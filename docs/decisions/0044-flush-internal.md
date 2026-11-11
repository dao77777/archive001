# 决策:flush 不对外暴露,只作为 layer 关闭 finalizer

> 已接受 · 2026-10-24 · 细化 [`0043`](0043-flush-on-close.md)（关闭时 flush 不变）·
> 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

`flush` 是 archive 的写入屏障,但生产代码里**没有任何调用方**:

- CLI / REPL / web 都只在 layer 关闭时释放 archive;
- 关闭已经由 [`0043`](0043-flush-on-close.md) 的 finalizer 自动 flush;
- 只有测试在直接调用 `archive.flush`。

公开一个没人用的方法,会让 `ArchiveShape` 多一条需要维护的契约。

## 处理

- `ArchiveShape` 只保留 `append`;
- `flush` 留在 `ArchiveLive` 内部,供 finalizer 调用;
- 测试不再直接 `archive.flush`,改成:
  - append 后让 layer scope 关闭;
  - 需要观察“关闭是否等待写入”时,显式 `Scope.close` + 阻塞 sink。
- 删除依赖公开 flush 的测试:
  - flush 期间 append 失败;
  - flush 等所有 entry;
  - sink 失败时 flush / 后续 append 都失败。

## 为什么

- **最小公开 API**:外部只需要 `append`;
- **关闭路径统一**:写入完成由 layer 生命周期负责,不靠调用方记得 flush;
- **实现不变**:`flush` 的 gate / pending / 失败监听逻辑都保留,只是不导出。

## 代价

- **失去显式写入屏障**:调用方无法在“不关闭 archive”的情况下等落盘;
- **测试覆盖变弱**:flush 期间的 append 拒绝、flush 失败语义不再直接测试;
- **finalizer 错误被忽略**:关闭时 flush 失败不会暴露给调用方;
- **未来 `appendAndWait` 可能要重新暴露**:需要时再加一个更窄的公开方法,而不是直接放回 `flush`。

## 复查条件

1. **客户端需要主动 flush**:例如“关闭前先落盘,再继续运行”,重新暴露 `flush`。
2. **需要 `appendAndWait`**:基于内部 `pending` 计数加一个批次屏障,不要恢复 per-entry Deferred。
3. **测试需要覆盖 flush 语义**:引入 test-only 的内部 entry,而不是污染 `ArchiveShape`。
4. **finalizer 失败需要诊断**:把 `Effect.ignore` 换成记录/上报,或暴露关闭结果。
