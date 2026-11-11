# 决策:一条 entry 一个 waiter,不做批次级等待

> 已被 [`0040`](0040-pending-count.md) 取代（移除 per-entry Deferred）·
> 已接受 · 2026-10-24 · 原取代 [`0035`](0035-waiters-by-entry-id.md) 的批次 waiter ·
> 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0035 的 waiter 是“一个 append 批次一个”:

```ts
interface Waiter {
  ids: ReadonlySet<string>;
  remaining: number;
  done: Deferred;
}
```

- 批次是调用方的概念，archive 内部真正关心的是**每一条 entry**；
- 一个 waiter 里塞一个 Set / 计数，worker 要遍历 ids、扣 remaining；
- `append` 返回一个 Deferred 却对应多条 entry，语义不精确：到底代表哪条写完？
- 如果一批里某条特别慢，整个 Deferred 都要等。

## 处理

- **一条 entry 一个 waiter**:

  ```ts
  interface Waiter {
    id: string;
    done: Deferred<void, ArchiveError>;
  }
  ```

- `append(entries)` 为每条 entry 建 waiter，返回 `ReadonlyArray<Deferred>`：
  - 调用方可以只等其中一条；
  - 也可以整批 `Effect.forEach(..., Deferred.await)`。
- worker 写完一批，用 batch 的 entry id 直接完成对应 waiter，然后移除；
- `flush` 仍然等 `waiters.length === 0`；
- 不再需要 `ids: Set` / `remaining`。

## 为什么

- **粒度对齐**:等待点就是 entry 本身，不是调用方碰巧怎么分批。
- **语义准确**:`append([a,b])` 返回 `[doneA, doneB]`，谁写完谁完成。
- **worker 更简单**:`batchIds.has(waiter.id)` 一条判断，不需要扣计数。
- **flush 不变**:waiters 空了就代表所有已接受 entry 都写完。

## 代价

- **append 返回值变成数组**:不关心的人要忽略数组；关心的人要按 index 对应 entry。
- **每条 entry 一个 Deferred**:比按批返回多几个对象；本地单用户可接受。
- **id 重复会多完成**:同一 id 的两条 entry 共享判断；当前事件 id 唯一，先按这个假设。
- **waiters 数量 = 未写 entry 数**:量大时数组遍历变多，需要时再建 id → waiter 索引。

## 复查条件

1. **append 返回数组太啰嗦**:可以再包一个 `appendOne` 便利函数；不要让 archive 退回批次语义。
2. **entry id 不再唯一**:waiter 需要换成 `(id, occurrence)` 或直接持有 entry 引用。
3. **waiters 数量很大**:用 `Map<string, Deferred>` 建索引；`flush` 仍看 map 是否为空。
4. **需要“整批一起完成”的调用方**:在调用方组合 `Effect.all`，不要在 archive 内部造批次 waiter。
