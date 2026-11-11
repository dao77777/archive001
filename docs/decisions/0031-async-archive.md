# 决策:archive 用队列异步落盘,`append` 只入队

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

如果每次事件都同步写盘:

- 每个 step 都要等 I/O,思考 / 工具 / 回答的延迟被磁盘拖慢;
- 写失败会直接打断对话;
- 事件产生方(状态机、工具执行器)要关心文件、路径、权限。

## 处理

- `Archive.append(event)` 只把事件放进 `Queue<ArchiveMessage>` 就返回;
- 一个常驻 worker 顺序消费:分配 `seq`、打 `at`、写 sink;
- `flush` 是屏障,等此前事件落盘(测试 / 优雅退出);
- 文件 sink:JSONL、单 writer、0600 / 0700、`flush` 时 fsync;
- `Agent.publish` 对 `append` 失败 `Effect.ignore`:实时事件继续,archive 失败通过 flush 暴露;
- 每个客户端 / web 会话一个 `archiveId` 一个文件。

## 为什么

- **不拖慢对话**:写入是异步的,`append` 的延迟只有一次入队。
- **顺序简单**:单 worker 顺序消费,`seq` 不需要原子分配。
- **解耦**:archive 只知道 `ArchiveSink`;文件 / 内存由调用方选。
- **可测**:memory sink + `flush` 让测试确定性地检查落盘内容。
- **失败可见**:sink 失败后 `append` / `flush` 失败,不静默丢。

## 代价

- **崩溃丢队尾**:`kill -9` 时队列里的事件、OS 页缓存里未 fsync 的内容会丢;
  `append` 成功 ≠ 已持久化。
- **无背压**:队列无界,极端情况下内存会涨。
- **archive 失败不阻断对话**:`publish` ignore 错误,用户可能继续聊但 archive 已经坏了;
  只能靠 `flush` / 状态发现。
- **没有读取 / 重放**:目前只有写侧,不能从 archive 恢复现场。
- **每个会话一个文件**:不做轮转 / 合并;长会话文件会一直增长。

## 复查条件

1. **需要"回答前必须落盘"**:把 `flush` 放到 turn 结束前,或改成 per-turn 同步 ack;
   这会牺牲延迟,需重新评估。
2. **内存压力**:改有界队列 + 背压(`append` 可能挂起),或批量写 / 压缩。
3. **archive 失败必须停对话**:把 `publish` 的 `Effect.ignore` 去掉,让 `ArchiveError` 传播。
4. **需要重放 / 续跑**:加 `readAll` / `entries(fromSeq)` + `fold(entries)` 投影;
   同时决定崩溃时未完成事件的处理。
5. **文件增长 / 轮转**:按大小 / 日期切文件,保留 `archiveId` + `seq` 链。
