// ═══════════════════════════════════════════════════════════════════════════
// Projection 契约:投影的数据形状 + 服务形状
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";
import type { ArchiveEntry, SessionId } from "../service.ts";
import type { Item } from "../../llm/_domain.ts";
import type { InboxMessage } from "../../loop/inbox/service.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/**
 * 全局的 inbox 视图(字段名与 `loop/inbox/service.ts` 一致):
 * `queue` 是还没被取走的,`staged` 是已经出队、但没进任何 step 的。
 */
export interface InboxProjection {
  readonly queue: ReadonlyArray<InboxMessage>;
  readonly staged: ReadonlyArray<InboxMessage>;
}

/** `Archive.projection(kind)` 能取的投影。 */
export interface Projections {
  /** 当前引擎的对话历史(下一步要发给模型的东西)。 */
  readonly transcript: ReadonlyArray<Item>;
  readonly inbox: InboxProjection;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** `Projection` 服务的形状。 */
export interface ProjectionShape {
  /**
   * 初始化:拿一整份日志把投影从头折一遍(先重置,再全量折叠)。
   * 构建时用;和 `advance` 的区别是它**现在就折**,不留到读的时候。
   */
  readonly init: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void>;
  /** 接手一批**新**条目(`Archive.append`)。只入队,不折,留到下一次 `get`。 */
  readonly advance: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void>;
  /**
   * 切到某个会话:当前投影状态换成它的;没有条目时就是空会话。
   * 所有条目都已在 `allEntries` 里,切换时按 `sessionId` 重新折叠。
   */
  readonly setSession: (sessionId: SessionId) => Effect.Effect<void>;
  /** 取一类投影;取之前把攒着的条目折进去。 */
  readonly get: <K extends keyof Projections>(kind: K) => Effect.Effect<Projections[K]>;
}

/** `Projection` 服务 Tag(实现见 `ProjectionLive`)。由 `ArchiveLive` 依赖,SDK 也导出。 */
export class Projection extends Context.Service<Projection, ProjectionShape>()("Projection") {}
