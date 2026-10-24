// 循环层的类型(不含逻辑):事件、服务形状、工具契约、工具相关错误。
// 常量在 `./_constants.ts`;llm 的类型在 `../llm/_domain.ts`。

import { Context, Data } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { Effect } from "effect";
import type { LlmError, LlmSettings, ToolDefinition } from "../llm/_domain.ts";

// ---------------------------------------------------------------------------
// 事件与服务形状
// ---------------------------------------------------------------------------

/** agent 运行时发出的中间事件,交给 UI 渲染(agent 自己不碰 Console)。 */
export type AgentEvent =
  | { readonly _tag: "thinking"; readonly text: string }
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "tool_call"; readonly name: string; readonly arguments: string }
  | { readonly _tag: "tool_result"; readonly name: string; readonly output: string };

/** UI 观察者:agent 只发事件,渲染是调用方的事。 */
export type Observer = (event: AgentEvent) => Effect.Effect<void>;

/**
 * 一个可执行工具:**定义**(喂给模型的 JSON Schema)+ **执行**(模型给的参数 → 观测)。
 * 工具由调用方按次提供,agent 自己不认识任何具体工具。
 */
export interface Tool {
  readonly definition: ToolDefinition;
  /** 永不失败:错误也当成观测返回给模型。 */
  readonly execute: (rawArguments: string) => Effect.Effect<string>;
}

/** `Agent` 服务的形状:一次 `run` 就是一次请求。 */
export interface AgentShape {
  /**
   * 一次请求就是一次 run:
   *   - `settings`:模型 / 档位 / wire(按次给,不绑在服务上)
   *   - `tools`   :这次可见的工具(按次给,可空)
   */
  readonly run: (
    input: string,
    settings: LlmSettings,
    tools: ReadonlyArray<Tool>,
    observe?: Observer,
  ) => Effect.Effect<string, LlmError>;
}

// ---------------------------------------------------------------------------
// 工具实现所需的类型
// ---------------------------------------------------------------------------

/** 平台服务的实例类型(`Tag` 的类类型 ≠ 服务实例类型)。 */
export type Spawner = Context.Service.Shape<typeof ChildProcessSpawner.ChildProcessSpawner>;

/** 工具参数(JSON 字符串或 Schema 校验)出错;`makeTool` 把它转成观测返回给模型。 */
export class ToolInputError extends Data.TaggedError("ToolInputError")<{
  readonly tool: string;
  readonly message: string;
}> {}
