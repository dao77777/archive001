# 决策:`archive/_domain.ts` 并进 `archive.ts`,类型跟着服务走

> 已接受 · 2026-10-24 · **文件划分已被 [`0081`](0081-service-contract-files.md) 取代**(类型仍归 archive,但契约另立文件)· 推翻 [`0073`](0073-archive-types-per-file.md) 对 archive 那部分的拆法 ·
> 落点 `packages/agent/src/archive/archive.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0073 把 archive 的声明按"谁用谁那边"拆开:entry / 事件负载 / 错误 / sink 留在 `_domain.ts`,
投影类型进 `project.ts`。但拆完之后,`_domain.ts` 里**没有一个类型是投影或实现独占的**:

| 声明                                                        | 谁用                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `ArchiveEntry` / `ArchiveEntryPayloads` / `ArchiveEntryTag` | `archive.ts`、`project.ts`、`loop/events.ts`、`loop/loop.ts`、测试 |
| `ArchiveEntryId` + 两个构造器                               | `archive.ts`、`loop/inbox.ts`、`loop/engine.ts`、测试              |
| `ArchiveError` / `ArchiveSinkShape` / `ArchiveSink`         | `archive.ts`、`file-sink.ts`、`memory-sink.ts`、`index.ts`         |

也就是说:**`archive.ts` 是它们唯一的服务侧出处**,`_domain.ts` 只是"服务前面的一个文件夹层"。
代价是每读一次 `archive.ts` 都要多跳一个文件,`import { ArchiveError } from "./_domain.ts"` 还要
自己判断"这不是 archive 本身"。

## 处理

`archive/_domain.ts` 删掉,内容并进 `archive.ts` 的「类型」段,顺序:

```
ArchiveEntryId + makeArchiveEntryId / newArchiveEntryId   (brand 与构造器贴着)
ArchiveEntryPayloads / ArchiveEntryTag / ArchiveEntry
ArchiveError
ArchiveSinkShape / ArchiveSink                             (存储端口)
```

- 外部引用改到 `./archive/archive.ts`:`loop/events.ts`、`loop/engine.ts`、`loop/inbox.ts`、`loop/loop.ts`、
  `archive/file-sink.ts`、`archive/memory-sink.ts`、`archive/project.ts`、各测试、`index.ts`;
- `project.ts` 只从 `archive.ts` 取**类型**(`import type`),运行期依赖仍是单向 `archive.ts → project.ts`。

## 为什么

文件级四段(`常量 / 工具 / 类型 / 服务`)已经给了"声明放哪"的答案:**本服务的类型就在本服务的文件里**。
`_domain.ts` 那层在 archive 上没有任何独立价值——它既不是跨包契约,也不是多服务共享。

## 代价

- `archive.ts` 变成 338 行(其中约 110 行是类型与负载表),文件比之前长;
- 出现了 **type-only 环**:`project.ts` ←类型← `archive.ts` →值→ `project.ts`。TS / ESM 都能处理
  (`import type` 被擦除),但读的人需要知道这条边的方向;
- `_domain.ts` 这个名字在 `docs/decisions/` 的历史记录里仍然出现(0058 / 0063 / 0066 / 0067 / 0073),不改写历史。

## 复查条件

- 若将来 `ArchiveEntry` 要变成跨包契约(例如另一个包只依赖事件而不依赖 archive 实现)→ 再抽出去,
  那时是"对外契约文件",不是"服务前的文件夹层";
- 若 type-only 环造成实际问题(`tsc` 报循环 / 打包工具把服务代码拉进只读用途的包)→ 把类型段重新独立成文件。
