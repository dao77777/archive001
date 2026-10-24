import process from "node:process";

// 客户端的表现层小工具:着色、首行、工具参数预览。
// 与领域无关的通用件(错误格式化、截断)在 `@archive001/agent` 里。

/** 只保留前 `n` 行,超出部分注明总行数。 */
export const firstLines = (text: string, n: number): string => {
  const lines = text.split("\n");
  return lines.length <= n ? text : `${lines.slice(0, n).join("\n")}\n…(共 ${lines.length} 行)`;
};

/** 只在真终端上着色;管道 / 重定向 / `NO_COLOR` 时返回纯文本。 */
const colorEnabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

/** 用 ANSI SGR 码包一层(码本身是常量,见 `_constants.ts`)。 */
export const paint = (code: string, text: string): string =>
  colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;

/** 把工具参数的 JSON 压成一行 `key=value …`,便于在终端预览。 */
export const previewArguments = (raw: string, maxChars: number): string => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed)
      .map(([key, value]) => `${key}=${JSON.stringify(value)?.slice(0, maxChars) ?? "null"}`)
      .join(" ");
  } catch {
    return raw.slice(0, maxChars);
  }
};
