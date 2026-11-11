# 设计:agent 循环

> 路径 `packages/agent/src/loop/`。**主服务的 `service.ts` / `live.ts` 直接放 `loop/` 根**(内部名 `Loop` / `LoopRuntime`),
> 子服务各占一个目录:`engine/` / `inbox/` / `events/` / `tool-executor/` / `builtin-tools/`,目录里 `service.ts` 是契约、
> `live.ts` 是实现;`src/index.ts` 在包边界把 `Loop` / `LoopRuntime` 改名成 `Agent` / `AgentRuntime` 再导出,
> 构建好的一层(`AgentLive`,带 Node 平台依赖)在 `src/live.ts`(`@archive001/agent/live`)。
> 模型层见 [`llm.md`](llm.md);一次完整的 turn 见 [`turn.md`](turn.md);跨包结构见 [`../overview.md`](../overview.md);
> 事件 schema 的取舍见 [`../../decisions/0025`](../../decisions/0025-error-as-content.md) 与
> [`0026`](../../decisions/0026-uppercase-tags-items.md)。

## 职责

对外**只有 `Agent`**,只有一个入口:`run` 起引擎并交出句柄,生命周期由调用方管。

一次完整的 turn 不在这里:它由 `turn/` 的 `Turn` 服务借 `run` 自己起停
(见 [`turn.md`](turn.md))。`Loop` 保持成一个持续运行的状态机。

`run` 交出的句柄:

| 成员                             | 作用                                |
| -------------------------------- | ----------------------------------- |
| `configure({ settings, tools })` | 调整模型 / 工具(下一次生成生效)     |
| `send({ id, text })`             | 往内部 inbox 塞一条**纯 prompt**    |
| `events`                         | 向外发完整生命周期事件(结构 + 内容) |
| `fiber`                          | 引擎纤维;中断它就是停这一段 run     |

- 持续运行以 step 为循环:调用方自己 `send` / 订阅 `events` / 决定何时停。
- inbox / tool executor / 事件总线都是内部实现。

## 内部实体

| 实体       | 文件                                   | 职责                                                                        | 不知道什么                              |
| ---------- | -------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| inbox      | [`inbox.ts`](inbox.md)                 | 收集 prompt / tool result;攒到"就位"再交出整批;发 `INBOX_*`                 | settings、tools、transcript、谁在等回答 |
| engine     | `engine.ts`                            | `Engine` 服务:只跑 step 循环,每步从投影拿 transcript;`configure` 换模型工具 | turn、工具怎么执行、客户端怎么等回答    |
| 工具执行器 | [`tool-executor.ts`](tool-executor.md) | 批内并发跑一批 `function_call`,完成即把观测写回 inbox                       | 下一步做什么、要不要继续调模型          |
| 事件总线   | `events.ts`                            | 所有事件的唯一出口:archive 队列 + 实时流;记住终点事件                       | 事件是谁发的、agent 现在到哪一步了      |

依赖方向:`Agent → Engine → Llm / Inbox / ToolExecutor / Events`;`ToolExecutor → Inbox → Events`。
`AgentLive` 把它们装配好并**全部藏起来**,客户端拿到的只有 `Agent`。

## 事件

每个事件都有 `id`;`parentId` 指向所属容器。层级只靠这两个字段。
**所有 `_tag` 大写**,内容事件命名与 [`llm/_domain.ts`](../../../packages/agent/src/llm/_domain.ts) 的 `Item` 对齐。

类型定义在 [`archive/service.ts`](../../../packages/agent/src/archive/service.ts)。`Agent.events` 发的是
`ArchiveEntry`:在事件字段之外还带 `v` / `at`。

```ts
type ArchiveEntry<T extends ArchiveEntryTag = ArchiveEntryTag> = T extends ArchiveEntryTag
  ? {
      v: 1;
      at: number;
      _tag: T;
      id: ArchiveEntryId; // 见 docs/designs/agent/archive.md
      parentId?: ArchiveEntryId;
    } & ArchiveEntryPayloads[T]
  : never;
```

