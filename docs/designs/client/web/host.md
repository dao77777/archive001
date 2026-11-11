# 设计:Web 客户端的本地宿主

> 取舍见 [`../../../decisions/0006-web-local-host.md`](../../../decisions/0006-web-local-host.md)(为什么要有宿主)
> 与 [`../../../decisions/0007-effect-http-host.md`](../../../decisions/0007-effect-http-host.md)(为什么用 `effect/http`、dev 为什么走代理)。
> 界面规则见 [`ui.md`](ui.md);内核见 [`../../agent/loop.md`](../../agent/loop.md)。

## 一句话

**浏览器只画,宿主干活;宿主就是几层 `effect/http` 路由。**

```
dev   浏览器 ── /api/* ──► Vite(519x,页面 + HMR)+ 代理 ──► 宿主(5180,只给 /api)
prod  浏览器 ── 全部 ───────────────────────────────────► 宿主(5180,dist/ + /api)
                                                          ├─ Turn.runTurn → Agent.events / send(…, BuiltinTools)
                                                          └─ DeepSeek(密钥只在这边)
```

- `src/` 下除 `host/` 之外的一切 = **浏览器代码**(目前不含 `node:*`、不持有密钥)。
- `src/host/` = **宿主**,和 `cli` / `repl` 一样是"客户端自己的后端",内核不认识它。

## 文件

| 文件                     | 职责                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `src/host/main.ts`       | 装配:路由 + 页面(prod `dist/`,dev 一句提示)+ `HttpServer` + `launch`           |
| `src/host/routes.ts`     | `/api/{state,turn,reset}` 三条路由 + `/api/*` 的 JSON 404                      |
| `src/host/session.ts`    | `Session` 服务:一套 `Agent` + `Turn` + 工具实例;`turn` 出事件流,`reset` 换一套 |
| `src/host/guard.ts`      | 安全闸:`Guard`(全局)+ `RequireToken`(路由级)                                   |
| `src/host/_util.ts`      | 纯判定:`isLoopbackHost` / `isSameOrigin` / `hasToken` / NDJSON                 |
| `src/host/_domain.ts`    | 声明:`/api/turn` 的请求体 Schema、`TurnEvent`、`SessionShape`                  |
| `src/host/_constants.ts` | 端口、绑定地址、令牌 Cookie 名、body 上限、env 名                              |
| `src/use-agent.ts`       | 浏览器侧唯一的外呼:POST `/api/turn`、读 NDJSON、折成 `Block`                   |

## 请求怎么走

```
NodeHttpServer ─► HttpRouter(FindMyWay)
                    ├─ Guard(全局)   Host 回环?Origin 同源?否则 401
                    ├─ GET  /api/state ─────────────► 不要求令牌(握手)
                    ├─ POST /api/turn   ┐ RequireToken
                    ├─ POST /api/reset  ┘  令牌不对 → 401
                    ├─ *    /api/*      ─────────────► JSON 404
                    └─ GET  /*          ─────────────► prod:`dist/`(spa 兜底);dev:只 `/`
```

- 路由 = `HttpRouter.add(method, path, handler)`,返回 **Layer**;`HttpRouter.serve(routes)` 交给
  `HttpServer`,与 `NodeHttpServer.layer(() => server, { port, host })` 合起来就是整个宿主。
- handler 直接 `yield* Session` / `yield* Agent`:依赖走 Layer 图,不再有 `ManagedRuntime`。
- `/api/turn` 的 body 用 `Schema` 解(`TurnBodySchema`):字段缺失 / 档位写错 → 框架自己回 400。

## API

