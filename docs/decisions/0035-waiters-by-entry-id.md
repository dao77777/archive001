# 决策:Waiter 记录 entry id,按实际写入扣减

> 已接受 · 2026-10-24 · 细化 [`0034`](0034-archive-batch-flush-lock.md)
> (批量 append / flush 锁不变)· 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0034 用两个累计计数器表示进度:

```ts
enqueued; // 已接受总数
written; // 已写完总数
target = enqueued + batch.length; // 每个 append 的等待水位
```

但队列里已经有每条 entry 的 `id` 了,再用累计数字推“这批写完没有”是绕路:

- `enqueued` / `written` 是**全局数字**,和具体哪几条 entry 没关系;
- `target` 必须靠 `enqueued` 算,多一个内部状态;
- 一旦出现重复 id / 跳号,数字能对上但内容对不上;
- flush 还要额外维护 `flushTarget`。

## 处理

Waiter 直接记录这批 entry 的 id:

```ts
interface Waiter {
  ids: ReadonlySet<string>;
  remaining: number;
  done: Deferred<void, ArchiveError>;
}
```

- `append(entries)` 建 waiter：`ids = entries.map(e => e.id)`，`remaining = entries.length`；
- worker 写完一批，用 batch 的 id 去扣每个 waiter 的 `remaining`；
- 扣到 0 → `Deferred.succeed(done)`，从 `waiters` 移除；
- `flush` 不再需要 `flushTarget`：锁住后等 **waiters 清空** 即可；
- `enqueued` / `written` / `target` / `flushTarget` 全部删除。

## 为什么

- **按内容记账**:等待点关心的是“我这几条写没写”，不是“全局写到第几条”。
- **少两个计数器**:`enqueued` / `written` 只是为了算 target 而存在,现在不需要。
- **flush 更直接**:waiters 空了 = 所有已接受批次都写完了；不用比较数字。
- **batch 合并天然支持**:一次 sink 写 5 条,waiter 按 id 命中的条数扣减,不管批次边界。

## 代价

- **依赖 entry id 唯一**:同一 id 出现两次会被多扣；当前事件 id 全局唯一,先按这个假设。
- **每个 waiter 存一个 Set**:比一个数字占内存；batch 很大时更明显。
- **worker 要遍历 waiters × batch**:O(n×m)；单进程本地写入可接受。
- **flush 不能再“等一个目标数字”**:必须等所有 waiter 消失;逻辑更依赖 waiter 生命周期。

## 复查条件

1. **entry id 不再唯一 / 允许重复**:给 waiter 换成 `(id, occurrence)` 或直接携带 entry 引用。
2. **waiters 数量 / batch 很大导致 CPU**:给 waiters 建 id → waiter 索引,或改回水位数字。
3. **需要“写到第 N 条”这种游标**:那是另一种查询,不要把它塞进 waiter;用文件行号。
4. **flush 期间仍有 append 排队**:当前 append 直接失败;如果以后改成挂起,flush 需要重新定义“waiters 清空”的时点。
