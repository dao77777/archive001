# 设计:inbox

> 路径 `packages/agent/src/loop/inbox/service.ts`。循环整体见 [`loop.md`](loop.md),事件 schema 也在那里。

## 一句话

`Agent.send` 与工具执行器**唯一的交接面**:两边的消息都进这一条队列,它只管一件事 ——
**攒到"能喂模型了没有",攒够才交出整批**。

## 形状

```ts
offer(message); // prompt(来自 Agent.send) / tool result(来自 tool-executor)
takeReadyBatch(awaiting); // engine 唯一入口;awaiting = 还等着的 callId
```

两个动作都是"消息进 / 消息出"。inbox 不解释语义:不认识 transcript、不认识模型、
不认识"工具到底干啥"。

消息的**类型判别**也归这一层:`isUserMessage` / `isFunctionCallOutput`(refinement),
别的模块直接用,不许各自再写一遍 `_tag === ...`。

## 就位规则

| `awaiting` | 就位条件                     | 交出的内容                                                         |
| ---------- | ---------------------------- | ------------------------------------------------------------------ |
| 非空       | 这些 `callId` 的结果**全齐** | `functionCallOutputs`(只含等的调用,**按调用顺序**)+ `userMessages` |
| 空         | 至少一条 prompt              | `userMessages`;`functionCallOutputs` 为空(迟到结果丢掉)            |

```
awaiting = [c1, c2];  消息里已有 c1 的结果
difference([c1,c2], [c1]) = [c2]   非空 ⇒ 还没齐
difference([c1],    [c1]) = []     空   ⇒ 齐了
```

- 这套判断是一个**纯函数** `readyBatch(messages, awaiting)`:`Some(能交出去的子集)` / `None`;
  "就位 + 该带哪些消息"都在里面,`takeReadyBatch` 只负责"等"和"交"。三个分支用语义化的 guard
  (`hasAwaiting` / `hasMissing` / `hasPrompts`)做 `Match`,读起来是"有要等的调用 → 还缺吗 → 齐了"
  (没调用要等的分支直接内联,不再拆函数);
- **迟到结果**:上次引擎中断时留在队列/攒着里的工具结果,配套调用已经不存在 →
  永远等不到就位,`awaiting` 为空时一律丢掉;
- 判断用集合差(`Arr.difference`,内部走哈希桶),不是逐个 `some`。

交出的是**分好类、排好序**的形状,engine 拿到就能直接往 transcript 上追加:

```ts
interface ReadyBatch {
  functionCallOutputs: ReadonlyArray<InboxMessage<"FUNCTION_CALL_OUTPUT">>; // 按 awaiting 顺序
  userMessages: ReadonlyArray<InboxMessage<"USER_MESSAGE">>; // 按到达顺序
}
```

即使结果乱序回来(执行器按完成顺序写回,见 [`tool-executor.md`](tool-executor.md#顺序谁保证什么)),
`functionCallOutputs` 也是按调用顺序给的;不属于这次等的结果在这里就被丢掉。

engine 把它当**一条流**用:`Stream.fromEffectRepeat(takeReadyBatch(awaiting))` —— 每交出一批就是
"可以生成"一次,循环体由 `Stream.runForEach` 驱动。

字段名不用 `results` / `prompts` 这类泛称:和消息自己的 `_tag`、transcript 的 `Item.type` 同名,
一个词从头用到尾(inbox 消息 → 交出的一批 → transcript)。

## 等待:递归,不是 `while`

```
offer ──► queue ──┐
                  ▼
             takeReadyBatch(awaiting)
                  │
        ┌─────────┴──────────┐
     就位?                 没就位
        │                    │
   清空 buffer         takeAll(队列空 ⇒ 挂起)
        │                    │
      交出整批          攒进 staged
                             │
                          再判(递归自己)
```

- 攒着但没交出的消息在 `Ref staged`(inbox 内部):等就位期间引擎被中断**也不会丢**;
- 队列空时 `Queue.takeAll` 会挂起消费方 —— 没有轮询、没有定时器。

## 事件:谁管队列,谁发事件

| 事件          | 谁发(`inbox.ts`)        | 时机                     | 内容                     |
| ------------- | ----------------------- | ------------------------ | ------------------------ |
| `INBOX_OFFER` | `publishOffer(message)` | `offer` 时(**入队之前**) | 完整消息(`id` + payload) |
| `INBOX_TAKE`  | `publishTake(taken)`    | 每次真正出队             | 只带 `messageId`         |

`INBOX_OFFER − INBOX_TAKE` = "还没被取走的 inbox",可以从 archive 投影出来
(见 [`archive.md`](archive.md#能从-archive-恢复什么读侧))。

> 入队之前发 `INBOX_OFFER`:看到事件就已经能拿到正文,不必等出队。

## 谁负责什么

| 事                                                 | 谁                           |
| -------------------------------------------------- | ---------------------------- |
| 排队、攒到就位、分类、按调用顺序排好、发 `INBOX_*` | **inbox**                    |
| 按交出的顺序拼 transcript、发 step 内容、回放契约  | engine(`engine.ts`)          |
| 跑工具、失败转观测、截断                           | executor(`tool-executor.ts`) |

inbox 只回答"这一批齐了没有、里面哪些能交";**transcript 长什么样、报文合不合法是 engine 的事**。

## 不做什么

- 不发别的生命周期事件、不碰 transcript、不判断工具是否存在;
- 不做"部分就位":一批要么齐、要么继续等 —— 要改就是 `takeReadyBatch` 的语义变更,得立决策。
