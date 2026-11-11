# 设计:Turn(一次完整的 runTurn)

> 路径 `packages/agent/src/turn/`。持续运行的循环见 [`loop.md`](loop.md);
> 依赖方向 `Turn → Agent(Loop)`。

## 职责

把「起 run → 配参数 → 订阅事件 → 发 prompt → 等这一轮结束 → 关 run」包成一次调用。
它也是**唯一知道 turn 的地方**:引擎只跑 step 循环,turn 的开始 / 结束 / 错误由 Turn 通过
`Loop.run({ archive })` 的 hook 织进事件流。

```ts
const turn = yield * Turn;
const answer =
  yield *
  turn.runTurn(
    { settings, tools: Option.none() },
    { text: "列一下当前目录" },
    { onEvent: render }, // 可省
  );
```

| 文件              | 内容                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `turn/service.ts` | `TurnShape` + `Turn` Tag、`TurnInput` / `TurnOptions`                  |
| `turn/live.ts`    | `TurnLive`、`makeTurnHook`(turn 事件)、`parseTurn`(这一轮的解析与收尾) |

## 数据流

```
Turn.runTurn(config, input, options?)
  └─► Loop.run({ archive: makeTurnHook() }) ──► configure(config)
        ├─► 订阅 handle.events
        ├─► handle.send({ id, text })
        ├─► 等这一轮的 TURN_END
        └─► ensuring(Fiber.interrupt(handle.fiber))   // 失败 / 取消也关
```

引擎发的是纯 step 事件(`STEP_START` / 内容 / `STEP_END` / `STEP_ERROR`),没有 `TURN_*`,
也没有 turn 的 `parentId`。`makeTurnHook` 在 `Events.publish` 写入 archive 之前改写这一批条目:

| 引擎事件        | hook 补的东西                                                              |
| --------------- | -------------------------------------------------------------------------- |
| `STEP_START`    | 没有开着的轮就先插 `TURN_START`;给 step 挂上 `parentId = turnId`           |
| `FUNCTION_CALL` | 记下这一步有工具调用(有调用的 step 只是这一轮的中间步)                     |
| `STEP_ERROR`    | 记下错误内容                                                               |
| `STEP_END`      | 挂上 `parentId`;若这一步没有调用或出错,补 `TURN_ERROR`(出错时)/ `TURN_END` |
| `ENGINE_ERROR`  | 若还有开着的轮,补 `TURN_ERROR` + `TURN_END` 再放行                         |
| `ENGINE_END`    | 若还有开着的轮,补 `TURN_END` 再放行                                        |

`parseTurn` 只在这里一份:

1. 生成 prompt id,先订阅 `events` 再 `send`;
2. `INBOX_TAKE` 里出现自己的 id → 有开着的轮就并进去,否则等 `TURN_START` 认领;
3. `USER_MESSAGE` 的 `inboxId` 再校准一次所属轮(用 `STEP_START.parentId`);
4. 每个 `STEP_START` 清空回答;`ASSISTANT_MESSAGE` 逐条追加 → 最后一步的正文就是回答;
5. `STEP_ERROR` / `TURN_ERROR` / `ENGINE_ERROR` 按 `parentId` 归属到这一轮;
6. 等到自己这一轮的 `TURN_END`(或 `ENGINE_END`)收尾,失败转成 `LlmError`。

`onEvent` 只是旁路转发,不参与解析;回调抛异常会让这一轮以 `LlmError` 收尾(引擎会继续跑完
当前事件,随后被关闭)。`Turn.runTurn` 的 `onEvent` **看不到自己这轮的 `ENGINE_END`**:
订阅在 `TURN_END` 停止,关 run 发生在返回之后。

## 两种运行模式

| 模式      | 入口           | 行为                                                    |
| --------- | -------------- | ------------------------------------------------------- |
| 一次 turn | `Turn.runTurn` | 自己开 run、挂 turn hook、解析事件、关 run;调用方拿回答 |
| 持续运行  | `Agent.run`    | 只跑 step 循环;调用方自己 `send` / 订阅 `events` / 停   |

持续运行模式**没有 turn 语义**:引擎只发 `STEP_*`,不会发 `TURN_*`。要拿"一轮的回答",
要么用 `Turn.runTurn`,要么自己按 step 事件对齐 / 收尾;`Turn` 的 `makeTurnHook` 是这套规则
在 turn 层的实现。

## 与 transcript 的关系

`Turn` 每轮关 run,但 transcript 在投影里**同一会话内跨 run 保留**;会话边界是 archive 的
`sessionId`(`Archive.startSession` 开新会话、`useSession` 切)。所以同一会话的第 2 次
`runTurn` 仍带着第 1 轮的历史;web reset 开新会话。细节见
[`archive.md`](archive.md#能从-archive-恢复什么读侧)。

## 暂未做

- 流式输出 / 超时 / 重试:要这些就在持续运行模式里自己订阅事件并套策略;
- 取消传播:`Turn.runTurn` 被中断会关掉本轮 run,但工具执行器是否立即停取决于它自己的中断语义;
- 会话列表 / 切换 UI(底层已有 `Archive.sessions` / `useSession`)。

## 为什么单独一层

- **引擎只感知 step**:`Engine` 不知道 turn,循环更简单;
- **turn 逻辑只有一个主人**:`makeTurnHook` + `parseTurn` 都在 `turn/`,由唯一的使用者拥有;
- **Loop 只提供机制**:archive hook 是插槽,`Turn` 是往插槽里放策略的那一层;
- **依赖单向**:`Turn → Agent.run`,没有循环导入。
