# 决策:archive 按会话分文件,sink 调用方不再知道路径

> 已接受 · 2026-11-12 · 所属设计 [`../designs/agent/archive.md`](../designs/agent/archive.md)
> 落点 `packages/agent/src/archive/sink/file.ts`、`packages/agent/src/live.ts`

## 矛盾

原来所有条目写进**同一个** `~/.local/state/archive001/archive.jsonl`,而路径是 `live.ts` 的模块常量,
再当参数传给 `FileSinkLive(ARCHIVE_FILE)`。两个问题:

| 问题                    | 后果                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 路径是**装配层**的决定  | 换个存储位置要改 `live.ts`;`Sink` 的调用方被迫知道"文件在哪",而它其实只需要 `read` / `write`                            |
| 单文件 + 单 writer 假设 | 一个进程同时活着两套实例(多 agent / 子 agent)时,两个 sink 追加同一文件、各自缓存 → 行交错、重启后读到的历史取决于谁先写 |

另外 `sessionId` 早就是条目上的字段(`0086`),但文件层面完全没用上 —— 所有会话挤一个文件,
`read` 要读全量才能知道有哪些会话。

## 处理

1. **路径下沉到 `file.ts`**:`ARCHIVE_DIR = ~/.local/state/archive001/sessions` 是文件内的常量;
   `FileSinkLive` 不再收参数,`live.ts` 里那行变成 `Layer.provide(FileSinkLive)`。
   `Sink` 契约不变:仍然只有 `read` / `write`。
2. **一个会话一个文件**:`write` 把一批条目按 `sessionId` 分组,各自 `append` 到 `<会话>.jsonl`
   (每次开→写→关,句柄跟着 scope 走,不攒 fd)。
3. **文件名安全**:会话 id 来自浏览器(`/api/sessions/open` 的 `id`),只保留 `[A-Za-z0-9_-]`;
   被改动过的再拼 8 位 sha256 前缀 —— 否则 `../../etc/x` 能写出目录,`a/b` 与 `a_b` 会撞名。
4. **读侧**:只读 `sessions/` 下的每个 `*.jsonl`,各自 `parseEntries` 后按 `at` **稳定**排序。
5. **不兼容旧格式**:`LEGACY_SESSION_ID` 与"缺 `sessionId` 就归到 legacy"的逻辑全部删除。
   - 进 sink 的条目没有 `sessionId` → `ArchiveError`(不猜文件),归档层视为 writer 失败;
   - 投影收到没有 `sessionId` 的条目 → 抛错(进投影的条目一定已被 `Archive.append` 打标);
   - 分发之前的历史数据(`archive.jsonl`、更早的 `archives/`、旧 `sessions/*.jsonl`)已删除。

## 为什么

- **调用方只认契约**:`ArchiveLive` 不需要知道"文件 / 内存 / 远端",更不需要知道路径;
  换存储只换 `Sink` 实现。
- **会话是天然的切分键**:它已经在条目上,`sessions` / `readSession` 也按它分组;
  一个会话一个文件让"读某个会话"将来可以只读一个文件,而不是全量。
- **多实例不再直接互踩**:同一个会话仍只有一个 writer(进程内单 sink),不同会话落在不同文件;
  为后续"多 agent"去掉了一个硬障碍。
- **不猜**:缺 `sessionId` 的条目宁可失败,也不写进某个"兜底会话"—— 那种兜底会让坏数据悄悄留在盘上。

## 代价

- **跨会话顺序靠 `at` 重建**:同一毫秒内的跨会话先后不确定(稳定排序只保证同一会话内不乱)。
  `ArchiveRuntime` 用"最后一条"选默认会话,所以这个不确定性会体现在"重启后默认打开哪段会话"上(极罕见)。
- **一次写要开 N 次文件**:批量里跨 k 个会话就 open/write/close k 次;换来的是不攒 fd、不共享句柄。
- **文件名不再是 id 原文**:异常 id 会变成 `<截断>-<哈希>.jsonl`,人要按文件名找回会话得先跑一遍哈希规则。
- **旧历史不可见**:分文件之前的数据已删除,没有迁移脚本;要找回只能靠备份。
- `FileSinkAt(dir)` 是**测试专用**导出;它让"路径固定"这条在测试里开了个口子,需要靠命名与注释守住。

## 复查条件

1. **条目量到几十万行 / 启动变慢** → `read` 改为懒加载:只列目录拿到会话 id,真正读内容放到
   `readSession`(`Archive` 已有这个方法);那时 `sink.read` 可以退化成"读元数据"。
2. **真要做多 agent 并发** → 每套实例一个目录(`FileSinkAt(agentDir)`)或把 `ARCHIVE_DIR` 变成
   `AgentConfig` 的一项;本次"路径固定在 file.ts"是刻意的让步,到期就该反悔。
3. **要接纳旧格式**(例如从别处导入)→ 写一次性迁移工具(读旧文件 → 按会话写入新目录),
   不要往读取路径里加兼容分支。
4. **`at` 出现同毫秒跨会话乱序导致选错默认会话** → 给条目加回单调序号,或在 `read` 里按
   `(at, 文件名)` 双键排序 —— 后者只解决确定性,不解决"真实顺序"。
