// ═══════════════════════════════════════════════════════════════════════════
// Turn:一次完整的 runTurn
//
//   Loop.run({ archive: turnHook }) ──► configure ──► 订阅 / send / 等 TURN_END ──► 中断 run
//        └─ turnHook 在 step 事件前后织入 TURN_START / TURN_END / TURN_ERROR 与 parentId
//        └─ parseTurn 解析这一轮:对齐 turn、收回答、归错误
//
// 解析与 turn 事件都只在这里一份;引擎只跑 step 循环。
// ═══════════════════════════════════════════════════════════════════════════

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref, Stream } from "effect";
import {
  newArchiveEntryId,
  type ArchiveEntry,
  type ArchiveEntryId,
  type SessionId,
} from "../archive/service.ts";
import { LlmError } from "../llm/_domain.ts";
import type { EventHook } from "../loop/events/service.ts";
import { Loop, type LoopConfig, type LoopRun } from "../loop/service.ts";
import { Turn, type TurnInput, type TurnOptions } from "./service.ts";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** 给条目挂上 turn 的 `parentId`。 */
const withParent = (entry: ArchiveEntry, parentId: ArchiveEntryId): ArchiveEntry =>
  ({ ...entry, parentId }) as ArchiveEntry;

/** 造一条 turn 级事件(id 由调用方给;TURN_START / TURN_END 共用 turnId)。 */
const turnEvent = (
  tag: "TURN_START" | "TURN_END",
  id: ArchiveEntryId,
  sessionId?: SessionId,
): ArchiveEntry => ({
  v: 1,
  at: Date.now(),
  _tag: tag,
  id,
  ...(sessionId === undefined ? {} : { sessionId }),
});

/** 造一条 `TURN_ERROR`。 */
const turnError = (
  parentId: ArchiveEntryId,
  failure: { readonly message: string; readonly cause?: string },
  sessionId?: SessionId,
): ArchiveEntry => ({
  v: 1,
  at: Date.now(),
  _tag: "TURN_ERROR",
  id: newArchiveEntryId(),
  parentId,
  message: failure.message,
  ...(failure.cause === undefined ? {} : { cause: failure.cause }),
  ...(sessionId === undefined ? {} : { sessionId }),
});

/**
 * 把 turn 的逻辑织进 step 事件流:
 *
 * - `STEP_START` 前没有轮就插 `TURN_START`,并给 step 挂上 `parentId`;
 * - `STEP_END` 时有工具调用就留在同一轮,否则(或这一步错了)补 `TURN_ERROR` / `TURN_END`;
 * - 引擎收尾时如果还有开着的轮,`ENGINE_ERROR` / `ENGINE_END` 前补齐 turn 的终点。
 *
 * 状态是 hook 闭包里的普通变量:同一个 run 里 step 事件由引擎单纤维顺序发,
 * 别的纤维只会发 `INBOX_OFFER` 这类不属于 step 的事件。
 */
export const makeTurnHook = (): EventHook => {
  let turnId: ArchiveEntryId | undefined;
  let stepCalls = 0;
  let stepFailure: { message: string; cause?: string } | undefined;

  return (entry) => {
    switch (entry._tag) {
      case "STEP_START": {
        stepCalls = 0;
        stepFailure = undefined;
        if (turnId === undefined) {
          turnId = newArchiveEntryId();
          return Effect.succeed([
            turnEvent("TURN_START", turnId, entry.sessionId),
            withParent(entry, turnId),
          ]);
        }
        return Effect.succeed([withParent(entry, turnId)]);
      }

      case "FUNCTION_CALL":
        stepCalls += 1;
        return Effect.succeed([entry]);

      case "STEP_ERROR":
        stepFailure =
          entry.cause === undefined
            ? { message: entry.message }
            : { message: entry.message, cause: entry.cause };
        return Effect.succeed([entry]);

      case "STEP_END": {
        const current = turnId;
        const written: Array<ArchiveEntry> =
          current === undefined ? [entry] : [withParent(entry, current)];

        // 有工具调用的 step 只是这一轮的中间步;否则(含出错)这一轮到此结束
        if (current !== undefined && (stepFailure !== undefined || stepCalls === 0)) {
          if (stepFailure !== undefined)
            written.push(turnError(current, stepFailure, entry.sessionId));
          written.push(turnEvent("TURN_END", current, entry.sessionId));
          turnId = undefined;
        }
        stepCalls = 0;
        stepFailure = undefined;
        return Effect.succeed(written);
      }

      case "ENGINE_ERROR": {
        if (turnId === undefined) return Effect.succeed([entry]);
        const current = turnId;
        turnId = undefined;
        return Effect.succeed([
          turnError(
            current,
            {
              message: entry.message,
              ...(entry.cause === undefined ? {} : { cause: entry.cause }),
            },
            entry.sessionId,
          ),
          turnEvent("TURN_END", current, entry.sessionId),
          entry,
        ]);
      }

      case "ENGINE_END": {
        if (turnId === undefined) return Effect.succeed([entry]);
        const current = turnId;
        turnId = undefined;
        return Effect.succeed([turnEvent("TURN_END", current, entry.sessionId), entry]);
      }

      default:
        return Effect.succeed([entry]);
    }
  };
};

