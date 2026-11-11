# 决策:append 用 Semaphore 做门,flush 用 PubSub 等排空

> 部分被 [`0040`](0040-pending-count.md) 取代（waiters → pending）·
> 已接受 · 2026-10-24 · 原细化 [`0036`](0036-one-waiter-per-entry.md)· 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0034–0036 的状态机同时承担了四件事:

- append 的准入（`status === OPEN`）；
- per-entry 等待点（`waiters`）；
- flush 的锁（`FLUSHING` + `flush` Deferred）；
- worker 失败的传播（`CLOSED` + `failure`）。

其中“准入”和“排空通知”可以用更专用的原语表达:

| 需求                        | 更专用的原语               |
| --------------------------- | -------------------------- |
| 现在还能不能 append         | `Semaphore` permit         |
| 等“所有已接受 entry 都写完” | `PubSub` 的 `DRAINED` 事件 |
| 每条 entry 的等待点         | `Deferred`（保留）         |

## 处理

- **gate**：`Semaphore.make(1)`
  - `append` 用 `withPermitsIfAvailable(1)`；拿不到 permit 直接失败，不创建 Deferred；
  - `flush` 用 `withPermits(1)` 拿住 gate，直到排空。
- **per-entry Deferred** 保留：
  - `waiters: Ref<Waiter[]>`，一条 entry 一个 `{ id, done }`；
  - worker 写完一批，完成对应 id 的 Deferred。
- **PubSub 做状态通知**：
  - worker 在 waiters 清空时发 `DRAINED`；
  - worker 失败时发 `FAILED`，并让所有未完成 Deferred 失败；
  - `flush`：拿 gate → 订阅 → 检查 waiters；非空就等 `DRAINED` / `FAILED`。
- **失败状态** 只保留 `failure: Ref<Option<ArchiveError>>`：
  - append 在登记 waiter 前后各检查一次；
  - flush 在订阅前后各检查一次。
- 删除 `Status`、flush 的 Deferred、`flushDone`。

## 为什么

- **准入就是 permit**:不需要自己维护 `OPEN/FLUSHING`；flush 拿着 permit，append 自然进不来。
- **排空就是事件**:waiters 清空时发一次 `DRAINED`，flush 订阅后等它，不需要状态字段。
- **等待点仍是 Deferred**:per-entry 的定向、可失败回执，PubSub 替代不了。
- **并发 flush 更简单**:第二个 flush 在 gate 上排队，拿到后看一眼 waiters 就返回，不需要共享 flush Deferred。

## 代价

- **多一个 PubSub + 订阅 Scope**:flush 里要 `PubSub.subscribe`（带 Scope），用完关闭。
- **订阅时序**:必须“拿 gate → 订阅 → 检查 waiters”，否则可能错过 `DRAINED`。
- **失败竞态要小心**:worker 失败时不清空 waiters，flush 才能稳定等到 `FAILED`；
  append 需要登记前后两次 failure 检查。
- **并发 flush 变成串行**:第二个 flush 等第一个释放 gate，而不是共享同一个等待点。
- **DRAINED 可能重复发**:每次 waiters 清空都发；没有订阅者时直接丢，不影响正确性。

## 复查条件

1. **flush 订阅时序经常写错**:把“拿 gate + 订阅 + 检查 + 等事件”封装成一个 helper，
   不要让调用方自己拼。
2. **并发 flush 需要共享同一个等待点**:退回 0036 的 `flush` Deferred，或让第二个 flush
   订阅第一个的完成事件。
3. **失败竞态仍出现**:把 `failure` 和 `waiters` 合并到一个 Ref，原子读取；
   或者让 worker 失败时关闭 gate（但 flush 需要另一条读取失败的路径）。
4. **PubSub 开销明显**:只在 flush 频繁时才有意义；单用户本地可忽略。
