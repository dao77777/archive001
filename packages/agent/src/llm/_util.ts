// llm 层的全部函数:item 助手、HTTP 调用、响应解码、wire 文本提取。
// 类型与 Schema 在 `./_domain.ts`(只有声明);与领域无关的小工具在 `../_util.ts`。

import { Effect, Schema } from "effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import { formatError } from "../_util.ts";
import { DEFAULT_BASE_URL, DEFAULT_SETTINGS } from "./_constants.ts";
import {
  HttpEnvelope,
  LlmError,
  type FunctionCall,
  type Item,
  type LlmSettings,
  type PostJsonOptions,
  type ResolvedSettings,
  type WireResponsesPart,
} from "./_domain.ts";

/**
 * 补全设置的缺省值:**整个库里只有这里给缺省赋值**。
 * 只有 `apiKey` 必填;`model` / `thinking` / `baseUrl` 缺省取自 `_constants.ts`。
 */
export const resolveSettings = (settings: LlmSettings): ResolvedSettings => ({
  apiKey: settings.apiKey,
  model: settings.model ?? DEFAULT_SETTINGS.model,
  thinking: settings.thinking ?? DEFAULT_SETTINGS.thinking,
  baseUrl: (settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
});

/**
 * 发一个 JSON POST 并拿回解析后的 body。两条 wire 共用:
 * 非 2xx 一律转成带原始 body 片段的 `LlmError`(便于把厂商的报错原样看到)。
 */
export const postJson = (options: PostJsonOptions): Effect.Effect<unknown, LlmError> =>
  Effect.gen(function* () {
    let request = HttpClientRequest.post(options.url);
    for (const [key, value] of Object.entries(options.headers)) {
      request = HttpClientRequest.setHeader(request, key, value);
    }
    const withBody = yield* HttpClientRequest.bodyJson(options.body)(request);

    const envelope = yield* options.client
      .execute(withBody)
      .pipe(Effect.flatMap(HttpClientResponse.schemaJson(HttpEnvelope)));

    if (envelope.status < 200 || envelope.status >= 300) {
      return yield* new LlmError({
        message: `${options.provider} 返回 HTTP ${envelope.status}:${JSON.stringify(envelope.body).slice(0, 400)}`,
      });
    }
    return envelope.body;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof LlmError
        ? cause
        : new LlmError({ message: `调用 ${options.provider} 失败:${formatError(cause)}`, cause }),
    ),
  );

/** 解码厂商响应;失败时给出可读原因。 */
export const decodeWire = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
  provider: string,
  schema: S,
  body: unknown,
): Effect.Effect<S["Type"], LlmError> =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (issue) => new LlmError({ message: `无法解析 ${provider} 响应:${formatError(issue)}` }),
    ),
  );

/** 从 wire part 里取文本(可只取某种 `part.type`);`text?: null` 不会流进字符串。 */
export const partTextsOf = (
  parts: ReadonlyArray<WireResponsesPart>,
  type?: string,
): ReadonlyArray<string> =>
  parts.flatMap((part) => {
    if (type !== undefined && part.type !== type) return [];
    return typeof part.text === "string" && part.text.length > 0 ? [part.text] : [];
  });

// ---------------------------------------------------------------------------
// item 助手:命名跟 `Item.type` 走,不用字段名。
//   `xxxOf`      → 取该类 item 本身(如 `functionCallsOf`)
//   `xxxTextsOf` → 取该类 item 的 `text`(如 `messageTextsOf`)
// ---------------------------------------------------------------------------

/** 按 `Item.type` 取同类项;泛型保证返回类型被收窄。 */
export const itemsOfType = <T extends Item["type"]>(
  items: ReadonlyArray<Item>,
  type: T,
): ReadonlyArray<Extract<Item, { readonly type: T }>> =>
  items.filter((item): item is Extract<Item, { readonly type: T }> => item.type === type);

/** 各条 `ASSISTANT_MESSAGE` 的文本(按出现顺序;空串已滤掉)。 */
export const assistantTextsOf = (items: ReadonlyArray<Item>): ReadonlyArray<string> =>
  itemsOfType(items, "ASSISTANT_MESSAGE")
    .map((item) => item.text)
    .filter((text) => text.length > 0);

/** 各条 `REASONING` 的文本(按出现顺序)。 */
export const reasoningTextsOf = (items: ReadonlyArray<Item>): ReadonlyArray<string> =>
  itemsOfType(items, "REASONING")
    .map((item) => item.text)
    .filter((text) => text.length > 0);

/** 本轮产出的工具调用。 */
export const functionCallsOf = (items: ReadonlyArray<Item>): ReadonlyArray<FunctionCall> =>
  itemsOfType(items, "FUNCTION_CALL");
