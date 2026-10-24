# 实施计划:常驻循环 + archive

> 状态:**未开始**(实现过一次又整体回滚,见 `~/Code/_lab/archive001-impl-snapshot-2026-10-24/`)。
> 目标设计:[`live-loop.md`](live-loop.md) + [`archive.md`](archive.md);决策背景 [`../../decisions/0008`](../../decisions/0008-archive-persisted.md)。

## 依赖顺序(决定了阶段划分)

```
_domain + _constants(声明与常量)
        │
        ▼
  projection(纯函数,最好测)
        │
        ▼
archive(内存)──► loop(会话化)──► archive-file(落盘)
                        │
                        ▼
              clients(cli → repl → web)──► smoke
```

每一步只让**一层**从“旧”变“新”,其余保持原样 —— 这样任何一步出错都能只回退那一步。

## Phase 0 · 基线(不做这步,后面都没法回退)

| 步骤 | 做什么                                                         | 验收                         |
| ---- | -------------------------------------------------------------- | ---------------------------- |
| 0.1  | `pnpm check && pnpm typecheck && pnpm test`                    | 51 文件 / **53 用例**绿      |
| 0.2  | **纳入版本管理**(`git init` 或加进 `~/Code` 父仓),打第一个提交 | `git log` 有一条可回退的基线 |
| 0.3  | 抽一份快照到 `~/Code/_lab/`(保护现状)                          | 目录能打开、关键文件在       |

⚠️ 上一次实现没有版本控制,回滚只能靠逐字重建 —— 这一步是后面所有“随时可退”的前提。

## Phase 1 · 类型与投影(纯函数,不碰运行时)

| 步骤 | 文件                      | 内容                                                                                                                                                                          |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | `loop/_constants.ts`      | 加 `SESSION_ID_PREFIX` / `ARCHIVE_VERSION` / 恢复与打断的观测文案                                                                                                             |
| 1.2  | `loop/_domain.ts`         | 加 `AgentInput` / `ArchiveBody`(9 种 Schema) / `ArchiveEntry` / `Phase` / `Projection` / `EventsIndex` / `ArchiveShape` / `SessionShape` / `StepOutcome`;**旧类型一律先留着** |
| 1.3  | `llm/_domain.ts`          | `Item` 升级成 `ItemSchema` + `typeof .Type`(落盘要 encode/decode)                                                                                                             |
| 1.4  | `loop/projection.ts`      | `emptyProjection` / `reduceEntry` / `fold` / `historyOf` / `phaseOf` / `inboxOf` / `eventsOf` / `validate`                                                                    |
| 1.5  | `loop/projection.test.ts` | 表驱动:history 三条规则、phase/inbox、events 映射、`fold ≡ 增量`、validate 的四种违规                                                                                         |

**验收**:新增用例全绿;`loop.ts` 一行没改;53 用例照旧 —— 这一步可以独立审阅,零风险。

## Phase 2 · archive(纯内存)

| 步骤 | 文件                   | 内容                                                                                                                                                              |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `loop/archive.ts`      | `Archive` 服务 + `makeArchive`:同一 `Semaphore(1)` 里分配 `seq` + `write`;两个铃(`awaitChange` 单消费者、`tail` 每订阅一个);`archiveMemory` / `openMemoryArchive` |
| 2.2  | `loop/archive.test.ts` | 并发 `append` → seq 无洞;`tail` 顺序 = seq;`closed` 收尾;`awaitChange` 不丢唤醒                                                                                   |

**验收**:还没接循环,但“案卷”本身可信 —— `tail`/铃的语义问题在这一层暴露,不会污染循环。

## Phase 3 · 循环会话化(分两小步)

**3a · 只做启动 + 投递 + 一次问答**

- `run(init)` 返回 `SessionShape`:`send` / `events` / `eventsFrom` / `snapshot` / `close`
- 启动段:新会话记 `opened`;续跑记 `recovered` + 补 `tool_returned`
- 循环体:等叫醒 → `pulse_started` → `llm.complete` → `llm_responded` → 有调用就跑工具 → 回顶部
- `history: Ref<Item[]>` 换成“投影 + 增量 `syncCache`”

**验收**:单 prompt → `answer`;未知工具错误回填;`close` → `closed`;旧用例的语义逐条移植(空答复丢弃、不带 reasoning、提示词跟工具集)。

**3b · 两个必须补的语义**(上次实现时踩出来的)

| 细节                                                                                     | 不做的后果                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `awaitingModel`:工具全部回齐后,**下一拍没有新输入也要跑**                                | 多步工具停在半路等人说话                                  |
| `deferredUsers`:工具还在跑时到的 prompt 先挂起,最后一个 `tool_returned` 之后才进 history | user 被插进 `function_call` 与它的 output 之间 → 回放 400 |

**验收**:三轮工具调用能自己收尾;插话断言 `[system, user1, function_call, output, user2]`。

## Phase 4 · 打断与关机(信号)

- `interrupts: Queue<void>` + `stopping: Ref<boolean>`;`guarded(work) = Effect.raceFirst(work, 等打断)`
- 工具逐条取消 → 剩余的补 `tool_returned{"已打断"}`;关机记 `interrupted` + `closed`
- **`interrupt` / `shutdown` 不进 archive**:它们是信号,效果由 `interrupted` / `closed` 记录

