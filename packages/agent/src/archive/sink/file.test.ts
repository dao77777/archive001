import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSinkAt } from "./file.ts";
import { Sink } from "./service.ts";
import { makeArchiveEntryId, makeSessionId, type ArchiveEntry } from "../service.ts";

const withTempDir = <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "archive001-sink-"));
  return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
};

/** 测试专用:目录由用例给(`FileSinkLive` 的路径是固定的)。 */
const layer = (dir: string) => FileSinkAt(dir).pipe(Layer.provide(NodeServices.layer));

const write = (dir: string, entries: ReadonlyArray<ArchiveEntry>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* Sink;
      yield* sink.write(entries);
    }).pipe(Effect.provide(layer(dir))),
  );

const read = (dir: string): Promise<ReadonlyArray<ArchiveEntry>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sink = yield* Sink;
      return yield* sink.read;
    }).pipe(Effect.provide(layer(dir))),
  );

const entry = (id: string, sessionId: string, at = 0): ArchiveEntry => ({
  v: 1,
  at,
  _tag: "ENGINE_START",
  id: makeArchiveEntryId(id),
  sessionId: makeSessionId(sessionId),
});

describe("文件 sink 的写侧", () => {
  it("一个会话一个文件,文件名就是会话 id", async () => {
    await withTempDir(async (dir) => {
      await write(dir, [entry("e1", "s1"), entry("e2", "s2"), entry("e3", "s1")]);

      expect(readdirSync(dir).sort()).toEqual(["s1.jsonl", "s2.jsonl"]);

      const s1 = readdirSync(dir).filter((name) => name.startsWith("s1"));
      expect(s1).toHaveLength(1);
      expect(await read(dir)).toHaveLength(3);
    });
  });

  it("没有 sessionId 的条目直接失败(不猜落哪个文件)", async () => {
    await withTempDir(async (dir) => {
      const bad: ArchiveEntry = { v: 1, at: 0, _tag: "ENGINE_START", id: makeArchiveEntryId("x") };
      await expect(write(dir, [bad])).rejects.toThrow(/缺少 sessionId/);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("会话 id 里的路径分隔符 / 点号不会逃出目录", async () => {
    await withTempDir(async (dir) => {
      await write(dir, [entry("e1", "../../etc/passwd"), entry("e2", "a/b")]);

      const names = readdirSync(dir);
      expect(names).toHaveLength(2);
      for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]+\.jsonl$/);
    });
  });
});

describe("文件 sink 的读侧", () => {
  it("写进去的条目能读回(同一会话保持写入顺序)", async () => {
    await withTempDir(async (dir) => {
      await write(dir, [entry("e1", "s1"), entry("e2", "s1")]);

      const entries = await read(dir);
      expect(entries.map((value) => value.id)).toEqual(["e1", "e2"]);
      expect(entries[0]?._tag).toBe("ENGINE_START");
    });
  });

  it("跨会话按 at 归并,不按目录顺序", async () => {
    await withTempDir(async (dir) => {
      // 故意倒着写:先写晚的,再写早的
      await write(dir, [
        entry("late", "s2", 200),
        entry("early", "s1", 100),
        entry("mid", "s1", 150),
      ]);

      expect((await read(dir)).map((value) => value.id)).toEqual(["early", "mid", "late"]);
    });
  });

  it("目录还不存在时读回空数组", async () => {
    await withTempDir(async (dir) => {
      expect(await read(join(dir, "nope"))).toEqual([]);
    });
  });

  it("半行 / 坏行之后的条目全部丢掉(单 writer 追加,坏行只可能在尾部)", async () => {
    await withTempDir(async (dir) => {
      await write(dir, [entry("e1", "s1")]);
      // 模拟写到一半被杀:最后一行不完整
      appendFileSync(
        join(dir, "s1.jsonl"),
        '{"v":1,"at":0,"_tag":"ENGINE_START","id":"e2"}\n{"v":1,"at":0,"_ta',
      );

      const entries = await read(dir);
      expect(entries.map((value) => value.id)).toEqual(["e1", "e2"]);
    });
  });
});
