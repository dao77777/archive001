// ═══════════════════════════════════════════════════════════════════════════
// Loop 契约:把各实体装配起来,对外只有 `Loop`
//
// `configure` / `send` / `run` 三个能力,别的一概不露;事件流由 `run` 交出。
//
// 实现在 `./live.ts`。
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect, type Fiber, type Option, type Stream } from "effect";
import type { ArchiveEntry } from "../archive/service.ts";
import type { LlmSettings } from "../llm/_domain.ts";
import type { EventHook } from "./events/service.ts";
import type { Tool } from "./tool-executor/service.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/** 一次会话的运行参数:模型 / 档位 / 密钥 / 端点 + 这次要用的工具。 */
export interface LoopConfig {
  readonly settings: LlmSettings;
  /**
   * 这次可见的工具。`none` = 用内置的 `bash` / `read_file` / `write_file` / `list_dir`
   * (由 agent 自己装配);`some([...])` 完全替换掉内置那套 —— 显式优先。
   */
  readonly tools: Option.Option<ReadonlyArray<Tool>>;
}

/** 客户端塞给 agent 的 prompt:只有 id 与文本。 */
export interface PromptInput {
  readonly id: string;
  readonly text: string;
}

/** `run` 的可选装配:目前只有 archive 的 hook 点。 */
export interface LoopRunOptions {
  /**
   * archive 的 hook:每条事件写入前调用,返回真正写入的条目。
   * `Turn` 用它插入 `TURN_*`、给 `STEP_*` 挂上 `parentId`;不传就原样写入。
   */
  readonly archive?: EventHook;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------
/**
 * `Loop` 服务的形状 —— 客户端(经 `src/index.ts` 改名成 `Agent`)只认识它。
 *
 * 只有一个入口:`run` 起引擎并交出**句柄**(事件流 / 引擎纤维 / `send` / `configure`)。
 * 这是**持续运行**的模式:以 step 为循环,不会被一轮回答关掉。一次完整的 turn 在
 * `turn/` 的 `Turn` 服务里(它借这里的 `run` 自己起停)。
 */
export interface LoopShape {
  /**
   * 起引擎(常驻循环)并交出句柄:
   * - `events`:完整生命周期事件流,订阅它就是看这一轮的过程;
   * - `fiber`:引擎纤维 —— 停下 = 中断它;它随执行 `run` 的那个纤维一起结束;
   * - `send`:塞一条纯 prompt(`INBOX_OFFER` 由 inbox 自己发);
   * - `configure`:设置模型 / 工具(下一次生成生效;至少要调一次)。
   *
   * `options.archive` 是 archive 的 hook 点:事件写入前可插入 / 改写条目。
   * 同一个实例只应该跑一个。
   */
  readonly run: (options?: LoopRunOptions) => Effect.Effect<LoopRun>;
}

/** `run` 交出的句柄(持续运行模式):事件流 + 引擎纤维 + 发 prompt / 配设置的口子。 */
export interface LoopRun {
  readonly events: Stream.Stream<ArchiveEntry>;
  readonly fiber: Fiber.Fiber<never, never>;
  readonly send: (prompt: PromptInput) => Effect.Effect<void>;
  readonly configure: (config: LoopConfig) => Effect.Effect<void>;
}
/** `Loop` 服务 Tag(实现见 `AgentLive`)。 */
export class Loop extends Context.Service<Loop, LoopShape>()("Loop") {}

/**
 * 装配:只做接线 —— `send` / `events` 交给 inbox / 事件总线,`configure` / `run` 交给引擎。
 * 引擎、inbox、执行器、事件总线都**不出现在输出里**,客户端只拿到 `Agent` 与它的 `run` 句柄。
 */
