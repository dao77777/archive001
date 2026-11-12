// ═══════════════════════════════════════════════════════════════════════════
// Projection:archive 读侧——把事件流折成引擎要的内存状态(transcript / inbox)
//
//   append ──► advance(只入队)──┐
//                               ├──► incoming ──► foldEntry ──► queue / staged / transcript / step
//   构建   ──► init(重置+全折)──┘                                        ▲
//                                                    get(kind):补折后读 ─┘
//
// 折叠是增量的:条目先进 `incoming`,读的时候才折(没人读就不折);
// 入队、折叠、读取各自是一个 STM 事务,读不到"折了一半"的中间态。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Layer, Match, TxRef } from "effect";
import { newSessionId, type ArchiveEntry, type SessionId } from "../service.ts";
import type { FunctionCall, Item } from "../../llm/_domain.ts";
import { Projection, type InboxProjection, type Projections } from "./service.ts";
import type { InboxMessage } from "../../loop/inbox/service.ts";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** 这一批里有没有要接手的条目。 */
const hasEntries = (entries: ReadonlyArray<ArchiveEntry>): boolean => entries.length > 0;

/** 条目属于哪个会话。进投影的条目都已由 `Archive.append` 打标;没有就是 bug。 */
const sessionOf = (entry: ArchiveEntry): SessionId => {
  if (entry.sessionId === undefined) {
    throw new Error(`投影收到没有 sessionId 的条目(${entry._tag} ${entry.id})`);
  }
  return entry.sessionId;
};

/** 按 id 摘掉一条消息,返回摘到的那条(没有就是 `undefined`)。 */
const removeById = (
  messages: ReadonlyArray<InboxMessage>,
  id: string,
): [InboxMessage | undefined, ReadonlyArray<InboxMessage>] => {
  const index = messages.findIndex((message) => message.id === id);
  return index === -1
    ? [undefined, messages]
    : [messages[index], [...messages.slice(0, index), ...messages.slice(index + 1)]];
};

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/** 正在进行的 step:要等 `STEP_END` 才知道它的正文怎么进 transcript。 */
interface Step {
  readonly id: string;
  readonly calls: ReadonlyArray<FunctionCall>;
  readonly texts: ReadonlyArray<string>;
  /** 这一 step 的产出,进 transcript 时用(顺序 = 事件顺序)。 */
  readonly produced: ReadonlyArray<Item>;
}

/**
 * 投影的每一部分各占一个 `TxRef`;折叠、入队、读取都各自是一个事务,
 * 一致性与回退由 STM 保证。外面只看到 `init` / `advance`(收下条目)与 `get`(补折后读)。
 */
