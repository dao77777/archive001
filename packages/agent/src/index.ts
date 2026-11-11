// **SDK 入口**:客户端(交互式 REPL / 将来的 TUI / 你自己的脚本)只需要从这里取东西。
//
// 典型用法:
//
//   import { Agent, Turn } from "@archive001/agent";
//   import { AgentLive } from "@archive001/agent/live"; // Node 侧:自带 Llm / archive / 内置工具
//
//   const App = AgentLive; // 输出 Agent(持续运行)+ Turn(一次完整 runTurn)
//
// 两种运行模式:
//   持续运行   Agent.run  交出句柄 `{ events, fiber, send, configure }`
//   一次 turn  Turn.runTurn(config, { text }, { onEvent? }) → 回答
//
//   const turn = yield* Turn;
//   const answer = yield* turn.runTurn(
//     { settings: { apiKey }, tools: Option.none() },
//     { text: input },
//   )
//
// `settings` 里只有 `apiKey` 必填;`tools` 是 `Option<ReadonlyArray<Tool>>` ——
// `Option.none()` = 用内置四个,`Option.some([...])` = 完全替换。
// 要自己控制超时 / 取消 / 多播,就用 `Agent.run` 交出句柄上的 `send` + `events`
// (见 docs/designs/agent/turn.md)。
//
// ⚠️ SDK **不读环境变量**:env → `LlmSettings` 的转换在 CLI / 各客户端自己那一层做。
//
// 导出分三类:服务(可直接组装)、类型(给调用方写签名)、缺省值与助手。

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

// 循环层的内部名字是 `Loop` / `LoopRuntime`;包边界换成客户端认识的 `Agent` / `AgentRuntime`
export { Loop as Agent } from "./loop/service.ts";
export { LoopRuntime as AgentRuntime } from "./loop/live.ts";
/** 一次完整的 runTurn:自己开 run、解析事件、关 run */
export { Turn } from "./turn/service.ts";
export { TurnLive } from "./turn/live.ts";
export { ArchiveRuntime } from "./archive/live.ts";
export { ProjectionLive } from "./archive/projection/live.ts";
export { Archive } from "./archive/service.ts";
export { Projection } from "./archive/projection/service.ts";
export { Sink } from "./archive/sink/service.ts"; // 存储端口;`FileSinkLive` / `MemorySinkLive` 是它的实现
export { Llm } from "./llm/service.ts";
export { LlmLive, LlmRuntime } from "./llm/live.ts";
// 构建好的 Node 侧装配(AgentLive / ArchiveLive / FileSinkLive)在 `@archive001/agent/live`。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type {
  LoopConfig as AgentConfig,
  LoopRunOptions as AgentRunOptions,
} from "./loop/service.ts";
export type { LoopShape as AgentShape, LoopRun as AgentRun, PromptInput } from "./loop/service.ts";
export type { TurnInput, TurnOptions, TurnShape } from "./turn/service.ts";
export type { Tool } from "./loop/tool-executor/service.ts";
/** 条目 / 存储:sink、错误 */
export type {
  ArchiveEntry,
  ArchiveEntryId,
  ArchiveEntryPayloads,
  ArchiveEntryTag,
  SessionId,
} from "./archive/service.ts";
/** session id 的构造器(session 列表 / useSession / readSession 用) */
export { makeSessionId } from "./archive/service.ts";
export type { SinkShape } from "./archive/sink/service.ts";
/** 读侧:条目折出来的状态(目前只有 transcript 与 inbox 视图) */
export type { InboxProjection } from "./archive/projection/service.ts";
export type { ProjectionShape, Projections } from "./archive/projection/service.ts";
/** 服务形状:契约在 `*.service.ts`,实现在同名文件里 */
export type { ArchiveShape } from "./archive/service.ts";
/** 思考档位的 Schema(值):客户端拿它校验环境变量,顺手也能拿类型 */
export { ThinkingLevel } from "./llm/_domain.ts";
/** 错误类(值):`runTurn` 的失败通道;客户端 match 它时要构造 */
export { LlmError } from "./llm/_domain.ts";
export type {
  BehaviorSettings,
  FunctionCall,
  Item,
  LlmSettings,
  ToolDefinition,
} from "./llm/_domain.ts";
export type { LlmShape } from "./llm/service.ts";

// ---------------------------------------------------------------------------
// 缺省值与助手
// ---------------------------------------------------------------------------

/**
 * 缺省行为参数(模型 / 档位)与缺省端点;密钥没有缺省值。
 * `LlmSettings` 里只有 `apiKey` 必填,其余省略即用这些缺省。
 */
export { DEFAULT_BASE_URL, DEFAULT_SETTINGS } from "./llm/_constants.ts";
/** 用 Effect Schema 造工具:一处定义,同时产出 JSON Schema 与运行时校验。 */
/** 与领域无关的小工具(客户端打印错误时常用)。 */
export { formatError } from "./_util.ts";
