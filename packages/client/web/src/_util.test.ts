import { describe, expect, it } from "vitest";
import type { ArchiveEntry, ArchiveEntryId } from "@archive001/agent";
import { blocksFromEntries } from "./_util.ts";

const id = (value: string) => value as ArchiveEntryId;

/** 历史会话:用户消息从 INBOX_OFFER 取正文,工具步按 callId 回填。 */
describe("blocksFromEntries", () => {
  it("纯问答:用户消息 + 最后一步的 answer", () => {
    const entries: ReadonlyArray<ArchiveEntry> = [
      {
        v: 1,
        at: 1,
        _tag: "INBOX_OFFER",
        id: id("o1"),
        message: { _tag: "USER_MESSAGE", id: "p1", payload: { text: "问题" } },
      },
      { v: 1, at: 2, _tag: "TURN_START", id: id("turn") },
      { v: 1, at: 3, _tag: "STEP_START", id: id("step"), parentId: id("turn") },
      {
        v: 1,
        at: 4,
        _tag: "USER_MESSAGE",
        id: id("u1"),
        parentId: id("step"),
        inboxId: "p1",
      },
      { v: 1, at: 5, _tag: "ASSISTANT_MESSAGE", id: id("a1"), parentId: id("step"), text: "答" },
      { v: 1, at: 6, _tag: "STEP_END", id: id("step"), parentId: id("turn") },
      { v: 1, at: 7, _tag: "TURN_END", id: id("turn") },
    ];

    expect(blocksFromEntries(entries)).toEqual([
      { kind: "user", text: "问题" },
      { kind: "answer", text: "答" },
    ]);
  });

  it("工具步:正文是宣告,输出回填到对应 callId", () => {
    const entries: ReadonlyArray<ArchiveEntry> = [
      {
        v: 1,
        at: 1,
        _tag: "INBOX_OFFER",
        id: id("o1"),
        message: { _tag: "USER_MESSAGE", id: "p1", payload: { text: "看看" } },
      },
      { v: 1, at: 2, _tag: "STEP_START", id: id("s1") },
      {
        v: 1,
        at: 3,
        _tag: "FUNCTION_CALL",
        id: id("c1"),
        parentId: id("s1"),
        callId: "call_1",
        name: "bash",
        arguments: '{"command":"ls"}',
      },
      {
        v: 1,
        at: 4,
        _tag: "INBOX_OFFER",
        id: id("o2"),
        message: {
          _tag: "FUNCTION_CALL_OUTPUT",
          id: "r1",
          payload: { callId: "call_1", name: "bash", output: "ok" },
        },
      },
      { v: 1, at: 5, _tag: "STEP_END", id: id("s1") },
      { v: 1, at: 6, _tag: "STEP_START", id: id("s2") },
      {
        v: 1,
        at: 7,
        _tag: "FUNCTION_CALL_OUTPUT",
        id: id("rout"),
        parentId: id("s2"),
        inboxId: "r1",
      },
      { v: 1, at: 8, _tag: "ASSISTANT_MESSAGE", id: id("a1"), parentId: id("s2"), text: "完成" },
      { v: 1, at: 9, _tag: "STEP_END", id: id("s2") },
    ];

    expect(blocksFromEntries(entries)).toEqual([
      { kind: "tool", callId: "call_1", name: "bash", args: '{"command":"ls"}', output: "ok" },
      { kind: "answer", text: "完成" },
    ]);
  });
});
