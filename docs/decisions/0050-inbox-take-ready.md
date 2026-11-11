# 决策:"攒到就位"归 inbox 管(`takeReady` 取代 `takeAll`)

> 已接受 · 2026-10-24 · 细化 [`0009`](0009-inbox-loop.md) 的三个实体划分
> · **返回值 `{ messages, takes }` 与"状态机发 `INBOX_TAKE`"已被 [`0051`](0051-inbox-writes-events.md) 取代**
> (`INBOX_TAKE` 由 inbox 自己发);"只返回消息数组"又被 [`0062`](0062-inbox-ready-batch.md) 取代
> (改成交出 `{ results, prompts }`,分类与结果排序都在 inbox)
> (inbox 从"笨队列"变成"能判断就位的队列")· 落点 `packages/agent/src/loop/inbox.ts` ·
> 设计见 [`../designs/agent/inbox.md`](../designs/agent/inbox.md#就位规则)

## 矛盾

旧实现里,inbox 只会 `takeAll`,**"什么时候算攒够了"写在状态机的循环条件里**:

```ts
while (true) {
  if (pending.length === 0) {
    buffer = buffer.filter(isUserMessage);
    if (buffer.length > 0) break;
  } else if (
    pending.every((c) => buffer.some((m) => isToolOutput(m) && m.payload.callId === c.callId))
  )
    break;
  buffer.push(...(yield * inbox.takeAll));
}
```

| 问题             | 说明                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| 职责错位         | inbox 的唯一职责是"交接面",但它的交接时机由消费方在外面用 10 行 if 推出来       |
| 消费方要知道内情 | 状态机必须知道"inbox 里可能有上次中断留下的迟到结果"这种队列细节,才能决定丢不丢 |
| 攒着的消息在外面 | 中途取走、还没并进 transcript 的消息放在状态机局部 `buffer` 里,引擎一被中断就丢 |
| 语义重复         | 等结果 / 挑结果 / 丢迟到结果,这三件事 `llm.ts` 和 `tool-executor.ts` 都各懂一点 |

## 处理

inbox 的接口从 `takeAll` 换成 `takeReady(awaiting)`:`awaiting` 是还等着回填的 `callId`,
**没就位它就自己一直等**(队列空时 `takeAll` 挂起,取到的先攒在内部 buffer),就位后一次交出整批。

```ts
takeReady(awaiting: ReadonlyArray<string>): Effect<{
  messages: ReadonlyArray<InboxMessage>; // 就位的这一批
  takes: ReadonlyArray<ReadonlyArray<InboxMessage>>; // 由哪几次出队拼成
}>
```

| `awaiting` | 就位条件                     | 交出的内容                         |
| ---------- | ---------------------------- | ---------------------------------- |
| 非空       | 这些 `callId` 的结果全部到齐 | 结果 + 等结果期间混进来的 prompt   |
| 空         | 至少一条 prompt              | 只有 prompt;工具结果当迟到结果丢掉 |

- 状态机退化成一句 `const batch = yield* inbox.takeReady(pending.map((c) => c.callId))`;
- `takes` 让"每次出队发一条 `INBOX_TAKE`"的事件语义原样保留(事件条数、id、时机都不变);
- 内部 buffer 用 `Ref` 持有:等就位期间被中断,已出队的消息不丢,下次 `takeReady` 接着攒。

## 为什么

- **交接时机是 inbox 自己的事**:它最先知道"又来一条了、现在还缺哪条",让别人在外面轮询是重复建模。
- **状态机只剩它该懂的事**:transcript 顺序(结果在前、prompt 在后)、回放契约、事件层级。
  它不再需要知道"迟到结果"这种队列细节。
- **事件不需要改**:`INBOX_OFFER` / `INBOX_TAKE` 的形状和含义(出队时发、只带引用)都没动,
  客户端 `ask` 的对齐逻辑照常工作。
- **丢消息的口子收窄**:`buffer` 从"状态机局部变量"变成 inbox 状态,引擎中断不再丢已出队的消息。

## 代价

- **inbox 不再是"笨队列"**:它懂两种消息(`USER_MESSAGE` / `FUNCTION_CALL_OUTPUT`)和 `callId`,
  也就意味着新的消息类型若要参与"就位"判断,得改 inbox 而不是只改状态机。
- **`takes` 是额外形状**:为了不改变 `INBOX_TAKE` 的逐次语义,返回值多带一层"出队批次"。
  不想保这个语义时,它是最先该删的字段。
- **多一层 `Ref`**:`takeReady` 每次循环至少一次 `Ref.set`;攒到就位期间队列里没有消息,
  事件投影上看不出"buffer 里有几条"。
- **中断窗口变窄但没消失**:`takeAll` 与 `Ref.set` 之间被中断仍会丢那一小步(旧实现整批都丢)。

## 复查条件

1. **出现第三种消息类型**(比如 `SYSTEM_INJECT` / 取消信号):若它也要参与"就位",
   就把就位条件抽成 inbox 的显式规则表;若只是旁路,不要塞进 `takeReady`。
2. **`takes` 没人用**:客户端与 archive 都不在乎"哪一次出队",合并成一条 `INBOX_TAKE`
   (整批一个事件),`InboxBatch` 退化成 `ReadonlyArray<InboxMessage>`。
3. **需要观察 buffer**("已出队未消费"要出现在事件 / 投影里):加一条 `INBOX_HOLD` 或在
   `INBOX_TAKE` 上区分 `held`,见 [`0015`](0015-event-content-structure.md) 复查条件。
4. **同一实例并发多个 `takeReady`**:现在只有一个状态机在等,天然互斥;真要并发消费时
   必须把"检查 + 出队 + 清 buffer"做成一个事务,否则会重复交出同一批。
