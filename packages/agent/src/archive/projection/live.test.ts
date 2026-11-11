import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Ref, Stream } from "effect";
import { ArchiveRuntime } from "../live.ts";
import { Projection } from "./service.ts";
import { ProjectionLive } from "./live.ts";
import { Sink } from "../sink/service.ts";
import { makeSessionId, newArchiveEntryId, type ArchiveEntry, type SessionId } from "../service.ts";
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
import { Loop, type LoopRun } from "../../loop/service.ts";
import { LoopRuntime } from "../../loop/live.ts";
import { makeTurnHook } from "../../turn/live.ts";
import { EngineLive } from "../../loop/engine/live.ts";
import { InboxLive } from "../../loop/inbox/live.ts";
import { EventsLive } from "../../loop/events/live.ts";
import { ToolExecutorLive } from "../../loop/tool-executor/live.ts";
import { BuiltinToolsLive } from "../../loop/builtin-tools/live.ts";
import { NodeServices } from "@effect/platform-node";
import type { Tool } from "../../loop/tool-executor/service.ts";
import { DEFAULT_SETTINGS } from "../../llm/_constants.ts";
import { Llm } from "../../llm/service.ts";
import type { Item, LlmSettings } from "../../llm/_domain.ts";

const testSettings: LlmSettings = {
  ...DEFAULT_SETTINGS,
  apiKey: Redacted.make("test-key"),
  baseUrl: "http://127.0.0.1:1",
};

const callItem: Item = {
  type: "FUNCTION_CALL",
  callId: "call_1",
  name: "bash",
  arguments: '{"command":"ls"}',
};

/** 按脚本依次回复的假 LLM(只想拿到真实事件,不关心 wire)。 */
const scriptedLlm = (script: ReadonlyArray<ReadonlyArray<Item>>) =>
  Layer.effect(
    Llm,
    Effect.gen(function* () {
      const step = yield* Ref.make(0);
      return Llm.of({
        complete: () =>
          Effect.gen(function* () {
            const index = yield* Ref.get(step);
            yield* Ref.update(step, (n) => n + 1);
            return script[index] ?? script[script.length - 1] ?? [];
          }),
      });
    }),
  );

const TestArchive = ArchiveRuntime.pipe(
  Layer.provide(ProjectionLive),
  Layer.provide(Layer.succeed(Sink, { write: () => Effect.void, read: Effect.succeed([]) })),
);

/** `LoopRuntime` 不做任何 provide:这里把内部实现 + 注入的 Llm / archive 一起给它。 */
const agentLayer = (llm: Layer.Layer<Llm>) =>
  LoopRuntime.pipe(
    Layer.provide(EngineLive),
    Layer.provide(ToolExecutorLive),
    Layer.provide(InboxLive),
    Layer.provide(EventsLive),
    Layer.provide(BuiltinToolsLive.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(TestArchive),
    Layer.provide(llm),
  );

const echoTool = (output = "stub"): Tool => ({
  definition: { name: "bash", description: "stub", parameters: { type: "object" } },
  execute: () => Effect.succeed(output),
});

/**
 * 起一个 agent,把事件收进数组,执行 `run` 直到 `until` 说"够了"。
 * 返回收集到的事件与"停"的函数(中断引擎,让 `ENGINE_END` 也进数组)。
 */
const collect = (
  script: ReadonlyArray<ReadonlyArray<Item>>,
  tools: ReadonlyArray<Tool>,
  drive: (run: LoopRun, events: Array<ArchiveEntry>) => Effect.Effect<void>,
) => {
  const { layer } = { layer: scriptedLlm(script) };
  const events: Array<ArchiveEntry> = [];

  return Effect.gen(function* () {
    // 起引擎,从句柄上 configure:句柄里有事件流与纤维
    const run = yield* (yield* Loop).run({ archive: makeTurnHook() });
    yield* run.configure({ settings: testSettings, tools: Option.some(tools) });
    yield* run.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
      Effect.forkChild({ startImmediately: true }),
    );

    yield* drive(run, events);

    yield* Fiber.interrupt(run.fiber);
    // 让事件订阅纤维把 `ENGINE_END` 也收进来
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    return events;
  }).pipe(Effect.provide(agentLayer(layer)));
};

