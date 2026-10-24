// 环境变量 → 密钥。**只有密钥从 env 来**;模型 / 档位 / 端点不读环境
// (要换就在代码里给 `settings`,或者用 agent CLI 的命令行选项)。
// 读 env 是客户端这一层的事 —— SDK 不读。

import { Effect, Redacted } from "effect";
import { ENV_API_KEY, ENV_API_KEY_FALLBACK } from "./_constants.ts";

/** 读 `DEEPSEEK_API_KEY`(兜底 `API_KEY`);两个都没设就失败并给出人话。 */
export const apiKeyFromEnv: Effect.Effect<Redacted.Redacted<string>, string> = Effect.gen(
  function* () {
    const raw = (process.env[ENV_API_KEY] ?? process.env[ENV_API_KEY_FALLBACK] ?? "").trim();
    if (raw.length === 0) {
      return yield* Effect.fail(`缺少 ${ENV_API_KEY}(或 ${ENV_API_KEY_FALLBACK})`);
    }
    return Redacted.make(raw);
  },
);
