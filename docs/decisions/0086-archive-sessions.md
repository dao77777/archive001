# 决策:archive 里加入 session

> 已接受 · 2026-11-10 · 取代 [`0083`](0083-run-turn-top-level-and-session-transcript.md) 的
> 「会话边界 = 层实例」· 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0083 把 transcript 的会话边界挂在**层实例**上:同一个 archive 文件里所有会话混在一起,
只能靠"再建一层、再 resetTranscript"来开新会话。后果:

| 现状                                      | 问题                                              |
| ----------------------------------------- | ------------------------------------------------- |
| entry 没有 session 身份                   | 一个文件里的多条会话无法区分、无法切回            |
| 会话边界 = 层实例                         | 想恢复上一段会话只能重建层;reset 只能丢掉当前这段 |
| `Projection` 只折当前一份                 | 没有"切到某个会话"的读侧                          |
| web reset / 新进程 / CLI 各自解释"新会话" | 行为靠层实例约定,不是 archive 的事实              |

## 处理

- **`SessionId`**:branded 字符串,构造器 `makeSessionId` / `newSessionId`;
  `ArchiveEntry` 增加 `sessionId?: SessionId`。
- **entry 带 session**:
  - `Events.publish` 用 `Archive.currentSession` 给每条事件打标;
  - `Archive.append` 对没有 `sessionId` 的条目补当前会话;
  - 旧文件没有这个字段,`ArchiveRuntime` 读入时归到 `LEGACY_SESSION_ID`。
- **Archive 的会话口子**:
  - `currentSession` / `sessions` / `readSession(id)`;
  - `startSession`:生成新 id、切过去,transcript 从空开始;
  - `useSession(id)`:切到已有会话;没有条目就是空会话。
- **Projection 按 session 折**:
  - 保留 `allEntries`(跨会话);`init` 后默认选中最后一段;
  - `setSession(id)` 清掉当前状态,按 `sessionId` 从 `allEntries` 重折;
  - 删掉 `resetTranscript`(新会话本身就是空 transcript)。
- **默认行为**:
  - `ArchiveRuntime` 启动时回到**最后一段会话**;没有历史就开新会话;
  - web reset:换层后调 `Archive.startSession`;
  - CLI / smoke:每次运行先 `startSession`;
  - REPL:默认续上最后一段。
- **SDK**:`AgentLive` 输出 `Agent | Turn | Archive`,客户端可以直接取 `Archive`。

## 为什么

- **会话成为 archive 的事实**:entry 自带 `sessionId`,读写两侧不用再靠层实例约定;
- **可切回**:`useSession` / `readSession` 让"看以前的会话"成为读侧能力;
- **reset 更轻**:开新会话不需要靠"删文件 / 重建层"来制造空 transcript;
- **CLI / Web / REPL 的语义一致**:新会话用 `startSession`,续会话用默认 / `useSession`。

## 代价

- **entry schema 变大**:每条记录多一个 `sessionId`;旧文件靠 legacy 兼容;
- **投影多存一份 `allEntries`**:切会话要按 session 重折,复杂度 O(会话条目数);
- **默认"回到最后一段"**:CLI 若不想续旧会话,必须显式 `startSession`(已经这么做);
- **会话元数据只有 id**:没有标题 / 创建时间 / 最后活动时间;
- **多客户端并发写同一文件**:session 仍然只按 `sessionId` 分组,跨进程锁 / 冲突检测没做;
- **`AgentLive` 输出面变大**:多了 `Archive`。

## 复查条件

1. **需要会话列表 UI / 标题 / 删除**:加 session 元数据(独立事件或 sidecar),不要只靠 entry 扫描。
2. **会话切换变频繁 / 条目很大**:把 `allEntries` + 重折改成按 session 的增量状态表。
3. **多客户端需要同时写**:文件级锁 / 追加协调 / 每客户端独立 archive,不能只靠 sessionId。
4. **需要"从某条 entry 之后增量读"**:补 `entries(fromLine)` 和按 session 的游标,现在只有一次性 `readAll`。
