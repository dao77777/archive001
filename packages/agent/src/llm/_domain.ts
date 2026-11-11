// llm 层的类型与 Schema(不含函数):思考档位、对话 item、设置、工具定义、错误、HTTP 信封、
// 两条 wire 的报文 Schema。服务形状在 `./service.ts`,实现分别在 `./live.ts` 与 `./wire/`。

import { Data, Schema } from "effect";
import type { Redacted } from "effect";
import type { HttpClient } from "effect/http";

// ---------------------------------------------------------------------------
// 思考档位
// ---------------------------------------------------------------------------

/**
 * 与 DeepSeek 官方的 effort 取值**同名**,不另造词:
 *   off          → 不请求思考
 *   low/high/max → 原样作为 `reasoning_effort` / `reasoning.effort` 发出
 */
export const ThinkingLevel = Schema.Literals(["off", "low", "high", "max"]);
export type ThinkingLevel = typeof ThinkingLevel.Type;

// ---------------------------------------------------------------------------
// Item:对话就是一条 item 列表(形状向 Responses API 看齐)
// ---------------------------------------------------------------------------

/**
 * 一条对话 item。**这就是本项目的主模型**:`/responses` 的 `input[]` 几乎能直接映射,
 * `/chat/completions` 则是把 item 折叠成 message 的兼容路径(见 `chat-completions.ts`)。
 *
 * 角色直接编进 `type`:一个 `type` 既是角色也是内容形状。
 *
 * | Item                    | Responses wire                                   | chat/completions wire              |
 * | ----------------------- | ------------------------------------------------ | ---------------------------------- |
 * | `SYSTEM_MESSAGE`        | 顶层 `instructions`                              | `{role:"system", content}`         |
 * | `USER_MESSAGE`          | `{type:"message", role:"user", …}`               | `{role:"user", content}`           |
 * | `ASSISTANT_MESSAGE`     | `{type:"message", role:"assistant", …}`          | assistant 的 `content`             |
 * | `REASONING`             | `{type:"reasoning", content:[{reasoning_text}]}` | assistant 上的 `reasoning_content` |
 * | `FUNCTION_CALL`         | `{type:"function_call", call_id, name, args}`    | assistant 上的 `tool_calls[]`      |
 * | `FUNCTION_CALL_OUTPUT`  | `{type:"function_call_output", call_id, output}` | `{role:"tool", tool_call_id, …}`   |
 */
export type Item =
  | { readonly type: "SYSTEM_MESSAGE"; readonly text: string }
  | { readonly type: "USER_MESSAGE"; readonly text: string }
  | { readonly type: "ASSISTANT_MESSAGE"; readonly text: string }
  | { readonly type: "REASONING"; readonly text: string }
  | {
      readonly type: "FUNCTION_CALL";
      readonly callId: string;
      readonly name: string;
      /** 模型给的参数,原样 JSON 字符串;解析与校验在 `tools.ts` */
      readonly arguments: string;
    }
  | { readonly type: "FUNCTION_CALL_OUTPUT"; readonly callId: string; readonly output: string };

/** 工具调用 item 的别名(`functionCallsOf` 的元素类型)。 */
export type FunctionCall = Extract<Item, { readonly type: "FUNCTION_CALL" }>;

// ---------------------------------------------------------------------------
// wire 选择
// ---------------------------------------------------------------------------

/**
 * 传输实现:`responses`(主路径)与 `chat`(兼容路径)。
 * ⚠️ **不是用户配置**:由 `llm/_constants.ts` 的 `DEFAULT_WIRE` 决定。
 */
export type Wire = "responses" | "chat";

// ---------------------------------------------------------------------------
// 工具定义(语义形状;套 wire 的壳由两条适配器负责)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema,由 Effect Schema 生成,见 `tools.ts` */
  readonly parameters: unknown;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export class LlmError extends Data.TaggedError("LLM_ERROR")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// wire 适配器的依赖
// ---------------------------------------------------------------------------

