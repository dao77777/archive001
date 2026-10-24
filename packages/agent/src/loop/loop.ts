// `Agent` 服务与 `AgentLive`:agent 的全部本质是一个循环 ——
// 调模型 → 若要求调工具就执行并回填 → 再调模型 → …… → 直到只回正文。
// 不认识 HTTP / wire / 文件系统,也不认识具体工具(工具是 `run` 的参数)。
// 历史是一串 `Item`,放在 Ref 里跨轮记忆。

import { Context, Effect, Layer, Ref } from "effect";
import { Llm } from "../llm/llm.ts";
import type { FunctionCall, Item, LlmError, LlmSettings } from "../llm/_domain.ts";
import { functionCallsOf, messageTextsOf, reasoningTextsOf } from "../llm/_util.ts";
import { MAX_STEPS, systemPromptFor } from "./_constants.ts";
import type { AgentEvent, AgentShape, Observer, Tool } from "./_domain.ts";
import { runTool } from "./_util.ts";

/** `Agent` 服务 Tag(实现见 `AgentLive`)。 */
export class Agent extends Context.Service<Agent, AgentShape>()("Agent") {}

/** 循环本体:依赖 `Llm`,工具与 settings 由每次 `run` 传入。 */
export const AgentLive = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const llm = yield* Llm;
    const history = yield* Ref.make<ReadonlyArray<Item>>([]);

    const emit = (observe: Observer | undefined, event: AgentEvent): Effect.Effect<void> =>
      observe === undefined ? Effect.void : observe(event);

    /** 执行一次工具调用:发事件 → 跑工具 → 发结果 → 产出要回填的 item。 */
    const executeToolCall =
      (tools: ReadonlyArray<Tool>, observe: Observer | undefined) =>
      (call: FunctionCall): Effect.Effect<Item> =>
        Effect.gen(function* () {
          yield* emit(observe, { _tag: "tool_call", name: call.name, arguments: call.arguments });
          const output = yield* runTool(tools, call.name, call.arguments);
          yield* emit(observe, { _tag: "tool_result", name: call.name, output });
          return { type: "function_call_output", callId: call.callId, output };
        });

    /**
     * 把本轮问答并进跨轮历史。
     *
     * ⚠️ 空答复**不写入**:正文为空的 assistant 消息会被拒("content or tool_calls must be set"),
     * 一旦落进历史,之后每一轮重放都会 400。
     *
     * ⚠️ 写进历史的 assistant 消息**不带 reasoning**:思维链只服务 UI,不回喂模型 ——
     * 记录(落盘)是另一件事,见 `docs/designs/agent/archive.md`。
     */
    const remember = (
      prior: ReadonlyArray<Item>,
      input: string,
      answer: string,
    ): Effect.Effect<void> => {
      const turn: ReadonlyArray<Item> =
        answer.length === 0
          ? [{ type: "message", role: "user", text: input }]
          : [
              { type: "message", role: "user", text: input },
              { type: "message", role: "assistant", text: answer },
            ];
      return Ref.set(history, [...prior, ...turn]);
    };

    const run = (
      input: string,
      settings: LlmSettings,
      tools: ReadonlyArray<Tool>,
      observe?: Observer,
    ): Effect.Effect<string, LlmError> =>
      Effect.gen(function* () {
        const prior = yield* Ref.get(history);
        // 提示词跟着工具集走:没给工具就别宣称能调工具(否则模型会把调用写成正文)
        const system = systemPromptFor(tools.map((tool) => tool.definition.name));
        let items: ReadonlyArray<Item> = [
          { type: "message", role: "system", text: system },
          ...prior,
          { type: "message", role: "user", text: input },
        ];

        for (let step = 0; step < MAX_STEPS; step++) {
          const produced = yield* llm.complete(
            items,
            tools.map((tool) => tool.definition),
            settings,
          );
          // 本轮产出按用途先分好:三种东西后面各用各的,也不重复调用取值函数
          const reasoningTexts = reasoningTextsOf(produced);
          const messageTexts = messageTextsOf(produced);
          const calls = functionCallsOf(produced);

          // 思维链先于正文(同一次生成里它本就产在前)
          for (const text of reasoningTexts) {
            yield* emit(observe, { _tag: "thinking", text });
          }

          // 没有工具调用 = 最终答复,由调用方(repl)负责打印,这里不重复发 text 事件
          if (calls.length === 0) {
            const answer = messageTexts.join("");
            yield* remember(prior, input, answer);
            return answer;
          }

          // 有工具调用时,正文是"我先查一下"这类宣告,语义在调用之前,先渲染
          for (const text of messageTexts) {
            yield* emit(observe, { _tag: "text", text });
          }

          items = [...items, ...produced];
          // 顺序执行(工具会写文件、跑 shell),结果按顺序拼回
          const outputs = yield* Effect.forEach(calls, executeToolCall(tools, observe));
          items = [...items, ...outputs];
        }

        return `(已达到最大步数 ${MAX_STEPS},任务可能未完成)`;
      });

    return Agent.of({ run });
  }),
);
