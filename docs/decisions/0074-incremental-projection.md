# 决策:投影改成增量折叠(`projectionCache` + 游标)

> 已接受 · 2026-10-24 · 细化 [`0070`](0070-archive-cache-before-queue.md) 的“engine 从 archive 投影” ·
> 落点 `packages/agent/src/archive/archive.ts` + `project.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md)

## 矛盾

0070 之后 engine 每一步都 `projection("transcript")`,而每次投影都是**整份折一遍**:

```ts
projection(kind) = Ref.get(cache).pipe(Effect.map((entries) => project(entries)[kind]));
```

| 代价             | 说明                                                 |
| ---------------- | ---------------------------------------------------- |
| 每步 O(entries)  | 一次会话 N 步 × 条目数 n ⇒ O(N·n),长会话里是 O(n²)   |
| 重复折同样的历史 | 第 k 步读的历史 = 前 k−1 步已经折过的东西,纯重复劳动 |
| 步数越多越慢     | 越到后面每一步越贵,延迟随会话长度增长                |

## 处理

把“折”和“读”拆开,折叠状态与游标留在 archive 里(变量名 `projectionCache`):

```ts
// archive.ts
const archiveCache = yield* Ref.make<ReadonlyArray<ArchiveEntry>>(...); // 已接收条目
const projectionCache = yield* Ref.make({ count: 0, state: createProjectionCache() });
const projectionFold = yield* Semaphore.make(1);                         // 补折互斥

const folded = projectionFold.withPermits(1)(
  Effect.gen(function* () {
    const entries = yield* Ref.get(archiveCache);
    const current = yield* Ref.get(projectionCache);
    if (current.count === entries.length) return current.state;          // 没新条目:直接返回

    const next = advanceProjectionCache(current.state, entries.slice(current.count));
    yield* Ref.set(projectionCache, { count: entries.length, state: next });
    return next;
  }),
);

projection: (kind) => folded.pipe(Effect.map((state) => readProjection(state, kind))),
```

`project.ts` 相应拆成两侧:

| 函数                                                                                                             | 作用                                         |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `createProjectionCache()`                                                                                        | 空状态(inbox 三张表 + 引擎/轮/step 草稿)     |
| `advanceProjectionCache(cache, entries)`                                                                         | 只折**新**条目,就地推进并返回同一个状态      |
| `readInbox` / `readEngines` / `readEngine` / `readTranscript` / `readPendingCallIds` / `readPhase` / `readTurns` | 各状态一个读函数                             |
| `readProjection(cache, kind)`                                                                                    | kind → 读函数(一张 `selectors` 表)           |
| `projectInbox` / `projectEngines` / … / `project`                                                                | 纯函数包装:新建状态 → 折完 → 读(恢复/测试用) |

- 阅读时懒折:`append` 不动,事件线程不为折叠买单;
- 并发安全:一把 `Semaphore(1)`,两个读者同时发现落后只有一个真的折;
- 读出来的数组都 `[...]` 拷贝一份(内部数组还会继续长,不能把引用递出去)。

## 为什么

- **摊还 O(1)**:补折只处理新增条目;首次读 O(n),之后每步 O(增量);
- **一份折叠状态**:inbox 与引擎状态在同一次遍历里推进(之前为了“按状态拆函数”做了两遍遍历);
- **对外形状不变**:`Archive.projection(kind)` 的签名、各 `project*` 纯函数都保留,调用方无感;
- **测试可对照**:纯函数 `project(entries)` 仍在,可以和增量结果对比(新增用例就是这么做的)。

## 代价

- **内存里多一份折叠草稿**(引擎/轮/step + inbox 三张表),与“条目数组”同量级;
- **读时拷贝**:每次读都拷一份目标数组(transcript / turns),O(该段大小),不是真正的 O(1);
- **状态是就地修改的**:`ProjectionCache` 只能由 `advanceProjectionCache` 推进,读侧必须只读 —— 类型上是 `readonly` 字段 + 内部 `Array`,靠约定;
- **游标与缓存要一致**:`count` 由 `Ref` 里的条目长度决定,若以后支持“裁剪 / 重载条目”,两者要一起重置;
- **单实例**:每个 `ArchiveLive` 实例各自折;共享同一文件的多个实例不共享折叠状态。

## 复查条件

1. **读时的数组拷贝成为瓶颈**(transcript 很长、每步都拷):改成“返回不可变快照 + 增量拼接”(持久化数据结构),或让 engine 直接消费流式增量,不要把整段递出去。
2. **要裁剪 / 重载条目**(文件轮转、从某行开始读):`projectionCache` 的 `count` 改成按“条目 id / 序号”记录,并在重载时整体重建。
3. **多引擎**:折叠状态要按引擎分段(现在只有一段,`engine` 单指针);届时 `ProjectionCache` 变成 `Map<engineId, …>`。
4. **折叠规则变了**(transcript 规则、system 状态):`foldEntry` 是唯一实现处,改它即可;但如果旧缓存与新规则不兼容(比如加了新的累计行为),要决定“重建”还是“兼容旧状态”。
