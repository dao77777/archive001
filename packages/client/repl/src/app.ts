// 装配**这个客户端**要用的依赖图(`AppLive`)。**不接受任何参数**:
//   - `AgentLive` 自带 `Llm`、archive(文件 sink + 投影)、内置工具;
//   - LLM 的设置(模型 / 档位 / 密钥 / 端点)是每次 `configure` / `run` 的入参;
//   - 平台服务留给 REPL 自己用。
//
// agent 本身来自 SDK(`@archive001/agent`),这里只做组装,不实现任何能力。

import { Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { AgentLive } from "@archive001/agent/live";

/** 完整应用:`AgentLive` 自带 Llm / archive / 内置工具;平台服务留给 REPL 自己用。 */
export const AppLive = Layer.mergeAll(AgentLive, NodeServices.layer);
