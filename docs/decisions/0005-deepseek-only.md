# 决策：只接 DeepSeek,内部形状不留"回放载荷"

> 已接受 · 2026-10-20 · 所属设计 [`../designs/overview.md`](../designs/overview.md) · 落点 `src/domain.ts` · `src/llm/`
> **取代** [`0003`](0003-reasoning-three-providers.md) 与 [`0004`](0004-responses-api.md) 中"多家厂商"的部分;
> 两条 wire 的取舍(0004 的 chat vs responses)继续有效。

## 矛盾

项目只有 DeepSeek 的 key,真正会跑的也只有 DeepSeek,但代码为三家厂商维护了四套翻译层:

| 0003/0004 留下的东西                                                         | 现状                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 三家 `Provider` + 四套适配器(`chat`/`responses` 各两方言 + `anthropic`)      | 只有 deepseek 一个方言会被执行                                   |
| `AssistantMessage.reasoningSignature`(不透明字符串,三种语义)                 | 0004 自己就把它写进「代价」:读代码要记住谁写谁读                 |
| `domain.ts` 里的 `tool_calls` / `function:{name,arguments}` / `tool_call_id` | 全是 wire 字段名,和「厂商字段不得越出 `src/llm/`」的规矩自相矛盾 |
| `THINKING` 里的 `medium`                                                     | DeepSeek 没有这一档,要靠"不发字段"来近似                         |

同时,本机实测发现了一件改变成本结构的事:**DeepSeek 两条 wire 的思维链都是明文**,
回放只需要文本本身 —— 也就是说,`reasoningSignature` 这个"不透明载荷"在本项目**根本没有存在理由**。

## 处理

- 只留 DeepSeek,两条 wire:`WIRE_API=chat`(默认)/ `responses`。
- `domain.ts` 只保留语义字段:`reasoning: string | null`、`toolCalls[{id,name,arguments}]`、
  `toolCallId`、`ToolDefinition{name,description,parameters}`。**wire 名一个不留**。
- 删掉全部"方言"抽象(`ChatCompletionsDialect` / `ResponsesDialect` / `WireAdapter` / `anthropic.ts`)。
- `THINKING` 改成 DeepSeek 的原生四档:`off | low | high | max`。
- `/responses` 回放时**用明文重建** reasoning item,不再保存原件(证据见
  [`../knowledge/deepseek-api.md`](../knowledge/deepseek-api.md) 第 8 节第 6 条)。

## 为什么

- **没被执行的分支就是负债**:三家 × 两协议的组合里,只有一条被真实调用验证过;其余全靠 mock 与 pi 的实现作对照,
  却每天增加读代码的负担。
- **域模型可以更诚实**:既然思维链是明文,就不该在领域里出现"不透明载荷"这种概念。
  少一个概念,`agent.ts` / `repl.ts` / 测试都少一次解释。
- **删掉的是抽象,不是能力**:加回第二家时,扩展点是 `LlmShape.complete`(见「修订」与复查条件 2)。

## 代价

- **失去多厂商能力**:要接第二家,必须重新引入"回放载荷"的表达(见复查条件 2),不是改个字段。
- **依赖一个未文档化的实现细节**:重建 reasoning item 能过,是因为服务端只校验 `reasoning_text`;
  DeepSeek 若改成签名/密文,回放立刻断。
- **`THINKING=medium` 不再有效**:旧配置会直接报 schema 错(刻意的:静默降级更难查)。
- **历史文档被改写**:`api/openai.md`、`api/anthropic.md` 已删除,`0003`/`0004` 保留原文作为历史,
  与当前实现的差异由本条说明。

## 复查条件

1. **DeepSeek 开始要求 reasoning 签名/密文**(回放时报 `reasoning_text` 之外的校验错):
   给 `AssistantMessage` 加回一个原样回放的载体字段,并把 `convertMessages` 改成回放原件。
2. **要接第二家厂商**:先判断它能否落进现有 `LlmShape.complete`(`complete(items, tools)`);
   若它的思维链需要不透明载荷(OpenAI 的 `encrypted_content`、Anthropic 的 `signature`),
   就在 `domain.ts` 一次性加回该字段,并**同时**更新 `AGENTS.md` 第 5 条的回放契约。
3. **要吃 Responses 的内置工具**(web_search / file_search / code_interpreter)时:`WIRE_API=responses`
   已经有位置放这些 item 类型,但需要扩展 `toAssistantMessage` 的 item 分支 —— 新需求,另开一条。

## 修订(2026-10-20,同一天的第二轮)

上述处理落地后,又做了两处方向性调整,记录在此(不改上文,便于对照):

| 调整         | 之前                                           | 现在                                                           | 理由                                                                                    |
| ------------ | ---------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 内部模型     | 消息联合(`AssistantMessage` / `ChatMessage`)   | **`Item` 列表**,照 `/responses` 的 `input[]` 设计              | responses 是表达力更强的一侧;让主路径直通,chat 去折叠,难度落在"可降级"的方向上          |
| 缺省 wire    | `chat`                                         | **`responses`**                                                | 同上;`chat` 降级为兼容路径                                                              |
| 领域类型位置 | `src/domain.ts`                                | **`src/llm/domain.ts`**(工具/展示共用错误留在 `src/errors.ts`) | LLM 领域与 wire 一对一,放一起读一次就够                                                 |
| 适配器契约   | `WireTransport` 接口 + 工厂返回 `{ complete }` | 直接导出 `complete(deps, items, tools)`                        | 原接口与 `LlmShape` 逐字相同,是重复抽象;删掉后由 `Llm.of(...)` 与三元表达式做同一层校验 |

扩展点与复查条件因此更新为:`LlmShape.complete`;若新厂商需要不透明回放载荷,
仍在 `Item` 上加一个字段(而不是恢复 `reasoningSignature` 那种字符串)。

上文复查条件里的旧名字对应关系(方便按图索骥):

| 上文写法                                 | 现在                     |
| ---------------------------------------- | ------------------------ |
| `AssistantMessage`                       | `Item`                   |
| `convertMessages` / `toAssistantMessage` | `toWireItem` / `toItems` |
| `WireTransport`                          | `LlmShape.complete`      |
