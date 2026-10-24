# 决策:宿主改用 `effect/http`,dev 期页面归 Vite、`/api` 走代理

> 已接受 · 2026-10-23 · 所属设计 [`../designs/client/web/host.md`](../designs/client/web/host.md)
> 落点 `packages/client/web/src/host/`、`packages/client/web/vite.config.ts`

## 矛盾

`0006` 定的宿主是**手写 `node:http` + Vite 中间件**:一个 `createServer` 里混着
"安全闸 + API + 前端产物",dev 期靠 `vite.middlewares(..., next)` 在同一个端口兜底 HTML。

- 那段代码只有一种"正确顺序",读和改都得通读全文件(校验 → if/else 路由 → 中间件 → 兜底)。
- Effect 世界里的错误、取消、依赖注入全在 handler 边界断掉:`handleTurn` 里要
  `runtime.runPromise(...)`,浏览器断开也只是"响应写完了",模型照跑。
- 浏览器断开 → 请求 fiber 被中断这件事,手写版根本没有。
- 与此同时 effect v4 自带 `effect/http`(`HttpRouter` / `HttpServerResponse` / `HttpStaticServer` / Cookie /
  Etag / Multipart),`@effect/platform-node` 提供 `NodeHttpServer` —— 这些都与本项目的 Layer 约定同构。

而 `NodeHttpServer` 是 `server.on("request", handler)` **独占入口**,塞不进 Vite 的
`middlewares(req, res, next)`(两个都挂会双写响应)。所以"用 effect/http"和"单端口 dev"不能同时要。

## 处理

1. 宿主全部改成 `effect/http`:路由是 Layer(`HttpRouter.add`),`HttpRouter.serve` → `HttpServer`,
   `Layer.launch` + `NodeRuntime.runMain` 收尾。文件拆成
   `main`(装配)/`routes`/`session`/`guard`/`_util`/`_domain`/`_constants`。
2. **dev 两个进程**:页面归 Vite(`pnpm web`),`/api/*` 由 Vite `server.proxy` 转到宿主(5180)。
   宿主在 dev 只提供 `/api/*`(根路径给一句提示),`NODE_ENV=production` 时才用
   `HttpStaticServer.layer({ root: dist, spa: true })` 把 `dist/` 一起 serve。
3. 会话:`Session` 把 `Agent` + 工具建在子 `Scope` 上,`reset` = 开新的、关旧的(不再用 `ManagedRuntime`)。
4. 事件流:`Stream.callback` 让 agent 跑在流的 scope 里 —— 浏览器断开即中断。
5. `Agent` 的 mid-`resolve` 校验换成 Schema:`TurnBodySchema` 解请求体,失败由框架回 400。
6. 令牌改成**握手**:`/api/state` 不要求令牌、但响应里种 cookie;`/api/turn`、`/api/reset` 必须带。
   于是 dev(页面在 Vite)与 prod(页面在宿主)两种形态用同一套鉴权。顺手修掉旧版
   "prod 下 `serveStatic("/")` 从不种 cookie,浏览器拿不到令牌、`/api/*` 全 401"的 bug。

## 为什么

- **同一套 runtime**:handler 就是 Effect,`yield* Agent` 直接拿服务;取消/超时/日志/span 都是
  Effect 的语义,不再需要 `runPromise` 的桥。
- **结构即路由**:增加一条路由 = 加一个 Layer;安全闸是可组合的中间件,不是"文件里某一段 if"。
- **少写一遍 HTTP**:mime / `Accept-Ranges` / cookie 编码 / 条件请求由框架给,`serveStatic` 那 20 行
  手写与"后缀猜 mime"可以删掉。
- **dev 更快更标准**:Vite 自己的 dev server 提供 HMR / 资源转换,宿主不必再做
  `transformIndexHtml` 与 HMR 复用端口这类非标准接线。

## 代价

- 依赖一个标了 `@stability unstable` 的模块面(`effect/http`、`effect/http-api`);
  升级 Effect 小版本时可能要吃签名变化。当前固定在 `4.0.5`。
- dev 从"一个端口"变成"两个端口 + 一条代理规则";`pnpm web:host` 单独跑时**没有页面**
  (要 UI 必须同时 `pnpm web`),直接打开 5180 只会看到一句提示。
- 代码行数没变少(~370 → ~330 行,但分成 7 个文件);换来的是每层可单独读。
- `reset` 关闭旧 scope 会**中断在飞的那一轮**(与"清空历史"语义一致,但会看到请求突然结束)。
- prod 的静态兜底依赖浏览器发 `Accept: text/html`(`HttpStaticServer` 的 spa 判据),
  curl 默认 `*/*` 会拿到 404 —— 这是行为差异,不是 bug。

## 复查条件

1. 若 `effect/http` 在某个 Effect 版本里发生破坏性变化,而项目不想跟 —— 回到"手写
   `node:http` + 路由表",但**保留** `Session` / `guard` 的 Effect 写法。
2. 若出现"必须单端口 dev"(例如某个只用 5173 的环境) —— 改用 `HttpRouter.toWebHandler` +
   自建 `node:http`,把 Vite 当 fallback,或反过来让宿主代理 Vite。
3. 若开始需要工具审批 / 多会话 / 持久化 —— 先改 `Session`(它已经是唯一的会话边界),
   不要把状态塞回 `main.ts`。
