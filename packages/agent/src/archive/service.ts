// ═══════════════════════════════════════════════════════════════════════════
// Archive 契约:entry 身份 / 事件负载 / 错误 / 服务形状
// ═══════════════════════════════════════════════════════════════════════════

import { Brand, Context, Data, type Effect, type Stream } from "effect";
import type { InboxMessage } from "../loop/inbox/service.ts";
import type { Projections } from "./projection/service.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/**
 * 一条 entry / 一个生命周期节点的身份。
 * branded:它和 inbox id、`callId` 之类都是字符串,但不是同一类东西,不能混用。
 * 造值只用下面的 `makeArchiveEntryId` / `newArchiveEntryId`,不要就地 `as` 断言。
 */
export type ArchiveEntryId = Brand.Branded<string, "ArchiveEntryId">;

/** 把已有字符串接成 entry id(不改值);反序列化 / 测试里用。 */
export const makeArchiveEntryId = Brand.nominal<ArchiveEntryId>();

/** 生成一个新的 entry id,是**唯一**正常来源。 */
export const newArchiveEntryId = (): ArchiveEntryId => makeArchiveEntryId(crypto.randomUUID());

/**
 * 一段会话的身份。一个 archive 文件里可以有多段会话;entry 按它分组。
 * 和 entry id / inbox id 一样是 branded 字符串,不能混用。
 */
export type SessionId = Brand.Branded<string, "SessionId">;

/** 把已有字符串接成 session id(不改值);反序列化 / 测试里用。 */
export const makeSessionId = Brand.nominal<SessionId>();

/** 生成一个新的 session id,是**唯一**正常来源。 */
export const newSessionId = (): SessionId => makeSessionId(crypto.randomUUID());

/** 没有 `sessionId` 的旧条目归到这里(文件迁移用,不是正常新会话)。 */
export const LEGACY_SESSION_ID: SessionId = makeSessionId("legacy");

/**
 * agent 向外发出的事件流。
 *
 * 每个事件都有 `id`;`parentId` 指向所属容器。层级只靠这两个字段:
 *
 *   ENGINE_START                     // 顶层:标记"一段运行"开始(引擎本身没有身份)
 *     TURN_START { id }
 *       STEP_START { id, parentId: turnId }
 *         SYSTEM_MESSAGE / USER_MESSAGE / FUNCTION_CALL_OUTPUT / REASONING /
 *         ASSISTANT_MESSAGE / FUNCTION_CALL { parentId: stepId }
 *       STEP_END { id: stepId, parentId: turnId }
 *     TURN_END { id: turnId }
 *   ENGINE_END                       // 顶层:标记这一段结束
 *
 * 错误是内容:`STEP_ERROR` / `TURN_ERROR` / `ENGINE_ERROR`,发完错误后照常发所属层级的 END。
 * `INBOX_OFFER` / `INBOX_TAKE` / `SYSTEM_MESSAGE_SET` / `SYSTEM_MESSAGE_CLEAR` / `ARCHIVE_ERROR`
 * 也是顶层内容(不属于某一段的容器),没有 parentId。
 * **turn / step 的 start 与 end 共用同一个 `id`**;引擎层没有 id —— 现在只有一段运行,
 * 分段靠 `ENGINE_START` / `ENGINE_END` 的先后。
 *
 * 负载分两类:**结构** = 生命周期容器,**内容** = 容器里发生的事。
 */
