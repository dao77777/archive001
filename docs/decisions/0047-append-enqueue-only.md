# 决策:append 只负责入队,worker 失败改走 `ARCHIVE_ERROR` 事件

> 已接受 · 2026-10-26 · 取代 [`0039`](0039-failure-as-signal.md) / [`0042`](0042-failure-state.md)
> 里「append 监听失败」的部分 · 细化 [`0046`](0046-tx-closed-flag.md) · 落点
> `packages/agent/src/archive/` + `packages/agent/src/loop/loop.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

`append` 本来只做一次 `Effect.tx`（查 `closed` + `offerAll` + `pending += n`），提交即返回，
不等 `sink.write`。但为了把 worker 的失败同步给调用方，它外面还套了一层：

```ts
yield * Effect.raceFirst(watchFailure, attempt);
```

`watchFailure` 是 `SubscriptionRef.changes(failure)` 上的一条流，所以**每条 append** 都要：

- 订阅一次 `changes`、fork 一个纤维、完成后再中断它；
- 把同一个**终态**错误重复上报给每个调用点。

而 archive 的失败是**整层终态**（worker 挂了就再也不恢复），不是「这一条没写进去」；
按调用点复制它就是拿一个 `Ref` 的读取代了「一条事件」。副作用是 `append` 的语义也变浑：
它既说「已入队」，又会因为别的事先发生而失败。

## 处理

- **append 只入队**：删掉 `raceFirst(watchFailure, …)`，只剩 `Effect.tx`；
  唯一还会失败的本地条件是 `closed`（关闸 / worker 已失败），一条 `TxRef.get`；
- **worker 失败时关闸**：失败处理器依次 `TxRef.set(closed, true)` → `failure = Some` →
  `pending = 0`。于是失败之后 append 仍然**立刻失败**，但不再需要任何订阅；
- **新增只读通道**：`ArchiveShape.errors: Stream<ArchiveError>`，即
  `changes(failure)` 过滤 `Some`，一次性、带当前值（晚订阅也能收到）；
- **`Agent` 转发成内容事件**：`loop.ts` 里 `forkScoped` 订阅 `archive.errors`，构造
  `ARCHIVE_ERROR { message, cause? }` 直接 `PubSub.publish(bus, …)`（**绕过 archive**，
  否则上报本身也会因为 archive 死了而失败），同时 `Effect.logError` 一条；
- **晚订阅回放**：和 `ENGINE_END` 一样存一份 `Ref<Option<Entry>>`，`events` 先补历史再接实时；
- 测试：「worker 失败后 `errors` 发错误、之后 append 直接失败」（archive 层）+
  「archive 失败时 `Agent.events` 收到 `ARCHIVE_ERROR`，对话照常跑完」（agent 层）。

## 为什么

- **错误通道与返回通道分开**：`append` 的返回值只回答「这条进队列了吗」，archive 的死活
  是一次性事件，订阅一次比每个调用点读一次更便宜也更诚实；
- **失败仍然是终态**：关闸把「worker 死了」变成「append 立刻失败」，语义和 [`0046`](0046-tx-closed-flag.md)
  的 `closed` 统一，不需要第二套判断；
- **对话不被 archive 拖住**：`ARCHIVE_ERROR` 只是内容事件，`run` 继续跑，客户端可以选择显示 / 忽略；
- **绕过 archive 上报**：archive 失败时它自己写不进去，错误事件不能再排队等它。

## 代价

- **失败不再回溯否认已入队的记录**：worker 死亡到关闸之间（一个事务宽度）的 append 仍会成功入队
  然后丢掉。这是 fire-and-forget 的固有窗口，比「每条 append 都假装能预知」诚实；
- **不订阅 `Agent.events` 就看不到**：错误不再是 `append` 返回值的一部分，调用方（含测试）必须订阅；
- **新增一个内容 tag**：`ARCHIVE_ERROR`，客户端要显示就得加分支（不处理也不影响对话）；
- **`errors` 是一次性流**：不结束但只可能有 1 个值；读者若中途取消订阅，后续订阅仍能拿到
  （因为来自 `SubscriptionRef` 当前值）；
- **两次判断**：`append` 看 `closed`，`errors` 看 `failure`，二者由失败处理器同时置位，
  理论上存在极窄的「append 已失败但 `errors` 还没发出」窗口（顺序是先关闸后置状态）。

## 复查条件

1. **需要「哪几条没写进去」**：现在的语义是「失败之后都不写」，要精确到条目就在 `pending` 里带上
   未落盘的 id 集合，并在 `ARCHIVE_ERROR` 里返回，而不是恢复 per-append 的失败镜像。
2. **需要调用方同步感知失败**（比如写入是对话的前置条件）：那说明 archive 不该是旁路，
   改成 `append` 等 `sink.write` 完成（`appendAndWait`），而不是加回 `race`。
3. **`ARCHIVE_ERROR` 需要在 `run` 停止后仍可查**：已通过 `Ref` 回放覆盖；若发现客户端只在
   重连后才订阅、且想要「历史是否丢过数据」，应改成读 sink 的计数，而不是复用事件。
4. **失败后仍希望继续写**（换 sink 重试）：把 `closed` 从终态改成可重置，并在事务里 reopen
   （见 [`0046`](0046-tx-closed-flag.md) 复查条件 1）。