不写泛型时是全部记录的联合;`ArchiveEntry<"INBOX_OFFER">` 的 `message` 自动是 `InboxMessage`。
`v / at` 由事件总线(`events.ts` 的 `publish`)在发实时流和入 archive 队列之前补上;顺序由文件行序决定。

```
结构(生命周期)                              内容(容器里发生的事)
────────────────────────────────────────   ─────────────────────────────────
ENGINE_START / ENGINE_END                   INBOX_OFFER { message }
TURN_START  / TURN_END                      INBOX_TAKE  { messageIds }
STEP_START  / STEP_END                      USER_MESSAGE { inboxId }
                                            FUNCTION_CALL_OUTPUT { inboxId }
                                            ASSISTANT_MESSAGE { text }
                                            REASONING { text }
                                            FUNCTION_CALL { callId, name, arguments }
                                            STEP_ERROR / TURN_ERROR / ENGINE_ERROR { message, cause? }
                                            ARCHIVE_ERROR { message, cause? }   // 顶层:archive 挂了
```

- ⚠️ **引擎只发 `ENGINE_*` / `STEP_*` 与 step 内容**;`TURN_*` 和 step 的 `parentId` 是
  `Turn` 通过 `Loop.run({ archive })` 的 hook 在写入 archive 之前织进来的(见 [`turn.md`](turn.md))。
  下面的事件序列是 **archive 里看到的最终形状**,不是引擎单独发出的原始事件。
- **turn / step 的 `START` / `END` 共用同一个 `id`**;引擎没有身份(现在只有一段运行),
  `ENGINE_*` 只标记开始 / 结束,不参与 `parentId`;
- `INBOX_OFFER` 带**完整消息**,`INBOX_TAKE` 只带**引用**;
- 错误是**内容**,排在最后:出错后照常发所属层级的 `END`;`END` 不带 `reason`;
- 错误 payload 是 `{ message, cause? }`:`message` 是给人看的摘要,`cause` 是底层原因(字符串)。
- step 的内容与 `Item` 一一对应:`USER_MESSAGE` / `ASSISTANT_MESSAGE` / `REASONING` /
  `FUNCTION_CALL` / `FUNCTION_CALL_OUTPUT`。
