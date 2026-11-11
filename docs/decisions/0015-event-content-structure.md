# 决策:事件分结构与内容,inbox 用 offer / take 还原

> 已接受 · 2026-10-24 · 细化 [`0014`](0014-agent-events-and-config.md) 的事件 schema
> (API 形状不变)· **具体事件清单已被 [`0016`](0016-flat-events.md) 取代**
> (结构/内容分开的原则保留)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0014 的事件已经能大致还原消息历史,但还有两个问题:

| 问题               | 说明                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| 结构事件混着内容   | `turn.end` 带 `answer` / `error`,`tool.call.start` 带 `arguments`,`tool.call.end` 带 `output` |
| inbox 状态无法还原 | 只有消息"到达"的事实,没有"被取走"的事实;不知道哪些还在队列里                                  |

而目标是把事件**全部持久化**,只靠事件就能还原细节(包括 inbox)。

## 处理

- **结构事件只带 id / 阶段 / 类型**:
  `engine.*`、`inbox.offer { messageId, kind }`、`inbox.take { messageIds }`、
  `turn.start/end { turnId, promptIds, reason }`、`step.*`、`llm.start/end`、
  `tool.batch.start/end { callIds }`、`tool.call.start/end { callId, name }`。
- **内容各自一条事件,按 id 关联**:
  `prompt.received { promptId, text }`、`thinking` / `text` / `answer.produced { turnId, text }`、
  `llm.error` / `turn.error { message }`、
  `tool.call.arguments { callId, arguments }`、`tool.call.output { callId, output }`。
- **inbox 投影 = offer − take**:
  - `Agent.send` 先发 `prompt.received`,再发 `inbox.offer`;
  - 工具执行器先发 `tool.call.output`,再发 `inbox.offer`;
  - 状态机每次 `takeAll` 后发 `inbox.take`。
- 客户端 `runTurn` 改为在 `answer` / `llm.error` / `turn.error` 上收集内容,
  到结构事件 `turn.end` 再用收集到的值收尾。

## 为什么

- **持久化/回放的前提是"一个事实只有一处"**:结构事件可被索引、可被压缩、可被 diff;
  正文、参数、输出、错误各自独立,导出时可以在内容边界上做 redact。
- **inbox 是状态,不是副作用**:只有 offer 没有 take,就永远不知道队列里还剩什么;
  加上 take 之后,`offer − take` 就是 inbox 的投影,和实际 `Queue` 语义一致。
- **结构稳定、内容易变**:UI / 投影只需要关心结构事件的 shape;内容事件可以单独演进。
- **层级不被内容污染**:`turn.end` 只表达"这一轮结束了",不需要因为 answer 很长而变大。

## 代价

- **事件条数变多**:一次工具调用从 2 条(start/end)变成 4 条(start/arguments/output/end)。
- **客户端要维护内容缓冲**:`runTurn` 不再能从 `turn.end` 直接拿 `answer`,必须先记 `answer` 事件;
  错误同理。
- **UI 要多处理两个事件**:工具块先由 `tool.call.start` 建,再由 `arguments` / `output` 回填。
- **`inbox.take` 是"出队"而不是"已处理"**:状态机 take 后暂存在 buffer 里的消息不在 inbox 里;
  如果此时引擎被中断,它们会丢,事件流无法恢复 buffer 内容。
- **顺序敏感**:`answer` 必须在 `turn.end` 前、`tool.call.output` 必须在 `inbox.offer` 前,
  发布顺序错了同一条事实就会缺失。

## 复查条件

1. **事件量成为瓶颈**:先按订阅者过滤(结构 / 内容),或给事件加 `level`;不要合并结构事件。
2. **需要恢复"已 take 但未处理"的消息**:在状态机里加 `engine.buffer` 结构事件
   (取走时入 buffer、处理时出 buffer),或者改成"处理时才 take";这会改变 inbox 的语义,需要重写本节。
3. **需要按内容做权限 / 保留策略**:内容事件已经是天然边界;在写入 archive 前按事件 tag 做
   redact / 丢弃,不要回到结构事件里。
4. **客户端内容缓冲开始重复**:抽一个客户端共享的 `runTurn` 助手(不是 Agent 方法),
   把 `answer` / `error` / `turn.end` 的拼装收敛到一处。
5. **需要完整重放 LLM 请求**:再增加 `llm.requested` 内容事件(items / tools / settings);
   现在只记录了模型输出侧的内容。
