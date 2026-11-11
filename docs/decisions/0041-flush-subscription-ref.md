# 决策:flush 用 SubscriptionRef 监听 pending

> [`0042`](0042-failure-state.md) 把 `failure` 从 `Deferred` 换成 `SubscriptionRef` ·
> 已接受 · 2026-10-24 · 细化 [`0040`](0040-pending-count.md)（append 只入队不变）·
> 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0040 里 `flush` 是：

```ts
gate → PubSub.subscribe(bus) → Ref.get(pending) → 非零就等 DRAINED
```

必须“先订阅、再检查”，否则可能错过 `DRAINED`。而且 `DRAINED` 只是一个
“归零”事件，没有进度；`pending` 和 `bus` 是两份状态，要手动保持一致。

## 处理

- `pending` 从 `Ref<number>` 换成 `SubscriptionRef<number>`；
- worker 每写完一批：`SubscriptionRef.updateAndGet(pending, n => n - batch.length)`；
- `flush`：

```ts
const drain = gate.withPermits(1)(
  SubscriptionRef.changes(pending).pipe(
    Stream.takeUntil((count) => count <= 0),
    Stream.runDrain,
  ),
);
yield * Effect.raceFirst(Deferred.await(failure), drain);
```

- 删掉 `bus: PubSub<void>` 和 `DRAINED`；
- 失败状态 `failure` 不变：worker 失败先置失败状态，再把 `pending` 置 0。

## 为什么

- **订阅时序不再是问题**:`SubscriptionRef.changes` 对新订阅者先发当前值；
  当前 `pending` 已经是 0 就直接结束，不需要“先订阅再检查”。
- **状态和事件合一**:`pending` 的每次变化就是通知，不再维护第二份 `DRAINED` 状态。
- **以后可复用**:`appendAndWait` 也可以用 `changes` 等到某个计数，不需要另建 bus。

## 代价

- `SubscriptionRef` 内部是 `PubSub.unbounded({ replay: 1 })`，慢订阅者会积压
  后续所有值；`flush` 是短订阅，影响小。
- `SubscriptionRef` 每次 `set` 都发布，即使值没变；当前更新只在批次结束 / 失败时发生，
  频率低。
- `flush` 从“等一个 void 事件”变成“跑一个短 Stream”，多一层 Stream 开销。
- 失败时先 fail 信号、再 `set(pending, 0)` 的顺序不能反，否则 drain 可能抢先成功。

## 复查条件

1. **慢订阅者积压**：给 `changes` 加 `Stream.conflate` / `Stream.changes`，
   只保留最新状态。
2. **flush 开销明显**：改回一个专门的 `Deferred` 或 `PubSub<number>` 进度事件。
3. **需要等某个 append 批次**：用同一个 `SubscriptionRef` 的计数做 target，
   不要恢复 per-entry Deferred。
4. **failure 与 pending 归零的顺序出现竞态**：把失败和归零合并到同一个状态机，
   而不是两个独立信号。
