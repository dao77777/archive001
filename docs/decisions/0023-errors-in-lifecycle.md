# 决策:三级错误并入生命周期,统一 `{ id, parentId, message }`

> 已接受 · 2026-10-24 · 细化 [`0022`](0022-error-levels.md)
> (错误分级不变)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0022 把错误分成 step / turn / engine 三级,但 `turn.error` 还留在内容组,而且格式不一样:

```ts
step.error   { id, parentId: stepId,   message }
engine.error { id, parentId: engineId, message }
turn.error   { id, parentId: turnId,   promptIds, message }   // 多一个 promptIds
```

- `turn.error` 不在生命周期组,读事件时要记得它是特例;
- `promptIds` 是"哪些用户输入"的内容,塞进错误事件里让格式不统一;
- 客户端认领 turn.error 依赖 promptIds,而不是统一的 `parentId`。

## 处理

- 三级错误都放进**生命周期组**,和 start/end 并列:

  ```ts
  engine.start / engine.error / engine.end;
  turn.start / turn.error / turn.end;
  step.start / step.error / step.end;
  ```

- 格式统一:

  ```ts
  {
    (id, parentId, message);
  }
  ```

- `turn.error` **去掉 `promptIds`**;`parentId` 就是 turn id。
- 客户端认领改为:
  - `inbox.take.messageIds` 含自己的 prompt 时,确定它属于当前 turn,或标记"下一轮开始";
  - `turn.start` 时把 pending prompt 绑定到 `turn.id`;
  - `turn.error.parentId === turnId` 时记为失败;
  - `step.error` 通过 `stepId → turnId` 映射判断;
  - `engine.error` 直接失败。
- `turn.start/end` 仍然不带 promptIds;prompt 的归属只出现在 step 的 `prompt` 内容事件里。

## 为什么

- **错误是生命周期的一部分**:start → (error) → end,放在同一组读起来最自然。
- **格式统一**:三级错误都是 `{ id, parentId, message }`,消费方不用为 turn 写特例。
- **错误不携带内容引用**:`promptIds` 属于"这一步吃了什么",在 step 的 `prompt` 里;
  错误只需要说明"哪个容器失败了、为什么"。
- **认领仍可靠**:`inbox.take` + `turn.start` 已经把 prompt 和 turn 对齐,不需要错误事件重复。

## 代价

- **客户端认领逻辑变复杂**:要跟踪 `inbox.take` / `turn.start` / `pendingPrompt`,
  不能只看 `turn.error.promptIds`。
- **错误事件不再自解释"哪些 prompt"**:要查 turn 的 `prompt` 内容事件;
  没进 step 就失败的 turn 没有 prompt 事件,只能靠 turn id 与 inbox.take 对齐。
- **同一个 turn 的多个 prompt 共享错误**:错误只挂在 turn 上,不区分是哪条 prompt 引起的
  (实际上 turn 级错误本来就是整轮失败)。
- **step / turn / engine 错误格式统一后,层级只能看 parentId**:排查时要知道 parent 是谁。

## 复查条件

1. **客户端认领错误频繁出错**:抽一个纯函数 `failureOf(events, promptId)`,
   把 inbox.take / turn.start / turn.error / step.error 的折叠收敛到一处。
2. **需要知道错误影响了哪些 prompt**:用 turn 的 `prompt` 内容事件 + inbox.take 推导;
   不要恢复 `turn.error.promptIds`。
3. **错误需要更多结构化字段**(code / retryable):继续用 `{ id, parentId, message, ... }`,
   保持三级一致;不要为某一级发明不同形状。
4. **turn 级错误太多**:检查是不是本该属于 step.error 或 engine.error;
   分级错了先修分级,不要改回内容组。
