// ═══════════════════════════════════════════════════════════════════════════
// Events 契约:所有事件的唯一出口
//
// `publish` 入队 + 推流,`stream` 是完整事件流。
//
// 实现在 `./live.ts`。
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect, type Stream } from "effect";
import type { ArchiveEntry, ArchiveEntryTag } from "../../archive/service.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/** `append` 之前的事件形状:`Entry` 去掉 archive 补的 `v` / `at`。 */
type EntryInput<T extends ArchiveEntryTag = ArchiveEntryTag> = T extends ArchiveEntryTag
  ? Omit<ArchiveEntry<T>, "v" | "at">
  : never;

/** 发事件的口子:由 `EventsLive` 提供(内部是 archive 队列 + PubSub)。 */
export type EventPublisher = (event: EntryInput) => Effect.Effect<void>;

/**
 * archive 的 hook 点:一条事件写入前调用,返回真正要写入的条目。
 * 可以插入(如 `TURN_START` / `TURN_END`)、改写(`parentId`)、或丢弃(返回空数组)。
 */
export type EventHook = (entry: ArchiveEntry) => Effect.Effect<ReadonlyArray<ArchiveEntry>>;

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** `Events` 服务:所有事件的唯一出口(archive + 实时流)。 */
export interface EventsShape {
  readonly publish: EventPublisher;
  /**
   * 开始新的一段 run:清掉上一次 `ENGINE_END` 的"补发",让新订阅者不会先收到旧终点。
   * 由 `Loop.run` 在 fork 引擎之前调;archive 失败的回放不清(它跨 run 有效)。
   */
  readonly begin: Effect.Effect<void>;
  /** 设置 archive 的 hook(`undefined` = 不插任何东西);由 `Loop.run` 在 fork 前调。 */
  readonly setHook: (hook: EventHook | undefined) => Effect.Effect<void>;
  /** 完整事件流;晚订阅会先补当前这段的 `ENGINE_END` / archive 失败。 */
  readonly stream: Stream.Stream<ArchiveEntry>;
}

/** `Events` 服务 Tag(实现见 `EventsLive`)。只由 `AgentLive` 装配,不从 SDK 导出。 */
export class Events extends Context.Service<Events, EventsShape>()("Events") {}
