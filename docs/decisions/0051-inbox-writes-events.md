# 决策:inbox 自己写 `INBOX_OFFER` / `INBOX_TAKE`

> 已接受 · 2026-10-24 · 收紧 [`0050`](0050-inbox-take-ready.md) 的边界
> (`InboxBatch.takes` 与"状态机发 `INBOX_TAKE`"被取消)· 落点 `packages/agent/src/loop/` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md#内部实体)

## 矛盾

`INBOX_OFFER` / `INBOX_TAKE` 描述的是**同一条队列**,但写它们的是三个不同的地方:

| 事件          | 谁在写                    | 为什么在那                       |
| ------------- | ------------------------- | -------------------------------- |
| `INBOX_OFFER` | `Agent.send`(prompt)      | 它调的是 `inbox.offer`           |
| `INBOX_OFFER` | `tool-executor`(工具结果) | 同上                             |
| `INBOX_TAKE`  | `llm.ts` 状态机           | 它调的是 `takeAll` / `takeReady` |

于是:

- **同一类事件散在两处**:prompt 与 tool result 各自记得"入队前后要发事件",新入口再写一遍就是第三份;
- **`ToolBatch` 得多带一个 `publish`**:工具执行器明明只往 queue 里放东西,却要知道事件总线的存在;
- **`takeReady` 的返回值为了保住事件语义被撑开**:`{ messages, takes }`(0050)纯粹是为了让调用方
  替 inbox 发 `INBOX_TAKE`;
- **事件总线藏在 `AgentRuntime` 里**:inbox 想自己发事件也拿不到 `publish`,所以只能由状态机代劳。

## 处理

把事件出口抽成独立服务 `events.ts`(`Events`:`publish` + `stream`),让队列自己写队列的事件:

```ts
// inbox.ts
offer(message)     → publish(INBOX_OFFER { message }) → Queue.offer
takeReady(awaiting) → Queue.takeAll … → 每次出队 publish(INBOX_TAKE { messageIds }) → 交出消息数组
```

连带改动:

- `InboxLive` 依赖 `Events`;`ToolExecutorLive` 只依赖 `Inbox`;
- `ToolBatch` 去掉 `publish`(执行器不再认识事件);
- `Agent.send` 退化成一句 `inbox.offer({ _tag: "USER_MESSAGE", … })`;
- `llm.ts` 只发生命周期 / step 内容事件,不再发 `INBOX_TAKE`;
- `takeReady` 返回 `ReadonlyArray<InboxMessage>`,`InboxBatch` / `takes` 删除;
- `AgentRuntime` 只剩 config `Ref` 与装配;`bus` / `stopped` / `archiveFailure` / `queue 写入` 搬进 `EventsLive`。

## 为什么

- **事件跟着状态走**:入队和 `INBOX_OFFER`、出队和 `INBOX_TAKE` 各在同一处,不可能"放进去了但忘了发";
- **事件总线不再藏在 Agent 里**:谁都能 publish,`Agent` 退化成纯装配,不再替别人发事件;
- **执行器更笨**:它只认识 `inbox.offer`,`ToolBatch` 少一个字段,也就少一条"谁能改事件流"的路径;
- **`takeReady` 回到纯数据**:返回值就是这一批消息,不再夹带"怎么发事件"的信息。

## 代价

- **inbox 再"聪明"一级**:它现在依赖事件层,单测必须提供 `Events` 桩,不再能只测一个 `Queue`;
- **顺序约束变隐蔽**:`INBOX_OFFER` 在入队**之前**发(内容先到,投影看到事件就能拿到消息),
  这条约定现在写在 `inbox.ts` 的注释里,而不是调用方那行 `publish` 之后;
- **多一层服务**:`Events` 多一个 Tag / 一个 Layer,`AgentLive` 的 provide 链多一层;
- **事件身份更分散**:`INBOX_*` 由 inbox 发、生命周期由状态机发、`ARCHIVE_ERROR` 由总线自己发,
  排查时要记住这三处的分工(设计文档里有表)。

## 复查条件

1. **出现第二个需要发事件的地方**(比如工具执行进度、取消信号):往 `Events.publish` 上加,
   不要给某个实体自建总线;若"谁发什么"开始说不清,在设计文档里补一张表而不是靠约定。
2. **需要 `INBOX_HOLD` 这类"已出队未消费"的事件**:先判断它描述的是不是队列本身 —— 是就继续放 inbox,
   不是(比如"state 机取了但没用")就放状态机。
3. **事件要拆成两个出口**(archive 与实时流投递保证不同):拆 `Events` 为两个服务,不要在每个实体里分叉。
4. **又想让 `takeReady` 报出"哪几次出队"**:不要把 `takes` 加回返回值,让 inbox 自己发事件;
   真需要批量语义时,改成"一次就位 = 一条 `INBOX_TAKE`",并在决策里写清客户端如何对齐。
