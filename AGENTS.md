# AGENTS.md — archive001(现状说明)

> 本文件描述**现在长什么样**、当前设计与已实测的事实。**没有硬规矩**:每条都只是"暂时这么做",
> 想改就改;改之前把代价写进 [`docs/decisions/`](docs/decisions/) 或对应的设计文档即可。

## 这是什么

一个会调工具的 agent,用的是 Effect v4 + Node 24 + Vite+(`vp`)。只接 DeepSeek。

| 包                                             | 角色                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/agent`(`@archive001/agent`)          | 内核:`llm/`(两条 wire)+ `loop/`(持续运行)+ `turn/`(一次完整 turn)+ 工具契约;只有 SDK 入口 `src/index.ts` |
| `packages/client/<名字>`(`@archive001/<名字>`) | 客户端:`repl`、`web`(React 19)、`cli`(一次性)可用;`tui` / `desktop` / `mobile` 是骨架                    |

依赖方向是**客户端 → `@archive001/agent`**。agent 目前不知道任何客户端存在;客户端之间互不依赖、
不共用表现层代码。

## 怎么跑

```bash
pnpm check      # 格式化 + lint + 类型(vp 按文件解析最近的 tsconfig)
pnpm typecheck  # 逐包 tsc --noEmit
pnpm test       # 单测(选路 + 两条 wire 各一组真 HTTP 打点)
pnpm build      # 各包 vp pack

