// ═══════════════════════════════════════════════════════════════════════════
// Inbox 契约:收集 prompt / tool result,攒到"就位"交出整批
//
// `offer` 入队,`takeReadyBatch(awaiting)` 等到这一批能交给模型。
//
// 实现在 `./live.ts`。
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/**
 * inbox 消息统一形状:`id` 表示这条消息自身,`payload` 是内容容器。
 * 用 `InboxMessage<Tag>` 把 tag 与 payload 绑定;默认是全部消息的联合。
 */
export interface InboxPayloads {
  readonly USER_MESSAGE: { readonly text: string };
  readonly FUNCTION_CALL_OUTPUT: {
    readonly callId: string;
    readonly name: string;
    readonly output: string;
  };
}

export type InboxTag = keyof InboxPayloads;

export type InboxMessage<T extends InboxTag = InboxTag> = T extends InboxTag
  ? {
      readonly _tag: T;
      /** 这条 inbox 消息自己的 id(不是 callId) */
      readonly id: string;
      readonly payload: InboxPayloads[T];
    }
  : never;

/**
 * `takeReadyBatch` 交出的一批:**已按类型分好、工具观测已按调用顺序排好**。
 *
 * 字段名与消息自己的 `_tag`(以及 transcript 的 `Item.type`)一致:
 * `FUNCTION_CALL_OUTPUT` / `USER_MESSAGE`。
 */
export interface ReadyBatch {
  readonly functionCallOutputs: ReadonlyArray<InboxMessage<"FUNCTION_CALL_OUTPUT">>;
  readonly userMessages: ReadonlyArray<InboxMessage<"USER_MESSAGE">>;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/**
 * `Inbox` 服务:收集 prompt / tool result,攒到"就位"再交出整批。
 *
 * `INBOX_OFFER` / `INBOX_TAKE` 由它自己发:两条事件描述的是队列本身,谁管队列谁写。
 */
export interface InboxShape {
  /** 入队,并发一条 `INBOX_OFFER`(完整消息)。 */
  readonly offer: (message: InboxMessage) => Effect.Effect<void>;
  /**
   * 等到这一批**就位**,一次取走(空的时候挂起);每次真正出队发一条 `INBOX_TAKE`(只带引用)。
   *
   * - `awaiting` 非空:等这些 `callId` 的结果全部回来(期间混进来的 prompt 一并交出,
   *   观测按 `awaiting` 顺序排好,不属于这次等的丢掉);
   * - `awaiting` 为空:等到至少一条 prompt;此时收到的工具结果等不到配套调用,
   *   是上次引擎中断留下的迟到结果,直接丢。
   */
  readonly takeReadyBatch: (awaiting: ReadonlyArray<string>) => Effect.Effect<ReadyBatch>;
}

/** `Inbox` 服务 Tag(实现见 `InboxLive`)。只由 `AgentLive` 装配,不从 SDK 导出。 */
export class Inbox extends Context.Service<Inbox, InboxShape>()("Inbox") {}
