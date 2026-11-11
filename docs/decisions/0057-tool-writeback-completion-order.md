# 决策:写回也并发,观测顺序 = 完成顺序

> 已接受 · 2026-10-24 · 取代 [`0056`](0056-tool-batch-concurrency.md) 的"按调用顺序写回"
> (0056 复查条件 2 触发了:不保序,换取完成即回喂)· 落点
> `packages/agent/src/loop/tool-executor.ts` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md#工具)

## 矛盾

0056 只并发**执行**,写回仍是排队等最慢的那个:

```ts
const messages = yield * Effect.forEach(batch.calls, runOne, { concurrency: 4 });
for (const message of messages) yield * inbox.offer(message); // 等最慢的
```

| 问题                 | 说明                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| 快的结果被压着       | `read_file` 10ms 就回来了,却要等一批里那个 30s 的 `bash` 才写回                                       |
| 事件看不到渐进       | 批内所有 `INBOX_OFFER` 在最后一起出现:archive 里看不出哪个工具先好、哪个在拖                          |
| 复杂度没用处         | `messages` 保序收集 + 二次循环,维护了一套**状态机并不需要**的顺序保证                                 |
| 顺序不是契约的一部分 | 就位判断按 `callId`(`pending.every(...)`),进 transcript 时按 `pending` 顺序重排 —— 写回顺序从来没人读 |

## 处理

跑工具与写回放进同一个并发任务,完成一个写回一个:

```ts
Effect.forEach(
  batch.calls,
  (call) =>
    runTool(batch.tools, call.name, call.arguments).pipe(
      Effect.flatMap((output) => inbox.offer(observationOf(call, output))),
    ),
  { concurrency: TOOL_CONCURRENCY, discard: true },
);
```

- 不再收集结果、不再二次写回,`Effect.forEach` 用 `discard: true`;
- `INBOX_OFFER` / archive 里观测的顺序 = **完成顺序**;
- transcript 不受影响:`takeReady` 交出的 `results` 按 `awaiting`(调用顺序)排好,
  由 inbox 负责([`0062`](0062-inbox-ready-batch.md)),engine 顺序追加;
- `INBOX_TAKE` 也不受影响:它按"这一批里有什么"取值,不依赖先后。

## 为什么

- **延迟只按最慢的工具算**:第一批结果提前到;虽然下一次生成仍要等齐(就位条件),
  但"结果已好却压着不发"这种假卡顿消失;
- **少一层多余状态**:不再有 `messages` 数组,也不需要维护"保序收集"的理由;
- **回放契约不靠写回顺序**:`FUNCTION_CALL_OUTPUT` 紧跟 `FUNCTION_CALL` 是状态机重排保证的,
  测试直接盯着 transcript 断言(而不是盯事件顺序);
- **archive 更如实**:events 记录"事情何时发生",而不是"我们整理后的顺序"。

## 代价

- **事件顺序不再确定**:同一个 prompt 两次跑,`INBOX_OFFER` 的先后可能不同;基于 archive
  的 diff / 断言不能依赖这个顺序(要确定性只能自己按 `callId` 排序);
- **archive 里"哪批调用"变模糊**:同一批的观测可能与其他事件交错;只能靠 `callId` +
  `FUNCTION_CALL` 的 step 归属去归组,没有显式的 batch 标记;
- **客户端若想按到达顺序渲染工具进度**:现在拿到的是完成顺序,渲染会抖;要稳定得自己排序;
- **`inbox.offer` 多 fiber 并发写队列**:`Queue.offer` 是安全的,但"先 offer 的消息先被
  `takeReady` 取走"这条语义现在只反映到达时间,不再反映调用顺序。

## 复查条件

1. **archive 顺序被当契约用**(重放要逐字节一致 / 有客户端按事件顺序做增量渲染):
   加显式序号(entry `seq` 或 batch index)再谈顺序;不要退回"等最慢的"。
2. **需要按批归组**(比如统计一批工具耗时):在 `FUNCTION_CALL` / `FUNCTION_CALL_OUTPUT`
   上加 `batchId` 或 `stepId` 引用,而不是靠相邻行推断。
3. **慢工具拖到必须"先回喂一部分"**:那时要考虑的是"部分就位"的就位条件(现在要求整批齐),
   不是写回顺序;那会改 `takeReady` 的语义,单独立决策。
4. **并发上限成为瓶颈或竞态源**:按工具类型分档 / 给写类工具串行组,见
   [`0056`](0056-tool-batch-concurrency.md) 复查条件 1、3。
