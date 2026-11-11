# 决策:archive 加读侧,`project(entries)` 把事件折叠回循环状态

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/archive/project.ts`(类型最初在 `archive/_domain.ts`,
> 后来随 [`0073`](0073-archive-types-per-file.md) 搬回 `project.ts`)·
> 设计见 [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧) ·
> 相关 [`0057`](0057-tool-writeback-completion-order.md)(写回顺序 = 完成顺序)

## 矛盾

archive 一直**只写不读**:`ArchiveShape` 只有 `append` / `errors`,"投影 `fold(entries)`" 挂在
`archive.md` 的"还没做"里。但"这段历史里到底发生了什么"的规则已经存在,只存在于 `llm.ts`:

| 想知道              | 现在只能                                                   |
| ------------------- | ---------------------------------------------------------- |
| inbox 里还剩什么    | 自己把 `INBOX_OFFER` 和 `INBOX_TAKE` 做差                  |
| transcript 长什么样 | 重读状态机:什么进 transcript、纯问答轮为什么不带 reasoning |
| 还欠哪些工具结果    | 自己配对 `FUNCTION_CALL` / `FUNCTION_CALL_OUTPUT`          |
| 引擎停在哪一步      | 自己看有没有未闭合的 step / `ENGINE_END`                   |

于是"读侧规则"要么在每个消费者那里复制一遍,要么就得给 `Agent` 加一个只读口子
(把内部状态暴露到 SDK 面上)。两种都不好。

## 处理

`archive/project.ts` 的纯函数 `project(entries)` → `ArchiveProjection`:

```ts
type ArchiveProjection = {
  inbox: ReadonlyArray<InboxMessage>; // INBOX_OFFER − INBOX_TAKE
  unused: ReadonlyArray<InboxMessage>; // 取走了但没进任何 step
  engines: ReadonlyArray<ProjectedEngine>; // 按 ENGINE_START 分段
};

type ProjectedEngine = {
  id;
  startedAt;
  endedAt;
  error;
  phase: "idle" | "generating" | "waiting" | "stopped";
  transcript: ReadonlyArray<Item>;
  pendingCallIds: ReadonlyArray<string>;
  turns: ReadonlyArray<ProjectedTurn>; // 每轮:steps(输入/输出/错误)/ answer / ended
};
```

- **读侧从 `Archive` 服务暴露**(外部环境拿服务就能恢复):
  `ArchiveShape.readAll`(读 sink,已落盘的全部条目)与 `ArchiveShape.restore`(= `readAll` + `project`)
  ——`restore` 后来被 [`0071`](0071-archive-projection-by-engine.md) 换成 `projection(engineId)`;
  `ArchiveSink` 因此多了 `read`:`write` 是单 writer,`read` 只读已落盘的,互不干扰;
- 折叠规则与状态机一一对应:有调用的 step 整批 `produced` 进 transcript、纯问答轮只留非空正文、
  `FUNCTION_CALL` 进 pending、`FUNCTION_CALL_OUTPUT` 出 pending、`ENGINE_END` 关段;
- `phase` 是**推**出来的:未闭合 step → generating,有 pending → waiting,`ENGINE_END` → stopped;
- 正文按引用取:`USER_MESSAGE.inboxId` / `FUNCTION_CALL_OUTPUT.inboxId` → `INBOX_OFFER.message`;
- 类型最初放 `archive/_domain.ts`(只声明),SDK 只导出 `project` + 这些类型(0073 后回到 `project.ts`);
- 恢复不了的东西写进设计文档:configure、`ARCHIVE_ERROR`、中断 vs 正常、同 step 内 item 交错、
  并发工具的真实完成时间。

## 为什么

- **读侧贴着写侧**:投影依赖事件 schema,放同一个目录、同一份文档里,改 schema 时最容易一起看到;
- **不给 Agent 开只读口子**:想要"现在到哪一步"不必在 SDK 上多暴露一个运行时状态查询;
- **纯函数**:不吃服务、不碰 IO,既能对内存里的事件流用,也能直接接将来的 `readAll`;
- **规则集中**:`inbox` 差集、`unused`、`answer` 这些"没说出口的约定"从注释变成代码。

## 代价

- **同一套规则有两份**:`llm.ts` 与 `project.ts` 都编码了"什么进 transcript";哪天状态机改了规则
  (压缩、保留纯问答 reasoning、空答复也入)而投影没跟上,读侧会静默地"看起来正常但不一样";
- **顺序是近似的**:同一 step 内 reasoning / 正文 / 调用的真实交错顺序投影不出来,
  只能按事件顺序(发出顺序是 reasoning → 正文 → 调用);
- **只读已落盘的**:`readAll` 不等在飞的批,因此同一实例刚写的东西可能读不到;
  恢复靠"旧层已关闭"这个前提(关闭会把残留写完),没有显式的 flush 屏障(0044 把 flush 收回了内部);
- **坏行之后的条目全丢**:文件 sink 在第一个坏行处截断(单 writer 追加,半行只可能在尾部),
  但真出现中间坏行时不会告警;
- **`unused` 混了两种含义**(丢弃的迟到结果 / 攒在 inbox buffer 里的),读侧分不出来;
- **多一份公开 API**:`project` 与 6 个类型进了 SDK 面,以后改形状要照顾兼容。

## 复查条件

1. **transcript 规则开始变化**:把"哪条事件进 transcript、怎么进"抽成 `llm.ts` / `project.ts` 共用
   的纯函数(或反过来,让状态机发显式的 transcript 变更事件);两份规则同时漂是最大的风险。
2. **要在同实例内读刚写的东西**:给 `Archive` 加一个内部屏障(等队列与在飞批清空)再读,
   或者提供 `readAll` 的 flush 版本;不要靠 sleep。
3. **缺 `ENGINE_END` / 缺 `INBOX_OFFER` 的降级**:现在只是"少点东西";要区分"日志被截断"与
   "引擎没正常收尾",得在看板上带校验(行数 / 最后一条 tag)或加心跳事件。
4. **要区分 `unused` 的两类**:让引擎停止时把 inbox buffer 报出来(新事件),或让 inbox 在中断时
   把攒着的消息退回队列——两条都比"猜"好。
5. **要同一 step 内的精确 items 顺序**:让状态机发"这一步喂给模型的 items"或给 produced 里的
   item 加序号;不要在投影里做启发式。
