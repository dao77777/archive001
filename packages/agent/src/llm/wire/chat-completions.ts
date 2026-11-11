// ═══════════════════════════════════════════════════════════════════════════
// wire → DeepSeek `/chat/completions`:兼容路径,把 item 列表折叠成 message
//
//   item[] ──toWireMessages(一轮回答折成一条 assistant)──► messages[] ──POST──► choice.message
//   choice.message ──toItems──► item[]
//
// 一轮回答的三样东西(`reasoning` / 正文 / `function_call`)折成**一条** assistant 消息,
// 思维链塞进 `reasoning_content`;思考开关是 `thinking:{type}` + `reasoning_effort`。
//
// ⚠️ 回放契约(实测,见 `docs/knowledge/deepseek-api.md` 第 8 节):
//   开思考时**每条** assistant 消息都必须带 `reasoning_content`(空串也算),否则 400;
//   正文与工具调用都空的 assistant 消息必须整条丢掉 —— 它会毒死整个会话。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Redacted } from "effect";
import { CHAT_COMPLETIONS_ENDPOINT, PROVIDER_NAME } from "../_constants.ts";
import {
  LlmError,
  WireChatResponse,
  type ChatTurn,
  type Item,
  type LlmDeps,
  type ResolvedSettings,
  type ThinkingLevel,
  type ToolDefinition,
  type WireChatAssistant,
  type WireChatMessage,
} from "../_domain.ts";
import { decodeWire, postJson } from "../_util.ts";

// ---------------------------------------------------------------------------
// 请求方向:item 列表 → messages[](按一轮回答折叠)
// ---------------------------------------------------------------------------

const emptyTurn = (): ChatTurn => ({ reasoning: [], text: null, calls: [] });

/** item 列表 → messages[]:一轮回答折成一条 assistant 消息。 */
export const toWireMessages = (
  items: ReadonlyArray<Item>,
  thinking: ThinkingLevel,
): ReadonlyArray<Record<string, unknown>> => {
  const messages: Record<string, unknown>[] = [];
  let turn = emptyTurn();

  const flush = (): void => {
    const hasText = turn.text !== null && turn.text.length > 0;
    // 空 assistant 消息会被拒(content or tool_calls must be set),且会毒死整个历史
    if (hasText || turn.calls.length > 0) {
      const assistant: WireChatAssistant = {
        role: "assistant",
        content: hasText ? turn.text : null,
        ...(turn.calls.length > 0 ? { tool_calls: turn.calls } : {}),
        // 没有思维链也要给空串:这是"继续思考"的信号,不是可选装饰
        ...(thinking === "off" ? {} : { reasoning_content: turn.reasoning.join("\n\n") }),
      };
      messages.push(assistant);
    }
    turn = emptyTurn();
  };

  for (const item of items) {
    switch (item.type) {
      case "SYSTEM_MESSAGE":
      case "USER_MESSAGE":
        flush();
        messages.push({
          role: item.type === "SYSTEM_MESSAGE" ? "system" : "user",
          content: item.text,
        });
        break;

      case "ASSISTANT_MESSAGE":
        // 思维链先于正文到达,所以只在"这一轮已经有正文/调用"时才收尾
        if (turn.text !== null || turn.calls.length > 0) flush();
        turn.text = item.text;
        break;

      case "REASONING":
        turn.reasoning = [...turn.reasoning, item.text];
        break;

      case "FUNCTION_CALL":
        turn.calls = [
          ...turn.calls,
          {
            id: item.callId,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          },
        ];
        break;

      case "FUNCTION_CALL_OUTPUT":
        flush();
        messages.push({ role: "tool", tool_call_id: item.callId, content: item.output });
        break;
    }
  }

  flush();
  return messages;
};

/** 工具定义套上 chat/completions 的壳:`{type:"function", function:{…}}`。 */
const toWireTool = (tool: ToolDefinition): Record<string, unknown> => ({
  type: "function",
  function: tool,
});

/** 组 `/chat/completions` 的请求体(思考开关 + 工具 + 折叠后的 messages)。 */
export const buildRequestBody = (
  options: { readonly model: string; readonly thinking: ThinkingLevel },
  items: ReadonlyArray<Item>,
  tools: ReadonlyArray<ToolDefinition>,
): Record<string, unknown> => ({
  model: options.model,
  messages: toWireMessages(items, options.thinking),
  ...(tools.length > 0 ? { tools: tools.map(toWireTool), tool_choice: "auto" } : {}),
  // 开思考时不发 temperature(DeepSeek 会忽略它,那就别发无效字段)
  ...(options.thinking === "off"
    ? { thinking: { type: "disabled" }, temperature: 0 }
    : { thinking: { type: "enabled" }, reasoning_effort: options.thinking }),
});

// ---------------------------------------------------------------------------
// 响应方向:一条 message → item 列表
// ---------------------------------------------------------------------------

export const toItems = (message: WireChatMessage): ReadonlyArray<Item> => {
  const items: Item[] = [];

  const reasoning = message.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    items.push({ type: "REASONING", text: reasoning });
  }

  const content = message.content;
  if (typeof content === "string" && content.length > 0) {
    items.push({ type: "ASSISTANT_MESSAGE", text: content });
  }

  for (const call of message.tool_calls ?? []) {
    items.push({
      type: "FUNCTION_CALL",
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments ?? "{}",
    });
  }

  return items;
};

// ---------------------------------------------------------------------------
// 适配器:complete
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
      url: `${settings.baseUrl}${CHAT_COMPLETIONS_ENDPOINT}`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${Redacted.value(settings.apiKey)}`,
      },
      body: buildRequestBody({ model: settings.model, thinking: settings.thinking }, items, tools),
    });

    const decoded = yield* decodeWire(PROVIDER_NAME, WireChatResponse, body);
    const message = decoded.choices[0]?.message;
    if (message === undefined) {
      return yield* new LlmError({ message: `${PROVIDER_NAME} 响应里没有 choices[0].message` });
    }

    const produced = toItems(message);
    if (produced.length === 0) {
      return yield* new LlmError({ message: `${PROVIDER_NAME} 响应里既没有正文也没有工具调用` });
    }
    return produced;
  });
