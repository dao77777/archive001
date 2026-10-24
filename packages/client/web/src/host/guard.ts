// 安全闸。这个端口只服务本机页面,两道闸缺一不可:
//
//   Guard(全局)  :`Host` 是回环 + `Origin` 同源;顺手给**每个**响应种下令牌 cookie ——
//                  这就是握手:dev 期页面由 Vite 提供,只有 `/api/*` 经过宿主,
//                  浏览器第一次调 `/api/state` 就把 cookie 收下了。
//   RequireToken :只给 `/api/turn`、`/api/reset` —— 它们能花钱、能清历史。

import { randomUUID } from "node:crypto";
import { Effect, type Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { TOKEN_COOKIE } from "./_constants.ts";
import { hasToken, isLoopbackHost, isSameOrigin } from "./_util.ts";

/** 本次启动的一次性令牌:进程换了就失效。 */
const token = randomUUID();

const cookie = { path: "/", httpOnly: true, sameSite: "strict" } as const;

const withCookie = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setCookieUnsafe(TOKEN_COOKIE, token, cookie)(response);

const unauthorized = withCookie(
  HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 }),
);

/** 全局:回环 + 同源,并且每个响应都带上令牌 cookie。 */
export const Guard: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.middleware(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!isLoopbackHost(request.headers["host"]) || !isSameOrigin(request)) return unauthorized;
      return withCookie(yield* app);
    }),
  { global: true },
);

/** 路由级:只有带令牌的请求能进 `/api/turn`、`/api/reset`。 */
export const RequireToken: Layer.Layer<never> = HttpRouter.middleware((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return hasToken(request, token) ? yield* app : unauthorized;
  }),
).layer;
