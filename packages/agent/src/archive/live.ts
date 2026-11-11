// ═══════════════════════════════════════════════════════════════════════════
// Archive:append 只入队;单 worker 写 sink;中断时 worker 自己把没写完的补上
//
//   append ──(closed 检查)──► 缓存(立刻可见) ──► TxQueue ──► worker ──► sink.write
//        └─ 返回“已入队 / 已在缓存”,不等写完
//
// 读侧有一份**条目缓存**,放在**写队列之前**:`append` 一进来就接进缓存,不等 worker 落盘 ——
// 读侧(`readAll` / `projection`)因此是"实时的已接收视图"。构建时从 sink 读一次作为底稿,
// 之后读侧不碰文件。
// ═══════════════════════════════════════════════════════════════════════════

import {
  Effect,
  Layer,
  Match,
  Option,
  Ref,
  Schedule,
  Stream,
  SubscriptionRef,
  TxQueue,
  TxRef,
} from "effect";
import {
  Archive,
  type ArchiveEntry,
  ArchiveError,
  type ArchiveShape,
  LEGACY_SESSION_ID,
  newSessionId,
  type SessionId,
} from "./service.ts";
import { Sink } from "./sink/service.ts";
import { Projection } from "./projection/service.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 单次从队列最多取多少条写(积压时分成多批,单批不会被无限放大)。 */
const SINK_BATCH_MAX = 1024;

/** 单批写入的重试策略:失败后隔 10ms 再试,最多 3 次(不含第一次)。 */
const SINK_RETRY_SCHEDULE = Schedule.recurs(3).pipe(
  Schedule.addDelay(() => Effect.succeed("10 millis")),
);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** `TxQueue.offerAll` 剩下的条目:非空说明队列已经关了,有东西没塞进去。 */
const hasRejected = (remaining: ReadonlyArray<ArchiveEntry>): boolean => remaining.length > 0;

