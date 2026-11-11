# 决策:worker 用 `forever(takeBetween >>= writeBatch)`,单批有上限

> 已接受 · 2026-10-24 · 落实 [`0034`](0034-archive-batch-flush-lock.md) 的复查条件 3 ·
> 落点 `packages/agent/src/archive/archive.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

worker 原来是手写的 `while (true)` + `takeAll`:

```ts
while (true) {
  const batch =
    yield *
    Effect.gen(function* () {
      const batch = yield* TxQueue.takeAll(queue); // 有多少拿多少
      yield* TxRef.set(writing, Option.some(batch)); // 取货即认领
      return batch;
    }).pipe(Effect.tx);
  yield * cachedSink.write(batch);
  yield * TxRef.set(writing, Option.none()).pipe(Effect.tx);
}
```

| 问题           | 说明                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| 批大小不受控   | `takeAll` 有多少拿多少:积压 10 万条时一次写 10 万条,单次写很久、内存尖峰 |
| 循环是手写的   | `while (true)` 混在 `Effect.gen` 里,读起来像同步代码,不好看出"永不结束"  |
| 三件事缠在一起 | 取货、认领、写、放下标记都在一个 gen 块里,想单独改哪一步都得动整块       |

## 处理

拆成两个可命名的步骤,用 `Effect.forever` 串起来:

```ts
/** 取一批(最多 SINK_BATCH_MAX)并标成"在飞":取货即认领,同一事务。 */
const takeBatch: Effect.Effect<ReadonlyArray<ArchiveEntry>> = Effect.gen(function* () {
  const batch = yield* TxQueue.takeBetween(queue, 1, SINK_BATCH_MAX); // 1024
  yield* TxRef.set(writing, Option.some(batch));
  return batch;
}).pipe(Effect.tx);

/** 写一批(事务外,走缓存),写完才放下"在飞"标记。 */
const writeBatch = (batch) =>
  Effect.gen(function* () {
    yield* cachedSink.write(batch);
    yield* TxRef.set(writing, Option.none()).pipe(Effect.tx);
  });

yield *
  Effect.forever(takeBatch.pipe(Effect.flatMap(writeBatch))).pipe(
    Effect.onInterrupt(() => drain.pipe(Effect.ignore)), // 关闸 + 补写:见 `drain`
    Effect.catch(/* 关闸 + 发 failure */),
    Effect.forkScoped({ startImmediately: true }),
  );
```

- `takeBetween(queue, 1, 1024)`:**至少 1 条才返回**(队列空时挂起,行为同 `takeAll`),
  最多 1024 条;积压时下一轮接着取,分成多批写;
- 上限进常量:`SINK_BATCH_MAX = 1024`(当时在 `archive/_constants.ts`,现在随 [`0073`](0073-archive-types-per-file.md)
  下放到 `archive.ts` 文件内);
- **"取货 + 标记在飞"仍在同一个事务里**(0048 的语义不变);
- 中断收尾、失败收尾都不动:它们读的仍是 `writing` 与队列。

## 为什么

- **单批有上限**:写一次的最坏耗时与内存尖峰有界;flush / 关闭也不会被一个巨大批次拖住;
- **形状说明意图**:`forever(take >>= write)` 一眼看出"取一批、写一批、永远循环",
  比 `while (true)` 更贴近实际语义(它永远不会正常返回);
- **两步可命名**:取货(带认领)与写(带放下标记)各是一件事,以后想给写加
  metrics / 限流、给取货换成别的策略,都只改一步。

## 代价

- **积压时多几次写**:10 万条会分成约 100 次写(而不是 1 次),系统调用与缓存拼接次数变多
  (缓存是"整份数组 copy-on-write",见 [`0060`](0060-archive-read-cache.md),次数多就更明显);
- **`takeBetween` 的边界语义要记住**:`min = 0` / `max = 0` / `min > max` 返回空数组,
  队列 close 时会"不足 min 也排出" —— 这里靠 `min = 1`、队列不 close 来避开;
- **写批次大小不再等于"当时积压量"**:排查"某次写了多少条"要看实现,不能从队列长度推;
- **中断窗口仍在**:`write → 放下标记` 之间被中断,收尾会再写一遍这一批(极端情况下 JSONL 多一行);
  保持可中断是为了"sink 卡住时关闭仍能开始收尾",两害相权;
- **`uninterruptible` 不是解法**:试过把"写 + 放下标记"包成不可中断,直接让"关闭时 gate 住写"的
  测试死等 —— 收尾依赖这次中断。

## 复查条件

1. **积压时写太碎 / 缓存拼接成瓶颈**(见 0060 的复查 1):把 `SINK_BATCH_MAX` 调大,或改成
   "积压越多批越大"(比如 `max(min(1024, backlog), 1)`);别退回 `takeAll`。
2. **重复写成为真实问题**(JSONL 出现重复行):把"写 + 放下标记"做成可中断的原子步骤
   (比如先在 sink 里写一个 commit 标记,或让 sink 支持幂等键),那时再讨论
   —— 单靠 `uninterruptible` 会和关闭语义打架。
3. **需要写入限流 / 观测**:在 `writeBatch` 外面包 metrics 或信号量,别塞回 `takeBatch`。
4. **队列 close 的路径出现**(`TxQueue.end` 之类):重新确认 `takeBetween` 在 close 时的
   "不足 min 也排出"与 `Effect.forever` 的配合,避免空批次反复循环。
