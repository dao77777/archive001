# 决策:投影独立成 `Projection` 服务(`project.ts` 自持折叠缓存)

> 已接受 · 2026-10-24 · **已被 [`0076`](0076-projection-on-archive.md) 取代**(投影不再单独成服务,
> 读口回到 `Archive.projection(kind)`,折叠缓存也放回 `archive.ts`)· 承接 [`0074`](0074-incremental-projection.md) 的"增量折叠" ·
> 落点 `packages/agent/src/archive/project.ts` ·
> 设计见 [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧)

## 矛盾

0074 把折叠缓存(`projectionCache` + 互斥锁)放在了 `archive.ts` 里,`ArchiveShape` 因此长出
`projection(kind)`,而**折叠规则、读函数、类型全在 `project.ts`**:

| 问题               | 说明                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| 存储层混进读侧状态 | `ArchiveLive` 里同时管"条目缓存"和"折叠缓存 + 游标 + 锁"               |
| 服务边界按实现切   | `Archive.projection` 的实现其实是"调 `project.ts` 的纯函数",形同转发   |
| 两套缓存挤在一处   | `archiveCache` 与 `projectionCache` 在同一个闭包,读代码要来回跳        |
| `Archive` 依赖读侧 | `archive.ts` 反过来 import `project.ts`,而 `project.ts` 又需要条目来源 |

## 处理

`project.ts` 变成一个服务,自持折叠缓存:

```ts
export interface ProjectionShape {
  /** 取一类投影(只折新增的条目):全局 queue / staged,或当前引擎的字段。 */
  readonly get: <K extends keyof Projections>(kind: K) => Effect.Effect<Projections[K]>;
  /** 整份投影:inbox 视图 + 所有引擎段。 */
  readonly snapshot: Effect.Effect<ArchiveProjection>;
}

export class Projection extends Context.Service<Projection, ProjectionShape>()("Projection") {}

export const ProjectionLive: Layer.Layer<Projection, never, Archive> = ...;
```

- `ProjectionLive` 依赖 `Archive`,靠 `Archive.readAll`(内存)拿条目 —— 依赖方向单向:
  `Projection → Archive`,而 `archive.ts` 不再 import `project.ts`;
- `ArchiveShape` 回到只有 `append` / `errors` / `readAll`(纯存储);
- engine 改成依赖 `Projection`:`transcriptOf = projection.get("transcript")`;
  `AgentLive` 的 provide 链多一层 `ProjectionLive`;
- 读侧的类型、投影函数、`projectionCache`(游标 + 状态)、互斥锁全部在 `project.ts`。

## 为什么

- **一个服务一件事**:`Archive` 管"条目怎么进来、怎么落盘",`Projection` 管"怎么折、折到哪了";
- **依赖方向干净**:`Projection → Archive` 单向,存储层不再知道"投影"这个词;
- **状态与规则同处**:折叠缓存和 `foldEntry` / `read*` 在同一个文件,改规则时只改一处;
- **对外形状不变**:`get(kind)` / `snapshot` 与原来的 `projection(kind)` / `project(entries)` 一一对应。

## 代价

- **多一层服务与装配**:`AgentLive` 多 provide 一个 `ProjectionLive`;单独用 archive 时想取投影要自己装;
- **投影实例与 archive 实例绑定**:测试里必须让两者共用同一个 `Archive`(`Layer.provideMerge`),
  否则投影读的是另一个实例的条目;
- **`project.ts` 变重**:纯函数 + 折叠状态 + 服务,一个文件约 550 行;
- **命名相邻**:类型 `Projections`(kind → 结果)与类 `Projection`(服务)只差一个 s,读 import 时容易看岔。

## 复查条件

1. **投影服务要按需配置**(TTL / 容量 / 只折某些 kind):`ProjectionLive` 改成工厂
   (`ProjectionLive(options)`),`ProjectionsShape` 加对应的读口。
2. **多个 archive 实例共享一个投影**:`ProjectionLive` 的 key 改成"按 archive id",
   或让 `Projection` 接收 `readAll` 函数而不是整个 `Archive` 服务。
3. **`project.ts` 继续膨胀**:拆成 `project/fold.ts`(折)+ `project/read.ts`(读)+ `project/service.ts`,
   服务只做装配;不要退回把缓存放 archive。
4. **命名混淆成真问题**(`Projections` vs `Projection`):把 kind 表改名 `ProjectionKinds`,服务留 `Projection`。
