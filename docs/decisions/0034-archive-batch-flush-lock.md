# 决策:archive 批量写 + append 返回等待点,flush 用状态锁

> 部分被 [`0040`](0040-pending-count.md) 取代（append 不再返回 Deferred）·
> 已接受 · 2026-10-24 · 细化 [`0031`](0031-async-archive.md) / [`0033`](0033-no-seq.md)
> (异步、无 seq 不变)· 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)
> · 复查条件 3(批量太大)由 [`0061`](0061-worker-take-between.md) 落实(单批上限 `SINK_BATCH_MAX`)。

## 矛盾

旧实现里:

- 队列消息是 `ENTRY | FLUSH` 两种,worker 要分支处理;
- `append` 不返回任何东西,调用方想确认“这条写完了”只能 `flush` 整个队列;
- `flush` 往队列里塞一条 `FLUSH` 消息,和 entry 混在一起;
- `ArchiveSink` 还有自己的 `flush`(fsync),和 `Archive.flush` 同名,语义容易混。

## 处理

- **队列只放 `ArchiveEntry`**,不再有 `ArchiveMessage` 联合;
- **`Archive.append(entries)` 批量入队**,返回 `Deferred<void, ArchiveError>`:
  - 调用方可以不等（fire-and-forget）；
  - 需要确认某批写完时，await 这个 Deferred 即可；
- **`ArchiveSink.append(entries)` 批量写**，移除 `sink.flush`：
  - 单 worker，同一时间只有一个 `sink.append` 在调用；
  - 不再要求 fsync，`flush` 只保证写进 sink；
- **`Archive.flush` 用状态锁**：
  - 状态 `OPEN → FLUSHING`，此后的 `append` 直接失败；
  - 等 `written >= flushTarget`（flush 开始时的 `enqueued`），再回到 `OPEN`；
  - 若 flush 开始时队列已空，立即完成并解锁；
  - 并发 flush 共享同一个等待点。
- 内部用 `enqueued` / `written` 计数 + waiter 列表：
  - 每个 append 记下 `target = enqueued + batch.length`；
  - worker 每写完一批，完成所有 `target <= written` 的等待点。

## 为什么

- **一个队列只放一种东西**:worker 不再需要区分 entry / flush；flush 是状态操作，不是消息。
- **等待点跟着 append 走**:调用方可以按需等待某一批，而不是只能等整个队列。
- **批量写**:worker 用 `takeAll` 拿到一批，`sink.append(batch)` 一次写多行，减少调用次数。
- **flush 锁语义明确**:锁住期间 append 直接失败，不需要在队列里插屏障；排空后自动解锁。
- **sink 不需要 flush**:单 writer、批量写，`Archive.flush` 已经能等到这批写完；fsync 是另一个承诺，先不混进来。

## 代价

- **append 多一个返回值**:不关心的人要 `Effect.ignore` 或直接忽略 Deferred。
- **flush 期间拒绝写入**:调用方需要处理 `ArchiveError`，不能继续 append。
- **没有 fsync**:`flush` 完成只代表写进 sink / 页缓存，`kill -9` 仍可能丢。
- **状态机更复杂**:`OPEN / FLUSHING / CLOSED` + `enqueued/written/waiters`，比一条 `FLUSH` 消息难读。
- **批量大小不受控**:`takeAll` 可能一次拿到很多 entry，sink 写入时间变长；flush 会等这一批写完。

## 复查条件

1. **需要“flush 即落盘”**:在 `ArchiveSink` 加 `sync`，`flush` 完成前调用；不要复用 `sink.flush` 这个名字。
2. **flush 期间希望 append 排队而不是失败**:改成 `FLUSHING` 时挂起 append，flush 后继续；这会改变“锁住即失败”的语义。
3. **批量太大导致延迟 / 内存**:给 `takeAll` 加 `takeN` 上限，或分批写。
4. **需要多 writer**:加文件锁，并把 enqueued/written 的协调移到单写者；当前实现只适合单进程。
