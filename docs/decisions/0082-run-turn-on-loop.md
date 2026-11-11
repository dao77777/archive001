# 决策:runTurn 回到 Loop,一轮的解析只留一份

> 已接受 · 2026-11-09 · 部分取代 [`0014`](0014-agent-events-and-config.md) 的「ask 由客户端实现」
> · 落点 `packages/agent/src/loop/` · 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md)
> **API 位置由 [`0083`](0083-run-turn-top-level-and-session-transcript.md) 调整**;
> **最终位置见 [`0084`](0084-turn-service.md)**:`runTurn` 独立成 `Turn` 服务,
> 解析仍只留这份。

## 矛盾

0014 把 `ask` 移出内核,理由是「怎么等一轮回答」属于客户端策略。代价是每个客户端都要自己写一份
同构的 `runTurn`:

| 位置                             | 做法                                           |
| -------------------------------- | ---------------------------------------------- |
| `client/cli/src/_turn.ts`        | 订阅事件、按 promptId 对齐 turn、收回答 / 错误 |
| `client/repl/src/_turn.ts`       | 同上(与 CLI 一字不差)                          |
| `client/web/src/host/session.ts` | 同构,但把事件转成 NDJSON,并额外做表现层裁剪    |
| `loop/live.test.ts`              | 测试里还有一份 `ask`,只为验证引擎行为          |
| `client/repl/scripts/smoke.ts`   | 用 REPL 那份                                   |

0014 的复查条件 1 已经预告了这件事:「`ask` 的重复实现开始漂移」。现在实际已经有 5 份,改一次事件
协议要同步改多处,而且 web 那份已经是变体。

`send` + `events` 仍然应该是底层协议,但不该让每个客户端都重新实现一遍「怎么认自己这一轮」。

## 处理

- `LoopRun` 增加一个方法:

  ```ts
  readonly runTurn: (
    input: TurnInput,
    options?: TurnOptions,
  ) => Effect.Effect<string, LlmError>;
  ```

  - prompt id 由 `runTurn` 自己生成,调用方不再传;
  - 订阅 `events` → `send` → 等这一轮的 `TURN_END` → 返回最后一步的正文;
  - `onEvent` 只是旁路转发,不参与解析;
  - 模型 / 引擎错误转成 `LlmError`。

- **解析逻辑只在 `loop/live.ts` 一份**:`INBOX_TAKE` / `USER_MESSAGE` 对齐 turn、按 `parentId`
  归属 `STEP_ERROR` / `TURN_ERROR` / `ENGINE_ERROR`、每个 `STEP_START` 清空回答、取最后一步正文。

- `send` / `events` **保留**:要超时、取消、多播、自己关联 id 的调用方仍然可以绕过 `runTurn`。

- 客户端只留表现层:
  - CLI / REPL 删除 `_turn.ts`,直接把渲染器交给 `onEvent`;
  - smoke 直接用 `session.runTurn`;
  - web 宿主保留「工具步的宣告要显示、最终回答由 ANSWER 行显示」的裁剪,但不再解析 turn。

## 为什么

- **一份解析**:事件协议 / 回放语义变化时只改内核,不追着五个客户端跑。
- **客户端入口变小**:客户端只剩三件事——设置从哪来、事件怎么画、回答怎么输出。
- **不改变协议**:`runTurn` 是 `events` 上的助手,不是新的请求-应答通道;引擎、事件 schema、
  inbox 都保持原样。
- **测试直接测公开面**:测试不再模拟客户端,`runTurn` 自己就是被测对象。

## 代价

- **内核重新知道「怎么等一轮」**:0014 当年正是为了避开这个。现在 `runTurn` 的默认策略
  (无超时、等 `TURN_END`、最后一步正文)成为事实标准;换策略要显式绕过。
- **prompt id 不可指定**:要按自己的 id 做外部关联 / 多端日志,仍得用 `send` + `events`。
- **`onEvent` 的异常会变成这一轮的 `LlmError`**:解析器不会替调用方吞掉渲染错误,但也不会让
  引擎停掉;调用方要保证回调本身不抛。
- **同一轮并进来的 prompt 共享 `TURN_END`**:两个 `runTurn` 都会拿到同一份回答——与以前各客户端
  自己实现时的行为一致,现在由内核明确约定。

## 复查条件

1. **需要按客户端设置等待策略**(超时、重试、取消、多播):把 `runTurn` 挪到
   `@archive001/agent/client` 这样的纯助手,或给 `TurnOptions` 加策略;不要再往 `Agent` 上堆。
2. **需要按外部 id 关联一轮**:给 `TurnInput` 加可选 id,或回到 `send` + `events`。
3. **「最后一步的正文」不足以表达回答**(流式 / 多段结构):让 `runTurn` 返回结构化结果,
   或导出折叠助手;不要把渲染塞进内核。
4. **各客户端开始需要不同的 turn 裁剪**:那是表现层,抽客户端共享的渲染助手,不要改内核解析。