/** 发一条 prompt,等到这一轮的 `TURN_END`。 */
const ask = (run: LoopRun, text: string) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    yield* run.events.pipe(
      Stream.takeUntil((event) => event._tag === "TURN_END"),
      Stream.runForEach((event) =>
        event._tag === "TURN_END" ? Deferred.succeed(done, undefined) : Effect.void,
      ),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* run.send({ id: crypto.randomUUID(), text });
    yield* Deferred.await(done);
  });

describe("archive 投影", () => {
  it("工具轮:transcript 是「观测紧跟调用、回答最后」,inbox 也已清空", async () => {
    const events = await Effect.runPromise(
      collect(
        [
          [{ type: "REASONING", text: "先看看目录" }, callItem],
          [{ type: "ASSISTANT_MESSAGE", text: "完成" }],
        ],
        [echoTool("a.txt")],
        (run) => ask(run, "看看目录"),
      ),
    );

    const projection = await Effect.runPromise(project(events));

    // 没有残留消息:prompt 与工具结果都被取走并进了 step
    expect(projection.inbox.queue).toEqual([]);
    expect(projection.inbox.staged).toEqual([]);

    // 与状态机内存里那份同形:结果紧跟调用,纯问答轮不带 reasoning
    expect(projection.transcript).toEqual([
      { type: "USER_MESSAGE", text: "看看目录" },
      { type: "REASONING", text: "先看看目录" },
      callItem,
      { type: "FUNCTION_CALL_OUTPUT", callId: "call_1", output: "a.txt" },
      { type: "ASSISTANT_MESSAGE", text: "完成" },
    ]);
  });

  it("最终回答逐条投影:多段正文不合并成一条", async () => {
    const events = await Effect.runPromise(
      collect(
        [
          [
            { type: "ASSISTANT_MESSAGE", text: "前半" },
            { type: "ASSISTANT_MESSAGE", text: "后半" },
          ],
        ],
        [],
        (run) => ask(run, "说两句"),
      ),
    );

    expect((await Effect.runPromise(project(events))).transcript).toEqual([
      { type: "USER_MESSAGE", text: "说两句" },
      { type: "ASSISTANT_MESSAGE", text: "前半" },
      { type: "ASSISTANT_MESSAGE", text: "后半" },
    ]);
  });

  it("等工具时插进来的 prompt:投影出的 transcript 是「观测在前、prompt 在后」", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const started = Effect.runSync(Deferred.make<void>());
    const gatedTool: Tool = {
      definition: { name: "bash", description: "stub", parameters: { type: "object" } },
      execute: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as("a.txt"),
        ),
    };

    const events = await Effect.runPromise(
      collect([[callItem], [{ type: "ASSISTANT_MESSAGE", text: "完成" }]], [gatedTool], (run) =>
        Effect.gen(function* () {
          const turn = yield* ask(run, "看看目录").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
          // 等结果时再问一句:并进同一轮,但排在观测后面
          yield* run.send({ id: crypto.randomUUID(), text: "顺便看看别处" });
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(turn);
        }),
      ),
    );

    expect((await Effect.runPromise(project(events))).transcript).toEqual([
      { type: "USER_MESSAGE", text: "看看目录" },
      callItem,
      { type: "FUNCTION_CALL_OUTPUT", callId: "call_1", output: "a.txt" },
      { type: "USER_MESSAGE", text: "顺便看看别处" },
      { type: "ASSISTANT_MESSAGE", text: "完成" },
    ]);
  });

  it("取走但没进任何 step 的消息进 staged(迟到的工具结果)", async () => {
    const entries: ReadonlyArray<ArchiveEntry> = [
      {
        v: 1,
        at: 1,
        _tag: "INBOX_OFFER",
        id: newArchiveEntryId(),
        message: {
          _tag: "FUNCTION_CALL_OUTPUT",
          id: "r1",
          payload: { callId: "call_x", name: "bash", output: "迟到" },
        },
      },
      { v: 1, at: 2, _tag: "INBOX_TAKE", id: newArchiveEntryId(), messageIds: ["r1"] },
    ];

    const projection = await Effect.runPromise(project(entries));

    expect(projection.transcript).toEqual([]);
    expect(projection.inbox.queue).toEqual([]);
    expect(projection.inbox.staged.map((message) => message.id)).toEqual(["r1"]);
  });

  it("init 是从头折一遍:再 init 一份日志,状态只剩这一份", async () => {
    const offer = (id: string): ArchiveEntry => ({
      v: 1,
      at: 1,
      _tag: "INBOX_OFFER",
      id: newArchiveEntryId(),
      message: { _tag: "USER_MESSAGE", id, payload: { text: `第 ${id} 条` } },
    });

    const inbox = await Effect.runPromise(
      Effect.provide(Layer.fresh(ProjectionLive))(
        Effect.gen(function* () {
          const projection = yield* Projection;
          yield* projection.init([offer("p1")]);
          yield* projection.init([offer("p2")]);
          return yield* projection.get("inbox");
        }),
      ),
    );

    expect(inbox.queue.map((message) => message.id)).toEqual(["p2"]);
  });

  it("transcript 跨 ENGINE_START 保留;不同 sessionId 互相隔离", async () => {
    /** 一段 run:ENGINE_START → turn → step → 正文 → 收尾。 */
    const turnEvents = (
      text: string,
      at: number,
      sessionId: SessionId,
    ): ReadonlyArray<ArchiveEntry> => {
      const turnId = newArchiveEntryId();
      const stepId = newArchiveEntryId();
      return [
        { v: 1, at, _tag: "ENGINE_START", id: newArchiveEntryId(), sessionId },
        { v: 1, at, _tag: "TURN_START", id: turnId, sessionId },
        { v: 1, at, _tag: "STEP_START", id: stepId, parentId: turnId, sessionId },
        {
          v: 1,
          at,
          _tag: "ASSISTANT_MESSAGE",
          id: newArchiveEntryId(),
          parentId: stepId,
          text,
          sessionId,
        },
        { v: 1, at, _tag: "STEP_END", id: stepId, parentId: turnId, sessionId },
        { v: 1, at, _tag: "TURN_END", id: turnId, sessionId },
      ];
    };

    const a = makeSessionId("session-a");
    const b = makeSessionId("session-b");

    const result = await Effect.runPromise(
      Effect.provide(Layer.fresh(ProjectionLive))(
        Effect.gen(function* () {
          const projection = yield* Projection;
          yield* projection.init([
            ...turnEvents("A-1", 1, a),
            ...turnEvents("A-2", 2, a),
            ...turnEvents("B-1", 3, b),
          ]);
          const byDefault = yield* projection.get("transcript"); // 最后一段 = B
          yield* projection.setSession(a);
          const sessionA = yield* projection.get("transcript");
          yield* projection.setSession(b);
          const sessionB = yield* projection.get("transcript");
          return { byDefault, sessionA, sessionB };
        }),
      ),
    );

    // 两个 run 接同一份 transcript
    expect(result.sessionA).toEqual([
      { type: "ASSISTANT_MESSAGE", text: "A-1" },
      { type: "ASSISTANT_MESSAGE", text: "A-2" },
    ]);
    // 默认是 init 里最后出现的会话
    expect(result.byDefault).toEqual([{ type: "ASSISTANT_MESSAGE", text: "B-1" }]);
    expect(result.sessionB).toEqual([{ type: "ASSISTANT_MESSAGE", text: "B-1" }]);
  });
});
