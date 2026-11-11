# 决策:`end` 与 `error` 互斥,`end` 不带 reason,`error` 带 kind

> 已接受 · 2026-10-24 · 细化 [`0023`](0023-errors-in-lifecycle.md)
> (错误并入生命周期不变)· **已被 [`0025`](0025-error-as-content.md) 取代**
> (error 回到内容,end 与 error 不再互斥)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

之前生命周期结束时混用两种表达:

```ts
turn.end { reason: "answer" | "error" | "interrupted" }
turn.error { message }
```

- `turn.end` 带 `reason` 等于让"正常结束"的事件也声明错误;
- 错误同时有 `turn.error` 和 `turn.end(reason=error)`,同一件事两处表达;
- 错误没有分类,只能从 message 猜;
- 消费者要判断 `end.reason` 才知道这一轮成功没有。

## 处理

- **`end` 与 `error` 互斥**:
  - `start → end` = 正常结束;
  - `start → error` = 异常结束,不再发对应的 `end`。
- **`end` 不再带 `reason`**:
  - `engine.end { id }`
  - `turn.end { id, parentId }`
  - `step.end { id, parentId }`
- **`error` 带分类与详情**:

  ```ts
  step.error   { id, parentId: stepId,   kind, message }
  turn.error   { id, parentId: turnId,   kind, message }
  engine.error { id, parentId: engineId, kind, message }
  ```

  `kind: "llm" | "config" | "defect"`;`message` 是详情。

- 中断视为"正常停止":逐层 `end`,不产生 error。
- 客户端不再判断 `end.reason`:
  - 看到 `turn.end`(匹配自己的 turn)= 成功,用最后一步的 `text`;
  - 看到 `turn.error` / `step.error` / `engine.error` = 失败;
  - 看到 `engine.end` = 引擎停止但没给回答,按失败处理。

## 为什么

- **一个生命周期只有一个终止符**:要么 end,要么 error;不会同时出现。
- **end 不解释**:它只表示"正常走完了";原因属于 error。
- **error 可分类**:`kind` 让 UI / 重试策略 / 统计能区分模型失败、配置缺失、引擎缺陷。
- **客户端判断简单**:不需要解析 `reason`;有 error 就是失败,有 end 就是正常。

## 代价

- **中断与正常完成共用 `end`**:`end` 不再说明是"跑完了"还是"被用户停了";
  需要区分时只能看上下文(比如客户端自己发的取消)。
- **error 不带 promptIds**:认领仍要靠 `inbox.take` + `turn.start` / `step.parentId`。
- **缺陷时错误会重复出现在三层**:step.error + turn.error + engine.error 都带同一条 message;
  消费方要选一层展示。
- **`kind` 目前只有三种**:以后增加错误类别要同步更新类型和客户端展示。

## 复查条件

1. **需要区分"正常完成"与"用户中断"**:加一个 `engine.stop` 内容事件,或让中断走
   `engine.error { kind: "interrupted" }`;不要恢复 `end.reason`。
2. **错误分类不够**:扩展 `ErrorKind`(如 `tool` / `network` / `rate_limit`);
   保持三级 error 同构。
3. **客户端仍要判断 end.reason**:说明有地方把错误塞回了 end;改回 error 事件。
4. **缺陷时的三层重复太吵**:只让最内层发 error,外层用 `end`?这与"异常结束"矛盾;
   更好的做法是消费方按层级过滤,而不是改事件语义。
