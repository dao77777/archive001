# archive001

一个会调工具的 agent。**一个内核包 + 每个客户端一个包**。

> 名字里的 `001` 只是编号;**主题是档案**(卷宗、卡片、档号),不是航天。界面**只借风格**,参照片见
> [`docs/designs/client/web/style-references.md`](docs/designs/client/web/style-references.md)(「科罗廖夫十字绽开」)。

| 包                                                | 是什么                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- |
| `packages/agent` · `@archive001/agent`            | 内核:LLM(两条 wire)+ 循环 + 工具契约。暴露 **SDK** 与 **CLI** |
| `packages/client/repl` · `@archive001/repl`       | REPL 客户端(**可用**)                                         |
| `packages/client/tui` · `@archive001/tui`         | TUI 客户端(骨架)                                              |
| `packages/client/web` · `@archive001/web`         | Web 客户端(React 19,**可用**)                                 |
| `packages/client/desktop` · `@archive001/desktop` | 桌面客户端(骨架)                                              |
| `packages/client/mobile` · `@archive001/mobile`   | 手机客户端(骨架)                                              |

依赖**单向**:客户端包 → `@archive001/agent`。客户端之间互不依赖,也不共用表现层代码。

## 跑

```bash
pnpm install

# REPL(密钥从 vault 注入,不进 shell 历史)
sops exec-env ~/Code/_vault/env/secrets.enc.yaml 'pnpm dev'
DEEPSEEK_API_KEY=sk-xxx pnpm dev                    # 或直接给 env

# agent 的 CLI(一次性跑 prompt)
pnpm cli "数一下 src 下有几个 .ts"
pnpm cli --json "只回复 OK"                          # NDJSON:每行一个事件
pnpm cli --thinking max --model deepseek-v4-pro "…"  # 行为参数走命令行

# 冒烟 / 构建 / 跑产物
pnpm smoke
pnpm build && pnpm start
```

| 环境变量                        | 说明                                               |
| ------------------------------- | -------------------------------------------------- |
| `DEEPSEEK_API_KEY` \| `API_KEY` | **必填**                                           |
| `MODEL`                         | 可选,缺省 `deepseek-flash`                         |
| `THINKING`                      | 可选,`off` \| `low` \| `high` \| `max`,缺省 `high` |
| `BASE_URL`                      | 可选,缺省 `https://api.deepseek.com`               |

这四项拼成一份 **`LlmSettings`**,**按次**传给 `agent.run` —— 没有"全局配置服务":
同一个进程里完全可以换 key、换端点。**只有 `apiKey` 必填**,其余三项省了就用 SDK 的缺省值
(`resolveSettings` 在服务边界补一次)。

⚠️ **SDK 不读环境变量**:env → `LlmSettings` 的转换在**入口那一层**做 ——
CLI 在 `packages/client/cli/src/main.ts`,REPL 在 `packages/client/repl/src/_env.ts`。
你自己的客户端想从 flag / 配置文件 / 数据库拿设置,也都随你。
走哪条 wire(`responses` / `chat`)是**内核内部实现**,不暴露给调用方。

## Web 客户端

