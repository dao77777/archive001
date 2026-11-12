import { describe, expect, it } from "vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scope, Stream } from "effect";
import { Archive } from "./service.ts";
import { ArchiveRuntime } from "./live.ts";
import { Projection } from "./projection/service.ts";
import { ProjectionLive } from "./projection/live.ts";
import {
  ArchiveError,
  makeArchiveEntryId,
  makeSessionId,
  newArchiveEntryId,
  type ArchiveEntry,
} from "./service.ts";
import { Sink } from "./sink/service.ts";
import { MemorySinkLive } from "./sink/memory.ts";
/**
 * 一次性折算:强制一个**新**的 `ProjectionLive` 实例 → 整份折进去 → 取两类。
 * `Layer.fresh` 不能省:`Effect.provide` 会复用当前 memo map 里已建好的实例,
 * 那样就不是"从零折一遍",而是往运行中的状态里再折一遍。
 */
const project = (entries: ReadonlyArray<ArchiveEntry>) =>
  Effect.gen(function* () {
    const projection = yield* Projection;
    yield* projection.init(entries);
    return {
      transcript: yield* projection.get("transcript"),
      inbox: yield* projection.get("inbox"),
    };
  }).pipe(Effect.provide(Layer.fresh(ProjectionLive)));

const entry = (id: string): ArchiveEntry => ({
  v: 1,
  at: 0,
  _tag: "ENGINE_START",
  id: makeArchiveEntryId(id),
  sessionId: makeSessionId("s1"),
});

const withArchive = (sink: Layer.Layer<Sink>) =>
  Layer.provide(sink)(ArchiveRuntime.pipe(Layer.provide(ProjectionLive)));

