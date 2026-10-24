import { describe, expect, it } from "vitest";
import { Effect, Layer, Redacted, Ref } from "effect";
import { Agent, AgentLive } from "./loop.ts";
import type { AgentEvent, Tool } from "./_domain.ts";
import { DEFAULT_SETTINGS } from "../llm/_constants.ts";
import type { LlmSettings } from "../llm/_domain.ts";
import { Llm } from "../llm/llm.ts";
import type { Item } from "../llm/_domain.ts";

/** 循环不碰连接信息,但 `LlmSettings` 里带着,于是给一份假的(假 LLM 从不发请求)。 */
const testSettings: LlmSettings = {
  ...DEFAULT_SETTINGS,
  apiKey: Redacted.make("test-key"),
  baseUrl: "http://127.0.0.1:1",
};

const textItem = (role: "user" | "assistant", text: string): Item => ({
  type: "message",
  role,
  text,
});

const callItem: Item = {
  type: "function_call",
  callId: "call_1",
  name: "bash",
  arguments: '{"command":"ls"}',
};

const toolTurn: ReadonlyArray<Item> = [{ type: "reasoning", text: "先看目录" }, callItem];

/** 按脚本依次回复的假 LLM;顺带记录每次收到什么历史。 */
const scriptedLlm = (script: ReadonlyArray<ReadonlyArray<Item>>) => {
  const seen: Array<ReadonlyArray<Item>> = [];
  const layer = Layer.effect(
    Llm,
    Effect.gen(function* () {
      const step = yield* Ref.make(0);
      return Llm.of({
        complete: (items) =>
          Effect.gen(function* () {
            seen.push(items);
            const index = yield* Ref.get(step);
            yield* Ref.update(step, (n) => n + 1);
            return script[index] ?? script[script.length - 1] ?? [];
          }),
      });
    }),
  );
  return { layer, seen };
};

/** 不做真事的工具:只回显被调用了。工具现在按次传入,不是服务。 */
const stubTools: ReadonlyArray<Tool> = [
  {
    definition: { name: "bash", description: "stub", parameters: { type: "object" } },
    execute: (rawArguments) => Effect.succeed(`stub:bash(${rawArguments})`),
  },
];

const agentLayer = (llm: Layer.Layer<Llm>) => AgentLive.pipe(Layer.provide(llm));

const collect = (script: ReadonlyArray<ReadonlyArray<Item>>, input = "干活") => {
  const { layer, seen } = scriptedLlm(script);
  return Effect.gen(function* () {
    const agent = yield* Agent;
    const events: string[] = [];
    const answer = yield* agent.run(input, testSettings, stubTools, (event: AgentEvent) =>
      Effect.sync(() => {
        events.push(event._tag);
      }),
    );
    return { answer, events, seen };
  }).pipe(Effect.provide(agentLayer(layer)));
};

describe("Agent", () => {
  it("模型要求调工具时执行工具,再拿结果继续,直到只回正文", async () => {
    const { answer, events, seen } = await Effect.runPromise(
      collect([toolTurn, [textItem("assistant", "完成")]]),
    );
    expect(answer).toBe("完成");
    expect(events).toEqual(["thinking", "tool_call", "tool_result"]);

    // 第二次调用拿到的是 item 历史:system + user + (reasoning, function_call) + 结果
    const second = seen[1] ?? [];
    expect(second.map((item) => item.type)).toEqual([
      "message",
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    expect(second[4]).toMatchObject({ callId: "call_1", output: 'stub:bash({"command":"ls"})' });
  });

  it("模型调了没提供的工具:错误当观测回填,循环继续", async () => {
    const unknownCall: Item = {
      type: "function_call",
      callId: "call_x",
      name: "nope",
      arguments: "{}",
    };
    const { answer, seen } = await Effect.runPromise(
      collect([[unknownCall], [textItem("assistant", "完成")]]),
    );
    expect(answer).toBe("完成");

    const second = seen[1] ?? [];
    expect(second[3]).toMatchObject({
      type: "function_call_output",
      callId: "call_x",
      output: "错误:未知工具 nope",
    });
  });

  it("思维链先于工具调用发出去", async () => {
    const { events } = await Effect.runPromise(
      collect([toolTurn, [textItem("assistant", "完成")]]),
    );
    expect(events[0]).toBe("thinking");
  });

  it("有工具调用时,正文作为「宣告」在工具之前渲染", async () => {
    const { events } = await Effect.runPromise(
      collect([
        [...toolTurn, textItem("assistant", "我先查一下")],
        [textItem("assistant", "完成")],
      ]),
    );
    expect(events).toEqual(["thinking", "text", "tool_call", "tool_result"]);
  });

  it("一轮到位时直接返回文本,不发 text 事件", async () => {
    const { answer, events } = await Effect.runPromise(
      collect([[textItem("assistant", "你好呀")]], "你好"),
    );
    expect(answer).toBe("你好呀");
    // 最终答复由 repl 打印,不重复发 text 事件
    expect(events).toEqual([]);
  });

  it("模型一直要工具时以最大步数兜底", async () => {
    const { answer } = await Effect.runPromise(collect([toolTurn], "死循环"));
    expect(answer).toContain("已达到最大步数");
  });

  it("空答复不写进历史,且历史里不带思维链", async () => {
    const { layer, seen } = scriptedLlm([[], [textItem("assistant", "ok")]]);

    const { first, second } = await Effect.runPromise(
      Effect.gen(function* () {
        const agent = yield* Agent;
        const first = yield* agent.run("第一轮", testSettings, stubTools);
        const second = yield* agent.run("第二轮", testSettings, stubTools);
        return { first, second };
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    expect(first).toBe("");
    expect(second).toBe("ok");

    // 第二轮看到的历史:system + 第一轮(空答复,只留 user) + 本轮 user
    const history = seen[1] ?? [];
    expect(history.map((item) => item.type)).toEqual(["message", "message", "message"]);
    expect(history.flatMap((item) => (item.type === "message" ? [item.role] : []))).toEqual([
      "system",
      "user",
      "user",
    ]);
    // 历史里绝不出现思维链
    expect(history.some((item) => item.type === "reasoning")).toBe(false);
  });
  it("提示词跟着工具集走:没有工具时明确禁止假装调用(客户端传 tools 为空就是这样)", async () => {
    const { layer, seen } = scriptedLlm([[textItem("assistant", "我没有工具")]]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const agent = yield* Agent;
        return yield* agent.run("读一下 README", testSettings, []);
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    const system = (seen[0] ?? []).flatMap((item) =>
      item.type === "message" && item.role === "system" ? [item.text] : [],
    );
    expect(system).toHaveLength(1);
    expect(system[0]).toContain("没有任何工具可用");
    expect(system[0]).toContain("<tool_call>");
    // 不能宣称能调工具
    expect(system[0]).not.toContain("你可以调用这些工具");
  });

  it("有工具时提示词里点出工具名,并给出调用规则", async () => {
    const { layer, seen } = scriptedLlm([[textItem("assistant", "好了")]]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const agent = yield* Agent;
        return yield* agent.run("干活", testSettings, stubTools);
      }).pipe(Effect.provide(agentLayer(layer))),
    );

    const system = (seen[0] ?? []).flatMap((item) =>
      item.type === "message" && item.role === "system" ? [item.text] : [],
    );
    expect(system[0]).toContain("你可以调用这些工具:bash");
    expect(system[0]).toContain("不要执行破坏性命令");
    expect(system[0]).not.toContain("没有任何工具可用");
  });
});
