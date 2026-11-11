# 决策:runTurn 与 run 平级;transcript 按会话跨 run 保留

> 已接受 · 2026-11-09 · 调整 [`0082`](0082-run-turn-on-loop.md) 的 API 位置 ·
> 取代 [`0078`](0078-projection-transcript-and-inbox-only.md) 的「`ENGINE_START` 清空 transcript」·
> 落点 `packages/agent/src/loop/` + `archive/projection/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md) · [`../designs/agent/archive.md`](../designs/agent/archive.md)
> **API 位置再次调整:见 [`0084`](0084-turn-service.md)**;`Agent` 只留持续运行。
> **会话边界已被 [`0086`](0086-archive-sessions.md) 取代**:从层实例改为 archive 里的 `sessionId`。

## 矛盾

0082 把 `runTurn` 放在 `run` 交出的句柄上。调用方仍然要先 `run`、再 `configure`、再 `runTurn`——
对"只跑一轮"的 CLI / smoke / 测试来说,生命周期是多余的。两个入口应该平级:

```ts
agent.runTurn(config, input, options?)   // 一轮 = 一次调用,结束就关
agent.run(...)                           // 常驻,自己管理
```

但顶层 `runTurn` 每轮关 run 会撞上一条旧规则:`ProjectionLive` 在 `ENGINE_START` 时清空
`transcript`(0078 的「新的一段从头记」)。于是下一轮即使 `archive` 里还有上一轮的问答,
引擎也看不到——不是换了 archive,是投影把 transcript 主动丢了。

## 处理

- **顶层入口**:`LoopShape.runTurn(config, input, options?)`。
  它自己 `run` → `configure` → 订阅 `events` / `send` / 等 `TURN_END` →
  `ensuring(Fiber.interrupt(fiber))`;失败 / 被取消也会关掉这次 run。
- **`run` 的句柄不带解析助手**:只有 `events` / `fiber` / `send` / `configure`。
  持续运行(以 step 为循环)的调用方自己订阅 `events` 对齐 turn;两种模式就是
  「一次完整 turn」和「持续 run」。
- **transcript 的作用域从 run 提到会话(层实例)**:
  - `ENGINE_START` 不再清 transcript,只清掉未闭合的 step;
  - 新增 `Projection.resetTranscript`(只清 transcript,不动 inbox / 待折队列);
    `ArchiveRuntime` 构建时调用一次——**新层 = 新会话**;
  - `archive` 仍保留全部事件,`readAll` 可以读回;投影的 transcript 不自动跨会话恢复。
- **`Events.begin`**:`Loop.run` 在 fork 引擎前清掉上一次 `ENGINE_END` 的回放。
  否则新一轮的订阅者会先收到旧终点,当场结束。

## 为什么

- **调用方不用管生命周期**:一轮一个 run,成功 / 失败 / 取消都会关;不会留下无限循环。
- **多轮记忆还在**:同一层里第 2 次 `runTurn` 起的新 run 从投影读到第 1 轮的 transcript。
- **会话边界明确**:层实例。web reset / 新进程 = 新层 = `resetTranscript`;不是靠 `ENGINE_START`
  顺手清掉。
- **协议不变**:事件 schema、engine、inbox 都没改;只调整 transcript 的折叠边界和 events 的回放清理。

## 代价

- **`ENGINE_START` 不再是会话边界**:直接读事件的人若以为它会清历史,会意外;会话开始看
  `resetTranscript`(或层实例)。
- **transcript 不跨层恢复**:和改动前实际行为一致(以前 `ENGINE_START` 也会清),但文档里
  「archive 能恢复 transcript」的说法要收窄成「`readAll` 能读回事件;投影不跨会话续」。
- **每轮一个 run**:引擎每轮发 `ENGINE_START` / `ENGINE_END`,多了一点启动 / 收尾事件与调度成本。
- **顶层 `runTurn` 的 `onEvent` 看不到自己这轮的 `ENGINE_END`**:订阅在 `TURN_END` 停止,
  引擎关闭发生在返回之后;要看完整 run 边界就用 `run` 句柄。
- **取消语义变强**:web 浏览器断开 = 中断 `runTurn` → 关掉本轮 run(以前引擎会继续跑完)。
- **同一个 Loop 实例并发 `runTurn` 会互相干扰**:仍然按「一个实例只跑一个」的约定用。

## 复查条件

1. **需要流式 / 半开 / 自己控制等待的 run**:用 `run` 的句柄自己订阅 `events`;不要给顶层
   `runTurn` 加模式开关,也不要重新往句柄上挂解析助手。
2. **需要跨层恢复 transcript**:引入会话 id 或 resume,明确「从哪份 archive 的哪一段续」;
   不要复用 `resetTranscript` 假装恢复。
3. **需要多端并发**:每端独立层实例;共享 archive 时 transcript 仍按层隔离。
4. **会话边界改成文件 / 进程**:改 `ArchiveRuntime` 里 `resetTranscript` 的调用点,并重写
   [`../designs/agent/archive.md`](../designs/agent/archive.md) 的读侧说明。
