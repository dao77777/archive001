// 浏览器这一侧只做两件事:把输入 POST 给本地宿主,再把回来的 NDJSON 折成块。
// 模型调用与工具都在宿主里(`src/host/`):浏览器拿不到密钥,也没有 node 能力。
// 会话列表 / 历史也由宿主读 archive,这里只负责取和画。

import type { ArchiveEntry, BehaviorSettings } from "@archive001/agent";
import { useCallback, useEffect, useMemo, useState } from "react";
import { appendEvent, blocksFromEntries, type Block } from "./_util.ts";

/** 宿主自报的状态(密钥在不在、工具能碰哪个目录)。 */
export interface HostState {
  readonly hasKey: boolean;
  readonly cwd: string;
}

/** 会话列表的一行(与 `src/host/session.ts` 的 `SessionSummary` 对齐)。 */
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly at: number;
  readonly entries: number;
  readonly current: boolean;
}

interface SessionList {
  readonly current: string;
  readonly sessions: ReadonlyArray<SessionSummary>;
}

interface OpenSessionResult {
  readonly ok: boolean;
  readonly id: string;
  readonly entries: ReadonlyArray<ArchiveEntry>;
}

/** 事件流里除了 `ArchiveEntry`,还有两种行:最终答复与错误。 */
type StreamLine =
  | ArchiveEntry
  | { readonly _tag: "ANSWER"; readonly text: string }
  | { readonly _tag: "ERROR"; readonly text: string };

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

  while (true) {
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
  const [sessions, setSessions] = useState<ReadonlyArray<SessionSummary>>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);

  /** 重新读会话列表。 */
  const refreshSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) return;
      const data = (await response.json()) as SessionList;
      setSessions(data.sessions);
      setCurrentSession(data.current);
    } catch {
      // 宿主没响应:保留上一次列表
    }
  }, []);

  /** 开页:先问状态拿 cookie;有会话就打开当前会话,否则开一段新的。 */
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/state");
        if (response.ok) setHost((await response.json()) as HostState);

        const listResponse = await fetch("/api/sessions");
        const list = listResponse.ok ? ((await listResponse.json()) as SessionList) : null;
        const target = list?.current ?? list?.sessions[0]?.id;

        if (target !== undefined) {
          const opened = await fetch("/api/sessions/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: target }),
          });
          if (opened.ok) {
            const data = (await opened.json()) as OpenSessionResult;
            setBlocks(blocksFromEntries(data.entries));
            setCurrentSession(data.id);
          }
        } else {
          await fetch("/api/reset", { method: "POST" });
        }
        await refreshSessions();
      } catch {
        setHost(null);
      }
    })();
  }, [refreshSessions]);

  /** 切到已有会话:宿主会切 archive 的当前会话,再把历史条目发回来。 */
  const openSession = useCallback(
    async (id: string) => {
      if (running) return;
      try {
        const response = await fetch("/api/sessions/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!response.ok) {
          const detail = await response.text();
          setBlocks((previous) => [
            ...previous,
            { kind: "error", text: `打开会话失败 ${response.status}:${detail.slice(0, 400)}` },
          ]);
          return;
        }
        const data = (await response.json()) as OpenSessionResult;
        setBlocks(blocksFromEntries(data.entries));
        setCurrentSession(data.id);
        await refreshSessions();
      } catch (error) {
        setBlocks((previous) => [...previous, { kind: "error", text: String(error) }]);
      }
    },
    [refreshSessions, running],
  );

  /** 开新会话:界面清空,宿主换一套运行时并 `Archive.startSession`。 */
  const newSession = useCallback(async () => {
    if (running) return;
    setBlocks([]);
    try {
      const response = await fetch("/api/reset", { method: "POST" });
      if (response.ok) {
        const data = (await response.json()) as { readonly id: string };
        setCurrentSession(data.id);
      }
      await refreshSessions();
    } catch {
      // 宿主没响应就算了:界面已经空了
    }
  }, [refreshSessions, running]);

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
          if (line._tag === "ANSWER") {
            setBlocks((previous) => [...previous, { kind: "answer", text: line.text }]);
          } else if (line._tag === "ERROR") {
            setBlocks((previous) => [...previous, { kind: "error", text: line.text }]);
          } else {
            setBlocks((previous) => appendEvent(previous, line));
          }
        });
      } catch (error) {
        setBlocks((previous) => [...previous, { kind: "error", text: String(error) }]);
      } finally {
        setRunning(false);
        // 标题 / 最后活动时间会变
        await refreshSessions();
      }
    },
    [refreshSessions, running],
  );

  return useMemo(
    () => ({
      blocks,
      running,
      host,
      sessions,
      currentSession,
      send,
      openSession,
      newSession,
    }),
    [blocks, running, host, sessions, currentSession, send, openSession, newSession],
  );
};
