// ═══════════════════════════════════════════════════════════════════════════
// ToolExecutor 契约:交一批调用,结果写回 inbox
//
// `submit` 只入队,不等跑完;执行由 worker 跨批串行、批内并发。
//
// 实现在 `./live.ts`。
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";
import type { FunctionCall, ToolDefinition } from "../../llm/_domain.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/**
 * 一个可执行工具:**定义**(喂给模型的 JSON Schema)+ **执行**(模型给的参数 → 观测)。
 * 工具由调用方按次提供,agent 自己不认识任何具体工具。
 */
export interface Tool {
  readonly definition: ToolDefinition;
  /**
   * 参数 → 观测。可以失败(参数非法、命令炸了…),**也可以抛异常**:
   * 这里的 `runTool` 会把失败 / 缺陷都转成 `错误:…` 观测回喂给模型,工具自己不必兜底;
   * 输出也不必自己截断 —— 回喂前统一截到 `TOOL_MAX_OUTPUT`。
   */
  readonly execute: (rawArguments: string) => Effect.Effect<string, unknown>;
}

/** 一批发给工具执行器的任务(同一轮 `function_call`)。 */
export interface ToolBatch {
  readonly calls: ReadonlyArray<FunctionCall>;
  readonly tools: ReadonlyArray<Tool>;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** `ToolExecutor` 服务:一批批执行,观测写回 inbox。 */
export interface ToolExecutorShape {
  readonly submit: (toolBatch: ToolBatch) => Effect.Effect<void>;
}

/** `ToolExecutor` 服务 Tag(实现见 `ToolExecutorLive`)。 */
export class ToolExecutor extends Context.Service<ToolExecutor, ToolExecutorShape>()(
  "ToolExecutor",
) {}
