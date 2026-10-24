// 内置工具:`bash` / `read_file` / `write_file` / `list_dir`。
// ⚠️ 它们**不是 agent 的一部分**:`agent.run` 只收调用方给的 `ReadonlyArray<Tool>`,
// 这一层是"想要这几个工具时"的现成实现 —— 给不给、给哪几个,由调用方决定。

import process from "node:process";
import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { truncate } from "../_util.ts";
import { BASH_TIMEOUT, TOOL_MAX_OUTPUT } from "./_constants.ts";
import { type Spawner, type Tool } from "./_domain.ts";
import { makeTool } from "./_util.ts";

// ---------------------------------------------------------------------------
// 四个工具:读、写、列目录、跑命令
// ---------------------------------------------------------------------------

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
        const text = truncate(body + suffix, TOOL_MAX_OUTPUT);
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
    handle: (args) =>
      fs
        .readFileString(path.resolve(args.path))
        .pipe(Effect.map((text) => truncate(text, TOOL_MAX_OUTPUT))),
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
        const text = truncate([...lines].sort().join("\n"), TOOL_MAX_OUTPUT);
        return text.length === 0 ? "(空目录)" : text;
      }),
  });

// ---------------------------------------------------------------------------
// 内置工具集(可选):agent 不依赖它,由调用方决定要不要把它传给 `agent.run`
// ---------------------------------------------------------------------------

/** 这一层的产物就是一个工具数组;要不要给 agent,是调用方的选择。 */
export class BuiltinTools extends Context.Service<BuiltinTools, ReadonlyArray<Tool>>()(
  "BuiltinTools",
) {}

/** 提供内置四个工具;调用方拿到后自行决定传给 `agent.run` 还是不用。 */
export const BuiltinToolsLive = Layer.effect(
  BuiltinTools,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return BuiltinTools.of([
      bashTool(spawner),
      readFileTool(fs, path),
      writeFileTool(fs, path),
      listDirTool(fs, path),
    ]);
  }),
);
