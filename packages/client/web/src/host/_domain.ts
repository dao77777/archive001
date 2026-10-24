// 宿主的契约(只放声明):请求体 Schema、事件流的一行、会话的形状。
// `/api/turn` 的 body 就是这两层:`settings` 只有模型与档位(密钥不来自浏览器)。

import { ThinkingLevel, type AgentEvent, type LlmSettings } from "@archive001/agent";
import { Schema, type Effect, type Stream } from "effect";

/** 浏览器能改的部分;字段缺省即用 SDK 的缺省值。 */
export const TurnSettingsSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(ThinkingLevel),
});

/**
 * 一次 turn 的请求体。用 Schema 而不是手写 if:字段缺失 / 档位写错 → 框架回 400。
 */
export const TurnBodySchema = Schema.Struct({
  input: Schema.String,
  settings: Schema.optional(TurnSettingsSchema),
});

export type TurnBody = typeof TurnBodySchema.Type;

/** 事件流的一行:`AgentEvent` 照抄,外加两种终止行。 */
export type TurnEvent =
  | AgentEvent
  | { readonly _tag: "answer"; readonly text: string }
  | { readonly _tag: "error"; readonly text: string };

/** 会话(`./session.ts` 的 `Session` 服务的形状):一次进程 = 一个会话。 */
export interface SessionShape {
  /** 一次请求 = 一个事件流(最后一行是 answer 或 error)。 */
  readonly turn: (input: string, settings: LlmSettings) => Stream.Stream<TurnEvent>;
  /** 清空会话:换一套服务端实例。 */
  readonly reset: Effect.Effect<void>;
}
