# 决策:读侧只暴露 `projection(kind)`,不暴露整份 `restore`

> 已接受 · 2026-10-24 · **补充**:`projection` 还要"指定投影类型"(`kind`);引擎 id 后来被
> [`0072`](0072-drop-engine-id.md) 去掉,`projection` 因此不再接 `engineId` ·
> 取代 [`0058`](0058-archive-projection.md) /
> [`0070`](0070-archive-cache-before-queue.md) 里的 `ArchiveShape.restore` ·
> 落点 `packages/agent/src/archive/` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧)

## 矛盾

`restore` 是"读全部条目 → 折成整份投影"的一步到位接口:

```ts
readonly restore: Effect.Effect<ArchiveProjection>; // { inbox, unused, engines: [...] }
```

而实际的两个读者都只要**自己那一段**:

| 谁     | 要什么                      | 现在得做的事                             |
| ------ | --------------------------- | ---------------------------------------- |
| engine | 当前 engine 的 transcript   | 折全部 → `engines.find(e => e.id === …)` |
| 客户端 | "这一轮到哪了"(按引擎 / 轮) | 同上,再自己筛                            |

于是:

- **接口给的比要的多**:每个读者都写一遍 `find`(还得记住 id 相等怎么比);
- **名字在撒谎**:`restore` 听起来像"恢复会话",其实只是"折一份全量快照";
- **全量投影的成本被藏起来**:调用方以为拿的是一段,实际每次都 O(整份 archive)。

## 处理

读侧改成"要哪一段给哪一段":

```ts
export interface ArchiveShape {
  /** 已接收的全部条目(按发生顺序),只碰内存。 */
  readonly readAll: Effect.Effect<ReadonlyArray<ArchiveEntry>>;
  /** **指定引擎**的投影;`undefined` = 还没有这一段。 */
  readonly projection: (engineId: ArchiveEntryId) => Effect.Effect<ProjectedEngine | undefined>;
}
```

- **还要指定投影类型**:`projection(engineId, kind)`,`kind` 就是 `ProjectedEngine` 的字段名
  (`engine` 整段 / `transcript` / `pendingCallIds` / `phase` / `turns`);
  **全局视图也是同一个读口**:`projection("inbox")` / `projection("unused")`(重载,没有 `engineId`);
- engine 侧变成一句:

  ```ts
  const transcriptOf = (engineId) =>
    archive.projection(engineId, "transcript").pipe(Effect.map((items) => items ?? []));
  ```

- 需要整份状态(inbox / 所有引擎)时用纯函数 `project(entries)`(`readAll` 给条目);
  它本来就导出,对内存数据同样方便;
- 测试改成 `readAll` + `project` 断言 inbox,并断言"不存在的 engineId → `undefined`"。

## 为什么

- **接口对得上需求**:读者要"我这段的状态",接口就给这段,不用再 `find`;
- **"哪一段"成为参数**:多引擎 / 子代理以后各要各的,接口不用再长新方法;
- **成本可见**:`projection(engineId)` 的签名里写着"折一遍再挑",比 `restore` 的"恢复"诚实;
- **少一个概念**:`ArchiveProjection` 退成纯函数 `project` 的返回值,服务面上只有"条目"与"一段"。

## 代价

- **仍然全量折叠**:`projection(engineId)` 内部还是 `project(entries)` 再 `find`,只是把这一步收进
  archive;`O(entries)` 的成本没变(见 0070 复查条件 1)。
- **整份状态要多一步**:想看 inbox + 所有引擎的调用方得自己 `project(readAll)`(或让 archive
  再多一个方法)。
- **`undefined` 的语气**:`projection` 对"还没出现过这段"返回 `undefined`,调用方要处理
  (engine 用 `?? []`);没有报错,也就不会暴露"id 打错"这种问题。
- **多一次 `find` 的重复**:多引擎并发读取时每次都重折,没有共享结果。

## 复查条件

1. **多引擎要同时读**:加 `projectionAll` 或让 `project` 接一个过滤条件(按 engineId / 条目范围),
   不要退回到"服务上有个 `restore` 全量接口"。
2. **`undefined` 掩盖了 id 错误**:改成 `Effect<Option<ProjectedEngine>>` 或让调用方显式传
   "必须存在"的断言;不要在这里抛异常。
3. **整份状态成为主要用法**(客户端列表页之类):在 archive 上加一个同样是内存读的
   `summary`(只要 inbox + 每个引擎的一行摘要),别把 `project` 的全量结果当接口。
4. **投影开始增量**:`projection(engineId)` 内部换成"按 engineId 分段折叠",签名不变。
