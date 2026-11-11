// ═══════════════════════════════════════════════════════════════════════════
// Engine 契约:常驻循环 + 改配置的入口
//
// `run` 是那个无限循环,`configure` 只换配置,下一次生成生效。
//
// 实现在 `./live.ts`。
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";
import type { LoopConfig } from "../service.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
// 这一层没有独立的类型:`configure` 收的 `LoopConfig` 在 `../service.ts`。

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** `Engine` 服务形状:常驻循环 + 改它状态的入口。 */
export interface EngineShape {
  /** 无限循环(消费 inbox → 调模型 → 派工具 …);调用方负责它的生命周期。 */
  readonly run: Effect.Effect<never>;
  /** 换配置(settings / tools):下一次生成生效。 */
  readonly configure: (config: LoopConfig) => Effect.Effect<void>;
}

/** `Engine` 服务 Tag(实现见 `EngineLive`)。只由 `AgentLive` 装配,不从 SDK 导出。 */
export class Engine extends Context.Service<Engine, EngineShape>()("Engine") {}

/**
 * 引擎本体:单纤维,只跑 **step 循环**。配置与 step 生命周期 id 在自己手里,
 * **transcript 不在本地** —— 每次生成前从 archive 投影(事件就是历史,archive 是唯一状态源)。
 *
 * - 外面只能通过 `configure` 改配置,`run` 就是那个常驻循环;
 * - 引擎不感知 turn:`TURN_*` 与 step 的 `parentId` 由 `Turn` 通过 archive hook 织入;
 * - 退出(包括被中断)时补齐未关闭的 step,并发出 `engine.end`。
 */
