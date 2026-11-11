# 决策:`inbox.take` 也带完整消息

> 已接受 · 2026-10-24 · 细化 [`0016`](0016-flat-events.md) 的 `inbox.take` 形状
> (其他事件不变)· **已被 [`0019`](0019-lifecycle-vs-content.md) 取代**
> (`inbox.take` 回到只带引用;它仍属于内容类事件)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0016 里:

```ts
inbox.offer { message }     // 内容
inbox.take  { messageIds }  // 只有 id
```

`take` 不自信:想知道"这一批到底消费了什么",必须回到前面的 `offer` 去查。

| 问题                | 说明                                                          |
| ------------------- | ------------------------------------------------------------- |
| take 不是自包含事件 | 回放 / 审计要 join offer;offer 被裁剪后 take 就失去内容       |
| 投影多一步          | inbox 状态要维护 id → message 映射,而不是直接比消息           |
| 语义不对等          | offer 是"放进去什么",take 是"拿走什么",两边都该能直接看见内容 |

## 处理

```ts
inbox.offer { message }       // 入队:完整消息
inbox.take  { messages }      // 出队:完整消息数组
```

- 状态机 `takeAll` 之后直接 `emit({ _tag: "inbox.take", messages })`,不再 map 成 id;
- inbox 投影仍然按 id 做差,但两边都自带内容,不需要查别的事件;
- prompt / tool_result 的判别方式不变:看 `message._tag`。

## 为什么

- **事件自包含**:`take` 单独看就知道"这一次被消费的 prompt / 工具结果是什么";
  重放、审计、调试都不依赖前面的 `offer`。
- **和引擎语义一致**:状态机拿到的就是 `InboxMessage[]`,事件原样记录,不做有损转换。
- **offer / take 对称**:一个入队、一个出队,都是内容事件;结构事件只剩 engine / turn / step。
- **对 archive 友好**:即使以后对 `offer` 做冷归档 / 压缩,`take` 仍然保留提交给模型的那批输入。

## 代价

- **内容重复**:同一条消息在 `offer` 和 `take` 各出现一次,archive 体积约多一份 inbox 流量。
- **redact 要覆盖两处**:导出 / 脱敏时不能只处理 `offer`。
- **id 仍然需要**:配对 offer/take 还是要 `message._tag === "prompt" ? id : callId`;
  只是不再用它去反查内容。
- **大工具输出会被写两遍**:`tool_result.output` 在 `offer` 与 `take` 都会落盘。

## 复查条件

1. **重复内容成为体积瓶颈**:改成 `offer` 只带 id/kind、`take` 带内容(或反过来),
   让"内容只出现一次";但这会重新引入 join,必须明确谁是内容源。
2. **需要按消息 id 快速索引**:保留 id 派生(现在从 message 里算),不要为索引再加字段。
3. **redact 漏掉一处**:把 `inbox.offer` / `inbox.take` 的内容放进同一个 redact 函数,
   在写 archive 前统一处理。
4. **take 只想要增量 / 摘要**:不要改 take 的内容语义;在投影层做统计。
