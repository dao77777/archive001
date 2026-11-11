// ═══════════════════════════════════════════════════════════════════════════
// Inbox:agent 内部唯一的交接面
//
// Agent.send ──► offer(prompt)──┐
// 工具执行器 ──► offer(result)──┤──► queue ──► takeReadyBatch(awaiting) ──► ReadyBatch
//                               └─ 顺手发 INBOX_OFFER / INBOX_TAKE(队列自己的事)
//
// 它只收集、不解释:"谁先谁后、工具结果要不要紧跟 function_call"由 `engine` 拼 transcript 时决定。
// ═══════════════════════════════════════════════════════════════════════════

import { Array as Arr, Effect, Layer, Match, Option, Queue, Ref } from "effect";
import { newArchiveEntryId } from "../../archive/service.ts";
import { Events } from "../events/service.ts";
import { Inbox, type InboxMessage, type ReadyBatch } from "./service.ts";

// ---------------------------------------------------------------------------
// 工具:消息判别 / 就位判断
// ---------------------------------------------------------------------------
/** 是不是一条 prompt(`Agent.send` 放进来的)。inbox 消息的类型判别归这里,别的模块直接用。 */
export const isUserMessage = (message: InboxMessage): message is InboxMessage<"USER_MESSAGE"> =>
  message._tag === "USER_MESSAGE";

/** 是不是一条工具结果(工具执行器放进来的)。 */
export const isFunctionCallOutput = (
  message: InboxMessage,
): message is InboxMessage<"FUNCTION_CALL_OUTPUT"> => message._tag === "FUNCTION_CALL_OUTPUT";

/** 按 `callIds` 的顺序把工具观测挑出来(不在的消息直接没有,由调用方先确认齐了)。 */
const outputsInOrder = (
  messages: ReadonlyArray<InboxMessage>,
  callIds: ReadonlyArray<string>,
): ReadonlyArray<InboxMessage<"FUNCTION_CALL_OUTPUT">> =>
  callIds.flatMap((callId) => {
    const result = messages
      .filter(isFunctionCallOutput)
      .find((message) => message.payload.callId === callId);
    return result === undefined ? [] : [result];
  });

/** 还有工具调用在等结果(等就位期间)。 */
const hasAwaiting = (awaiting: ReadonlyArray<string>): boolean => awaiting.length > 0;

/** 这一批里还有没回来的结果。 */
const hasMissing = (missing: ReadonlyArray<string>): boolean => missing.length > 0;

/** 这一批就位了(可以直接交出去)。 */
const isReady = (candidate: Option.Option<ReadyBatch>): candidate is Option.Some<ReadyBatch> =>
  Option.isSome(candidate);

/** 这一批里有 prompt。 */
const hasPrompts = (prompts: ReadonlyArray<InboxMessage<"USER_MESSAGE">>): boolean =>
  prompts.length > 0;

/** 这批消息里带着结果的 callId。 */
const resultCallIds = (messages: ReadonlyArray<InboxMessage>): ReadonlyArray<string> =>
  messages.filter(isFunctionCallOutput).map((result) => result.payload.callId);

/**
 * 就位的那一批(不纯的只有"判断",这里只有选择):给一批消息,返回**可以直接交出去的那批**,
 * 还没就位就是 `None`。交出的形状见 `ReadyBatch`:工具观测已按调用顺序排好、只含这次等的调用。
 *
 * - `awaiting` 非空:等的是这些工具调用,结果全到齐才算就位;期间混进来的 prompt 一起带出;
 * - `awaiting` 为空:只等 prompt;此时的工具结果等不到配套调用,是上次引擎被中断时留下的
 *   迟到结果,不算就位条件,也不带出去(丢掉)。
 */
