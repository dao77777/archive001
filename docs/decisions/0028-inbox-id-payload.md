# 决策:inbox 消息统一 `id` + `payload`

> 已接受 · 2026-10-24 · 细化 [`0026`](0026-uppercase-tags-items.md)
> (命名不变)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

两条 inbox 消息的"自身 id"位置不一致:

```ts
{
  _tag: ("USER_MESSAGE", id, text);
}
{
  _tag: ("FUNCTION_CALL_OUTPUT", callId, name, output);
} // 用 callId 当消息 id
```

- prompt 用 `id`,tool result 用 `callId`,投影要分别处理;
- 文本 / callId / 工具输出散在消息顶层,和"消息 = id + 内容"的模型不一致;
- tool result 的 `callId` 是"回应哪次调用",不是"这条 inbox 消息是谁"。

## 处理

所有 inbox 消息统一:

```ts
interface InboxUserMessage {
  _tag: "USER_MESSAGE";
  id: string; // 消息自身
  payload: { text: string }; // 内容
}

interface InboxFunctionCallOutput {
  _tag: "FUNCTION_CALL_OUTPUT";
  id: string; // 消息自身(独立生成)
  payload: { callId: string; name: string; output: string };
}
```

- `INBOX_OFFER { message }` 带这个形状;`INBOX_TAKE { messageIds }` 里的 id 就是 `message.id`;
- `messageIdOf` 退化成 `message.id`;
- 工具结果的 `id` 由执行器生成 UUID,`payload.callId` 仍然用于和 `FUNCTION_CALL` 配对;
- `USER_MESSAGE` 的 id 仍是客户端给的 prompt id。

## 为什么

- **一条消息一个身份**:`id` 只回答"这条消息是谁",不掺业务 id(callId)。
- **内容有固定容器**:`payload` 统一放正文 / callId / 输出,新增消息类型时形状稳定。
- **投影简单**:`offer − take` 都用 `message.id`,不需要按 tag 分支取 id。
- **callId 语义归位**:它是工具调用的配对键,属于 payload,不再是 inbox 消息的身份。

## 代价

- **多一个 id**:tool result 现在有 `id` + `payload.callId` 两个 id,排查时要说清是哪个。
- **旧事件/旧测试要迁移**:之前把 callId 当消息 id 的地方全部要改。
- **消息更大一点**:多一层 `payload` 嵌套。
- **工具执行器要生成 id**:不能再复用 provider 的 callId。

## 复查条件

1. **`id` 与 `payload.callId` 混淆造成 bug**:在类型命名上继续强化(如 `messageId`),
   不要合并两个概念。
2. **payload 需要版本化**:加 `payload.v` / schema,而不是把字段摊回顶层。
3. **需要跨进程稳定 id**:prompt id 仍由客户端给;tool result id 可以改成 `${callId}:${attempt}`
   这类确定性 id,但仍放在 `id` 字段。
4. **消息数量大、嵌套开销明显**:保持 `id` + `payload`,不要为性能拆回扁平的 callId 当 id。
