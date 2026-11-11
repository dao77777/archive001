import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Layer, Option, Redacted, Ref, Stream } from "effect";
import { NodeServices } from "@effect/platform-node";
import { ArchiveRuntime } from "../archive/live.ts";
import { ProjectionLive } from "../archive/projection/live.ts";
import { Sink } from "../archive/sink/service.ts";
import { ArchiveError } from "../archive/service.ts";
import { SYSTEM_MESSAGE } from "./engine/live.ts";
import { TOOL_MAX_OUTPUT } from "./tool-executor/live.ts";
import { Loop, type LoopRun } from "./service.ts";
import { LoopRuntime } from "./live.ts";
import { EngineLive } from "./engine/live.ts";
import { InboxLive } from "./inbox/live.ts";
import { EventsLive } from "./events/live.ts";
import { ToolExecutorLive } from "./tool-executor/live.ts";
import { BuiltinToolsLive } from "./builtin-tools/live.ts";
import { Turn } from "../turn/service.ts";
import { makeTurnHook, TurnLive } from "../turn/live.ts";
import { type ArchiveEntry } from "../archive/service.ts";
import type { Tool } from "./tool-executor/service.ts";
import { DEFAULT_SETTINGS } from "../llm/_constants.ts";
import { LlmError, type LlmSettings, type ToolDefinition } from "../llm/_domain.ts";
import { Llm } from "../llm/service.ts";
import type { Item } from "../llm/_domain.ts";

/** 循环不碰连接信息,但 `LlmSettings` 里带着,于是给一份假的(假 LLM 从不发请求)。 */
const testSettings: LlmSettings = {
  ...DEFAULT_SETTINGS,
  apiKey: Redacted.make("test-key"),
  baseUrl: "http://127.0.0.1:1",
};

const textItem = (role: "user" | "assistant", text: string): Item =>
  role === "user" ? { type: "USER_MESSAGE", text } : { type: "ASSISTANT_MESSAGE", text };

const callItem: Item = {
  type: "FUNCTION_CALL",
  callId: "call_1",
  name: "bash",
  arguments: '{"command":"ls"}',
};

const toolTurn: ReadonlyArray<Item> = [{ type: "REASONING", text: "先看目录" }, callItem];

/** 按脚本依次回复的假 LLM;顺带记录每次收到什么历史。 */
const scriptedLlm = (script: ReadonlyArray<ReadonlyArray<Item>>) => {
  const seen: Array<ReadonlyArray<Item>> = [];
  const seenTools: Array<ReadonlyArray<ToolDefinition>> = [];
  const layer = Layer.effect(
    Llm,
    Effect.gen(function* () {
      const step = yield* Ref.make(0);
      return Llm.of({
        complete: (items, tools) =>
          Effect.gen(function* () {
            seen.push(items);
            seenTools.push(tools);
            const index = yield* Ref.get(step);
            yield* Ref.update(step, (n) => n + 1);
            return script[index] ?? script[script.length - 1] ?? [];
          }),
      });
    }),
  );
  return { layer, seen, seenTools };
};

/** 不做真事的工具:只回显被调用了。 */
const stubTools: ReadonlyArray<Tool> = [
  {
    definition: { name: "bash", description: "stub", parameters: { type: "object" } },
    execute: (rawArguments) => Effect.succeed(`stub:bash(${rawArguments})`),
  },
];

const TestArchive = ArchiveRuntime.pipe(
  Layer.provide(ProjectionLive),
  Layer.provide(
    Layer.succeed(Sink, {
      write: () => Effect.void,
      read: Effect.succeed([]),
    }),
  ),
);

/** `LoopRuntime` 不做任何 provide:这里把内部实现 + 注入的 Llm / archive 一起给它。 */
const loopLayer = (llm: Layer.Layer<Llm>) =>
  LoopRuntime.pipe(
    Layer.provide(EngineLive),
    Layer.provide(ToolExecutorLive),
    Layer.provide(InboxLive),
    Layer.provide(EventsLive),
    Layer.provide(BuiltinToolsLive.pipe(Layer.provide(NodeServices.layer))),
    Layer.provide(TestArchive),
    Layer.provide(llm),
  );

/** 客户端拿到的完整应用:`Agent`(持续运行)+ `Turn`(一次完整 runTurn)。 */
const agentLayer = (llm: Layer.Layer<Llm>) => {
  const loop = loopLayer(llm);
  return Layer.merge(loop, TurnLive.pipe(Layer.provide(loop)));
};

