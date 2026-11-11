# 决策:Engine 只跑 step;Turn 通过 archive hook 织入 turn

> 已接受 · 2026-11-10 · 落点 `packages/agent/src/loop/` + `turn/` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md) ·
> [`../designs/agent/turn.md`](../designs/agent/turn.md)

## 矛盾

0084 把 `runTurn` 拆成了 `Turn` 服务,但 `Engine` 里还留着 turn 的状态与边界:

| Engine 里的东西                         | 其实属于谁 |
| --------------------------------------- | ---------- |
| `turnIdRef` / `startTurn` / `endTurn`   | turn       |
| `failTurn`(turn.error + turn.end)       | turn       |
| `STEP_START` / `STEP_END` 的 `parentId` | turn       |
| 无工具调用 ⇒ 结束这一轮                 | turn       |

引擎真正要做的只有 step 循环:消费一批就位消息 → 一次模型调用 = 一个 step → 有工具调用就
派给 executor,没有就等下一批。turn 只是 step 的分组 / 收尾语义。

## 处理

- **Engine 只发 step 事件**:
  - `STEP_START` / `STEP_END` / `STEP_ERROR` 以及 step 里的内容事件;
  - 不再发 `TURN_*`,也不再给 step 挂 `parentId`;
  - 无工具调用时只 `endStep`,不再 `endTurn`。
- **Loop 暴露 archive hook**:

  ```ts
  Agent.run({ archive?: EventHook }): Effect<AgentRun>
  ```

  `EventHook = (entry: ArchiveEntry) => Effect<ReadonlyArray<ArchiveEntry>>`。
  `Events.publish` 写入 archive / 实时流之前先过 hook;hook 可以插入、改写、丢弃条目。
  不传 hook 时原样写入。

- **Turn 是 hook 的唯一使用者**:
  - `makeTurnHook()` 维护 turn 状态:
    - `STEP_START` 前没有开着的轮 → 插 `TURN_START`,并给 step 挂 `parentId`;
    - `FUNCTION_CALL` → 记下这一步有调用;
    - `STEP_ERROR` → 记下错误;
    - `STEP_END` → 没有调用或出错时补 `TURN_ERROR`(出错)/ `TURN_END`;
    - `ENGINE_ERROR` / `ENGINE_END` → 还有开着的轮就补 turn 的终点;
  - `Turn.runTurn` 用 `loop.run({ archive: makeTurnHook() })`;
  - `parseTurn` 仍按事件解析这一轮(规则不变)。

## 为什么

- **层级清楚**:Engine 只回答"step 怎么跑",Turn 只回答"turn 怎么开始 / 结束";
- **引擎更小**:去掉 turnId / startTurn / endTurn / failTurn,step 循环只有 step 一个状态;
- **机制与策略分开**:Loop 提供 archive hook 这个机制,Turn 提供 turn 策略;
- **事件仍是 archive 里的完整形状**:hook 在写入前织入,投影 / 客户端看到的层级不变。

## 代价

- **`TURN_*` 不再由引擎直接发**:不挂 hook 的 `run` 只有 `STEP_*`;持续运行的调用方要么用
  `Turn`,要么自己实现一份 turn hook / 事件解析;
- **事件顺序依赖 hook**:turn 的 `parentId`、`TURN_ERROR` 的位置都由 hook 决定,调试时要同时看
  `turn/live.ts`;
- **hook 权力很大**:可以改写任意事件;目前只允许 `Turn` 使用,将来多个使用者要先定义组合规则;
- **hook 状态是闭包里的普通变量**:step 事件由引擎单纤维顺序发;如果将来多纤维发 step 事件,
  要改成 `Ref`;
- **`Loop.run` 从 `Effect` 变成函数**:所有调用点要改成 `run()` / `run({ archive })`。

## 复查条件

1. **hook 需要组合 / 多个消费者**(日志、脱敏、指标):把单个 hook 改成有序 hook 列表,
   明确"能不能改写 / 只能观察"。
2. **hook 需要直接访问 archive / 服务**:现在只给它 `ArchiveEntry`;要更多能力时先定接口,
   不要让它 import `Archive`。
3. **持续运行客户端需要 turn 语义**:复用 `Turn` 的 hook 工厂,或给 `Loop` 提供"默认 turn hook"
   选项;不要把 turn 逻辑搬回 Engine。
4. **Engine 需要靠 turn 决定行为**(例如按轮限流 / 预算):那说明 turn 边界上升为状态机的一部分,
   重新讨论 `Engine` 与 `Turn` 的边界。
