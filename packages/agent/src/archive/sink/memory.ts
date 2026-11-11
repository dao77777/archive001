// ═══════════════════════════════════════════════════════════════════════════
// Sink → 内存:测试 / 无持久化场景
//
//   write(entries) ──► Ref 追加
//   read ──────────► Ref.get
//
// entries 由调用方持有:同一个 Ref 可以喂给多个实例,也可以用来断言"写进去了什么"。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Layer, Ref } from "effect";
import { type ArchiveEntry } from "../service.ts";
import { Sink } from "./service.ts";

export const MemorySinkLive = (
  entries: Ref.Ref<ReadonlyArray<ArchiveEntry>>,
): Layer.Layer<Sink> => {
  // -------------------------------------------------------------------------
  // 对外方法:write / read
  // -------------------------------------------------------------------------
  /** 追加到调用方持有的 Ref。 */
  const write = (incoming: ReadonlyArray<ArchiveEntry>): Effect.Effect<void> =>
    Ref.update(entries, (all) => [...all, ...incoming]);

  /** 读就是读整份。 */
  const read: Effect.Effect<ReadonlyArray<ArchiveEntry>> = Ref.get(entries);

  return Layer.succeed(Sink, { write, read });
};
