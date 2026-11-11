# 决策:archive 的 `_domain` 只留公用类型,`_constants` 删掉

> 已接受 · 2026-10-24 · 落实 [`0063`](0063-domain-per-file.md) 的判据 ·
> 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

`archive/_domain.ts` 里混着三类东西,`archive/_constants.ts` 更是一个只服务单文件的常量表:

| 位置                   | 里面有什么                                                             | 真实使用方                           |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `_domain.ts`（前段）   | `ArchiveEntryId` / 事件负载 / `ArchiveEntry` / 错误 / sink 契约        | 多处（archive / sinks / loop / SDK） |
| `_domain.ts`（读侧段） | `Projected*` / `EnginePhase` / `InboxProjection` / `ArchiveProjection` | `project.ts`（生产）+ SDK 导出       |
| `_domain.ts`（服务段） | `Projections` / `ArchiveShape`                                         | `archive.ts`（唯一实现）             |
| `_constants.ts`        | `SINK_BATCH_MAX` / 重试策略                                            | `archive.ts`（唯一使用）             |

后果和 0063 当时一模一样:读投影要跳到 `_domain`,读服务形状也要跳过去,而它们的主人就在隔壁;
常量表只为一份实现存在,却占了一个"公共"位置。

## 处理

按"归谁"再分一次:

| 现在在哪        | 内容                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_domain.ts`    | `ArchiveEntryId`(+ `makeArchiveEntryId` / `newArchiveEntryId`)、事件负载、`ArchiveEntry`、`ArchiveError`、`ArchiveSinkShape` / `ArchiveSink`                            |
| `project.ts`    | `ProjectedError` / `ProjectedStep*` / `ProjectedTurn` / `EnginePhase` / `ProjectedEngine` / `InboxProjection` / `ArchiveProjection` / `Projections` / `projection` 派发 |
| `archive.ts`    | `ArchiveShape` + 批量上限与重试策略常量(常量只有它用)                                                                                                                   |
| `_constants.ts` | **删除**                                                                                                                                                                |

- `index.ts` 的导出按来源拆开:entry / sink / error 来自 `_domain`,投影类型(含 `Projections`)来自
  `project.ts`,`ArchiveShape` 来自 `archive.ts`;
- `project.ts` 自己维护 `offered` 映射,不再依赖 `_domain` 里的任何读侧声明。

## 为什么

- **判据一致**:一个文件用的东西放回那个文件,`_domain` 变成"entry 与存储契约"这一件事;
- **读侧类型跟着读侧实现**:`ProjectedEngine` 是 `project.ts` 的返回值,读实现时不用再跳文件;
- **服务形状跟着服务**:`ArchiveShape` 与 `ArchiveLive` 同屏,改接口时只有一处;
- **常量表消失**:批量上限 / 重试策略只服务一个文件,`_constants.ts` 只是形式;

## 代价

- **`project.ts` 变长**:实现 + 结果类型在一个文件(约 400 行);
- **`_domain.ts` 的定位变窄**:只剩"entry / sink / error",以后想找"读侧类型"要先知道去 `project.ts`;
- **SDK 导出分散在三处**:`index.ts` 里 archive 相关的导出分成三段,读起来比一段长;
- **一次性迁移成本**:`index.ts` 与 import 路径都要对一遍来源。

## 复查条件

1. **`_domain.ts` 只剩 sink 一处**:把 sink 契约并进 `archive.ts`(或 sinks 侧),直接删掉 `_domain.ts`;
   不要为了"目录对称"留空壳。
2. **`project.ts` 继续变大**(超过 500 行 / 出现第二类投影):按"inbox 视图 / 引擎段"拆成两个文件,
   类型跟着各自的实现走。
3. **出现第二个使用常量的地方**(比如给 sink 加超时、给客户端暴露批量上限):把常量提到
   `_constants.ts` 并注明"至少两处用";单个文件用的常量不要再抽出去。
4. **SDK 导出散乱影响使用**:在 `index.ts` 里按"服务 / 读侧 / 条目"分组加注释,不要合并成一条大导出。
