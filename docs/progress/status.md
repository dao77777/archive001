# 状态:archive001

> 快照,覆盖更新;历史见 [`../logs/`](../logs/)。更新于 2026-11-09。

## 到哪了

**可用,真 key 验证过。** 内核 `@archive001/agent`(只有 SDK)+ 客户端群 `packages/client/`
(repl / web / cli 可用,tui / desktop / mobile 是骨架)。Web 客户端有**本地宿主**(`effect/http` 写的):
浏览器只画,模型调用与内置工具在 Node 里跑,密钥不进浏览器;dev 期页面归 Vite、`/api` 走代理。

| 项                    | 证据                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| 门禁                  | `pnpm check` ✅ 格式 + lint + 类型 / `pnpm typecheck` ✅ 6 包 0 错 / `pnpm test` ✅ 11 文件 98 用例 |
| 构建                  | `pnpm build` ✅ agent(index/cli)+ repl + tui + web(desktop/mobile 无 build,按设计跳过)              |
| 两条 wire(mock)       | 请求形状 + 解析各一组真 HTTP 打点                                                                   |
| **两条 wire(真 key)** | `pnpm smoke` 跑通多轮工具对话(`deepseek-flash`,low / off 两档)                                      |

## 能力

- **SDK**:`@archive001/agent` 导出服务 / 类型 / 缺省值与助手;**CLI**:一次性跑 prompt(文本 / NDJSON)
- **Web 会话列表**:`GET /api/sessions` 读 archive 里的会话;`POST /api/sessions/open` 切换;
  浏览器「会话」弹层展示标题 / 条数 / 最后活动时间,并用历史条目重建消息流;「新会话」走 `startSession`
- **archive**:事件异步入队后由 worker 写 JSONL(`append` 只保证入队,`flush` 为屏障);
  读侧:`Archive.readAll`(所有会话)/ `readSession(id)` / `currentSession` / `sessions` /
  `startSession` / `useSession(id)` + `Archive.projection("transcript" | "inbox")`(转发给 `Projection` 服务;
  其余状态先不做);`Projection` 自持折叠状态、由 `Archive.append` 推进、读时才折,
  折叠、状态、读取都在 `ProjectionLive` 内部,外面只有 `init`(构建时全量折叠)/ `advance`(只入队)/
  `setSession`(按 session 重折)/ `get`。缓存放在
  **写队列之前**(`append` 立刻可读,构建时从 sink 读一次底稿),所以读只碰内存、不会失败;
  engine 的 transcript 就是每步从 `projection` 拿的,本地不留副本
- **会话参数**:`agent.configure({ settings, tools })` —— 只有 `apiKey` 必填,模型 / 档位 / 端点有缺省;
  工具集也在配置里。**SDK 不读环境变量**,env → settings 在 CLI / 客户端那层做
- **`Agent` 与 `Turn` 分开**:`Agent.run` 只跑 step 循环(交出句柄);一次完整 turn 用独立的
  `Turn.runTurn(config, { text }, { onEvent? })`——借 `Agent.run({ archive: makeTurnHook() })` 起一个 run、
  在 archive hook 上织入 `TURN_*` / step 的 `parentId`,解析事件、跑完关掉。
  引擎本身只发 `STEP_*`;prompt id、turn 对齐、回答 / 错误收集都在 `turn/live.ts`,客户端只剩渲染;
  要自己的超时 / 多播就留在 `run` 的持续模式,用 `send` + `events` 自己订阅(或不挂 hook,只收 step)。
  事件分结构 / 内容:结构是 `ENGINE/TURN/STEP_START|END`,
  内容是 `INBOX_OFFER`(完整消息,`id` + `payload`)/ `INBOX_TAKE`(引用)/ `USER_MESSAGE` /
  `ASSISTANT_MESSAGE` / `REASONING` / `FUNCTION_CALL` / `FUNCTION_CALL_OUTPUT`;system 是引擎级状态
  (`SYSTEM_MESSAGE_SET` / `SYSTEM_MESSAGE_CLEAR`);错误是内容
  (`STEP_ERROR` / `TURN_ERROR` / `ENGINE_ERROR`);生命周期只有 start→end;层级只用 id / parentId;
  `Turn.runTurn` 把最后一步的 `ASSISTANT_MESSAGE` 作为回答返回;`INBOX_OFFER − INBOX_TAKE` 可还原 inbox。
  transcript 在投影里**同一会话内跨 run 保留**,会话边界是 archive 的 `sessionId`
  (`Archive.startSession` / `useSession`),所以每轮关 run 不丢多轮记忆。
  inbox 自己攒到"就位"再交出整批(`takeReadyBatch(awaiting)`),`INBOX_OFFER` / `INBOX_TAKE` 也由它自己发;所有事件
  统一从 `events.ts` 出口(archive 队列 + 实时流)