/** 外部使用方式:起引擎 → 从句柄上 configure。 */
const start = (settings: LlmSettings = testSettings, tools: ReadonlyArray<Tool> = stubTools) =>
  Effect.gen(function* () {
    const session = yield* (yield* Loop).run({ archive: makeTurnHook() });
    yield* session.configure({ settings, tools: Option.some(tools) });
    return session;
  });

/**
 * 持续运行模式下的 `ask`:句柄不再带解析助手,这里按事件自己对齐 turn、收回答。
 * 顶层 `runTurn` 的解析是同一套规则(生产代码里只留一份),这里保留一份是为了测
 * 「常驻 run + 自己订阅」这条路径。
 */
const ask = (session: LoopRun, text: string): Effect.Effect<string, LlmError> =>
  Effect.gen(function* () {
    const id = crypto.randomUUID();
    const answer = yield* Ref.make("");
    const failure = yield* Ref.make<string | undefined>(undefined);
    const done = yield* Deferred.make<void>();
    /** 自己的 prompt 出现在哪一轮:`INBOX_TAKE` 对齐 turn,`step.parentId` 也能查。 */
    let turnId: string | undefined;
    let currentTurnId: string | undefined;
    let pendingPrompt = false;
    const stepParents = new Map<string, string>();

    const wait = yield* session.events.pipe(
      Stream.takeUntil(
        (event) =>
          event._tag === "ENGINE_END" ||
          (turnId !== undefined && event._tag === "TURN_END" && event.id === turnId),
      ),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event._tag === "INBOX_TAKE" && event.messageIds.includes(id)) {
            if (currentTurnId !== undefined) turnId = currentTurnId;
            else pendingPrompt = true;
          }
          if (event._tag === "TURN_START") {
            currentTurnId = event.id;
            if (pendingPrompt) {
              turnId = event.id;
              pendingPrompt = false;
            }
          }
          if (event._tag === "STEP_START" && event.parentId !== undefined) {
            stepParents.set(event.id, event.parentId);
          }
          if (event._tag === "USER_MESSAGE" && event.inboxId === id) {
            turnId = stepParents.get(event.parentId ?? "") ?? currentTurnId;
          }
          if (event._tag === "TURN_ERROR" && event.parentId === turnId) {
            yield* Ref.set(failure, event.message);
          }
          if (
            event._tag === "STEP_ERROR" &&
            turnId !== undefined &&
            stepParents.get(event.parentId ?? "") === turnId
          ) {
            yield* Ref.set(failure, event.message);
          }
          if (event._tag === "ENGINE_ERROR") {
            yield* Ref.set(failure, event.message);
          }
          if (event._tag === "STEP_START") yield* Ref.set(answer, "");
          if (event._tag === "ASSISTANT_MESSAGE") {
            yield* Ref.update(answer, (text) => text + event.text);
          }
          if (event._tag === "ENGINE_END") {
            yield* Ref.update(failure, (current) => current ?? "agent 已停止");
            yield* Deferred.succeed(done, undefined);
          }
          if (event._tag === "TURN_END") {
            if (event.id === currentTurnId) currentTurnId = undefined;
            if (event.id === turnId) yield* Deferred.succeed(done, undefined);
          }
        }),
      ),
      Effect.forkChild({ startImmediately: true }),
    );

    yield* session.send({ id, text });
    yield* Fiber.join(wait);
    yield* Deferred.await(done);

    const error = yield* Ref.get(failure);
    if (error !== undefined) return yield* Effect.fail(new LlmError({ message: error }));

    return yield* Ref.get(answer);
  });

/** 只挑语义事件做断言,生命周期事件单独看。 */
const meaningful = (events: ReadonlyArray<ArchiveEntry>): ReadonlyArray<string> =>
  events.flatMap((event) => {
    if (event._tag === "INBOX_OFFER") {
      return event.message._tag === "FUNCTION_CALL_OUTPUT" ? ["tool.result"] : [];
    }
    return ["REASONING", "ASSISTANT_MESSAGE", "FUNCTION_CALL"].includes(event._tag)
      ? [event._tag]
      : [];
  });

const collect = (
  script: ReadonlyArray<ReadonlyArray<Item>>,
  input = "干活",
  tools: ReadonlyArray<Tool> = stubTools,
) => {
  const { layer, seen } = scriptedLlm(script);
  return Effect.gen(function* () {
    const session = yield* start(testSettings, tools);
    const events: Array<ArchiveEntry> = [];
    yield* session.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
      Effect.forkChild({ startImmediately: true }),
    );
    const answer = yield* ask(session, input);
    return { answer, events, seen };
  }).pipe(Effect.provide(agentLayer(layer)));
};

