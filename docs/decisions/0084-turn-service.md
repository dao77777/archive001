# 决策:runTurn 独立成 `Turn` 服务,Agent 只留持续运行

> 已接受 · 2026-11-10 · 取代 [`0083`](0083-run-turn-top-level-and-session-transcript.md) 里
> 「`runTurn` 挂在 `LoopShape` 上」的 API 位置 · 落点 `packages/agent/src/turn/` ·
> 设计见 [`../designs/agent/turn.md`](../designs/agent/turn.md)
> **Engine 进一步只跑 step、turn 由 archive hook 织入:见 [`0085`](0085-engine-step-only-turn-hook.md)。**

## 矛盾

0083 把 `runTurn` 和 `run` 并排放在 `Agent` 上。两个问题:

| 问题                       | 说明                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| 两种运行模式挤在一个服务里 | `run` 是持续运行的引擎;`runTurn` 是"起一个 run、跑一轮、关掉"的用例层           |
| `run` 的手柄责任不清       | 句柄本来只要 `events` / `fiber` / `send` / `configure`,却还要知道"怎么解析一轮" |
| 解析实现的位置跟着 API 走  | 解析属于一次完整 turn,不属于常驻循环                                            |

## 处理

新增 `turn/` 目录,单独一个服务:

```
turn/service.ts   TurnShape + Turn Tag + TurnInput / TurnOptions
turn/live.ts      TurnLive:借 Loop.run 起 run → configure → parseTurn → ensuring 关 run
```

- **`Agent`(内部的 `Loop`)只剩持续运行**:`LoopShape` 只有 `run`,句柄只有
  `events` / `fiber` / `send` / `configure`;
- **`Turn` 是一次完整 turn 的唯一入口**:`Turn.runTurn(config, input, options?)` 自己开 run、
  订阅 `events`、`send`、等 `TURN_END`、`ensuring(Fiber.interrupt(fiber))`;
- **依赖方向** `Turn → Loop`;`Loop` 不认识 `Turn`,没有循环导入;
- **`AgentLive` 输出 `Loop | Turn`**,SDK 导出 `Turn` / `TurnLive` / `TurnInput` / `TurnOptions` /
  `TurnShape`;客户端 `yield* Turn` 后调 `runTurn`;
- 持续运行模式不提供解析助手:要自己收一轮,就按 [`turn.md`](../designs/agent/turn.md) 的规则
  自己订阅事件(测试里的 `ask` 是示例)。

## 为什么

- **一个服务一个模式**:`Agent` 只回答"引擎怎么一直转",`Turn` 只回答"一轮怎么开始和结束";
- **句柄变薄**:`run` 不再携带请求-应答策略,持续运行的调用方看到的能力就是它真正需要的;
- **解析只有一份且位置正确**:`parseTurn` 在 `turn/live.ts`,由唯一的使用者拥有;
- **装配仍然简单**:`AgentLive` 把 `TurnLive` 一起 provide,客户端拿到的还是"一个 AppLive";
- **测试边界清楚**:持续模式测 `run` + 事件,顶层模式测 `Turn.runTurn`。

## 代价

- **多一个服务 Tag**:客户端要 `yield* Turn`,自定义装配要记得 provide `TurnLive`;
- **`Agent` 不再有 `runTurn`**:0082/0083 的调用点全部改成 `Turn.runTurn`,SDK 是破坏性变化;
- **`AgentLive` 输出两个服务**:类型从 `Layer<Loop>` 变成 `Layer<Loop | Turn>`;
- **`TurnLive` 依赖 `Loop`**:单独用 `TurnLive` 时必须自己给 `Loop`;`AgentLive` 已经处理好;
- **持续模式没有便捷解析**:客户端要自己写一段与 `parseTurn` 同构的订阅逻辑(或只用 `onEvent` 观察)。

## 复查条件

1. **`Turn` 开始需要流式 / 超时 / 重试等策略**:在 `Turn` 上加选项或拆成多个 turn 策略;
   不要把策略塞回 `Agent`。
2. **多个客户端需要不同的 turn 语义**:抽 `@archive001/agent/turn` 的纯助手,或让 `Turn` 只做
   最小公共部分。
3. **`AgentLive` 的装配变复杂**:把 `TurnLive` 拆成可选层,由客户端显式合并;
   现在它只是 `Layer.merge(LoopLive, TurnLive.pipe(Layer.provide(LoopLive)))`。
4. **需要跨层恢复 / 多端会话**:那是会话层,不要塞进 `Turn`。
