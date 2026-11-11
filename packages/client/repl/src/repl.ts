// 终端 REPL:读行(`node:readline`,不能用 `Terminal.readLine`,见 `ask` 的说明)、
// 渲染 `ArchiveEntry`、把 settings 与工具交给 agent。唯一允许碰 Console / ANSI 的层。

import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Console, Effect, Option } from "effect";
import {
  formatError,
  Turn,
  type ArchiveEntry,
  type LlmSettings,
  type TurnShape,
} from "@archive001/agent";
import { firstLines, paint, previewArguments } from "./_util.ts";
import {
  ANSI_CYAN,
  ANSI_DIM,
  ANSI_RED,
  ARGUMENT_PREVIEW_CHARS,
  REASONING_PREVIEW_LINES,
  REPL_PROMPT,
  TOOL_OUTPUT_PREVIEW_LINES,
} from "./_constants.ts";

// 角色 → ANSI 码,是表现层自己的排版决定;着色能力本身在 `_util.paint`
const dim = (text: string) => paint(ANSI_DIM, text);
const cyan = (text: string) => paint(ANSI_CYAN, text);
const red = (text: string) => paint(ANSI_RED, text);

/**
 * 终端渲染:正文先缓冲,遇到 tool.call 才作为"宣告"打印;
 * 最后一步没有 tool.call,它的正文是最终回答,由 `runTurn` 返回后统一打印。
 */
const makeRender = (): ((event: ArchiveEntry) => Effect.Effect<void>) => {
  let pending = "";
  let hasTool = false;

  return (event) => {
    switch (event._tag) {
      case "STEP_START":
        pending = "";
        hasTool = false;
        return Effect.void;
      case "ASSISTANT_MESSAGE":
        pending += event.text;
        return Effect.void;
      case "FUNCTION_CALL":
        hasTool = true;
        return Effect.gen(function* () {
          if (pending.length > 0) {
            yield* Console.log(`  ${pending}`);
            pending = "";
          }
          yield* Console.log(
            cyan(`  ⚙ ${event.name} ${previewArguments(event.arguments, ARGUMENT_PREVIEW_CHARS)}`),
          );
        });
      case "STEP_END":
        return Effect.gen(function* () {
          if (hasTool && pending.length > 0) yield* Console.log(`  ${pending}`);
          pending = "";
          hasTool = false;
        });
      case "REASONING":
        return Console.log(dim(`  🧠 ${firstLines(event.text, REASONING_PREVIEW_LINES)}`));
      case "INBOX_OFFER":
        return event.message._tag === "FUNCTION_CALL_OUTPUT"
          ? Console.log(
              dim(`    ↳ ${firstLines(event.message.payload.output, TOOL_OUTPUT_PREVIEW_LINES)}`),
            )
          : Effect.void;
      default:
        return Effect.void;
    }
  };
};

/**
 * 读一行;EOF / Ctrl-C / 流已关闭时返回 none,让调用方退出。
 *
 * ⚠️ **不要改用 `Terminal.readLine`**:effect 的实现给 TTY 打开 raw mode,创建 readline 时
 * 既不给 `output` 也不自己回显 —— raw mode 关掉了内核回显,结果就是"自己打的字自己看不见"。
 * 这里用 Node 原生 `readline/promises`:提示符、回显、方向键、行编辑全归它管。
 */
const ask = (rl: Interface): Effect.Effect<Option.Option<string>> =>
  Effect.tryPromise({ try: () => rl.question(REPL_PROMPT), catch: () => "closed" as const }).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
  );

/** 跑一个交互式 REPL,直到 EOF / `exit` / `quit`。 */
export const runRepl = (settings: LlmSettings): Effect.Effect<void, never, Turn> =>
  Effect.gen(function* () {
    const turn = yield* Turn;

    yield* Console.log(
      `archive001 · ${settings.model} · thinking=${settings.thinking} · 输入 exit 退出\n`,
    );

    const render = makeRender();

    const rl = yield* Effect.sync(() =>
      createInterface({ input: process.stdin, output: process.stdout }),
    );
    yield* loop(turn, settings, rl, render).pipe(Effect.ensuring(Effect.sync(() => rl.close())));
  });

const loop = (
  turn: TurnShape,
  settings: LlmSettings,
  rl: Interface,
  render: (event: ArchiveEntry) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const line = yield* ask(rl);
      if (Option.isNone(line)) break;

      const input = line.value.trim();
      if (input.length === 0) continue;
      if (input === "exit" || input === "quit") break;

      // 每一轮一个 run:runTurn 跑完就关,memory 由投影跨 run 保留
      const answer = yield* turn
        .runTurn({ settings, tools: Option.none() }, { text: input }, { onEvent: render })
        .pipe(
          Effect.catch((error) =>
            Console.log(`\n${red(`出错了:${formatError(error)}`)}\n`).pipe(Effect.as("")),
          ),
        );
      if (answer.length > 0) yield* Console.log(`\n${answer}\n`);
    }
  });