describe("Agent", () => {
  it("模型要求调工具时执行工具,再拿结果继续,直到只回正文", async () => {
    const { answer, events, seen } = await Effect.runPromise(
      collect([toolTurn, [textItem("assistant", "完成")]]),
    );

    expect(answer).toBe("完成");
    expect(meaningful(events)).toEqual([
      "REASONING",
      "FUNCTION_CALL",
      "tool.result",
      "ASSISTANT_MESSAGE",
    ]);

    // 结构:engine → inbox.offer → turn → step → turn.end
    const tags = events.map((event) => event._tag);
    expect(tags).toContain("ENGINE_START");
    expect(tags).toContain("INBOX_OFFER");
    expect(tags).toContain("INBOX_TAKE");
    expect(tags).toContain("TURN_START");
    expect(tags).toContain("STEP_START");
    expect(tags).toContain("STEP_END");
    expect(tags).toContain("TURN_END");

    // 第二次调用拿到的是 item 历史:system + user + (reasoning, function_call) + 结果
    const second = seen[1] ?? [];
    expect(second.map((item) => item.type)).toEqual([
      "SYSTEM_MESSAGE",
      "USER_MESSAGE",
      "REASONING",
      "FUNCTION_CALL",
      "FUNCTION_CALL_OUTPUT",
    ]);
    expect(second[4]).toMatchObject({ callId: "call_1", output: 'stub:bash({"command":"ls"})' });
  });

  it("工具输出截断保留头尾:超长时只丢中间,尾部报错仍在", async () => {
    const middle = "x".repeat(TOOL_MAX_OUTPUT * 3);
    const lastLine = "Error: 最后一行才是关键线索";
    const huge = `${middle}\n${lastLine}`;
    const tools: ReadonlyArray<Tool> = [
      {
        definition: { name: "bash", description: "stub", parameters: { type: "object" } },
        // 工具自己不管上限:截断是执行器的事
        execute: () => Effect.succeed(huge),
      },
    ];

    const { events, seen } = await Effect.runPromise(
      collect([toolTurn, [textItem("assistant", "完成")]], "干活", tools),
    );

    const observed = events.flatMap((event) =>
      event._tag === "INBOX_OFFER" && event.message._tag === "FUNCTION_CALL_OUTPUT"
        ? [event.message.payload.output]
        : [],
    );
    expect(observed).toHaveLength(1);

    const half = TOOL_MAX_OUTPUT / 2;
    const output = observed[0] ?? "";
    // 头尾都留:开头能看到上下文,结尾能看到报错 / exit code
    expect(output.startsWith(huge.slice(0, half))).toBe(true);
    expect(output.endsWith(huge.slice(-half))).toBe(true);
    expect(output.endsWith(lastLine)).toBe(true);
    // 中间省略多少写清楚,不被切成"看起来完整"的一条
    expect(output).toContain(`中间已截断 ${huge.length - TOOL_MAX_OUTPUT} 字符`);

    // 截断后的文本才是进 transcript、回喂给模型的东西
    const fed = (seen[1] ?? []).find((item) => item.type === "FUNCTION_CALL_OUTPUT");
    expect(fed).toMatchObject({ output });
  });

  it("一批调用并发执行:完成即写回,transcript 仍按调用顺序", async () => {
    /** 完成顺序:用来证明两个工具真的重叠跑了。 */
    const finished: Array<string> = [];
    // 建 Deferred 不需要服务,直接拿;串行执行时第一个工具会一直等不到第二个跑完
    const secondFinished = Effect.runSync(Deferred.make<void>());

    const slowFirst: Tool = {
      definition: { name: "bash", description: "stub", parameters: { type: "object" } },
      execute: () =>
        Deferred.await(secondFinished).pipe(
          Effect.as("第一"),
          Effect.tap(() => Effect.sync(() => void finished.push("call_1"))),
        ),
    };
    const fastSecond: Tool = {
      definition: { name: "read_file", description: "stub", parameters: { type: "object" } },
      execute: () =>
        Effect.succeed("第二").pipe(
          Effect.tap(() => Effect.sync(() => void finished.push("call_2"))),
          // 先记完成,再放第一个工具走:完成顺序是确定的
          Effect.tap(() => Deferred.succeed(secondFinished, undefined)),
        ),
    };
    const twoCalls: ReadonlyArray<Item> = [
      callItem, // call_1 → bash(慢,等 call_2 先跑完)
      { type: "FUNCTION_CALL", callId: "call_2", name: "read_file", arguments: "{}" },
    ];

    const { answer, events, seen } = await Effect.runPromise(
      collect([twoCalls, [textItem("assistant", "完成")]], "干活", [slowFirst, fastSecond]).pipe(
        Effect.timeout("5 seconds"),
      ),
    );

    expect(answer).toBe("完成");
    // 串行执行会死等:call_2 根本没开始;并发下 call_2 先跑完
    expect(finished).toEqual(["call_2", "call_1"]);

    // 写回顺序 = 完成顺序(不保证调用顺序),两条观测都在
    const observations = events.flatMap((event) =>
      event._tag === "INBOX_OFFER" && event.message._tag === "FUNCTION_CALL_OUTPUT"
        ? [event.message.payload.callId]
        : [],
    );
    expect([...observations].sort()).toEqual(["call_1", "call_2"]);

    // 回放契约只依赖 transcript:并进 transcript 时按 pending(调用顺序)重排
    const fed = (seen[1] ?? []).flatMap((item) =>
      item.type === "FUNCTION_CALL_OUTPUT" ? [{ callId: item.callId, output: item.output }] : [],
    );
    expect(fed).toEqual([
      { callId: "call_1", output: "第一" },
      { callId: "call_2", output: "第二" },
    ]);
  });

  it("工具失败 / 抛异常都变成观测:执行器不崩,模型拿到的仍是 call result", async () => {
    const failing: Tool = {
      definition: { name: "bash", description: "stub", parameters: { type: "object" } },
      execute: () => Effect.fail(new Error("命令炸了")),
    };
    const dying: Tool = {
      definition: { name: "read_file", description: "stub", parameters: { type: "object" } },
      // 直接抛异常(缺陷)也不能把执行器带走
      execute: () => Effect.die(new Error("参数都没解析就崩了")),
    };
    const twoCalls: ReadonlyArray<Item> = [
      callItem,
      { type: "FUNCTION_CALL", callId: "call_2", name: "read_file", arguments: "{}" },
    ];

    const { answer, events } = await Effect.runPromise(
      collect([twoCalls, [textItem("assistant", "完成")]], "干活", [failing, dying]),
    );

    expect(answer).toBe("完成");
    const observations = events.flatMap((event) =>
      event._tag === "INBOX_OFFER" && event.message._tag === "FUNCTION_CALL_OUTPUT"
        ? [event.message.payload.output]
        : [],
    );
    expect(observations).toEqual(["错误:命令炸了", "错误:参数都没解析就崩了"]);
  });

  it("模型调了没提供的工具:错误当观测回填,循环继续", async () => {
    const unknownCall: Item = {
      type: "FUNCTION_CALL",
      callId: "call_x",
      name: "nope",
      arguments: "{}",
    };
    const { answer, seen } = await Effect.runPromise(
      collect([[unknownCall], [textItem("assistant", "完成")]]),
    );
    expect(answer).toBe("完成");

    const second = seen[1] ?? [];
    expect(second[3]).toMatchObject({
      type: "FUNCTION_CALL_OUTPUT",
      callId: "call_x",
      output: "错误:未知工具 nope",
    });
  });

  it("思维链先于工具调用发出去", async () => {
    const { events } = await Effect.runPromise(
      collect([toolTurn, [textItem("assistant", "完成")]]),
    );
    const tags = meaningful(events);
    expect(tags.indexOf("REASONING")).toBeLessThan(tags.indexOf("FUNCTION_CALL"));
  });

  it("有工具调用时,正文作为「宣告」在工具之前渲染", async () => {
    const { events } = await Effect.runPromise(
      collect([
        [...toolTurn, textItem("assistant", "我先查一下")],
        [textItem("assistant", "完成")],
      ]),
    );
    expect(meaningful(events)).toEqual([
      "REASONING",
      "ASSISTANT_MESSAGE",
      "FUNCTION_CALL",
      "tool.result",
      "ASSISTANT_MESSAGE",
    ]);
  });

  it("一轮到位时,最后一步的 text 就是回答", async () => {
    const { answer, events } = await Effect.runPromise(
      collect([[textItem("assistant", "你好呀")]], "你好"),
    );
    expect(answer).toBe("你好呀");
    expect(meaningful(events)).toEqual(["ASSISTANT_MESSAGE"]);
  });

  it("runTurn 自己解析这一轮:按事件转发,回答仍由返回值给出", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "你好")]]);
    const seen: Array<ArchiveEntry> = [];

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const turn = yield* Turn;
        return yield* turn.runTurn(
          { settings: testSettings, tools: Option.some(stubTools) },
          { text: "你好" },
          { onEvent: (event) => Effect.sync(() => void seen.push(event)) },
        );
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(answer).toBe("你好");
    // 转发的是完整事件;prompt id 由 runTurn 生成,外部只能从 INBOX_OFFER 里认
    const tags = seen.map((event) => event._tag);
    expect(tags).toEqual(
      expect.arrayContaining([
        "ENGINE_START",
        "INBOX_OFFER",
        "INBOX_TAKE",
        "TURN_START",
        "STEP_START",
        "ASSISTANT_MESSAGE",
        "STEP_END",
        "TURN_END",
      ]),
    );
    const promptId = seen.flatMap((event) =>
      event._tag === "INBOX_OFFER" && event.message._tag === "USER_MESSAGE"
        ? [event.message.id]
        : [],
    )[0];
    expect(
      seen.some(
        (event) => event._tag === "INBOX_TAKE" && event.messageIds.includes(promptId ?? ""),
      ),
    ).toBe(true);
  });

  it("onEvent 抛异常时 runTurn 以 LlmError 收尾,不会永远挂在等回答上", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "不该被用到")]]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const turn = yield* Turn;
        return yield* turn
          .runTurn(
            { settings: testSettings, tools: Option.some(stubTools) },
            { text: "一" },
            {
              onEvent: () => Effect.die(new Error("渲染炸了")),
            },
          )
          .pipe(Effect.result);
      }).pipe(Effect.provide(agentLayer(layer)), Effect.timeout("2 seconds")),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(LlmError);
      expect(result.failure.message).toContain("渲染炸了");
    }
  });

  it("工具调用没有次数上限:连跑 20 步仍会继续,直到只回正文", async () => {
    const rounds = Array.from({ length: 20 }, (_, index): ReadonlyArray<Item> => [
      { type: "REASONING", text: `第 ${index + 1} 步` },
      {
        type: "FUNCTION_CALL",
        callId: `call_${index + 1}`,
        name: "bash",
        arguments: '{"command":"ls"}',
      },
    ]);

    const { answer, seen } = await Effect.runPromise(
      collect([...rounds, [textItem("assistant", "完成")]], "一直查"),
    );

    expect(answer).toBe("完成");
    expect(seen).toHaveLength(21);
  });

  it("空答复不写进历史,且历史里不带思维链", async () => {
    const { layer, seen } = scriptedLlm([[], [textItem("assistant", "ok")]]);

    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        const first = yield* ask(session, "第一轮");
        const second = yield* ask(session, "第二轮");
        return { first, second };
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(first).toBe("");
    expect(second).toBe("ok");

    const history = seen[1] ?? [];
    expect(history.map((item) => item.type)).toEqual([
      "SYSTEM_MESSAGE",
      "USER_MESSAGE",
      "USER_MESSAGE",
    ]);
    expect(history.some((item) => item.type === "REASONING")).toBe(false);
  });

  it("system prompt 只有一条:安全约束不带工具名,工具定义走 tools 字段", async () => {
    const { layer, seen, seenTools } = scriptedLlm([[textItem("assistant", "好了")]]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        return yield* ask(session, "干活");
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    const system = (seen[0] ?? []).flatMap((item) =>
      item.type === "SYSTEM_MESSAGE" ? [item.text] : [],
    );
    expect(system).toEqual([SYSTEM_MESSAGE]);
    expect(system[0]).not.toContain("bash");
    expect(seenTools[0]?.map((tool) => tool.name)).toEqual(["bash"]);
  });

  it("最终回答逐条进历史:多段正文不合并成一条", async () => {
    const { layer, seen } = scriptedLlm([
      [
        { type: "ASSISTANT_MESSAGE", text: "前半" },
        { type: "ASSISTANT_MESSAGE", text: "后半" },
      ],
      [textItem("assistant", "好的")],
    ]);

    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        yield* ask(session, "第一问");
        return yield* ask(session, "第二问");
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(answer).toBe("好的");
    const history = (seen[1] ?? []).flatMap((item) =>
      item.type === "ASSISTANT_MESSAGE" ? [item.text] : [],
    );
    expect(history).toEqual(["前半", "后半"]);
  });

  it("system 是引擎级状态:开头 SET 一次,step 里不再重复", async () => {
    const { events } = await Effect.runPromise(collect([[textItem("assistant", "好了")]], "干活"));

    const sets = events.filter((event) => event._tag === "SYSTEM_MESSAGE_SET");
    expect(sets).toHaveLength(1);
    // 引擎没有身份:SET 是顶层事件,不带 parentId
    expect(sets[0]).toMatchObject({ text: SYSTEM_MESSAGE });
    expect(sets[0]).not.toHaveProperty("parentId");
  });

  it("等工具结果时到达的新 prompt 与结果合并:结果紧跟 function_call,prompt 排在后", async () => {
    const { layer, seen } = scriptedLlm([toolTurn, [textItem("assistant", "完成")]]);

    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const tools: ReadonlyArray<Tool> = [
          {
            definition: { name: "bash", description: "gated", parameters: { type: "object" } },
            execute: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("done"),
              ),
          },
        ];

        const session = yield* start(testSettings, tools);

        const firstFiber = yield* ask(session, "第一个问题").pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const secondFiber = yield* ask(session, "第二个问题").pipe(Effect.forkChild);
        // 让第二个 ask 先把 prompt 放进 inbox(单线程调度;几次 yield 足够)
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);

        return {
          first: yield* Fiber.join(firstFiber),
          second: yield* Fiber.join(secondFiber),
        };
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(first).toBe("完成");
    expect(second).toBe("完成");

    const secondCall = seen[1] ?? [];
    expect(secondCall.map((item) => item.type)).toEqual([
      "SYSTEM_MESSAGE",
      "USER_MESSAGE",
      "REASONING",
      "FUNCTION_CALL",
      "FUNCTION_CALL_OUTPUT",
      "USER_MESSAGE",
    ]);
    expect(secondCall[4]).toMatchObject({ type: "FUNCTION_CALL_OUTPUT", callId: "call_1" });
    expect(secondCall[5]).toMatchObject({ type: "USER_MESSAGE", text: "第二个问题" });
  });

  it("模型报错不杀死常驻循环:下一条 prompt 照常回答", async () => {
    const seen: Array<ReadonlyArray<Item>> = [];
    const layer = Layer.effect(
      Llm,
      Effect.gen(function* () {
        const step = yield* Ref.make(0);
        return Llm.of({
          complete: (items) =>
            Effect.gen(function* () {
              seen.push(items);
              const index = yield* Ref.get(step);
              yield* Ref.update(step, (n) => n + 1);
              if (index === 0) {
                return yield* new LlmError({ message: "boom", cause: new Error("root-cause") });
              }
              return [textItem("assistant", "ok")];
            }),
        });
      }),
    );

    const events: Array<ArchiveEntry> = [];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        const first = yield* ask(session, "一").pipe(Effect.result);
        const second = yield* ask(session, "二");
        return { first, second };
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(result.first._tag).toBe("Failure");
    expect(result.second).toBe("ok");
    expect(seen[1]?.map((item) => item.type)).toEqual([
      "SYSTEM_MESSAGE",
      "USER_MESSAGE",
      "USER_MESSAGE",
    ]);

    // 模型调用失败:error 是内容,随后仍然 step.end / turn.end
    const stepError = events.find((event) => event._tag === "STEP_ERROR");
    expect(stepError).toMatchObject({ message: "boom", cause: "root-cause" });
    expect(stepError).not.toHaveProperty("kind");
    const failedStep = events.find(
      (event) => event._tag === "STEP_START" && event.id === stepError?.parentId,
    );
    expect(failedStep).toBeDefined();
    expect(
      events.some((event) => event._tag === "STEP_END" && event.id === stepError?.parentId),
    ).toBe(true);

    const turnError = events.find((event) => event._tag === "TURN_ERROR");
    expect(turnError).toMatchObject({ message: "boom", cause: "root-cause" });
    expect(
      events.some((event) => event._tag === "TURN_END" && event.id === turnError?.parentId),
    ).toBe(true);
  });

  it("没 configure 就开跑:引擎在开轮之前就以缺陷收尾(engine.error)", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "不该被调用")]]);
    const events: Array<ArchiveEntry> = [];

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // 不 configure,直接跑
        const session = yield* (yield* Loop).run({ archive: makeTurnHook() });
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        const outcome = yield* ask(session, "一").pipe(Effect.result);
        yield* Effect.yieldNow;
        return outcome;
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(result._tag).toBe("Failure");
    // 配置在开轮之前读:连轮都没开,所以没有 turn/step 级错误
    expect(events.some((event) => event._tag === "TURN_START")).toBe(false);
    expect(events.some((event) => event._tag === "TURN_ERROR")).toBe(false);
    expect(events.some((event) => event._tag === "STEP_ERROR")).toBe(false);
    const engineError = events.find((event) => event._tag === "ENGINE_ERROR");
    expect(engineError).toMatchObject({ message: expect.stringContaining("未配置") });
    expect(events.some((event) => event._tag === "ENGINE_END")).toBe(true);
  });

  it("引擎缺陷:逐层发 error,随后逐层 end", async () => {
    const events: Array<ArchiveEntry> = [];
    const layer = Layer.effect(
      Llm,
      Effect.sync(() => Llm.of({ complete: () => Effect.die(new Error("fatal")) })),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        const outcome = yield* ask(session, "一").pipe(Effect.result);
        yield* Effect.yieldNow;
        return outcome;
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(result._tag).toBe("Failure");

    const engineError = events.find((event) => event._tag === "ENGINE_ERROR");
    expect(engineError).toMatchObject({
      message: expect.stringContaining("fatal"),
      cause: expect.stringContaining("fatal"),
    });
    expect(engineError).not.toHaveProperty("kind");

    const stepError = events.find((event) => event._tag === "STEP_ERROR");
    expect(stepError).toBeDefined();
    expect(
      events.some((event) => event._tag === "STEP_END" && event.id === stepError?.parentId),
    ).toBe(true);

    const turnError = events.find((event) => event._tag === "TURN_ERROR");
    expect(turnError).toBeDefined();
    expect(
      events.some((event) => event._tag === "TURN_END" && event.id === turnError?.parentId),
    ).toBe(true);

    expect(events.some((event) => event._tag === "ENGINE_END")).toBe(true);
  });

  it("inbox.offer 自带 prompt 原文;step 里用 inboxId 引用它", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "好")]]);
    const seen: Array<ArchiveEntry> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* ask(session, "你好");
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    const offer = seen.find(
      (event) => event._tag === "INBOX_OFFER" && event.message._tag === "USER_MESSAGE",
    );
    expect(offer).toMatchObject({
      _tag: "INBOX_OFFER",
      message: { _tag: "USER_MESSAGE", payload: { text: "你好" } },
    });

    const promptId =
      offer?._tag === "INBOX_OFFER" && offer.message._tag === "USER_MESSAGE"
        ? offer.message.id
        : undefined;
    const startEvent = seen.find((event) => event._tag === "TURN_START");
    expect(startEvent).toMatchObject({ _tag: "TURN_START" });
    expect(startEvent).not.toHaveProperty("inboxId");

    const promptEvent = seen.find((event) => event._tag === "USER_MESSAGE");
    expect(promptEvent).toMatchObject({ _tag: "USER_MESSAGE", inboxId: promptId });

    const step = seen.find(
      (event) => event._tag === "STEP_START" && event.id === promptEvent?.parentId,
    );
    expect(step).toMatchObject({ _tag: "STEP_START", parentId: startEvent?.id });
  });

  it("inbox 状态 = inbox.offer − inbox.take:take 只引用 offer 过的", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "好")]]);
    const events: Array<ArchiveEntry> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* ask(session, "待处理");
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    const offered = events
      .filter((event) => event._tag === "INBOX_OFFER")
      .map((event) => event.message.id);
    const taken = events
      .filter((event) => event._tag === "INBOX_TAKE")
      .flatMap((event) => event.messageIds);

    expect(offered).toHaveLength(1);
    // 每一条 take 都必须先 offer 过,且跑完一轮后没有残留
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.every((id) => offered.includes(id))).toBe(true);
    expect(offered.filter((id) => !taken.includes(id))).toEqual([]);
  });

  it("turn 跑完后 inbox 为空:所有 offer 都被 take 掉", async () => {
    const { layer } = scriptedLlm([toolTurn, [textItem("assistant", "完成")]]);
    const events: Array<ArchiveEntry> = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* ask(session, "看看目录");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    const promptId = events.flatMap((event) =>
      event._tag === "INBOX_OFFER" && event.message._tag === "USER_MESSAGE"
        ? [event.message.id]
        : [],
    )[0];
    const offered = events
      .filter((event) => event._tag === "INBOX_OFFER")
      .map((event) => event.message.id);
    const taken = events
      .filter((event) => event._tag === "INBOX_TAKE")
      .flatMap((event) => event.messageIds);

    expect(offered).toHaveLength(2);
    expect(offered[0]).toBe(promptId);
    expect(offered.filter((id) => !taken.includes(id))).toEqual([]);
  });

  it("Engine 只发 step:不挂 archive hook 时没有 TURN_*", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "好")]]);

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* (yield* Loop).run(); // 不挂 turn hook
        const collected: Array<ArchiveEntry> = [];
        const stepEnd = yield* Deferred.make<void>();

        yield* session.events.pipe(
          Stream.takeUntil((event) => event._tag === "STEP_END"),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              collected.push(event);
              if (event._tag === "STEP_END") yield* Deferred.succeed(stepEnd, undefined);
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* session.configure({ settings: testSettings, tools: Option.some(stubTools) });
        yield* session.send({ id: crypto.randomUUID(), text: "你好" });
        yield* Deferred.await(stepEnd);
        yield* Fiber.interrupt(session.fiber);
        return collected;
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(events.map((event) => event._tag)).toContain("STEP_START");
    expect(events.some((event) => event._tag.startsWith("TURN_"))).toBe(false);
    // turn / step 的上下级由 hook 织入;引擎发出来的 step 本身没有 turn parent
    expect(events.find((event) => event._tag === "STEP_START")).not.toHaveProperty("parentId");
  });

  it("顶层 runTurn 每轮起停一个 run,transcript 跨 run 保留", async () => {
    const { layer, seen } = scriptedLlm([
      [textItem("assistant", "第一答")],
      [textItem("assistant", "第二答")],
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const turn = yield* Turn;
        const config = { settings: testSettings, tools: Option.some(stubTools) };

        /** 跑一轮并收集这一轮的事件。 */
        const runOne = (text: string) =>
          Effect.gen(function* () {
            const events: Array<ArchiveEntry> = [];
            const answer = yield* turn.runTurn(
              config,
              { text },
              { onEvent: (event) => Effect.sync(() => void events.push(event)) },
            );
            return { answer, events };
          });

        return { first: yield* runOne("第一问"), second: yield* runOne("第二问") };
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(result.first.answer).toBe("第一答");
    expect(result.second.answer).toBe("第二答");

    // 每一轮都有自己的 run 边界(开始事件会转发;结束在句柄收尾时发,已经不再转发)
    for (const { events } of [result.first, result.second]) {
      const tags = events.map((event) => event._tag);
      expect(tags).toContain("ENGINE_START");
      expect(tags).toContain("TURN_END");

      // hook 织入:turn 包住 step,step 的 parentId 指向同一个 turn
      expect(tags.indexOf("TURN_START")).toBeLessThan(tags.indexOf("STEP_START"));
      expect(tags.indexOf("STEP_END")).toBeLessThan(tags.indexOf("TURN_END"));
      const turnStart = events.find((event) => event._tag === "TURN_START");
      const stepStart = events.find((event) => event._tag === "STEP_START");
      expect(stepStart?.parentId).toBe(turnStart?.id);
    }

    // 第二轮发给模型的历史里带着第一轮的问答
    expect((seen[1] ?? []).map((item) => item.type)).toEqual([
      "SYSTEM_MESSAGE",
      "USER_MESSAGE",
      "ASSISTANT_MESSAGE",
      "USER_MESSAGE",
    ]);
    expect(seen[1]?.[1]).toMatchObject({ text: "第一问" });
    expect(seen[1]?.[3]).toMatchObject({ text: "第二问" });
  });

  it("引擎停止后,还在等的 ask 立即失败而不是挂死", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "不该被调用")]]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        // 让引擎真的开始跑,否则中断一个还没启动的纤维不会触发它的退出清理
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(session.fiber);
        return yield* ask(session, "你好").pipe(Effect.result);
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(LlmError);
  });

  it("archive 失败时发 ARCHIVE_ERROR,对话照常跑完", async () => {
    const { layer } = scriptedLlm([[textItem("assistant", "完成")]]);
    const failingArchive = ArchiveRuntime.pipe(
      Layer.provide(ProjectionLive),
      Layer.provide(
        Layer.succeed(Sink, {
          write: () => Effect.fail(new ArchiveError({ message: "disk full" })),
          read: Effect.succeed([]),
        }),
      ),
    );

    const { answer, reported, replay } = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* start();
        const wait = yield* session.events.pipe(
          Stream.filter((event) => event._tag === "ARCHIVE_ERROR"),
          Stream.runHead,
          Effect.timeout("2 seconds"),
          Effect.forkChild({ startImmediately: true }),
        );

        const answer = yield* ask(session, "干活");
        const reported = yield* Fiber.join(wait);

        // 晚订阅者也能看到这条(不需要重跑对话)
        const replay = yield* session.events.pipe(Stream.runHead);
        return { answer, reported, replay };
      }).pipe(
        Effect.provide(
          LoopRuntime.pipe(
            Layer.provide(EngineLive),
            Layer.provide(ToolExecutorLive),
            Layer.provide(InboxLive),
            Layer.provide(EventsLive),
            Layer.provide(BuiltinToolsLive.pipe(Layer.provide(NodeServices.layer))),
            Layer.provide(failingArchive),
            Layer.provide(layer),
          ),
        ),
      ),
    );

    // archive 坏了不影响对话
    expect(answer).toBe("完成");
    expect(Option.isSome(reported) ? reported.value._tag : undefined).toBe("ARCHIVE_ERROR");
    expect(
      Option.isSome(reported) && reported.value._tag === "ARCHIVE_ERROR"
        ? reported.value.message
        : undefined,
    ).toBe("disk full");
    // 晚订阅:先补历史错误
    expect(Option.isSome(replay) ? replay.value._tag : undefined).toBe("ARCHIVE_ERROR");
  });
});
