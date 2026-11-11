# 决策:sink 写入失败重试 3 次,耗尽后才判 archive 失败

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

单次 `sink.append(batch)` 失败就判死,会把临时错误当成永久错误:

- 文件短暂被占用 / 设备忙 / 网络盘抖动;
- 一次 `writeAll` 的瞬时失败会让整个 archive `CLOSED`,后续所有事件都写不进去。

但无限重试也不行:磁盘满 / 权限错这类错误重试多少次都没用,只会拖住单 worker。

## 处理

- 只重试 `sink.append(batch)`,不重试整个 worker 循环;
- 策略:
  ```ts
  Schedule.recurs(SINK_RETRY_TIMES) // 首次之外再 3 次
    .pipe(Schedule.addDelay(() => Effect.succeed(SINK_RETRY_DELAY)));
  ```
  `SINK_RETRY_TIMES = 3`,`SINK_RETRY_DELAY = "10 millis"`;
- 重试仍失败 → 进入原来的失败流程:`failure` / `FAILED` / 所有 waiter 失败;
- 重试期间 worker 仍在处理这一批,后续 entry 自然排队等待。

## 为什么

- **临时错误值得再试**:本地文件系统偶发 `EBUSY` / 短暂权限抖动,重试几次通常能过。
- **有界**:3 次 + 10ms,最坏多等 30ms,不会无限拖住队列。
- **只重试批次写入**:状态更新、Deferred 完成这些不会失败,重试范围最小。
- **失败语义不变**:重试耗尽后仍然走同一套 `FAILED` 流程,调用方不需要区分“第几次失败”。

## 代价

- **可能重复写**:文件 `writeAll` 失败时可能已写入部分字节,重试会再写一遍;
  极端情况下 JSONL 出现半行 / 重复行。
- **单 worker 被拖慢**:重试期间后续条目都在等;频繁失败会放大延迟。
- **固定间隔不是最优**:没有指数退避 / 抖动;当前单用户本地场景够用。
- **重试对永久错误无意义**:磁盘满 / 权限错仍会重试 3 次才报错,多等 30ms。

## 复查条件

1. **重复行 / 半行成为实际问题**:让 sink 支持幂等(如写临时文件再 rename),
   或失败后 truncate 回已知偏移;不要简单去掉重试。
2. **重试延迟影响吞吐**:改成指数退避 + 抖动,或让重试策略可配置。
3. **需要区分可重试 / 不可重试错误**:给 `ArchiveError` 加 `retryable`,只重试可重试的。
4. **需要“写失败就立刻停”**:把 `SINK_RETRY_TIMES` 设为 0;但这是策略选择,不是默认。
