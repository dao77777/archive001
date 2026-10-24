// DeepSeek 的 `/responses`:本项目的内部模型就是它的 item 列表,所以这里几乎只做搬运。
//   - 输入 `input[]`,系统提示提到顶层 `instructions`;
//   - 思考档位 `reasoning:{effort}`,其中 `none` 关思考;
//   - 思维链是明文 `reasoning` item 的 `content[].reasoning_text`;
//   - **无状态**:服务端不存任何东西,历史只能由调用方全量重发。
//
// ⚠️ 回放契约(实测,见 `docs/knowledge/deepseek-api.md` 第 8 节):
//   开思考时每轮 `function_call` 之前都要有 `reasoning` item,且 `reasoning_text` **非空**;
//   历史里出现第二轮工具调用时缺了它必 400。

import { Effect, Redacted } from "effect";
import { PROVIDER_NAME, RESPONSES_ENDPOINT } from "./_constants.ts";
import {
  LlmError,
  WireResponsesBody,
  type Item,
  type LlmDeps,
  type ResolvedSettings,
  type ThinkingLevel,
  type ToolDefinition,
  type WireResponsesItem,
} from "./_domain.ts";
import { decodeWire, partTextsOf, postJson } from "./_util.ts";

// ---------------------------------------------------------------------------
// 请求方向:item → input[]
// ---------------------------------------------------------------------------

const toWireItem = (item: Item, thinking: ThinkingLevel): ReadonlyArray<unknown> => {
  switch (item.type) {
    case "message":
      // 系统提示走顶层 instructions,不是 input item
      if (item.role === "system") return [];
      return [
        {
          type: "message",
          role: item.role,
          content: [
            { type: item.role === "assistant" ? "output_text" : "input_text", text: item.text },
          ],
        },
      ];

    case "reasoning":
      // 关思考时不回放;空文本会让服务端报 "reasoning_text must be passed back"
      if (thinking === "off" || item.text.length === 0) return [];
      return [{ type: "reasoning", content: [{ type: "reasoning_text", text: item.text }] }];

    case "function_call":
      // 不带 item id:回放只需要 call_id 与 function_call_output 配对
      return [
        {
          type: "function_call",
          call_id: item.callId,
          name: item.name,
          arguments: item.arguments,
        },
      ];

    case "function_call_output":
      return [{ type: "function_call_output", call_id: item.callId, output: item.output }];
  }
};

/** 工具定义在 responses 里是**扁平**的:没有 chat/completions 那层 `function`。 */
const toWireTool = (tool: ToolDefinition): Record<string, unknown> => ({
  type: "function",
  ...tool,
});

/** 组 `/responses` 的请求体(input items、instructions、思考档位)。 */
export const buildRequestBody = (
  options: { readonly model: string; readonly thinking: ThinkingLevel },
  items: ReadonlyArray<Item>,
  tools: ReadonlyArray<ToolDefinition>,
): Record<string, unknown> => {
  const instructions = items
    .flatMap((item) => (item.type === "message" && item.role === "system" ? [item.text] : []))
    .join("\n\n");

  return {
    model: options.model,
    input: items.flatMap((item) => toWireItem(item, options.thinking)),
    ...(instructions.length > 0 ? { instructions } : {}),
    ...(tools.length > 0 ? { tools: tools.map(toWireTool), tool_choice: "auto" } : {}),
    // `off` 就是 `none`(DeepSeek 用它关思考)
    reasoning: { effort: options.thinking === "off" ? "none" : options.thinking },
    // 刻意不发 temperature:思考模式下它无效
  };
};

// ---------------------------------------------------------------------------
// 响应方向:output[] → item
// ---------------------------------------------------------------------------

export const toItems = (wireItems: ReadonlyArray<WireResponsesItem>): ReadonlyArray<Item> => {
  const items: Item[] = [];

  for (const wireItem of wireItems) {
    switch (wireItem.type) {
      case "reasoning": {
        const text = partTextsOf(wireItem.content ?? []).join("\n");
        if (text.length > 0) items.push({ type: "reasoning", text });
        break;
      }

      case "message": {
        const text = partTextsOf(wireItem.content ?? [], "output_text").join("");
        if (text.length > 0) items.push({ type: "message", role: "assistant", text });
        break;
      }

      case "function_call":
        items.push({
          type: "function_call",
          callId: wireItem.call_id ?? "",
          name: wireItem.name ?? "",
          arguments: wireItem.arguments ?? "{}",
        });
        break;

      default:
        break; // 本项目不用的 item 类型(内置工具调用等)
    }
  }

  return items;
};

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export const complete = (
  deps: LlmDeps,
  items: ReadonlyArray<Item>,
  tools: ReadonlyArray<ToolDefinition>,
  settings: ResolvedSettings,
): Effect.Effect<ReadonlyArray<Item>, LlmError> =>
  Effect.gen(function* () {
    const body = yield* postJson({
      client: deps.client,
      provider: PROVIDER_NAME,
      url: `${settings.baseUrl}${RESPONSES_ENDPOINT}`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${Redacted.value(settings.apiKey)}`,
      },
      body: buildRequestBody({ model: settings.model, thinking: settings.thinking }, items, tools),
    });

    const decoded = yield* decodeWire(PROVIDER_NAME, WireResponsesBody, body);

    const failure = decoded.error?.message;
    if (typeof failure === "string" && failure.length > 0) {
      return yield* new LlmError({ message: `${PROVIDER_NAME} 返回失败:${failure}` });
    }

    // ⚠️ status=failed/incomplete 时 HTTP 仍是 200;不检查就会变成一个「静默的空回答」
    const reason = decoded.incomplete_details?.reason;
    if (decoded.status === "failed" || decoded.status === "incomplete") {
      return yield* new LlmError({
        message: `${PROVIDER_NAME} 响应不完整(status=${decoded.status}${
          typeof reason === "string" ? `, reason=${reason}` : ""
        })`,
      });
    }

    const output = decoded.output ?? [];
    if (output.length === 0) {
      return yield* new LlmError({
        message: `${PROVIDER_NAME} 响应里没有 output items(status=${decoded.status ?? "unknown"})`,
      });
    }

    const produced = toItems(output);
    if (produced.length === 0) {
      return yield* new LlmError({ message: `${PROVIDER_NAME} 响应里没有可用 item` });
    }
    return produced;
  });
