# 决策:inbox 交出"分好类、排好序"的一批(`ReadyBatch`)

> 已接受 · 2026-10-24 · 收紧 [`0050`](0050-inbox-take-ready.md)/[`0051`](0051-inbox-writes-events.md)
> 的边界(inbox 现在也负责分类与结果排序)· 落点 `packages/agent/src/loop/inbox.ts` ·
> 设计见 [`../designs/agent/inbox.md`](../designs/agent/inbox.md#就位规则)

## 矛盾

`takeReady` 一直返回"一袋消息"(`ReadonlyArray<InboxMessage>`),engine 拿到后还要自己干三件事:

```ts
const prompts = taken.filter(isUserMessage);
const results = taken.filter(isFunctionCallOutput);
consumedResults = pending.flatMap((call) => results.find((r) => r.payload.callId === call.callId));
```

| 问题              | 说明                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| 排序规则在 engine | `results` 是**完成顺序**(0057),要按调用顺序重排得靠 `pending` 再走一遍  |
| 过滤规则在 engine | `taken` 里可能有不在 `pending` 里的迟到结果,engine 得自己按 callId 挑掉 |
| 同一规则两处懂    | inbox 已经知道 `awaiting`(调用顺序),engine 又用 `pending` 重复表达一次  |
| 每次都要两遍过滤  | `filter(isUserMessage)` + `filter(isFunctionCallOutput)`,再 find 一遍   |

## 处理

`takeReady` 直接交出**结构化、已排序**的一批:

```ts
interface ReadyBatch {
  functionCallOutputs: ReadonlyArray<InboxMessage<"FUNCTION_CALL_OUTPUT">>; // 只含这次等的 callId,按 awaiting 顺序
  userMessages: ReadonlyArray<InboxMessage<"USER_MESSAGE">>; // 按到达顺序
}

takeReady(awaiting): Effect<ReadyBatch>
```

- `readyBatch` 从 `Option<messages>` 改成 `Option<ReadyBatch>`:齐了就按 `awaiting` 把结果挑出来排好
  (新助手 `outputsInOrder`),`userMessages` 单独一类;不属于这次等的观测**就地丢掉**;
- engine 变成两段顺序追加:

```ts
const { functionCallOutputs, userMessages } = yield* inbox.takeReady(pending.map((call) => call.callId));
for (const observation of functionCallOutputs) transcript = [...transcript, { type: "FUNCTION_CALL_OUTPUT", … }];
for (const message of userMessages) transcript = [...transcript, { type: "USER_MESSAGE", text: … }];
```

- engine 不再需要 `isUserMessage` / `isFunctionCallOutput`(那两个 refinement 回到 inbox 内部使用);
- `functionCallOutputs` 同时复用为 step 内容事件(`FUNCTION_CALL_OUTPUT { inboxId }`)的来源,不再有 `consumedResults`;

## 为什么

- **规则跟着数据走**:inbox 是唯一知道"这一批里哪些是这次等的、它们按什么顺序"的地方,
  排序与过滤在这里是同一件事,分开就得让 engine 复述一遍;
- **engine 只剩 transcript**:它负责"按顺序追加 + 发事件",不再碰 `callId` 匹配;
- **形状即契约**:`{ functionCallOutputs, userMessages }` 把"观测在前、prompt 在后"写进类型,读代码不用推;
  字段名与消息的 `_tag` / transcript 的 `Item.type` 同名,一个词从 inbox 用到 transcript;
- **少一次隐式约定**:原来"`taken` 里可能有迟到结果"只写在注释里,现在由 inbox 保证不给。

## 代价

- **inbox 又懂多一件事**:它现在管"就位 + 分类 + 结果排序",不再只是"容器 + 队列";
  以后要改 transcript 的顺序语义(比如把 prompt 插到结果之间),得改 inbox 而不是 engine;
- **`INBOX_TAKE` 与交出内容不再一一对应**:事件仍按"每次出队"发(只带 id),
  而交出的 `functionCallOutputs` 可能只是这些消息的一个子集(迟到观测被丢),事件与返回值不能简单对齐;
- **`awaiting` 的语义被强化**:它不只是"还等什么",还是"输出的排序键";
  engine 传错顺序(`pending` 顺序错)会直接反映到 transcript 上;
- **多一层结构**:`ReadyBatch` 比数组多两个字段,测试与调用点都要跟着改。

## 复查条件

1. **需要"部分就位"**(先给已回来的结果、不等齐):`ReadyBatch` 的构造要能表达"缺谁",
   那时把 `readyBatch` 改成返回 `Some(交出的) | None(还缺的 callId)`,并单独立决策。
2. **transcript 顺序要变**(prompt 插进结果之间 / 按时间混排):排序归 inbox 的假设不成立,
   把 `ReadyBatch` 降级成"已分类未排序",排序搬回 engine。
3. **需要从 `INBOX_TAKE` 还原出交出内容**:事件就得区分"取走但丢掉"与"取走并交出"
   (比如 `INBOX_TAKE` 带上 `kept` / `dropped`),否则投影只能看到"取走过"。
4. **`inbox` 承担了更多规则**(redact、去重、限流):先问它是不是"队列的事",
   不是就别再往里塞 —— 见 [`0051`](0051-inbox-writes-events.md) 的复查条件 1。