| 路由                      | 用途                                                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/state`          | `{ hasKey, cwd }` —— 密钥在不在、工具能碰哪个目录。**不要求令牌,且响应里种下令牌** —— 这就是握手(dev 期页面在 Vite 那边)                                                                                                                                                   |
| `GET /api/sessions`       | `{ current, sessions: [{ id, title, at, entries, current }] }`;标题取第一条用户消息,最近活动在前                                                                                                                                                                           |
| `POST /api/sessions/open` | body `{ id }`;切到该 archive 会话,返回 `{ ok, id, entries }`(`ArchiveEntry[]`)                                                                                                                                                                                             |
| `POST /api/turn`          | body `{ input, settings: { model?, thinking? } }`;响应 `application/x-ndjson`,一行一个 JSON:`ArchiveEntry` 原样转发(`INBOX_OFFER` 带完整消息,以及 `REASONING` / `ASSISTANT_MESSAGE` / `FUNCTION_CALL`;层级用 id / parentId),末行 `{_tag:"ANSWER"}`;出错是 `{_tag:"ERROR"}` |
| `POST /api/reset`         | 换一套服务端实例 + `Archive.startSession`,返回 `{ ok, id }`(新会话 id)                                                                                                                                                                                                     |

**为什么 NDJSON**:`/api/turn` 是 POST,`EventSource` 用不了;NDJSON 就是"一行一个 JSON",
`fetch` 流 + `split("\n")` 即可(注意留半行,见 `use-agent.ts` 的 `buffer`)。

## 会话

`AgentLive` 只装配(输出 `Agent` + `Turn`,inbox 是内部实现),**不常驻引擎**;`Session.open` 建一套层,
每次 `/api/turn` 调 `Turn.runTurn`——起一个 run、跑一轮、关掉它。transcript 在投影里**同一会话内
跨 run 保留**,所以多轮仍有记忆;`reset` 换一套实例并调用 `Archive.startSession` 开新会话,
关旧 scope 会停掉在飞的那一轮;`/api/sessions` / `/api/sessions/open` 读的是同一份 archive,
不换层。

`/api/turn` 的事件流用 `Stream.callback`:`runTurn` 的 `onEvent` 把事件逐行写给浏览器,
最后补 `answer` / `error` 行(最终回答的正文不再作为 `ASSISTANT_MESSAGE` 重复转发)。
⚠️ 浏览器断开 = 事件流被中断 → `runTurn` 的 `ensuring` 关掉本轮 run(生成会停),不会留下空转的引擎。

页面挂载时先 `GET /api/state`(拿 cookie)再 `POST /api/reset` —— 于是**刷新 = 新会话**。

## 工具与 cwd

- 工具就是内置四件套(`bash` / `read_file` / `write_file` / `list_dir`),**不需要前端确认**(已定)。
- 工具的工作目录 = **启动宿主时的 `process.cwd()`**;静态产物的根是包自己的 `dist/`
  (`import.meta.dirname/../../dist`),两者分开,免得"为了 serve 页面把工具锁进某个包目录"。
- 界面上会显示这个目录(空态一行),用户得知道工具能碰哪儿。

## 安全

下面五条共同构成当前的隔离面(删掉任何一条都会开一个口子):

| 手段                                                                       | 挡住什么                                |
| -------------------------------------------------------------------------- | --------------------------------------- |
| 只绑 `127.0.0.1`                                                           | 同网段/公网访问                         |
| 校验 `Host` 是回环(`Guard`)                                                | DNS rebinding(恶意域名解析到 127.0.0.1) |
| 校验 `Origin` 与 `Host` 同源(`Guard`)                                      | 别的站点用 `fetch` 打本地端口(CSRF)     |
| 启动生成一次性 token,`HttpOnly` + `SameSite=Strict` cookie(`RequireToken`) | 同机其它页面的越权调用                  |
| 不发 `Access-Control-Allow-Origin`                                         | 跨源读响应                              |

## 这层不管

- **流式 token**:事件粒度是"一步"(STEP_START / STEP_END),不做逐字流;要做另开 draft。
- **多会话 / 持久化**:一个进程一个会话,不落盘;`reset` 会打断常驻循环与在飞的那一轮。
- **工具审批**:已决定不做,所以宿主目前只在本机回环上跑。
- **单元测试 HTTP 层**:目前只测 `_util.ts` 的判定;要给路由写集成测试用
  `NodeHttpServer.layerTest`(临时端口 + fetch 客户端)。
