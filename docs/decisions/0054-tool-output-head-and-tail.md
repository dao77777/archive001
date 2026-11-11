# 决策:工具输出截断收进 `runTool`,且头尾都留

> 已接受 · 2026-10-24 · 取代 [`0052`](0052-tool-output-truncation.md) 的"截断在 `executeBatch`、
> 只留头部"(0052 的复查条件 2 触发了)· 落点 `packages/agent/src/loop/tool-executor.ts` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md#工具)

## 矛盾

0052 之后,截断是这样两步:

```ts
const output = truncate(yield* runTool(...), TOOL_MAX_OUTPUT); // executeBatch 里
```

两个问题:

| 问题             | 说明                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| 两步才得到"观测" | `runTool` 返回的是工具的原始输出,真正能回喂的是 `truncate` 之后那个 —— 概念跨两个函数 |
| 新路径容易漏截   | 任何以后新增的派发路径(重试、并发、预热)都得记得再套一次 `truncate`                   |
| 只留头部         | 报错摘要、`exit code N`、测试失败列表都在**尾部**;超长时它们被整段切掉,模型看不到线索 |

第三条正是 0052 自己写下的复查条件 2("截断把有用信息切掉(错误摘要、exit code 在尾部)")。
`bash` 尤其明显:`body + "\n(exit code 7)"` 一旦超长,退出码永远到不了模型眼前。

## 处理

截断搬进 `runTool`,它直接返回**可以回喂给模型的观测**;截断本身改成保留头尾:

```ts
const truncate = (text, limit) => {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return `${text.slice(0, head)}\n...[中间已截断 ${text.length - limit} 字符]...\n${text.slice(-tail)}`;
};

const runTool = (tools, name, rawArguments) =>
  (tool === undefined ? Effect.succeed(`错误:未知工具 ${name}`) : tool.execute(rawArguments)).pipe(
    Effect.map((text) => truncate(text, TOOL_MAX_OUTPUT)),
  );
```

- `executeBatch` 只剩一句 `const output = yield* runTool(...)`;
- 未知工具的错误观测也走同一条截断路径(统一,不为它开特例);
- 截断后总长 = `TOOL_MAX_OUTPUT` + 一行标记(标记 ≈ 30 字符)。

## 为什么

- **"观测"只有一个定义**:`runTool` 的返回值就是回喂给模型的东西,截断是它的职责,而不是调用者要记得做的第二步;
- **尾部信息不再丢**:`exit code`、最后几行报错、测试失败摘要都能到模型眼前 —— 这些正是自我纠正的依据;
- **模型知道被截了**:中间那行写明省略多少字符,不会把半截输出当成完整输出;
- **一处上限**:头尾比例、标记文案都只在一个函数里。

## 代价

- **中间内容彻底丢**:关键线索恰好在中段时(长日志中间的某条 warning)看不到;
- **比例是一刀切**:头尾各半,读大文件时尾部的一半浪费、跑命令时头部的一半浪费;
  真正的比例应按工具区分,现在没有;
- **长度略超上限**:标记行让回喂文本比 `TOOL_MAX_OUTPUT` 多几十字符,断言不能死盯等于上限;
- **断行不友好**:头尾按字符切,可能落在半行 / 半个多字节边界上(中文在多字节边界上被切开,
  只是少见;`slice` 按 UTF-16 码元,可能出现单个代理项)。

## 复查条件

1. **中段内容确实重要**(长日志中间的告警):加"按行采样"或按工具分段读取,
   不要靠调大上限解决;要改就改本条。
2. **头尾比例成为问题**(读文件嫌尾部浪费、跑命令嫌头部浪费):给 `Tool` 或 `ToolBatch`
   加 `headRatio` / 头尾字符数,`truncate` 仍是唯一实现;不要按工具各写一份截断。
3. **需要完整输出**:让工具把完整内容写到文件 / archive,回喂一个路径 + 摘要(需要工具与
   会话存储配合),不要在执行器里放宽上限。
4. **上限要按会话配**:把 `TOOL_MAX_OUTPUT` 挪进 `AgentConfig` / `ToolBatch`,截断仍在 `runTool`。
5. **截断切开多字节字符导致乱码**:把 `slice` 换成按码点 / 按行的切法,并补一条中文长输出用例。
