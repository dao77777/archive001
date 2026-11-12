// `/api/*`:archive001 自己的业务,框架件在 `./framework.ts`。
//
// 这里是**声明式**的:先用 `HttpApiEndpoint` 写清"每条路由收什么、回什么、错什么",
// 再在 `HttpApiBuilder.group` 里实现。handler 拿到的是解好的 `payload`,形状在签名上。
//
//   常量 → 安全闸(策略)→ Schema(请求 / 响应 / 错误)→ 端点 → 实现 → 装配
//
// 密钥只在宿主读;**读不到也不拒绝启动**,只是 `/api/state` 会说 hasKey=false。

import { makeSessionId, ThinkingLevel, type LlmSettings } from "@archive001/agent";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";
import {
  encodeNdjsonLine,
  hasToken,
  HTTP_ERR_NOT_FOUND,
  HTTP_ERR_TOO_LARGE,
  HTTP_ERR_UNAUTHORIZED,
  isLoopbackHost,
  isSameOrigin,
  newTokenCookie,
} from "./framework.ts";
import { Session } from "./session.ts";

// ── 常量 ──────────────────────────────────────────────────────────────────

const TOKEN_COOKIE = "archive001_token";

/** 要令牌的两条:能花钱(turn)/ 能清历史(reset、换会话) */
const NEEDS_TOKEN = new Set(["/api/turn", "/api/reset", "/api/sessions/open"]);

/** 密钥只从这两处读(与 cli / repl 保持一致) */
const ENV_API_KEY = "DEEPSEEK_API_KEY";
const ENV_API_KEY_FALLBACK = "API_KEY";

/** 请求体上限:一次请求只是一句话,64KB 绰绰有余 */
const MAX_BODY_BYTES = 64 * 1024;

const apiKeyFromEnv = (): Redacted.Redacted<string> | undefined => {
  const raw = (process.env[ENV_API_KEY] ?? process.env[ENV_API_KEY_FALLBACK] ?? "").trim();
  return raw.length === 0 ? undefined : Redacted.make(raw);
};

// ── 安全闸(策略;判据在 framework) ─────────────────────────────────────

const { token, apply: withCookie } = newTokenCookie(TOKEN_COOKIE);

/** 401 也要带 cookie:它就是握手的一环。 */
const unauthorized = withCookie(HTTP_ERR_UNAUTHORIZED());

/**
 * 全局闸。三道,顺序即代价从低到高:
 *   ① Host 回环 + Origin 同源 —— 挡 DNS rebinding 与别的站点
 *   ② 带 body 的路由先看 `content-length` —— 413,不读流
 *   ③ 能花钱 / 能清历史的三条要令牌 —— 401
 * 顺带给**每个**响应种令牌 cookie:dev 期页面在 Vite 那边,
 * 浏览器第一次调 `/api/state` 就把 cookie 收下了(握手)。
 */
export const Guard: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.middleware(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!isLoopbackHost(request.headers["host"]) || !isSameOrigin(request)) return unauthorized;

      const path = request.url.split("?")[0] ?? request.url;
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
        return withCookie(HTTP_ERR_TOO_LARGE());
      }
      if (NEEDS_TOKEN.has(path) && !hasToken(request, TOKEN_COOKIE, token)) return unauthorized;

      return withCookie(yield* app);
    }),
  { global: true },
);

// ── Schema:请求 ───────────────────────────────────────────────────────────

/** 浏览器能改的只有模型与档位;密钥不来自浏览器。 */
const TurnBody = Schema.Struct({
  input: Schema.String,
  settings: Schema.optional(
    Schema.Struct({
      model: Schema.optional(Schema.String),
      thinking: Schema.optional(ThinkingLevel),
    }),
  ),
});

const OpenSessionBody = Schema.Struct({ id: Schema.String });

// ── Schema:响应 ───────────────────────────────────────────────────────────

const HostState = Schema.Struct({ hasKey: Schema.Boolean, cwd: Schema.String });

const SessionSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  at: Schema.Number,
  entries: Schema.Number,
  current: Schema.Boolean,
});

const SessionList = Schema.Struct({
  current: Schema.String,
  sessions: Schema.Array(SessionSummary),
});

