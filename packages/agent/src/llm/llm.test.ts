import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { Effect, Redacted } from "effect";
import { DEFAULT_SETTINGS } from "./_constants.ts";
import type { Item, LlmSettings, LlmShape } from "./_domain.ts";
import { Llm, LlmLive } from "./llm.ts";
import { resolveSettings } from "./_util.ts";

/**
 * 这个文件只测 `llm.ts` 自己的职责:
 *   ① 默认走哪条 wire(`responses`);② `model` / `thinking` 原样传下去。
 * 两条 wire 的报文形状由 `chat-completions.test.ts` / `responses.test.ts` 负责。
 */

const user: Item = { type: "message", role: "user", text: "你好" };

const settings = (overrides: Partial<LlmSettings> = {}): LlmSettings => ({
  ...DEFAULT_SETTINGS,
  apiKey: Redacted.make("test-key"),
  baseUrl: "http://127.0.0.1:1",
  ...overrides,
});

/** 记录请求、并按 `/responses` 的形状回一个最小响应。 */
const listen = async () => {
  const seen: Array<{ url?: string; auth?: string; body: Record<string, unknown> }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "好" }] }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, seen };
};

/** 跑一段使用 `Llm` 的程序:`LlmLive` 自带 HttpClient,不需要任何外部配置。 */
const withLlm = <A, E>(use: (llm: LlmShape) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* Llm;
      return yield* use(llm);
    }).pipe(Effect.provide(LlmLive)),
  );

describe("缺省值只在服务边界补一次", () => {
  it("只有 apiKey 必填;省掉的项落成缺省值,端点去掉结尾斜杠", () => {
    const minimal = resolveSettings({ apiKey: Redacted.make("k") });
    expect(Redacted.value(minimal.apiKey)).toBe("k");
    expect(minimal.model).toBe("deepseek-flash");
    expect(minimal.thinking).toBe("high");
    expect(minimal.baseUrl).toBe("https://api.deepseek.com");

    const custom = resolveSettings({
      apiKey: Redacted.make("k"),
      model: "deepseek-v4-pro",
      thinking: "off",
      baseUrl: "http://127.0.0.1:1234//",
    });
    expect(custom).toMatchObject({
      model: "deepseek-v4-pro",
      thinking: "off",
      baseUrl: "http://127.0.0.1:1234",
    });
  });
});

describe("Llm 的 wire 选择", () => {
  it("默认走 /responses(调用方无从选择 wire)", async () => {
    const { server, baseUrl, seen } = await listen();
    try {
      const items = await withLlm((llm) => llm.complete([user], [], settings({ baseUrl })));
      expect(seen.map((request) => request.url)).toEqual(["/responses"]);
      expect(seen[0]?.auth).toBe("Bearer test-key");
      expect(items).toMatchObject([{ type: "message", role: "assistant", text: "好" }]);
    } finally {
      server.close();
    }
  });

  it("同一个实例按次换 model / thinking,wire 不变", async () => {
    const { server, baseUrl, seen } = await listen();
    try {
      await withLlm((llm) =>
        Effect.gen(function* () {
          yield* llm.complete([user], [], settings({ baseUrl, model: "m-a", thinking: "max" }));
          return yield* llm.complete(
            [user],
            [],
            settings({ baseUrl, model: "m-b", thinking: "off" }),
          );
        }),
      );
      expect(seen.map((request) => request.url)).toEqual(["/responses", "/responses"]);
      expect(seen[0]?.body).toMatchObject({ model: "m-a", reasoning: { effort: "max" } });
      expect(seen[1]?.body).toMatchObject({ model: "m-b", reasoning: { effort: "none" } });
    } finally {
      server.close();
    }
  });
});