/**
 * 在 `session` 上跑一轮:发一条 prompt,等它所属的 `TURN_END`,返回最后一步的正文。
 *
 * 解析都在这里:prompt id 自己生成,靠 `INBOX_TAKE` / `USER_MESSAGE` 认出自己落在哪一轮,
 * 每开一个 step 清空回答(工具步的"宣告"不算答案),错误按 `STEP_ERROR` / `TURN_ERROR` /
 * `ENGINE_ERROR` 归属到这一轮。`onEvent` 只是旁路转发,不参与解析。
 */
const parseTurn = (
  session: LoopRun,
  input: TurnInput,
  options?: TurnOptions,
): Effect.Effect<string, LlmError> =>
  Effect.gen(function* () {
    const id = crypto.randomUUID();
    const answer = yield* Ref.make("");
    const failure = yield* Ref.make<string | undefined>(undefined);
    const done = yield* Deferred.make<void>();
    /** 自己的 prompt 落在哪一轮:`INBOX_TAKE` 先看到它,`USER_MESSAGE` 再校准。 */
    let turnId: string | undefined;
    let currentTurnId: string | undefined;
    let pendingPrompt = false;
    const stepParents = new Map<string, string>();

    // 先订阅、再 send:否则可能错过这一轮的 TURN_END
    yield* session.events.pipe(
      Stream.takeUntil(
        (event) =>
          event._tag === "ENGINE_END" ||
          (turnId !== undefined && event._tag === "TURN_END" && event.id === turnId),
      ),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (options?.onEvent !== undefined) yield* options.onEvent(event);

          // ── 自己的 prompt 落在哪一轮 ──────────────────────────────
          // 被取走时已经有开着的轮:并进去;否则等 TURN_START 认领
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

          // ── 错误归属 ────────────────────────────────────────────
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

          // ── 回答 = 最后一步的正文(工具步的宣告会被下一个 step 清掉)──
          if (event._tag === "STEP_START") yield* Ref.set(answer, "");
          if (event._tag === "ASSISTANT_MESSAGE") {
            yield* Ref.update(answer, (text) => text + event.text);
          }

          // ── 终点 ────────────────────────────────────────────────
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
      // 订阅纤维异常退出(比如 onEvent 抛了):别让 Deferred 永远等下去,
      // 把原因记成这一轮的错误;中断(调用方取消)不在此列。
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? Ref.update(failure, (current) => current ?? Cause.pretty(exit.cause)).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
            )
          : Effect.void,
      ),
      Effect.forkChild({ startImmediately: true }),
    );

    yield* session.send({ id, text: input.text });
    yield* Deferred.await(done);

    const error = yield* Ref.get(failure);
    if (error !== undefined) return yield* Effect.fail(new LlmError({ message: error }));

    return yield* Ref.get(answer);
  });

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** 构建好的 `Turn`:依赖 `Loop`(由 `AgentLive` 装配)。 */
export const TurnLive: Layer.Layer<Turn, never, Loop> = Layer.effect(
  Turn,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const loop = yield* Loop;

    // -----------------------------------------------------------------------
    // 对外方法
    // -----------------------------------------------------------------------
    /**
     * 自己开一个 run,配好参数,跑完一轮就中断它。
     * `ensuring` 保证失败 / 被取消时也关;下一轮会起新的 run,transcript 由投影跨 run 保留。
     */
    const runTurn = (
      config: LoopConfig,
      input: TurnInput,
      options?: TurnOptions,
    ): Effect.Effect<string, LlmError> =>
      Effect.gen(function* () {
        // 1. 自己开一个 run,并把 turn 的逻辑挂到 archive hook 上
        const session = yield* loop.run({ archive: makeTurnHook() });

        // 2. 配好 → 订阅事件 / 发 prompt / 解析这一轮;3. 无论成败都关掉这个 run
        return yield* Effect.gen(function* () {
          yield* session.configure(config);
          return yield* parseTurn(session, input, options);
        }).pipe(Effect.ensuring(Fiber.interrupt(session.fiber)));
      });

    return Turn.of({ runTurn });
  }),
);