/** archive 条目由内核定义,这里不重复声明,原样透传。 */
const OpenResult = Schema.Struct({
  ok: Schema.Boolean,
  id: Schema.String,
  entries: Schema.Array(Schema.Unknown),
});

const ResetResult = Schema.Struct({ ok: Schema.Boolean, id: Schema.String });

/** NDJSON 事件流:一行一个 JSON,浏览器边读边渲染。 */
const TurnStream = HttpApiSchema.StreamUint8Array({
  contentType: "application/x-ndjson; charset=utf-8",
});

// ── Schema:错误 ───────────────────────────────────────────────────────────
//
// 带 `_tag` 是为了让"同一个端点两种错误"能被区分开(400 vs 503);
// 状态码用 `HttpApiSchema.status`,响应体仍是 `{ _tag, error }`。

const BadRequest = HttpApiSchema.status(400)(
  Schema.Struct({ _tag: Schema.Literal("BadRequest"), error: Schema.String }),
);

const ServiceUnavailable = HttpApiSchema.status(503)(
  Schema.Struct({ _tag: Schema.Literal("ServiceUnavailable"), error: Schema.String }),
);

// ── 端点(声明) ───────────────────────────────────────────────────────────

const E = HttpApiEndpoint;

const endpoints = [
  /** 握手:密钥在不在、工具能碰哪个目录。**不要求令牌**。 */
  E.get("state", "/api/state", { success: HostState }),
  /** 会话列表(最近活动在前)。 */
  E.get("sessions", "/api/sessions", { success: SessionList }),
  /** 切到某个会话,返回它的原始条目。 */
  E.post("openSession", "/api/sessions/open", {
    payload: OpenSessionBody,
    success: OpenResult,
    error: BadRequest,
  }),
  /** 一次请求 = 一条 NDJSON 事件流。 */
  E.post("turn", "/api/turn", {
    payload: TurnBody,
    success: TurnStream,
    error: [BadRequest, ServiceUnavailable],
  }),
  /** 换一套服务端实例 + 开新 archive 会话。 */
  E.post("reset", "/api/reset", { success: ResetResult }),
] as const;

const WebGroup = HttpApiGroup.make("web").add(...endpoints);

export const Api = HttpApi.make("archive001").add(WebGroup);

// ── 实现 ──────────────────────────────────────────────────────────────────

export const ApiLive = HttpApiBuilder.group(Api, "web", (handlers) =>
  handlers
    .handle("state", () =>
      Effect.sync(() => ({ hasKey: apiKeyFromEnv() !== undefined, cwd: process.cwd() })),
    )
    .handle("sessions", () =>
      Effect.gen(function* () {
        const session = yield* Session;
        return { current: yield* session.current, sessions: yield* session.sessions };
      }),
    )
    .handle("openSession", ({ payload }) =>
      Effect.gen(function* () {
        const id = payload.id.trim();
        if (id.length === 0) {
          return yield* Effect.fail({ _tag: "BadRequest" as const, error: "id 不能为空" });
        }
        const session = yield* Session;
        const sessionId = makeSessionId(id);
        return { ok: true, id: sessionId, entries: yield* session.open(sessionId) };
      }),
    )
    .handle("turn", ({ payload }) =>
      Effect.gen(function* () {
        const apiKey = apiKeyFromEnv();
        if (apiKey === undefined) {
          return yield* Effect.fail({
            _tag: "ServiceUnavailable" as const,
            error: `宿主缺少密钥:启动时设置 ${ENV_API_KEY}`,
          });
        }
        const input = payload.input.trim();
        if (input.length === 0) {
          return yield* Effect.fail({ _tag: "BadRequest" as const, error: "input 不能为空" });
        }
        const settings: LlmSettings = { apiKey, ...payload.settings };
        const session = yield* Session;
        return session.turn(input, settings).pipe(Stream.map(encodeNdjsonLine));
      }),
    )
    .handle("reset", () =>
      Effect.gen(function* () {
        const session = yield* Session;
        return { ok: true, id: yield* session.reset };
      }),
    ),
);

/** 其它 `/api/*` 一律 JSON 404(别落到静态资源的兜底里)。 */
export const ApiNotFound = HttpRouter.add("*", "/api/*", HTTP_ERR_NOT_FOUND());
