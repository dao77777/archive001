# 决策:一批工具调用并发执行,观测按调用顺序写回

> 已接受 · 2026-10-24 · 落实 [`0009`](0009-inbox-loop.md) 的复查条件 4 ·
> **"按调用顺序写回"已被 [`0057`](0057-tool-writeback-completion-order.md) 取代**
> (写回也并发,顺序 = 完成顺序)·
> 落点 `packages/agent/src/loop/tool-executor.ts` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md#工具)

## 矛盾

`executeBatch` 一直是 `for` 循环逐条跑:

```ts
for (const call of batch.calls) {
  const output = yield* runTool(...);
  yield* inbox.offer(message);
}
```

模型一次吐出多个 `function_call` 很常见(读三个文件、跑两条命令),串行时**总耗时 = 各自耗时之和**,
而它们之间大多没有依赖。改动的唯一阻力一直是"顺序语义":

| 想要           | 串行时天然成立,并发后要处理                               |
| -------------- | --------------------------------------------------------- |
| 观测顺序可复现 | archive / 事件里 `FUNCTION_CALL_OUTPUT` 的顺序 = 调用顺序 |
| 状态机能就位   | 按 `callId` 匹配,顺序无关(这部分**不用改**)               |
| 副作用不打架   | `write_file` / `bash` 可能改同一路径,并发就有竞态         |

## 处理

`Effect.forEach(..., { concurrency: TOOL_CONCURRENCY })` 并发跑,**按 `calls` 顺序收集**,再依次写回:

```ts
const messages =
  yield *
  Effect.forEach(
    batch.calls,
    (call) => runTool(tool, call).pipe(Effect.map((output) => observationOf(call, output))),
    { concurrency: TOOL_CONCURRENCY }, // 4
  );
for (const message of messages) yield * inbox.offer(message);
```

- `forEach` 保序:返回值与 `calls` 一一对应,写回时不会乱;
- `TOOL_CONCURRENCY = 4` 是**批内**上限(不是全局线程池);
- 跨批、跨 step 仍串行:worker 一批跑完才取下一批,下一步依赖上一步的结果;
- 状态机不用改:就位判断是 `pending.every(...)`,并进 transcript 时按 `pending`(调用顺序)重排。

## 为什么

- **保序的并发**两全:执行重叠,事件与 archive 仍是确定的调用顺序,回放 / 审计不用重新推理;
- **写回不额外损失延迟**:状态机本来就要等整批结果齐了才生成(就位条件),"等最慢那个再一起交"
  在端到端的延迟上没有代价;损失的只是"第一条结果先出现的渐进感"(客户端目前也不用它);
- **上限而不是无界**:一批 20 个 `bash` 同时起 20 个子进程没意义,4 个足够把常见 I/O 重叠掉;
- **不改上游**:`callId` 匹配本来就是顺序无关的,这次只动了执行器一个函数。

## 代价

- **副作用仍是竞态**:同一批里两个 `write_file` 写同一路径,谁后落盘不确定;串行时至少是
  "调用顺序决定结果"。现在只能靠提示词 / 工具设计避免(没有读写锁、没有串行组);
- **事件不再渐进**:批内所有 `INBOX_OFFER` 在**最慢的工具**结束后一起出现,archive 里看不到
  "第一个工具什么时候完成";排查慢工具要靠日志或工具自身的事件;
- **一个慢工具拖住整批写回**:虽然模型也要等齐,但"结果已好却压着不发"看起来像卡住;
- **并发上限对所有人一样**:没有按工具区分的限流(比如 `bash` 想小一点、`read_file` 想大一点);
- **多 fiber**:同一批调用现在开最多 4 个 fiber,调试面板里一个 step 会展开成多条并发线。

## 复查条件

1. **同一批写同一文件出问题**(结果时好时坏):给 `Tool` 加 `serial` / `resourceKey` 标记,
   按标记分组执行(同组串行、组间并发);不要退回全串行。
2. **需要渐进结果**(第一条结果就回喂 / 客户端展示进度):改成"完成即写回",代价是丢保序,
   那时要同时决定 archive 顺序是否还要求确定性(可能得给事件加序号)。
3. **4 太小 / 太大**:先按工具类型分档(读类可以更高,shell 类更低),再考虑从
   `AgentConfig` 暴露;别直接调成 unlimited。
4. **限流需要全局而非批内**(多批 / 多会话共享):并发控制上移到 `AgentConfig` 或独立的
   semaphore 服务,执行器只负责语义。
