// ═══════════════════════════════════════════════════════════════════════════
// Loop:把各实体装配起来,对外只留 `Loop`
//
// configure  调整模型 / 工具(可随时改,下一次生成生效)
// send       塞一条纯 prompt(id + 文本)──► inbox.offer
// run        起引擎(消费 inbox → 调模型 → 派工具 …),交出 { events, fiber }
//
// 只做接线:引擎 / inbox / 执行器 / 事件总线都不出现在输出里,外面只拿到 `Loop`。
// 一次完整的 turn 在 `turn/` 的 `Turn` 服务里。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Layer, Option } from "effect";
import { Llm } from "../llm/service.ts";
import type { Archive } from "../archive/service.ts";
import type { LoopConfig, LoopRunOptions } from "./service.ts";
import { Loop, type LoopRun, type PromptInput } from "./service.ts";
import { Engine } from "./engine/service.ts";
import { Events } from "./events/service.ts";
import { Inbox } from "./inbox/service.ts";
import { BuiltinTools } from "./builtin-tools/service.ts";

/**
 * 只做接线、不做任何 `provide`:依赖由外面的 `LoopLive`(或测试)给。
 * 拿到的是 `Loop`,用到的五个内部实现都不出现在输出里。
 */
export const LoopRuntime: Layer.Layer<
  Loop,
  never,
  Engine | Inbox | Events | BuiltinTools | Llm | Archive
> = Layer.effect(
  Loop,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const inbox = yield* Inbox;
    const events = yield* Events;
    const engine = yield* Engine;
    const builtinTools = yield* BuiltinTools;
    /** 本层自己的 scope:引擎 fiber 挂在它下面(层死引擎死,与调用方纤维无关)。 */
    const layerScope = yield* Effect.scope;

    // -----------------------------------------------------------------------
    // 对外方法
    // -----------------------------------------------------------------------
    /** 塞一条 prompt:`INBOX_OFFER` 由 inbox 自己发:入队与事件在同一个地方,不会漏。 */
    const send = (prompt: PromptInput): Effect.Effect<void> =>
      inbox.offer({ _tag: "USER_MESSAGE", id: prompt.id, payload: { text: prompt.text } });

    /** 换配置:没给 `tools` 就用内置四个;给了就只用手给的(显式替换)。 */
    const configure = (config: LoopConfig): Effect.Effect<void> =>
      engine.configure({
        ...config,
        // 没给就用装好的内置四件套
        tools: Option.isSome(config.tools) ? config.tools : Option.some(builtinTools),
      });

    /**
     * 起引擎并交出句柄:事件流给订阅,纤维给"停"。
     * 引擎 `forkIn(层的 scope)`:它跟**这一层**同生共死,不跟 `run` 这个 Effect 本身,
     * 所以 `run` 返回句柄之后引擎照跑;`startImmediately: false` 让调用方先订阅再让它跑,开头的事件不至于漏。
     */
    const run = (options?: LoopRunOptions): Effect.Effect<LoopRun> =>
      Effect.gen(function* () {
        // 新的一段 run:先把上一次 ENGINE_END 的回放清掉,否则新订阅者会当场收到它
        yield* events.begin;
        // archive 的 hook 在这一段 run 里一直有效;下一次 run 会覆盖它
        yield* events.setHook(options?.archive);
        const fiber = yield* engine.run.pipe(
          Effect.forkIn(layerScope, { startImmediately: false }),
        );
        return { events: events.stream, fiber, send, configure };
      });

    return Loop.of({ run });
  }),
);
