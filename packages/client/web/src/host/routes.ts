// `/api/*`:三条路由。业务只在这里;准入在 `./guard.ts`。
//
//   GET  /api/state  密钥在不在、工具能碰哪个目录 —— **不要求令牌**(它就是握手)
//   POST /api/turn   一次请求 = 一条 NDJSON 事件流(见 `./session.ts`)
//   POST /api/reset  换一套服务端实例(清历史)
//
// 密钥只在宿主读;**读不到也不拒绝启动**,只是 `/api/state` 会说 hasKey=false。

import { type LlmSettings } from "@archive001/agent";
import { Effect, Layer, Redacted, Stream } from "effect";
import {
  HttpRouter,
  type HttpServerRequest as Request,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { API_PREFIX, ENV_API_KEY, ENV_API_KEY_FALLBACK, MAX_BODY_BYTES } from "./_constants.ts";
import { TurnBodySchema } from "./_domain.ts";
import { encodeNdjsonLine } from "./_util.ts";
import { RequireToken } from "./guard.ts";
import { Session } from "./session.ts";

const apiKeyFromEnv = (): Redacted.Redacted<string> | undefined => {
  const raw = (process.env[ENV_API_KEY] ?? process.env[ENV_API_KEY_FALLBACK] ?? "").trim();
  return raw.length === 0 ? undefined : Redacted.make(raw);
};

const badRequest = (error: string) => HttpServerResponse.jsonUnsafe({ error }, { status: 400 });

const state = HttpRouter.add(
  "GET",
  `${API_PREFIX}/state`,
  Effect.sync(() =>
    HttpServerResponse.jsonUnsafe({ hasKey: apiKeyFromEnv() !== undefined, cwd: process.cwd() }),
  ),
);

const turn = HttpRouter.add("POST", `${API_PREFIX}/turn`, (request: Request.HttpServerRequest) =>
  Effect.gen(function* () {
    const apiKey = apiKeyFromEnv();
    if (apiKey === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: `宿主缺少密钥:启动时设置 ${ENV_API_KEY}` },
        { status: 503 },
      );
    }

    // 一次 turn 只是一句话:先看声明的长度,不让它把内存撑爆
    if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
      return HttpServerResponse.jsonUnsafe({ error: "请求体太大" }, { status: 413 });
    }

    // 字段缺失 / 档位写错 → Schema 错误 → 框架回 400(不用手写判断)
    const body = yield* HttpServerRequest.schemaBodyJson(TurnBodySchema);
    const input = body.input.trim();
    if (input.length === 0) return badRequest("input 不能为空");

    const settings: LlmSettings = { apiKey, ...body.settings };
    const session = yield* Session;

    return HttpServerResponse.stream(
      session.turn(input, settings).pipe(Stream.map(encodeNdjsonLine)),
      {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }),
);

const reset = HttpRouter.add("POST", `${API_PREFIX}/reset`, () =>
  Effect.gen(function* () {
    const session = yield* Session;
    yield* session.reset;
    return HttpServerResponse.jsonUnsafe({ ok: true });
  }),
);

/** 其它 `/api/*` 一律 JSON 404(别落到静态资源的兜底里)。 */
const notFound = HttpRouter.add(
  "*",
  `${API_PREFIX}/*`,
  HttpServerResponse.jsonUnsafe({ error: "not found" }, { status: 404 }),
);

/**
 * 令牌只守在"能花钱 / 能清历史"的两条上;`state` 放行是握手所必需的:
 * 它的响应里带着 cookie(见 `./guard.ts` 的 `Guard`)。
 */
export const ApiRoutes = Layer.mergeAll(
  Layer.mergeAll(turn, reset).pipe(Layer.provide(RequireToken)),
  state,
  notFound,
);
