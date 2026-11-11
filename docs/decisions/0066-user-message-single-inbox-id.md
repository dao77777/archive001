# 决策:`USER_MESSAGE` 只带一个 `inboxId`,一条 prompt 一条事件

> 已接受 · 2026-10-24 · 取代 [`0029`](0029-step-inbox-references.md) 的"`USER_MESSAGE` 用数组
> `inboxIds`"· 落点 `packages/agent/src/archive/_domain.ts` + `loop/engine.ts` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md#事件)

## 矛盾

`0029` 为了表达"一个 step 里可能并进来多条 prompt",把 step 里的引用做成两种基数:

```ts
USER_MESSAGE         { inboxIds: ReadonlyArray<string> }  // 0..n 条 prompt
FUNCTION_CALL_OUTPUT { inboxId: string }                  // 1 条结果
```

两个后果:

| 问题                | 说明                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| 同一类引用两种形状  | 读事件的人要先判断"这个字段是数组还是字符串"                                      |
| 投影 / 客户端的写法 | 一律 `inboxIds.includes(id)` / `for (const id of …)` —— 绝大多数时候只有 1 个元素 |
| 一条事件多条内容    | `USER_MESSAGE` 事件里塞 N 条引用,归档 / 渲染时要再拆开                            |
| 与另一侧不对称      | `FUNCTION_CALL_OUTPUT` 一直是一条事件一个引用,只有 prompt 特殊                    |

## 处理

`USER_MESSAGE` 改成**一条 prompt 一条事件**,引用与另一侧统一为单数:

```ts
USER_MESSAGE: { readonly inboxId: string };
```

- engine 里从"一次 emit 带数组"变成 `Effect.forEach(userMessages, emit({ inboxId: message.id }))`;
- 事件顺序 = prompt 到达顺序,所以 transcript 的拼法与之前一致;
- `project` 折叠时按 `inboxId` 取 offer 的正文,一个事件推一条 transcript;
- 客户端 `_turn.ts` / web 宿主:`event.inboxId === ownPromptId` 即可。

## 为什么

- **一个引用一个值**:所有 step 引用都是 `inboxId`,不用记"哪个是数组";
- **基数交给事件条数**:并进来 2 条 prompt 就有 2 条 `USER_MESSAGE`,不用在 payload 里表达 N;
- **读写都变短**:`includes` / `for` 循环消失,直接相等比较;
- **与 `FUNCTION_CALL_OUTPUT` 对称**:两类输入事件形状一致。

## 代价

- **同一 step 的事件变多**:并两条 prompt 时 step 里有两条 `USER_MESSAGE`;按 step 分组统计时要先聚合;
- **archive 体积略增**:每条多一个 `id` / `parentId` / `v` / `at`;
- **断点还原更细但要按事件算**:以前"一条事件 = 一次合并",现在"一条事件 = 一条 prompt";
- **旧 archive 不兼容**:早先写下的 `inboxIds` 行,`project` 会当作"缺 `inboxId`"跳过。

## 复查条件

1. **需要"一次合并"的事件**(比如给 UI 一个"本步新增了 3 条 prompt"的提示):
   用 `parentId` 分组统计,不要恢复数组字段。
2. **archive 里要兼容旧行**:在 `project` 里对 `inboxIds` 做一次兜底(读旧、写新),
   并在读完一批旧数据后删掉这段兼容代码。
3. **prompt 与结果需要同一条事件表示**(比如"这批输入"作为一个整体):那时引入显式的
   `STEP_INPUT` 事件,而不是又改引用字段的基数。