- **内部模型是 `Item`**:照 `/responses` 的 `input[]` 设计;chat 是折叠成 message 的兼容路径
- **思维链**:两条路都显示 🧠(都是明文,无需签名)
- **思考档位**:`off|low|high|max`,与 DeepSeek 的 effort 同名;缺省 `high`(不走环境变量)
- 工具:内置 `bash`(30s 超时)/ `read_file` / `write_file` / `list_dir`;自己造工具就按 `Tool` 契约写 `{ definition, execute }`;
  输出在 `runTool` 里统一截断到 `TOOL_MAX_OUTPUT`(头尾各半,中间标注省略多少)
- 记忆:一个 archive 会话一条 transcript(跨 run 保留;`startSession` 开新会话)· 工具调用无次数上限 · 参数 Schema 校验 · 工具失败 / 抛异常由
  `runTool` 转成 `错误:…` 观测回喂
  · 工具轮保留 `reasoning`(回放契约),纯问答轮不保留 · 等工具时的新 prompt 与结果合并
  · 同一批工具调用并发跑(`TOOL_CONCURRENCY = 4`),完成一个写回一个(顺序 = 完成顺序),
  进 transcript 时再按调用顺序重排

## 暂未做

流式 · 上下文压缩 · 重试 · 计费 · 沙箱 · 多模态 · `responses` 内置工具 · 工具级限流 ·
TUI / 桌面 / 手机客户端(只有骨架);Web 端的流式渲染、Markdown、会话管理(标题 / 删除)。想法先写 [`../drafts/`](../drafts/)。

## 待观察

| 事项                                     | 说明                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **重建 reasoning item 依赖未文档化行为** | 只校验 `reasoning_text` 这件事没写进官方文档;DeepSeek 一旦改签名 / 密文,回放立刻断 —— 见 [`../decisions/0005-deepseek-only.md`](../decisions/0005-deepseek-only.md) 复查条件 1     |
| 开思考但某轮没有 reasoning 文本          | 本项目**不编造** item,此时 `responses` 会 400(chat 给空串即可)。DeepSeek 正常不会出现                                                                                              |
| `deepseek-v4-pro` 未跑过                 | 冒烟只用 `deepseek-flash`;换模型前先改 `scripts/smoke.ts` 里传的 `model`                                                                                                           |
| `effect/http` 标 unstable                | 宿主的 HTTP 全在 `effect/http` / `effect/http-api`(v4.0.5);升 Effect 时先看这两个模块的签名 —— 见 [`../decisions/0007-effect-http-host.md`](../decisions/0007-effect-http-host.md) |
| `top_p` / `max_tokens`                   | 未暴露;两条 wire 的字段名不同(`max_tokens` / `max_output_tokens`)                                                                                                                  |
| 默认模型名                               | 取自本机 pi 的模型目录,会随厂商漂移                                                                                                                                                |
| system prompt 只有一条                   | `SYSTEM_MESSAGE`(`loop/_constants.ts`):只写安全约束,不枚举工具名;工具定义走请求的 `tools` 字段                                                                                     |
| 换模型 = 换会话                          | 设置按会话固定(设计「配置放哪」A);Web 上切模型会重开会话、丢历史 —— 要"同一会话换模型"就得加 `configure` 条目(见设计阶段 4)                                                        |
| REPL / 宿主默认续上最后一段会话          | `ArchiveRuntime` 启动时选中 archive 里最后一段会话;想开新会话就用 `Archive.startSession`(CLI / smoke 已这么做),不用删文件                                                          |
| web 断流的中断边界                       | 断开 = 中断 `runTurn`,它的 `ensuring` 关掉本轮 run;LLM HTTP 请求是否立即停取决于客户端的中断语义,没有单独测过                                                                      |
| process-compose                          | 只登记了宿主 `archive001-web`(5180);dev 的页面(`pnpm web`,Vite)按需手动起,REPL(`pnpm dev`)要终端交互,不归编排                                                                      |
