# 设计:agent 循环 · 事件驱动的常驻循环

> 取代 [`loop.md`](loop.md) 里「一次 `run` = 一次请求、返回正文」的形状;**尚未实现**。
> 状态怎么存见 [`archive.md`](archive.md),分步实施见 [`implementation-plan.md`](implementation-plan.md):
> 本文件只描述**循环**(拍 / 打断 / 关机),
> 历史、状态机、信箱、出站都是 archive 的投影,不是内核里的可变状态。
> 模型层 [`llm.md`](llm.md)、跨包结构 [`../overview.md`](../overview.md) 不变。

## 结论

`run` 不再返回正文,而是**起一个常驻循环**(只由 `shutdown` / scope 关闭结束):

```
客户端 ──send(输入)──► 信箱 ──► [ 一拍 = 一次 llm.complete + 一批工具 ] ──► 事件流 ──► 客户端
```

⚠️ 图里的"信箱 / 事件流"都是**投影**,不是队列:写下去的每条东西都是 [`archive.md`](archive.md)
里的一个条目,信箱 = 未被消费的输入条目,事件流 = 条目的投影。

心理模型:**一个 LLM 一直守着一个信箱**;信箱里来东西(一条 prompt、一个/多个工具结果、
工具结果后紧跟的插入式 prompt),它就做一次动作(调工具 / 回答),做完继续守。

|                | 现在                                | 目标                                                        |
| -------------- | ----------------------------------- | ----------------------------------------------------------- |
| `run`          | 跑一轮,返回 `string`                | 起来的循环,返回 `Session` 句柄(`send` / `events` / `close`) |
| 触发模型的输入 | 函数入参 `input`                    | 信箱里取到的一**批**输入                                    |
| 任务结束       | `return answer`                     | 发 `answer` 事件,循环回到待命                               |
| 步数上限       | `MAX_STEPS`(超了 `return` 一句提示) | **删掉**:内核不猜预算,兜底交调用方(见下)                    |
| 错误           | `Effect` 失败(`LlmError`)           | `error` 事件,循环**不炸**                                   |
| 多轮之间       | 客户端再调一次 `run`                | 循环内天然续着(不用重放任何东西)                            |

⚠️ **`run` 是唯一的退出点**:客户端想要"跑完就退",自己 `send(shutdown)` 或 `close` ——
一次性 CLI 用 `runOnce`(见「落地」)薄封装,别把一次性语义塞回内核。

⚠️ **这里没有步数上限**:`MAX_STEPS` 已删。"该跑多久"是**调用方的策略**(CLI 超时、
Web 上用户按停止、以后可能有 token 预算),不是内核的事实;写成常量只会变成"任务被莫名截断"。
要兜底的客户端,在它自己那层挂 `Effect.timeout` / 预算(见「落地」阶段 1)。

## 结构图

```
          send(AgentInput) = append(input)          events = eventsOf(archive tail)
  客户端 ────────────────────────────────┐        ┌──────────────────────────────►
                                          ▼        │
                                    ┌───────────────────┐
                                    │  archive(唯一状态) │
                                    └─────────┬─────────┘
                                              │ tail / prefix 投影
                                    ┌─────────▼─────────┐
                                    │ pulseLoop(单 fiber)│
                                    └─────────┬─────────┘
                                              │
                            Llm.complete(prefix 投影) · runTool(顺序)

  打断 / 关机:append(input) + **信号**(Deferred)——循环忙时读不到信箱,
  在飞的 llm 调用 / 工具批次只能被信号穿透。

  archive **落盘**(JSONL,拍边界 fsync):重开一个会话 = 接着这段日志跑。
```

内核里**只有两条通道**,都不是队列:

