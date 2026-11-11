# 决策:只留 `ArchiveEntry`,`v` / `seq` / `at` 并入,去掉 `archiveId`

> 已接受 · 2026-10-24 · 细化 [`0031`](0031-async-archive.md)
> (异步队列持久化不变)· 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

之前事实和存储信封是两层:

```ts
interface ArchiveEvent { _tag; id; parentId; payload… }
interface ArchiveEntry {
  v; seq; at; archiveId;
  event: ArchiveEvent;
}
```

- 读一条记录要先看 `entry` 再看 `event`,多一层嵌套;
- `archiveId` 当前只有一个 archive,却让每条记录都背一个重复字段;
- `seq` / `at` 由 worker 分配,导致实时流(ArchiveEvent)和落盘(ArchiveEntry)是两种形状,
  客户端拿到实时事件时没有 `seq/at`。

## 处理

- **只留 `ArchiveEntry`**,把 `v` / `seq` / `at` 直接并进去:
  ```ts
  type ArchiveEntry<T> = {
    v: 1;
    seq: number;
    at: number;
    _tag: T;
    id: string;
    parentId?: string;
  } & ArchivePayloads[T];
  ```
- **去掉 `ArchiveEvent`**:`Agent.events` 直接发 `ArchiveEntry`;
- **去掉 `archiveId`**:当前只有一个 archive,文件固定为
  `~/.local/state/archive001/archive.jsonl`;
- `v / seq / at` 由 `Agent.publish` 在**发实时流和入 archive 队列之前**分配,
  这样实时流与落盘看到的是同一份 Entry;
- `Archive.append(entry)` 只入队;worker 只写行,不再分配 seq/at。

## 为什么

- **一个类型**:事实、实时流、落盘记录都是 `ArchiveEntry`,不再出现两种形状。
- **少一层嵌套**:JSON 一行更扁,读取 / 调试都直接。
- **单 archive 先简单**:没有 `archiveId`,也没有按 id 分文件;需要多 archive 时再加。
- **实时流也有 seq/at**:客户端能直接排序 / 显示时间,不需要等 archive 分配。

## 代价

- **seq 由 Agent 分配,不是 archive 单写者分配**:`loop.ts` 里用进程级计数器,web reset 后不会重复;
  重启时也会从 1 开始,因此 `seq` 不是跨进程 / 跨重启的全序;真正的顺序是文件行顺序。
- **少了一个隔离字段**:以后要多 archive 时,需要加回 `archiveId` 或分文件。
- **`Archive.append` 接收完整 Entry**:调用方必须自己补 `v/seq/at`;archive 不再替它补。
- **worker 更笨**:只写行,不能校验 / 重排 seq。

## 复查条件

1. **需要多 archive / 多进程**:加回 `archiveId`(或在文件名里区分),并让 seq 由单写者分配;
   这会重新引入"实时流没有 seq"的问题,需要重新设计。
2. **seq 冲突成为实际 bug**:把 seq 分配移到 archive 单写者,`append` 返回分配后的 Entry,
   或让实时流使用 `(processId, seq)` 复合键。
3. **需要读取 / 重放**:`ArchiveEntry` 已经是完整记录,直接 `readAll` + `fold` 即可;
   不需要恢复 `ArchiveEvent`。
4. **Entry 太扁导致字段冲突**:把 payload 收进 `payload` 容器;但不要恢复 `event` 嵌套。
