# 决策:排空判据换成「队列空 + 在飞的一批」,删掉 pending 计数

> **已被 [`0049`](0049-worker-owns-close.md) 取代**(`writing` / `drained` 一并删除)·
> 已接受 · 2026-10-30 · 取代 [`0040`](0040-pending-count.md) / [`0041`](0041-flush-subscription-ref.md)
> 的 `pending` 计数,以及 [`0045`](0045-append-tx.md) 里「append 同事务加计数」的部分
> · 保留 [`0047`](0047-append-enqueue-only.md) 的 append 只入队 · 落点
> `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

`pending: TxSubscriptionRef<number>` 是"已接受但还没写完的 entry 数",它由**三个过程**共同维护:

| 谁                   | 怎么改                          |
| -------------------- | ------------------------------- |
| `append`             | `+= entries.length`(入队事务里) |
| worker               | `-= batch.length`(每写完一批)   |
| finalizer / 失败路径 | `= 0`(关闸、writer 挂了)        |

它只有一个读者:`flush`。于是"能不能关掉"要三处对齐,而这三处各自只知道自己那一步:

- `append` 明明只该管"入门",却要为 drain 记账;
- worker 的 `takeAll` 和 `-= n` 之间隔着一次 `sink.write`,**队列已经空了但计数还没减**,
  这个中间态靠计数表达,不靠数据结构表达;
- 失败路径要额外把计数清零,否则 `flush` 会等一个永远不归零的数。

换句话说:计数"跨了三个过程",但排空本来只是一个**结构问题**——一条 entry 现在在哪?

## 处理

```ts
queue: TxQueue<ArchiveEntry>; // 已接受、还没人取
writing: TxSubscriptionRef<Option<ReadonlyArray<ArchiveEntry>>>; // worker 手上正在写的那批
```

- **取一批 = 一个事务**:`TxQueue.takeAll(queue)` 与 `writing = Some(batch)` 一起提交;
- 写完把 `writing` 置回 `None`(也在事务里);
- 排空 = `Effect.tx(TxQueue.isEmpty(queue) && writing === None)`,两样在同一个快照里读;
- `flush`:`关闸 → changesStream(writing) → filterEffect(drained) → take(1)`;
- `append` 不再碰任何计数:仍然只是 `TxRef.get(closed)` + `TxQueue.offerAll`;
- 失败路径:关闸 → 置 `failure` → `writing = None`(手上那批丢弃)。

## 为什么

- **语义分开**:`writing` 只属于 worker 一个过程,`append` 和 finalizer 都不写它;
  其余状态全部由「队列 + `writing`」算出来,不再有第三份真相。
- **中间态变成不可表达**:`takeAll` 与 `writing = Some` 同一事务提交,所以不存在
  "队列空了但没人知道这批还在写"的窗口;计数版本里这个窗口是靠减法补上的。
- **漏醒可以论证**:关闸后只有 worker 动队列,而它取 / 交一批都会改 `writing`,
  所以每个 `Some → None` 都是一次判定机会;不存在"状态变到排空但没有通知"的路径。
- **append 更小**:一个事务里只剩闸门 + 入队,失败回滚没有第二份状态要回滚。

## 代价

- **`flush` 从"一个数比阈值"变成"一次事务读两样"**:多一层 `Effect.tx` + `filterEffect`,
  可读性略微下降(换来的是不变量能一句话说完)。
- **`writing` 仍要能被订阅才能唤醒 flush**:所以它还得是 `TxSubscriptionRef`,
  每条批次发布两次(取走、交回),比原来只发布一次更频繁——订阅者只有 flush,影响可忽略。
- **“写完”和“放下这批”不可能一个事务**:`sink.write` 是外部操作，只能两次提交；
  中断落在写的过程中会丢掉那一批(sink 的结局不可知)，所以 `onInterrupt` 也要放下这批。
- **失败要先发信号、再放下这批**:反序会让 `flush` 先看到「排空」而放行，失败就报不出去
  （`Failure` 还没置、scope 已关完）。这条约束是 0041 代价里那条的翻版，换了个状态名而已。
- **隐式假设单 writer**:`writing` 是"一批"而不是"一批的集合";将来并发写就要改成集合或计数。
- **历史文档要读者自己换算**:0040 / 0041 / 0045 里仍是 `pending` 的说法(它们记录的是当时的取舍)。

## 复查条件

1. **worker 变并发**(多 writer / 分片写):`writing` 改成 `Option<Map<workerId, Batch>>` 或退回计数,
   并且排空判据要重新证明不漏醒。
2. **队列被"非 worker 路径"改动**(例如关闸时 `TxQueue.clear`):那条路径必须同时发一次 `writing` 更新,
   否则 `flush` 会等一个不会到来的通知 —— 出现这种改动就把 drain 通知抽成显式信号。
3. **flush 开销可见**(高频关闭 / 多次订阅):换回一个专门的布尔 `TxSubscriptionRef<boolean> drained`,
   在 worker 的同一个事务里顺带写它。
4. **需要"正在写哪一批"的进度信息**(日志 / 指标):`writing` 已经带着整批 entry,直接读它,不要再加计数。
