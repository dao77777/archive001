# 决策:最终回答的正文逐条进 transcript,不再 join 成一条

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/loop/engine.ts` + `archive/project.ts` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md#历史)

## 矛盾

工具轮与纯问答轮对"正文档数"的处理曾经不一致:

| 轮次     | transcript 里的正文                                               |
| -------- | ----------------------------------------------------------------- |
| 工具轮   | `transcript = [...transcript, ...produced]` —— 模型产出几条就几条 |
| 纯问答轮 | `texts.join("")` —— 多段正文合成**一条** `ASSISTANT_MESSAGE`      |

而事件层一直是逐条记的(`ASSISTANT_MESSAGE` 一条 text 一个事件)。于是:

- 同一次生成的"事件条数"与"transcript 条数"对不上,排查时要先做一次 join 反推;
- `project()` 为了还原 transcript,得复制一遍"纯问答轮要 join"的规则,两处规则要一起改;
- 一条正文里如果原本分了几段(不同 content part),合起来后回放时无法还原原来的分条。

## 处理

纯问答轮也逐条入 transcript:

```ts
if (isAnswerStep(calls)) {
  // 纯问答轮:正文逐条进 transcript(与事件、与工具轮的 `produced` 一样不合并不丢条);
  // 思维链不留在历史里
  yield *
    Ref.update(transcript, (current) => [
      ...current,
      ...texts.map((text): Item => ({ type: "ASSISTANT_MESSAGE", text })),
    ]);
  yield * finishTurn();
  return;
}
```

- `texts` 来自 `assistantTextsOf`,**已经过滤空串**,所以不再需要"空答复不入历史"的单独判断;
- `project()` 同步:纯问答轮把 `step.texts` 逐条推进 transcript(仍然丢掉 `REASONING`);
- 客户端回答不变:`ask` 这类实现本来就把 `ASSISTANT_MESSAGE` 文本累加,`ProjectedTurn.answer`
  仍然是 `texts.join("")` 的展示值。

## 为什么

- **一条事件 = 一条正文**:事件与 transcript 一一对应,读完事件就知道历史长什么样;
- **工具轮 / 纯问答轮同构**:两边的"正文怎么进历史"是同一条规则(逐条),不再是特殊情况;
- **投影不用复刻 join 规则**:`project` 只按事件顺序追加,不会因为"这是最后一轮"而改变形状;
- **保住原始分段**:模型分几段说就记几段,回放时信息不丢。

## 代价

- **回放可能连续多条 assistant**:chat wire 会把连续的 `ASSISTANT_MESSAGE` 折成多条 assistant 消息
  (工具轮本来就这样),个别厂商对"连续同角色消息"敏感时表现可能不同;
- **多一次数组操作**:历史里多几条 item,长对话时体积略增;
- **历史里不再有"整段回答"**:想拿完整回答要自己 join(展示层已经这么做:`answer` 字段 / `ask`);
- **旧 archive 的纯问答轮是一条**:新旧 archive 在 transcript 形状上略有差异(内容等价)。

## 复查条件

1. **连续多条 assistant 让某个厂商报错 / 行为异常**:在 wire 层把相邻 `ASSISTANT_MESSAGE` 合并成
   一条(那是报文层的事),不要回退到 transcript 里 join。
2. **需要在历史里区分"一条消息的多个 part"**:给 `ASSISTANT_MESSAGE` 加 `partId` 之类的标记,
   而不是靠 join / 拆分猜。
3. **历史体积成为问题**:先考虑压缩(摘要 / 截断,见 0012 复查条件),不要重新合并正文。
