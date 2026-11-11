# 决策:服务契约单独成文件(`*.service.ts`),实现文件只放实现

> 已接受 · 2026-10-24 · 取代 [`0080`](0080-archive-types-in-service-file.md) 的文件划分 ·
> 落点 `packages/agent/src/archive/` · 设计见 [`../designs/agent/archive.md`](../designs/agent/archive.md#文件)

## 矛盾

0080 把 archive 的类型并进 `archive.ts` 之后,`archive.ts` 变成 338 行:契约(entry 类型 / 错误 / sink /
`ArchiveShape` + Tag)和实现(缓存 / worker / drain / append)混在一份文件里。两类读者的诉求不同:

| 谁                           | 要什么              | 不想要什么               |
| ---------------------------- | ------------------- | ------------------------ |
| 别处(`loop/*`、客户端、测试) | 类型、Tag、服务形状 | 写队列、worker、STM 细节 |
| 改实现的人                   | 实现                | 在契约里翻找             |

而且 `ArchiveSink` 的契约本来就跟 `file-sink.ts` / `memory-sink.ts` 两个实现无关——它属于"端口",不该寄生在
某个实现文件里。

## 处理

三份契约各自独立,实现文件只放实现:

| 文件                              | 放什么                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `archive.service.ts`              | `ArchiveEntryId` + 构造器、`ArchiveEntryPayloads` / `ArchiveEntryTag` / `ArchiveEntry`、`ArchiveError`、`ArchiveShape` + `Archive` |
| `archive-sink.service.ts`         | `ArchiveSinkShape` + `ArchiveSink`                                                                                                 |
| `project.service.ts`              | `InboxProjection` / `Projections`、`ProjectionShape` + `Projection`                                                                |
| `archive.ts`                      | `ArchiveLive`                                                                                                                      |
| `project.ts`                      | `ProjectionLive`                                                                                                                   |
| `file-sink.ts` / `memory-sink.ts` | `ArchiveSink` 的实现                                                                                                               |

- 每份 `*.service.ts` 也套四段结构:常量 / 工具(通常为空占位)、类型、服务;
- `index.ts` 的导出跟着挪:值(Tag)从 `*.service.ts` 出,`*Live` 从实现文件出;
- 依赖方向:`实现文件 → *.service.ts`;**`project.service.ts` 只被 `archive.service.ts` 以 `import type` 引用**
  (`Projections`),运行期没有环。

## 为什么

- **契约是给别人看的,实现是给自己改的**:分开之后"我要用 Archive" 只需要读 148 行契约,不用穿过 worker;
- **端口与实现解除绑定**:`ArchiveSink` 不再属于 `archive.ts`,加第三种 sink 时不用碰写入实现;
- 与四段文件结构天然契合:`*.service.ts` 就是"类型 + 服务"两段,实现文件是"常量 + 工具 + 类型(内部)+ 实现"。

## 代价

- 文件数从 2 个实现文件变成 3 个契约 + 2 个实现:找 `ArchiveShape` 要多记一个文件名;
- `project.service.ts` ↔ `archive.service.ts` 之间有一条 type-only 环(`Projections` / `ArchiveEntry`),`import type` 会擦除;
- `index.ts` 的导出列表比之前长(值、类型分两处来源)。

## 复查条件

- 若某个 `*.service.ts` 只剩下一两个类型、且没人 `import type` 它 → 并回实现文件,不为对称而对称;
- 若 type-only 环在打包 / `tsc --isolatedModules` 下出问题 → 把 `Projections` 挪进 `archive.service.ts`(让环只朝一个方向)。
