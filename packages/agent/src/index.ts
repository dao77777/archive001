// **SDK 入口**:客户端(交互式 REPL / 将来的 TUI / 你自己的脚本)只需要从这里取东西。
//
// 典型用法:
//
//   import { Agent, AgentLive, LlmLive, BuiltinTools, BuiltinToolsLive } from "@archive001/agent";
//
//   const App = Layer.mergeAll(
//     Layer.provide(LlmLive)(AgentLive),                   // Agent(不需要任何配置)
//     Layer.provide(NodeServices.layer)(BuiltinToolsLive), // Tool[]
//     NodeServices.layer,
//   );
//
// **设置与工具都是按次传的**;设置里只有 `apiKey` 必填,其余有缺省:
//   agent.run(input, { apiKey }, tools, observe?)
//   agent.run(input, { apiKey, model: "deepseek-v4-pro", thinking: "max" }, tools, observe?)
//
// ⚠️ SDK **不读环境变量**:env → `LlmSettings` 的转换在 CLI / 各客户端自己那一层做。
//
// 导出分三类:服务(可直接组装)、类型(给调用方写签名)、缺省值与助手。

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export { Agent, AgentLive } from "./loop/loop.ts";
export { Llm, LlmLive } from "./llm/llm.ts";
// 内置工具单独走 `@archive001/agent/builtin-tools`:它们依赖 node:fs / child_process,浏览器里不该被拉进来。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type { AgentEvent, AgentShape, Observer, Tool } from "./loop/_domain.ts";
/** 思考档位的 Schema(值):客户端拿它校验环境变量,顺手也能拿类型 */
export { ThinkingLevel } from "./llm/_domain.ts";
export type {
  BehaviorSettings,
  FunctionCall,
  Item,
  LlmError,
  LlmSettings,
  LlmShape,
  ToolDefinition,
} from "./llm/_domain.ts";

// ---------------------------------------------------------------------------
// 缺省值与助手
// ---------------------------------------------------------------------------

/**
 * 缺省行为参数(模型 / 档位)与缺省端点;密钥没有缺省值。
 * `LlmSettings` 里只有 `apiKey` 必填,其余省略即用这些缺省。
 */
export { DEFAULT_BASE_URL, DEFAULT_SETTINGS } from "./llm/_constants.ts";
/** 用 Effect Schema 造工具:一处定义,同时产出 JSON Schema 与运行时校验。 */
export { makeTool } from "./loop/_util.ts";
/** 与领域无关的小工具(客户端打印错误 / 截断长输出时常用)。 */
export { formatError, truncate } from "./_util.ts";
