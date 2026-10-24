// 真 key 冒烟:跑两轮带工具的对话,把 AgentEvent 打出来。
// 验证「请求形状 + 回放契约 + 解析」在真实 API 上成立(单元测试只有 mock 服务端)。
//
//   sops exec-env ~/Code/_vault/env/secrets.enc.yaml 'pnpm smoke'
//   sops exec-env ~/Code/_vault/env/secrets.enc.yaml 'pnpm smoke max'   # 档位走参数,不走 env
import { Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { Schema } from "effect";
import { Agent, ThinkingLevel, type LlmSettings } from "@archive001/agent";
import { BuiltinTools } from "@archive001/agent/builtin-tools";
import { AppLive } from "../src/app.ts";
import { apiKeyFromEnv } from "../src/_env.ts";

const show = (event: { readonly _tag: string }) => Effect.log(`  ${event._tag}`);

const smoke = (settings: LlmSettings) =>
  Effect.gen(function* () {
    const agent = yield* Agent;
    const tools = yield* BuiltinTools;
    yield* Effect.log(
      `model=${settings.model ?? "(缺省)"} thinking=${settings.thinking ?? "(缺省)"}`,
    );

    const first = yield* agent.run(
      "用 list_dir 看当前目录,再数一下 src 下有几个 .ts 文件。",
      settings,
      tools,
      show,
    );
    yield* Effect.log(`A1: ${first}`);

    // 第二轮:历史里已有工具调用轮,这一步会真正考验回放契约
    const second = yield* agent.run("刚才数出来是几个?", settings, tools, show);
    yield* Effect.log(`A2: ${second}`);
  }).pipe(Effect.provide(AppLive));

/** 第一个参数可选:思考档位(不读环境变量,一次性参数写在命令行上)。 */
const rawThinking = process.argv[2];

const program = Effect.gen(function* () {
  const apiKey = yield* apiKeyFromEnv;
  const thinking =
    rawThinking === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(ThinkingLevel)(rawThinking).pipe(
          Effect.mapError(() => `档位只能是 off | low | high | max,收到 "${rawThinking}"`),
        );
  return yield* smoke({ apiKey, ...(thinking === undefined ? {} : { thinking }) });
});

NodeRuntime.runMain(program);
