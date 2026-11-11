# 决策:失败作为信号,append / flush 用 race 监听

> 已被 [`0042`](0042-failure-state.md) 取代（`Deferred` → `SubscriptionRef` 状态）·
> 后续 [`0040`](0040-pending-count.md) 移除了 per-entry Deferred ·
> 部分被 [`0047`](0047-append-enqueue-only.md) 取代（append 不再监听失败）·
> 已接受 · 2026-10-24 · 细化 [`0037`](0037-gate-pubsub-flush.md)
> (gate + PubSub 不变)· 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

之前 `append` / `flush` 手动检查 `failure: Ref<Option<ArchiveError>>`:

- append 在登记 waiter 前后各查一次;
- flush 在订阅前后各查一次;
- 每次检查都要覆盖“检查之后、下一步之前”的竞态窗口,越加越多。

这是**轮询式**的错误检测:操作自己不断问“失败了吗”,而不是“失败时通知我”。

## 处理

- `failure` 改成 **`Deferred<never, ArchiveError>`**:
  - worker 失败时 `Deferred.fail(failure, error)`;
  - 一旦失败,所有 `await` 它的操作立即拿到错误。
- `append`:
  ```ts
  Effect.raceFirst(Deferred.await(failure), attempt);
  ```
  - 失败优先;若 append 正在登记 / 入队,原过程被中断;
  - 已经登记的 waiter 通过 `Effect.onExit` 清理并失败。
- `flush`:
  ```ts
  Effect.raceFirst(Deferred.await(failure), drain);
  ```
  - 失败优先;drain 已经在订阅 / 等 DRAINED 时被中断;
  - `Effect.scoped` 关闭订阅。
- worker 失败顺序:
  1. 先 fail `failure` 信号;
  2. 再清空 waiters、失败所有 per-entry Deferred。
- `flush` 的 PubSub 只保留 `DRAINED`;失败不再走 `FAILED` 事件。

## 为什么

- **语义正确**:失败是“事件”,不是“需要反复检查的状态”。
- **没有检查窗口**:race 覆盖操作的全过程,不需要在 start / middle / end 各查一次。
- **错误优先**:把 `Deferred.await(failure)` 放在 `raceFirst` 前面,已失败时不会被“操作刚好能立即完成”抢先。
- **少一个事件类型**:失败用 Deferred,PubSub 只负责排空。

## 代价

- **append 需要清理逻辑**:race 可能在登记 waiter 之后中断 append,必须 `onExit` 移除/失败这些 waiter。
- **race 的开销**:每次 append / flush 都多一个等待者;本地单用户可忽略。
- **失败信号是一次性的**:archive 失败后不能复用,只能重建实例。
- **失败优先可能导致“本可成功”的 append 被拒**:如果 worker 在 append 即将完成时失败,append 返回错误;但 archive 本来也已经不可用了。

## 复查条件

1. **append 清理逻辑出现遗漏**:把“登记 waiter + 入队 + 返回”封装成 `acquireRelease` 式的助手,
   不要在每个分支手写 remove/fail。
2. **race 开销明显**:对 append 改成 `Deferred.isDone` 快速路径 + race;但不要退回多次手动检查。
3. **需要失败后继续写**:当前失败是一次性的;要做可恢复 archive,得重建 sink / 队列 / 状态。
4. **需要区分 admission 拒绝与 worker 失败**:两边的 `ArchiveError.message` 已经不同,必要时加 `kind`。
