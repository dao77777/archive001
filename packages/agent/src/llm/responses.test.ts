import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { Effect, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { Item, LlmDeps, ResolvedSettings, ThinkingLevel } from "./_domain.ts";
import { buildRequestBody, complete, toItems } from "./responses.ts";

/** 设置里带着连接信息:同一份 setttings 就能打不同端点、换不同 key。 */
const settings = (overrides: Partial<ResolvedSettings> = {}): ResolvedSettings => ({
  model: "deepseek-flash",
  thinking: "low",
  apiKey: Redacted.make("test-key"),
  baseUrl: "http://127.0.0.1:1",
  ...overrides,
});

const user: Item = { type: "message", role: "user", text: "你好" };

const call: Item = {
  type: "function_call",
  callId: "call_1",
  name: "bash",
  arguments: '{"command":"ls"}',
};

/** 场景:一轮带工具的回答 + 工具结果。 */
const toolTurn: ReadonlyArray<Item> = [
  { type: "reasoning", text: "想一下" },
  call,
  { type: "function_call_output", callId: "call_1", output: "a.txt" },
];

const body = (items: ReadonlyArray<Item>, thinking: ThinkingLevel = "low") =>
  buildRequestBody({ model: "deepseek-flash", thinking }, items, []);

const inputOf = (built: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> =>
  (built.input ?? []) as ReadonlyArray<Record<string, unknown>>;

const typesOf = (built: Record<string, unknown>): ReadonlyArray<unknown> =>
  inputOf(built).map((item) => item.type);

describe("responses 请求体(item → input,近乎直通)", () => {
  it("用户消息用 input_text", () => {
    expect(inputOf(body([user]))).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
    ]);
  });

  it("系统提示提到顶层 instructions,不进 input", () => {
    const built = body([{ type: "message", role: "system", text: "你是 archive001" }, user]);
    expect(built.instructions).toBe("你是 archive001");
    expect(typesOf(built)).toEqual(["message"]);
  });

  it("assistant 正文用 output_text", () => {
    expect(inputOf(body([{ type: "message", role: "assistant", text: "好的" }]))).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的" }] },
    ]);
  });

  it("工具轮的 item 顺序原样保留:reasoning → function_call → output", () => {
    expect(typesOf(body(toolTurn))).toEqual(["reasoning", "function_call", "function_call_output"]);
  });

  it("function_call 不带 item id,只留 call_id(配对键)", () => {
    expect(inputOf(body([call]))).toEqual([
      { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
    ]);
  });

  it("关思考时不回放 reasoning item", () => {
    expect(typesOf(body(toolTurn, "off"))).toEqual(["function_call", "function_call_output"]);
  });

  it("思维链为空时不编造 reasoning item", () => {
    expect(typesOf(body([{ type: "reasoning", text: "" }, call]))).toEqual(["function_call"]);
  });

  it("工具描述是扁平的(没有 chat/completions 那层 function)", () => {
    const built = buildRequestBody(
      { model: "m", thinking: "low" },
      [user],
      [{ name: "bash", description: "跑命令", parameters: { type: "object" } }],
    );
    expect(built.tools).toEqual([
      { type: "function", name: "bash", description: "跑命令", parameters: { type: "object" } },
    ]);
    expect(built.tool_choice).toBe("auto");
  });

  it("思考档位原样发给 reasoning.effort,off 映射成 none", () => {
    expect(body([user], "low").reasoning).toEqual({ effort: "low" });
    expect(body([user], "high").reasoning).toEqual({ effort: "high" });
    expect(body([user], "max").reasoning).toEqual({ effort: "max" });
    expect(body([user], "off").reasoning).toEqual({ effort: "none" });
    expect(body([user])).not.toHaveProperty("temperature");
  });
});

describe("responses 响应解析(output → item)", () => {
  it("明文 reasoning_text / output_text / function_call 各成一条 item", () => {
    expect(
      toItems([
        { type: "reasoning", content: [{ type: "reasoning_text", text: "我先看目录" }] },
        { type: "message", content: [{ type: "output_text", text: "好的" }] },
        { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
      ]),
    ).toEqual([
      { type: "reasoning", text: "我先看目录" },
      { type: "message", role: "assistant", text: "好的" },
      { type: "function_call", callId: "call_1", name: "bash", arguments: '{"command":"ls"}' },
    ]);
  });

  it("空 reasoning / 空正文不产生 item", () => {
    expect(
      toItems([{ type: "reasoning", content: [{ type: "reasoning_text", text: "" }] }]),
    ).toEqual([]);
    expect(toItems([{ type: "message", content: [{ type: "output_text", text: "" }] }])).toEqual(
      [],
    );
  });

  it("忽略认不出来的 item 类型", () => {
    expect(
      toItems([
        { type: "web_search_call" },
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
      ]),
    ).toEqual([{ type: "message", role: "assistant", text: "ok" }]);
  });
});

describe("responses 适配器(真打 HTTP)", () => {
  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { server, baseUrl: `http://127.0.0.1:${port}` };
  };

  const reply = (payload: unknown) => (req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  };

  const run = (baseUrl: string, items: ReadonlyArray<Item> = [user]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const deps: LlmDeps = { client: yield* HttpClient.HttpClient };
        return yield* Effect.exit(complete(deps, items, [], settings({ baseUrl })));
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

  it("打 /responses,带 Bearer,并把 output items 解析回来", async () => {
    const seen: { url?: string; auth?: string; body: Record<string, unknown> } = { body: {} };
    const { server, baseUrl } = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.body = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "completed",
            output: [
              { type: "reasoning", content: [{ type: "reasoning_text", text: "想过了" }] },
              { type: "message", content: [{ type: "output_text", text: "好" }] },
            ],
          }),
        );
      });
    });

    try {
      const exit = await run(baseUrl);
      expect(seen.url).toBe("/responses");
      expect(seen.auth).toBe("Bearer test-key");
      expect(seen.body).toMatchObject({ model: "deepseek-flash", reasoning: { effort: "low" } });
      expect(exit).toMatchObject({
        _tag: "Success",
        value: [
          { type: "reasoning", text: "想过了" },
          { type: "message", role: "assistant", text: "好" },
        ],
      });
    } finally {
      server.close();
    }
  });

  it("HTTP 200 但 status=incomplete 时也报错(否则会变成静默的空回答)", async () => {
    const { server, baseUrl } = await listen(
      reply({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "x" }] }],
      }),
    );
    try {
      expect(await run(baseUrl)).toMatchObject({ _tag: "Failure" });
    } finally {
      server.close();
    }
  });

  it("HTTP 200 但 status=failed 时也报错", async () => {
    const { server, baseUrl } = await listen(
      reply({ status: "failed", error: { message: "模型不可用" }, output: [] }),
    );
    try {
      expect(await run(baseUrl)).toMatchObject({ _tag: "Failure" });
    } finally {
      server.close();
    }
  });

  it("output 为空、或只有认不出来的 item 时也报错", async () => {
    const empty = await listen(reply({ status: "completed", output: [] }));
    const unknown = await listen(
      reply({ status: "completed", output: [{ type: "web_search_call" }] }),
    );
    try {
      expect(await run(empty.baseUrl)).toMatchObject({ _tag: "Failure" });
      expect(await run(unknown.baseUrl)).toMatchObject({ _tag: "Failure" });
    } finally {
      empty.server.close();
      unknown.server.close();
    }
  });
});