| 通道          | 类型                                                | 走什么                        | 为什么这样                                                    |
| ------------- | --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| archive       | append-only 条目序列(见 [`archive.md`](archive.md)) | 输入 / 生成 / 工具结果 / 关机 | 唯一真相;信箱、历史、出站全是它的**投影**                     |
| 叫醒铃        | `Queue<void>`,不携带内容                            | 只表示"archive 变长了"        | 循环阻塞在它上面;可以合并、可以多余,**内容一律回 archive 读** |
| 信号 `signal` | 每拍一个 `Deferred<void>` + `Ref<Reason>`           | `interrupt` / `shutdown`      | 循环忙时读不到 archive 尾巴,打断要能穿透在飞的工作            |

⚠️ 信箱为什么是 `Queue` 而不是 `PubSub` / `Stream`:`PubSub` 给慢订阅者丢事件,
`Stream` 没有"取空"的概念(一事件一调模型的病就是这么来的);`Queue` + 投影同时满足两件事。

## 接口草案

```ts
type AgentInput =
  | { readonly _tag: "prompt"; readonly text: string }
  | { readonly _tag: "interrupt"; readonly text?: string } // 可顺便改口
  | { readonly _tag: "shutdown" };
// 投递后立刻成为 archive 里的一条 input 条目 —— 记录与投递是同一个动作。

type AgentEvent =
  | { readonly _tag: "ready" } // 循环已起,可以开始投递
  | { readonly _tag: "received"; readonly text: string } // 某条输入被这一拍收编
  | { readonly _tag: "thinking"; readonly text: string }
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "tool_call"; readonly name: string; readonly arguments: string }
  | { readonly _tag: "tool_result"; readonly name: string; readonly output: string }
  | { readonly _tag: "answer"; readonly text: string } // 本轮任务结束(不再是返回值)
  | { readonly _tag: "error"; readonly text: string } // 不致命,循环继续
  | { readonly _tag: "interrupted"; readonly text?: string }
  | { readonly _tag: "closed" }; // 随后事件流结束

interface SessionShape {
  /** 投递,永不阻塞、不等待:不提供请求/响应语义。 */
  readonly send: (input: AgentInput) => Effect.Effect<void>;
  /** 单消费者;要多路自己 `Stream.broadcast`。 */
  readonly events: Stream.Stream<AgentEvent>;
  /** = send(shutdown) 并等循环退出(可被打断)。 */
  readonly close: Effect.Effect<void>;
}

interface AgentShape {
  /** 起一个永不返回的循环;`settings` / `tools` 在会话生命周期内固定。 */
  readonly run: (init: {
    readonly settings: LlmSettings;
    readonly tools: ReadonlyArray<Tool>;
  }) => Effect.Effect<SessionShape>;
}
```

`Tool` / `makeTool` / `builtin-tools.ts` / `Llm` **一律不动**;`Observer` 退休(由 `events` 取代)。

配置放哪,三选一:

| 方案                                          | 代价                                                      | 结论                                        |
| --------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| A. 会话固定(`run(init)` 后不可变)             | 换模型 / 换工具集要新开会话(= Web 的 `reset`)             | ✅ **推荐**:一个会话 = 一个进程的语义最干净 |
| B. 每条 `prompt` 带 `settings` / `tools` 覆盖 | 一次批量入队时"以谁为准"说不清;工具执行用哪套也要额外规定 | ✗                                           |
| C. `configure` 事件改 `Ref`                   | 多一个事件、多一点顺序敏感性                              | 需要"计划模式切工具集"时再加                |

## 状态机

```
              prompt
   ┌──────────────────────────► Thinking ──(产出无 function_call)──► answer ──┐
   │                              │                                          │
 Idle ◄── interrupt / error ◄────┤ 产出有 function_call                      │
   ▲                              ▼                                          │
   │                           Acting ──(本批 output 全部到齐)──► Thinking    │
   └─────────────────────────────────────────────────────────────────────────┘
                                 shutdown ──► closed ──► 流结束
```

- `Idle` = 循环阻塞在叫醒铃上,**零 token**。空闲不发事件(`answer` 已经宣告了任务结束)。
- `Thinking` / `Acting` 之外不发 `llm.complete`(一拍只一次;两拍并发会让同一前缀被两个写者推着跑)。
- 没有"步数"这个维度:一个任务能拍多少次只由模型决定,直到它给 `answer` 或被 `interrupt`。

