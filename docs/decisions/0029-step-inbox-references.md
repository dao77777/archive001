# 决策:step 里的 inbox 引用统一用 `inboxId` / `inboxIds`

> 已接受 · 2026-10-24 · 细化 [`0028`](0028-inbox-id-payload.md)
> (inbox 消息 id/payload 不变)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)
> · "`USER_MESSAGE` 用数组 `inboxIds`"已由 [`0066`](0066-user-message-single-inbox-id.md) 取代(一条 prompt 一条事件)。

## 矛盾

step 内容里引用 inbox 消息时用了两套字段:

```ts
USER_MESSAGE           { promptIds }     // prompt id 数组
FUNCTION_CALL_OUTPUT   { callId, output } // 用 callId,还带了内容
```

- `promptIds` / `callId` 是两种名字,实际都指向 inbox 消息;
- `FUNCTION_CALL_OUTPUT` 还复制了 output,和 `INBOX_OFFER` 重复;
- 和"inbox 消息自身用 `id`"的新模型不一致。

## 处理

step 里的 inbox 引用统一:

```ts
USER_MESSAGE         { id, parentId, inboxIds }  // 多条 prompt → 数组
FUNCTION_CALL_OUTPUT { id, parentId, inboxId }   // 一条工具结果 → 单数
```

- 引用值就是 `InboxMessage.id`;
- 内容不再复制:prompt 原文在 `INBOX_OFFER` 的 `USER_MESSAGE.payload.text`,
  工具输出在 `INBOX_OFFER` 的 `FUNCTION_CALL_OUTPUT.payload.output`;
- 工具调用配对键 `callId` 留在 inbox 消息的 payload 里,step 事件不再重复。

## 为什么

- **一个引用名**:不管是 prompt 还是工具结果,都用 `inboxId(s)`,消费方不需要记两套。
- **引用不复制内容**:step 事件只负责"这一步吃了哪些 inbox 消息";内容查 offer。
- **单复数表达基数**:`USER_MESSAGE` 一次可能多条 → `inboxIds`;
  `FUNCTION_CALL_OUTPUT` 一条结果一个事件 → `inboxId`。
- **和 `INBOX_TAKE` 对齐**:take 的 `messageIds` 也是 inbox 消息 id,投影可以互相校验。

## 代价

- **事件不再自包含**:要拿 prompt 文本 / 工具输出,必须 join `INBOX_OFFER`;
  如果 offer 被裁剪,需要保证引用可查。
- **`callId` 不在 step 事件里**:要配对工具调用,得去 inbox payload 找。
- **单复数两种字段**:`inboxIds` vs `inboxId`,写错时类型能挡,但读起来要注意。

## 复查条件

1. **需要 step 事件自包含**:在 step 里保留 `inboxIds` 的同时加一份内容快照,
   或恢复 `FUNCTION_CALL_OUTPUT.output`;但不要改回 `callId` 当引用名。
2. **inbox offer 被裁剪**:保证 take/step 引用的 id 仍能查到内容,或把内容快照进 step。
3. **需要统一成总是数组**:把 `FUNCTION_CALL_OUTPUT` 也改成 `inboxIds`(通常长度为 1);
   代价是语义变模糊。
