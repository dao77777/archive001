# 设计:archive —— append-only 的内核状态源(落盘)

> 内核 [`live-loop.md`](live-loop.md) 的**状态基础**:loop 只有一件可变状态(archive),
> 其余(历史 / 状态机 / 信箱 / 出站)全是它的投影。**尚未实现**。
> 决策背景见 [`../../decisions/0008-archive-persisted.md`](../../decisions/0008-archive-persisted.md);
> 分步实施见 [`implementation-plan.md`](implementation-plan.md)。

## 结论

```
        客户端 send ──┐
                      ▼
   Llm / 工具结果 ──► archive(append-only 条目序列)──┬──► history   (投影:喂给模型)
   loop 的决定 ──────┘        │                       ├──► phase     (投影:状态机)
                              └──► 磁盘(JSONL)        ├──► inbox     (投影:未消费输入)
                                                      └──► events    (投影:出站 → UI)
```

一句话:**内核就是一段日志,状态是它的投影,这段日志落在磁盘上**。

|          | 现在(`Ref<Item[]>` + 队列)                                    | 目标                                               |
| -------- | ------------------------------------------------------------- | -------------------------------------------------- |
| 权威状态 | `history` `Ref` + inbox `Queue` + outbox `Queue`,三份各写各的 | **一份** append-only 条目序列                      |
| 存活期   | 进程死了全没                                                  | 落盘;重开 = 继续这个会话                           |
| 历史     | 循环里手写 `remember()` 拼                                    | `historyOf(prefix)` 纯函数                         |
| 状态机   | 隐含在 `for` 循环的位置里                                     | `phaseOf(entries)` 纯函数                          |
| 信箱     | `Queue<AgentInput>` 自己就是真相                              | 未消费的 `input` 条目;`Queue` 退化成**叫醒用的铃** |
| 出站     | 循环 `Queue.offer`                                            | 条目 → 事件(`eventsOf`),消费游标归消费者           |
| 会话重置 | 重建 Layer + 子 scope(见 web `session.ts`)                    | 换一份 archive                                     |
| 事后追因 | 没有;只能看打印                                               | 整段可重放、可校验、可 diff、可跨进程续            |

**收益不是"多了一份日志",而是四个能力**:任意时刻重放(`fold(entries) ≡ 现场`)、
结构性校验(回放契约可被机器检查)、UI 断线/重启重连(按游标重放事件)、**崩溃续跑**(重开接着跑)。

## 结构图

```
                    append(body) ─┬─► Ref{ entries, seq }   原子分配 seq,唯一真相
                                  ├─► Queue<void>           只叫醒,不携带内容
                                  └─► writer(单 fiber) ──► <session>.jsonl
                                          │                  每行一个条目;拍边界 fsync
   ┌──────────────────────────────────────┴───────────────────────────────┐
   │ pulseLoop(单 fiber)                                                   │
   │   等:inbox 投影非空才开工(否则阻塞在叫醒铃上)                          │
   │   拍:append(pulse_started) → llm.complete(prefix 投影) → append(...)   │
   │   缓存:同一个 reduce 函数增量维护 { history, phase, pending, consumed } │
   └──────────────────────────────────────┬───────────────────────────────┘
                                          │
        ┌─────────────┬───────────────────┴──────┬─────────────────┐
        ▼             ▼                          ▼                 ▼
   history/prefix   phase/inbox           events(投影)        磁盘(JSONL)
   (= 模型入参)      (= 状态机 / 待办)      → 客户端             = 会话本体
```

| 谁           | 能做                              | 不能做                                        |
| ------------ | --------------------------------- | --------------------------------------------- |
| 客户端       | `append({_tag:"input"})`          | 改 / 删 / 插队到已有序号之前                  |
| 循环 fiber   | `append` 其余全部                 | 改历史、改旧条目                              |
| writer fiber | 把条目按 `seq` 写进文件并 `fsync` | 解析 / 加工 / 过滤内容(照抄)                  |
| 任何读者     | 从任意 `seq` 起 `tail`            | 依赖 `Queue` 里的内容(它只有"有事了"一个 bit) |