**验收**:生成中打断不落 `llm_responded` 且循环还能用;工具中打断不留半拍;`send` 不阻塞;关机立刻收场。

## Phase 5 · 落盘

| 步骤 | 内容                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1  | `loop/archive-file.ts`:`load`(拆行 → Schema 解码 → `validate` → 截断残行)、`.lock`(`O_CREAT\|O_EXCL`)、`write` + `sync` 钩子、finalizer 收尾 |
| 5.2  | `packages/agent/package.json` 加 `./archive-file` 子路径                                                                                     |
| 5.3  | `archive-file.test.ts`:写→重开投影一致、残行、双开被拒、坏文件拒开、无 `apiKey`、重启续跑                                                    |

⚠️ 恢复顺序:先 `recovered{voidPulse}`,再补 `tool_returned`(反过来会让配对检查先失败)。
⚠️ 恢复只补“结果未知”,**绝不重跑工具**(副作用可能已发生)。

## Phase 6 · 客户端逐个接(每个都能独立跑通)

| 顺序 | 客户端   | 改法                                                                                       | 验收                            |
| ---- | -------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| 6a   | CLI      | 会话 + `takeUntil(answer\|error)`(或保留 `runOnce` 组合)                                   | `--help` 正常;单 prompt 跑通    |
| 6b   | REPL     | 事件后台渲染 + 读行并发;Ctrl-C → `interrupt`;archive 换文件版                              | 手打一句、插一句、按一次 Ctrl-C |
| 6c   | Web 宿主 | `turn` = `mark = snapshot().length` → `send` → `eventsFrom(mark + 1)`;`reset` = 关会话重开 | 一问一答;中途断开不烧 token     |
| 6d   | smoke    | 一个会话两轮                                                                               | `sops exec-env … 'pnpm smoke'`  |

每次只改**一个**客户端,改完跑一遍门禁 —— 内核与新客户端之间不存在“改一半”的中间状态。

## Phase 7 · 文档收尾

- `live-loop.md` / `archive.md`:去掉“未实现”,补一节**与设计的偏差**(必有:`awaitingModel`、`deferredUsers`、信号不进 archive、`validate` 放宽、`opened` 字段拍平、Semaphore 替代 writer fiber)
- `loop.md` 标为旧形状;`README` / `AGENTS.md` / `status.md` / 本索引同步

## 目标用例数

| 阶段     | 0   | 1   | 2   | 3   | 4   | 5   | 6   |
| -------- | --- | --- | --- | --- | --- | --- | --- |
| 累计用例 | 53  | ≈70 | ≈74 | ≈80 | ≈82 | ≈88 | ≈90 |

## 每个阶段之间的三条不变规则

1. **一次只动一层**:Phase 1 不碰 `loop.ts`,Phase 3 不碰客户端。
2. **每阶段一次提交**:`git commit -am "phase N: …"`,它就是回退点。
3. **用例只增不减**:任何一步让旧用例变红,先修旧行为,别改断言。

## 上次实现踩过的坑(照抄即可避开)

| #   | 坑                                             | 正确做法                                                          |
| --- | ---------------------------------------------- | ----------------------------------------------------------------- |
| 1   | 工具结果回齐后去等新输入                       | `awaitingModel`                                                   |
| 2   | 插话直接进 history                             | `deferredUsers`,output 之后再入                                   |
| 3   | 把 `interrupt` 记成 `input` 条目               | 纯信号;效果记 `interrupted`                                       |
| 4   | `validate` 要求“同一拍配对”                    | 全局配对 + “两次生成之间不许夹未回的工具”                         |
| 5   | `Layer.mergeAll(AgentLive, archiveMemory)`     | `Layer.provide(archiveMemory)(Layer.provide(LlmLive)(AgentLive))` |
| 6   | `Fiber.await` / `Effect.fork` / `Layer.scoped` | v4 是 `Fiber.join` / `forkDetach`·`forkIn` / `Layer.effect`       |
| 7   | 多个 `tail` 共用一个铃                         | 每个订阅自己的 `Queue<void>`(Queue 是 work-stealing)              |
| 8   | seq 分配与写盘分两步                           | 同一 `Semaphore(1)` 内完成,否则文件行序 ≠ seq 序                  |
| 9   | Web 用 `mark` 而不是 `mark + 1`                | 会重复读上一条                                                    |
| 10  | 崩溃恢复重跑工具                               | 只补“结果未知”                                                    |

## 最小可运行切片

**Phase 1 + 2 + 3a** 就能得到“常驻会话、一拍一调用、能回答、能关机”的内核(约 700 行 + 测试);
打断、落盘、客户端全部推后 —— 内核 API 定型后,剩下的都是加法。

## 什么情况下停手(复查条件)

- Phase 3 做完发现**REPL 反而更难用**(打断语义不清、输出交错)→ 停,回到一次性 `run`,把本次经验写进 `../../decisions/`;
- Phase 5 发现文件格式反复变(说明 `Item` / 条目还没定)→ 先冻结 `_domain.ts`,再继续;
- Phase 6c 做不动(浏览器侧要改的比预期多)→ Web 先保留“一请求一流”,只换内核,别同时改协议。
