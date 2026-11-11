// ═══════════════════════════════════════════════════════════════════════════
// 构建好的一层(`@archive001/agent/live`):什么依赖都不用给,拿到就能跑
//
//   AgentLive ──► 自带 Llm / archive(文件 sink + 投影)/ 内置工具 / 平台服务
//                 输出 `Agent`(持续运行)+ `Turn`(一次完整 runTurn)
//   ArchiveLive ─► 自带 投影 + 文件 sink + 平台服务
//
// ⚠️ 这个入口依赖 Node(`@effect/platform-node` / `node:fs` / `child_process`),
// 浏览器侧只能 import 包根(`@archive001/agent` 的类型与纯值)。
// ═══════════════════════════════════════════════════════════════════════════

import { homedir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";
import type { Archive } from "./archive/service.ts";
import { ArchiveRuntime } from "./archive/live.ts";
import { ProjectionLive } from "./archive/projection/live.ts";
import { FileSinkLive } from "./archive/sink/file.ts";
import { LlmLive } from "./llm/live.ts";
import type { Loop } from "./loop/service.ts";
import { LoopRuntime } from "./loop/live.ts";
import { EngineLive } from "./loop/engine/live.ts";
import { InboxLive } from "./loop/inbox/live.ts";
import { EventsLive } from "./loop/events/live.ts";
import { ToolExecutorLive } from "./loop/tool-executor/live.ts";
import { BuiltinToolsLive } from "./loop/builtin-tools/live.ts";
import type { Turn } from "./turn/service.ts";
import { TurnLive } from "./turn/live.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 所有客户端共用的 archive 文件。 */
const ARCHIVE_FILE = join(homedir(), ".local/state/archive001/archive.jsonl");

// ---------------------------------------------------------------------------
// 构建好的服务(名字在包边界换过:内部叫 Loop,对外叫 Agent)
// ---------------------------------------------------------------------------
/** `ArchiveRuntime` + 投影 + 文件 sink + 平台服务:文件打不开按缺陷处理。 */
export const ArchiveLive: Layer.Layer<Archive> = ArchiveRuntime.pipe(
  Layer.provide(ProjectionLive),
  Layer.provide(FileSinkLive(ARCHIVE_FILE)),
  Layer.provide(NodeServices.layer),
  Layer.orDie,
);

/** `LoopRuntime` + `Llm` + `Archive` + 内置工具:外面拿到就能用。 */
const LoopLive: Layer.Layer<Loop | Archive> = LoopRuntime.pipe(
  Layer.provide(EngineLive),
  Layer.provide(ToolExecutorLive),
  Layer.provide(InboxLive),
  Layer.provide(EventsLive),
  Layer.provide(BuiltinToolsLive.pipe(Layer.provide(NodeServices.layer))),
  Layer.provide(LlmLive),
  // 同时把 Archive 暴露出去:客户端要用 session / readAll / projection
  Layer.provideMerge(ArchiveLive),
  Layer.orDie,
);

/** 持续运行(`Agent`)+ 一次完整 turn(`Turn`)+ archive 读侧(`Archive`)。 */
export const AgentLive: Layer.Layer<Loop | Archive | Turn> = Layer.merge(
  LoopLive,
  TurnLive.pipe(Layer.provide(LoopLive)),
);

export { FileSinkLive } from "./archive/sink/file.ts";
