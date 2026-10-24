import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { BuiltinTools, BuiltinToolsLive } from "./builtin-tools.ts";
import type { Tool } from "./_domain.ts";

const TestLive = BuiltinToolsLive.pipe(Layer.provide(NodeServices.layer));

const run = <A, E>(effect: Effect.Effect<A, E, BuiltinTools>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestLive)));

const withTempDir = <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "archive001-"));
  return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
};

/** 内置工具就是一组 `Tool`,调用方按名字派发(agent 里也是同一件事)。 */
const execute = (tools: ReadonlyArray<Tool>, name: string, rawArguments: string) =>
  Effect.gen(function* () {
    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (tool === undefined) return `错误:未知工具 ${name}`;
    return yield* tool.execute(rawArguments);
  });

describe("内置工具", () => {
  it("四个工具都带名字、描述与 JSON Schema", async () => {
    const tools = await run(
      Effect.gen(function* () {
        return yield* BuiltinTools;
      }),
    );
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "bash",
      "read_file",
      "write_file",
      "list_dir",
    ]);
    for (const tool of tools) {
      expect(tool.definition.description.length).toBeGreaterThan(0);
      expect(tool.definition.parameters).toMatchObject({ type: "object" });
    }
  });

  it("write_file 之后 read_file 能读回内容", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "hello.txt");
      const content = await run(
        Effect.gen(function* () {
          const tools = yield* BuiltinTools;
          yield* execute(
            tools,
            "write_file",
            JSON.stringify({ path: file, content: "你好,Effect" }),
          );
          return yield* execute(tools, "read_file", JSON.stringify({ path: file }));
        }),
      );
      expect(content).toBe("你好,Effect");
    });
  });

  it("list_dir 给目录加 / 后缀", async () => {
    await withTempDir(async (dir) => {
      const listing = await run(
        Effect.gen(function* () {
          const tools = yield* BuiltinTools;
          yield* execute(
            tools,
            "write_file",
            JSON.stringify({ path: join(dir, "a.txt"), content: "x" }),
          );
          yield* execute(
            tools,
            "write_file",
            JSON.stringify({ path: join(dir, "sub", "b.txt"), content: "y" }),
          );
          return yield* execute(tools, "list_dir", JSON.stringify({ path: dir }));
        }),
      );
      expect(listing.split("\n")).toEqual(["a.txt", "sub/"]);
    });
  });

  it("参数校验失败时把错误当观测返回,而不是抛异常", async () => {
    const output = await run(
      Effect.gen(function* () {
        const tools = yield* BuiltinTools;
        return yield* execute(tools, "read_file", "{}");
      }),
    );
    expect(output.startsWith("错误:")).toBe(true);
  });
});
