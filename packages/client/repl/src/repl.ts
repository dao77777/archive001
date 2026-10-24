// 终端 REPL:读行(`node:readline`,不能用 `Terminal.readLine`,见 `ask` 的说明)、
// 渲染 `AgentEvent`、把 settings 与工具交给 agent。唯一允许碰 Console / ANSI 的层。

import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Console, Effect, Option } from "effect";
import {
  Agent,
  formatError,
  type AgentEvent,
  type AgentShape,
  type LlmSettings,
  type Tool,
} from "@archive001/agent";
import { BuiltinTools } from "@archive001/agent/builtin-tools";
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

/** 把 agent 事件渲染到终端(UI 关注点都留在这一层)。 */
const render = (event: AgentEvent): Effect.Effect<void> => {
  switch (event._tag) {
    case "thinking":
      return Console.log(dim(`  🧠 ${firstLines(event.text, REASONING_PREVIEW_LINES)}`));
    case "text":
      return Console.log(`  ${event.text}`);
    case "tool_call":
      return Console.log(
        cyan(`  ⚙ ${event.name} ${previewArguments(event.arguments, ARGUMENT_PREVIEW_CHARS)}`),
      );
    case "tool_result":
      return Console.log(dim(`    ↳ ${firstLines(event.output, TOOL_OUTPUT_PREVIEW_LINES)}`));
  }
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
export const runRepl = (settings: LlmSettings): Effect.Effect<void, never, Agent | BuiltinTools> =>
  Effect.gen(function* () {
    const agent = yield* Agent;

    yield* Console.log(
      `archive001 · ${settings.model} · thinking=${settings.thinking} · 输入 exit 退出\n`,
    );

    const tools = yield* BuiltinTools;

    const rl = yield* Effect.sync(() =>
      createInterface({ input: process.stdin, output: process.stdout }),
    );
    yield* loop(agent, rl, settings, tools).pipe(Effect.ensuring(Effect.sync(() => rl.close())));
  });

const loop = (
  agent: AgentShape,
  rl: Interface,
  settings: LlmSettings,
  tools: ReadonlyArray<Tool>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      const line = yield* ask(rl);
      if (Option.isNone(line)) break;

      const input = line.value.trim();
      if (input.length === 0) continue;
      if (input === "exit" || input === "quit") break;

      const answer = yield* agent
        .run(input, settings, tools, render)
        .pipe(
          Effect.catch((error) =>
            Console.log(`\n${red(`出错了:${formatError(error)}`)}\n`).pipe(Effect.as("")),
          ),
        );
      if (answer.length > 0) yield* Console.log(`\n${answer}\n`);
    }
  });