/** 只做接线、不做任何 `provide`:sink 与投影由外面给(文件 / 内存 / 测试桩都可以)。 */
export const ArchiveRuntime: Layer.Layer<Archive, never, Sink | Projection> = Layer.effect(
  Archive,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const sinkSvc = yield* Sink;
    const projectionSvc = yield* Projection;

    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------
    /** 待写的条目队列:worker 唯一的进货口。 */
    const queue = yield* TxQueue.unbounded<ArchiveEntry>();
    /** 闸门:置 true 后 append 一律失败,且不再打开。 */
    const closedRef = yield* TxRef.make(false);
    /** worker 手上正在写的那批。 */
    const writingRef = yield* TxRef.make<Option.Option<ReadonlyArray<ArchiveEntry>>>(Option.none());
    /** 失败状态;`errors` 是它的出口。 */
    const failureSubRef = yield* SubscriptionRef.make<Option.Option<ArchiveError>>(Option.none());
    /**
     * 已接收条目的缓存,放在**写队列之前**:
     * `append` 一进来就接进缓存,不等 worker 落盘 —— 所以 `readAll` 是"已接收"视图
     * (可能还没落盘,在队列 / 在飞);反过来 sink 挂掉也不影响读。
     */
    const cacheRef = yield* Ref.make<ReadonlyArray<ArchiveEntry>>([]);
    /** 当前会话:新事件都挂到它上面。 */
    const sessionRef = yield* TxRef.make<SessionId>(LEGACY_SESSION_ID);

    // -----------------------------------------------------------------------
    // 方法:takeBatch / writeBatch / drain
    // -----------------------------------------------------------------------
    /** 取一批(最多 `SINK_BATCH_MAX`)并标成"在飞":取货即认领,同一事务。 */
    const takeBatch: Effect.Effect<ReadonlyArray<ArchiveEntry>> = Effect.gen(function* () {
      const entries = yield* TxQueue.takeBetween(queue, 1, SINK_BATCH_MAX);
      yield* TxRef.set(writingRef, Option.some(entries));
      return entries;
    }).pipe(Effect.tx);

    /**
     * 写一批:落盘(按 `SINK_RETRY_SCHEDULE` 重试;缓存早在 `append` 时补过了),
     * 写完才放下"在飞"标记。
     *
     * 保持可中断:中断正好落在中间时,收尾会拿着"仍然标着在飞"的这一批再写一遍
     * (极端情况下会重复一行);换来的是 sink 卡住时关闭仍能立刻开始收尾。
     */
    const writeBatch = (entries: ReadonlyArray<ArchiveEntry>): Effect.Effect<void, ArchiveError> =>
      Effect.gen(function* () {
        yield* sinkSvc.write(entries).pipe(Effect.retry(SINK_RETRY_SCHEDULE));
        yield* TxRef.set(writingRef, Option.none()).pipe(Effect.tx);
      });

    /**
     * 关闭收尾的**唯一动作**:关闸 → 收拢未落盘 → 写掉。
     *
     * 三件事是一体的:关闸挡住后续 `append`,收拢才拿得到"最后一刻"的在飞批 + 队列残余,
     * 写掉之后文件里的条目才是完整的。有副作用(关闸),所以只能用于收尾。
     */
    const drain: Effect.Effect<void, ArchiveError> = Effect.gen(function* () {
      yield* TxRef.set(closedRef, true).pipe(Effect.tx);

      const rest = yield* Effect.gen(function* () {
        const inFlight = yield* TxRef.get(writingRef);
        const queued = yield* TxQueue.clear(queue);
        yield* TxRef.set(writingRef, Option.none());
        return [...(Option.isSome(inFlight) ? inFlight.value : []), ...queued];
      }).pipe(Effect.tx);

      // 收尾就是"把剩下这批按正常路径写掉";多一次 `writingRef = none` 无副作用
      if (rest.length > 0) yield* writeBatch(rest);
    });

    // -----------------------------------------------------------------------
    // 初始化:读底稿 → 填缓存与投影 → 起 worker
    // -----------------------------------------------------------------------
    /**
     * 构建时从 sink 读一次作为底稿。
     * 读失败按缺陷处理(读不到文件不是一个可恢复的运行期错误):之后读侧只碰内存,
     * sink 写失败也不会让读挂掉。
     */
    const initial = yield* sinkSvc.read.pipe(Effect.orDie);
    /** 旧文件没有 sessionId:归到 legacy;新条目在 append 时补当前会话。 */
    const normalized: ReadonlyArray<ArchiveEntry> = initial.map((entry) =>
      entry.sessionId === undefined ? { ...entry, sessionId: LEGACY_SESSION_ID } : entry,
    );
    const last = normalized[normalized.length - 1];
    const initialSession = last?.sessionId ?? newSessionId();
    yield* Ref.set(cacheRef, normalized);
    yield* TxRef.set(sessionRef, initialSession);
    /** 同一份底稿交给投影:重置后全量折叠,之后只 `advance` 增量。 */
    yield* projectionSvc.init(normalized);
    /** 默认回到最后一段会话;没有历史就开一段新的。 */
    yield* projectionSvc.setSession(initialSession);

    /** worker:唯一碰队列、唯一写 sink 的纤维。 */
    yield* Effect.forever(takeBatch.pipe(Effect.flatMap(writeBatch))).pipe(
      // 中断 → 关闸 + 把没落盘的(在飞 + 队列)一次写完
      Effect.onInterrupt(() => drain.pipe(Effect.ignore)),
      // 失败 → 关闸 + 发 failureSubRef
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* TxRef.set(closedRef, true).pipe(Effect.tx);
          yield* SubscriptionRef.set(failureSubRef, Option.some(error));
          yield* TxRef.set(writingRef, Option.none()).pipe(Effect.tx);
        }),
      ),
      // startImmediately:fork 时就开始跑(返回前已注册好 finalizer)
      Effect.forkScoped({ startImmediately: true }),
    );

    // -----------------------------------------------------------------------
    // 对外方法
    // -----------------------------------------------------------------------
    /** 批量入队;成功 = 已经进队列,不代表落盘。 */
    const append = (entries: ReadonlyArray<ArchiveEntry>): Effect.Effect<void, ArchiveError> =>
      Effect.gen(function* () {
        if (entries.length === 0) return;
        const sessionId = yield* TxRef.get(sessionRef);
        // 没有 sessionId 的条目挂到当前会话;已有(如 Events 已标)就原样保留
        const tagged = entries.map((entry) =>
          entry.sessionId === undefined ? { ...entry, sessionId } : entry,
        );
        const closedError = new ArchiveError({
          message: "archive 已停止(关闭或 writer 失败),不接受 append",
        });
        const queueClosedError = new ArchiveError({ message: "archive 队列已关闭" });

        // 入队:检查 closedRef + 入队,同一事务
        yield* Effect.gen(function* () {
          if (yield* TxRef.get(closedRef)) return yield* Effect.fail(closedError);
          // `offerAll` 返回的是**没塞进去的**条目:有剩下就说明队列已经关了
          yield* Match.value(yield* TxQueue.offerAll(queue, tagged)).pipe(
            // 队列已关闭:整次 append 失败
            Match.when(hasRejected, () => Effect.fail(queueClosedError)),
            // 全塞进去了
            Match.orElse(() => Effect.void),
          );
        }).pipe(Effect.tx);

        // 入队成功就接进缓存、同一批交给投影(在 worker 落盘之前):读侧要能立刻看到这一批。
        // 两步都只是内存操作,包成不可中断,免得停在"缓存有了、投影没拿到"的中间态。
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Ref.update(cacheRef, (current) => [...current, ...tagged]);
            yield* projectionSvc.advance(tagged);
          }),
        );
      });

    /** worker 失败的**一次性**通知:worker 挂了发一条,然后流结束;晚订阅者先拿到已发生的那条。 */
    const errors: Stream.Stream<ArchiveError> = SubscriptionRef.changes(failureSubRef).pipe(
      Stream.filter(Option.isSome),
      Stream.map((state) => state.value),
    );

    /** 读回**已接收**的全部条目(内存缓存,不碰文件,不会失败)。 */
    const readAll: Effect.Effect<ReadonlyArray<ArchiveEntry>> = Ref.get(cacheRef);

    /** 读回某一会话的条目。 */
    const readSession = (sessionId: SessionId): Effect.Effect<ReadonlyArray<ArchiveEntry>> =>
      Ref.get(cacheRef).pipe(
        Effect.map((entries) => entries.filter((entry) => entry.sessionId === sessionId)),
      );

    /** 当前会话。 */
    const currentSession: Effect.Effect<SessionId> = TxRef.get(sessionRef);

    /** 已接收条目的会话(按第一次出现顺序;至少包含当前会话)。 */
    const sessions: Effect.Effect<ReadonlyArray<SessionId>> = Effect.gen(function* () {
      const entries = yield* Ref.get(cacheRef);
      const current = yield* TxRef.get(sessionRef);
      const seen: Array<SessionId> = [];
      for (const entry of entries) {
        const sessionId = entry.sessionId ?? LEGACY_SESSION_ID;
        if (!seen.includes(sessionId)) seen.push(sessionId);
      }
      if (!seen.includes(current)) seen.push(current);
      return seen;
    });

    /** 开一段新会话并切过去。 */
    const startSession: Effect.Effect<SessionId> = Effect.gen(function* () {
      const sessionId = newSessionId();
      yield* TxRef.set(sessionRef, sessionId);
      yield* projectionSvc.setSession(sessionId);
      return sessionId;
    });

    /** 切到已有会话。 */
    const useSession = (sessionId: SessionId): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* TxRef.set(sessionRef, sessionId);
        yield* projectionSvc.setSession(sessionId);
      });

    /** 投影读口:转发给 `Projection` 服务(折叠状态在那边)。 */
    const projection: ArchiveShape["projection"] = (kind) => projectionSvc.get(kind);

    return Archive.of({
      append,
      errors,
      readAll,
      readSession,
      currentSession,
      sessions,
      startSession,
      useSession,
      projection,
    });
  }),
);