describe("Archive", () => {
  it("append 只入队,不等待 sink;关闭时再写", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));
    const sink = Layer.succeed(Sink, {
      write: (batch) =>
        Deferred.await(gate).pipe(Effect.andThen(Ref.update(entries, (all) => [...all, ...batch]))),
      read: Ref.get(entries),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        yield* archive.append([entry("e1")]);
        expect(yield* Ref.get(entries)).toEqual([]);
        yield* Deferred.succeed(gate, undefined);
      }).pipe(Effect.provide(withArchive(sink))),
    );

    expect(Effect.runSync(Ref.get(entries)).map((value) => value.id)).toEqual(["e1"]);
  });

  it("关闭 layer 时按顺序写入", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));

    await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        yield* archive.append([entry("e1"), entry("e2")]);
        yield* archive.append([entry("e3")]);
      }).pipe(Effect.provide(withArchive(MemorySinkLive(entries)))),
    );

    expect(Effect.runSync(Ref.get(entries)).map((value) => value.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("被中断时把手上这批和队列里的残余一起补写", async () => {
    // 关闭时:正在写的那批 + 队列里的残余,按这个顺序进 sink
    const started = Effect.runSync(Deferred.make<void>());
    const gate = Effect.runSync(Deferred.make<void>());
    const calls = Effect.runSync(Ref.make(0));
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));

    // 只有第一次写会卡住(它会被中断作废)
    const sink = Layer.succeed(Sink, {
      read: Ref.get(entries),
      write: (batch) =>
        Effect.gen(function* () {
          if ((yield* Ref.getAndUpdate(calls, (n) => n + 1)) === 0) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
          }
          yield* Ref.update(entries, (all) => [...all, ...batch]);
        }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(withArchive(sink), scope);
        const archive = Context.get(context, Archive);

        yield* archive.append([entry("e1")]);
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"));
        // e1 在手上,e2 / e3 在队列里
        yield* archive.append([entry("e2"), entry("e3")]);

        yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("1 second"));
      }),
    );

    // gate 从头到尾没放行:第一次写作废,e1 只可能由补写写进去
    expect(Effect.runSync(Ref.get(entries)).map((value) => value.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("关闭 layer 时等 sink 写完再退出", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const started = Effect.runSync(Deferred.make<void>());
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));
    const sink = Layer.succeed(Sink, {
      read: Ref.get(entries),
      write: (batch) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(gate);
          yield* Ref.update(entries, (all) => [...all, ...batch]);
        }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(withArchive(sink), scope);
        const archive = Context.get(context, Archive);
        yield* archive.append([entry("e1")]);

        // 主动关 scope,让收尾在后台跑
        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);

        // 收尾已经开始等 sink
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"));
        expect(yield* Ref.get(entries)).toEqual([]);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(closing).pipe(Effect.timeout("1 second"));
        expect((yield* Ref.get(entries)).map((value) => value.id)).toEqual(["e1"]);
      }),
    );
  });

  it("sink 短暂失败会重试,关闭时仍能写完", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));
    const attempts = Effect.runSync(Ref.make(0));

    const sink = Layer.succeed(Sink, {
      read: Ref.get(entries),
      write: (batch) =>
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          if (attempt <= 2) return yield* Effect.fail(new ArchiveError({ message: "try again" }));
          yield* Ref.update(entries, (all) => [...all, ...batch]);
        }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        yield* archive.append([entry("e1")]);
      }).pipe(Effect.provide(withArchive(sink))),
    );

    expect(Effect.runSync(Ref.get(entries)).map((value) => value.id)).toEqual(["e1"]);
    expect(Effect.runSync(Ref.get(attempts))).toBe(3);
  });

  it("sink 失败时关闭 layer 不报错", async () => {
    const sink = Layer.succeed(Sink, {
      write: () => Effect.fail(new ArchiveError({ message: "disk full" })),
      read: Effect.succeed([]),
    });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const archive = yield* Archive;
          yield* archive.append([entry("e1")]);
        }).pipe(Effect.provide(withArchive(sink))),
      ),
    ).resolves.toBeUndefined();
  });

  it("关闭过程中 append 失败,不入队", async () => {
    const started = Effect.runSync(Deferred.make<void>());
    const gate = Effect.runSync(Deferred.make<void>());
    const calls = Effect.runSync(Ref.make(0));
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));

    // 第一批卡住,之后的补写立即落盘
    const sink = Layer.succeed(Sink, {
      read: Ref.get(entries),
      write: (batch) =>
        Effect.gen(function* () {
          if ((yield* Ref.getAndUpdate(calls, (n) => n + 1)) === 0) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
          }
          yield* Ref.update(entries, (all) => [...all, ...batch]);
        }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(withArchive(sink), scope);
        const archive = Context.get(context, Archive);
        yield* archive.append([entry("e1")]);

        const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"));

        // 关闸发生在中断后的收尾里,所以反复探测到 append 被拒为止
        const rejected = yield* Effect.gen(function* () {
          for (let i = 0; i < 1000; i++) {
            const exit = yield* archive.append([entry("probe")]).pipe(Effect.exit);
            if (Exit.isFailure(exit)) return exit;
            yield* Effect.yieldNow;
          }
          return yield* Effect.die(new Error("关闭后 append 仍然成功"));
        });
        expect(Exit.isFailure(rejected)).toBe(true);

        yield* Fiber.join(closing).pipe(Effect.timeout("1 second"));
      }),
    );

    // probe 不算内容;e1 仍然要落盘
    expect(
      Effect.runSync(Ref.get(entries))
        .map((value) => value.id)
        .filter((id) => id !== "probe"),
    ).toEqual(["e1"]);
  });

  it("缓存是实时的已接收视图:append 立刻可读,读侧只碰内存", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));
    const reads = Effect.runSync(Ref.make(0));
    const written = Effect.runSync(Deferred.make<void>());
    const sink = Layer.succeed(Sink, {
      read: Effect.gen(function* () {
        yield* Ref.update(reads, (n) => n + 1);
        return yield* Ref.get(entries);
      }),
      write: (batch) =>
        Ref.update(entries, (all) => [...all, ...batch]).pipe(
          Effect.andThen(Deferred.succeed(written, undefined)),
        ),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        const first = yield* archive.readAll;
        yield* archive.append([entry("a")]);
        // 不等 worker 落盘:读侧看到的是"已接收"
        const beforeWrite = yield* archive.readAll;
        yield* Deferred.await(written);
        const afterWrite = yield* archive.readAll;
        const readTimes = yield* Ref.get(reads);
        return { first, beforeWrite, afterWrite, readTimes };
      }).pipe(Effect.provide(withArchive(sink))),
    );

    expect(result.first).toEqual([]);
    expect(result.beforeWrite.map((value) => value.id)).toEqual(["a"]);
    expect(result.afterWrite.map((value) => value.id)).toEqual(["a"]);
    // 只在构建时读过一次文件
    expect(result.readTimes).toBe(1);
  });

  it("构建时的底稿与之后 append 的条目接在一起,不重复", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([entry("old")]));
    const written = Effect.runSync(Deferred.make<void>());
    const sink = Layer.succeed(Sink, {
      read: Ref.get(entries),
      write: (batch) =>
        Ref.update(entries, (all) => [...all, ...batch]).pipe(
          Effect.andThen(Deferred.succeed(written, undefined)),
        ),
    });

    const readBack = await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        yield* archive.append([entry("a")]);
        yield* Deferred.await(written);
        return yield* archive.readAll;
      }).pipe(Effect.provide(withArchive(sink))),
    );

    expect(readBack.map((value) => value.id)).toEqual(["old", "a"]);
  });

  it("session:新会话互相隔离,readSession / sessions / useSession 可用", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));
    const sink = MemorySinkLive(entries);

    /** 一段 run:ENGINE_START → turn → step → 正文 → 收尾。 */
    const turnEvents = (text: string): ReadonlyArray<ArchiveEntry> => {
      const turnId = newArchiveEntryId();
      const stepId = newArchiveEntryId();
      return [
        { v: 1, at: 1, _tag: "ENGINE_START", id: newArchiveEntryId() },
        { v: 1, at: 2, _tag: "TURN_START", id: turnId },
        { v: 1, at: 3, _tag: "STEP_START", id: stepId, parentId: turnId },
        { v: 1, at: 4, _tag: "ASSISTANT_MESSAGE", id: newArchiveEntryId(), parentId: stepId, text },
        { v: 1, at: 5, _tag: "STEP_END", id: stepId, parentId: turnId },
        { v: 1, at: 6, _tag: "TURN_END", id: turnId },
      ];
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        const a = yield* archive.currentSession;
        yield* archive.append(turnEvents("A"));
        const b = yield* archive.startSession;
        yield* archive.append(turnEvents("B"));

        const readA = yield* archive.readSession(a);
        const readB = yield* archive.readSession(b);
        const transcriptB = yield* archive.projection("transcript");
        yield* archive.useSession(a);
        const transcriptA = yield* archive.projection("transcript");
        const c = yield* archive.startSession;
        const sessions = yield* archive.sessions;
        const empty = yield* archive.projection("transcript");
        return { a, b, c, sessions, readA, readB, transcriptA, transcriptB, empty };
      }).pipe(Effect.provide(withArchive(sink))),
    );

    expect(result.a).not.toBe(result.b);
    expect(result.readA.every((value) => value.sessionId === result.a)).toBe(true);
    expect(result.readB.every((value) => value.sessionId === result.b)).toBe(true);
    expect(result.sessions).toEqual([result.a, result.b, result.c]);
    expect(result.transcriptA).toEqual([{ type: "ASSISTANT_MESSAGE", text: "A" }]);
    expect(result.transcriptB).toEqual([{ type: "ASSISTANT_MESSAGE", text: "B" }]);
    expect(result.empty).toEqual([]);
  });

  it("readAll + project:换一个新实例就能读回并投影(外部环境恢复)", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));
    const sink = MemorySinkLive(entries);
    const offer: ArchiveEntry = {
      v: 1,
      at: 1,
      _tag: "INBOX_OFFER",
      id: makeArchiveEntryId("offer"),
      message: { _tag: "USER_MESSAGE", id: "p1", payload: { text: "还没被取走" } },
    };

    // 第一段:写(作用域关闭时 worker 会把残留也写进 sink)
    await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        yield* archive.append([offer]);
      }).pipe(Effect.provide(withArchive(sink))),
    );

    // 第二段:新实例只读 —— 这就是"外部环境拿它恢复"
    const { readBack, restored, transcript, inbox } = await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        const entriesRead = yield* archive.readAll;
        return {
          readBack: entriesRead,
          restored: yield* project(entriesRead),
          transcript: yield* archive.projection("transcript"),
          inbox: yield* archive.projection("inbox"),
        };
      }).pipe(Effect.provide(withArchive(sink))),
    );

    expect(readBack.map((value) => value._tag)).toEqual(["INBOX_OFFER"]);
    // 还没被 take 走:投影里它还在 inbox 的 queue 里
    expect(restored.inbox.queue.map((message) => message.id)).toEqual(["p1"]);
    expect(restored.transcript).toEqual([]);
    expect(transcript).toEqual([]);
    expect(inbox.queue.map((message) => message.id)).toEqual(["p1"]);
    expect(inbox.staged).toEqual([]);
  });

  it("投影缓存是增量的:分次 append,读到的与整份投影一致", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));
    const sink = MemorySinkLive(entries);
    const id = (value: string) => makeArchiveEntryId(value);
    const entry = (at: number, payload: ArchiveEntry extends never ? never : object) =>
      ({ v: 1, at, ...payload }) as ArchiveEntry;

    // 一轮纯问答:TURN_START → STEP_START → 正文 → STEP_END → TURN_END
    const head: ReadonlyArray<ArchiveEntry> = [
      entry(1, { _tag: "ENGINE_START", id: id("e1") }),
      entry(2, { _tag: "TURN_START", id: id("t1") }),
      entry(3, { _tag: "STEP_START", id: id("s1"), parentId: id("t1") }),
    ];
    const tail: ReadonlyArray<ArchiveEntry> = [
      entry(4, {
        _tag: "ASSISTANT_MESSAGE",
        id: id("a1"),
        parentId: id("s1"),
        text: "第一轮",
      }),
      entry(5, { _tag: "STEP_END", id: id("s1"), parentId: id("t1") }),
      entry(6, { _tag: "TURN_END", id: id("t1") }),
    ];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* Archive;
        yield* archive.append(head);
        const partial = yield* archive.projection("transcript"); // step 还没结束:空
        yield* archive.append(tail);
        const after = yield* archive.projection("transcript"); // 只折了新增的三条
        const all = yield* project(yield* archive.readAll);
        return { partial, after, expected: all.transcript };
      }).pipe(Effect.provide(withArchive(sink))),
    );

    expect(result.partial).toEqual([]);
    expect(result.after).toEqual([{ type: "ASSISTANT_MESSAGE", text: "第一轮" }]);
    // 增量折叠与整份投影一致
    expect(result.after).toEqual(result.expected);
  });

  it("worker 失败后:errors 发出错误,之后 append 直接失败", async () => {
    const sink = Layer.succeed(Sink, {
      write: () => Effect.fail(new ArchiveError({ message: "disk full" })),
      read: Effect.succeed([]),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(withArchive(sink), scope);
        const archive = Context.get(context, Archive);

        // 入队不关心 writer:这条先成功
        yield* archive.append([entry("e1")]);

        // 失败一次性通知(含重试后,给够时间)
        const reported = yield* Stream.runHead(archive.errors).pipe(Effect.timeout("1 second"));
        expect(Option.isSome(reported) ? reported.value.message : undefined).toBe("disk full");

        // 之后 append 不用订阅也能立刻失败
        const after = yield* Effect.exit(archive.append([entry("e2")]));
        expect(Exit.isFailure(after)).toBe(true);

        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("关闭后 append 失败,不静默丢弃", async () => {
    const entries = Effect.runSync(Ref.make<ReadonlyArray<ArchiveEntry>>([]));

    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(withArchive(MemorySinkLive(entries)), scope);
        const archive = Context.get(context, Archive);
        yield* archive.append([entry("e1")]);

        // scope 关完:收尾已排空并关闸,worker 已中断
        yield* Scope.close(scope, Exit.void);

        return yield* archive.append([entry("late")]).pipe(Effect.exit);
      }),
    );

    // 关闭之后的 append:失败,不是静默丢弃
    expect(Exit.isFailure(after)).toBe(true);
    expect(Effect.runSync(Ref.get(entries)).map((value) => value.id)).toEqual(["e1"]);
  });
});
