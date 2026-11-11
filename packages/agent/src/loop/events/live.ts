// ═══════════════════════════════════════════════════════════════════════════
// Events:archive 队列 + 实时流
//
// publish(event) ──► archive.append(只入队,不等落盘)──► PubSub ──► Agent.events
//      └─ 顺手记住 ENGINE_END / ARCHIVE_ERROR,晚订阅的人也能补上,不会永远等
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Layer, Option, PubSub, Ref, Stream } from "effect";
import { formatError } from "../../_util.ts";
import { newArchiveEntryId, type ArchiveEntry, Archive } from "../../archive/service.ts";
import { Events, type EventHook, type EventPublisher } from "./service.ts";

/** `Events` 服务:所有事件的唯一出口(archive + 实时流)。 */
export const EventsLive: Layer.Layer<Events, never, Archive> = Layer.effect(
  Events,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const archive = yield* Archive;

    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------
    /** 实时流:Agent 往外发,客户端订阅。 */
    const bus = yield* PubSub.unbounded<ArchiveEntry>();
    /** 引擎是否已经停了 —— 让晚订阅的人也能收到 `engine.end`,不会永远等。 */
    const stoppedRef = yield* Ref.make<
      Option.Option<Extract<ArchiveEntry, { _tag: "ENGINE_END" }>>
    >(Option.none());
    /** archive 的终态错误 —— 同样给晚订阅的人补一条。 */
    const archiveFailureRef = yield* Ref.make<
      Option.Option<Extract<ArchiveEntry, { _tag: "ARCHIVE_ERROR" }>>
    >(Option.none());
    /** 当前 run 的 archive hook(`undefined` = 原样写入)。 */
    const hookRef = yield* Ref.make<EventHook | undefined>(undefined);

    // -----------------------------------------------------------------------
    // 方法:replayed
    // -----------------------------------------------------------------------
    /** 晚订阅要先补的:已经发生过的 `engine.end` / `archive.error`。 */
    const replayed: Stream.Stream<ArchiveEntry> = Stream.concat(
      Stream.fromEffect(Ref.get(stoppedRef)).pipe(
        Stream.flatMap((state) => (Option.isSome(state) ? Stream.make(state.value) : Stream.empty)),
      ),
      Stream.fromEffect(Ref.get(archiveFailureRef)).pipe(
        Stream.flatMap((state) => (Option.isSome(state) ? Stream.make(state.value) : Stream.empty)),
      ),
    );

    // -----------------------------------------------------------------------
    // 初始化:把 archive 的失败接到总线上
    // -----------------------------------------------------------------------
    // archive 挂掉不阻断对话,但要把错误告诉客户端:直接推总线,不经过 archive(它自己就是坏的)
    yield* Stream.runForEach(archive.errors, (error) =>
      Effect.gen(function* () {
        const entry = {
          v: 1 as const,
          at: Date.now(),
          _tag: "ARCHIVE_ERROR" as const,
          id: newArchiveEntryId(),
          message: error.message,
          ...(error.cause === undefined ? {} : { cause: formatError(error.cause) }),
        };
        yield* Ref.set(archiveFailureRef, Option.some(entry));
        yield* Effect.logError(`archive 已停止,之后的记录不再落盘:${error.message}`);
        yield* PubSub.publish(bus, entry);
      }),
    ).pipe(Effect.forkScoped);

    // -----------------------------------------------------------------------
    // 对外方法:publish / stream
    // -----------------------------------------------------------------------
    /** 发一条:先过 archive hook,再入 archive 队列(只入队,不等落盘),再发实时流。 */
    const publish: EventPublisher = (event) =>
      Effect.gen(function* () {
        // 事件属于当前会话;hook 拿到的条目已带 sessionId,插入的 turn 事件要复制它
        const sessionId = yield* archive.currentSession;
        const entry = { v: 1, at: Date.now(), ...event, sessionId } as ArchiveEntry;
        const hook = yield* Ref.get(hookRef);
        // hook 可以在这条前后插入事件、改写 parentId,或返回空数组丢弃它
        const entries = hook === undefined ? [entry] : yield* hook(entry);
        if (entries.length === 0) return;

        // archive 失败由 `Archive.errors` → `ARCHIVE_ERROR` 事件暴露,不阻断实时事件
        yield* archive.append(entries).pipe(Effect.ignore);
        for (const written of entries) {
          if (written._tag === "ENGINE_END") {
            yield* Ref.set(stoppedRef, Option.some(written));
          }
          yield* PubSub.publish(bus, written);
        }
      });

    /** 新的一段 run:清掉上一次的终点,别让新订阅者当场收到旧的 `ENGINE_END`。 */
    const begin: Effect.Effect<void> = Ref.set(stoppedRef, Option.none());

    /** 设置 archive hook(`undefined` = 原样写入)。 */
    const setHook = (hook: EventHook | undefined): Effect.Effect<void> => Ref.set(hookRef, hook);

    /** 补发 + 实时流拼起来的完整事件流。 */
    const stream: Stream.Stream<ArchiveEntry> = Stream.concat(replayed, Stream.fromPubSub(bus));

    return Events.of({ publish, begin, setHook, stream });
  }),
);