状态本身不存:**`phaseOf(entries)` 是 archive 的投影**(见 [`archive.md`](archive.md#2-phase状态机))。

## 一拍(pulse)

一拍 = 收掉当前全部未消费输入 + 一次 `llm.complete` + 该次产出要求的工具。

```
awaitWork:
  while (inboxOf(archive) 为空)     // 投影:未消费的 input 条目
    Queue.take(bell)                // 阻塞点:唯一等待(可以多余,重扫即可)

一拍:
  1. adopted = inboxOf(archive)           // 一次取空 = 这一拍的合并快照
     append(pulse_started { adopted })
  2. events 投影发出 received(逐条)
  3. produced = llm.complete(
       [system(工具集), ...historyOf(prefix(pulse.seq))],   // 纯函数
       tools.map(def), settings)
  4. append(llm_responded { reasoning, items: produced })
  5. 无 function_call → 本拍到此为止(事件投影已经发了 answer)→ 回 awaitWork
     有 function_call → 逐个执行工具 → append(tool_returned)
  6. 回 awaitWork(信箱里若已积压,立刻又凑一拍,不用等铃)
```

批里有什么,什么时候进模型入参:

| 输入                     | 触发模型调用?                         | 在 `items` 里的位置                                       |
| ------------------------ | ------------------------------------- | --------------------------------------------------------- |
| `prompt`(Idle 时到)      | ✅ 本拍                               | 历史末尾(新任务的第一条 user)                             |
| `prompt`(忙碌时到)       | ✅ **下一拍**,与那批 tool output 同拍 | 在该批 `function_call_output` **之后**                    |
| 工具结果(内部产生)       | 不单独触发,本批齐了才用               | `function_call_output`,**按 call 顺序**回填(不是完成顺序) |
| `interrupt` / `shutdown` | ❌                                    | 不进 items(不进投影的 history)                            |

关键:忙碌期间没人 append `pulse_started`,所以期间到达的 prompt 就是"未被 adopted 的 input 条目",
下次 `inboxOf` 一次性全部收走 → **一拍只调一次模型**。合并语义写在 `adopted` 里,不靠队列时序。

## 历史与回放契约

历史**不是**独立状态,而是 archive 的投影(`historyOf(prefix)`):`input` → user、
`llm_responded` → assistant + `function_call`、`tool_returned` → `function_call_output`。
投影规则在 [`archive.md`](archive.md#1-history喂给模型的那串-item);
下面四条是**来自厂商回放契约与投影顺序的约束**,不是人为规定:

1. 进历史的 `function_call` 要**在同一拍**里带上它的 `function_call_output`
   (Responses 回放要配对;chat 折叠成一轮 assistant + tool 消息,缺了 400)。
   打断时无法配对的调用补一条 `输出: 错误:已被打断`,`validate` 第 2 条会查出漏网的。
2. 插入式 prompt 落在 **output 之后**:夹在 `function_call` 与它的 output 之间同样会 400。
3. `reasoning` 不进模型入参(记录了但不回喂:跨轮带思维链会显著加成本,收益没证据;
   要带就改 `historyOf` 一行)。
4. 一拍内多条 prompt → 多条连续的 `user` message,保持到达顺序(拼成一条会丢归属);
   `answer` 的正文一定在下一拍的 user 之前(顺序由 `seq` 天然给出)。

系统提示词**不进历史**,每拍按当前工具集现拼 —— 会话常驻时工具集若变,提示词跟着变也不会和历史打架。

## 打断 / 错误 / 关机

| 情况                   | 做什么                                                                              | 落地为条目                                                          |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `interrupt`(在飞)      | `Deferred.complete` → `llm.complete` / 工具批次与它 `race`,输者被 interrupt;回 Idle | `interrupted`(+ 未完成 call 补 `已打断` 的 `tool_returned`)         |
| `interrupt`(带 `text`) | 同上,并把 `text` 当 `prompt` append(下一拍生效)                                     | `input{interrupt}` + `input{prompt}`                                |
| `interrupt`(空闲)      | 直接回 Idle,无副作用;残留信号在下一拍开始时重置                                     | `interrupted`                                                       |
| `LlmError`             | 回 Idle,**不重试**                                                                  | `errored{where:"llm"}`(history 投影不贡献任何 item → 允许连续 user) |
| 循环内部缺陷(bug)      | 让 fiber 死:`ensuring` 里 `close`(补一条 `closed`)                                  | `closed`                                                            |
| `shutdown`             | 置位 → 打断在飞 → 丢弃未消费输入 → 退出                                             | `input{shutdown}` + `closed`                                        |

⚠️ `shutdown` 是**立即**退出,不"跑完再退";要"跑完再退"就在 `close` 之前先等 `answer`。
⚠️ `send` 不做背压等待:archive 在内存里长(会话以千条计),条目一条不丢比内存更紧要;
真正的背压手段是客户端断开 → scope 关闭 → 整条循环被 interrupt。

## 客户端怎么变

| 客户端                       | 变化                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli`                        | 起会话 → `send(prompt)` → 消费到 `answer` → `close`;`--json` 直接把事件 `JSON.stringify` 成 NDJSON(现在是手拼的)                                                                      |
| `repl`                       | **读行与消费事件并发**:一边 `for await readline`,一边 `Stream.runForEach(events, render)`。任务进行中打的字照样 `send` → 自动成为插入式 prompt;Ctrl-C → `interrupt`                   |
| `web` 宿主                   | `/api/turn`(一请求一流) → `/api/send` + `/api/events`(SSE 常驻)+ `/api/archive?from=`(刷新重放)。`reset` = 换一份 archive。`TurnEvent` 里现有的 `answer` / `error` 升进内核后可以删掉 |
| `web` 前端                   | 从"一轮一请求"变成"一条长连接 + 投递";刷新时先按游标重放条目(含 `thinking`,它已落盘),再接实时流失。需要处理 `received`(显示"插入的指令已收下,本步结束后生效")                         |
| `tui` / `desktop` / `mobile` | 未实现,按同一形状做                                                                                                                                                                   |
| 命名                         | 内核的 `Session` 与 Web 宿主的 `Session` 撞概念:宿主那个改名 `HostSession`,或让宿主只做 `AgentSession` 的搬运                                                                         |
| 一次性脚本                   | `runOnce(agent, input, settings, tools): Effect<string>` 放进 `loop/_util.ts`:起会话 → send → 等到 `answer` → close → 返回文本。**超时 / 预算由调用方给参数**(内核不再有 `MAX_STEPS`) |

## 测试

假 `Llm` 改成**条目驱动**(测试脚本里 `push(items)`),这样时序可控:

| #   | 用例                                                             | 断言                                                                     |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | 一条 prompt                                                      | 一拍一发 `answer`;`complete` 只被调 1 次                                 |
| 2   | 空闲时连发 3 条 prompt                                           | **只调 1 次** `complete`,items 里 3 条 user                              |
| 3   | 工具批次执行中投递 prompt(工具卡在 `Deferred` 上)                | 本拍 items 无该 user;下一拍 = `[..., calls, outputs, user]`              |
| 4   | 生成中 `interrupt`                                               | 无 `llm_responded`;发 `interrupted`;回 Idle;再 prompt 仍能工作           |
| 5   | 工具执行中 `interrupt`                                           | 每个未完成 call 都有 `已打断` 的 `tool_returned`(`validate` 过),不留半拍 |
| 6   | 工具报错 / 未知工具                                              | 错误当观测回填,循环继续                                                  |
| 7   | `shutdown`                                                       | 发 `closed`;`run` 完成;事件流结束;之后的 `send` 是 no-op                 |
| 8   | 一整段会话(含 3 次工具、1 次插话、1 次打断、1 次 `kill -9` 重启) | `validate` 零 Problem;`fold ≡ 缓存`                                      |
| 9   | `send` 不阻塞                                                    | 循环卡住时连发 100 条立即返回                                            |
| 10  | 模型永不收手(只调工具)                                           | **不会自行停**:只能靠 `interrupt`(锁住"已删 `MAX_STEPS`"这个语义)        |

用例 3/5/10 是本次改造真正的难点,别只测"happy path 一条 prompt"。

## 落地

分步实施顺序(每步动什么、怎么验收、回退点、上次踩过的坑)见
[`implementation-plan.md`](implementation-plan.md)。

`owner` 提醒:`run` 的签名变了 = SDK 破坏性变更;`packages/client/*` 都要跟,`docs`/索引同步。

## 设计里相互牵连的几处

下面这些不是规矩,是**当前设计里一改就会连带别处**的点;
真要改,先看它牵连谁:

| 点                                      | 牵到谁                                              |
| --------------------------------------- | --------------------------------------------------- |
| 一拍只发一次 `llm.complete`             | 并发两拍会让同一前缀被两个写者推着跑                |
| 收信只在 `awaitWork` / `adopted` 一处   | 循环体里再算一次 inbox 就会出现两份真相             |
| history / phase / inbox 只从 archive 推 | 多存一份 `Ref<Item[]>` 就有两个写者                 |
| `function_call` 与 `tool_returned` 同拍 | 差一条就 400(`validate` 第 2 条)                    |
| 事件只由 `eventsOf` 产出                | 循环里再 `Queue.offer(AgentEvent)` 就有两条出站路径 |
| `run` 不返回正文                        | 调用方靠 `answer` 事件;再返回 string 会有两份"结果" |
| 领域错误进 `errored` 而不打穿 effect    | 循环要活到 `shutdown` 才退出                        |
| `send` 不阻塞、不等结果                 | 要等结果就监听事件,别在 `send` 上加请求/响应语义    |
| 打断走信号(不走信箱)                    | `llm.complete` 期间没人读 archive 尾巴              |
| 没有步数上限                            | 要预算就去调用方,或记成 `budget_exhausted` 条目     |

## 暂未做 / 代价 / 复查条件

暂未做:流式输出(SSE 增量)· 上下文压缩 · 自动重试 / 退避 · 工具并发(阶段 4)· 请求/响应式 `ask()` API。

**代价**:

- 内核从"无状态纯函数式的 `run`"变成"有生命周期 + fiber + 日志 + 投影",测试要处理时序,代码量约翻倍;
- 所有状态都绕一道投影:改一行 `history` 的直觉不管用了([`archive.md`](archive.md) 的代价也计入这里);
- `run` 签名破坏性变更,5 个客户端入口都得跟;
- 回调(`Observer`)换成 `Stream`,不熟 Effect 的读者要多跨一道概念;
- `answer` 变成事件后,"拿到最终文本"变麻烦(`runOnce` 兜着,但 SDK 使用者会踩一次);
- 删了 `MAX_STEPS` = 无人看守时会一直烧 token(Web / REPL 有停止按钮,headless 靠调用方超时);
- 会话落盘 = 明文(思维链 + 工具输出)躺在本地文件里,权限与"不进 git/备份"得靠规矩守。

**复查条件**(任一条成立就回来改这份设计,别就地加补丁):

- 客户端普遍只需要"一问一答" → 说明常驻循环的价值不成立,退回一次性 `run`;
- 出现"同一会话里要换模型 / 换工具级权限"的真实需求 → 采纳 `configure` 事件(阶段 4);
- 一拍里被塞进 >5 条 prompt 导致模型混淆 → 引入"批内合并成一条带编号的 user message",并重写「历史」节;
- 出现模型长时间不收手烧钱的真事故 → 把预算**记成条目**(`budget_exhausted`)并在 `runOnce` 默认开,
  而不是把 `MAX_STEPS` 恢复成内核常量;
- 出现需要"流式增量渲染"的需求 → `llm.complete` 换 `Stream`,本节的事件模型不用改(增量事件另开一族)。
