// ═══════════════════════════════════════════════════════════════════════════
// Turn 契约:一次完整的 runTurn —— 自己开 run、解析这一轮、关掉 run
//
//   runTurn(config, { text }, { onEvent? }) ──► 回答
//
// 实现在 `./live.ts`。
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";
import type { ArchiveEntry } from "../archive/service.ts";
import type { LlmError } from "../llm/_domain.ts";
import type { LoopConfig } from "../loop/service.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/** `runTurn` 的输入:只有文本;prompt 的 id 由 `runTurn` 自己生成。 */
export interface TurnInput {
  readonly text: string;
}

/** `runTurn` 的可选回调。 */
export interface TurnOptions {
  /**
   * 每来一条事件调一次,顺序与 `Agent.events` 一致(表现层渲染用)。
   * 回调失败会让这一轮以 `LlmError` 收尾 —— 它属于调用方,内核不替它兜底。
   */
  readonly onEvent?: (entry: ArchiveEntry) => Effect.Effect<void>;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** `Turn` 服务的形状:一次调用 = 起 run → 配 → 解析 → 关 run。 */
export interface TurnShape {
  /**
   * 跑一轮:自己生成 prompt id、开一个 run、订阅事件、发 prompt、等到这一轮的
   * `TURN_END`,返回最后一步的正文;失败 / 被取消也会关掉这个 run。
   *
   * - `onEvent` 只是转发,**不影响解析**;
   * - 一轮里并进来的其他 prompt 共享这次 `TURN_END`;
   * - 要持续运行 / 自己控制等待,就用 `Agent.run` 的句柄自己订阅事件。
   */
  readonly runTurn: (
    config: LoopConfig,
    input: TurnInput,
    options?: TurnOptions,
  ) => Effect.Effect<string, LlmError>;
}

/** `Turn` 服务 Tag(实现见 `TurnLive`)。 */
export class Turn extends Context.Service<Turn, TurnShape>()("Turn") {}
