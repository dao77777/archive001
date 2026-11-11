import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSinkLive } from "./file.ts";
import { Sink } from "./service.ts";
import { makeArchiveEntryId, type ArchiveEntry } from "../service.ts";

const withTempDir = <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "archive001-sink-"));
  return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
};

const write = (file: string, entries: ReadonlyArray<ArchiveEntry>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* Sink;
      yield* sink.write(entries);
    }).pipe(Effect.provide(FileSinkLive(file).pipe(Layer.provide(NodeServices.layer)))),
  );

const read = (file: string): Promise<ReadonlyArray<ArchiveEntry>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* Sink;
      return yield* sink.read;
    }).pipe(Effect.provide(FileSinkLive(file).pipe(Layer.provide(NodeServices.layer)))),
  );

const entry = (id: string): ArchiveEntry => ({
  v: 1,
  at: 0,
  _tag: "ENGINE_START",
  id: makeArchiveEntryId(id),
});

describe("文件 sink 的读侧", () => {
  it("写进去的条目能原样读回(顺序不变)", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "archive.jsonl");
      await write(file, [entry("e1"), entry("e2")]);

      const entries = await read(file);
      expect(entries.map((value) => value.id)).toEqual(["e1", "e2"]);
      expect(entries[0]?._tag).toBe("ENGINE_START");
    });
  });

  it("文件还不存在时读回空数组", async () => {
    await withTempDir(async (dir) => {
      expect(await read(join(dir, "nope.jsonl"))).toEqual([]);
    });
  });

  it("半行 / 坏行之后的条目全部丢掉(单 writer 追加,坏行只可能在尾部)", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "archive.jsonl");
      await write(file, [entry("e1")]);
      // 模拟写到一半被杀:最后一行不完整
      appendFileSync(file, '{"v":1,"at":0,"_tag":"ENGINE_START","id":"e2"}\n{"v":1,"at":0,"_ta');

      const entries = await read(file);
      expect(entries.map((value) => value.id)).toEqual(["e1", "e2"]);
    });
  });
});