⚠️ **铃只负责叫醒,内容一律回 archive 读**:叫醒信号可以合并、可以多余,条目一条都不能丢。
事件顺序也靠 `seq` 保证(两个并发 `append` 拿到 5/6,铃的到达顺序可能相反;
读者按游标重扫 archive 就永远是有序的)。

## 条目

```ts
type Seq = number; // 从 1 起,单调、无洞

type ArchiveBody =
  | { _tag: "opened"; sessionId: string; settings: BehaviorSettings; tools: ReadonlyArray<string> }
  | { _tag: "input"; input: AgentInput } // prompt / interrupt / shutdown 全从这进
  | { _tag: "pulse_started"; adopted: ReadonlyArray<Seq> } // 本拍消费掉的 input
  | { _tag: "llm_responded"; reasoning: ReadonlyArray<string>; items: ReadonlyArray<Item> }
  | { _tag: "tool_returned"; callId: string; output: string } // 报错 / 被取消也是观测
  | { _tag: "errored"; where: "llm" | "kernel"; message: string }
  | { _tag: "interrupted"; cause: "client" | "shutdown"; note?: string }
  | { _tag: "recovered"; voidPulse?: Seq } // 进程重启时补记(见「重启」)
  | { _tag: "closed" };

interface ArchiveEntry {
  readonly seq: Seq;
  readonly at: number; // 单调毫秒,只用于展示 / 诊断,不参与任何判定
  readonly body: ArchiveBody;
}
```

命名:**条目用过去式(是"已经发生的事实"),出站事件用现在式(是"通知")** ——
`tool_returned` 是条目,`tool_result` 是事件。一眼能分清你在写哪一层。

`reasoning` 与其它字段**同级**:它就是一个普通的 `ReadonlyArray<string>`,会一起落盘、
一起重放、一起被 diff。没有"内存里一套、磁盘上一套"的双重策略。

### 为什么只有 9 种

判据:**能由前缀推导的,一律不记**。少记一条 = 少一处会跟投影不一致的真相。

| 想要的                              | 不记,因为                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `answered`(本轮答复)                | = 最近一条 `llm_responded` 且 `items` 里没有 `function_call`                 |
| `tool_called`(派发)                 | 已在 `llm_responded.items` 的 `function_call` 里;事件由投影产出              |
| `want_llm`(请求体)                  | = `prefix(pulse.seq)` 的 history 投影 + 现拼的 system;请求体复制一遍是 O(n²) |
| `state`(状态机关节)                 | = `phase` 投影;记了就有两份真相                                              |
| `text` / `thinking` / `answer` 事件 | = `llm_responded` 的投影(`eventsOf`);同一条消息不发两次                      |
| `received`(输入已收编)              | = `pulse_started.adopted` 的投影                                             |
| `reset` / `deleted`                 | append-only 里没有删除;重置 = 换一份 archive                                 |

推不出来的才记:`opened`(初值)、`pulse_started`(这一拍到底收了哪几条)、`llm_responded`、
`tool_returned`、`errored`、`interrupted`、`recovered`(重启这件事本身)、`closed`。

## 四个投影

`reduce(cache, entry) → cache` 是**唯一**的投影逻辑;`fold(entries) = entries.reduce(reduce, 空)`。
落地的缓存就是同一个 `reduce` 增量跑出来的(见「缓存 = 折叠」)。

`cache = { seq, history, phase, pendingCalls, consumed, voidedPulses }`。

### 1. history(喂给模型的那串 `Item`)

