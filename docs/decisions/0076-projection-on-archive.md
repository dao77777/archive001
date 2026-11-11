# 决策:投影读口放回 `Archive.projection(kind)`,不单独成服务

> 已接受 · 2026-10-24 · **已被 [`0077`](0077-projection-service-push.md) 取代**(投影仍是服务,由 archive 推进;
> 折叠状态回到 `Projection` 服务里)· 取代 [`0075`](0075-projection-service.md) ·
> 落点 `packages/agent/src/archive/archive.ts` + `project.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧)

## 矛盾

0075 把投影独立成 `Projection` 服务,`ProjectionLive` 依赖 `Archive`。用了半天发现:

| 问题                          | 说明                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| 多一层服务                    | `AgentLive` 要多 provide 一层;客户端想读投影还得自己装 `ProjectionLive`        |
| 两个服务绑在一起              | 投影必须与 `Archive` 用**同一个**实例,测试里得 `Layer.provideMerge` 才不串数据 |
| 读口被拆成两处                | 条目靠 `Archive.readAll`、投影靠 `Projection.get`,调用方要看两个服务           |
| 折叠本质是 archive 的派生状态 | 它的输入(`archiveCache`)本来就在 `ArchiveLive` 里                              |

## 处理

回到"archive 提供读口",`project.ts` 只留实现(纯函数):

- `ArchiveShape` 重新带 `projection(kind)`:

  ```ts
  readonly projection: <K extends keyof Projections>(kind: K) => Effect.Effect<Projections[K]>;
  ```

- 折叠缓存(`projectionCache` = `{ count, state }`)与补折互斥(`Semaphore(1)`)放回 `ArchiveLive`
  的闭包,和 `archiveCache` 并排;`projection(kind)` = 补折 → `readProjection`;
- `project.ts` 不再有服务 / Layer:只导出类型、`createProjectionCache` / `advanceProjectionCache` /
  `read*` / `project*`(纯函数);
- engine 回到 `archive.projection("transcript")`,依赖 `Archive`;
- `index.ts` 去掉 `Projection` / `ProjectionLive` / `ProjectionShape`。

## 为什么

- **读口只有一个**:`Archive` 既给条目(`readAll`)又给派生状态(`projection`),调用方只装一个服务;
- **状态归属正确**:折叠缓存的输入就是 archive 的条目缓存,放同一个闭包最省一次跳转;
- **装配更短**:`AgentLive` 少 provide 一层,测试也不用 `provideMerge` 保证实例一致;
- **实现仍在 `project.ts`**:折叠规则、读函数、类型都不动,只是"谁持有缓存 / 谁暴露方法"变了。

## 代价

- **`ArchiveLive` 又多两份状态**:条目缓存 + 折叠缓存(+ 锁);存储层确实混进了"读侧"的状态,
  0075 想解决的那半件事又回去了;
- **`archive.ts` 依赖 `project.ts`**:两个文件互相引用(单向:`archive.ts` → `project.ts`);
- **`project.ts` 不再是"独立可用的读侧模块"**:想只用纯函数没问题,但"增量读"必须经由 archive;
- **API 面回到"一个服务两个方法"**:以后若想把读侧拆出去(比如单独的 read replica),要再拆一次。

## 复查条件

1. **需要多个读副本 / 投影按会话隔离**(比如 web 宿主给每个会话单独折):再把投影拆成服务,
   但用"传入 `readAll` 函数"而不是整个 `Archive` 服务,避免实例耦合(0075 的代价)。
2. **`ArchiveLive` 的状态过多**(条目 + 折叠 + 游标 + 锁 > 4 份):按职责拆 `ArchiveStorage` /
   `ArchiveProjection` 两个 layer,但 `Archive` 仍同时暴露两个读口。
3. **纯函数读侧要独立发布**(别的进程只想要 `project`):把它挪到独立包 / 子路径导出,
   不要让服务边界跟着它走。
