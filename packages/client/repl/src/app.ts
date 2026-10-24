// 装配**这个客户端**要用的整张依赖图(`AppLive`)。**不接受任何参数**:
//   - LLM 的设置(模型 / 档位 / 密钥 / 端点)是每次 `run` 的入参;
//   - 工具也是每次 `agent.run` 的入参,内置工具只是一种现成来源。
//
//   Llm ─────────────┐
//   NodeServices ──► BuiltinTools ──────┴─► repl(自己决定传哪些工具)
//
// agent 本身来自 SDK(`@archive001/agent`),这里只做组装,不实现任何能力。

import { Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { AgentLive, LlmLive } from "@archive001/agent";
import { BuiltinToolsLive } from "@archive001/agent/builtin-tools";

const AgentWithDeps = Layer.provide(LlmLive)(AgentLive);
const ToolsWithPlatform = Layer.provide(NodeServices.layer)(BuiltinToolsLive);

/** 完整应用:Agent + 内置工具 + 平台服务。 */
export const AppLive = Layer.mergeAll(AgentWithDeps, ToolsWithPlatform, NodeServices.layer);
