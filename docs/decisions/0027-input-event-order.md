# 决策:step 输入事件按 SYSTEM → USER → FUNCTION_CALL_OUTPUT 排,错误最后

> 已接受 · 2026-10-24 · 细化 [`0026`](0026-uppercase-tags-items.md)
> (命名不变)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)
> · **已被 [`0068`](0068-input-event-order-matches-request.md) 取代**:step 输入事件改成与请求同序(观测在前、prompt 在后)。

## 矛盾

step 的内容事件顺序之前是:

```
SYSTEM_MESSAGE
FUNCTION_CALL_OUTPUT   // 工具结果
USER_MESSAGE           // 新 prompt
REASONING / ASSISTANT_MESSAGE / FUNCTION_CALL
```

但 `SYSTEM_MESSAGE` / `USER_MESSAGE` / `FUNCTION_CALL_OUTPUT` 都是 **LLM 的输入**,
应该同层、按"系统 → 用户 → 工具结果"排;错误则应该放在最后,表示这一步的结局。

同时,真正的 transcript 顺序必须是:
`FUNCTION_CALL_OUTPUT` 紧跟 `FUNCTION_CALL`,且排在新 user 消息之前(回放契约)。
**事件展示顺序**与 **wire 报文顺序**不是一回事。

## 处理

- step 内容事件顺序改为:

  ```
  SYSTEM_MESSAGE
  USER_MESSAGE
  FUNCTION_CALL_OUTPUT
  ASSISTANT_MESSAGE / REASONING / FUNCTION_CALL
  STEP_ERROR(如果有)
  STEP_END
  ```

- `ArchiveEvent` 类型与文档里,错误事件统一挪到内容组最后。
- 状态机的 transcript 拼接顺序**不变**:结果先、prompt 后,保证 wire 合法。
- 测试/文档只断言"事件里输入在前、输出在后、错误最后";不改变模型请求。

## 为什么

- **按语义分组**:输入(系统 / 用户 / 工具结果)一组,输出(正文 / 思考 / 工具调用)一组,错误收尾。
- **阅读顺序自然**:先看喂了什么,再看模型产出了什么,最后看有没有错。
- **不牺牲 wire 正确性**:事件顺序与请求顺序解耦;两者各自服务不同读者。
- **错误最后**:错误是结局,放在 step 内容末尾比夹在输入中间更合理。

## 代价

- **事件顺序 ≠ transcript 顺序**:排查时要记住"事件是展示,transcript 是报文";
  两者对 `FUNCTION_CALL_OUTPUT` 的位置不同。
- **文档要写两遍顺序**:设计文档、wire 契约各说各的;容易看混。
- **测试不能只断言事件顺序来推断请求**:wire 测试仍要单独看 `toWireMessages` / `toWireItem`。

## 复查条件

1. **事件顺序与 transcript 顺序造成实际 bug**:优先在投影层明确区分 `eventOrder` 与 `wireOrder`,
   不要让事件顺序去驱动请求。
2. **需要"事件即请求"的严格对应**:那就必须让 `FUNCTION_CALL_OUTPUT` 排在新 prompt 前,
   并接受阅读顺序变差;这属于对 wire 契约的重新取舍。
3. **错误需要紧跟触发它的输出**:可以把 `STEP_ERROR` 放到 `FUNCTION_CALL` 之后、
   但仍在本 step 最后;不要放回输入组。
