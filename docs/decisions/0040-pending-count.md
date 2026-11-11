# 决策:append 只入队,flush 等 pending 归零

> [`0041`](0041-flush-subscription-ref.md) 把 `pending` 从 `Ref` 换成 `SubscriptionRef`；
> [`0042`](0042-failure-state.md) 把 `failure` 从 `Deferred` 换成 `SubscriptionRef` ·
> 已接受 · 2026-10-24 · 取代 [`0034`](0034-archive-batch-flush-lock.md) /
> [`0036`](0036-one-waiter-per-entry.md) 的 per-entry Deferred 部分,
> 保留 [`0039`](0039-failure-as-signal.md) 的失败信号 · 落点
> `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

`append` 返回 `ReadonlyArray<Deferred<void, ArchiveError>>`,一条 entry 一个等待点:

- 客户端从不 await 它,`Agent.publish` 直接 `Effect.ignore`;
- 只有测试用它确认某条写完;
- 为了发这些 Deferred,worker 要维护 `waiters`、按 id 对齐、在失败时逐个 fail;
- append 还要处理“登记 waiter 后失败 / 中断”的清理。

功能上没人用,复杂度却一直在。

## 处理

```ts
interface ArchiveShape {
  append(entries): Effect.Effect<void, ArchiveError>; // 成功 = 已入队
  flush: Effect.Effect<void, ArchiveError>; // 成功 = 已接受的全部写完
}
```

- `append` 不再返回 Deferred;入队成功即返回;
- 内部用 `pending: Ref<number>` 计“已接受但还没写完”的条数:
  - `append`:入队前 `pending += n`;
  - worker:写完一批 `pending -= batch.length`;
  - `pending === 0` → 发 `DRAINED`;
- `flush` 拿 gate → 订阅 `DRAINED` → `pending` 非零就等;
- 测试:以前 `await Deferred`,现在 `append; flush`;
- 失败信号不变:worker 失败先 fail `failure`,再把 `pending` 归零。

## 为什么

- **append 的职责收窄**:只负责“按顺序放进队列”,不承担“每条写完的通知”。
- **调用方语义更清楚**:
  - 要 fire-and-forget → `append` 本身已经是;
  - 要确认写入 → `flush`;
  - 不需要区分“哪一条写完”。
- **实现少一半状态**:没有 `waiters`、没有 id 对齐、没有 per-entry Deferred 清理。
- **顺序仍由单队列 + 单 writer 保证**,append 仍同步入队,`Agent.publish` 不用改。

## 代价

- **失去单条完成通知**:只能等 `flush`（全部已接受 entry）。
- **append 成功 ≠ 落盘**:调用方如果把“append 成功”当成“已持久化”会误判;
  文档和类型注释必须写清楚。
- **测试表达变化**:断言“某条写完”要改成“append + flush”,粒度变粗。
- **失败归属变粗**:sink 失败仍是整批失败,per-entry 归因能力消失。
- **append 仍需回滚计数**:race 失败 / 中断时,`onExit` 要把还没入队的 `pending` 减回去。

## 复查条件

1. **需要等单条 entry**:新增 `appendAndWait(entries)`（内部一个批次 Deferred）,
   不要恢复 per-entry 数组。
2. **需要部分写入的精确进度**:给 worker / sink 加批次回执,`flush` 之外再暴露进度。
3. **append 成功被误当成落盘**:把返回类型改成 `Effect<"accepted", ArchiveError>` 或
   在命名上区分 `enqueue` / `append`。
4. **flush 粒度不够**:增加 `flushThrough(entryId)` 或公开 `pending` 快照。
