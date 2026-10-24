# 设计:agent 循环

> 路径 `packages/agent/src/loop/`。模型层见 [`llm.md`](llm.md);跨包结构见 [`../overview.md`](../overview.md)。
> ⚠️ 本文件描述**当前实现**(一次 `run` = 一次请求)。下一版形态是常驻事件循环,见
> [`live-loop.md`](live-loop.md)(未实现,尚未覆盖本节)。

## 职责

**一次 `run` = 一次请求**,本质是一个循环:

```
调模型 → 若要求调工具就执行并回填 → 再调模型 → …… → 直到只回正文
```

不知道 HTTP、wire、文件系统,也**不知道有哪些工具**(工具是参数)。

| 文件               | 内容                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| `loop.ts`          | `Agent` 服务 + `AgentLive`:循环、历史、事件                                      |
| `builtin-tools.ts` | 四个内置工具(可选来源)+ `BuiltinTools` 服务                                      |
| `_constants.ts`    | `MAX_STEPS` / `systemPromptFor(toolNames)` / 工具上限与超时                      |
| `_domain.ts`       | `AgentEvent` / `Observer` / `AgentShape` / `Tool` / `Spawner` / `ToolInputError` |
| `_util.ts`         | `makeTool`(Schema → Tool)、`runTool`(按名字派发)                                 |

## 提示词:跟着工具集走

系统提示词由 `systemPromptFor(toolNames)` 现拼,**不能比真实能力大**:

| 本次 `run` 的 `tools`      | 提示词                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| 非空                       | 人格 + "你可以调用这些工具:a、b…" + 调用规则(先查后答、不做破坏性操作)          |
| **空**(Web 客户端就是这样) | 人格 + "⚠️ 本次运行没有任何工具可用" + 不许输出 `<tool_call>`、不许声称读过文件 |

⚠️ 血泪原因:工具集为空却仍在提示词里承诺工具,模型会把调用**写成正文**(实测
`<tool_call>{"name":"shell","arguments":{…}}</tool_call>`),客户端既不执行也不继续 ——
用户看到的就是"卡在调用工具里"。见 `docs/logs/2026-10-21.md`。

## 接口

```ts
interface Tool {
  readonly definition: ToolDefinition; // 喂给模型
  readonly execute: (rawArguments: string) => Effect.Effect<string>; // 永不失败:错误也是观测
}

interface AgentShape {
  readonly run: (
    input: string,
    settings: LlmSettings, // 模型 / 档位 / wire,按次给
    tools: ReadonlyArray<Tool>, // 这次可见的工具,可空
    observe?: Observer, // UI 事件出口
  ) => Effect.Effect<string, LlmError>;
}
```

`settings` 与 `tools` 都是**调用参数**,不是装配参数 —— 所以同一个 `Agent` 实例可以按次换模型、换档位、换工具集。

## 数据流

1. 组 items = `[system, ...历史, user]`
2. `llm.complete(items, tools.map(t => t.definition), settings)` → 本轮产出的 items
3. 分红:`functionCallsOf` / `messageTextsOf` / `reasoningTextsOf`
4. 无工具调用 → 正文用 `messageTexts.join("")`,写历史,返回
5. 有工具调用 → 发 `text` 事件(正文是"我先查一下"这类宣告)→ 逐个执行工具(顺序,工具会写文件 / 跑 shell)
   → 回填 `function_call_output` → 回到第 2 步
6. 超过 `MAX_STEPS`(12)返回提示,不无限循环

## 事件

`AgentEvent` 是内核与 UI 的唯一接口,**内核不碰 Console**:

| 事件          | 谁发                     | 客户端怎么用          |
| ------------- | ------------------------ | --------------------- |
| `thinking`    | 每轮产出里的 `reasoning` | 折叠显示(🧠)          |
| `text`        | 仅"有工具调用"的轮次     | 作为宣告,先于工具卡片 |
| `tool_call`   | 执行前                   | 显示工具名 + 参数     |
| `tool_result` | 执行后                   | 显示结果(截断)        |

最终答复**不发事件**,由 `run` 返回给调用方打印 —— 避免同一段文字渲染两次。

## 历史

- 放在 `Ref<ReadonlyArray<Item>>`,跨轮记忆。
- 写入的只有 `user` 与最终 `assistant` 的**正文**。
- ⚠️ **`reasoning` 不回喂模型**(只服务单次 run 的 UI);空答复也不写(会毒死会话)。
  下一版会把它当普通条目记进 archive(见 [`archive.md`](archive.md)、[`../../decisions/0008`](../../decisions/0008-archive-persisted.md)),
  但**仍不回喂**。

## 工具

- 契约只有 `{ definition, execute }`;`makeTool` 用一份 Effect Schema 同时产出 JSON Schema 与运行时校验。
- 参数非法 / 执行抛错一律转成 `错误:…` 字符串回喂给模型 —— **工具永不失败**,模型看到错误才能自我纠正。
- `BuiltinTools` 只是"想要 bash/读/写/列目录时"的现成实现;调用方可以给空数组,或自己造工具。

## 暂未做

流式输出 · 工具并发 · 上下文压缩 / 摘要 · 沙箱 · 多轮规划器。想法先记到 `docs/drafts/`。

## 下一版

`run` 改成**永不返回的循环**(信箱进、事件流出、一拍一次模型调用)的完整设计见
[`live-loop.md`](live-loop.md)。
