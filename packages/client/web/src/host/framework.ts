// 宿主用的 **http 框架层**:只跟 `effect/http` 打交道,不认识 archive001 的业务。
// 想把业务挪走时,这个文件跟着业务无关地留下。
//
//   错误     —— 闸 / 超限 / 404 三条(业务错误跟着 http-api 的类型走,在 `api.ts`)
//   传输     —— `encodeNdjsonLine`
//   安全判据 —— 回环 Host、同源 Origin、令牌 cookie(纯函数,可单测)
//   启动     —— `nodeServer` / `run`:回环端口 + EADDRINUSE 说人话 + 日志 + `Layer.launch`

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { HttpServerRequest as Request } from "effect/http";
import { HttpServerResponse } from "effect/http";

// ── 错误(全部在这;一律 thunk,用时加 `()`) ─────────────────────────────
//
// 带 body 的业务错误(400 / 503)不在这里:它们要参与 http-api 的类型检查,
// 定义在 `api.ts` 的「Schema:错误」段。这里只放"闸"与"传输出错"。

/** 401:闸没过(Host 不是回环 / Origin 不同源 / 令牌不对)。 */
export const HTTP_ERR_UNAUTHORIZED = () =>
  HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });

/** 404:没有这条路由。 */
export const HTTP_ERR_NOT_FOUND = () =>
  HttpServerResponse.jsonUnsafe({ error: "not found" }, { status: 404 });

/** 413:请求体超限(按 `content-length` 判,不信实际流长度)。 */
export const HTTP_ERR_TOO_LARGE = () =>
  HttpServerResponse.jsonUnsafe({ error: "请求体太大" }, { status: 413 });

// ── 传输 ──────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** 一行 NDJSON(含换行);事件流里不夹别的分隔符。 */
export const encodeNdjsonLine = (value: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(value)}\n`);

// ── 安全判据(纯函数,单测在 `./framework.test.ts`) ──────────────────────

/** `Host` 只允许回环写法:挡 DNS rebinding(恶意域名解析到 127.0.0.1)。 */
export const isLoopbackHost = (hostHeader: string | undefined): boolean => {
  if (hostHeader === undefined) return false;
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
};

/** 有 `Origin` 就必须和 `Host` 一致(挡别的站点 fetch 本地端口);没有就放行。 */
export const isSameOrigin = (request: Request.HttpServerRequest): boolean => {
  const origin = request.headers["origin"];
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers["host"];
  } catch {
    return false;
  }
};

/** 请求里带的令牌是否就是本次启动发的那个。 */
export const hasToken = (
  request: Request.HttpServerRequest,
  cookieName: string,
  token: string,
): boolean => request.cookies[cookieName] === token;

/**
 * 一次性令牌 + 种它的函数。进程换了令牌就失效;`HttpOnly` 让 JS 读不到,
 * `SameSite=Strict` 让别的站点带不上 —— 配合上面两条判据,把"任意网页都能 fetch 本地端口"堵死。
 */
export const newTokenCookie = (cookieName: string) => {
  const token = randomUUID();
  return {
    token,
    /** 给响应种下令牌 cookie(握手:每个响应都带)。 */
    apply: (response: HttpServerResponse.HttpServerResponse) =>
      HttpServerResponse.setCookieUnsafe(cookieName, token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
      })(response),
  };
};

// ── 启动 ──────────────────────────────────────────────────────────────────

/**
 * 回环端口上的 Node server 层。端口占用要说人话:默认端口被 process-compose 占着时,
 * 手动再起一个必然撞,不然只会看到 `EADDRINUSE` 栈。
 */
export const nodeServer = (options: { readonly port: number; readonly host: string }) => {
  const server = createServer();
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        `端口 ${options.port} 已被占用:换个 PORT(如 PORT=5181),或先停掉占用的进程。\n`,
      );
      process.exit(1);
    }
    throw error;
  });
  return NodeHttpServer.layer(() => server, { port: options.port, host: options.host });
};

/** 跑起来:一行启动日志 + `Layer.launch`。`app` 应是"服务都喂完了、只等 `never`"的层。 */
export const run = <E>(app: Layer.Layer<never, E, never>, label: string) =>
  NodeRuntime.runMain(
    Effect.gen(function* () {
      yield* Effect.logInfo(label);
      return yield* Layer.launch(app);
    }),
  );
