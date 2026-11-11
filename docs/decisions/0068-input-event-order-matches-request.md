# 决策:step 输入事件顺序与请求一致(工具观测在前、新 prompt 在后)

> 已接受 · 2026-10-24 · 取代 [`0027`](0027-input-event-order.md) 的"事件顺序与 transcript 顺序解耦" ·
> 落点 `packages/agent/src/loop/engine.ts` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md#事件)

## 矛盾

`0027` 定的是:事件里按"系统 → 用户 → 工具结果"分组(方便阅读),transcript / 请求里按
"工具结果 → 用户"(回放契约),两套顺序**刻意解耦**,理由是"事件是展示,transcript 是报文"。

问题在于 `project()` 是**按事件顺序**还原 transcript 的:

```ts
case "FUNCTION_CALL_OUTPUT": engine?.transcript.push({ type: "FUNCTION_CALL_OUTPUT", … });
case "USER_MESSAGE":        engine?.transcript.push({ type: "USER_MESSAGE", text });
```

于是"等工具时用户又插了一句"这种真实场景(一批里同时有观测和 prompt),投影出来的 transcript 是

```
… FUNCTION_CALL, USER_MESSAGE(新), FUNCTION_CALL_OUTPUT   ← 错:prompt 夹在调用与观测之间
```

而引擎真正发给模型的是 `… FUNCTION_CALL, FUNCTION_CALL_OUTPUT, USER_MESSAGE(新)`。
**双顺序在投影层已经变成真 bug**,正好踩中 `0027` 的复查条件 1。

## 处理

把 step 输入事件的 emit 顺序调成与请求一致:

```ts
// 工具观测在前(紧跟它们的 FUNCTION_CALL),新 prompt 在后 —— 与 transcript / 请求同一个次序
yield* Effect.forEach(functionCallOutputs, …emit FUNCTION_CALL_OUTPUT…);
yield* Effect.forEach(userMessages, …emit USER_MESSAGE…);
```

- 事件顺序 = transcript 顺序 = 请求顺序,system 已经是独立的引擎级状态
  ([`0067`](0067-system-message-as-state.md)),不再参与 step 内排序;
- `project()` 不用改:按事件顺序拼出来的就是真实 transcript;
- 回归用例:等工具时插一句 prompt → 断言投影出的 transcript 是
  `[USER, FUNCTION_CALL, FUNCTION_CALL_OUTPUT, USER, ASSISTANT]`(换回旧顺序会失败)。

## 为什么

- **投影只靠事件顺序就能还原报文**:不用再在投影里写"观测要排到 prompt 前面"这条规则;
- **archive 读起来就是请求的样子**:排查 `400` 类问题时,直接照 archive 的顺序对照 wire 即可;
- **少一套记忆负担**:`0027` 的代价里已经写着"事件顺序 ≠ transcript 顺序,排查时要记住…",
  这条现在就消失了;
- **保持"所见即所喂"**:archive 是请求的忠实记录,顺序也是记录的一部分。

## 代价

- **阅读分组变了**:人肉读 archive 时先看到工具观测、再看到新 prompt;想看"这一步喂了哪些 prompt"
  要往后翻;
- **旧 archive 不一致**:早先写下的 step 里 prompt 在观测前,`project` 会按旧顺序还原(与当时的请求
  顺序相反);要严格兼容得在投影里加一段"观测提前"的重排;
- **多了一个隐式约定**:以后新增任何"step 输入"类事件,都得排在 `FUNCTION_CALL` 之后、模型输出之前,
  否则报文非法 —— 这条现在写在 `loop.md` 的警告里,不在类型里。

## 复查条件

1. **需要按"输入分组"展示**(系统/用户/工具结果各归一组):在客户端按 `_tag` 分组渲染,
   不要动事件顺序。
2. **必须兼容旧 archive 的旧顺序**:在 `project` 里对老行做一次"观测提前"的重排,并标明版本;
   不要为了兼容把 emit 顺序改回去。
3. **出现"一批里既有多条观测又有多条 prompt 且需要交错"**:顺序规则要重新定义(比如按
   `INBOX_TAKE` 的到达顺序),那时单独立决策,别让两套顺序再次分叉。
