import type { ArchiveEntry } from "@archive001/agent";

// Web 客户端的视图模型:把 `ArchiveEntry` 流折叠成可渲染的块。

export type Block =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "answer"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly args: string;
      readonly output?: string;
    }
  | { readonly kind: "error"; readonly text: string };

/** 事件 → 新块;`tool.call.end` 按 callId 回填对应工具块。生命周期事件不渲染。 */
export const appendEvent = (blocks: ReadonlyArray<Block>, event: ArchiveEntry): Block[] => {
  switch (event._tag) {
    case "REASONING":
      return [...blocks, { kind: "thinking", text: event.text }];
    case "ASSISTANT_MESSAGE":
      return [...blocks, { kind: "text", text: event.text }];
    case "FUNCTION_CALL":
      return [
        ...blocks,
        { kind: "tool", callId: event.callId, name: event.name, args: event.arguments },
      ];
    case "INBOX_OFFER": {
      if (event.message._tag !== "FUNCTION_CALL_OUTPUT") return [...blocks];
      const { callId, output } = event.message.payload;
      const index = blocks.findLastIndex(
        (block) => block.kind === "tool" && block.callId === callId,
      );
      if (index < 0) return [...blocks];
      return blocks.map((block, i) => (i === index ? { ...block, output } : block));
    }
    default:
      // 生命周期 / answer.produced 等由外层处理
      return [...blocks];
  }
};

type OfferedMessage = Extract<ArchiveEntry, { readonly _tag: "INBOX_OFFER" }>["message"];

/**
 * 历史会话 → 渲染块。规则与实时流同构:用户消息从 `INBOX_OFFER` 取正文,
 * 工具步的正文当"宣告",没有工具调用的步骤把正文收成 `answer`。
 */
export const blocksFromEntries = (entries: ReadonlyArray<ArchiveEntry>): Block[] => {
  const offers = new Map<string, OfferedMessage>();
  const blocks: Block[] = [];
  let stepTexts: Array<string> = [];
  let stepHasTool = false;

  const flushTexts = (kind: "text" | "answer"): void => {
    const text = stepTexts.join("");
    stepTexts = [];
    if (text.length > 0) blocks.push({ kind, text });
  };

  const pushError = (text: string): void => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "error" && last.text === text) return;
    blocks.push({ kind: "error", text });
  };

  for (const event of entries) {
    switch (event._tag) {
      case "INBOX_OFFER":
        offers.set(event.message.id, event.message);
        break;
      case "STEP_START":
        stepTexts = [];
        stepHasTool = false;
        break;
      case "USER_MESSAGE": {
        const message = offers.get(event.inboxId);
        if (message?._tag === "USER_MESSAGE") {
          blocks.push({ kind: "user", text: message.payload.text });
        }
        break;
      }
      case "REASONING":
        blocks.push({ kind: "thinking", text: event.text });
        break;
      case "ASSISTANT_MESSAGE":
        stepTexts.push(event.text);
        break;
      case "FUNCTION_CALL":
        flushTexts("text");
        stepHasTool = true;
        blocks.push({
          kind: "tool",
          callId: event.callId,
          name: event.name,
          args: event.arguments,
        });
        break;
      case "FUNCTION_CALL_OUTPUT": {
        const message = offers.get(event.inboxId);
        if (message?._tag !== "FUNCTION_CALL_OUTPUT") break;
        const { callId, output } = message.payload;
        const index = blocks.findLastIndex(
          (block) => block.kind === "tool" && block.callId === callId,
        );
        const block = blocks[index];
        if (index >= 0 && block?.kind === "tool") blocks[index] = { ...block, output };
        break;
      }
      case "STEP_END":
        flushTexts(stepHasTool ? "text" : "answer");
        stepHasTool = false;
        break;
      case "STEP_ERROR":
      case "TURN_ERROR":
      case "ENGINE_ERROR":
        pushError(event.message);
        break;
      default:
        // 生命周期 / system / inbox 引用不渲染
        break;
    }
  }

  return blocks;
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
