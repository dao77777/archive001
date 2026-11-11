# 决策:`ArchiveEvent` 用 `ArchivePayloads` 泛型绑定 tag 与 payload

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/loop/_domain.ts` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

`ArchiveEvent` 是一长串手写的联合:

```ts
type ArchiveEvent = EventBase & (
  | { _tag: "ENGINE_START" }
  | { _tag: "INBOX_OFFER"; message: InboxMessage }
  | { _tag: "USER_MESSAGE"; inboxIds: ReadonlyArray<string> }
  | …
);
```

- 每个事件都要重复写 `_tag` 和 payload;
- 想按 `_tag` 取出某种事件时,只能手写 `Extract<ArchiveEvent, { _tag: "…" }>`;
- 新增事件要改三处:类型、发布处、订阅处;容易漏。

## 处理

像 `InboxMessage<Tag>` 一样,用 payload 表 + 条件类型:

```ts
interface ArchivePayloads {
  ENGINE_START: {};
  ENGINE_END: {};
  INBOX_OFFER: { message: InboxMessage };
  INBOX_TAKE: { messageIds: ReadonlyArray<string> };
  SYSTEM_MESSAGE: { text: string };
  USER_MESSAGE: { inboxIds: ReadonlyArray<string> };
  FUNCTION_CALL_OUTPUT: { inboxId: string };
  ASSISTANT_MESSAGE: { text: string };
  REASONING: { text: string };
  FUNCTION_CALL: { callId; name; arguments };
  STEP_ERROR / TURN_ERROR / ENGINE_ERROR: { message: string };
  // …
}

type ArchiveTag = keyof ArchivePayloads;

type ArchiveEvent<T extends ArchiveTag = ArchiveTag> = T extends ArchiveTag
  ? {
      _tag: T;
      id: string;
      parentId?: string;
    } & ArchivePayloads[T]
  : never;
```

- 不写泛型 → 全部事件的联合;
- `ArchiveEvent<"INBOX_OFFER">` → payload 自动收窄为 `{ message: InboxMessage }`;
- `Extract<ArchiveEvent, { _tag: "…" }>` 仍然可用。

## 为什么

- **一处定义**:新增事件只加 `ArchivePayloads` 一项,payload 与 tag 自动绑定。
- **按 tag 收窄**:`ArchiveEvent<"ENGINE_ERROR">` 不需要再手写 Extract。
- **和 `InboxMessage<Tag>` 一致**:两层消息都用同一套泛型模式。
- **减少重复**:事件联合不再逐个重复 `_tag` / payload。

## 代价

- **类型更抽象**:读 `_domain.ts` 要理解条件类型分发;IDE 提示会比显式联合长。
- **嵌套泛型**:`ArchiveEvent<"INBOX_OFFER">["message"]` 是 `InboxMessage`,再收窄要按 `_tag`。
- **错误信息可能更难读**:泛型约束报错时,堆栈里出现 `ArchivePayloads[...]`。
- **`EventBase` 已去掉**:`id` / `parentId` 和 `_tag` 一样直接写在 `ArchiveEvent<T>` 里,
  少一层只在单处使用的间接。
- **空 payload 用 `{}`**:`ENGINE_START` 之类没有字段,但类型上仍允许任意额外属性(除非再收紧)。

## 复查条件

1. **类型报错难以理解 / IDE 变慢**:退回显式联合,或给常用 tag 加显式别名
   (如 `type InboxOfferEvent = ArchiveEvent<"INBOX_OFFER">`)。
2. **需要运行时校验**:从 `ArchivePayloads` 生成 Schema 映射,而不是手写每个事件的 Schema。
3. **空 payload 需要严格**:把 `{}` 换成 `Record<never, never>` 或 `unknown` 的具体约束,
   避免额外属性混入。
4. **新增事件忘记更新订阅方**:用穷尽 switch(`never` 检查)兜底,而不是回到手写联合。
