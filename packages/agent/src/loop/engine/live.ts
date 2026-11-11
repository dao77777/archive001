// ═══════════════════════════════════════════════════════════════════════════
// Engine:llm 的状态机 —— 一个常驻的 **step 循环**,消费 inbox,直到被中断
//
// inbox.takeReadyBatch(awaiting) ──► 开 step ──► archive.projection("transcript")
//      └─► Llm.complete ──► FUNCTION_CALL? ──是──► ToolExecutor.submit(结果从 inbox 回来)
//                                        └─否──► endStep,等下一批消息
//
// 引擎只感知 step,不知道 turn:`TURN_*` 和 step 的 `parentId` 由 `Turn` 通过
// `Loop.run({ archive })` 的 archive hook 织进来。
// transcript 不在本地:每次生成前从 archive 投影(archive 是唯一状态源)。
// ═══════════════════════════════════════════════════════════════════════════

import { Cause, Effect, Exit, Layer, Match, Option, Ref, Result, Stream } from "effect";
import { formatError } from "../../_util.ts";
import { newArchiveEntryId, type ArchiveEntryId, Archive } from "../../archive/service.ts";
import type { FunctionCall } from "../../llm/_domain.ts";
import { Llm } from "../../llm/service.ts";
import { assistantTextsOf, functionCallsOf, reasoningTextsOf } from "../../llm/_util.ts";
import type { LoopConfig } from "../service.ts";
import { Events } from "../events/service.ts";
import { Inbox, type ReadyBatch } from "../inbox/service.ts";
import { ToolExecutor } from "../tool-executor/service.ts";
import { Engine } from "./service.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/**
 * 每个 step 开头的 system 内容(名字与事件 / `Item` 的 `SYSTEM_MESSAGE` 一致)。
 * 只放**不能从请求的 `tools` 字段推出来**的东西:一条安全约束 ——
 * 工具的名字 / 描述 / 参数已经在 `tools` 里,这里不重复。
 */
