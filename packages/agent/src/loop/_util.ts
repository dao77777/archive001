// 循环层的工具函数:造工具(`makeTool`)、派发工具调用(`runTool`)。
// 循环本身(历史 / 事件 / 记忆)在 `agent.ts`;通用小工具在 `../_util.ts`。

import { Effect, Schema } from "effect";
import { formatError } from "../_util.ts";
import { ToolInputError, type Tool } from "./_domain.ts";

/**
 * 用 Effect Schema 一处定义参数:
 *   - 生成 JSON Schema 喂给模型
 *   - 运行时校验模型给的参数
 * 少一处手写、少一处漂移。
 */
export const makeTool = <
  S extends Schema.ConstraintCodec<unknown, unknown, never, never>,
>(options: {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  readonly handle: (args: S["Type"]) => Effect.Effect<string, unknown>;
}): Tool => ({
  definition: {
    name: options.name,
    description: options.description,
    parameters: Schema.toJsonSchemaDocument(options.parameters).schema,
  },
  execute: (rawArguments) =>
    Effect.gen(function* () {
      const json = yield* Effect.try({
        try: () => JSON.parse(rawArguments) as unknown,
        catch: (cause) =>
          new ToolInputError({
            tool: options.name,
            message: `参数不是合法 JSON:${formatError(cause)}`,
          }),
      });

      const args = yield* Schema.decodeUnknownEffect(options.parameters)(json).pipe(
        Effect.mapError(
          (issue) =>
            new ToolInputError({
              tool: options.name,
              message: `参数校验失败:${formatError(issue)}`,
            }),
        ),
      );

      return yield* options.handle(args);
    }).pipe(Effect.catch((error) => Effect.succeed(`错误:${formatError(error)}`))),
});

/** 按名字找工具并执行;找不到也返回一条观测(模型看到错误才能自我纠正)。 */
export const runTool = (
  tools: ReadonlyArray<Tool>,
  name: string,
  rawArguments: string,
): Effect.Effect<string> => {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  return tool === undefined ? Effect.succeed(`错误:未知工具 ${name}`) : tool.execute(rawArguments);
};
