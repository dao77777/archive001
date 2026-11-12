#!/usr/bin/env node
// **Web 客户端自己的后端**(本地宿主):浏览器只负责画,模型调用与工具都在这里跑。
//
//   浏览器 ── POST /api/turn(NDJSON 事件流)──► 这里 ──► DeepSeek
//                                             └─ Turn.runTurn → Agent(工具要 node:fs / child_process)
//
// 为什么要有这一层:内置工具依赖 `node:*`,浏览器跑不了;而且密钥不该进浏览器。
// 这个文件只做装配:常量 → 页面 → http-api 层 + 404 兜底 + 安全闸 → 起服务。
//
// 两种跑法:
//   dev  —— 页面归 Vite(`pnpm web`),`/api` 由它代理过来(见 vite.config.ts);
//   prod —— `NODE_ENV=production`,同一个端口把 `dist/` 也 serve 了。

import { resolve } from "node:path";
import process from "node:process";
import { Layer } from "effect";
import { Etag, HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Api, ApiLive, ApiNotFound, Guard } from "./api.ts";
import { nodeServer, run } from "./framework.ts";
import { SessionLive } from "./session.ts";

/** 监听端口;process-compose 与本地开发都用它 */
const PORT = Number(process.env.PORT ?? 5180);

/** 只绑回环:这台机器之外一律连不上 */
const HOST = "127.0.0.1";

const isProduction = process.env.NODE_ENV === "production";

/**
 * prod:静态产物。根 = 本包的 `dist/`,与"工具能碰哪个目录"分开:
 * 后者是启动宿主时的 cwd(`process.cwd()`),由 `/api/state` 报给界面。
 */
const Static = HttpStaticServer.layer({
  root: resolve(import.meta.dirname, "../../dist"),
  spa: true,
});

/** dev 下打开宿主根地址的人:告诉他页面在 Vite 那边。 */
const DevHint = HttpRouter.add(
  "GET",
  "/",
  HttpServerResponse.text("dev:页面由 Vite 提供(pnpm web),这里只提供 /api/*\n"),
);

/** 页面归谁:prod 宿主自己 serve `dist/`,dev 归 Vite。两条腿共用同一套 `/api`。 */
const Pages = isProduction ? Static : DevHint;

/** 声明 → 实现:端点在 `api.ts` 里声明,handler 在那里实现,这里只把它们接成路由层。 */
const ApiRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(ApiLive), Layer.provide(Etag.layer));

const Routes = Layer.mergeAll(ApiRoutes, ApiNotFound, Pages, Guard);

const Server = Routes.pipe(
  HttpRouter.serve,
  Layer.provide(SessionLive),
  Layer.provide(nodeServer({ port: PORT, host: HOST })),
);

run(
  Server,
  `archive001 web host · ${isProduction ? "prod" : "dev(仅 /api)"} · cwd ${process.cwd()}`,
);