export const SYSTEM_MESSAGE = `不要执行破坏性命令(删除、覆盖用户数据),除非用户明确要求。`;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** 已经 `configure` 过了(`none` = 还没配)。 */
const isConfigured = (stored: Option.Option<LoopConfig>): stored is Option.Some<LoopConfig> =>
  Option.isSome(stored);

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** `Engine` 服务形状:常驻 step 循环 + 改它状态的入口。 */
export const EngineLive: Layer.Layer<Engine, never, Llm | Inbox | ToolExecutor | Events | Archive> =
  Layer.effect(
    Engine,
    Effect.gen(function* () {
      // ---------------------------------------------------------------------
      // 依赖
      // ---------------------------------------------------------------------
      const llm = yield* Llm;
      const inbox = yield* Inbox;
      const executor = yield* ToolExecutor;
      const archive = yield* Archive;
      const events = yield* Events;

      // ---------------------------------------------------------------------
      // 状态
      // ---------------------------------------------------------------------
      /** 当前配置:`configure` 写,每次生成前读一次(`none` = 还没配)。 */
      const configRef = yield* Ref.make<Option.Option<LoopConfig>>(Option.none());

      /** 已经派给 executor、还没等到观测回来的调用:它非空就说明这一批还得等。 */
      const pendingCallsRef = yield* Ref.make<ReadonlyArray<FunctionCall>>([]);

      /** 当前 step 的 id;不在 step 里就是 `none`。 */
      const stepIdRef = yield* Ref.make<Option.Option<ArchiveEntryId>>(Option.none());

      // ---------------------------------------------------------------------
      // 方法:startStep / endStep / failStep / handleReadyBatch
      // ---------------------------------------------------------------------
      /**
       * 开一个 step,发 `STEP_START`。
       * `parentId`(所属 turn)不在这里写:由 archive hook 织进来。
       */
      const startStep = (): Effect.Effect<ArchiveEntryId> =>
        Effect.gen(function* () {
          const stepId = newArchiveEntryId();
          yield* Ref.set(stepIdRef, Option.some(stepId));
          yield* events.publish({ _tag: "STEP_START", id: stepId });
          return stepId;
        });

      /** 关当前 step:发 `STEP_END` 并清空 `stepIdRef`(没有未闭合的 step 就什么都不做)。 */
      const endStep = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const stepId = yield* Ref.get(stepIdRef);

          yield* Option.match(stepId, {
            // 没有未闭合的 step:没什么可关
            onNone: () => Effect.void,
            // 有:发 STEP_END 并清掉 step
            onSome: (stepId) =>
              events
                .publish({ _tag: "STEP_END", id: stepId })
                .pipe(Effect.andThen(Ref.set(stepIdRef, Option.none()))),
          });
        });

      /** 出错:把 error 作为内容挂到当前 step 上(`STEP_ERROR`),然后关掉它。 */
      const failStep = (message: string, cause?: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const stepId = yield* Ref.get(stepIdRef);
          const detail = cause === undefined ? {} : { cause };

          yield* Option.match(stepId, {
            // 没在 step 里:没有可挂的地方,交给上层
            onNone: () => Effect.void,
            // 在 step 里:发 STEP_ERROR,再关掉这个 step
            onSome: (stepId) =>
              events
                .publish({
                  _tag: "STEP_ERROR",
                  id: newArchiveEntryId(),
                  parentId: stepId,
                  message,
                  ...detail,
                })
                .pipe(Effect.andThen(endStep())),
          });
        });

      /**
       * 一批"就位"的消息 → 一次生成:配置 → 开 step(拼输入 → 调模型 → 收尾)。
       * 出错不往外抛(自己收尾这个 step),这样批次流不会被打断;
       * turn 级的错误 / 边界由 hook 看到 `STEP_ERROR` / `STEP_END` 后补。
       */
      const handleReadyBatch = (readyBatch: ReadyBatch): Effect.Effect<void> =>
        Effect.gen(function* () {
          const { functionCallOutputs, userMessages } = readyBatch;

          // ── 1. 配置 ──────────────────────────────────────────────────────
          // 每次生成前读一次(configure 的改动在这里生效);读不到是**装配错误**
          // (该在 `run` 之前 configure),抛缺陷,引擎以 `ENGINE_ERROR` 收尾
          const config = yield* Match.value(yield* Ref.get(configRef)).pipe(
            // 配过了:交给这一步
            Match.when(isConfigured, (configured) => Effect.succeed(configured.value)),
            // 还没 configure:装配错误,以缺陷形式暴露
            Match.orElse(() =>
              Effect.die(new Error("agent 未配置 settings / tools:先调用 configure")),
            ),
          );

          // ── 2. 一次模型输出 = 一个 step ──────────────────────────────────
          const stepId = yield* startStep();

          // ── 2.1 step 的输入事件:工具观测在前、新 prompt 在后 ────────────────
          // 与 transcript / 请求报文同一个次序;system 不在这里记 —— 它是引擎级状态
          // (`SYSTEM_MESSAGE_SET`);错误最后发(如果有)
          yield* Effect.forEach(
            functionCallOutputs,
            (observation) =>
              events.publish({
                _tag: "FUNCTION_CALL_OUTPUT",
                id: newArchiveEntryId(),
                parentId: stepId,
                inboxId: observation.id,
              }),
            { discard: true },
          );
          yield* Effect.forEach(
            userMessages,
            (message) =>
              events.publish({
                _tag: "USER_MESSAGE",
                id: newArchiveEntryId(),
                parentId: stepId,
                inboxId: message.id,
              }),
            { discard: true },
          );

          // ── 2.2 调模型:投影出 transcript → 拼 items → 调用 ────────────────
          // 2.1 已经把这批输入记进了 archive,投影出的历史里就有它们
          // (观测在前、prompt 在后,与回放契约一致)
          // 失败不在管道里吞,交给下面统一收尾
          const completeRes = yield* Effect.result(
            llm.complete(
              // transcript 不在本地:每次生成前从 archive 投影一遍(archive 是唯一状态源);
              // system 是引擎级状态,拼在历史前面
              [
                { type: "SYSTEM_MESSAGE", text: SYSTEM_MESSAGE },
                ...(yield* archive.projection("transcript")),
              ],
              // agent 装配时已经把内置工具并进 `tools`
              Option.getOrElse(config.tools, () => []).map((tool) => tool.definition),
              config.settings,
            ),
          );

          if (Result.isFailure(completeRes)) {
            // 模型调用失败:step.error + step.end,这一批结束;turn 级错误由 hook 补
            yield* failStep(
              completeRes.failure.message,
              completeRes.failure.cause === undefined
                ? undefined
                : formatError(completeRes.failure.cause),
            );
            return;
          }

          const produced = completeRes.success;
          const calls = functionCallsOf(produced);
          const texts = assistantTextsOf(produced);
          const reasoningTexts = reasoningTextsOf(produced);

          // ── 2.3 step 的输出事件:思考 → 正文 → 调用(与文档顺序一致)───────
          yield* Effect.forEach(
            reasoningTexts,
            (text) =>
              events.publish({
                _tag: "REASONING",
                id: newArchiveEntryId(),
                parentId: stepId,
                text,
              }),
            { discard: true },
          );

          // 正文属于这一步:有工具调用时是"我先查一下"这类宣告,
          // 没有工具调用时就是最终回答(外部看 step 内容自己判断)
          yield* Effect.forEach(
            texts,
            (text) =>
              events.publish({
                _tag: "ASSISTANT_MESSAGE",
                id: newArchiveEntryId(),
                parentId: stepId,
                text,
              }),
            { discard: true },
          );

          yield* Effect.forEach(
            calls,
            (call) =>
              events.publish({
                _tag: "FUNCTION_CALL",
                id: newArchiveEntryId(),
                parentId: stepId,
                callId: call.callId,
                name: call.name,
                arguments: call.arguments,
              }),
            { discard: true },
          );

          // ── 2.4 收尾 step:有调用就派给执行器,没有就等下一批消息 ──────────────
          yield* endStep();
          if (calls.length > 0) {
            yield* Ref.set(pendingCallsRef, calls);
            yield* executor.submit({
              calls,
              tools: Option.getOrElse(config.tools, () => []),
            });
          }
        });

      // ---------------------------------------------------------------------
      // 对外方法:run / configure
      // ---------------------------------------------------------------------
      const run: Effect.Effect<never> = Effect.gen(function* () {
        // 同一个 `run` 被重复执行时,从干净的状态开始
        yield* Ref.set(stepIdRef, Option.none());
        yield* Ref.set(pendingCallsRef, []);
        yield* events.publish({ _tag: "ENGINE_START", id: newArchiveEntryId() });
        // system 是这一次运行的状态:开头设一次,step 里不再重复记录
        yield* events.publish({
          _tag: "SYSTEM_MESSAGE_SET",
          id: newArchiveEntryId(),
          text: SYSTEM_MESSAGE,
        });

        // inbox 交出的就是一条**批次流**:每来一批,"可以生成"一次
        const readyBatchStream: Stream.Stream<ReadyBatch> = Stream.fromEffectRepeat(
          // 每批都读当时的"在飞调用"当 awaiting(Ref 保证拿到最新值),再等这批就位;
          // 就位 = 这些结果都回来了,在飞清单当场清空(下一批不该再等它们)
          Effect.gen(function* () {
            const pendingCalls = yield* Ref.get(pendingCallsRef);
            const readyBatch = yield* inbox.takeReadyBatch(pendingCalls.map((call) => call.callId));

            yield* Ref.set(pendingCallsRef, []);
            return readyBatch;
          }),
        );

        // 批次流永不结束;真结束(不该发生)就让引擎挂住,不静默返回
        return yield* Stream.runForEach(readyBatchStream, handleReadyBatch).pipe(
          Effect.andThen(Effect.never),
        );
      }).pipe(
        // 退出(中断 / 异常):补齐未关闭的 step,最后 engine.end
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              const message = Cause.pretty(exit.cause);

              // step 级错误先发,engine 级错误随后;turn 级错误由 hook 看到 step 后补
              yield* failStep(message, message);
              yield* events.publish({
                _tag: "ENGINE_ERROR",
                id: newArchiveEntryId(),
                message,
                cause: message,
              });
            } else {
              // 正常停止(中断):关掉未闭合的 step
              yield* endStep();
            }

            // 引擎停了:system 状态清掉,收尾
            yield* events.publish({ _tag: "SYSTEM_MESSAGE_CLEAR", id: newArchiveEntryId() });
            yield* events.publish({ _tag: "ENGINE_END", id: newArchiveEntryId() });
          }),
        ),
      );

      /** 换配置:下一次生成生效。 */
      const configure = (next: LoopConfig): Effect.Effect<void> =>
        Ref.set(configRef, Option.some(next));

      return Engine.of({ run, configure });
    }),
  );
