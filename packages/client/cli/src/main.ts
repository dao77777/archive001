#!/usr/bin/env node
// **CLI 客户端**:一次性跑一个 prompt,给"不想写代码"的客户端用(含 shell 脚本)。
// 它和 repl / web / tui 一样是**客户端**:只依赖 `@archive001/agent` 的 SDK,
// 内核不认识它:本包只消费 SDK。
//
//   archive001 "列出当前目录"                           文本模式:事件流 + 最终答复
//   archive001 --json "列出当前目录"                    NDJSON:每行一个事件,最后一行是答复
//   archive001 --thinking max --model deepseek-v4-pro "…"
//
// 设置分两路:**密钥只从环境变量来**(机密),**模型 / 档位 / 端点只从命令行来**(显式)。
// 环境变量不读这三项 —— 一次性的行为参数写在命令里,比藏在 shell 环境里更难弄错。
//
// 交互式客户端(REPL / TUI)是另外的包;它们直接 import SDK,不走这个 CLI。

import process from "node:process";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Archive, formatError, ThinkingLevel, Turn } from "@archive001/agent";
import { AgentLive } from "@archive001/agent/live";
import type { ArchiveEntry, LlmSettings } from "@archive001/agent";
import { ENV_API_KEY, ENV_API_KEY_FALLBACK } from "./_constants.ts";

/** `AgentLive` 自带 `Llm` / 文件 archive / 内置工具;平台服务留给本进程自己用。 */
const AppLive = Layer.mergeAll(AgentLive, NodeServices.layer);

type Output = "text" | "json";

/** 命令行上能覆盖的设置(密钥不在此列)。 */
interface SettingsFlags {
  readonly model?: string;
  readonly thinking?: string;
  readonly baseUrl?: string;
}

const USAGE = `用法:archive001 [选项] <prompt...>

  --json              事件与答复按 NDJSON 输出(给机器读)
  --model <名字>      缺省 deepseek-flash
  --thinking <档位>   off | low | high | max(缺省 high)
  --base-url <URL>    缺省 https://api.deepseek.com
  -h, --help          显示这段说明

环境变量(只读一项):
  DEEPSEEK_API_KEY | API_KEY   必填。其余设置一律走上面的命令行选项`;

const parseArgs = (
  argv: ReadonlyArray<string>,
):
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }
  | ({
      readonly kind: "run";
      readonly prompt: string;
      readonly output: Output;
    } & SettingsFlags) => {
  if (argv.includes("-h") || argv.includes("--help")) return { kind: "help" };

  let output: Output = "text";
  const flags: { model?: string; thinking?: string; baseUrl?: string } = {};
  const words: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--json") {
      output = "json";
      continue;
    }

    // 需要取值的选项:值是下一个 token,缺了就报用法错(不要静默当成 prompt 的一部分)
    const key =
      arg === "--model"
        ? "model"
        : arg === "--thinking"
          ? "thinking"
          : arg === "--base-url"
            ? "baseUrl"
            : undefined;
    if (key !== undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: `${arg} 需要一个值` };
      }
      flags[key] = value;
      index++;
      continue;
    }

    words.push(arg);
  }

  const prompt = words.join(" ").trim();
  return { kind: "run", prompt, output, ...flags };
};

/**
 * 环境变量只贡献密钥;模型 / 档位 / 端点从命令行来(省了就让 SDK 的缺省值兜底)。
 * 这是在**入口这一层**做的事 —— SDK 不读环境变量。
 */
