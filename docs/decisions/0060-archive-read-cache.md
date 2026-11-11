# 决策:archive 的读侧加条目缓存(`readAll` 只读一次文件)

> 已接受 · 2026-10-24 · **"缓存 = 已落盘"已被 [`0070`](0070-archive-cache-before-queue.md) 取代**
> (缓存前移到写队列之前,语义变成"已接收")· 在 [`0058`](0058-archive-projection.md) 的读侧之上加缓存层 ·
> 落点 `packages/agent/src/archive/archive.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧)

## 矛盾

0058 让 `readAll` 直接等于 `sink.read`:

```ts
const readAll = sink.read; // 每次都读整个文件 + 逐行 parse
const restore = readAll.pipe(Effect.map(project));
```

于是:

| 问题                 | 说明                                                              |
| -------------------- | ----------------------------------------------------------------- |
| 每次读都是全文件     | JSONL 越写越长,`restore` 的成本是 O(整份日志)                     |
| 轮询 / 重复读不划算  | UI 想看"现在到哪了"就得每次从头 parse;`restore` 再折一遍也是 O(n) |
| 写的时候数据就在手上 | worker 已经把每一批写进文件了,读侧却还要把它从磁盘再读回来        |
| 外部环境读一次就够   | 恢复是"读一次、然后跟着新事件走",不是"每问一次都重读"             |

## 处理

在 `archive.ts` 里给读侧加一份**条目缓存**,并把 sink 的读 / 写都包一层:

```ts
const cache = yield * Ref.make<Option.Option<ReadonlyArray<ArchiveEntry>>>(Option.none()); // None = 未加载
const io = yield * Semaphore.make(1); // "加载缓存" 与 "写文件 + 补缓存" 互斥

const cachedSink: ArchiveSinkShape = {
  write: (batch) =>
    io.withPermits(1)(
      Effect.gen(function* () {
        yield* sink.write(batch).pipe(Effect.retry(SINK_RETRY_SCHEDULE)); // 写成功
        const cached = yield* Ref.get(cache);
        if (Option.isSome(cached)) yield* Ref.set(cache, Option.some([...cached.value, ...batch]));
      }),
    ),
  read: io.withPermits(1)(
    Effect.gen(function* () {
      const cached = yield* Ref.get(cache);
      if (Option.isSome(cached)) return cached.value;
      const entries = yield* sink.read;
      yield* Ref.set(cache, Option.some(entries));
      return entries;
    }),
  ),
};
```

- worker 与关闭收尾都改写 `cachedSink.write`(原来各自 `sink.write(...).pipe(retry)`);
- `append` **不进锁**:它只入队、不碰文件,不能让每个事件都排在文件 IO 后面;
- 缓存未加载时写入不补缓存(第一次 `cachedSink.read` 会从 sink 读到那一批,不会重复);
- 对外的 `readAll` / `restore` 不变:前者就是 `cachedSink.read`,后者是它 + `project`。

## 为什么

- **一次文件读换 N 次内存读**:恢复 + 轮询都变成"读数组",与日志长度脱钩;
- **写路径本来就是权威**:写完的那一批数据已经在手里,顺手接到缓存比让读侧再 parse 一遍便宜;
- **名字把两件事都说了**:`cachedSink` —— 它是 sink(缓存写、缓存读),不是别的东西;
  `write` / `read` 按 sink 的形状对称命名,一个对象同时表达"缓存"与"sink";
- **互斥范围最小**:只有"真写文件"和"真读文件"互斥,`append` / `project` / `events` 都不受影响;
  不互斥的话必然出现漏条目(写完但加载没看见)或重复(加载看见 + 缓存又加);
- **重试语义没变**:`cachedSink.write` 把重试包在里面,缓存只在成功后更新,不会缓存到没落盘的东西。

## 代价

- **整份日志驻留内存**:长会话 / 大工具输出会让进程常驻内存与日志等大,而且没有淘汰;
- **只跟自己的写入同步**:两个实例开在同一个文件上,A 的追加不会出现在 B 的缓存里
  (B 要么新建实例,要么 `readAll` 之后才准);不提供失效 / 重载接口;
- **仍是"已落盘"语义**:写完到缓存之间隔着一次真实写入,读到的永远不包含在飞的批 ——
  "读刚 append 的东西"依旧不保证(要等 worker 写完);
- **一把锁串行化文件 IO**:`restore` 撞上一次正在重试的写入时会等;重试窗口越长,读越慢;
- **缓存不区分"读侧用不用"**:只要写过就留着,哪怕没人调用 `readAll`;
- **坏行截断被固化**:首次加载时按 sink 的截断规则缓存下来,之后的读不会"再试一次尾部"。

## 复查条件

1. **内存随日志线性增长成为问题**:改成增量 / 分段缓存(只留最近 N 条 + `entries(fromLine)`),
   或者缓存"已解析的 offset"而不是内容;`readAll` 语义随之改成"读到哪算哪"并写清楚。
2. **多实例共用同一文件**:加文件级失效(按 mtime / size 判断重读)或跨进程锁;
   不要假设缓存是对的。
3. **读要看到在飞的批**(比如崩溃前最后一次 append 也要能恢复):得让 `append` 参与某种
   可见性协议(缓存里存"已接收"而不是"已落盘",并标注 durable 与否);这是语义变更,单独立决策。
4. **重试窗口拖慢读**:把重试移出锁外(写成功后再拿锁补缓存),但要重新论证不会漏 / 重。
