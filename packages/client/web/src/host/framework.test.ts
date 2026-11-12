// 框架层的纯判定:回环 Host、同源 Origin、令牌、NDJSON 一行。
// 这些是"安全闸"的全部判据 —— 它们坏了等于后门敞开,所以单独测。

import type { HttpServerRequest } from "effect/http";
import { describe, expect, it } from "vitest";
import { encodeNdjsonLine, hasToken, isLoopbackHost, isSameOrigin } from "./framework.ts";

/** 只造判定用到的字段,别的一概不管。 */
const request = (options: {
  readonly host?: string;
  readonly origin?: string;
  readonly cookies?: Readonly<Record<string, string>>;
}): HttpServerRequest.HttpServerRequest =>
  ({
    headers: {
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    cookies: options.cookies ?? {},
  }) as unknown as HttpServerRequest.HttpServerRequest;

describe("回环 Host", () => {
  it("认得三种回环写法(含端口与 IPv6)", () => {
    for (const host of ["127.0.0.1", "127.0.0.1:5180", "localhost:5173", "[::1]:80"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("挡住外部域名与缺失的 Host", () => {
    for (const host of [undefined, "example.com", "0.0.0.0:5180", "127.0.0.1.evil.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("同源 Origin", () => {
  it("没有 Origin(脚本 / 同源 GET)放行", () => {
    expect(isSameOrigin(request({ host: "127.0.0.1:5180" }))).toBe(true);
  });

  it("Origin 与 Host 一致才放行", () => {
    expect(isSameOrigin(request({ host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" }))).toBe(
      true,
    );
    expect(isSameOrigin(request({ host: "localhost:5173", origin: "http://localhost:5173" }))).toBe(
      true,
    );
  });

  it("别的站点、以及解析不了的 Origin 一律拒绝", () => {
    expect(isSameOrigin(request({ host: "127.0.0.1:5180", origin: "http://evil.com" }))).toBe(
      false,
    );
    expect(isSameOrigin(request({ host: "127.0.0.1:5180", origin: "not a url" }))).toBe(false);
  });
});

describe("令牌", () => {
  const name = "t";
  it("只有同名同值才算", () => {
    expect(hasToken(request({ cookies: { [name]: "abc" } }), name, "abc")).toBe(true);
    expect(hasToken(request({ cookies: { [name]: "abc" } }), name, "abd")).toBe(false);
    expect(hasToken(request({ cookies: {} }), name, "abc")).toBe(false);
  });
});

describe("NDJSON", () => {
  it("一行一个 JSON,带换行", () => {
    const text = new TextDecoder().decode(encodeNdjsonLine({ _tag: "ANSWER", text: "好" }));
    expect(text).toBe('{"_tag":"ANSWER","text":"好"}\n');
    expect(text.split("\n")).toHaveLength(2);
  });
});
