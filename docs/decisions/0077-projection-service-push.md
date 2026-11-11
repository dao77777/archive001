# 决策:`Projection` 服务由 archive 推进,读口仍从 `Archive` 暴露

> 已接受 · 2026-10-24 · 取代 [`0076`](0076-projection-on-archive.md)(把折叠状态放回 archive)
> 与 [`0075`](0075-projection-service.md)(投影服务反向依赖 archive)· 落点
> `packages/agent/src/archive/project.ts` + `archive.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧)

## 矛盾

前两版都不顺:

| 版本      | 折叠状态在哪          | 问题                                                 |
| --------- | --------------------- | ---------------------------------------------------- |
| 0074/0076 | `ArchiveLive` 闭包    | 存储层混进读侧状态;`Archive` 反向依赖 `project.ts`   |
| 0075      | `Projection` 服务(拉) | 服务反过来依赖 `Archive` 拿条目;两个服务必须共用实例 |

根源是**方向**:投影需要条目,条目在 archive 手里。拉模型(投影问 archive 要)必然让投影依赖
archive;而"状态放投影服务"又要求 archive 依赖投影 —— 两个方向同时要,只能靠调用方拼装(0075
的 `provideMerge`)。

## 处理

改成**推模型**:`Projection` 只认识条目,不认识存储;`Archive` 依赖它,往里推。

```ts
// project.ts
export interface ProjectionShape {
  /** 把一批新条目折进去(Archive.append / 构建时初始加载调用)。 */
  readonly advance: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void>;
  readonly get: <K extends keyof Projections>(kind: K) => Effect.Effect<Projections[K]>;
  readonly snapshot: Effect.Effect<ArchiveProjection>;
}
export class Projection extends Context.Service<Projection, ProjectionShape>()("Projection") {}
export const ProjectionLive: Layer.Layer<Projection>; // 无依赖,状态就是一条 Ref<ProjectionCache>
```

- `ArchiveLive: Layer<Archive, never, ArchiveSink | Projection>`:
  - 构建时:`sink.read` 的底稿既放进 `archiveCache`,也 `projection.advance(initial)`;
  - `append` 成功后:`Ref.update(archiveCache, …)` 与 `projection.advance(entries)` 一起包进
    `Effect.uninterruptible`(两步都只是内存操作,避免停在"缓存有了、投影没拿到");
- **`advance` 只入队,折叠放在读时**:`Projection` 里是 `state` + `queue` 两条 `Ref`,
  `advance` 把条目接进 `queue`(数组拼接,不折),`get` / `snapshot` 先把 `queue` 折进 `state`
  再读 —— 没人读就不折;补折由一把 `Semaphore(1)` 串起来并包成不可中断(否则会重复折);
- `ArchiveShape.projection(kind)` 仍然在:**转发**给 `Projection.get(kind)`,调用方只装 archive;
- `Projection` / `ProjectionLive` / `ProjectionShape` 也从 SDK 导出(想单独读投影的人可以直接拿);
- 客户端 compose 时多一行 `ArchiveLive.pipe(Layer.provide(ProjectionLive))`。

## 为什么

- **依赖单向且合理**:`Archive → Projection`;投影不知道"条目从哪来、怎么落盘";
- **状态在服务里**:折叠缓存归 `Projection`,存储层只剩"条目缓存";
- **读口不拆**:客户端继续用 `Archive.projection(kind)`,不需要认识两个服务;
- **没有拉模型的过期问题**:不再是"读时发现落后再补折",而是 append 时同步推进,读永远是最新的。

## 代价

- **客户端装配多一层**:所有 compose `ArchiveLive` 的地方都要 `Layer.provide(ProjectionLive)`
  (repl / cli / web 宿主 / 测试);
- **两个缓存可能不同步**:`archiveCache` 与投影状态是两次更新;靠 `Effect.uninterruptible` 包在一起
  避免中断落在中间,但**不是事务**(如果 `advance` 抛缺陷,缓存已更新而投影未推);
- **`advance` 的调用纪律**:只有 `Archive` 该调用;别人乱推会把状态推歪(类型上无法阻止);
- **增量语义靠调用方**:重复推同一批条目会重复折叠(不像 0074 有游标去重);
- **`advance` 变成"攒着"**:待折队列随 append 变长,若一直没人读,内存里会压着这份积压;
  读的那一刻要一次折完(首个读者承担)。

## 复查条件

1. **待折队列涨得比读快**(只写不读的场景):改成"每 N 条或每次 append 就折一次"的混合策略,
   或者干脆让 append 同步折(本决策最初的形态);两者之间只差"折叠时机",状态形状不变。
2. **装配太烦**(每处都要 provide `ProjectionLive`):把 `ProjectionLive` 合进 `ArchiveLive`
   (`ArchiveLive.pipe(Layer.provide(ProjectionLive))`),代价是外部拿不到 `Projection` 服务实例。
3. **投影要按会话隔离 / 多实例**:`ProjectionLive` 变成工厂(按 key 建),`Archive` 的 `advance`
   带上归属;别让一个全局投影服务喂所有 archive。
4. **两个缓存不同步成了真问题**:把"条目缓存 + 折叠状态"合成一条 `Ref`,让 append 一次原子更新两半。
