// 宿主的契约(只放声明):请求体 Schema、事件流的一行、会话的形状。
// `/api/turn` 的 body 就是这两层:`settings` 只有模型与档位(密钥不来自浏览器)。

import {
  ThinkingLevel,
  type ArchiveEntry,
  type LlmSettings,
  type SessionId,
} from "@archive001/agent";
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

/** 打开已有会话:只带 id。 */
export const OpenSessionBodySchema = Schema.Struct({
  id: Schema.String,
});

export type OpenSessionBody = typeof OpenSessionBodySchema.Type;

/** 事件流的一行:`ArchiveEntry` 照抄,外加两种终止行。 */
export type TurnEvent =
  | ArchiveEntry
  | { readonly _tag: "ANSWER"; readonly text: string }
  | { readonly _tag: "ERROR"; readonly text: string };

/** 会话列表里的一行。 */
export interface SessionSummary {
  readonly id: string;
  /** 第一条用户消息的第一行;没有就显示"新会话"。 */
  readonly title: string;
  /** 最后一条条目的时间(epoch ms)。 */
  readonly at: number;
  readonly entries: number;
  readonly current: boolean;
}

/** 会话(`./session.ts` 的 `Session` 服务的形状):一个进程管理一套层 + 多个 archive 会话。 */
export interface SessionShape {
  /** 一次请求 = 一个事件流(最后一行是 answer 或 error)。 */
  readonly turn: (input: string, settings: LlmSettings) => Stream.Stream<TurnEvent>;
  /** 开新会话(换一套层并 `Archive.startSession`),返回新 id。 */
  readonly reset: Effect.Effect<SessionId>;
  /** 列出 archive 里的会话(最近活动在前)。 */
  readonly sessions: Effect.Effect<ReadonlyArray<SessionSummary>>;
  /** 当前会话 id。 */
  readonly current: Effect.Effect<SessionId>;
  /** 切到某个会话,返回它的原始条目。 */
  readonly open: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ArchiveEntry>>;
}