- **system 不是一个 step 的内容,而是这一次运行的状态**:`SYSTEM_MESSAGE_SET { text }`(开头设一次)、
  `SYSTEM_MESSAGE_CLEAR`(收尾时清掉),都是顶层事件(没有 `parentId`);每一步用的 system 由投影按
  当时的状态补出来([`archive.md`](archive.md#能从-archive-恢复什么读侧))。

inbox 消息(`INBOX_OFFER.message`)也复用同样的命名:

```ts
{
  _tag: ("USER_MESSAGE", id, text);
}
{
  _tag: ("FUNCTION_CALL_OUTPUT", callId, name, output);
}
```

正常路径:

```
ENGINE_START                                       // 顶层:一段运行开始(引擎没有身份)
  SYSTEM_MESSAGE_SET { text }                     // 顶层状态:只设一次
  INBOX_OFFER { message: USER_MESSAGE }           // 顶层,无 parentId
  INBOX_TAKE  { messageIds }
  TURN_START  { id: T }                           // 顶层(引擎无 id,不挂 parentId)
    STEP_START { id: S1, parentId: T }
      USER_MESSAGE           { id: …, parentId: S1, inboxId }
      REASONING / ASSISTANT_MESSAGE / FUNCTION_CALL { parentId: S1 }
    STEP_END   { id: S1, parentId: T }
    INBOX_OFFER { message: FUNCTION_CALL_OUTPUT }
    INBOX_TAKE  { messageIds }
    STEP_START { id: S2, parentId: T }
      FUNCTION_CALL_OUTPUT   { parentId: S2, inboxId } // 上一步的工具结果(按 inboxId 引用)
      USER_MESSAGE           { parentId: S2, inboxId } // 只有新并进来的 prompt 才有;多条就多条事件
      REASONING / ASSISTANT_MESSAGE / FUNCTION_CALL
    STEP_END   { id: S2, parentId: T }
  TURN_END  { id: T }
  SYSTEM_MESSAGE_CLEAR                            // 顶层状态:收尾时清掉
ENGINE_END                                          // 顶层:这一段结束
```

出错时(error 是内容,ends 照常闭合):

```
STEP_ERROR   { parentId: S, message, cause? }   // 模型调用失败
STEP_END     { id: S, parentId: T }
TURN_ERROR   { parentId: T, message, cause? }   // hook 在 STEP_END 后补
TURN_END     { id: T }

ENGINE_ERROR { message, cause? }                // 引擎缺陷(顶层)
ENGINE_END   { id: E }

ARCHIVE_ERROR { message, cause? }              // 顶层内容:archive 停止,之后的记录不再落盘;
                                               // 不写入 archive(它自己就是坏的),只出现在 events 上
```

- step 的内容顺序与 **transcript / 请求报文一致**:工具观测在前(紧跟它们的 `FUNCTION_CALL`)、
  新 prompt 在后,然后是模型输出、错误。⚠️ 反了就是非法报文 —— `FUNCTION_CALL_OUTPUT` 与
  `FUNCTION_CALL` 之间不能夹 prompt。
- system **不在 step 内容里**:它是引擎级状态(`SYSTEM_MESSAGE_SET` / `SYSTEM_MESSAGE_CLEAR`),
  每一步用的是当时的状态(见上文「事件」表与 [`archive.md`](archive.md#能从-archive-恢复什么读侧))。
- `USER_MESSAGE` 事件只带 `inboxId`(引用,一条 prompt 一条事件);正文在 `INBOX_OFFER` 的
  `USER_MESSAGE.payload.text` 里。
- `FUNCTION_CALL_OUTPUT` 事件只带 `inboxId`(引用);输出在对应 `INBOX_OFFER` 的 payload 里。
- 最终回答**不是单独事件**:一个 step 没有 `FUNCTION_CALL` 时,它的 `ASSISTANT_MESSAGE` 文本就是回答;
  外部按 step 折叠(每步清空缓冲、`ASSISTANT_MESSAGE` 追加,`TURN_END` 时取最后一步)。
- 中断属于普通停止:逐层 `END`,不发 error。

## inbox 与工具执行器

- **inbox**:排队 + "攒到就位" + 发 `INBOX_*` 事件 —— 见 [`inbox.md`](inbox.md);
- **tool executor**:批内并发跑工具、失败转观测、截断、写回 inbox —— 见
  [`tool-executor.md`](tool-executor.md);
- **从事件还原 inbox**:`INBOX_OFFER − INBOX_TAKE` 由 `project()` 折叠出来 —— 见
  [`archive.md`](archive.md#能从-archive-恢复什么读侧)。

## 与 Turn 的关系

一次完整的 turn(开 run → 解析事件 → 关 run)在 [`turn.md`](turn.md);解析只在那里一份。
`Loop.run({ archive })` 把 archive hook 交给 `Events`:每条事件写入 archive 之前先过 hook,
`Turn` 就是在这个口子上插入 `TURN_*`、给 `STEP_*` 挂 `parentId`;不传 hook 时引擎只发 step 事件。
持续运行模式没有解析助手:客户端自己订阅 `events`,按 turn.md 的规则对齐 turn / 收回答 / 归错误
(测试里的 `ask` 是这条路径的示例)。

**run 的边界**:`run` 在 fork 引擎前调 `Events.begin`,清掉上一次 `ENGINE_END` 的回放,
所以新一轮的订阅者不会当场收到旧终点。

**transcript 跨 run**:`ENGINE_START` 不再清空 transcript;会话边界是 archive 里的 **session**
(`sessionId`)。所以同一会话里的第二次 `Turn.runTurn` 仍然带着第 1 轮的历史;
web reset = `Archive.startSession`,新进程默认回到最后一段会话。

## 状态机

| 状态       | 进入条件                 | 在做什么                              | 出口                                                       |
| ---------- | ------------------------ | ------------------------------------- | ---------------------------------------------------------- |
| idle       | inbox 里没有待回填的结果 | 阻塞等 prompt(`takeReadyBatch([])`)   | 拿到 prompt → generating                                   |
| generating | 有 prompt / 有齐了的结果 | 调一次模型,期间不碰 inbox(新消息排队) | 只回正文 → `STEP_END`(hook 补 `TURN_END`);有调用 → waiting |
| waiting    | 上一步产出了 tool call   | 等结果集齐(`takeReadyBatch(callIds)`) | 集齐 → 交出整批 → generating                               |

- **settings / tools** 由 `configure` 写进 `Ref`;状态机**每次生成前**读一次。
  中途 `configure` 会在下一次 LLM 调用生效;没配置就开跑会以 `ENGINE_ERROR` 收尾
  (还没开 step,所以没有 turn 事件)。
- 模型报错(`LLM_ERROR`)不杀循环:引擎发 `STEP_ERROR` + `STEP_END`,hook 随后补
  `TURN_ERROR` / `TURN_END`,回到 idle。

## 顺序:工具结果必须紧跟 FUNCTION_CALL

```
[SYSTEM_MESSAGE, ...transcript, 结果₁…结果ₙ, 新 prompt₁…新 promptₘ]
                                  └── 先补完上一轮的调用 ──┘  └── 再放用户新话 ──┘
```

⚠️ 反了就是非法报文:`FUNCTION_CALL_OUTPUT` 与 `FUNCTION_CALL` 之间夹一条 user 消息,
回放契约直接破。**这个顺序由 inbox 交出时就排好**(`takeReadyBatch` 返回 `{ functionCallOutputs, userMessages }`,
结果按调用顺序),engine 只按顺序追加。

## 历史

- `transcript` 不在引擎本地:每步从 `Archive.projection("transcript")` 拿(archive 是唯一状态源),
  **同一会话内跨 run 保留**;会话边界是 `sessionId`,由 `Archive.startSession` / `useSession` 切。
- 用户消息与 assistant 正文都会写入,**逐条**(模型分几段就几条);空文本不入(会毒死会话)。
- ⚠️ **工具轮整批保留**(含 `REASONING`):responses 的回放契约要求每个 `FUNCTION_CALL` 前有
  `reasoning_text`。纯问答轮不保留思维链。
- 没有"清空当前会话"的接口:web 的 reset 用 `Archive.startSession` 开新会话(旧会话仍留在文件里)。
- 增长无上限,上下文压缩仍未做。

## 工具

- 契约只有 `{ definition, execute }`,调用方自己造工具就按这个写;
- 内置工具在 `builtin-tools/live.ts`,用文件内的 `makeTool`(一份 Effect Schema 同时产出 JSON Schema 与运行时校验);
- 内置工具由 `AgentLive` 自己装配(`Layer.provide(BuiltinToolsLive)`),`configure` 不传 `tools` 就用它们,传了就替换掉。
- 执行、失败转观测、截断、写回的细节在 [`tool-executor.md`](tool-executor.md);这里只留三条接口约定:
  1. 工具**可以失败也可以抛异常**,转成 `错误:…` 观测是执行器的事;
  2. 输出**不必自己截断**,上限由执行器统一施加;
  3. 观测写回顺序 = **完成顺序**(批内并发),transcript 的调用顺序由本文件重排保证。
- `BuiltinTools` 只是"想要 bash/读/写/列目录时"的现成实现;调用方可以给空数组,或自己造工具。

## 暂未做

- **事件持久化 / replay**:落盘与 `project()` 折叠已做(见 [`archive.md`](archive.md));跨会话恢复
  已有 `Archive.useSession`;增量读 `entries(fromLine)` 还没做。
- **取消 / 中断传播**:`Turn.runTurn` 被中断会关掉本轮 run;要停一个常驻 run 仍需中断句柄的 fiber
  或关掉层 scope。
- **调用次数 / 成本上限**:刻意没有。模型陷入"调工具 → 再调工具"时不会自动停,
  只能人工中断;要加也应做成会话级预算,而不是写死步数。
- 流式输出 · 上下文压缩 / 摘要 · 沙箱 · 多轮规划器 · **工具级限流**(现在整批一个并发上限,
  不区分读写工具)。
