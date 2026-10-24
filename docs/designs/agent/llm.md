# 设计:LLM 层

> 路径 `packages/agent/src/llm/`。循环见 [`loop.md`](loop.md);跨包结构见 [`../overview.md`](../overview.md)。

## 职责

把**内部 item 列表**翻译成 DeepSeek 两条 wire 之一的请求,再翻译回来。只做翻译,不做策略:
模型 / 档位 / wire 都是调用参数。

| 文件                  | 内容                                                          |
| --------------------- | ------------------------------------------------------------- |
| `llm.ts`              | `Llm` 服务 + `LlmLive`:交给内部选定的适配器(默认 `responses`) |
| `responses.ts`        | 主路径:`Item` ↔ `/responses`(近乎直通)                        |
| `chat-completions.ts` | 兼容路径:`Item` ↔ `/chat/completions`(折叠成 message)         |
| `_domain.ts`          | 全部类型与 wire Schema(不含函数)                              |
| `_util.ts`            | item 助手、`postJson`、`decodeWire`、`partTextsOf`            |
| `_constants.ts`       | 厂商名、两条端点、`DEFAULT_SETTINGS`                          |

## Item 模型

内部模型就是 `/responses` 的 `input[]` 形状;chat 是把它折叠成 message 的兼容路径。

| `Item`                                   | `/responses`                          | `/chat/completions`                    |
| ---------------------------------------- | ------------------------------------- | -------------------------------------- |
| `message(role, text)`                    | `{type:"message", role, content:[…]}` | `{role, content}`                      |
| `reasoning(text)`                        | `reasoning` item                      | assistant 的 `reasoning_content`       |
| `function_call(callId, name, arguments)` | 独立 item                             | assistant 的 `tool_calls[]`            |
| `function_call_output(callId, output)`   | 独立 item                             | `{role:"tool", tool_call_id, content}` |

两条路的思维链都是**明文**,所以这里没有"签名 / 密文"这类不透明载荷 —— 回放只需要文本本身。

命名:`Item` 助手跟 `type` 走 —— `functionCallsOf` 取 item,`messageTextsOf` / `reasoningTextsOf` 取文本。

## 回放契约

⚠️ 违反任意一条都是 400,且可能**毒死整个会话**。两条都已用真实 key 实测(证据见
[`../../knowledge/deepseek-api.md`](../../knowledge/deepseek-api.md) 第 8 节)。

| wire        | 规则                                                                                                                     | 代码位置                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `responses` | 开思考时每轮 `function_call` 之前都要有 `reasoning` item,且 `reasoning_text` **非空**;历史里出现第二轮工具调用时缺了必挂 | `responses.ts` `toWireItem`            |
| `chat`      | 开思考时**每条** assistant 都必须带 `reasoning_content`,没有也要给 `""`                                                  | `chat-completions.ts` `toWireMessages` |
| 两者        | 正文与工具调用都空的 assistant 消息**整条丢弃**                                                                          | 同上                                   |

`responses` 回放用的 `reasoning` item 是**用明文重建**的(`{type:"reasoning", content:[{reasoning_text}]}`)——
实测 `id` / `summary` / `encrypted_content` 都不是回放必需品。这是个**未文档化的实现细节**,
DeepSeek 一旦改成签名 / 密文,就得把原样回放的载体加回来(见
[`../../decisions/0005-deepseek-only.md`](../../decisions/0005-deepseek-only.md) 的复查条件)。

## 选路与参数

```ts
const complete: LlmShape["complete"] = (items, tools, settings) =>
  (DEFAULT_WIRE === "responses" ? responsesComplete : chatCompletionsComplete)(
    deps,
    items,
    tools,
    settings,
  );
```

- **走哪条 wire 不对外暴露**:由 `_constants.ts` 的 `DEFAULT_WIRE`(默认 `responses`)决定。
  调用方只给设置(`model` / `thinking` / `apiKey` / `baseUrl`),无从知道传输细节;排障要切兼容路径时改这一个常量
  (或直接调 `chat-completions.ts` 的 `complete`)。
- `Llm` 服务**不持有任何设置**:模型 / 档位 / 密钥 / 端点都是 `complete(…, settings)` 的入参,
  所以同一个实例能按次换模型、换 key、换端点(测试就是这么打本地 mock 的)。
- 唯一依赖是 `HttpClient`(`LlmLive` 自带 `FetchHttpClient`)—— **没有全局配置服务**。
- 设置里**只有 `apiKey` 必填**;`model` / `thinking` / `baseUrl` 省了就走缺省
  (`deepseek-flash` / `high` / `https://api.deepseek.com`)。补全在 `LlmLive` 的边界做一次
  (`resolveSettings`),适配器只认 `ResolvedSettings` —— 缺省值全库只有一处。
- 思考档位就用官方四档:`off | low | high | max`(`off` 即 `reasoning.effort: "none"` / `thinking: disabled`)。

| wire        | 开思考                                           | 关思考                       |
| ----------- | ------------------------------------------------ | ---------------------------- |
| `responses` | `reasoning:{effort}`                             | `reasoning:{effort:"none"}`  |
| `chat`      | `thinking:{type:"enabled"}` + `reasoning_effort` | `thinking:{type:"disabled"}` |

思考模式下**不发 `temperature`**(服务端会忽略,别发无效字段)。

## 错误

| 情况                                                     | 处理                                                |
| -------------------------------------------------------- | --------------------------------------------------- |
| HTTP 非 2xx                                              | `postJson` 转成 `LlmError`,带原始 body 片段(200 字) |
| `responses` 的 `status=failed/incomplete`(HTTP 仍是 200) | 显式转成 `LlmError`,否则会变成"静默的空回答"        |
| 响应解不出预期形状 / 没有可用 item                       | `LlmError`                                          |
| 工具执行出错                                             | **不算** LLM 错误:转成字符串观测(见 `agent.md`)     |

## 暂未做

流式(SSE)· `responses` 的内置工具(web_search 等)· 重试 / 退避 · 多厂商 · `top_p` / `max_tokens` 配置化。
