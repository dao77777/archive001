// `Llm` 服务与 `LlmLive`:把一次调用交给内部选定的 wire 适配器(默认 `responses`)。
// 服务不持有任何设置:模型 / 档位 / 密钥 / 端点全在 `complete(…, settings)` 里。

import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { DEFAULT_WIRE } from "./_constants.ts";
import { complete as chatCompletionsComplete } from "./chat-completions.ts";
import type { LlmDeps, LlmShape } from "./_domain.ts";
import { resolveSettings } from "./_util.ts";
import { complete as responsesComplete } from "./responses.ts";

/** `Llm` 服务 Tag:调用方只依赖这个 Tag,不关心底下是哪条 wire。 */
export class Llm extends Context.Service<Llm, LlmShape>()("Llm") {}

/**
 * `Llm` 不持有任何设置:`apiKey`(必填)/ `model` / `thinking` / `baseUrl`(可省,有缺省)
 * 都是 `complete` 的入参,
 * 所以同一个实例可以被不同调用用不同模型、不同 key、不同端点打。
 * 走哪条 wire 由 `DEFAULT_WIRE` 决定 —— 调用方无从选择,也就不必知道。
 */
export const LlmLive: Layer.Layer<Llm, never, never> = Layer.effect(
  Llm,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const deps: LlmDeps = { client };

    // 缺省值只在服务边界补一次:适配器拿到的永远是 ResolvedSettings
    const complete: LlmShape["complete"] = (items, tools, settings) => {
      const wire = DEFAULT_WIRE === "responses" ? responsesComplete : chatCompletionsComplete;
      return wire(deps, items, tools, resolveSettings(settings));
    };

    return Llm.of({ complete });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
