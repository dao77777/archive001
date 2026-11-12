// ═══════════════════════════════════════════════════════════════════════════
// Sink → 文件:**一个会话一个文件**,JSONL,一行一个 ArchiveEntry
//
//   写:条目按 `sessionId` 分组 ──► `<目录>/<会话>.jsonl`(flag "a",0600)
//   读:旧单文件(若有)+ 目录下每个 `*.jsonl` ──► 各自解析 ──► 按 `at` 稳定归并
//
// 路径**固定在文件里**,调用方(`ArchiveLive`)不知道也不该知道写到哪:
// 它只认 `Sink` 的 `read` / `write`。换存储(内存 / 远端)只换实现。
//
// 单 writer 假设不变:同一个 sink 实例顺序追加;一个会话一个文件,坏行只可能在尾部。
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Layer, Path } from "effect";
import { formatError } from "../../_util.ts";
import { ArchiveError, type ArchiveEntry, type SessionId } from "../service.ts";
import { Sink } from "./service.ts";

// ---------------------------------------------------------------------------
// 位置(固定,由调用方之外的这一层决定)
// ---------------------------------------------------------------------------
/** 会话目录:每个会话一个 `<sessionId>.jsonl`。 */
const ARCHIVE_DIR = join(homedir(), ".local/state/archive001/sessions");

const EXT = ".jsonl";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** 把底层错误包成 `ArchiveError`,消息里带上"在哪个路径上失败了"。 */
const wrap =
  (message: string) =>
  (cause: unknown): ArchiveError =>
    new ArchiveError({ message: `${message}:${formatError(cause)}`, cause });

/**
 * JSONL → entries。坏行一律**停在那里**(丢掉它和它之后的):
 * 单 writer 追加时坏行只可能出现在尾部(半行),后面的内容不可信。
 */
const parseEntries = (text: string): ReadonlyArray<ArchiveEntry> => {
  const entries: Array<ArchiveEntry> = [];

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as ArchiveEntry);
    } catch {
      break;
    }
  }

  return entries;
};

/**
 * 会话 id → 文件名。只留 `[A-Za-z0-9_-]`(id 来自浏览器,可能带 `/` 或 `..`);
 * 被改过的补一段短哈希,免得 `a/b` 与 `a_b` 落到同一个文件。
 */
const fileNameOf = (sessionId: string): string => {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  if (safe === sessionId && safe.length > 0) return `${safe}${EXT}`;
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return `${safe.length === 0 ? "_" : safe}-${digest}${EXT}`;
};

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------
/**
 * 文件 sink。目录默认是 `ARCHIVE_DIR`;**`FileSinkAt` 只是给测试换目录用**,
 * 装配侧(`ArchiveLive`)一律用 `FileSinkLive`,不该知道路径。
 */
const makeFileSink = (
  dir: string,
): Layer.Layer<Sink, ArchiveError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Sink,
    Effect.gen(function* () {
      // ---------------------------------------------------------------------
      // 依赖
      // ---------------------------------------------------------------------
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const archiveDir = path.resolve(dir);

      yield* fs
        .makeDirectory(archiveDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(wrap(`无法创建 archive 目录 ${archiveDir}`)));

      // ---------------------------------------------------------------------
      // 写
      // ---------------------------------------------------------------------
      /** 追加一批到某个文件:每次开→写→关(句柄跟着 scope 关,不攒 fd)。 */
      const appendTo = (file: string, batch: ReadonlyArray<ArchiveEntry>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs
              .open(file, { flag: "a", mode: 0o600 })
              .pipe(Effect.mapError(wrap(`无法打开 archive 文件 ${file}`)));
            const text = batch.map((entry) => `${JSON.stringify(entry)}\n`).join("");
            yield* handle
              .writeAll(encoder.encode(text))
              .pipe(Effect.mapError(wrap(`写入 archive 失败 ${file}`)));
          }),
        );

      /** 写一批:按会话分组,各自追加到自己的文件。 */
      const write = (entries: ReadonlyArray<ArchiveEntry>): Effect.Effect<void, ArchiveError> =>
        Effect.gen(function* () {
          const groups = new Map<SessionId, Array<ArchiveEntry>>();
          for (const entry of entries) {
            // 走到 sink 的条目一定已被 `Archive.append` 打上会话;没有就是 bug,别猜一个
            if (entry.sessionId === undefined) {
              return yield* Effect.fail(
                new ArchiveError({
                  message: `条目缺少 sessionId(${entry._tag} ${entry.id}),无从决定写哪个文件`,
                }),
              );
            }
            const group = groups.get(entry.sessionId);
            if (group === undefined) groups.set(entry.sessionId, [entry]);
            else group.push(entry);
          }

          yield* Effect.forEach(
            groups,
            ([sessionId, batch]) => appendTo(join(archiveDir, fileNameOf(sessionId)), batch),
            { discard: true },
          );
        });

      // ---------------------------------------------------------------------
      // 读
      // ---------------------------------------------------------------------
      /** 一个文件 → entries;不存在就是空。 */
      const readOne = (file: string): Effect.Effect<ReadonlyArray<ArchiveEntry>, ArchiveError> =>
        Effect.gen(function* () {
          const exists = yield* fs
            .exists(file)
            .pipe(Effect.mapError(wrap(`无法检查 archive 文件 ${file}`)));
          if (!exists) return [];
          const text = yield* fs
            .readFileString(file)
            .pipe(Effect.mapError(wrap(`读取 archive 失败 ${file}`)));
          return parseEntries(text);
        });

      /** 会话目录下的所有 `.jsonl`;目录不在就是空。 */
      const sessionFiles: Effect.Effect<ReadonlyArray<string>, ArchiveError> = Effect.gen(
        function* () {
          const exists = yield* fs
            .exists(archiveDir)
            .pipe(Effect.mapError(wrap(`无法检查 archive 目录 ${archiveDir}`)));
          if (!exists) return [];
          const names = yield* fs
            .readDirectory(archiveDir)
            .pipe(Effect.mapError(wrap(`无法列出 archive 目录 ${archiveDir}`)));
          return names.filter((name) => name.endsWith(EXT)).map((name) => join(archiveDir, name));
        },
      );

      /**
       * 读全部:目录下每个会话文件。
       * 跨会话按 `at` **稳定**排序 —— 同一会话内的先后仍是文件里的先后;
       * `ArchiveRuntime` 用"最后一条"决定默认回到哪段会话,所以这里必须按时间归并,
       * 不能拿目录顺序凑。
       */
      const read: Effect.Effect<ReadonlyArray<ArchiveEntry>, ArchiveError> = Effect.gen(
        function* () {
          const files = yield* sessionFiles;
          const all: Array<ArchiveEntry> = [];
          for (const file of files) all.push(...(yield* readOne(file)));
          return all.sort((left, right) => left.at - right.at);
        },
      );

      return Sink.of({ write, read });
    }),
  );

/** 默认文件 sink:写到 `~/.local/state/archive001/sessions/<会话>.jsonl`。 */
export const FileSinkLive: Layer.Layer<Sink, ArchiveError, FileSystem.FileSystem | Path.Path> =
  makeFileSink(ARCHIVE_DIR);

/** **仅测试用**:把会话目录换到别处(`FileSinkLive` 的路径是固定的)。 */
export const FileSinkAt = makeFileSink;
