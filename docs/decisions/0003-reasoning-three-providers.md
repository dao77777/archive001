# 决策：思维链要做三套适配器,OpenAI 暂时不上 Responses API

> ⚠️ **已被 [`0005`](0005-deepseek-only.md) 取代**:项目现在只接 DeepSeek,`anthropic.ts` 与 `reasoningSignature` 均已删除。本篇保留作历史。

> 已接受 · 2026-10-16 · 所属设计 [`../designs/overview.md`](../designs/overview.md) · 落点 `src/llm/`

## 矛盾

需求是「带 reasoning,兼容 deepseek + openai + anthropic」。但三家**根本不是同一套协议**:

| provider  | 传输                                  | 思考参数                                                                            | 响应里的思维链                                                 | 回放约束                                              |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| deepseek  | `/chat/completions`                   | `thinking:{type}` + `reasoning_effort`                                              | `message.reasoning_content`                                    | **每条** assistant 都要带 `reasoning_content`(可空串) |
| openai    | `/chat/completions` _或_ `/responses` | `reasoning_effort` / `reasoning:{effort,summary}`                                   | chat/completions **拿不到**;Responses 的 `reasoning` item 才有 | 无                                                    |
| anthropic | `/messages`                           | `thinking:{type:adaptive}`+`output_config.effort`,或 `{type:enabled,budget_tokens}` | `content[]` 的 `thinking` block                                | 带 tool_use 那轮必须回传 `signature`                  |

**"兼容三家"= 写三套 wire 翻译**,不是加一个字段。

## 处理

- 内部只保留**一个**统一消息形状(`domain.ts` 的 `AssistantMessage`):
  `content` + **`reasoning`**(归一化文本)+ **`reasoningSignature`**(回放用的不透明载荷)+ `tool_calls`。
- 差异**全部收敛**在 `src/llm/`:
  - `chat-completions.ts` —— 一个适配器 + 两个方言(`deepseek` / `openai`)
  - `anthropic.ts` —— Messages 协议(含 tool_result 合并、thinking 回放)
- `reasoningSignature` 一家一义:chat/completions 系存**字段名**(`reasoning_content`),anthropic 存 **signature**(redacted 用 `redacted:<data>` 前缀)。

## 为什么

- 统一形状让 `agent.ts` / `repl.ts` / `tools.ts` **完全不知道**厂商存在(它们只看 `reasoning`)。
- deepseek 与 openai 共用适配器,是因为**它们的请求/响应骨架确实相同**(OpenAI 兼容),差别只在思考开关 —— 用"方言"表达最省。
- anthropic 无法复用(消息数组、工具结果、system 位置全不一样),只能单写。
- **OpenAI 走 chat/completions**:`reasoning_effort` 可用、工具调用可用;只是拿不到思维链文本。
  pi 对 OpenAI 全部走 Responses API,但那是完整 harness 的选择(要 encrypted reasoning、prompt cache 等);
  对本项目而言 Responses API 是**第三套协议**(input items / function_call_output / reasoning item 回放),
  代码量约再翻一倍,而收益只是"能显示 OpenAI 的思维链"。

## 代价

- `src/llm/` 从 1 个文件涨到 5 个,总计约 620 行;项目从 ~840 行到 ~1840 行。
- **OpenAI 这家看不到 🧠**:`PROVIDER=openai` 时思维链通常为空(reasoning_effort 仍生效)。
- Anthropic 的 `adaptive` / `budget` 必须**手工指定**(`ANTHROPIC_THINKING_STYLE`),因为要靠模型目录才知道哪个模型支持哪种。
- 三家都**无法用真实 key 全量验证**——只有 deepseek 能(见 `docs/progress/status.md`);openai / anthropic 靠 mock 服务端 + pi 的实测实现作对照。

## 复查条件

1. **OpenAI 的 chat/completions 不再接受 `reasoning_effort`**(或 GPT-5.x 之后只提供 Responses API)时,
   必须补 `src/llm/responses.ts` —— 这是一次**局部新增**,不影响其他适配器(接口是 `WireAdapter`)。
2. 需要 openai 的思维链文本(而不只是"它推理过")时,同样是补 Responses 适配器。
3. 若第四家厂商出现,先判断 **能否归入 chat-completions 方言**;能就别新建适配器。
