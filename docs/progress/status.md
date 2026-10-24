# 状态:archive001

> 快照,覆盖更新;历史见 [`../logs/`](../logs/)。更新于 2026-10-23。

## 到哪了

**可用,真 key 验证过。** 内核 `@archive001/agent`(只有 SDK)+ 客户端群 `packages/client/`
(repl / web / cli 可用,tui / desktop / mobile 是骨架)。Web 客户端有**本地宿主**(`effect/http` 写的):
浏览器只画,模型调用与内置工具在 Node 里跑,密钥不进浏览器;dev 期页面归 Vite、`/api` 走代理。

| 项                    | 证据                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| 门禁                  | `pnpm check` ✅ 格式 + lint + 类型 / `pnpm typecheck` ✅ 6 包 0 错 / `pnpm test` ✅ 8 文件 77 用例 |
| 构建                  | `pnpm build` ✅ agent(index/cli)+ repl + tui + web(desktop/mobile 无 build,按设计跳过)             |
| 两条 wire(mock)       | 请求形状 + 解析各一组真 HTTP 打点                                                                  |
| **两条 wire(真 key)** | `pnpm smoke` 跑通多轮工具对话(`deepseek-flash`,low / off 两档)                                     |

## 能力

- **SDK**:`@archive001/agent` 导出服务 / 类型 / 缺省值与助手;**CLI**:一次性跑 prompt(文本 / NDJSON)
- **按次参数**:`run(input, settings, tools, observe?)` —— 只有 `apiKey` 必填,模型 / 档位 / 端点有缺省;
  工具集也逐次给。**SDK 不读环境变量**,env → settings 在 CLI / 客户端那层做
- **内部模型是 `Item`**:照 `/responses` 的 `input[]` 设计;chat 是折叠成 message 的兼容路径
- **思维链**:两条路都显示 🧠(都是明文,无需签名)
- **思考档位**:`off|low|high|max`,与 DeepSeek 的 effort 同名;缺省 `high`(不走环境变量)
- 工具:内置 `bash`(30s 超时)/ `read_file` / `write_file` / `list_dir`;可用 `makeTool` 自造
- 记忆:多轮 · 最多 12 步 · 参数 Schema 校验 · 工具错误当观测回喂 · `reasoning` 不落历史

## 暂未做

流式 · 上下文压缩 · 重试 · 工具并发 · 计费 · 沙箱 · 多模态 · `responses` 内置工具 ·
TUI / 桌面 / 手机客户端(只有骨架);Web 端的流式渲染、Markdown、会话持久化。想法先写 [`../drafts/`](../drafts/)。

## 待观察

| 事项                                     | 说明                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **重建 reasoning item 依赖未文档化行为** | 只校验 `reasoning_text` 这件事没写进官方文档;DeepSeek 一旦改签名 / 密文,回放立刻断 —— 见 [`../decisions/0005-deepseek-only.md`](../decisions/0005-deepseek-only.md) 复查条件 1     |
| 开思考但某轮没有 reasoning 文本          | 本项目**不编造** item,此时 `responses` 会 400(chat 给空串即可)。DeepSeek 正常不会出现                                                                                              |
| `deepseek-v4-pro` 未跑过                 | 冒烟只用 `deepseek-flash`;换模型前先改 `scripts/smoke.ts` 里传的 `model`                                                                                                           |
| `effect/http` 标 unstable                | 宿主的 HTTP 全在 `effect/http` / `effect/http-api`(v4.0.5);升 Effect 时先看这两个模块的签名 —— 见 [`../decisions/0007-effect-http-host.md`](../decisions/0007-effect-http-host.md) |
| `top_p` / `max_tokens`                   | 未暴露;两条 wire 的字段名不同(`max_tokens` / `max_output_tokens`)                                                                                                                  |
| 默认模型名                               | 取自本机 pi 的模型目录,会随厂商漂移                                                                                                                                                |
| Web 端没有工具,提示词如实说              | `agent.run({ settings, tools: [] })`;系统提示词由 `systemPromptFor(toolNames)` 现拼,工具集为空时明令禁止输出 `<tool_call>`(2026-10-21 修复"卡在调用工具里")                        |
| 换模型 = 换会话                          | 设置按会话固定(设计「配置放哪」A);Web 上切模型会重开会话、丢历史 —— 要"同一会话换模型"就得加 `configure` 条目(见设计阶段 4)                                                        |
| REPL 的会话文件会一直续上                | `ARCHIVE_PATH` 指向的文件重启后接着聊;想开新会话就挪走/删掉那个文件(恢复逻辑会作废半拍、补未知结果)                                                                                |
| process-compose                          | 只登记了宿主 `archive001-web`(5180);dev 的页面(`pnpm web`,Vite)按需手动起,REPL(`pnpm dev`)要终端交互,不归编排                                                                      |