| 条目              | 贡献                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`(`prompt`) | 一条 `message/user`(到达顺序);`interrupt` / `shutdown` 无贡献                                                                                         |
| `llm_responded`   | `reasoning` **不进模型入参**;正文非空 → 一条 `message/assistant`(有工具调用时也留,它是"我先查一下"的宣告);**空正文且无调用 → 整条丢弃**(否则毒死会话) |
| `tool_returned`   | 一条 `function_call_output`(顺序跟在它的 `function_call` 之后)                                                                                        |
| 其余              | 无贡献                                                                                                                                                |

⚠️ reasoning **记录了但不回喂**:跨轮带思维链会显著加成本,而收益没有证据。
要改是**一行**(`items` 里加上 `reasoning` item),但先看复查条件 —— 它同时受回放契约约束
(见 [`llm.md`](llm.md#回放契约))。

### 2. phase(状态机)

| 状态       | 判定(对 fold 的余量)                                             |
| ---------- | ---------------------------------------------------------------- |
| `closed`   | 有条目 `closed`                                                  |
| `acting`   | `pendingCalls` 非空(有 `function_call` 没等到 `tool_returned`)   |
| `thinking` | 最近一条是 `pulse_started`(且未被 `recovered` 作废),没有收尾条目 |
| `idle`     | 其余:没有未完成的拍、没有未消费的输入                            |

⚠️ 状态是**判定出来的**,不是记下来的:要查"为什么卡在 acting",看 `pendingCalls` 里缺的是哪个 `callId`。

### 3. inbox(还没被消费的输入)

`inbox = [input 条目] - ⋃ pulse_started.adopted`,按 `seq` 升序;作废的拍(`recovered.voidPulse`)
不算消费;`closed` 之后恒为空。

⚠️ **一拍 = 一次取空**:`pulse_started.adopted` 就是这一拍的合并快照,下一拍只能收 `seq` 更大的输入。
合并语义写在条目里,不靠队列时序。

### 4. events(出站)

```ts
eventsOf(entry): ReadonlyArray<AgentEvent> // 纯函数,可能 0 条,也可能多条
```

| 条目            | 事件                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `opened`        | `ready`                                                                                                   |
| `pulse_started` | `received` × 每条 adopted 的 `prompt`(UI 才知道插话生效了)                                                |
| `llm_responded` | `thinking` × reasoning;无调用 → 一条 `answer`;有调用 → `text` × 正文 + `tool_call` × 每个 `function_call` |
| `tool_returned` | `tool_result`                                                                                             |
| `errored`       | `error`                                                                                                   |
| `interrupted`   | `interrupted`                                                                                             |
| `recovered`     | `recovered`(UI 看到"上次是崩了,已接着跑")                                                                 |
| `closed`        | `closed`                                                                                                  |

落盘之后这条投影有了额外价值:**重放整段条目 = 精确复原当时的 UI**,
所以客户端刷新 / 换设备 / 换前端都能拿到同一份录像,不必各自存一份。

## 一次模型调用 = 一个前缀的投影

```
request(pulse) = [system(工具名)] ++ historyOf(entries where seq < pulse.seq)
```

- `pulse_started` 之前的 `input` 已经在 fold 里 → 这一拍采用的新 prompt 天然在入参末尾;
- 上一拍的 `llm_responded` + `tool_returned` 也在这个前缀里 → 工具结果天然回填好;
- 于是:**`llm.complete` 的入参是 (archive 前缀, 工具集) 的纯函数**。

这条性质带来两个白拿的能力:同一个前缀可以离线重放去比对厂商行为;
"这一拍到底给模型喂了什么"永远查得到,不必把请求体再存一遍。

⚠️ 唯一不在 archive 里的入参是**工具定义**(JSON Schema):`opened.tools` 只存名字。
重放时 schema 可能不同(工具改过版本),这是有意的取舍 —— 存 schema 会把会话格式和工具实现绑死。

## 缓存 = 折叠

```
cache: Ref<Cache>
append(entry):  Ref.update(cache, (c) => reduce(c, entry))   // 每次 O(1)
```

- `reduce` 只有一份,**重放和增量走同一条代码路径**;
- 不变量:`fold(entries) ≡ Ref.get(cache)`,**测试里断言**(纯函数等值);
- 成本:每条 `tool_returned` 输出最多 8k 字符,几千条量级没问题。
  长命会话再谈"快照 + 截断",但那会破坏 append-only,**只能开新 archive 文件**。

## 持久化

### 文件

| 项       | 规定                                                                        |
| -------- | --------------------------------------------------------------------------- |
| 格式     | JSONL:一行一个条目 `{"v":1,"seq":12,"at":1730000000000,"body":{…}}`         |
| 位置     | 由调用方给路径(`ArchiveFile({ path })`);内核不认识任何默认目录              |
| 建议路径 | `~/Library/Application Support/archive001/sessions/<日期>-<id8>.jsonl`      |
| 权限     | 目录 `0700`、文件 `0600`(创建时定,`O_CREAT` 用 mode)                        |
| 版本     | `v` 是**格式版本**,只增字段、不改语义;不认识的 `v` 拒绝启动                 |
| 会话标识 | `opened.sessionId`(uuid);文件名只是给人看的                                 |
| 并发     | `<path>.lock`(`O_CREAT\|O_EXCL`,内容写 pid):**一个 archive 只许一个进程写** |

⚠️ **archive 文件永不进 git / 备份 / 云同步盘**:它记录思维链与工具 stdout(可能含密钥),
是"本机私有会话录像",不是仓库资产。

### 写盘

```
append(body)   → 内存(分配 seq,更新缓存)+ 叫醒铃 + 交给 writer 队列
writer(fiber)  → 按 seq 顺序 write 整行 + "\n";按拍边界 fsync
flush(upTo)    → 等到 seq ≤ upTo 全部落盘并 fsync 完成(屏障)
```

- **单 writer fiber**:写盘顺序 = `seq` 顺序,不会被并发写搅乱;
- **fsync 点(每拍两个)**:`llm_responded` 之后(钱已经花了,先把它钉住)、拍末(工具结果 + `closed` 语义);
  LLM 延迟是秒级,一次 fsync(毫秒级)不算成本;
- **写失败即停机**:磁盘满 / 只读 → 发 `errored{where:"kernel"}` + `closed`,**不做"继续跑但不落盘"**。
  理由:archive 就是真相,真相写不下去还继续聊,等于悄悄丢历史;
- **循环不被 I/O 阻塞**:`append` 只入队,`flush` 只在拍边界的两个点上等。

### 重启

打开已有文件 → 逐行解析 → `validate` → 补记 → 继续跑。

| 崩在哪                                     | 重开时做什么                                                                          | 结果                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 最后一行没有 `\n` / 解析不了               | 丢弃该行(残行),从上一个完整行继续                                                     | 丢一条从未被任何读者见过的事实                         |
| `validate` 失败                            | **拒绝启动**,报出路径与行号                                                           | 不猜、不自动修                                         |
| `pulse_started` 之后、`llm_responded` 之前 | 追加 `recovered{voidPulse}`                                                           | 那一拍的 `adopted` 输入重新变回待处理 → 重开即重跑该拍 |
| `llm_responded` 之后、`tool_returned` 不全 | 给缺的 `callId` 追加 `tool_returned{output:"错误:进程中断,执行结果未知(可能已生效)"}` | 配对不破;工具不重跑(副作用未知,重跑可能重复)           |
| 正常 `closed`                              | 什么也不补                                                                            | 会话已结束;`closed` 之后 append 是 no-op               |

⚠️ 恢复只能**追加**条目:删行 / 改行会让 `seq` 与 `fold ≡ 缓存` 同时失效 —— 这是 append-only 唯一的"修法"。

### 成长与留存

- 一个会话 ~ 一拍 2–5 条;`tool_returned` 单条 ≤ 8k。几千拍 ≈ 几十 MB,不做行内压缩;
- **没有轮转、没有截断**:要"瘦身"就是结束会话、换新文件;
- 删除 = 删整个文件(会话级),不是改 archive;SDK 不提供单条删除;
- 要跨会话搜索/统计 → 那是**索引**(另开 projection),别让 archive 变形。

## 校验

`validate(entries): ReadonlyArray<Problem>`,启动时必跑、测试里跑、开发模式下每拍抽检:

| #   | 检查                                                               | 违反的后果                |
| --- | ------------------------------------------------------------------ | ------------------------- |
| 1   | `seq` 从 1 起连续、单调、无洞                                      | 游标重放会漏条目          |
| 2   | 每个 `function_call` 在**同一拍**内有 `tool_returned`(callId 配对) | 回放 400,毒死整个会话     |
| 3   | 同一 `callId` 不出现两次                                           | 同上                      |
| 4   | `llm_responded` 不早于 `pulse_started` 且同一拍内至多一条          | 一拍多次生成 = 单飞被破   |
| 5   | `closed` 之后没有条目                                              | 关机后还在写              |
| 6   | 行里没有 `apiKey`(或任何密钥形态)                                  | 密钥会永久留在文件里      |
| 7   | `fold(entries) ≡ 增量缓存`                                         | 投影代码漂了              |
| 8   | 首条是 `opened`、`v` 认识、`seq` 与行序一致                        | 文件被手改过 / 版本不兼容 |

第 2 条是本次设计最实惠的地方:**以前靠人记的回放契约,现在机器能查**。

## 单写者与顺序

- `append` 内部 `Ref.modify` 分配 `seq` —— 谁调都行,**分配是原子的**,不存在两条同号;
- 结构上的"一拍一次生成"由循环保证(单 fiber),不靠锁;跨进程靠 lock 文件;
- 读者按 `seq` 游标重扫(铃的到达顺序不一定等于条目顺序,别拿铃当序列);
- 会话 = 一份 archive:`run(init)` 新建或续上,`close` 只收尾不删除;
  **Web 的 reset 从"重建子 scope"退化成"换一份 archive"**。

## append-only 意味着什么

"只追加"不是口号,它撑起上面所有推导,也决定了出错时能做什么:

| 后果              | 说明                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| 纠正 = 再追加一条 | 就地改 `entries[i]` 会让 `fold ≡ 缓存` 与 `seq 无洞` 同时失效,`validate` 会当场查出              |
| 手改 JSONL 不可行 | 改了行就得同时改 `seq` 与后续所有派生状态;跑一次 `validate` 就知道文件被改过                     |
| 没有"删除条目"    | 删会话 = 删整个文件;要"删某条消息"只能加墓碍条目 + 接受字节仍在(见复查条件)                      |
| 投影得无副作用    | `historyOf` / `phaseOf` / `inboxOf` / `eventsOf` 只看条目;读外部时钟或随机数会让重放不可复现     |
| 密钥不进来        | `apiKey` 是 `Redacted`,写进去就永久留在文件里;`opened` / `pulse_started` 只存 `BehaviorSettings` |
| 文件是本机私有物  | `0600` / `0700` / 不进 git 与备份(见「持久化」表);它含思维链与工具 stdout 的明文                 |

## 跟 `live-loop.md` 的差异

| 项                | live-loop                                 | 现在                                |
| ----------------- | ----------------------------------------- | ----------------------------------- |
| 信箱              | `Queue<AgentInput>` 是真相,`takeAll` 合并 | 真相在 archive;`Queue<void>` 只叫醒 |
| 出站              | 循环 `Queue.offer(AgentEvent)`            | 条目投影;消费者自带游标             |
| 历史提交点        | 两个显式提交点(`prompt` 先落、产出原子落) | 不存在提交点:append 即落,投影管顺序 |
| `MAX_STEPS`       | 改成 `MAX_STEPS_PER_TASK`                 | **删掉**(见下)                      |
| `thinking` 的重放 | 只走实时,`replay` 模式过滤掉              | 与其它事件一样可重放(它已落盘)      |
| reset             | 重建 Layer + 子 scope                     | 换 archive                          |
| 存活期            | 进程内                                    | 跨进程(重启续跑)                    |

**`MAX_STEPS` 删除**:内核不再猜"该跑多少步"——那是**调用方的策略**,不是内核的事实。
兜底交给:① `interrupt` 是一等公民(repl 的 Ctrl-C / Web 的停止按钮);
② 一次性客户端在 `runOnce` 上挂 `Effect.timeout` 或 token 预算;③ 真要预算,以后记成条目
(`budget_exhausted`),而不是写在常量里。

## 测试

| #   | 用例                                                 | 断言                                                                              |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | 手工条目序列 → 四个投影                              | 表驱动:每条各一条用例(空正文丢弃、最后一条无调用的答案是 answer…)                 |
| 2   | `fold(entries)` vs 增量缓存                          | 逐条 append 后两者深等                                                            |
| 3   | 并发 `append`(100 条,fork 成 2 条 fiber)             | `seq` 连续无洞;`tail` 输出严格按 `seq`;磁盘行序同 `seq`                           |
| 4   | 工具执行中投递 prompt                                | `pulse_started.adopted` 不含它;下一拍含它,history 顺序 = `[calls, outputs, user]` |
| 5   | 打断时工具未回                                       | 每个 `function_call` 都有 `已打断` 的 `tool_returned`(`validate` 第 2 条过)       |
| 6   | 关机                                                 | `closed` 之后 `inboxOf` 为空、`append` 是 no-op、文件已 fsync                     |
| 7   | **写→重开→续跑**                                     | 新进程的四个投影与旧进程逐项相等;`thinking` 也能重放出来                          |
| 8   | 尾行被截断(手动砍掉半行)                             | 能打开;残行被丢弃;`validate` 零 Problem                                           |
| 9   | `pulse_started` 后立刻崩                             | 重开后该拍输入回到 inbox;重跑该拍;`validate` 过                                   |
| 10  | `llm_responded` + 只回了一个工具就崩                 | 缺的补"结果未知";**工具不被重跑**                                                 |
| 11  | 两份进程开同一文件                                   | 第二个报错(lock)                                                                  |
| 12  | 文件里搜 `apiKey` / `sk-`                            | 搜不到                                                                            |
| 13  | 一整段会话(3 次工具、1 次插话、1 次打断、1 次崩重启) | `validate` 零 Problem;`fold ≡ 缓存`                                               |

用例 1/2/7/13 是主要测试面;9/10 是"崩溃语义"的正确性,最容易写错。

## 落地

分步实施顺序见 [`implementation-plan.md`](implementation-plan.md)(Phase 1–5 覆盖本文件);
下面的测试(1–13)与「校验」节是验收内容,不随阶段变化。

文件:`loop/archive.ts`(服务)、`loop/projection.ts`(投影,`projection.test.ts`)、
`loop/archive-file.ts`(落盘)、`_domain.ts`(类型 + Schema)、`_constants.ts`(`ARCHIVE_VERSION`)。

## 代价 / 复查条件

**代价**:

- 多一层间接:改一行 `history` 的直觉不管用了,所有改动都要问"这是条目还是投影";
- 排障方式变了:GUI 之外靠 `snapshot` + `validate`,得先学会读条目;
- 投影是"模型入参的唯一入口",投影写错 = 模型看到的和历史不一致 —— 只能靠用例 2/7/13 兜;
- **落盘的是明文**:思维链 + 工具 stdout(可能含 env dump / token)在本地文件里;
  泄露面从"内存"扩到"磁盘 / 备份 / 同步盘 / 误 `git add`";
- 文件格式从此是兼容性负担:字段只能加,`Item` 的变化会连带改磁盘格式;
- 崩溃续跑要处理"未知副作用"(工具可能已执行),只能标"结果未知",不能真恢复。

**复查条件**:

- 要把 archive 放到云 / 多机同步 / 共享给他人 → 就恢复"落盘前剥离 `reasoning`",并把本条标为 superseded;
- 要给会话做"分享 / 导出"功能 → 先有 redact 管线(工具输出里的密钥),再谈导出;
- 条目种类涨到 >12 或同一个 `_tag` 开始带分支语义 → 说明"事无巨细"过界了,按"能推导就不记"再削一轮;
- 需要长命会话(>10 万条 / >1GB)→ 快照 + 新 archive 文件分段;分段后 append-only 只在单段内成立,要写清楚;
- 出现"用户要求删掉某条消息"的合规需求 → 加 `redacted(seq)` 墓碍条目,并接受"删不掉字节",或改写「append-only 意味着什么」。