/**
 * 一次调用的**全部**设置:行为参数 + 连接事实。
 *
 * - **只有 `apiKey` 必填**;`model` / `thinking` / `baseUrl` 都可省,省了用
 *   `llm/_constants.ts` 的缺省值(在 `LlmLive` 里一次补全,见 `resolveSettings`);
 * - 连接也在设置里 —— 没有"全局 config 服务":同一进程用两个 key 打两个端点很正常;
 * - 走哪条 wire 仍然**不是设置**:那是 `llm/` 的内部实现(`DEFAULT_WIRE`)。
 */
export interface LlmSettings {
  /** 密钥用 `Redacted` 包住,避免被日志 / 字符串插值泄漏。**必填** */
  readonly apiKey: Redacted.Redacted<string>;
  /** 缺省 `deepseek-flash` */
  readonly model?: string;
  /** 思考档位;缺省 `high`(现阶段是启动值,将来做会话级切换时它退化为缺省值) */
  readonly thinking?: ThinkingLevel;
  /** 端点(不带结尾斜杠);缺省 DeepSeek 官方端点 */
  readonly baseUrl?: string;
}

/** 补完缺省值之后的设置:适配器只认这个形状(内部的,调用方看不到)。 */
export interface ResolvedSettings extends LlmSettings {
  readonly model: string;
  readonly thinking: ThinkingLevel;
  readonly baseUrl: string;
}

/** 客户端**持久化**的那部分设置:模型与档位(补全后,不含密钥)。 */
export type BehaviorSettings = Required<Pick<LlmSettings, "model" | "thinking">>;

/** 一条 wire 路径跑起来需要的东西:只有 HTTP 客户端(设置每次传)。 */
export interface LlmDeps {
  readonly client: HttpClient.HttpClient;
}

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

/** `HttpClientResponse.schemaJson` 解的是「信封」:状态码 + 原始 body。 */
export const HttpEnvelope = Schema.Struct({
  status: Schema.Number,
  body: Schema.Unknown,
});
export type HttpEnvelope = typeof HttpEnvelope.Type;

/** `postJson` 的入参:一次 JSON POST 需要的东西。 */
export interface PostJsonOptions {
  readonly client: HttpClient.HttpClient;
  readonly provider: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

// ---------------------------------------------------------------------------
// chat/completions wire(兼容路径)
// ---------------------------------------------------------------------------

export const WireChatToolCall = Schema.Struct({
  id: Schema.String,
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
export type WireChatToolCall = typeof WireChatToolCall.Type;

export const WireChatMessage = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.NullOr(Schema.Array(WireChatToolCall))),
});
export type WireChatMessage = typeof WireChatMessage.Type;

export const WireChatResponse = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: WireChatMessage })),
});
export type WireChatResponse = typeof WireChatResponse.Type;

/**
 * 回放时**发出**的 assistant 消息(折叠后的一轮)。
 * 用 `type` 而非 `interface`:只有类型别名能隐式符合 `Record<string, unknown>`,而它要进 `messages[]`。
 */
export type WireChatAssistant = {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<Record<string, unknown>>;
  readonly reasoning_content?: string;
};

/** 折叠 item 时的累加器:一轮回答 = 思维链 + 正文 + 若干工具调用。字段**可变**(适配器内部工作区)。 */
export interface ChatTurn {
  reasoning: ReadonlyArray<string>;
  text: string | null;
  calls: ReadonlyArray<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// responses wire(主路径)
// ---------------------------------------------------------------------------

export const WireResponsesPart = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
});
export type WireResponsesPart = typeof WireResponsesPart.Type;

export const WireResponsesItem = Schema.Struct({
  type: Schema.String,
  content: Schema.optional(Schema.NullOr(Schema.Array(WireResponsesPart))),
  call_id: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  arguments: Schema.optional(Schema.NullOr(Schema.String)),
});
export type WireResponsesItem = typeof WireResponsesItem.Type;

export const WireResponsesBody = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  incomplete_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ reason: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  error: Schema.optional(
    Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  output: Schema.optional(Schema.NullOr(Schema.Array(WireResponsesItem))),
});
export type WireResponsesBody = typeof WireResponsesBody.Type;
