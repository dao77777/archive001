// 浏览器这一侧只做两件事:把输入 POST 给本地宿主,再把回来的 NDJSON 折成块。
// 模型调用与工具都在宿主里(`src/host/`):浏览器拿不到密钥,也没有 node 能力。

import type { AgentEvent, BehaviorSettings } from "@archive001/agent";
import { useCallback, useEffect, useMemo, useState } from "react";
import { appendEvent, type Block } from "./_util.ts";

/** 宿主自报的状态(密钥在不在、工具能碰哪个目录)。 */
export interface HostState {
  readonly hasKey: boolean;
  readonly cwd: string;
}

/** 事件流里除了 `AgentEvent`,还有两种行:最终答复与错误。 */
type StreamLine =
  | AgentEvent
  | { readonly _tag: "answer"; readonly text: string }
  | { readonly _tag: "error"; readonly text: string };

/**
 * 读 NDJSON:一行一个 JSON 值。
 * ⚠️ 网络分块是任意的,一行可能被切断 —— 所以留着 `buffer` 等下一块。
 */
const readNdjson = async (
  body: ReadableStream<Uint8Array>,
  onValue: (line: StreamLine) => void,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) onValue(JSON.parse(line) as StreamLine);
    }
  }
  if (buffer.trim().length > 0) onValue(JSON.parse(buffer) as StreamLine);
};

export const useAgent = () => {
  const [blocks, setBlocks] = useState<ReadonlyArray<Block>>([]);
  const [running, setRunning] = useState(false);
  const [host, setHost] = useState<HostState | null>(null);

  // 开页:先问一次状态 —— 宿主的响应会种下令牌 cookie(dev 期页面在 Vite 那边,
  // 只有 `/api/*` 经过宿主,握手只能这样);拿到 cookie 之后才能 reset。
  // 于是**刷新 = 新会话**,界面与服务端历史才对得上。
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/state");
        if (response.ok) setHost((await response.json()) as HostState);
        await fetch("/api/reset", { method: "POST" });
      } catch {
        setHost(null);
      }
    })();
  }, []);

  /** 清空会话:界面清块,宿主重开运行时(历史在服务端)。 */
  const reset = useCallback(async () => {
    setBlocks([]);
    try {
      await fetch("/api/reset", { method: "POST" });
    } catch {
      // 宿主没响应就算了:界面已经空了
    }
  }, []);

  const send = useCallback(
    async (input: string, behavior: BehaviorSettings) => {
      const text = input.trim();
      if (text.length === 0 || running) return;

      setBlocks((previous) => [...previous, { kind: "user", text }]);
      setRunning(true);
      try {
        const response = await fetch("/api/turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: text, settings: behavior }),
        });

        if (!response.ok || response.body === null) {
          const detail = await response.text();
          setBlocks((previous) => [
            ...previous,
            { kind: "error", text: `宿主返回 ${response.status}:${detail.slice(0, 400)}` },
          ]);
          return;
        }

        await readNdjson(response.body, (line) => {
          if (line._tag === "answer") {
            setBlocks((previous) => [...previous, { kind: "answer", text: line.text }]);
          } else if (line._tag === "error") {
            setBlocks((previous) => [...previous, { kind: "error", text: line.text }]);
          } else {
            setBlocks((previous) => appendEvent(previous, line));
          }
        });
      } catch (error) {
        setBlocks((previous) => [...previous, { kind: "error", text: String(error) }]);
      } finally {
        setRunning(false);
      }
    },
    [running],
  );

  return useMemo(
    () => ({ blocks, running, host, send, reset }),
    [blocks, running, host, send, reset],
  );
};
