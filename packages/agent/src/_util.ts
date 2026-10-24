// agent 包内与领域无关的小工具:错误格式化、截断。
// 表现层的小工具(着色、首行、参数预览)在客户端包里。

/** 把任意抛出的东西变成一行可读文案。 */
export const formatError = (u: unknown): string => {
  if (u instanceof Error) return u.message;
  if (typeof u === "object" && u !== null) {
    const tagged = u as { _tag?: unknown; message?: unknown };
    if (typeof tagged.message === "string") return tagged.message;
    if (typeof tagged._tag === "string") return tagged._tag;
  }
  return String(u);
};

/** 截断到 `limit` 个字符,并注明原始长度。 */
export const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n...[已截断,共 ${text.length} 字符]`;
