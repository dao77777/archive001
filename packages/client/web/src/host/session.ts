// **会话**:一个宿主进程 = 一个会话。
//
// `AgentLive` 在建层时 `Ref.make(history)`,历史没有"清空"的接口 —— 所以 reset 的做法是
// **换一套实例**:把 `Agent` + 工具层建在独立的子 `Scope` 上,reset 时开一套新的、
// 关掉旧的一套(旧 scope 关闭 → 在飞的那一轮被中断,与"清空历史"的语义一致)。
//
// 一次 `turn` = 一个事件流:agent 的观察者把事件塞进 Queue,answer / error 各补一行,
// 队列 shutdown 即流结束。浏览器断开 → 流的 scope 关闭 → fork 被中断(不白烧 token)。

import { Agent, AgentLive, formatError, LlmLive, type LlmSettings } from "@archive001/agent";
import { BuiltinTools, BuiltinToolsLive } from "@archive001/agent/builtin-tools";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Queue, Ref, Scope, Stream } from "effect";
import type { SessionShape, TurnEvent } from "./_domain.ts";

export class Session extends Context.Service<Session, SessionShape>()("archive001/web/Session") {}

/** `Agent`(要 `Llm`)与内置工具(要 Node 能力)合成一套实例。 */
const Instances = Layer.mergeAll(
  Layer.provide(LlmLive)(AgentLive),
  Layer.provide(NodeServices.layer)(BuiltinToolsLive),
);

export const SessionLive: Layer.Layer<Session> = Layer.effect(Session)(
  Effect.gen(function* () {
    /** 开一套新实例,并把它绑在自己的 scope 上(关 scope = 释放这套实例)。 */
    const open = Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(Instances, scope);
      return { scope, context };
    });

    const current = yield* Ref.make(yield* open);

    // 宿主关停:把当前这套实例一起放掉
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(current), (instances) => Scope.close(instances.scope, Exit.void)),
    );

    /**
     * 一次 turn = 一个事件流。`Stream.callback` 在**流的 scope 里**跑这段 effect,
     * 所以:agent 的观察者往里塞事件 → 消费者边收边发;浏览器断开 → scope 关 → 这一轮被中断。
     */
    const turn = (input: string, settings: LlmSettings): Stream.Stream<TurnEvent> =>
      Stream.callback((queue) =>
        Effect.gen(function* () {
          const { context } = yield* Ref.get(current);
          const agent = Context.get(context, Agent);
          const tools = Context.get(context, BuiltinTools);

          const last = yield* agent
            .run(input, settings, tools, (event) => Queue.offer(queue, event).pipe(Effect.asVoid))
            .pipe(
              Effect.match({
                onFailure: (error): TurnEvent => ({ _tag: "error", text: formatError(error) }),
                onSuccess: (text): TurnEvent => ({ _tag: "answer", text }),
              }),
            );

          yield* Queue.offer(queue, last);
          // 收尾:让流正常结束(scope 关闭时另外还会 shutdown 一次)
          return yield* Queue.end(queue);
        }),
      );

    const reset = Effect.gen(function* () {
      const previous = yield* Ref.get(current);
      const next = yield* open;
      yield* Ref.set(current, next);
      yield* Scope.close(previous.scope, Exit.void);
    });

    return Session.of({ turn, reset });
  }),
);

/** 给测试用的空实现:不碰模型,只回一行 answer。 */
export const SessionFake: Layer.Layer<Session> = Layer.succeed(Session, {
  turn: (input: string) =>
    Stream.make({ _tag: "text", text: input }, { _tag: "answer", text: "ok" }),
  reset: Effect.void,
});
