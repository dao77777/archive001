# 决策:`SYSTEM_MESSAGE` 从"每步的内容事件"改成"引擎级状态事件"(SET / CLEAR)

> 已接受 · 2026-10-24 · 落实 [`0026`](0026-uppercase-tags-items.md) 的复查条件 4 ·
> 落点 `packages/agent/src/archive/_domain.ts` + `loop/engine.ts` + `archive/project.ts` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md#事件)

## 矛盾

`SYSTEM_MESSAGE` 一直是**每个 step 开头的一条内容事件**:

```ts
STEP_START { id: S }
  SYSTEM_MESSAGE { id: …, parentId: S, text }   // 每步都发,内容通常完全一样
  USER_MESSAGE   { parentId: S, inboxId }
```

而在引擎里它其实是**一次运行的状态**:`SYSTEM_MESSAGE` 是常量(`loop/_constants.ts`),
`ENGINE_START` 之后到 `ENGINE_END` 之间每一步都用同一份。

| 问题                | 说明                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| 重复写入            | N 个 step 就有 N 条一模一样的 system 行;长会话里纯浪费 archive 体积          |
| 语义错位            | 它描述的是"这次运行用什么 system",不是"这一步发生了什么"                     |
| 归组歧义            | 读投影的人要先按 step 扫一遍 `SYSTEM_MESSAGE`,再发现全都一样                 |
| 0026 早就写下了这条 | "`SYSTEM_MESSAGE` 每步重复太吵 → 改为在变化时发一次,step 只引用"(复查条件 4) |

## 处理

把它当成**状态**记录:设一次、清一次,payload 只带状态本身。

```ts
/** system 被设成这段文本(一次引擎运行通常只有一条,在 `ENGINE_START` 之后)。 */
SYSTEM_MESSAGE_SET: {
  text: string;
}
/** system 被清掉:引擎收尾时发,之后的 step 不再带 system。 */
SYSTEM_MESSAGE_CLEAR: {
}
```

- `parentId` 指向 **engine**(它是引擎级状态,不属于某个 step)——引擎 id 后来被
  [`0072`](0072-drop-engine-id.md) 去掉,现在这两条是顶层事件,没有 `parentId`;
- engine:`ENGINE_START` 之后发 `SYSTEM_MESSAGE_SET { text: SYSTEM_MESSAGE }`;step 里**不再发**;
  收尾(`onExit` 的错误分支与正常分支)在 `ENGINE_END` 之前发 `SYSTEM_MESSAGE_CLEAR`;
- 发给模型的 `items` 不变:仍是 `[{ type: "SYSTEM_MESSAGE", text }, ...transcript]`;
- 投影:`EngineDraft.system` 由 `SET` / `CLEAR` 维护,`STEP_START` 时把当时的值快照进
  `step.inputs.system`(0 或 1 条);`ProjectedEngine.system` 暴露引擎结束时还生效的值
  (清过就是 `undefined`)。

## 为什么

- **状态只记变化**:同一份 system 只写一行,archive 体积与 step 数解耦;
- **语义对齐**:`SYSTEM_MESSAGE_SET/CLEAR` 一眼看出是"设/清一个状态",与
  `INBOX_*`(队列本身的事件)同属"状态/过程"而不是"step 内容";
- **投影仍然自足**:每步的 `inputs.system` 由状态快照得到,`pool` 里也能看出这次运行用的是哪段
  文本(即使常量以后改了,归档里仍留着当时的 `text`);
- **step 内容更纯**:`STEP_START..STEP_END` 里只剩真正随步变化的东西(prompt / 观测 / 输出)。

## 代价

- **状态事件带生命周期**:读的人要理解 `SET` … `CLEAR` 的作用域(engine),不能只按 step 读;
- **每步的 system 需要"补"**:单看某一条 step 事件看不到 system,要回到投影 / 引擎级事件;
- **投影多一份状态**:`project` 多维护一个 `system` 字段并在 `STEP_START` 做快照,漏了就会
  "步骤里没有 system";
- **旧 archive 不兼容**:以前的 `SYSTEM_MESSAGE`(parentId = step)事件不会被新投影识别,
  旧数据里那些 step 会显示"没有 system"(要兼容得加一段读旧 tag 的兜底);
- **CLEAR 的价值取决于读者**:引擎结束后状态其实已无人使用,`CLEAR` 主要是给"状态机"一个
  完整生命周期;如果以后 system 变成跨引擎(会话级),`CLEAR` 才有实际关闭含义。

## 复查条件

1. **system 变成可变 / 会话级**:`SET` 可能在一次会话里发多次,投影要按"最后一条 SET 生效";
   `CLEAR` 的时机也要跟着改(会话结束而不是引擎结束)。
2. **需要"每步都用同一份"的可读性**:投影已经把它下发到 step(`inputs.system`),不要再让
   step 事件自己带一份 —— 那会回到重复。
3. **旧 archive 需要读**:在 `project` 里兼容旧 `SYSTEM_MESSAGE` tag(读旧、写新),
   兼容期过了就删。
4. **状态事件多了**(将来还有别的"设置"类状态):把 `SET` / `CLEAR` 抽成通用的
   `*_SET` / `*_CLEAR` 约定,并在设计文档里列一张"状态事件"表。
