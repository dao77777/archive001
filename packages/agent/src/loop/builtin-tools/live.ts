// ═══════════════════════════════════════════════════════════════════════════
// BuiltinTools:四个现成工具(`bash` / `read_file` / `write_file` / `list_dir`)
//
// BuiltinToolsLive ──► ReadonlyArray<Tool> ──► AgentLive 装配时直接用它们
//
// 它们**是 agent 的默认工具**:`configure` 不传 `tools` 就用这四个,传了就换成你给的。
// ═══════════════════════════════════════════════════════════════════════════

import process from "node:process";
import { Context, Data, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { formatError } from "../../_util.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Tool } from "../tool-executor/service.ts";
import { BuiltinTools } from "./service.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 内置 bash 工具的单次超时(只有这个文件用)。 */
const BASH_TIMEOUT = "30 seconds";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/**
 * 用 Effect Schema 一处定义参数:生成 JSON Schema 喂给模型,同时校验模型给的参数。
 * 少一处手写、少一处漂移。
 */
const makeTool = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(options: {
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

      // 失败就让它失败:参数错误、handle 报错都由执行器的 `runTool` 转成观测
      return yield* options.handle(args);
    }),
});

const bashTool = (spawner: Spawner): Tool =>
  makeTool({
    name: "bash",
    description: "在 shell 里执行一条命令并返回 stdout/stderr。用于查看环境、跑测试、搜索等。",
    parameters: Schema.Struct({ command: Schema.String }),
    handle: (args) =>
      Effect.gen(function* () {
        const { stdout, stderr, exitCode } = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* ChildProcess.make("bash", ["-c", args.command], {
              cwd: process.cwd(),
            });
            // stdout / stderr / exitCode 必须并发读,否则写满管道缓冲区会死锁
            return yield* Effect.all(
              [
                child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                child.exitCode,
              ],
              { concurrency: 3 },
            ).pipe(
              Effect.map(([out, err, code]) => ({ stdout: out, stderr: err, exitCode: code })),
            );
          }),
        );

        const body = [stdout, stderr].filter((s) => s.length > 0).join("\n");
        const code = Number(exitCode);
        const suffix = code === 0 ? "" : `\n(exit code ${code})`;
        const text = body + suffix;
        return text.length === 0 ? "(无输出)" : text;
      }).pipe(
        Effect.timeout(BASH_TIMEOUT),
        Effect.catchTag("TimeoutError", () =>
          Effect.succeed(`错误:命令超过 ${BASH_TIMEOUT} 未完成,已终止`),
        ),
        // 把 spawner 固化进闭包,这样 execute 对调用方是零依赖的
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
  });

const readFileTool = (fs: FileSystem.FileSystem, path: Path.Path): Tool =>
  makeTool({
    name: "read_file",
    description: "读取一个文本文件的内容。",
    parameters: Schema.Struct({ path: Schema.String }),
    handle: (args) => fs.readFileString(path.resolve(args.path)),
  });

const writeFileTool = (fs: FileSystem.FileSystem, path: Path.Path): Tool =>
  makeTool({
    name: "write_file",
    description: "写入文件(覆盖),父目录会自动创建。",
    parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
    handle: (args) =>
      Effect.gen(function* () {
        const file = path.resolve(args.path);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, args.content);
        return `已写入 ${file}(${args.content.length} 字符)`;
      }),
  });

const listDirTool = (fs: FileSystem.FileSystem, path: Path.Path): Tool =>
  makeTool({
    name: "list_dir",
    description: "列出目录内容,目录名带 / 后缀。",
    parameters: Schema.Struct({ path: Schema.optional(Schema.String) }),
    handle: (args) =>
      Effect.gen(function* () {
        const dir = path.resolve(args.path ?? ".");
        const entries = yield* fs.readDirectory(dir);
        const lines = yield* Effect.forEach(entries, (name) =>
          fs.stat(path.join(dir, name)).pipe(
            Effect.map((info) => (info.type === "Directory" ? `${name}/` : name)),
            Effect.catch(() => Effect.succeed(name)),
          ),
        );
        const text = [...lines].sort().join("\n");
        return text.length === 0 ? "(空目录)" : text;
      }),
  });

/** 这一层的产物就是一个工具数组;要不要给 agent,是调用方的选择。 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/** 工具参数(JSON 字符串或 Schema 校验)出错;执行器把它转成一条观测。 */
export class ToolInputError extends Data.TaggedError("TOOL_INPUT_ERROR")<{
  readonly tool: string;
  readonly message: string;
}> {}

/** 平台服务的实例类型(`Tag` 的类类型 ≠ 服务实例类型)。 */
type Spawner = Context.Service.Shape<typeof ChildProcessSpawner.ChildProcessSpawner>;

/** 内置四件套:要平台服务(`FileSystem` / `Path` / `ChildProcessSpawner`),由装配层提供。 */
export const BuiltinToolsLive: Layer.Layer<
  BuiltinTools,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  BuiltinTools,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // -----------------------------------------------------------------------
    // 对外方法
    // -----------------------------------------------------------------------
    /** 这一层的产物就是一个工具数组;要不要给 agent 由调用方决定。 */
    return BuiltinTools.of([
      bashTool(spawner),
      readFileTool(fs, path),
      writeFileTool(fs, path),
      listDirTool(fs, path),
    ]);
  }),
);
