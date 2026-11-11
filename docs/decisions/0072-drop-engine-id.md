# 决策:暂时去掉 `engineId`(引擎没有身份,`projection` 只按"当前段"取)

> 已接受 · 2026-10-24 · 取代 [`0071`](0071-archive-projection-by-engine.md) 的"`projection(engineId, kind)`"
> 与 [`0067`](0067-system-message-as-state.md) 里"状态事件的 `parentId` 指向 engine" ·
> 落点 `packages/agent/src/archive/` + `loop/engine.ts` ·
> 设计见 [`../designs/agent/archive.md`](../designs/agent/archive.md) 与
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

`engineId` 一直以三种方式存在:

| 位置                         | 作用                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `State.engineId`             | 引擎自己的 id,开 / 关 / 出错事件都用它当 `id`         |
| `TURN_START.parentId` 等     | turn 挂在 engine 下面;`SYSTEM_MESSAGE_SET/CLEAR` 也是 |
| `projection(engineId, kind)` | 按 id 找某一段引擎的投影                              |
| `ProjectedEngine.id`         | 投影结果里带着这段的身份                              |

但实际上**现在只有一段运行**:一个 `Agent` 实例一个引擎,进程内没有第二个。
于是每次读都要先拿到 id、再拿 id 去找自己刚写的那一段:

- `engine.ts` 要维护 `engineId`(还得在 `run` 开头重发一个);
- `projection(engineId, …)` 多一个参数,调用方还要处理"找不到这段 → `undefined`";
- 事件层出现 `parentId: engineId`,而它指向的容器**只有一个**、没有别的用途。

## 处理

把"引擎身份"整个拿掉:

- **`State` 不再有 `engineId`**;`ENGINE_START` / `ENGINE_END` / `ENGINE_ERROR` 用普通事件 id,
  start / end 不再共用 id(它们只标记"一段开始 / 结束");
- **`TURN_START` / `TURN_END` / `SYSTEM_MESSAGE_SET` / `SYSTEM_MESSAGE_CLEAR` 不再带 `parentId`**
  (引擎不是有身份的容器);`STEP_START.parentId` 仍然是 `turnId`;
- **`ProjectedEngine` 不再有 `id`**;分段靠 `ENGINE_START` / `ENGINE_END` 的先后;
- **`projection` 只接一个 `kind`**:

  ```ts
  interface Projections {
    // 全局
    inbox;
    unused;
    // 当前(最后一段)引擎
    engine: ProjectedEngine | undefined;
    transcript;
    pendingCallIds;
    turns;
    phase: EnginePhase | undefined;
  }
  projection: <K extends keyof Projections>(kind: K) => Effect<Projections[K]>;
  ```

- engine 侧的 `transcriptOf` 直接变成 `archive.projection("transcript")`(数组类不会 `undefined`)。

## 为什么

- **只有一个的东西就不要编号**:一段运行没有第二者可比,id 只增加"要传、要查、要处理找不到"的成本;
- **读口的形状更简单**:`projection(kind)` 没有"哪一段"这一维,调用方不必再处理 `undefined`
  (数组类给空、对象类给 `undefined` 且只在"还没开跑"时出现);
- **事件层少一层挂靠**:turn 不再声称自己属于某个"有身份的引擎",层级就剩 engine(无身份)→ turn → step;
- **为将来留位**:真有多引擎时,回来看 [`0071`](0071-archive-projection-by-engine.md) 与
  [`0021`](0021-id-parent-id.md) 的层级约定再加回来(本文件写了复查条件)。

## 代价

- **事件里的 `ENGINE_*` 不再成对**:start / end 没有共同 id,想"配对"得靠顺序;如果以后要
  "这一段的产物",得重新引入身份。
- **`projection("engine")` 的含义变模糊**:它给"最后一段";如果将来有"当前 vs 历史段"的区分,
  这个名字会误导(现在只有一段,所以不歧义)。
- **`Turn` 变成顶层**:`TURN_START` 没有 `parentId`,按 `parentId` 做树形展示的调用方要改
  (现有客户端只用 `step.parentId` 找 turn,不受影响)。
- **文档要改一圈**:`loop.md` 的事件图、`archive.md` 的投影类型、`0021` / `0067` / `0070` / `0071`
  的相关句子都提到过 `engineId`。

## 复查条件

1. **真的出现多引擎**(子代理 / 会话并行 / 重放历史段):把 `ProjectedEngine.id` 与
   `projection(engineId, kind)` 加回来,事件层恢复 `TURN_START.parentId`;写新决策 supersede 本文,
   并保留"当前段"的简化读口(`projection("transcript")` 依然可用)。
2. **需要引擎段配对**(把一段的 start/end 关联起来做统计):给 `ENGINE_START` / `ENGINE_END` 加一个
   不叫 `engineId` 的 `runId`,只在统计层用,不进入 turn 层级。
3. **`projection("engine")` 的"最后一段"语义被误用**:拆成 `projection("current")` 与
   `projection("segments")`,不要靠注释解释。
