# 决策:错误事件按层级分 `step.error` / `turn.error` / `engine.error`

> 已接受 · 2026-10-24 · 细化 [`0021`](0021-id-parent-id.md)
> (id / parentId 不变)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

之前所有错误都塞进 `turn.error`:

- 模型调用失败其实是 **step** 的问题;
- 没配置 / turn 级失败才是 turn 的问题;
- 引擎自身的缺陷(未捕获异常)没有对应事件,只能从 `engine.end` 猜。

这和"结构是容器、内容挂在容器上"的模型不一致:错误应该发生在哪一层,就挂在哪一层。

## 处理

三级错误事件,都是内容,`parentId` 指向所在层级:

```ts
step.error   { id, parentId: stepId,   message }   // 模型调用失败
turn.error   { id, parentId: turnId,   promptIds, message } // turn 级失败
engine.error { id, parentId: engineId, message }   // 引擎级异常(缺陷 / 未捕获)
```

- `llm.complete` 返回 `LlmError` → `step.error`,然后 `step.end`、`turn.end(reason=error)`;
- 没配置 settings / tools(还没进 step)→ `turn.error`,然后 `turn.end(error)`;
- 引擎 fiber 以缺陷 / 未捕获错误退出 → `onExit` 发 `engine.error`,然后 `engine.end(reason=error)`;
- 纯中断不算错误:只发 `engine.end(reason=interrupted)`。

客户端:

- `step.error`:用 `stepId → turnId` 映射判断是不是自己这一轮;
- `turn.error`:看 `promptIds` 是否含自己的 prompt;
- `engine.error`:直接记为失败,`engine.end` 收尾。

## 为什么

- **错误属于它发生的层级**:step 内失败不该伪装成整个 turn 的失败;
- **客户端能分级展示**:UI 可以在工具卡片上标红,也可以在整轮 / 整个引擎上提示;
- **engine.error 让缺陷可见**:以前引擎缺陷只有 `engine.end`,没有原因;
- **与 id/parentId 一致**:错误就是挂在容器上的内容事件。

## 代价

- **客户端要处理三种 error**:`step.error` 还要先判断是不是自己这一轮;
- **错误可能重复表达**:`step.error` + `turn.end(reason=error)` + `engine.error`(缺陷时)
  描述的是同一件事的不同层级,消费方要选一个展示;
- **`engine.error` 的消息来自 `Cause.pretty`**,可能很长、带栈;
- **中断与错误要区分**:纯中断不发 error,避免把用户取消当成故障。

## 复查条件

1. **客户端只关心"这一轮是否失败"**:在客户端共享层做 `failureOf(events, promptId)`,
   合并三级错误;不要删掉分级事件。
2. **`engine.error` 太长 / 太吵**:只保留首行或 message 字段,不要改成只发 `engine.end`。
3. **需要错误码 / 可重试标记**:给 error 内容事件加结构化字段(如 `retryable`),
   仍然挂 `parentId`,不要新造生命周期。
4. **step 内部有多类失败**(模型 / 工具 / 校验):工具错误目前是观测,不是 step.error;
   如果以后要区分,加 `tool.error` 内容事件,parent 是 tool.call / step。
