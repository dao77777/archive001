// 宿主的纯判定:回环 Host、同源 Origin、令牌 cookie,以及 NDJSON 的一行。
// 没有状态,可直接单测(见 `./_util.test.ts`)。

import type { HttpServerRequest as Request } from "effect/http";
import { TOKEN_COOKIE } from "./_constants.ts";

/** `Host` 头只允许回环写法(挡 DNS rebinding:恶意域名解析到 127.0.0.1)。 */
export const isLoopbackHost = (hostHeader: string | undefined): boolean => {
  if (hostHeader === undefined) return false;
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
};

/**
 * 同源检查:有 `Origin` 就必须和 `Host` 一致(挡别的站点 fetch 本地端口);
 * 没有 `Origin`(脚本 / 同源 GET)放行。
 */
export const isSameOrigin = (request: Request.HttpServerRequest): boolean => {
  const origin = request.headers["origin"];
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers["host"];
  } catch {
    return false;
  }
};

/** `/api/turn`、`/api/reset` 的准入:必须带着本次启动发的令牌。 */
export const hasToken = (request: Request.HttpServerRequest, token: string): boolean =>
  request.cookies[TOKEN_COOKIE] === token;

const encoder = new TextEncoder();

/** 一行 NDJSON(含换行);事件流里不夹别的分隔符。 */
export const encodeNdjsonLine = (value: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(value)}\n`);