```bash
pnpm web        # 前端 dev server(Vite,页面 + HMR);`/api/*` 代理到宿主
pnpm web:host   # 宿主(Effect HTTP,127.0.0.1:5180),开发期只提供 `/api/*`
pnpm build && NODE_ENV=production pnpm web:host   # 生产:一个端口把 dist/ + /api 一起给
```

开发时**两个进程**:页面归 Vite(`pnpm web`),模型与工具归宿主(`pnpm web:host`,常驻走
process-compose);Vite 把 `/api/*` 代理过去,所以宿主不用再托管 Vite 中间件。

Web 客户端由**两个进程角色**组成(详见 [`docs/designs/client/web/host.md`](docs/designs/client/web/host.md)):

```
浏览器 ── POST /api/turn (NDJSON) ──► 本地宿主(Node)──► DeepSeek
                                        └─ 内置工具(读文件 / 跑命令…)
```

- **密钥只在宿主**环境里:`DEEPSEEK_API_KEY`(或 `API_KEY`),浏览器拿不到任何片段;
- 工具的工作目录 = 启动宿主时的 `cwd`(界面空态会显示),所以从仓库根启动就能改整个仓库;
- 只绑 `127.0.0.1` + `Host`/`Origin` 校验 + 一次性 cookie —— 别改成对外监听。

**常驻开发用 `process-compose`**(工作区根 `~/Code/process-compose.yaml`,端口 5180,已登记):

```bash
cd ~/Code
process-compose process start archive001-web   # 起
process-compose process logs  archive001-web   # 看日志
process-compose process stop  archive001-web   # 停
```

控件用 **Base UI** 的无头原语(只借行为,样式自己写),样式用 **Tailwind v4**。风格借自 `_asset` 里
「科罗廖夫十字绽开」:近白纸 + 近黑墨 + 一枚砖红 + 1px 细线 —— 但**题材是档案**,主体是卷宗夹,
不是影片里的火箭十字。
详见 [`docs/designs/client/web/ui.md`](docs/designs/client/web/ui.md) 与[实测拆解](docs/designs/client/web/style-references.md)。
| [`docs/designs/client/web/style-references.md`](docs/designs/client/web/style-references.md) | 参照片风格拆解(实测) |

浏览器里只选**模型 / 档位**;密钥在宿主的环境变量里,界面拿不到。宿主侧全部用
`effect/http` 写:路由是 Layer,`HttpRouter.serve` → `HttpServer` → `Layer.launch`。

```
src/
├── main.tsx          挂载 React
├── app.tsx           消息流 + 输入框 + 设置(模型 / 档位)
├── controls.tsx      输入框下沿的控件
├── use-agent.ts      唯一外呼:POST /api/turn、读 NDJSON、折成 Block
├── _util.ts          事件 → Block / 参数预览
├── folder-mark.tsx   卷宗夹记号(SVG)
├── styles.css        Tailwind + 设计令牌
└── host/             宿主(只跑在 Node 里)
    ├── main.ts         装配:路由 + 静态产物 + NodeHttpServer + launch
    ├── routes.ts       /api/{state,turn,reset}
    ├── session.ts      会话:一套 Agent + 工具实例,reset = 换一套
    ├── guard.ts        安全闸(Host / Origin / 令牌 cookie)
    ├── _util.ts        纯判定(可单测)
    ├── _domain.ts      /api/turn 的请求体 Schema 与事件行
    └── _constants.ts   端口 / 绑定 / cookie 名 / body 上限 / env 名
```

## 命令

| 命令                                        | 作用                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm dev` / `pnpm watch`                   | REPL(Node 直接跑 TS / 带 `--watch`)                                   |
| `pnpm cli`                                  | 一次性 CLI(`packages/client/cli`)                                     |
| `pnpm smoke`                                | 真 key 冒烟:两轮带工具对话                                            |
| `pnpm tui` / `pnpm desktop` / `pnpm mobile` | 其它客户端占位(打印"还没实现")                                        |
| `pnpm web`                                  | Web 前端 dev server(Vite;`/api` 代理到 5180)                          |
| `pnpm web:host`                             | Web 宿主(开发期只给 `/api`;`NODE_ENV=production` 时连 `dist/` 一起给) |
| `pnpm check`                                | 格式化 + lint + 类型检查(vp 按文件用最近的 `tsconfig`)                |
| `pnpm typecheck`                            | 逐包 `tsc --noEmit`                                                   |
| `pnpm test`                                 | Vitest                                                                |
| `pnpm build`                                | 各包 `vp pack`(没有 build 脚本的包跳过)                               |

## 用 SDK

```ts
import { Effect, Layer, Redacted } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Agent, AgentLive, BuiltinTools, BuiltinToolsLive, LlmLive } from "@archive001/agent";

const App = Layer.mergeAll(
  Layer.provide(LlmLive)(AgentLive), // Agent(不需要任何配置)
  Layer.provide(NodeServices.layer)(BuiltinToolsLive), // 可选:内置四件套
  NodeServices.layer,
);

const program = Effect.gen(function* () {
  const agent = yield* Agent;
  const tools = yield* BuiltinTools; // 不要工具就传 []
  // 只有密钥必填;模型 / 档位 / 端点省了就用缺省值
  const settings = { apiKey: Redacted.make("sk-…") };
  return yield* agent.run("列一下当前目录", settings, tools, (event) =>
    Effect.sync(() => console.log(event._tag)),
  );
}).pipe(Effect.provide(App));
```

SDK 只导出三类(`packages/agent/src/index.ts`):

| 类            | 内容                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| 服务          | `Agent(Live)` · `Llm(Live)` · `BuiltinTools(Live)`                                            |
| 类型          | `AgentEvent` · `Item` · `LlmSettings` · `BehaviorSettings` · `Tool` · `LlmError` …            |
| 缺省值 / 助手 | `DEFAULT_SETTINGS` · `DEFAULT_BASE_URL` · `ThinkingLevel`(Schema)· `makeTool` · `formatError` |

内置工具在子路径 `@archive001/agent/builtin-tools`(依赖 `node:fs` / `child_process`,浏览器不该被拉进来)。

## 结构

```
packages/
├── agent/                        @archive001/agent(只有 SDK,没有入口程序)
│   ├── src/index.ts              ★ SDK 入口(只转发)
│   ├── src/loop/                 循环 + 内置工具
│   ├── src/llm/                  模型层:两条 wire
│   └── src/_util.ts
└── client/                       每个客户端一个包
    ├── cli/                      src/{main,_constants}.ts(一次性:跑一个 prompt 就退出)
    ├── repl/                     src/{main,app,repl,_env,_constants,_util}.ts
    ├── web/                      src/{main.tsx, app.tsx, use-agent, runtime, _constants, _util} + index.html
    └── tui/  desktop/  mobile/   骨架
```

每个目录的 `_constants.ts` / `_domain.ts` / `_util.ts` 分别是**常量 / 类型 / 工具函数**,不含业务逻辑;
`index.ts` 只做转发。每个包自带 `tsconfig.json`(web 额外开 `DOM`)。

## 文档

| 去哪                                                                                               | 内容                 |
| -------------------------------------------------------------------------------------------------- | -------------------- |
| [`AGENTS.md`](AGENTS.md)                                                                           | 现状说明与已知事实   |
| [`docs/designs/agent/loop.md`](docs/designs/agent/loop.md) · [`llm.md`](docs/designs/agent/llm.md) | 两层设计             |
| [`docs/designs/client/web/ui.md`](docs/designs/client/web/ui.md)                                   | Web 界面的美术与排版 |
| [`docs/designs/code-conventions.md`](docs/designs/code-conventions.md)                             | 代码现状与风格       |
| [`docs/README.md`](docs/README.md)                                                                 | 全部文档索引         |

## 已知取舍

- 只接 DeepSeek;两条 wire 的思维链都是明文,所以内部没有"签名 / 密文"这类不透明载荷
- 两个包都是 `private`:SDK 的 `exports` 直接指向 `src/*.ts`(靠 Node 24 跑 TS);真发布要改 `dist` + `prepack`
- 无流式、无多模态、无重试、无计费;历史全量重发;工具在 `process.cwd()` 执行,没有沙箱
