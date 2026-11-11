# 决策:投影先只做 `transcript` 与 `inbox`,其余状态不做

> 已接受 · 2026-10-24 · 收窄 [`0058`](0058-archive-projection.md) / [`0071`](0071-archive-projection-by-engine.md) /
> [`0074`](0074-incremental-projection.md) / [`0077`](0077-projection-service-push.md) 的投影面 ·
> 落点 `packages/agent/src/archive/project.ts` · 设计见
> [`../designs/agent/archive.md`](../designs/agent/archive.md#能从-archive-恢复什么读侧)
> **`ENGINE_START` 清空 transcript 的规则已被 [`0083`](0083-run-turn-top-level-and-session-transcript.md)
> 取代**:transcript 按会话(层实例)保留,`Projection.resetTranscript` 才是边界。

## 矛盾

投影面一路加到七类:`queue` / `staged` / `engine` / `transcript` / `pendingCallIds` / `phase` / `turns`。
但**真正的消费者只有一个** —— 引擎每步要的是 `transcript`;调试时要的是 inbox 视图。其余:

| 状态              | 谁在读                   | 现在有没有用                      |
| ----------------- | ------------------------ | --------------------------------- |
| `engine` 整段     | 测试、文档示例           | 没有客户端读                      |
| `pendingCallIds`  | 无(inbox 自己就管"等谁") | 引擎用 `dispatchedCalls` 本地状态 |
| `phase`           | 无                       | 引擎自己知道自己在哪个阶段        |
| `turns` / `steps` | 投影自测                 | 客户端从**事件流**折叠,不读投影   |

于是 `project.ts` 里有四类"没人读但要坚持正确"的输出:它们的类型、折叠规则、测试断言都得跟着
transcript 的规则一起维护(0069 那次"正文逐条"就同时改了三处)。**维护成本 > 使用价值。**

## 处理

投影面砍到两类:

```ts
interface Projections {
  transcript: ReadonlyArray<Item>; // 当前引擎的对话历史
  inbox: InboxProjection; // { queue, staged }
}
```

- 删掉 `engine` / `pendingCallIds` / `phase` / `turns` 的读函数与类型
  (`ProjectedEngine` / `ProjectedTurn` / `ProjectedStep*` / `ProjectedError` / `EnginePhase`);
- 折叠状态跟着瘦身:草稿只剩"当前 step(**只为了知道正文怎么进 transcript**)"
  (`calls` / `texts` / `produced`),不再有 turn / engine 段 / system / pending / 错误;
- `ENGINE_START` 只做一件事:**清空 transcript**(新的一段从头记);
- `Projection` 服务去掉 `snapshot`(整份就是两个 `get`),`project(entries)` 仍返回
  `{ queue, staged, transcript }`;
- `index.ts` 的读侧导出只留 `ArchiveProjection` / `InboxProjection` / `Projections` / `ProjectionShape`。

## 为什么

- **只保留有人读的**:`transcript` 有引擎每步消费、`inbox` 有调试与"offer−take 可还原"的核对;
  其余都是"想清楚了但没有使用方";
- **减少一致性负担**:每多一类输出,折叠规则就多一处要跟着 transcript 的规则改;
- **`project.ts` 从 ~600 行降到 ~315 行**,一眼能看完;
- **需要时再加回来**:事件 schema 没变,补一类投影 = 加一个 `read*` + 一处 `selectors`,
  不用改写入侧。

## 代价

- **客户端如果将来想读投影**(比如"现在到哪一步"),得走事件流或等投影补回来;
- **测试面变窄**:`phase = waiting`、`pendingCallIds` 这类"状态机阶段可观察"的断言没了,
  阶段相关的问题只能从事件序列推断;
- **删掉的类型是公开的**:SDK 少导出 7 个类型(`ProjectedEngine` 等),外部若已 import 会编译失败
  (仓库内无使用方);
- **折叠状态里不再有 turn / engine 段的边界**:以后要按轮 / 按段输出,得重新引入这些草稿。

## 复查条件

1. **需要"现在到哪一步"**(客户端进度显示 / 断点恢复):补 `phase` 与 `pendingCallIds`,
   它们本来就在折叠路径上,只加读函数即可。
2. **需要按轮展示**(每轮问答列表):补 `turns`,并恢复 `TurnDraft`(含 `answer`)。
3. **外部要整份快照**:恢复 `snapshot`(= `inbox` + `transcript`,实现是两个 `get` 的组合)。
4. **`transcript` 的折叠规则再变**(压缩 / 保留纯问答 reasoning):`foldEntry` 是唯一实现处,
   改它;若同时还有个"按轮"的输出,要一起对一遍。