# 真 key 冒烟(两轮带工具对话,验证回放契约)
sops exec-env ~/Code/_vault/env/secrets.enc.yaml 'pnpm smoke'
sops exec-env ~/Code/_vault/env/secrets.enc.yaml 'pnpm smoke max'   # 档位走参数,env 只读密钥
```

## 现状与已知事实

- **工具链是 `vp`**:`pnpm check / typecheck / test / build / fmt / lint`;配置在 `vite.config.ts` 与各包 `tsconfig.json`。
  `vp` 靠 **git 枚举文件**,项目对 `~/Code` 的 git 不可见时报「No files found」。
- **Effect 是 v4**,包已合并(`effect/http`、`effect/process`…);v3 的资料大多不适用。
- **回放契约**:`responses` 开思考时每个 `function_call` 前要有非空 `reasoning_text`;`chat` 每条 assistant 要带
  `reasoning_content`;既没正文也没工具调用的 assistant 整条丢弃 —— 否则 400 并毒死会话。
  实测与报文见 [`docs/designs/agent/llm.md`](docs/designs/agent/llm.md#回放契约)。
- **工具是 `Agent.configure` 的参数**:`agent.configure({ settings, tools })`。内置 `bash` / `read_file` / `write_file` /
  `list_dir` 在 `loop/builtin-tools/live.ts`(由 `AgentLive` 自己装配,客户端不 import),
  想要才传。自造工具用 `makeTool({...})`,参数写 Effect Schema(同时产出 JSON Schema 与运行时校验)。
- **`AgentRuntime` 需要 `Llm` + `Archive`**;**`AgentLive` 输出 `Agent | Turn | Archive`**
  (在 `@archive001/agent/live`,只给 Node 侧):
  archive 的事件写入是异步队列(`append` 只入队),
  文件 sink 在 `archive/sink/file.ts`;所有客户端共用一个 JSONL 文件(`~/.local/state/archive001/archive.jsonl`)。
- **archive 有 session 了**:每条 entry 带 `sessionId`(旧文件归 `LEGACY_SESSION_ID`);
  `Archive.currentSession` / `sessions` / `readSession(id)` / `startSession` / `useSession(id)`。
  `readAll` 返回所有会话;`projection("transcript" | "inbox")` 只读当前会话(其余状态先不做)。
  sink 有 `read`(构建时读一次底稿)。**缓存放在写队列之前**:`append` 立刻可读,
  `readAll` / `projection(kind)` 只碰内存(不会失败);投影状态在 **`Projection` 服务**里
  (`Archive.append` 推进它,`Archive.projection` 转发读口,`setSession` 按 session 重折),
  **engine 每步的 transcript 也从 `projection("transcript")` 拿**,本地不留副本。
  `configure` 的内容仍没有事件,增量读(`entries(fromLine)`)也还没做。
- **`Agent` 与 `Turn` 分开**:`Agent.run` 起引擎并交出句柄(`events` / `fiber` / `send` /
  `configure`),是持续运行;一次完整 turn 用 `Turn.runTurn(config, { text }, { onEvent? })`——
  它借 `Agent.run({ archive: makeTurnHook() })` 开一个 run,在 archive hook 上织入
  `TURN_*` / step 的 `parentId`,再订阅 / `send` / 等 `TURN_END`、最后中断 fiber 关掉这次 run。
  引擎只跑 step 循环;prompt id、turn 对齐、回答 / 错误收集都在 `turn/live.ts` 一份。
  要自己的超时 / 多播就留在 `run` 的持续模式里,自己 `send` + `events`。
  `Turn.runTurn` 每轮一个 run;transcript 在投影里**同一会话内跨 run 保留**,会话边界是 archive 的 `sessionId`。事件分**结构**
  (`ENGINE/TURN/STEP_START|END`)与**内容**(`INBOX_OFFER` 带完整消息(`id` + `payload`)、`INBOX_TAKE` 带引用、
  `USER_MESSAGE` / `ASSISTANT_MESSAGE` / `REASONING` / `FUNCTION_CALL` /
  `FUNCTION_CALL_OUTPUT`);错误是内容(`STEP_ERROR` / `TURN_ERROR` / `ENGINE_ERROR`;archive 挂了是顶层的 `ARCHIVE_ERROR`,不落盘)。
  `Turn.runTurn` 把最后一步的 `ASSISTANT_MESSAGE` 作为回答返回;自己折叠事件时按同样规则判断。
  `INBOX_OFFER − INBOX_TAKE` 可以还原 inbox。
  四个内部实体:`inbox.ts`(攒到"就位"再交出整批,自己发 `INBOX_OFFER` / `INBOX_TAKE`)、`engine.ts`
  (`Engine` 服务:只跑 step 循环,自持配置,transcript 每步从投影取,`configure` 换模型工具)、`tool-executor.ts`(顺序执行一批调用,结果写回 inbox)、
  `events.ts`(所有事件的唯一出口:archive 队列 + 实时流)。等工具时进来的新 prompt 会并进当前轮,并进 transcript 时
  **工具结果在前、prompt 在后**(`FUNCTION_CALL_OUTPUT` 必须紧跟 `FUNCTION_CALL`)。
  所有 `_tag` 大写,内容命名与 `Item` 对齐;代价与复查条件见
  [`docs/decisions/0026-uppercase-tags-items.md`](docs/decisions/0026-uppercase-tags-items.md)。
- **密钥从 `~/Code/_vault` 取**,用 `sops exec-env` 注入;内核与 llm 层不读环境变量,env → `LlmSettings` 在客户端那层做。
- **transcript 在投影里**:engine 每步从 `Archive.projection("transcript")` 拿,同一会话里**跨 run 保留**
  (`Turn.runTurn` 每轮关 run 也不丢);工具轮整批保留(含 `reasoning`,回放契约要求),纯问答轮不保留思维链。
  会话边界是 archive 的 `sessionId`(`Archive.startSession` / `useSession`),所以 web reset 开新会话;
  archive 事件仍全部留在 JSONL 里,`readAll` / `readSession` 能读回。
- **Web 客户端的密钥只在本地宿主**(`src/host/`,从 env 读),浏览器只发模型 / 档位;宿主目前只绑本机回环,
  因为工具没有审批。细节见 [`docs/designs/client/web/host.md`](docs/designs/client/web/host.md)。
- **REPL 的输入用 `node:readline/promises`**:effect 的 `Terminal.readLine` 实现给 TTY 开 raw mode 却不给
  `output`、也不回显,表现为"自己打的字自己看不见"(踩过)。

## 文档去哪

| 想知道                   | 看                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两层怎么设计             | [`docs/designs/agent/loop.md`](docs/designs/agent/loop.md) · [`docs/designs/agent/turn.md`](docs/designs/agent/turn.md) · [`docs/designs/agent/llm.md`](docs/designs/agent/llm.md) |
| 各实体怎么设计           | [`inbox.md`](docs/designs/agent/inbox.md) · [`tool-executor.md`](docs/designs/agent/tool-executor.md) · [`archive.md`](docs/designs/agent/archive.md)                              |
| 代码现在怎么写           | [`docs/designs/code-conventions.md`](docs/designs/code-conventions.md)                                                                                                             |
| DeepSeek 报文 / 回放实测 | [`docs/knowledge/deepseek-api.md`](docs/knowledge/deepseek-api.md)                                                                                                                 |
| 为什么这么定             | [`docs/decisions/`](docs/decisions/)                                                                                                                                               |
| 现在到哪了               | [`docs/progress/status.md`](docs/progress/status.md)                                                                                                                               |
