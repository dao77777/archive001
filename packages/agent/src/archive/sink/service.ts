// ═══════════════════════════════════════════════════════════════════════════
// Sink 契约:存储适配器(文件 / 内存)
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";
import type { ArchiveEntry, ArchiveError } from "../service.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/**
 * 存储适配器(文件 / 内存)。批量写,单 writer 顺序调用;读是**读侧**用的,可随时调用。
 * `read` 只返回**已落盘**的条目:同一实例刚 append、还在队列里的批不在里面。
 */
export interface SinkShape {
  readonly write: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void, ArchiveError>;
  readonly read: Effect.Effect<ReadonlyArray<ArchiveEntry>, ArchiveError>;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
export class Sink extends Context.Service<Sink, SinkShape>()("Sink") {}