const settingsFrom = (flags: SettingsFlags): Effect.Effect<LlmSettings, string> =>
  Effect.gen(function* () {
    const apiKey = (process.env[ENV_API_KEY] ?? process.env[ENV_API_KEY_FALLBACK] ?? "").trim();
    if (apiKey.length === 0) {
      return yield* Effect.fail(`缺少 ${ENV_API_KEY}(或 ${ENV_API_KEY_FALLBACK})`);
    }

    const thinking =
      flags.thinking === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(ThinkingLevel)(flags.thinking).pipe(
            Effect.mapError(
              () => `--thinking 只能是 off | low | high | max,收到 "${flags.thinking}"`,
            ),
          );

    return {
      apiKey: Redacted.make(apiKey),
      ...(flags.model === undefined ? {} : { model: flags.model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(flags.baseUrl === undefined ? {} : { baseUrl: flags.baseUrl }),
    };
  });

/**
 * 文本模式渲染:正文先缓冲,遇到 tool.call 才作为"宣告"打印;
 * 最后一步没有 tool.call,它的正文是最终回答,由 `runTurn` 返回后统一打印。
 */
const makeTextRenderer =
  (print: (line: string) => Effect.Effect<void>) =>
  (event: ArchiveEntry): Effect.Effect<void> => {
    let pending = "";
    let hasTool = false;

    return event._tag === "STEP_START"
      ? Effect.sync(() => {
          pending = "";
          hasTool = false;
        })
      : event._tag === "ASSISTANT_MESSAGE"
        ? Effect.sync(() => {
            pending += event.text;
          })
        : event._tag === "FUNCTION_CALL"
          ? Effect.gen(function* () {
              hasTool = true;
              if (pending.length > 0) {
                yield* print(`[说] ${pending}`);
                pending = "";
              }
              yield* print(`[调用] ${event.name} ${event.arguments}`);
            })
          : event._tag === "STEP_END"
            ? Effect.gen(function* () {
                if (hasTool && pending.length > 0) yield* print(`[说] ${pending}`);
                pending = "";
                hasTool = false;
              })
            : event._tag === "REASONING"
              ? print(`[思考] ${event.text}`)
              : event._tag === "INBOX_OFFER" && event.message._tag === "FUNCTION_CALL_OUTPUT"
                ? print(`[结果] ${event.message.payload.output}`)
                : Effect.void;
  };

const runOnce = (prompt: string, output: Output, flags: SettingsFlags) =>
  Effect.gen(function* () {
    const turn = yield* Turn;
    const archive = yield* Archive;
    const settings = yield* settingsFrom(flags);

    // 一次 CLI = 一段新会话;archive 里的其它会话不受影响
    yield* archive.startSession;

    const print = (line: string) => Effect.sync(() => void process.stdout.write(`${line}\n`));
    const renderText = makeTextRenderer(print);
    const onEvent =
      output === "json" ? (event: ArchiveEntry) => print(JSON.stringify(event)) : renderText;

    // 一次 CLI = 一轮:runTurn 自己起 run、跑完关掉
    const answer = yield* turn.runTurn(
      { settings, tools: Option.none() },
      { text: prompt },
      { onEvent },
    );
    yield* print(output === "json" ? JSON.stringify({ _tag: "ANSWER", text: answer }) : answer);
  }).pipe(
    Effect.catchTag("LLM_ERROR", (error) =>
      Effect.sync(() => {
        process.stderr.write(`出错了:${formatError(error)}\n`);
        process.exitCode = 1;
      }),
    ),
    // 剩下的失败都是"设置没给对 / 环境没配好"这类字符串消息
    Effect.catch((message) =>
      Effect.sync(() => {
        process.stderr.write(`${typeof message === "string" ? message : formatError(message)}\n`);
        process.exitCode = 2;
      }),
    ),
  );

// ⚠️ 先解析参数、再决定要不要进 Effect:否则 `--help` / 空参数也会去读环境变量。
const args = parseArgs(process.argv.slice(2));

if (args.kind === "help") {
  process.stdout.write(`${USAGE}\n`);
} else if (args.kind === "error") {
  process.stderr.write(`${args.message}\n\n${USAGE}\n`);
  process.exitCode = 2;
} else if (args.prompt.length === 0) {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
} else {
  NodeRuntime.runMain(
    runOnce(args.prompt, args.output, {
      model: args.model,
      thinking: args.thinking,
      baseUrl: args.baseUrl,
    }).pipe(Effect.provide(AppLive)),
  );
}
