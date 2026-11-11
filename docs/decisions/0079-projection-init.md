# 决策:`Projection` 加 `init`,区分"初始化全量折叠"与"增量入队"

> 已接受 · 2026-10-24 · 细化 [`0077`](0077-projection-service-push.md) / [`0078`](0078-projection-transcript-and-inbox-only.md) 的服务面 ·
> 落点 `packages/agent/src/archive/project.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧)

## 矛盾

构建 `ArchiveLive` 时,先 `sink.read` 拿到整份已有日志,再交给投影。原来这条路上只有一个方法:

```ts
yield * projection.advance(initial); // 只入队,折叠留到第一次 get
```

问题是**两件事共用一个名字**:

| 场景             | 想做的事                           | 用 `advance` 表达是否准确              |
| ---------------- | ---------------------------------- | -------------------------------------- |
| 构建 / 恢复      | 用一整份日志把状态建起来(全量折叠) | ❌ 名字只说"入队",实际什么时候折不可见 |
| `Archive.append` | 把新条目放进待折队列,等下一次读    | ✅ 准确                                |

而 `advance` 的 doc 只能写成"`Archive.append` / 构建时初始加载调用"—— 一个方法,两种调用纪律。

## 处理

`ProjectionShape` 拆成三个方法,各自名字对应一件事:

```ts
readonly init: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void>;   // 重置 + 全量折叠
readonly advance: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void>; // 只入队
readonly get: <K extends keyof Projections>(kind: K) => Effect.Effect<Projections[K]>;
```

- `init` = 五个 `TxRef` 重置 → 把这份日志整份 `foldEntry` → 一次事务提交;
- `ArchiveLive` 构建时改用 `projection.init(initial)`,`append` 之后仍是 `projection.advance(entries)`;
- 因此 `init` 也是**可复用的**:同一实例再 `init` 一份日志,状态就是这一份(有测试钉住);
- 两个测试 helper 的"从零折算一份日志"改用 `init`——它们要的本来就是全量折叠,不是入队。

## 为什么

语义分层:**"建"和"加"不是同一件事**。`init` 表达"这是这份日志的完整状态",所以它守恒地重置;
`advance` 表达"又来了一批",所以它只排队。名字分开之后,调用纪律不用靠注释传达。

## 代价

- 公开面多一个方法(`init` / `advance` / `get`),SDK 使用者要能分清两者的区别;
- 构建时从"懒折"变成"立刻折":启动多一段折叠工作(总量与以前第一次 `get` 相同,只是提前);
- `init` 会重置状态:若将来有人在运行中间调用它,已折的状态会被丢掉——这正是它要表达的语义,
  但也意味着它不该出现在增量路径上。

## 复查条件

- 若出现"同实例换日志但不想重置"的需求 → 那时要的是 `reload` / `merge` 之类的第三语义,不是放宽 `init`;
- 若构建时的全量折叠成为启动瓶颈(日志很长)→ 退回懒折(构建只 `advance`),并把 `init` 留着备用,
  但要重新说明"构建时到底折不折"。
