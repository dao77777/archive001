# 决策:`run` 就是循环,消息只从 inbox 进

> 已接受 · 2026-10-24 · 取代 [`0009`](0009-inbox-loop.md) 里 `run` / inbox 的接口部分
> (三个实体与 inbox 结构不变)· **对外暴露部分已被 [`0013`](0013-agent-encapsulates-inbox.md) 取代**
> (Inbox 不再导出,客户端只调 `Agent.ask`)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0009 里循环虽然常驻了,但接口还是请求-应答的:

```ts
agent.run(input, settings, tools, observe?) => Effect<string, LlmError>
```

这留下两个别扭之处:

| 想要的                                         | 接口上的冲突                                                  |
| ---------------------------------------------- | ------------------------------------------------------------- |
| "引擎"和"给引擎喂消息"是两件事                 | `run` 同时是引擎、又是消息入口、又负责等回答                  |
| 循环的生命周期由调用方显式管理(何时起、何时停) | 引擎藏在 `Layer.effect` 的 `forkScoped` 里,起停只能靠关 scope |
| 状态机本身可以被单独阅读 / 测试                | 状态机、服务装配、请求-应答逻辑全在 `loop.ts`                 |

## 处理

- **状态机搬到 `loop/llm.ts`**,导出 `llmStateMachine(llm, inbox, executor): Effect<never>`
  (文件名/函数后来改成 `engine.ts` / `engine`,见 [`0059`](0059-loop-engine-rename.md));
  它只认识 inbox / Llm / executor,不认识 `Agent` 服务。
- **`AgentShape.run: Effect<never>`** —— 就是那个无限循环本身,没有参数;
  循环退出(中断 / 异常)时 `Inbox.close`,让还在等的 `ask` 立即失败。
- **消息只从 inbox 进**:
  - `Inbox.ask(input, settings, tools, observe?)` —— 塞 prompt 并等这一轮回答;
  - `Inbox.offer(message)` —— 只塞,不等回答;
  - tool result 由 executor 用 `offer` 写回。
- **`AgentLive` 只装配,不启动**:输出 `Agent | Inbox`(`provideMerge` 把 Inbox 暴露给客户端),
  引擎在调用方 fork `run` 时才跑。
- 生命周期归调用方:CLI / REPL / 测试用 `Effect.forkChild`(随父纤维结束),
  web 宿主用 `Effect.forkIn(会话 scope)`(reset = 关 scope = 引擎停)。

```ts
const agent = yield * Agent;
const inbox = yield * Inbox;
yield * agent.run.pipe(Effect.forkChild); // 启动引擎
const answer = yield * inbox.ask("…", settings, tools, observe);
```

## 为什么

- **一个 Effect = 一个职责**:`run` 只负责"一直转",`ask` 只负责"塞一条并等回答";
  谁起停引擎一目了然。
- **状态机可以脱离服务读**:`llm.ts` 是纯函数式装配(依赖作参数),测试可以直接给它假的
  inbox / executor / Llm,不需要建整个 `Agent` 层。
- **不再有隐藏纤维**:以前 `Layer.effect` 里 fork,建层就烧资源、关层才停;
  现在客户端明确持有 fork 返回的 fiber,能 `Fiber.interrupt`、能绑到自己的 scope。
- **inbox 成了唯一入口**:prompt / tool result 都走同一条队列,合并顺序与回答路由仍只有一处。

## 代价

- **客户端多一步**:忘了 fork `agent.run` 时,`ask` 会一直等(队列有人在收才有回答)。
  这不是类型能挡住的错误;只能在文档 / 客户端装配层保证。
- **"还没启动就被中断"没有清理**:中断一个尚未开始执行的纤维不会触发 `onExit`,
  inbox 不会被 close,已排队的 `ask` 可能挂住。测试里要 `Effect.yieldNow` 后再中断;
  真实客户端都是先启动、后 `ask`,不受影响。
- **`Inbox` 不再是纯队列**:它持有 `ask` 的 reply 与 `close` 信号,顺便管了请求-应答便利与
  引擎退出广播。"一个笨队列"的理想让位给了"一个能用的入口"。
- **SDK 面变大**:`AgentLive` 现在输出 `Agent | Inbox`,并额外导出 `Inbox` / `InboxShape` /
  `InboxMessage`;客户端要认识"先起引擎"这件事。
- **生命周期约定分散到各客户端**:REPL / CLI / smoke 用 `forkChild`,web 用 `forkIn(scope)`,
  没有统一的 `start/stop` 门面。

## 复查条件

1. **客户端反复忘记 fork `run` / 生命周期写错**:加一个显式的 `Agent.start`(返回带 scope 的
   handle)或 `Layer.scoped` 的 `AgentRuntime`,把"起引擎"收回到一个地方;本条随之 supersede。
2. **"中断在启动之前"变成真实场景**(比如 web 打开即 reset):把 close 的责任移到启动方
   (fork 后立即注册清理),或让 `run` 先把自己标记为已启动再进循环。
3. **回答需要多播 / 多条 prompt 需要各自路由**:引入事件流 + turn id,`ask` 退化成
   "订阅一次"的便利函数;此时 `Inbox` 应重新变回纯队列。
4. **`ask` 的语义开始变重**(超时、重试、取消):把它从 `Inbox` 挪到会话 / 客户端层,
   inbox 只保留 `offer` / `takeAll`。
