import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { Inbox } from "./service.ts";
import { InboxLive } from "./live.ts";
import { Events } from "../events/service.ts";
import type { EventPublisher } from "../events/service.ts";
import type { InboxMessage } from "./service.ts";

const prompt = (id: string, text = "问一句"): InboxMessage => ({
  _tag: "USER_MESSAGE",
  id,
  payload: { text },
});

const toolResult = (id: string, callId: string, output = "ok"): InboxMessage => ({
  _tag: "FUNCTION_CALL_OUTPUT",
  id,
  payload: { callId, name: "bash", output },
});

/** 只记录、不落盘的事件总线:让测试能看见 inbox 自己发了什么。 */
const recordingEvents = () => {
  const published: Array<Parameters<EventPublisher>[0]> = [];
  const layer = Layer.effect(
    Events,
    Effect.succeed(
      Events.of({
        publish: (event) => Effect.sync(() => void published.push(event)),
        begin: Effect.void,
        setHook: () => Effect.void,
        stream: Stream.empty,
      }),
    ),
  );
  return { layer, published };
};

/** 在 `InboxLive` + 记录式总线的层里跑一段,返回结果与这次发出去的事件。 */
const runWithEvents = <A, E>(effect: Effect.Effect<A, E, Inbox>) => {
  const events = recordingEvents();
  return Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({ value, published: events.published })),
      Effect.provide(InboxLive),
      Effect.provide(events.layer),
    ),
  );
};

/** 只看 inbox 语义时,不关心发了什么事件。 */
const run = async <A, E>(effect: Effect.Effect<A, E, Inbox>): Promise<A> =>
  (await runWithEvents(effect)).value;

const ids = (messages: ReadonlyArray<InboxMessage>): ReadonlyArray<string> =>
  messages.map((message) => message.id);

describe("inbox:攒到就位", () => {
  it("没有 pending 时:等到第一条 prompt 就位,工具结果不算", async () => {
    const { value, published } = await runWithEvents(
      Effect.gen(function* () {
        const inbox = yield* Inbox;
        const waiting = yield* inbox.takeReadyBatch([]).pipe(Effect.forkChild);
        // 上次引擎被中断时留下的迟到结果:等不到配套调用,不是就位条件
        yield* inbox.offer(toolResult("r1", "call_1"));
        yield* inbox.offer(prompt("p1"));
        return yield* Fiber.join(waiting);
      }),
    );

    expect(ids(value.userMessages)).toEqual(["p1"]);
    expect(value.functionCallOutputs).toEqual([]);

    // 两条 inbox 事件都是 inbox 自己发的:入队发 offer,出队发 take(只带引用)
    const offered = published.flatMap((event) =>
      event._tag === "INBOX_OFFER" ? [event.message.id] : [],
    );
    const taken = published.flatMap((event) =>
      event._tag === "INBOX_TAKE" ? event.messageIds : [],
    );
    expect(offered).toEqual(["r1", "p1"]);
    expect(taken).toEqual(["r1", "p1"]);
  });

  it("有 pending 时:结果全到齐才就位,交出时已按调用顺序排好、prompt 单独一类", async () => {
    const batch = await run(
      Effect.gen(function* () {
        const inbox = yield* Inbox;
        const waiting = yield* inbox.takeReadyBatch(["call_1", "call_2"]).pipe(Effect.forkChild);
        // 故意让 call_2 的结果先回来:交出时仍按 awaiting 顺序
        yield* inbox.offer(toolResult("r2", "call_2"));
        yield* inbox.offer(prompt("p1"));
        yield* inbox.offer(toolResult("r1", "call_1"));
        return yield* Fiber.join(waiting);
      }),
    );

    expect(ids(batch.functionCallOutputs)).toEqual(["r1", "r2"]);
    expect(ids(batch.userMessages)).toEqual(["p1"]);
  });

  it("交出去之后队列为空:下一次 takeReadyBatch 重新等", async () => {
    const result = await run(
      Effect.gen(function* () {
        const inbox = yield* Inbox;
        yield* inbox.offer(prompt("p1"));
        const first = yield* inbox.takeReadyBatch([]);

        // 已经交出去了:pending 里没有残留,新一批只认新消息
        yield* inbox.offer(toolResult("r1", "call_1"));
        yield* inbox.offer(prompt("p2"));
        const second = yield* inbox.takeReadyBatch([]);
        return { first, second };
      }),
    );

    expect(ids(result.first.userMessages)).toEqual(["p1"]);
    expect(ids(result.second.userMessages)).toEqual(["p2"]);
  });
});
