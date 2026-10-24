import type { AgentEvent } from "@archive001/agent";

// Web 客户端的视图模型:把 `AgentEvent` 流折叠成可渲染的块。

export type Block =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "answer"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly args: string;
      readonly output?: string;
    }
  | { readonly kind: "error"; readonly text: string };

/** 事件 → 新块;`tool_result` 回填最近一个同名且还在运行的工具块。 */
export const appendEvent = (blocks: ReadonlyArray<Block>, event: AgentEvent): Block[] => {
  switch (event._tag) {
    case "thinking":
      return [...blocks, { kind: "thinking", text: event.text }];
    case "text":
      return [...blocks, { kind: "text", text: event.text }];
    case "tool_call":
      return [...blocks, { kind: "tool", name: event.name, args: event.arguments }];
    case "tool_result": {
      const index = blocks.findLastIndex(
        (block) => block.kind === "tool" && block.name === event.name && block.output === undefined,
      );
      if (index < 0)
        return [...blocks, { kind: "tool", name: event.name, args: "", output: event.output }];
      return blocks.map((block, i) => (i === index ? { ...block, output: event.output } : block));
    }
  }
};

/** 参数预览:`{"path":"."}` → `path="."` */
export const previewArgs = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    return entries.length === 0
      ? "(无参)"
      : entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  } catch {
    return raw;
  }
};
