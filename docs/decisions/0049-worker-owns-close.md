# 决策:关闭的收尾就是 worker 自己的 finalizer,外面不参与

> 已接受 · 2026-10-30 · 取代 [`0048`](0048-in-flight-batch.md) 的「在飞批次 + 排空判据」·
> 保留:失败以 `closed` / `failure` 表达、`append` 只入队 · 落点
> `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0048 为了"关闭时知道写没写完",把 worker 的内部状态（手上有没有一批）复制成
`writing`/`drained` 供外面观察,于是又付了三份税:取货与记账必须同一事务、每次变化要发布通知、
关闸后还要用 `changesStream` + `filterEffect` 判"排空"。而关闭流程真正想要的只有一句话：
**等 worker 干完**。

随后又被"谁来等"坑了一次:`.pipe(Effect.ensuring(...))` 在 `catch` 之前跑,顺序反了会让
`writing` 先变成 `None`,flush 提前放行,失败信号再也报不出去。这类"两个过程共享一个状态、
再靠顺序约定安全"的东西,每加一处就多一个可以踩反的地方。

而 flush 挪进 worker 的循环（关闸信号 + 循环开头收尾）虽然删掉判据,但又引入了 layer finalizer
与 worker 的**交互**（一个 `Deferred` 信号 + 一次 `Fiber.join`）：关闭流程仍然要理解 worker 的内部节奏。

## 处理

关闭交给 worker 自己的 finalizer,外面**什么都不做**：

```ts
// worker：唯一的写者
while (true) {
  batch = tx(takeAll(queue) + writing = Some(batch)); // 取货即认领
  sink.write(batch).retry(...);
  writing = None;                                     // 写成功才放下
}

// worker 的资源释放：中断时把没写完的直接写进 sink
onInterrupt 里 {
  closed = true;                                      // 先关闸
  rest = [...writing, ...TxQueue.clear(queue)];        // 手上这批在前，队列残余在后
  writing = None;
  if (rest.length > 0) sink.write(rest).retry(...);
}
```

- 收尾直接写在 worker 的 `Effect.onInterrupt(() => ...)` 里(不单独命名);
  `Effect.forkScoped({ startImmediately: true })`；
- 删除:layer 级 `addFinalizer`、`Deferred` 关闭信号、`Fiber.join`、`drained` 判据、
  `changesStream`、`TxSubscriptionRef`（`writing` 退回普通 `TxRef`）；
- 失败路径:关闸 + 置 `failure` + 清 `writing`,队列丢弃（失败之后不写）。

## 为什么

- **资源释放天然属于 worker**:它是唯一碰队列、唯一写 sink 的纤维;栈上没有的东西正是它自己该记账的。
- **外面不需要理解内部节奏**:没有信号要发、没有 idle 要等、没有顺序约定要守 —— layer 里连 finalizer 都没了。
- **单写者**:释放和正常写在同一纤维,不存在"谁接手"。
- **`writing` 的职责变单纯**:它不再是"给别人看的排空依据",只是"中断后我该补写什么"的记账。
- 取货与记账仍然同一事务,但理由变得**局部**:释放要拿这两处当"全部残余",分开提交就会丢一批。

## 代价

- ⚠️ **中断落在写盘中间时这一批会被再写一遍**。sink 的结局不可知,补写是唯一"不丢"的做法;
  代价与重试一致（半行 / 重复行）。这是刻意选择"宁可重复,不要丢"——
  [`0031`](0031-async-archive.md) / [`0047`](0047-append-enqueue-only.md) 的"fire-and-forget"口径没有变,
  但**尾部丢**变成了**尾部可能重复**。
- 收尾里的写也能被二次中断截断;关闭没有超时,sink 卡住 = 关闭卡住。
- `forkScoped` 必须 `startImmediately: true`:否则 scope 关得比第一次调度还快时,worker 一行没跑、
  `onInterrupt` 没注册,释放逻辑根本不存在（实现时踩过,5 个用例一起挂）。
- `writing` 每批多两次事务（认领、放下）;没有订阅者,成本可忽略。
- 失败路径不补写:失败前在写的那批只是"写坏了",不会重试到关闭。

## 复查条件

1. **重复行不可接受**（例如下游严格按行消费、不允许重放）:改成"中断时不补写"（丢掉手上那批），
   或者让 `sink` 支持幂等 / 截断半行后重写。
2. **需要"关闭不等写完"**:加超时;或者在收尾里只清队列、不补写在飞批次。
3. **需要进度 / 指标**:读 `writing` 即可（它现在带着整批 entry）；**不要**恢复 `drained` 判据。
4. **出现多 writer / 分片写**:释放要按 writer 分组,"一个 finalizer"的前提不成立,需重新设计关闭。
5. **`startImmediately` 之外的"fiber 还没跑就关"路径**（例如将来改成 `Layer.launch`）:
   确认 worker 的 finalizer 一定注册得上,否则释放逻辑会静默失效。
