# 决策：集成 Responses API,并把 openai 默认切到 `/responses`

> ⚠️ **部分被 [`0005`](0005-deepseek-only.md) 取代**:`WIRE_API=auto` 与 responses 方言表已删除(现在只有 `chat`/`responses` 两条 DeepSeek wire);省略 item id 的结论仍然有效。

> 已接受 · 2026-10-16 · 所属设计 [`../designs/overview.md`](../designs/overview.md) · 落点 `src/llm/responses.ts`
> 补充(不推翻)[`0001`](0001-effect-v4-rewrite.md) 与本条,**部分取代** [`0003`](0003-reasoning-three-providers.md) 的处理与代价两节。

## 矛盾

[`0003`](0003-reasoning-three-providers.md) 当时的结论是「OpenAI 暂时不上 Responses API」,代价写的是
「OpenAI 这家看不到 🧠」。现在要求把这个缺口补上。补的时候发现两件事:

1. **DeepSeek 也有 `/responses`**(官方文档有完整 schema),而且思维链是**明文** `reasoning_text`;
2. **两家的 `/responses` 互不兼容**:OpenAI 是加密 reasoning(`include:["reasoning.encrypted_content"]`)+
   `summary`,且 `store` 语义不同;DeepSeek 是明文 + 天生无状态。所以不是"再写一个适配器",
   而是"一个适配器 + 两个方言"。

## 处理

- 新增 `src/llm/responses.ts`:一个适配器 + `openaiResponsesDialect` / `deepseekResponsesDialect`。
- 新增配置 `WIRE_API = auto | chat | responses`(默认 `auto`):
  - `auto`:openai → `responses`(这才是拿得到思维链的那条路),deepseek → `chat`,anthropic → `messages`
  - `chat` / `responses` 可强制覆盖(指向只支持 chat 的兼容端点时用)
- 统一形状**不变**:仍然只靠 `AssistantMessage.reasoning` + `reasoningSignature`。
  只是 `reasoningSignature` 在 responses 系里存的是 **reasoning item 的 JSON 数组**(可整体原样回放)。

## 为什么

- **`WIRE_API` 而不是"直接换掉 chat"**:DeepSeek 的 chat 路径已经能拿到思维链且更简单,没有理由强制迁移;
  同时保留 `chat` 作为"兼容端点"的逃生口。
- **不扩展 `domain.ts`**:回放 `function_call` 时**省略 item id** —— 依据是本机 pi 的实现注释
  (「By omitting the id, we avoid triggering that pairing validation」)。
  若把 `fc_…` 塞进 `ToolCall.id`(pi 用的是 `call_id|fc_id` 拼串),就得让 `domain.ts` 认识 Responses 概念,
  违反"厂商差异只在 `src/llm/`"这条规矩。省略 id 是合法的输入形状,代价最小。
- **一个适配器两个方言**,而不是两个适配器:请求体骨架(item 列表、扁平 tools、`instructions`)完全相同,
  只有 `include`/`store`/`reasoning` 与"思维链从 `summary` 还是 `content` 取"不同。

## 代价

- `src/llm/` 从 4 个文件涨到 5 个;`responses.ts` 312 行,项目约 1840 → 2150 行。
- **`reasoningSignature` 的语义又分叉了一层**:chat 系是字段名、anthropic 是 signature、responses 是 item JSON。
  它是纯不透明的,但读代码时要知道"谁写的、谁读的"。
- **OpenAI 的加密思维链有时效/配对约束**:拿不到 `encrypted_content` 时我们**不回放**该 item
  (否则被拒),这意味着跨模型切换时可能丢掉思维链上下文。这是刻意的保守选择。
- 依然**没有真实 key 验证**(openai / anthropic);responses 路径只有 mock 服务端与 pi 的实现作对照。

## 复查条件

1. **模拟真实 OpenAI 调用**时若报 `Item 'rs_…' of type 'reasoning' was provided without its required following item`
   —— 说明省略 `fc_` id 不够,必须把 item id 也回传:届时给 `ToolCall` 加一个可选的
   `providerItemId` 字段(一次性改动,不影响其它适配器)。
2. 若 OpenAI 把 `reasoning.summary` 改成默认返回/改名,或 `include` 不再需要 —— 调整方言常量即可,不动架构。
3. 若 DeepSeek 的 `/responses` 与 OpenAI 的差异继续变大(例如加入 `store` 语义)——考虑拆成两个适配器。
4. 需要 Responses 的**内置工具**(web_search / code_interpreter)时,那是新需求,另开一条决策。
