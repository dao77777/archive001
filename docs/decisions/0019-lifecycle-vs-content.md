# 决策:结构 = 生命周期容器,内容 = 容器里发生的事

> 已接受 · 2026-10-24 · 取代 [`0018`](0018-inbox-take-content.md)
> (`inbox.take` 回到只带引用)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0018 把 `inbox.take` 改成带完整消息,理由却是"它应该自信" —— 这把**结构 / 内容**理解成了
"带不带正文",而不是它们的本来含义:

| 概念     | 真正的含义                                                 | 例子                                                                       |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| **结构** | 生命周期容器:`start … end` 成对出现,用来容纳里面发生的内容 | `engine.start/end`、`turn.start/end`、`step.start/end`                     |
| **内容** | 容器里发生的事;可以是正文,也可以是对内容的引用             | `inbox.offer`、`inbox.take`、`thinking`、`text`、`tool.call`、`turn.error` |

按这个定义,`inbox.take` 本来就是**内容事件**(它不是 start/end),但它只是"取走了哪些消息"这个动作,
用 id 引用即可;消息正文已经在 `inbox.offer` 里。

## 处理

```ts
inbox.offer { message }      // 内容:完整消息(prompt / tool_result)
inbox.take  { messageIds }   // 内容:被取走消息的引用
```

- `inbox.take` 归入内容类事件,但**只带引用**,不再复制 message;
- 结构事件只剩 `engine.*` / `turn.*` / `step.*` 的 start/end;
- inbox 投影仍然按 id 做差:`offered − taken`;内容从 `inbox.offer` 取。

## 为什么

- **结构是容器,不是"无内容事件"**:`inbox.take` 不是生命周期边界,所以它是内容;
  但"内容"不等于"必须复制正文"。
- **一条事实只存一份**:消息正文在 offer;take 只表达"消费了哪些"。
  两份正文会让 archive 体积翻倍,redact 也要做两遍。
- **引用足够重建**:`take` 的 id 配合 offer 就能还原消费顺序与内容;
  如果以后 offer 被裁剪,再单独讨论 take 的自包含性。
- **事件表更好读**:start/end 一眼看出层级;其余都是发生的事。

## 代价

- **take 不自信**:回放 / 审计要 join offer;如果 offer 被冷归档,需要保证 id → 内容的可查性。
- **redact 只需覆盖 offer**(以及 thinking/text/tool.call/turn.error),不用重复处理 take。
- **id 规则仍在**:prompt 用 `id`、tool_result 用 `callId`;投影要知道这个约定。
- **0018 的实现要回退**:`inbox.take` 从 `{ messages }` 回到 `{ messageIds }`。

## 复查条件

1. **archive 允许裁剪 / 压缩 offer,但 take 必须自包含**:改成 take 带内容(回到 0018 的形态),
   或保证 offer 的保留期不短于 take。
2. **需要按 take 直接渲染内容**:让投影先 join offer;不要为了渲染方便复制正文。
3. **结构 / 内容的定义再次混淆**:以"是否 start…end 生命周期"为唯一判据,不以"带不带正文"判据。
4. **inbox.take 需要额外元信息**(比如取走原因 / 批次号):加在 take 上,它仍是内容事件;
   不要包装成 `inbox.take.start/end`。
