# 决策:Agent 封装 inbox,客户端只认识 Agent

> 已接受 · 2026-10-24 · 取代 [`0010`](0010-run-is-the-loop.md) 的对外暴露部分
> (inbox 常驻循环、`run` 无限循环都不变)· **`ask` 暴露部分已被 [`0014`](0014-agent-events-and-config.md) 取代**
> (Agent 仍封装 inbox,但不再提供 `ask`)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0010 把 `Inbox` 做成了公开服务:`AgentLive` 输出 `Agent | Inbox`,客户端要同时拿两个东西:

```ts
const agent = yield* Agent;
const inbox = yield* Inbox;
yield* agent.run.pipe(Effect.forkChild);
const answer = yield* inbox.ask(…);
```

问题:

| 问题                    | 说明                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| 泄漏实现细节            | inbox 是内部交接面;客户端不该知道"消息先进队列再被引擎取走"        |
| 两个入口                | 起引擎找 `Agent`,塞消息找 `Inbox`;调用方要自己配对                 |
| SDK 面变大              | 多导出 `Inbox` / `InboxShape` / `InboxMessage`,以后换 archive 更难 |
| 外部可以绕过 Agent 语义 | 拿到 `Inbox.offer` 就能塞任意内部消息,破坏"Agent 是唯一门面"       |

## 处理

- `AgentShape` 增加 `ask`,和 `run` 一起构成**唯一对外接口**:
  ```ts
  interface AgentShape {
    readonly run: Effect.Effect<never>; // 引擎
    readonly ask: (input, settings, tools, observe?) => Effect<string, LlmError>;
  }
  ```
- `Agent.ask` 内部直接转发 `inbox.ask`(即"拿到 inbox 的 offer + 等回答"),客户端不接触 inbox。
- `AgentLive` 用 `Layer.provide(InboxLive)`(**不是 `provideMerge`**),输出只有 `Agent`。
- SDK 不再导出 `Inbox` / `InboxShape` / `InboxMessage`;`inbox.ts` 仍存在,但只由 `AgentLive` 装配。
- 客户端统一改成 `agent.ask(...)`;`run` 的生命周期约定不变(CLI/REPL/测试 `forkChild`,
  web `forkIn(会话 scope)`)。

## 为什么

- **一个门面**:外部只感知 `Agent`;起引擎、塞消息、拿回答都在同一个对象上。
- **可替换**:inbox 以后可能被 archive / 投影取代,客户端签名不变。
- **少一层误用**:外部拿不到 `offer` / `takeAll`,就不会绕过状态机直接改队列。
- **事件仍按 ask 分发**:`observe` 留在 `Agent.ask` 上,行为和以前一致,不用引入全局事件流。

## 代价

- **Agent 变胖**:`run`(生命周期)+ `ask`(请求-应答)放在一起;以后若再加 `send` / `events`,
  可能该拆成 `Agent` + `Session` 两层。
- **没有全局事件订阅**:事件只发给当次 `ask` 的 `observe`;多个观察者(UI + 日志 + 归档)
  要各自拿一份就得改接口。
- **`ask` 仍依赖"先 fork `run`"**:忘了启动引擎时它还是会等;封装没有消除这个时序约定。

## 复查条件

1. **需要多个事件消费者 / 断线重放**:给 `Agent` 加 `events: Stream<AgentEvent>`(或 PubSub),
   `ask` 的 `observe` 退化成便利参数;那时考虑把 `Agent` 拆成 `Agent`(引擎)+ `Session`(对话)。
2. **archive 落地**:`ask` 改成"append `prompt_received` + 等 `turn_finished` 投影",
   客户端签名仍然不变 —— 这是本决策的主要收益。
3. **外部确实需要塞非 prompt 消息**(比如注入工具结果做测试):再暴露一个受限的
   `Agent.inject(...)`,而不是把整个 inbox 放出去。
4. **`Agent` 的方法继续膨胀**:按 `run`(生命周期)/ `ask`(对话)拆服务,保持每个服务一组内聚方法。
