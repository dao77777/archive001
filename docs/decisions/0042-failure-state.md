# 决策:worker 失败用 SubscriptionRef 状态,不用 Deferred

> 部分被 [`0047`](0047-append-enqueue-only.md) 取代（append 不再监听失败）·
> 已接受 · 2026-10-24 · 取代 [`0039`](0039-failure-as-signal.md) 的
> `Deferred` 机制 · 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0039 用 `Deferred<never, ArchiveError>` 表示 worker 失败:

```ts
const failure = yield * Deferred.make<never, ArchiveError>();
// worker 失败
yield * Deferred.fail(failure, error);
// append / flush
Effect.raceFirst(Deferred.await(failure), operation);
```

问题是语义不对:

- `Deferred` 表达的是“等一个一次性事件”,不是“读取一个状态”;
- 失败之后才开始的 `append` / `flush` 需要先 await 一个已经完成的 Deferred;
- 每个操作都要重新 `Deferred.await`,而它不携带“已经失败”的当前值;
- 失败是终态,不是一次性信号;新观察者应该立刻看到它。

## 处理

- `failure` 改成:

```ts
SubscriptionRef<Option<ArchiveError>>;
```

- 初始 `None`;
- worker 失败:
  1. `SubscriptionRef.set(failure, Option.some(error))`;
  2. `pending` 归零。
- 统一的失败监听:

```ts
const watchFailure = SubscriptionRef.changes(failure).pipe(
  Stream.runForEach((state) => (Option.isSome(state) ? Effect.fail(state.value) : Effect.void)),
  Effect.andThen(Effect.never),
);
```

- `append` / `flush` 继续 `raceFirst(watchFailure, operation)`;
- `changes` 会先把当前值发给新订阅者:
  - 已失败 → 立即拿到 `Some` 并失败;
  - 未失败 → 等后续变成 `Some`。

## 为什么

- **状态语义正确**:失败是终态,不是一次性事件。
- **晚来的观察者也能看到**:失败之后新建的 `append` / `flush` 不需要特殊路径。
- **多观察者天然支持**:每个操作自己的订阅都会先收到当前状态。
- **和 `pending` 统一**:两者都是 `SubscriptionRef`,都是“当前状态 + 变化通知”。

## 代价

- 每次 `append` / `flush` 都创建一个短 Stream 订阅,比 `Deferred.await` 多一点开销。
- `Option` 包一层,`watchFailure` 需要 `andThen(Effect.never)` 把“Stream 结束”变成“永不成功”。
- 失败状态是单向的:一旦 `Some`,archive 实例不可恢复;要恢复只能重建。
- `SubscriptionRef` 内部是 unbounded PubSub,监听者多时会有订阅开销;当前操作都是短订阅。

## 复查条件

1. **订阅开销明显**:抽一个 `awaitSome(ref)` 帮助函数,或缓存一个共享的 `Deferred`。
2. **需要失败后恢复**:把 `failure` 改成可清空的状态,并明确重建队列 / sink 的流程。
3. **需要多个不同错误 / 错误历史**:改用 `PubSub<ArchiveError>({ replay: n })`,
   而不是单值状态。
4. **需要“等待失败”只发生一次**:那才是 `Deferred` 的适用场景;现在有多个观察者。