const readyBatch = (
  messages: ReadonlyArray<InboxMessage>,
  awaiting: ReadonlyArray<string>,
): Option.Option<ReadyBatch> =>
  Match.value(awaiting).pipe(
    // 有要等的调用
    Match.when(hasAwaiting, (callIds) =>
      Match.value(Arr.difference(callIds, resultCallIds(messages))).pipe(
        // 还缺的结果:没回来齐,继续等
        Match.when(hasMissing, () => Option.none()),
        // 缺的为空 = 齐了:观测按调用顺序排好,prompt 排后面
        Match.orElse(() =>
          Option.some({
            functionCallOutputs: outputsInOrder(messages, callIds),
            userMessages: messages.filter(isUserMessage),
          }),
        ),
      ),
    ),
    // 没有要等的调用:只等 prompt(工具结果等不到配套调用,一律不带)
    Match.orElse(() =>
      Match.value(messages.filter(isUserMessage)).pipe(
        // 有 prompt:就位,只交 prompt
        Match.when(hasPrompts, (userMessages) =>
          Option.some({ functionCallOutputs: [], userMessages }),
        ),
        // 连 prompt 都没有:攒着的全是等不到配套调用的迟到结果,继续等
        Match.orElse(() => Option.none()),
      ),
    ),
  );

/**
 * `Inbox` 服务:收集 prompt / tool result,攒到"就位"再交出整批。
 *
 * `INBOX_OFFER` / `INBOX_TAKE` 由它自己发:两条事件描述的是队列本身,谁管队列谁写。
 */
export const InboxLive: Layer.Layer<Inbox, never, Events> = Layer.effect(
  Inbox,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const events = yield* Events;

    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------
    /** 待取的消息队列。 */
    const queue = yield* Queue.unbounded<InboxMessage>();
    /** 已经从队列取出、还没交出去的消息:等"就位"期间就攒在这里。 */
    /** 已经从队列取出、还没交出去的消息(等"就位"期间攒在这里)。 */
    const stagedRef = yield* Ref.make<ReadonlyArray<InboxMessage>>([]);

    // -----------------------------------------------------------------------
    // 方法:publishOffer / publishTake
    // -----------------------------------------------------------------------
    /** 入队即内容事件:带**完整消息**,读到事件就拿到正文。 */
    const publishOffer = (message: InboxMessage): Effect.Effect<void> =>
      events.publish({ _tag: "INBOX_OFFER", id: newArchiveEntryId(), message });

    /** 出队即内容事件,但只带引用:正文在对应的 `INBOX_OFFER` 里,不复制。 */
    const publishTake = (taken: ReadonlyArray<InboxMessage>): Effect.Effect<void> =>
      events.publish({
        _tag: "INBOX_TAKE",
        id: newArchiveEntryId(),
        messageIds: taken.map((message) => message.id),
      });

    // -----------------------------------------------------------------------
    // 对外方法:offer / takeReadyBatch
    // -----------------------------------------------------------------------
    /** 入队:内容先发再入队 —— 看到 `INBOX_OFFER` 就能拿到结果,不必等出队。 */
    const offer = (message: InboxMessage): Effect.Effect<void> =>
      publishOffer(message).pipe(Effect.andThen(Queue.offer(queue, message)), Effect.asVoid);

    /**
     * 等到就位:就位了就交出去,没就位就再收一批 —— 没就位时的"再试一次"就是递归调用自己,
     * 队列空时 `takeAll` 会把消费方挂起。
     */
    const takeReadyBatch = (awaiting: ReadonlyArray<string>): Effect.Effect<ReadyBatch> =>
      Effect.Do.pipe(
        // 取出攒着的消息(上次等就位时留下的也在里面)
        Effect.bind("messages", () => Ref.get(stagedRef)),
        Effect.flatMap(({ messages }) =>
          Match.value(readyBatch(messages, awaiting)).pipe(
            // 齐了:交出这一批,顺手清空攒着的(`ready` 是值,先包成 Effect 再 tap)
            Match.when(isReady, (ready) =>
              Effect.succeed(ready.value).pipe(Effect.tap(() => Ref.set(stagedRef, []))),
            ),
            // 还缺:收一批进来(攒着的留在 inbox 里,等就位期间中断也不会丢),再判一次
            Match.orElse(() =>
              Queue.takeAll(queue).pipe(
                Effect.tap(publishTake),
                Effect.flatMap((taken) =>
                  Ref.set(stagedRef, [...messages, ...taken]).pipe(
                    Effect.andThen(takeReadyBatch(awaiting)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

    return Inbox.of({ offer, takeReadyBatch });
  }),
);
