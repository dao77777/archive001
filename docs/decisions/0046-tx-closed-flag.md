# 决策:用事务内 `closed` 标志取代 Semaphore gate

> 已接受 · 2026-10-26 · 取代 [`0037`](0037-gate-pubsub-flush.md) 的 gate 部分（其余不变）·
> 细化 [`0045`](0045-append-tx.md) · 落点 `packages/agent/src/archive/archive.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

`gate: Semaphore(1)` 同时承担「flush 期间独占」和「能不能 append」两件事，但它只能表达
**此刻有没有人拿着 permit**，不能表达**已经关了**：

- `append` 用 `withPermitsIfAvailable(1)`（包在 `Effect.tx` 外面），入队与准入不在同一个线性化点；
- flush 结束、permit 归还后，闸门自动「重开」；
- layer 关闭的后半段（flush 已结束、worker 即将被中断）里 `append` 仍然成功，但队列再没人消费。

实测（当时直接把 append 放在 `Scope.close` 之后）：

```
关闭后 append 的结果: Success
落盘 entries: [ 'e1' ]        ← late 这条静默消失
```

`Agent.publish` 对 archive 错误是 `Effect.ignore`，所以这个假成功连日志都没有。

## 处理

- 删掉 `Semaphore`，换成 `closed: TxRef<boolean>`；
- `append`：在 `Effect.tx` 里 `TxRef.get(closed)` → `TxQueue.offerAll` → `pending += n`，
  三道操作同一个事务；已关闭就 `Effect.fail(closingError)`（事务整体回滚，不会入队）；
- `flush`（layer 关闭的 finalizer）：`Effect.tx(TxRef.set(closed, true))` **先**关闸，**再**
  `TxSubscriptionRef.changesStream(pending)` 等归零；
- 补两条测试：「关闭过程中 append 失败,不入队」「关闭后 append 失败,不静默丢弃」。

## 为什么

- **准入与入队同一个线性化点**：STM 保证 append 事务要么排在关闸事务之前提交（`pending` 已算进去），
  要么看到 `closed = true`。permit 版本靠「持有期间 append 进不来」，能用但表达的是借用关系；
- **关闭是终态**：`closed` 一旦为 `true` 不再复位，和 `ArchiveShape` 的契约
  （「append 失败 = 没进队列 / 正在关闭」）一致；
- **append 之间不再互相串行**：`permits = 1` 时两个并发 append 也要排队，而它们其实不冲突
  （冲突交给 STM）;
- **少一个原语**：`Semaphore` 完全退出 archive。

### 为什么不是 `Latch`

`Latch`（`effect/Latch`）能表达「关闭且不再打开」，正好补上终态这一半，但补不了另一半：

| 需求                  | `Semaphore(1)`        | `Latch`                  |
| --------------------- | --------------------- | ------------------------ |
| flush 期间禁止 append | ✅ permit 被占住      | ❌ 只能标记，不能占住    |
| 准入与入队原子        | ⚠️ 包在事务外，够用   | ❌ 检查必须挪出事务      |
| 终态关闭              | ❌ permit 会还回来    | ✅ `close` 后永不 `open` |
| 能进 `Effect.tx`      | ⚠️ 不能，但可包在外面 | ❌ v4 没有 `TxLatch`     |

`Latch` 是 fiber 原语，读不进事务，所以 `append` 只能写成「先 `isOpen` 判断、再提交事务」，
把 [`0045`](0045-append-tx.md) 用事务消掉的 check-then-act 竞态请回来。两者都要就等于加原语。

## 代价

- **flush 变成一次性**：`closed` 不复位。当前 flush 只在 layer 关闭时跑（[`0044`](0044-flush-internal.md)），
  够用；哪天要「暂停写入 → 恢复」，得在事务里 reopen，或退回 permit / 条件变量模型；
- **失败状态仍不在事务里**：`failure` 还是普通 `SubscriptionRef`（[`0042`](0042-failure-state.md)），
  append 的 `race` 与事务是两条路径；
- **每条 append 多一次 `TxRef.get`**：与既有的 `offerAll` + `pending` 同事务，开销可忽略；
- **关闭后 append 从「静默成功」变成「报错」**：调用方如果原本指望它不失败，会看到
  `archive 正在关闭`。目前 `Agent.publish` 是 `Effect.ignore`，行为不变。

## 复查条件

1. **需要暂停后恢复写入**（比如导出 / 轮转期间只停写不关层）：把 `closed` 换成事务内的
   状态枚举（`open | draining`），drain 完在事务里回到 `open`，别在事务外另加一把锁。
2. **需要「关闭后仍接受、延后写」**：说明关闭不该是终态，退回 0043 的「关闭即丢」并明确文档，
   而不是把 `closed` 改回去当锁用。
3. **STM 争用明显**（append 高频 + `pending` 事务重试）：把 `closed` 和 `pending` 合成一个
   `TxRef<{ closed: boolean; pending: number }>`，一次读改。
4. **要在 flush 期间知道丢了多少**：不要恢复 permit，让 `append` 的 `closingError` 带计数或
   在 finalizer 里返回统计（见 [`0043`](0043-flush-on-close.md) 的复查条件 2）。
