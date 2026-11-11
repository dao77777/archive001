# 决策:扁平事件 —— inbox.offer 带内容,删掉 llm / tool 生命周期

> 已接受 · 2026-10-24 · 取代 [`0015`](0015-event-content-structure.md) 的具体事件清单
> (结构 / 内容分开的原则保留)· **`answer.produced` 部分已被 [`0017`](0017-answer-is-external.md) 取代**
> (最终回答由外部从 step 内容判断)· **`inbox.take` 的形状已被 [`0018`](0018-inbox-take-content.md) 取代**
> (take 也带完整消息)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0015 把结构 / 内容分开了,但事件还是太碎:

| 问题                             | 说明                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| inbox.offer 不带内容             | prompt 的内容在 `prompt.received`,工具结果在 `tool.call.output`,inbox 事件只是"有个 id" |
| llm.start / end 没有信息量       | 一次 step 就是一次模型调用,再包一层 start/end 只是多两条事件                            |
| tool.batch / tool.call.start/end | 工具的"开始 / 结束"不影响状态机,也很少被 UI 用;结果已经由 `inbox.offer` 带回            |
| 参数 / 输出被拆成单独事件        | `tool.call.arguments` + `tool.call.output` 与 `tool.call` 分开,回放时要按 id 拼三次     |

## 处理

- **`inbox.offer` 本身就是内容事件**:`{ message }`,message 是完整的 inbox 消息
  (`prompt { id, text }` 或 `tool_result { callId, name, output }`)。
  `inbox.take` 仍然只带 `messageIds`。
- **删掉 `llm.start/end`**:step 已经是"一次模型输出"的边界。
- **删掉 `tool.batch.*` / `tool.call.start/end`**:工具调用是 step 内的 `tool.call` 内容事件
  (`callId / name / arguments`);结果作为 `inbox.offer { message: tool_result }` 回来。
- **一个 step 只含**:`thinking` / `text` / `tool.call`;最终答复是 turn 级的
  `answer.produced`,在 `step.end` 之后、`turn.end` 之前发出。
- **错误只留 `turn.error`**(内容),`turn.end` 只带 `reason`。

最终事件清单:

```
engine.start / engine.end
inbox.offer { message } / inbox.take { messageIds }
turn.start / turn.end
step.start / step.end
thinking / text / tool.call
answer.produced
turn.error
```

## 为什么

- **inbox 是唯一需要"内容 + 状态"的地方**:offer 带内容、take 带 id,
  `offer − take` 就是 inbox;不需要再维护 `prompt.received` / `tool.call.output` 的映射。
- **step 的语义足够**:一次模型输出里的东西就是思考、正文、工具调用;工具执行与结果回填在 step 之外,
  不需要额外的 llm / tool 生命周期。
- **持久化更省**:同样一次工具轮从约 10 条事件降到约 6 条;结构事件更少,回放更快。
- **UI 更简单**:工具块由 `tool.call` 建,输出由 `inbox.offer(tool_result)` 回填;
  不需要处理 start/end 的配对。

## 代价

- **`inbox.offer` 同时承担内容与入队**:这是对"结构 / 内容严格分开"的一个有意例外;
  它的 message 可能很大(工具 stdout),但这也正是需要持久化的东西。
- **没有工具级时间线**:不知道某个工具何时开始 / 结束,只能从事件顺序推断。
- **没有 llm 级时间线**:不知道请求何时发出 / 返回,只能看 step 边界。
- **工具结果不在 step 里**:step 结束到结果回来之间,事件流里只有一个 `inbox.offer` / `inbox.take`;
  要画"工具执行中"的 UI 需要自己推断。
- **最终答复仍需特殊事件**:`text` 既是宣告又是正文,不能靠它唯一确定回答,所以保留 `answer.produced`。

## 复查条件

1. **需要工具耗时 / 并发观测**:加 `tool.call.started/finished`(结构,带时间戳)或 `metric` 事件,
   不要恢复整条生命周期。
2. **`inbox.offer` 的 message 太大**:把 message 内容拆到单独内容事件,offer 只留 id;
   但这会退回到 0015 的 inbox 重建成本,需要重新权衡。
3. **需要"工具执行中"的 UI**:在 step 之外加一个轻量 `tool.pending { callIds }` /
   `tool.settled`,或者由客户端根据 `tool.call` + `inbox.offer` 自行推断。
4. **最终答复改为纯 `text`**:如果确认所有客户端都能从"最后一个 step 的 text"取回答,
   可以删掉 `answer.produced`;但空回答 / 多 text 段要重新定义。
