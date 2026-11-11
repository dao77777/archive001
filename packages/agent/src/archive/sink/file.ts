// ═══════════════════════════════════════════════════════════════════════════
// Sink → 文件:JSONL,一行一个 ArchiveEntry
//
//   write(entries) ──► handle.writeAll(每行一条 JSON)          // 只写页缓存,不 fsync
//   read ──────────► 读整份文本 ──► parseEntries(坏行处截断)    // 只给构建时的底稿用
//
// 只追加(flag "a"),单 writer;读是读侧(恢复)用的,独立于 writer。
// 文件 0600、目录 0700;依赖 effect 的 FileSystem / Path,由客户端提供。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, FileSystem, Layer, Path } from "effect";
import { formatError } from "../../_util.ts";
import { ArchiveError, type ArchiveEntry } from "../service.ts";
import { Sink } from "./service.ts";

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

/** `filePath` 会被 resolve;父目录自动创建,文件 0600 / 目录 0700。 */
export const FileSinkLive = (
  filePath: string,
): Layer.Layer<Sink, ArchiveError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Sink,
    Effect.gen(function* () {
      // ---------------------------------------------------------------------
      // 依赖
      // ---------------------------------------------------------------------
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // ---------------------------------------------------------------------
      // 初始化:建目录 → 打开文件
      // ---------------------------------------------------------------------
      const file = path.resolve(filePath);

      yield* fs
        .makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(wrap(`无法创建 archive 目录 ${path.dirname(file)}`)));

      const handle = yield* fs
        .open(file, { flag: "a", mode: 0o600 })
        .pipe(Effect.mapError(wrap(`无法打开 archive 文件 ${file}`)));

      const encoder = new TextEncoder();

      // ---------------------------------------------------------------------
      // 对外方法:write / read
      // ---------------------------------------------------------------------
      /** 写一批:一行一条 JSON,只写页缓存(不 fsync)。 */
      const write = (entries: ReadonlyArray<ArchiveEntry>): Effect.Effect<void, ArchiveError> =>
        handle
          .writeAll(encoder.encode(entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")))
          .pipe(Effect.mapError(wrap(`写入 archive 失败 ${file}`)));

      /**
       * 读全部:文件还不存在就是空;坏行(半行)按 `parseEntries` 截断。
       * 只给构建时的底稿用,运行期读侧不碰文件。
       */
      const read: Effect.Effect<ReadonlyArray<ArchiveEntry>, ArchiveError> = Effect.gen(
        function* () {
          const exists = yield* fs
            .exists(file)
            .pipe(Effect.mapError(wrap(`无法检查 archive 文件 ${file}`)));
          if (!exists) return [];

          const text = yield* fs
            .readFileString(file)
            .pipe(Effect.mapError(wrap(`读取 archive 失败 ${file}`)));
          return parseEntries(text);
        },
      );

      return Sink.of({ write, read });
    }),
  );