export interface ArchiveEntryPayloads {
  // ── 结构:生命周期容器 ──────────────────────────────────────────────
  readonly ENGINE_START: {};
  readonly ENGINE_END: {};
  readonly TURN_START: {};
  readonly TURN_END: {};
  readonly STEP_START: {};
  readonly STEP_END: {};
  // ── 内容:容器里发生的事(命名与 llm/_domain 的 Item 对齐)────────────
  readonly INBOX_OFFER: { readonly message: InboxMessage };
  readonly INBOX_TAKE: { readonly messageIds: ReadonlyArray<string> };
  // LLM 的输入:新 prompt / 工具结果(step 里发生的事)
  /** system 被设成这段文本:一个引擎运行通常只在开头设一次(`parentId` = engine)。 */
  readonly SYSTEM_MESSAGE_SET: { readonly text: string };
  /** system 被清掉:引擎收尾时发,之后的 step 不再带 system。 */
  readonly SYSTEM_MESSAGE_CLEAR: {};
  /** 一条 prompt 一条事件:只引用它对应的那条 inbox 消息。 */
  readonly USER_MESSAGE: { readonly inboxId: string };
  readonly FUNCTION_CALL_OUTPUT: { readonly inboxId: string };
  // LLM 的输出
  readonly ASSISTANT_MESSAGE: { readonly text: string };
  readonly REASONING: { readonly text: string };
  readonly FUNCTION_CALL: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: string;
  };
  // 错误放最后:描述这一步 / 轮 / 引擎的结局
  readonly STEP_ERROR: { readonly message: string; readonly cause?: string };
  readonly TURN_ERROR: { readonly message: string; readonly cause?: string };
  readonly ENGINE_ERROR: { readonly message: string; readonly cause?: string };
  // archive 挂了:对话可以继续,但之后的记录不再落盘。不写进 archive(它自己就是坏的),
  // 只出现在 `Agent.events` 上。
  readonly ARCHIVE_ERROR: { readonly message: string; readonly cause?: string };
}

export type ArchiveEntryTag = keyof ArchiveEntryPayloads;

/**
 * 一条 archive 记录:事实本身 + 版本 / 时间。
 * `ArchiveEntry<Tag>` 把 tag 与 payload 绑定;不写泛型时是全部记录的联合。
 * 顺序由文件行序决定:`Entry` 里没有 `seq` 字段。
 */
export type ArchiveEntry<T extends ArchiveEntryTag = ArchiveEntryTag> = T extends ArchiveEntryTag
  ? {
      /** 存储格式版本。 */
      readonly v: 1;
      /** append 时间(epoch ms)。 */
      readonly at: number;
      readonly _tag: T;
      /** 本事件 / 生命周期节点的 id。 */
      readonly id: ArchiveEntryId;
      /** 所属会话。旧文件里的条目没有;`Archive` 读入时会补 `LEGACY_SESSION_ID`。 */
      readonly sessionId?: SessionId;
      /** 所属容器;顶层事件(engine / inbox)没有。 */
      readonly parentId?: ArchiveEntryId;
    } & ArchiveEntryPayloads[T]
  : never;

export class ArchiveError extends Data.TaggedError("ARCHIVE_ERROR")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/** `Archive` 服务的形状。 */
export interface ArchiveShape {
  /**
   * 批量入队;成功 = 已经进队列,不代表落盘。
   * - 不返回 per-entry Deferred;落盘由 layer 关闭时的内部 flush 保证;
   * - 已在关闭 / writer 已失败时,append 直接失败(事务里看 `closedRef`,不做任何订阅);
   * - writer 失败本身不经过这里,见 `errors`。
   */
  readonly append: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void, ArchiveError>;
  /**
   * writer 失败的**一次性**通知:worker 挂了就发一条错误,然后流结束。
   * 晚订阅者会先拿到已经发生的那条。
   */
  readonly errors: Stream.Stream<ArchiveError>;
  /**
   * 读回**已接收**的全部条目(按发生顺序):内存里的缓存,不碰文件,因此不会失败。
   * 可能包含还没落盘的条目(在队列 / 在飞);所有会话都在里面。
   */
  readonly readAll: Effect.Effect<ReadonlyArray<ArchiveEntry>>;
  /** 读回某一会话的条目。 */
  readonly readSession: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ArchiveEntry>>;
  /** 当前会话(新事件都挂到它上面)。 */
  readonly currentSession: Effect.Effect<SessionId>;
  /** 已接收条目的会话 id(按第一次出现顺序;至少包含当前会话)。 */
  readonly sessions: Effect.Effect<ReadonlyArray<SessionId>>;
  /** 开一段新会话并切过去(transcript 从空开始);返回新 id。 */
  readonly startSession: Effect.Effect<SessionId>;
  /** 切到已有会话(没有条目时就是空会话)。 */
  readonly useSession: (sessionId: SessionId) => Effect.Effect<void>;
  /**
   * **投影:要哪一类就给哪一类**。读内存里的已接收条目,不碰文件。
   * `inbox`(`queue` / `staged`)是当前会话的;`transcript` 是当前会话的历史。
   */
  readonly projection: <K extends keyof Projections>(kind: K) => Effect.Effect<Projections[K]>;
}

/** `Archive` 服务 Tag。 */
export class Archive extends Context.Service<Archive, ArchiveShape>()("Archive") {}
