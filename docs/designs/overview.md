# 设计:跨包结构

> 设计按**包**分:内核 [`agent/loop.md`](agent/loop.md) · [`agent/turn.md`](agent/turn.md) · [`agent/llm.md`](agent/llm.md);
> 客户端 [`client/web/ui.md`](client/web/ui.md);全仓规范 [`code-conventions.md`](code-conventions.md)。

## 包与依赖

```
packages/agent          @archive001/agent    内核:只有 SDK(src/index.ts),无入口程序
packages/client/cli     @archive001/cli      ✅ 可用(一次性:跑一个 prompt 就退出)
packages/client/repl    @archive001/repl     ✅ 可用
packages/client/tui     @archive001/tui      骨架
packages/client/web     @archive001/web      ✅ 可用(浏览器 UI + 本地宿主 `src/host/`)
packages/client/desktop @archive001/desktop  骨架(外壳未定,无 build)
packages/client/mobile  @archive001/mobile   骨架(构建链未定,无 build)
```

```
客户端包 ──imports──► @archive001/agent(SDK)
```

现状:**依赖是客户端 → 内核**。内核不知道客户端存在;客户端之间不互相依赖、不共用表现层代码 ——
共用的只有 SDK。

## 内核分层

```
Turn(一次完整 runTurn) ──► Agent.run({ archive: hook })
Agent(step 循环) ──► Llm(选 wire) ──┬─► responses.ts        (主路径)
       │                            └─► chat-completions.ts  (兼容)
       ├─► Inbox(Queue)：prompt / tool result 的唯一入口
       └─► ToolExecutor(常驻 worker) ──► Inbox
                 └─► Tool 数组(随 prompt 进 inbox)──► BuiltinTools(可选)
```

`Agent.run` **就是常驻的 step 循环**:调用方 `run` 拿到句柄,消息通过 `send` 进(inbox 是内部实现);
一次完整的 turn 由独立的 `Turn` 服务提供——`Turn.runTurn` 借 `Agent.run({ archive: hook })` 起一个 run,
在 archive hook 上织入 `TURN_*` / step 的 `parentId`,解析事件、跑完关掉。解析只在 `Turn` 里;
transcript 按 archive 的会话(`sessionId`)跨 run 保留。要用自己的等待策略仍可 `Agent.run` + `send` + `events` 绕过。
三个实体与状态机见 [`agent/loop.md`](agent/loop.md),archive 写入见
[`agent/archive.md`](agent/archive.md)。

- `src/index.ts` 是 SDK 边界:只转发服务 / 类型 / 缺省值与助手。
- 设置只有一份:`LlmSettings` = 密钥(必填)+ 模型 / 档位 / 端点(可选,缺省在 `llm/_constants.ts`),
  **通过 `Agent.configure`** 设置;没有全局配置服务。
- ⚠️ **SDK 不读环境变量**:env → `LlmSettings` 在客户端那层做(cli 在 `client/cli/src/main.ts`,
  REPL 在 `client/repl/src/_env.ts`)。内核只认传进来的设置。
- 依赖图装配是**客户端**的事:各包自己的 `src/app.ts` / `src/main.ts`;内核只被 `provide`,不认识任何入口。

## 每层三件套

| 目录                 | `_constants.ts`        | `_domain.ts`                            | `_util.ts`                        |
| -------------------- | ---------------------- | --------------------------------------- | --------------------------------- |
| `packages/agent/src` | env 名                 | (无:`LlmSettings` 在 `llm/_domain.ts`)  | `formatError`                     |
| `.../agent/loop`     | (无:常量跟着各服务走)  | (无:类型跟着各服务的 `service.ts` 走)   | ——                                |
| `.../agent/llm`      | 厂商名、端点、缺省参数 | 全部类型(含 `LlmSettings`)/ wire Schema | item 助手 / HTTP / 解码           |
| `packages/repl/src`  | ANSI、预览尺寸、提示符 | (无)                                    | `paint` / `firstLines` / 参数预览 |

不含业务逻辑;`index.ts` 只转发。规范细节见 [`code-conventions.md`](code-conventions.md)。
