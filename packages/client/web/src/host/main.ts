#!/usr/bin/env node
// **Web 客户端自己的后端**(本地 Host):浏览器只负责画,模型调用与工具都在这里跑。
//
//   浏览器 ── POST /api/turn (NDJSON 事件流) ──► 这里 ──► DeepSeek
//                                              └─ agent.run(…, BuiltinTools)
//
// 为什么要这一层:内置工具依赖 `node:fs` / `child_process`,浏览器跑不了;而且密钥不该进浏览器。
//
// 全部用 `effect/http` 写:路由是 Layer,`HttpRouter.serve` 换成 `HttpServer`,最后 `Layer.launch`。
//
// 两种跑法:
//   dev  —— 宿主只提供 `/api/*`,页面由 Vite 服务,`/api` 由 Vite 代理过来(见 vite.config.ts);
//   prod —— `NODE_ENV=production`,同一个端口把 `dist/` 也 serve 了。
//
// 安全(不做就是给自己开个后门):只绑 127.0.0.1 + 校验 Host 是回环 + Origin 同源 +
// 一次性 HttpOnly cookie + 不发 CORS 头 —— 全在 `./guard.ts`。

import { resolve } from "node:path";
import process from "node:process";
import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/http";
import { HOST_BIND, HOST_PORT } from "./_constants.ts";
import { Guard } from "./guard.ts";
import { ApiRoutes } from "./routes.ts";
import { SessionLive } from "./session.ts";

const isProduction = process.env.NODE_ENV === "production";

/**
 * prod:静态产物。根 = **本文件所在包的 `dist/`**,与"工具能碰哪个目录"分开:
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

/** 页面归谁:prod 由宿主自己 serve `dist/`,dev 归 Vite。两条腿共用同一套 `/api`。 */
const Pages = isProduction ? Static : DevHint;

const Routes = Layer.mergeAll(ApiRoutes, Pages, Guard);

// 端口冲突要说人话:默认 5180 被 process-compose 占着,手动再起一个必然撞。
const server = createServer();
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(
      `端口 ${HOST_PORT} 已被占用:换个 PORT(如 PORT=5181 pnpm web:host),或先停掉占用的进程。\n`,
    );
    process.exit(1);
  }
  throw error;
});

const Server = Routes.pipe(
  HttpRouter.serve,
  Layer.provide(SessionLive),
  Layer.provide(NodeHttpServer.layer(() => server, { port: HOST_PORT, host: HOST_BIND })),
);

const program = Effect.gen(function* () {
  yield* Effect.logInfo(
    `archive001 web host · ${isProduction ? "prod" : "dev(仅 /api)"} · cwd ${process.cwd()}`,
  );
  return yield* Layer.launch(Server);
});

NodeRuntime.runMain(program);
