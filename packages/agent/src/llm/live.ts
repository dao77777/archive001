// ═══════════════════════════════════════════════════════════════════════════
// Llm:把一次调用交给内部选定的 wire 适配器(默认 `responses`)
//
//   complete(items, tools, settings) ──► 补缺省值(resolveSettings)──► wire.complete
//        └─ 装配时固定 HTTP 客户端;调用方看不见 wire 的选择
//
// 走哪条 wire 由 `DEFAULT_WIRE` 决定 —— 调用方无从选择,也就不必知道。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { DEFAULT_WIRE } from "./_constants.ts";
import { complete as chatCompletionsComplete } from "./wire/chat-completions.ts";
import type { LlmDeps } from "./_domain.ts";
import { resolveSettings } from "./_util.ts";
import { complete as responsesComplete } from "./wire/responses.ts";
import { Llm, type LlmShape } from "./service.ts";

/**
 * 只做接线、不做任何 `provide`:HTTP 客户端由外面的 `LlmLive`(或测试)给。
 *
 * `Llm` 不持有任何设置:`apiKey`(必填)/ `model` / `thinking` / `baseUrl`(可省,有缺省)
 * 都是 `complete` 的入参,所以同一个实例可以被不同调用用不同模型、不同 key、不同端点打。
 */
export const LlmRuntime: Layer.Layer<Llm, never, HttpClient.HttpClient> = Layer.effect(
  Llm,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const client = yield* HttpClient.HttpClient;
    const deps: LlmDeps = { client };

    // -----------------------------------------------------------------------
    // 对外方法:complete
    // -----------------------------------------------------------------------
    // 缺省值只在服务边界补一次:适配器拿到的永远是 ResolvedSettings
    const complete: LlmShape["complete"] = (items, tools, settings) => {
      const wire = DEFAULT_WIRE === "responses" ? responsesComplete : chatCompletionsComplete;
      return wire(deps, items, tools, resolveSettings(settings));
    };

    return Llm.of({ complete });
  }),
);

/** 构建好的版本:HTTP 客户端用 `FetchHttpClient`,外面拿到就能用。 */
export const LlmLive: Layer.Layer<Llm> = LlmRuntime.pipe(Layer.provide(FetchHttpClient.layer));
