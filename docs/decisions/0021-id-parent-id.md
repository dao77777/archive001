# 决策:层级只用 `id` / `parentId`,不再区分 turnId / stepId

> 已接受 · 2026-10-24 · 取代 [`0020`](0020-prompt-ids-in-step.md) 的字段名
> (promptIds 放在 step 内容里的做法不变)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

之前每个层级都有自己的字段名:

```ts
turn.start { turnId }
step.start { turnId, step }
prompt     { turnId, step, promptIds }
thinking   { turnId, step, text }
```

这带来三个问题:

| 问题                 | 说明                                                   |
| -------------------- | ------------------------------------------------------ |
| 每层一套命名         | 新增一层就要发明 `xxxId`,内容事件还要知道最近两层的 id |
| 层级信息散在 payload | `turnId` / `step` 是结构,却混在内容事件里              |
| 无法通用遍历         | 想画事件树 / 做通用投影,必须为每种 tag 写特例          |

## 处理

所有事件共用:

```ts
interface EventBase {
  readonly id: string;
  readonly parentId?: string;
}
```

- **start / end 共用同一个 `id`**:
  - `engine.start/end { id }`
  - `turn.start/end { id, parentId: engineId }`(引擎 id 后来被 [`0072`](0072-drop-engine-id.md) 去掉,现在没有 parentId)
  - `step.start/end { id, parentId: turnId }`
- **内容事件挂到容器上**:
  - `prompt / thinking / text / tool.call { id, parentId: stepId, … }`
  - `turn.error { id, parentId: turnId, promptIds, message }`
- **顶层内容事件没有 parentId**:
  - `inbox.offer { id, message }`
  - `inbox.take { id, messageIds }`
- 删除 `turnId` / `step` / `stepId` 字段;`promptIds` 仍然只在 step 的 `prompt` 内容 /
  `turn.error` 里。

客户端关联:

- `step.start.parentId` 就是 turn id,存一张 `stepId → turnId` 映射;
- 看到 `prompt` 事件的 `promptIds` 含自己的 id,用 `parentId` 查出 turnId;
- `turn.error.parentId` 直接是 turnId;
- 等 `turn.end.id === turnId` 收尾。

## 为什么

- **一种层级机制**:`id` / `parentId` 可以表达任意深度,不再为每层发明字段。
- **通用投影**:事件树、trace、archive 都可以用同一套遍历;不需要知道 `turnId` 还是 `stepId`。
- **内容事件不关心层级名**:只带 `parentId`,挂到哪个 step 都对。
- **start/end 对齐**:同一个 `id` 让"这个 end 关的是哪个 start"一眼可见。

## 代价

- **认领 turn 多一步**:`prompt` 的 parent 是 step,不是 turn;客户端要存 `stepId → turnId` 映射
  (或维护 current turn)。
- **内容事件也有 id**:每条 thinking/text 都生成一个 UUID,事件变长一点;它们通常不被引用。
- **可读性下降**:`parentId` 不像 `turnId` 那样自解释,排查时要先看事件树。
- **`turn.error` 的 parentId 是 turn**,和其他内容事件的 parent 是 step 不同;
  这是因为它可能发生在 step 之前。

## 复查条件

1. **客户端反复写 stepId → turnId 映射**:提供一个纯投影助手 `parentOf(event)` / `turnOf(event)`,
   不要恢复 `turnId` 字段。
2. **内容事件的 id 完全没用**:把 `id` 在内容事件上改成可选,只保留 `parentId`;
   生命周期 start/end 仍然必须有 `id`。
3. **事件树遍历成为性能热点**:在 archive 投影里建索引(`id → parentId`),不要在写入侧加字段。
4. **需要多根事件**:`parentId` 已经是可选;根事件不填即可。
