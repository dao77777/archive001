# 决策:prompt 只留纯消息,配置上移 Agent,ask 由事件实现

> 已接受 · 2026-10-24 · 取代 [`0013`](0013-agent-encapsulates-inbox.md) 的 `Agent.ask` 暴露部分
> (Agent 仍封装 inbox)· **事件 schema 已被 [`0015`](0015-event-content-structure.md) 细化**
> (结构 / 内容分开 + inbox 事件)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)
> **部分被 [`0082`](0082-run-turn-on-loop.md) 取代**:`runTurn` 回到内核(解析只留一份),
> `send` + `events` 仍保留为底层协议。

## 矛盾

0013 之后,`Agent` 对外是 `run` + `ask`,但还有三处没分清:

| 问题                         | 说明                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| prompt 消息不纯              | `PromptMessage` 里塞了 `settings` / `tools` / `observe` / `reply`              |
| 配置被当成"每条消息的一部分" | 模型 / 工具其实是会话级参数,改一次要跟着每条 prompt 走                         |
| `ask` 被烘进内核             | 内核替客户端决定了"怎么等一轮回答";客户端无法换策略(超时、取消、多播)          |
| 事件是扁平的                 | 只有 `thinking` / `text` / `tool_call` / `tool_result`,没有 turn / step 的边界 |

## 处理

- **prompt 只留纯消息**:`send({ id, text })`;settings / tools / observe 全部从消息里移除。
- **配置上移 Agent**:`configure({ settings, tools })` 写进内部 `Ref`,状态机每次生成前读一次。
- **删掉 `Agent.ask`**:客户端用 `send` + `events` 自己实现;CLI / REPL / smoke / web 各有一份同构的
  `runTurn`,不放进 SDK。
- **事件改成层级生命周期**:
  ```
  engine.start → prompt.received(text) → turn.start(promptIds)
               → step.start → llm.start → … → llm.end
               → tool.batch.start → tool.call.start/end → tool.batch.end
               → step.end → turn.end → engine.end
  ```
  `prompt.received` 是唯一带原文的入口;turn 的 start/end 只带 id,避免文本重复。
  每个 start 都有对应 end;中断时 `onExit` 补齐。
- `AgentShape` 变成:
  ```ts
  interface AgentShape {
    readonly configure: (config: AgentConfig) => Effect.Effect<void>;
    readonly send: (prompt: PromptInput) => Effect.Effect<void>;
    readonly events: Stream.Stream<AgentEvent>;
    readonly run: Effect.Effect<never>;
  }
  ```
- `Inbox` 退回成纯队列(`offer` / `takeAll`),不再持有 reply / close。

## 为什么

- **职责单一**:inbox 只传消息,Agent 只存配置 / 发事件,`ask` 是客户端的策略。
- **客户端可换策略**:要超时就在 `runTurn` 外面套 `Effect.timeout`;要取消就中断订阅 / 引擎;
  要多个观察者就各自订阅 `events` —— 内核不需要知道。
- **生命周期可关联**:`turn.start.promptIds` / `turn.end.promptIds` 让客户端能按自己的 id 找到回答;
  `step` / `llm` / `tool` 的 start/end 让 UI 能画进度、能对时间与费用。
- **配置是会话事实**:模型 / 工具不该跟着每条消息复制;`configure` 一次,下一次生成生效。
- **为 archive 铺路**:层级事件天然就是"事实流",以后 archive 只追加这些事件,投影就是 fold。

## 代价

- **`ask` 重复实现**:CLI 与 REPL 各有一份 `_turn.ts`(web 是流式变体),改协议要改多处。
- **事件是热流**:必须先订阅再 `send`;只补发一次 `engine.end`,不做完整重放(那是 archive 的事)。
- **配置是 Agent 级**:同一个 Agent 上两个客户端用不同 settings 会互相覆盖;prequest 级配置不再可能。
- **中途 `configure` 的语义**:在下一次 LLM 调用生效,可能让同一轮前后两次生成用不同模型 / 工具。
- **事件量变大**:UI 必须忽略 lifecycle 事件,否则渲染会多出无意义行。
- **中断时的事件顺序**:executor 与状态机是两个纤维,`tool.batch.end` 与 `step.end` 的先后在中断边界上
  不保证严格嵌套(正常路径保证)。

## 复查条件

1. **`ask` 的重复实现开始漂移**:抽一个**客户端共享包**(不是 Agent 方法),或把 `runTurn` 作为
   `@archive001/agent/client` 的纯助手导出;内核仍不提供 `ask`。
2. **需要按 prompt 覆盖配置**:引入显式会话/多 Agent 实例,或给 `send` 加受控的 `overrides`
   (但要重新讨论"prompt 是否还纯")。
3. **需要断线重放 / 多端同步**:落 archive(事件持久化),`events` 变成 archive 的 tail;
   现在的热流只适合单进程实时。
4. **中断时的 start/end 不闭合成为问题**:在状态机里维护一个 scope 栈,所有 open 都用
   `acquireRelease` 式的句柄关闭,而不是手工 `live.stepOpen`。
5. **事件数量影响性能**:先按订阅者过滤(`Stream.filter`),或给事件加 `level`;不要删生命周期。