export const ProjectionLive: Layer.Layer<Projection> = Layer.effect(
  Projection,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------
    /** 已经在 inbox 里、还没被取走的消息(`INBOX_OFFER` 带全文)。 */
    const queueRef = yield* TxRef.make<ReadonlyArray<InboxMessage>>([]);
    /** 已经出队、还没进任何 step 的消息(`INBOX_TAKE` 把它们从 queue 挪过来)。 */
    const stagedRef = yield* TxRef.make<ReadonlyArray<InboxMessage>>([]);
    /** 当前会话的对话历史:跨 run 保留;切会话(`setSession`)时换一份。 */
    const transcriptRef = yield* TxRef.make<ReadonlyArray<Item>>([]);
    /** 正在进行的 step。 */
    const stepRef = yield* TxRef.make<Step | undefined>(undefined);
    /** 已经接手、还没折的条目。 */
    const incomingRef = yield* TxRef.make<ReadonlyArray<ArchiveEntry>>([]);
    /** 所有已接手的条目(跨会话):切会话时从这里重折。 */
    const allEntriesRef = yield* TxRef.make<ReadonlyArray<ArchiveEntry>>([]);
    /** 当前投影的是哪一段会话。 */
    const currentSessionRef = yield* TxRef.make<SessionId>(newSessionId());

    // -----------------------------------------------------------------------
    // 方法:takeMessage / foldEntry / fold
    // -----------------------------------------------------------------------
    /** 按 id 取走一条消息:先 staged(正常路径),再 queue(事件顺序错乱时兜底)。 */
    const takeMessage = (id: string): Effect.Effect<InboxMessage | undefined> =>
      TxRef.modify(stagedRef, (staged) => removeById(staged, id)).pipe(
        Effect.flatMap((found): Effect.Effect<InboxMessage | undefined> =>
          found !== undefined
            ? Effect.succeed(found)
            : TxRef.modify(queueRef, (queue) => removeById(queue, id)),
        ),
      );

    /** 把一条条目折进状态。 */
    const foldEntry = (entry: ArchiveEntry): Effect.Effect<void> =>
      Match.value(entry).pipe(
        // ── inbox:正文在 offer 里,take 只带引用 → 从 queue 挪到 staged ────
        Match.when({ _tag: "INBOX_OFFER" }, (offer) =>
          TxRef.update(queueRef, (queue) => [...queue, offer.message]),
        ),
        Match.when({ _tag: "INBOX_TAKE" }, (take) => {
          const taken = new Set(take.messageIds);
          return TxRef.modify(queueRef, (queue) => [
            queue.filter((message) => taken.has(message.id)),
            queue.filter((message) => !taken.has(message.id)),
          ]).pipe(
            Effect.flatMap((moving) => TxRef.update(stagedRef, (all) => [...all, ...moving])),
          );
        }),

        // ── run 边界:只清掉没闭合的 step,transcript 跨 run 保留 ──────────
        Match.when({ _tag: "ENGINE_START" }, () => TxRef.set(stepRef, undefined)),
        Match.when({ _tag: "ENGINE_END" }, () => TxRef.set(stepRef, undefined)),

        // ── step:进来开草稿,出去时把正文并进 transcript ──────────────────
        Match.when({ _tag: "STEP_START" }, (start) =>
          TxRef.set(stepRef, { id: start.id, calls: [], texts: [], produced: [] }),
        ),
        Match.when({ _tag: "STEP_END" }, (end) =>
          TxRef.modify(stepRef, (step): [Step | undefined, Step | undefined] => [
            step,
            undefined,
          ]).pipe(
            Effect.flatMap((step) =>
              step === undefined || step.id !== end.id
                ? // 不是这个 step 的收尾(或根本没有 step):不动历史
                  Effect.void
                : // 有工具调用时整批产出进历史;纯问答只留非空正文(与状态机一致)
                  TxRef.update(transcriptRef, (transcript) => [
                    ...transcript,
                    ...(step.calls.length > 0
                      ? step.produced
                      : step.texts
                          .filter((text) => text.length > 0)
                          .map((text): Item => ({ type: "ASSISTANT_MESSAGE", text }))),
                  ]),
            ),
          ),
        ),

        // ── step 的输入:只带引用,正文从 inbox 取走(进历史后就不在 inbox 了)──
        Match.when({ _tag: "USER_MESSAGE" }, (input) =>
          takeMessage(input.inboxId).pipe(
            Effect.flatMap((message) =>
              message === undefined || message._tag !== "USER_MESSAGE"
                ? // 消息已经不在了(或者类型对不上):跳过
                  Effect.void
                : TxRef.update(transcriptRef, (transcript) => [
                    ...transcript,
                    { type: "USER_MESSAGE", text: message.payload.text } as Item,
                  ]),
            ),
          ),
        ),
        Match.when({ _tag: "FUNCTION_CALL_OUTPUT" }, (input) =>
          takeMessage(input.inboxId).pipe(
            Effect.flatMap((message) =>
              message === undefined || message._tag !== "FUNCTION_CALL_OUTPUT"
                ? // 消息已经不在了(或者类型对不上):跳过
                  Effect.void
                : TxRef.update(transcriptRef, (transcript) => [
                    ...transcript,
                    {
                      type: "FUNCTION_CALL_OUTPUT",
                      callId: message.payload.callId,
                      output: message.payload.output,
                    } as Item,
                  ]),
            ),
          ),
        ),

        // ── step 的产出:同时记进 `produced`(进 transcript 的形态) ────────
        Match.when({ _tag: "REASONING" }, (reasoning) => {
          const item: Item = { type: "REASONING", text: reasoning.text };
          return TxRef.update(stepRef, (step) =>
            step === undefined ? step : { ...step, produced: [...step.produced, item] },
          );
        }),
        Match.when({ _tag: "ASSISTANT_MESSAGE" }, (message) => {
          const item: Item = { type: "ASSISTANT_MESSAGE", text: message.text };
          return TxRef.update(stepRef, (step) =>
            step === undefined
              ? step
              : {
                  ...step,
                  texts: [...step.texts, message.text],
                  produced: [...step.produced, item],
                },
          );
        }),
        Match.when({ _tag: "FUNCTION_CALL" }, (call) => {
          const item: FunctionCall = {
            type: "FUNCTION_CALL",
            callId: call.callId,
            name: call.name,
            arguments: call.arguments,
          };
          return TxRef.update(stepRef, (step) =>
            step === undefined
              ? step
              : { ...step, calls: [...step.calls, item], produced: [...step.produced, item] },
          );
        }),

        // 轮次 / step 的收尾、system prompt 状态、写盘失败:都不进投影
        Match.orElse(() => Effect.void),
      );

    /**
     * 补折:清空队列,再把刚才那些条目逐条折进状态。
     * 整段是一个事务:要么全提交,要么全回退(失败 / 中断不会留下"清空了没折完");
     * 并发提交冲突就整段重跑,所以既不需要锁,也不需要 `uninterruptible`。
     */
    const fold: Effect.Effect<void> = Effect.gen(function* () {
      const incoming = yield* TxRef.get(incomingRef);
      const current = yield* TxRef.get(currentSessionRef);
      yield* TxRef.set(incomingRef, []);

      yield* Effect.forEach(
        incoming.filter((entry) => sessionOf(entry) === current),
        foldEntry,
        { discard: true },
      );
    }).pipe(Effect.tx);

    // -----------------------------------------------------------------------
    // 对外方法:init / advance / get
    // -----------------------------------------------------------------------
    /**
     * 初始化:重置五个状态,再把这份日志整份折进去。
     * 一次事务,中途失败 / 中断不会留下折了一半的状态。
     */
    const init = (entries: ReadonlyArray<ArchiveEntry>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const last = entries[entries.length - 1];
        const current = last === undefined ? newSessionId() : sessionOf(last);

        yield* TxRef.set(allEntriesRef, entries);
        yield* TxRef.set(currentSessionRef, current);
        yield* TxRef.set(queueRef, []);
        yield* TxRef.set(stagedRef, []);
        yield* TxRef.set(transcriptRef, []);
        yield* TxRef.set(stepRef, undefined);
        yield* TxRef.set(incomingRef, []);

        yield* Effect.forEach(
          entries.filter((entry) => sessionOf(entry) === current),
          foldEntry,
          { discard: true },
        );
      }).pipe(Effect.tx);

    /** 接手一批**新**条目:只入队,不折。 */
    const advance = (entries: ReadonlyArray<ArchiveEntry>): Effect.Effect<void> =>
      Match.value(entries).pipe(
        // 有条目:整批入队,等下一次读再折
        Match.when(hasEntries, (entries) =>
          Effect.gen(function* () {
            yield* TxRef.update(allEntriesRef, (all) => [...all, ...entries]);
            yield* TxRef.update(incomingRef, (incoming) => [...incoming, ...entries]);
          }).pipe(Effect.tx),
        ),
        // 空批次:没有可接手的,不碰队列(省一次事务)
        Match.orElse(() => Effect.void),
      );

    /**
     * 切到某个会话:按 `sessionId` 从 `allEntries` 重折当前会话的状态。
     * 一次事务;别的会话的条目仍留在 `allEntries` 里。
     */
    const setSession = (sessionId: SessionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const all = yield* TxRef.get(allEntriesRef);

        yield* TxRef.set(currentSessionRef, sessionId);
        yield* TxRef.set(queueRef, []);
        yield* TxRef.set(stagedRef, []);
        yield* TxRef.set(transcriptRef, []);
        yield* TxRef.set(stepRef, undefined);
        yield* TxRef.set(incomingRef, []);

        yield* Effect.forEach(
          all.filter((entry) => sessionOf(entry) === sessionId),
          foldEntry,
          { discard: true },
        );
      }).pipe(Effect.tx);

    /**
     * 取一类投影:补折 + 读在同一个事务里,折完直接读,
     * 不会读到"折了一半"的队列 / staged。
     */
    const get = <K extends keyof Projections>(kind: K): Effect.Effect<Projections[K]> =>
      Effect.gen(function* () {
        yield* fold;

        const projection = Match.value(kind as keyof Projections).pipe(
          // 对话历史:当前会话的 transcript(跨 run)
          Match.when("transcript", () => TxRef.get(transcriptRef)),
          // inbox:两个队列一次读齐
          Match.when("inbox", () =>
            Effect.all([TxRef.get(queueRef), TxRef.get(stagedRef)]).pipe(
              Effect.map(([queue, staged]): InboxProjection => ({ queue, staged })),
            ),
          ),
          Match.exhaustive,
        );

        // kind → 结果类型的对应关系由上面的分支保证,编译器看不出这一层
        return (yield* projection) as Projections[K];
      }).pipe(Effect.tx);

    return Projection.of({ init, advance, setSession, get });
  }),
);
