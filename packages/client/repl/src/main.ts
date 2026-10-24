// **REPL 客户端**的入口:决定设置从哪来 → 装配 → 跑。
// 现在只有密钥来自环境变量;模型 / 档位 / 端点用 SDK 的缺省(要换就改这里)。
// 换 CLI flag / 配置文件只改这个文件;UI 逻辑在 `repl.ts`。
//
// 别的客户端(如将来的 TUI)是**另一个包**(`packages/tui`),各自有入口,
// 互不共用表现层代码 —— 只共用 `@archive001/agent` 这个 SDK。

import process from "node:process";
import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { apiKeyFromEnv } from "./_env.ts";
import { AppLive } from "./app.ts";
import { runRepl } from "./repl.ts";

const program = Effect.gen(function* () {
  const apiKey = yield* apiKeyFromEnv;
  return yield* runRepl({ apiKey }).pipe(Effect.provide(AppLive));
}).pipe(
  // 设置读不出来(没 key / 档位写错)时给一句人话,不要甩 stack
  Effect.catch((message) =>
    Effect.sync(() => {
      process.stderr.write(`${String(message)}\n`);
      process.exitCode = 2;
    }),
  ),
);

NodeRuntime.runMain(program);
