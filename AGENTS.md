# AGENTS.md — archive001(现状说明)

> 本文件描述**现在长什么样**、当前设计与已实测的事实。**没有硬规矩**:每条都只是"暂时这么做",
> 想改就改;改之前把代价写进 [`docs/decisions/`](docs/decisions/) 或对应的设计文档即可。

## 这是什么

一个会调工具的 agent,用的是 Effect v4 + Node 24 + Vite+(`vp`)。只接 DeepSeek。

| 包                                             | 角色                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/agent`(`@archive001/agent`)          | 内核:`llm/`(两条 wire)+ `loop/`(循环)+ 工具契约;只有 SDK 入口 `src/index.ts`          |
| `packages/client/<名字>`(`@archive001/<名字>`) | 客户端:`repl`、`web`(React 19)、`cli`(一次性)可用;`tui` / `desktop` / `mobile` 是骨架 |

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
  `vp` 靠 **git 枚举文件**,项目对 `~/Code` 的 git 不可见时报「No files found」(见 `code-conventions.md` §9)。
- **Effect 是 v4**,包已合并(`effect/http`、`effect/process`…);v3 的资料大多不适用。要点在
  [`docs/designs/code-conventions.md`](docs/designs/code-conventions.md#5-effect)。
- **回放契约**:`responses` 开思考时每个 `function_call` 前要有非空 `reasoning_text`;`chat` 每条 assistant 要带
  `reasoning_content`;既没正文也没工具调用的 assistant 整条丢弃 —— 否则 400 并毒死会话。
  实测与报文见 [`docs/designs/agent/llm.md`](docs/designs/agent/llm.md#回放契约)。
- **工具是 `run` 的参数**:`agent.run(input, settings, tools, observe?)`。内置 `bash` / `read_file` / `write_file` /
  `list_dir` 在 `loop/builtin-tools.ts`(SDK 子路径 `@archive001/agent/builtin-tools`,依赖 Node,浏览器别 import),
  想要才传。自造工具用 `makeTool({...})`,参数写 Effect Schema(同时产出 JSON Schema 与运行时校验)。
- **密钥从 `~/Code/_vault` 取**,用 `sops exec-env` 注入;内核与 llm 层不读环境变量,env → `LlmSettings` 在客户端那层做。
- **状态暂存在 `Ref<Item[]>`**(多轮历史);下一版是 archive(append-only,落盘),见
  [`docs/designs/agent/archive.md`](docs/designs/agent/archive.md)。
  落盘后文件里是**明文**(思维链 + 工具 stdout),路径与权限见该文档的「持久化」节。
- **Web 客户端的密钥只在本地宿主**(`src/host/`,从 env 读),浏览器只发模型 / 档位;宿主目前只绑本机回环,
  因为工具没有审批。细节见 [`docs/designs/client/web/host.md`](docs/designs/client/web/host.md)。
- **REPL 的输入用 `node:readline/promises`**:effect 的 `Terminal.readLine` 实现给 TTY 开 raw mode 却不给
  `output`、也不回显,表现为"自己打的字自己看不见"(踩过)。

## 文档去哪

| 想知道                     | 看                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 两层怎么设计               | [`docs/designs/agent/loop.md`](docs/designs/agent/loop.md) · [`docs/designs/agent/llm.md`](docs/designs/agent/llm.md)                   |
| 下一版(常驻循环 / archive) | [`docs/designs/agent/live-loop.md`](docs/designs/agent/live-loop.md) · [`docs/designs/agent/archive.md`](docs/designs/agent/archive.md) |
| 怎么一步步实现             | [`docs/designs/agent/implementation-plan.md`](docs/designs/agent/implementation-plan.md)                                                |
| 代码现在怎么写             | [`docs/designs/code-conventions.md`](docs/designs/code-conventions.md)                                                                  |
| DeepSeek 报文 / 回放实测   | [`docs/knowledge/deepseek-api.md`](docs/knowledge/deepseek-api.md)                                                                      |
| 为什么这么定               | [`docs/decisions/`](docs/decisions/)                                                                                                    |
| 现在到哪了                 | [`docs/progress/status.md`](docs/progress/status.md)                                                                                    |
