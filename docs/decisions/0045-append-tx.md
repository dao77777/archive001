# 决策:append 用 Effect.tx 原子入队 + 增加 pending

> 已接受 · 2026-10-24 · 「append 同事务加 `pending`」已被 [`0048`](0048-in-flight-batch.md) 取代
> (事务本身保留,只少了计数)· 细化 [`0040`](0040-pending-count.md) /
> [`0044`](0044-flush-internal.md) · 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

append 要同时做两件事:

1. 把 entries 放进队列;
2. 增加 `pending`。

之前用普通 `Queue` + `Ref`/`SubscriptionRef`，于是 append 里要手写:

- `registered` / `committed` 两个标志；
- `onExit` 回滚 `pending`；
- 入队失败 / 中断的清理分支。

本质是在用补偿模拟原子操作。

## 处理

- 队列换成 `TxQueue`;
- `pending` 换成 `TxSubscriptionRef<number>`;
- append：

```ts
const attempt = Effect.gen(function* () {
  const remaining = yield* TxQueue.offerAll(queue, entries);
  if (remaining.length > 0) {
    return yield* Effect.fail(new ArchiveError({ message: "archive 队列已关闭" }));
  }
  yield* TxSubscriptionRef.update(pending, (count) => count + entries.length);
}).pipe(Effect.tx, gate.withPermitsIfAvailable(1));
```

- 入队和 `pending += n` 在同一个事务里；
- 失败 / 中断 / 冲突 → 整体回滚，不需要 `registered` / `committed` / `rollback`；
- worker 用 `TxQueue.takeAll`，写完后 `TxSubscriptionRef.update(pending, -n)`；
- `flush` 用 `TxSubscriptionRef.changesStream(pending)` 等归零。

## 为什么

- **真正的原子**:队列和计数一起提交，不存在“加了 pending 但没入队”或反过来。
- **代码更短**:删除标志位、`onExit` 回滚、部分入队处理。
- **冲突自动重试**:append 和 worker 同时改 `pending` 时，事务自己解决。
- **`TxQueue` 关闭 / 容量语义自带**:不用手写 `remaining` 回滚。

## 代价

- **事务开销**:每次 append 走一次 `Effect.tx`；worker 每次 `takeAll` 也走事务。
- **API 更小众**:`TxQueue` / `TxSubscriptionRef` 比 `Queue` / `SubscriptionRef` 难读。
- **仍有一把 gate**:事务不负责拒绝关闭期间的 append，gate 还在。
- **失败状态仍是非事务的**:`failure` 用普通 `SubscriptionRef`，不在 append 事务里。
- **tx 可能重试**:高并发下 append body 可能重跑；body 里只有 Tx 操作，安全。

## 复查条件

1. **事务开销明显**:换回普通队列 + 单 writer 的显式顺序协议，但不要恢复手写 rollback 标志。
2. **需要跨进程队列**:`TxQueue` 只在本进程内存里，持久队列另做。
3. **需要 append 与外部状态原子提交**:把外部状态也换成 `Tx*`，一起放进 `Effect.tx`。
4. **worker 的 take 成为瓶颈**:考虑批量提交 / 预取，而不是去掉事务。
