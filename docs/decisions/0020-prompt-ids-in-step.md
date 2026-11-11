# 决策:promptIds 下放到 step,`turn.start/end` 只做边界

> 已接受 · 2026-10-24 · 细化 [`0019`](0019-lifecycle-vs-content.md)
> (结构 / 内容判据不变)· **字段名已被 [`0021`](0021-id-parent-id.md) 取代**
> (`turnId` / `stepId` / `step` → `id` / `parentId`)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

`turn.start` / `turn.end` 之前带着 `promptIds`:

```ts
turn.start { turnId, promptIds }
turn.end   { turnId, promptIds, reason }
```

但 `promptIds` 是**这一步吃了哪些用户输入** —— 是内容,不是生命周期边界。
把它塞进 turn 的 start/end,等于让结构事件承载内容,而且:

| 问题                 | 说明                                                                  |
| -------------------- | --------------------------------------------------------------------- |
| 结构不纯             | turn 的 start/end 应该只表达"开始 / 结束",不携带负载                  |
| 合并 prompt 无处安放 | 等工具时新 prompt 并进来,只改 `turn.end.promptIds`,看不出它属于哪一步 |
| 与 step 的语义脱节   | 实际"这次生成吃了哪些 prompt"是 step 的属性,不是整个 turn 的          |

## 处理

- `turn.start { turnId }`、`turn.end { turnId, reason }`:**去掉 `promptIds`**。
- 新增 step 内容事件:

  ```ts
  prompt { turnId, step, promptIds }
  ```

  在 `step.start` 之后、thinking / text / tool.call 之前发出;只在这一步有新 prompt 时发
  (第一轮、或等工具时新并进来的 prompt)。

- `turn.error { turnId, promptIds, message }`:错误发生在 step 之前(比如没配置)时,
  客户端仍需要认领自己的 prompt,所以错误内容事件带 `promptIds`。
- 客户端关联方式:
  - 订阅时先记 `turnId = undefined`;
  - 看到 `prompt` 事件的 `promptIds` 含自己的 id → 记下 `turnId`;
  - 看到 `turn.error` 的 `promptIds` 含自己的 id → 记下 `turnId` 并记失败;
  - 等这一 `turnId` 的 `turn.end`,用它收尾;
  - `engine.end` 仍然兜底。

## 为什么

- **结构只做容器**:turn 的 start/end 不携带任何"谁问了什么";prompt 属于 step 的输入。
- **合并 prompt 有准确归属**:哪个 step 吃了新 prompt,就在哪个 step 的 `prompt` 事件里;
  不会出现"turn.end 里突然多了一个 id"。
- **引用而非正文**:`prompt` 只带 id,正文仍在 `inbox.offer`;不重复内容。
- **客户端仍能认领**:自己的 prompt 一定会在某个 step 的 `prompt` 里出现(或 turn.error 里),
  拿到 turnId 后再等 turn.end 即可。

## 代价

- **关联多一步**:不能再用 `turn.end.promptIds.includes(id)` 直接过滤,必须先记 turnId。
- **step 前的错误要特殊处理**:没配置 / 模型还没跑就失败时没有 step,所以 `turn.error` 需要带 promptIds。
- **空 step 的 prompt**:后续 step 没有新 prompt 时不发 `prompt` 事件,客户端要允许"这一步没有 prompt"。
- **归档/UI 需要 join**:prompt 正文在 inbox.offer,promptIds 在 step;按 id 关联。

## 复查条件

1. **客户端关联逻辑重复且易错**:抽一个纯函数 `turnIdOf(events, promptId)` / `answerOf(...)`,
   放在客户端共享层,不要回到结构事件里塞 promptIds。
2. **需要"这一轮所有 prompt"的快速视图**:由外部投影 `fold(events)` 计算;
   不要为了查询方便把 promptIds 加回 turn.end。
3. **turn.error 的 promptIds 不够**:如果错误可能发生在 prompt 被 take 之前,考虑在
   `turn.error` 里带上更完整的上下文,或让错误只通过 `engine.end` / inbox 事件表达。
4. **step 的 prompt 事件太频繁**:只在有 prompt 时发(现状);不要合并到 step.start 的结构里。
