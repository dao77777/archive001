import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { Item, LlmDeps, ResolvedSettings, ThinkingLevel } from "../_domain.ts";
import { buildRequestBody, complete, toItems, toWireMessages } from "./chat-completions.ts";

/** 设置里带着连接信息:同一份 settings 就能打不同端点、换不同 key。 */
const settings = (overrides: Partial<ResolvedSettings> = {}): ResolvedSettings => ({
  model: "deepseek-flash",
  thinking: "low",
  apiKey: Redacted.make("test-key"),
  baseUrl: "http://127.0.0.1:1",
  ...overrides,
});

const user: Item = { type: "USER_MESSAGE", text: "你好" };

const call: Item = {
  type: "FUNCTION_CALL",
  callId: "call_1",
  name: "bash",
  arguments: '{"command":"ls"}',
};

const messagesOf = (items: ReadonlyArray<Item>, thinking: ThinkingLevel = "low") =>
  toWireMessages(items, thinking);

describe("chat/completions 请求体(item → messages)", () => {
  it("system / user 原样变成消息", () => {
    expect(
      messagesOf([
        { type: "SYSTEM_MESSAGE", text: "你是 archive001" },
        { type: "USER_MESSAGE", text: "你好" },
      ]),
    ).toEqual([
      { role: "system", content: "你是 archive001" },
      { role: "user", content: "你好" },
    ]);
  });

  it("一轮回答折成一条 assistant:思维链 + 正文 + tool_calls", () => {
    expect(
      messagesOf([
        user,
        { type: "REASONING", text: "想一下" },
        { type: "ASSISTANT_MESSAGE", text: "我先查一下" },
        call,
      ]),
    ).toEqual([
      { role: "user", content: "你好" },
      {
        role: "assistant",
        content: "我先查一下",
        reasoning_content: "想一下",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
    ]);
  });

  it("只有工具调用的轮次:content 为 null,但 reasoning_content 必须有(空串)", () => {
    expect(messagesOf([call])).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
    ]);
  });

  it("关思考时不发 reasoning_content", () => {
    expect(messagesOf([call], "off")[0]).not.toHaveProperty("reasoning_content");
  });

  it("只有思维链、没有正文也没有工具调用的轮次整条丢掉(会毒死整个历史)", () => {
    expect(messagesOf([{ type: "REASONING", text: "想了但没说" }])).toEqual([]);
  });

  it("工具结果变成 role=tool 消息", () => {
    expect(
      messagesOf([{ type: "FUNCTION_CALL_OUTPUT", callId: "call_1", output: "a.txt" }]),
    ).toEqual([{ role: "tool", tool_call_id: "call_1", content: "a.txt" }]);
  });

  it("连续多轮不会把工具结果并进上一条 assistant", () => {
    const messages = messagesOf([
      call,
      { type: "FUNCTION_CALL_OUTPUT", callId: "call_1", output: "a" },
      call,
      { type: "FUNCTION_CALL_OUTPUT", callId: "call_1", output: "b" },
    ]);
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
  });
});

describe("chat/completions 请求参数", () => {
  it("开思考:thinking=enabled + reasoning_effort,不带 temperature", () => {
    const body = buildRequestBody({ model: "m", thinking: "max" }, [user], []);
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(body).not.toHaveProperty("temperature");
  });

  it("关思考:thinking=disabled + temperature=0,不带 reasoning_effort", () => {
    const body = buildRequestBody({ model: "m", thinking: "off" }, [user], []);
    expect(body).toMatchObject({ thinking: { type: "disabled" }, temperature: 0 });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("工具定义套上 function 壳", () => {
    const body = buildRequestBody(
      { model: "m", thinking: "low" },
      [user],
      [{ name: "bash", description: "跑命令", parameters: { type: "object" } }],
    );
    expect(body).toMatchObject({
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "bash", description: "跑命令" } }],
    });
  });
});

describe("chat/completions 响应解析(message → item)", () => {
  it("思维链 / 正文 / 工具调用各成一条 item,顺序不变", () => {
    expect(
      toItems({
        content: "答案",
        reasoning_content: "思考",
        tool_calls: [{ id: "call_1", function: { name: "bash", arguments: "{}" } }],
      }),
    ).toEqual([
      { type: "REASONING", text: "思考" },
      { type: "ASSISTANT_MESSAGE", text: "答案" },
      { type: "FUNCTION_CALL", callId: "call_1", name: "bash", arguments: "{}" },
    ]);
  });

  it("空内容 / 空思维链不产生 item", () => {
    expect(toItems({ content: "", reasoning_content: "" })).toEqual([]);
    expect(toItems({ content: "只有正文" })).toEqual([
      { type: "ASSISTANT_MESSAGE", text: "只有正文" },
    ]);
  });

  it("工具参数缺失时兜底成 {}", () => {
    expect(toItems({ tool_calls: [{ id: "call_1", function: { name: "x" } }] })).toEqual([
      { type: "FUNCTION_CALL", callId: "call_1", name: "x", arguments: "{}" },
    ]);
  });
});

describe("chat/completions 适配器(真打 HTTP)", () => {
  it("打 /chat/completions,带 Bearer,并把 reasoning_content 解析回 item", async () => {
    const seen: { url?: string; auth?: string; body: Record<string, unknown> } = { body: {} };
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.body = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "好", reasoning_content: "想过了" } },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const produced = await Effect.runPromise(
        Effect.gen(function* () {
          const deps: LlmDeps = { client: yield* HttpClient.HttpClient };
          return yield* complete(
            deps,
            [user],
            [],
            settings({ baseUrl: `http://127.0.0.1:${port}` }),
          );
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      );

      expect(seen.url).toBe("/chat/completions");
      expect(seen.auth).toBe("Bearer test-key");
      expect(seen.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "enabled" } });
      expect(produced).toEqual([
        { type: "REASONING", text: "想过了" },
        { type: "ASSISTANT_MESSAGE", text: "好" },
      ]);
    } finally {
      server.close();
    }
  });
});
