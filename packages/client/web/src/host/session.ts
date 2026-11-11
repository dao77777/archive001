// **会话**:一个宿主进程管理一套层 + archive 里的多段会话。
//
// 每一轮由 `Turn.runTurn` 起一个 run、跑完关掉;transcript 在投影里**同一会话内跨 run**保留,
// 所以多轮仍有记忆。`sessions` 列 archive 里的会话,`open` 切过去,`reset` 换层 + 开新会话。
//
// 一次 `turn` = 一个事件流:`runTurn` 把事件交给 onEvent(塞进 Queue),answer / error 各补一行,
// 队列 shutdown 即流结束。⚠️ 浏览器断开 = 中断 `runTurn`;它的 `ensuring` 会关掉本轮 run。

import {
  Archive,
  formatError,
  makeSessionId,
  Turn,
  type ArchiveEntry,
  type LlmSettings,
  type SessionId,
} from "@archive001/agent";
import { AgentLive } from "@archive001/agent/live";
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Exit, Layer, Option, Queue, Ref, Scope, Stream } from "effect";
import type { SessionShape, SessionSummary, TurnEvent } from "./_domain.ts";

export class Session extends Context.Service<Session, SessionShape>()("archive001/web/Session") {}

/** 一套 `Agent` + `Turn`(自带 Llm / archive / 内置工具)+ 平台服务。 */
const makeInstances = () => {
  // `AgentLive` 自带 `Llm` / 文件 archive / 内置工具;平台服务留给宿主自己用
  return Layer.mergeAll(AgentLive, NodeServices.layer);
};

export const SessionLive: Layer.Layer<Session> = Layer.effect(Session)(
  Effect.gen(function* () {
    /** 开一套新实例,并把它绑在自己的 scope 上(关 scope = 释放这套实例)。 */
    const open = Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const context = yield* Layer.buildWithScope(Layer.orDie(makeInstances()), scope);
      return { scope, context };
    });

    const current = yield* Ref.make(yield* open);

    // 宿主关停:把当前这套实例一起放掉
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(Ref.get(current), (instances) => Scope.close(instances.scope, Exit.void)),
    );

    /**
     * 一次 turn = 一个事件流。`runTurn` 负责解析(对齐 turn、收答案、错误归属),
     * 这里只把事件转发给浏览器,最后补一行 ANSWER / ERROR。
     * 最后一步的正文由 ANSWER 行渲染,所以不把它的 `ASSISTANT_MESSAGE` 推给界面(避免重复)。
     */
    const turn = (input: string, settings: LlmSettings): Stream.Stream<TurnEvent> =>
      Stream.callback((queue) =>
        Effect.gen(function* () {
          const { context } = yield* Ref.get(current);
          const turnService = Context.get(context, Turn);

          const forward = (value: ArchiveEntry): Effect.Effect<void> =>
            Queue.offer(queue, value).pipe(Effect.asVoid);

          /** 表现层缓冲:工具步的"宣告"随工具调用一起放行,最终回答留给 ANSWER 行。 */
          let stepHasTool = false;
          const pendingTexts: Array<ArchiveEntry> = [];
          const flushTexts = () =>
            Effect.forEach(pendingTexts.splice(0), forward, { discard: true });

          const onEvent = (event: ArchiveEntry): Effect.Effect<void> =>
            Effect.gen(function* () {
              if (event._tag === "STEP_START") {
                stepHasTool = false;
                pendingTexts.length = 0;
                yield* forward(event);
              } else if (event._tag === "ASSISTANT_MESSAGE") {
                pendingTexts.push(event);
              } else if (event._tag === "FUNCTION_CALL") {
                stepHasTool = true;
                yield* flushTexts();
                yield* forward(event);
              } else if (event._tag === "STEP_END") {
                if (stepHasTool) yield* flushTexts();
                else pendingTexts.length = 0;
                yield* forward(event);
              } else {
                yield* forward(event);
              }
            });

          const last = yield* turnService
            .runTurn({ settings, tools: Option.none() }, { text: input }, { onEvent })
            .pipe(
              Effect.match({
                // 这一轮失败:把错误当内容发出去
                onFailure: (error): TurnEvent => ({ _tag: "ERROR", text: formatError(error) }),
                // 成功:回答是这一轮最后一步的正文
                onSuccess: (text): TurnEvent => ({ _tag: "ANSWER", text }),
              }),
            );

          yield* Queue.offer(queue, last);
          // 收尾:让流正常结束(scope 关闭时另外还会 shutdown 一次)
          return yield* Queue.end(queue);
        }),
      );

    /** 当前层的 Archive。 */
    const archiveOf = Effect.gen(function* () {
      const { context } = yield* Ref.get(current);
      return Context.get(context, Archive);
    });

    /** 打开已有会话:切过去并返回它的原始条目(不换层)。 */
    const openSession = (sessionId: SessionId): Effect.Effect<ReadonlyArray<ArchiveEntry>> =>
      Effect.gen(function* () {
        const archive = yield* archiveOf;
        yield* archive.useSession(sessionId);
        return yield* archive.readSession(sessionId);
      });

    /** 会话列表:标题取第一条用户消息,时间取最后一条条目;最近活动在前。 */
    const sessions: Effect.Effect<ReadonlyArray<SessionSummary>> = Effect.gen(function* () {
      const archive = yield* archiveOf;
      const ids = yield* archive.sessions;
      const currentId = yield* archive.currentSession;
      const all = yield* archive.readAll;

      const titleOf = (entries: ReadonlyArray<ArchiveEntry>): string => {
        const offer = entries.find(
          (entry) => entry._tag === "INBOX_OFFER" && entry.message._tag === "USER_MESSAGE",
        );
        if (offer === undefined || offer._tag !== "INBOX_OFFER") return "新会话";
        if (offer.message._tag !== "USER_MESSAGE") return "新会话";
        const firstLine = offer.message.payload.text.trim().split("\n")[0] ?? "";
        return firstLine.length === 0
          ? "新会话"
          : firstLine.length > 48
            ? `${firstLine.slice(0, 48)}…`
            : firstLine;
      };

      return ids
        .map((id): SessionSummary => {
          const entries = all.filter((entry) => entry.sessionId === id);
          return {
            id,
            title: titleOf(entries),
            at: entries[entries.length - 1]?.at ?? 0,
            entries: entries.length,
            current: id === currentId,
          };
        })
        .sort((left, right) =>
          left.current === right.current ? right.at - left.at : left.current ? -1 : 1,
        );
    });

    /** 当前会话 id。 */
    const currentSession: Effect.Effect<SessionId> = Effect.gen(function* () {
      const archive = yield* archiveOf;
      return yield* archive.currentSession;
    });

    const reset = Effect.gen(function* () {
      const previous = yield* Ref.get(current);
      const next = yield* open;
      // 新层默认会回到 archive 里最后一段会话;reset 要的是新会话
      const id = yield* Context.get(next.context, Archive).startSession;
      yield* Ref.set(current, next);
      yield* Scope.close(previous.scope, Exit.void);
      return id;
    });

    return Session.of({
      turn,
      reset,
      sessions,
      current: currentSession,
      open: openSession,
    });
  }),
);

/** 给测试用的空实现:不碰模型,只回一行 answer。 */
export const SessionFake: Layer.Layer<Session> = Layer.succeed(Session, {
  turn: () => Stream.make({ _tag: "ANSWER", text: "ok" }),
  reset: Effect.succeed(makeSessionId("fake")),
  sessions: Effect.succeed([]),
  current: Effect.succeed(makeSessionId("fake")),
  open: () => Effect.succeed([]),
});
