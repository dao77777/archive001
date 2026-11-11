// ═══════════════════════════════════════════════════════════════════════════
// Llm 契约:调一次模型,拿回本轮产出的 item
//
//   complete(items, tools, settings) ──► ReadonlyArray<Item>
//
// 服务不持有任何设置:模型 / 档位 / 密钥 / 端点全在 `settings` 里,所以同一个实例能被不同调用
// 用不同模型、不同 key、不同端点打。实现见 `./live.ts`。
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";
import type { Item, LlmError, LlmSettings, ToolDefinition } from "./_domain.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
// 这一层没有独立的类型:入参 / 出参都是 `_domain.ts` 的 `Item` / `ToolDefinition` / `LlmSettings`。

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/** `Llm` 服务:调用方只依赖这个 Tag,不关心底下是哪条 wire。 */
export interface LlmShape {
  /**
   * 调一次模型:给完整 item 历史 + 本次的 `settings`,拿回本轮**产出的 item**
   * (思维链 / 正文 / 工具调用)。
   *
   * `settings` 是**每次调用**的参数,不是装配参数 —— 所以同一个 `Llm` 可以被不同调用
   * 用不同模型 / 档位 / wire 打(比如以后"便宜的分类调用 + 贵的推理调用")。
   */
  readonly complete: (
    items: ReadonlyArray<Item>,
    tools: ReadonlyArray<ToolDefinition>,
    settings: LlmSettings,
  ) => Effect.Effect<ReadonlyArray<Item>, LlmError>;
}

/** `Llm` 服务 Tag(实现见 `LlmLive`)。 */
export class Llm extends Context.Service<Llm, LlmShape>()("Llm") {}
