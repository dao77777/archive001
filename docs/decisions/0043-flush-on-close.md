# 决策:Archive layer 关闭时自动 flush

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

`append` 只入队、不保证写入。调用方如果直接结束程序 / 关闭 layer / reset 会话，
队列里已接受的 entry 可能还没到 sink，进程退出后就丢了。

之前只能靠调用方记得在关闭前手动 `flush`，容易漏。

## 处理

`ArchiveLive` 在 layer scope 上注册 finalizer：

```ts
yield * Effect.addFinalizer(() => flush.pipe(Effect.ignore));
```

顺序很关键：

1. worker 先 `forkScoped`，注册自己的中断 finalizer；
2. flush finalizer 后注册；
3. Scope finalizer LIFO → flush 先执行；
4. flush 执行时 worker 还活着，`pending` 能继续归零；
5. flush 完成后再中断 worker。

flush 失败用 `Effect.ignore` 吞掉：worker 已经失败时没什么可 flush 的，
不应该让 layer 关闭因为收尾失败而报错。

## 为什么

- **关闭路径统一**:CLI / REPL / web reset / 测试都不用手写 flush。
- **顺序正确**:flush 必须早于 worker 中断，否则没人消费队列，flush 会等一个永远不归零的 pending。
- **失败不阻断关闭**:archive 坏了也要能关掉。

## 代价

- **关闭可能变慢**:flush 等所有已接受 entry，sink 慢就关得慢。
- **没有超时**:sink 永久卡住时，layer 关闭也会永久卡住。
- **只能尽力而为**:`kill -9`、进程崩溃、finalizer 没机会跑时仍然丢队列。
- **失败被吞**:关闭时的 flush 错误不会出现在调用方;需要诊断得看 sink / 进程日志。
- **依赖 finalizer 顺序**:以后如果在 flush 之后又注册了会阻塞 worker 的 finalizer，
  需要重新检查 LIFO 顺序。

## 复查条件

1. **关闭被卡住**:给 finalizer 加 `Effect.timeout`，并明确超时后丢队列的策略。
2. **需要知道关闭时是否丢数据**:让 flush finalizer 返回统计 / 记录失败，而不是 `ignore`。
3. **finalizer 顺序变化**:在 layer 里新增 finalizer 时，确认它和 flush / worker 的相对顺序。
4. **需要强制落盘**:在 sink 里加 fsync，而不是只依赖 flush（flush 只保证写进 sink）。
