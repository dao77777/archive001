# DeepSeek — 两条传输路径的报文格式

> 本项目只用 DeepSeek,两条 wire 都接。设计与回放契约见 [`../designs/agent/llm.md`](../designs/agent/llm.md);
> 本文是**报文本身**:每个场景的请求 / 响应,以及回放行为。
> ✅ = 由本项目代码实跑产出 · 📖 = 官方文档有、本项目未实现
> ⚠️ 示例 JSON 的**字段与取值**由本项目代码实跑产出;空白/换行经仓库格式化器整理,不影响语义。

## 0. 速查

| 项         | chat/completions(默认)                 | /responses                                       |
| ---------- | -------------------------------------- | ------------------------------------------------ |
| 端点       | `POST {base}/chat/completions`         | `POST {base}/responses`                          |
| 认证       | `Authorization: Bearer <key>`          | 同左                                             |
| 输入载体   | `messages[]`                           | `input: [item, …]`                               |
| 系统提示   | system 消息                            | `instructions`                                   |
| 工具描述   | `{type,function:{name,…}}`             | 扁平 `{type,name,…}`                             |
| 工具结果   | `{role:"tool", tool_call_id, content}` | `{type:"function_call_output", call_id, output}` |
| 思考开关   | `thinking:{type}` + `reasoning_effort` | `reasoning:{effort}`                             |
| 思维链     | `message.reasoning_content`(**明文**)  | `output[].reasoning_text`(**明文**)              |
| 服务端状态 | ❌ 无                                  | ❌ **无**(官方明说无状态)                        |
| 模型       | `deepseek-flash` · `deepseek-v4-pro`   | 同左                                             |

> **两条路径的思维链都是明文**。本项目两条都实现了:**`/responses` 是主路径**(内部 `Item` 就照它的 `input[]` 设计),
> `/chat/completions` 是把 item 折叠成 message 的兼容路径。

## 1. 怎么选

```
默认 ─────────────────► /responses           (主路径)
排障改 DEFAULT_WIRE ──► /chat/completions   (兼容路径)
```

> 走哪条 wire 是内核内部实现(`packages/agent/src/llm/_constants.ts` 的 `DEFAULT_WIRE`),
> 不是环境变量,也不进 SDK 参数。

```
/chat/completions
┌────────────────────────────────────────────┐
│ model · messages[] · tools[] · tool_choice │
│ thinking{type} · reasoning_effort · temp   │
├────────────────────────────────────────────┤
│ messages: [ {role, content}, … ]            │
│   assistant 上可挂:                         │
│     ├─ tool_calls[]          模型的调用请求  │
│     └─ reasoning_content     思维链(回放)   │
│   tool: {role:"tool", tool_call_id, content}│
└────────────────────────────────────────────┘

/responses
┌────────────────────────────────────────────┐
│ model · input[] · instructions · tools[]   │
│ reasoning{effort} · max_output_tokens      │
├────────────────────────────────────────────┤
│ input: [ {type:"message"|"reasoning"|       │
│           "function_call"|                  │
│           "function_call_output"}, … ]      │
└────────────────────────────────────────────┘
```

## 2. `/chat/completions`(默认路径)

### 2.1 最小单轮 ✅

```json
{
  "model": "deepseek-flash",
  "messages": [{ "role": "user", "content": "看看当前目录" }],
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low"
}
```

### 2.2 system + user + 工具 ✅

工具是嵌套的 `{type, function:{name, description, parameters}}`(与 OpenAI 相同,与 Responses 不同)。

```json
{
  "model": "deepseek-flash",
  "messages": [
    { "role": "system", "content": "你是 archive001,一个会调工具的 agent。" },
    { "role": "user", "content": "看看当前目录" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_dir",
        "description": "列出目录内容,目录名带 / 后缀。",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取一个文本文件的内容。",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low"
}
```

### 2.3 多轮 ✅

```json
{
  "model": "deepseek-flash",
  "messages": [
    { "role": "system", "content": "你是 archive001,一个会调工具的 agent。" },
    { "role": "user", "content": "看看当前目录" },
    { "role": "assistant", "content": "目录里有 README.md 和 src/。", "reasoning_content": "" },
    { "role": "user", "content": "再看一下 README" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_dir",
        "description": "列出目录内容,目录名带 / 后缀。",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取一个文本文件的内容。",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low"
}
```

### 2.4 并行工具调用 —— 回放 ✅

每个 `function_call` 对应一条 `{role:"tool"}` 消息,配对的键是 **`tool_call_id`**。

```json
{
  "model": "deepseek-flash",
  "messages": [
    { "role": "system", "content": "你是 archive001,一个会调工具的 agent。" },
    { "role": "user", "content": "看看当前目录" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_1",
          "type": "function",
          "function": { "name": "list_dir", "arguments": "{}" }
        },
        {
          "id": "call_2",
          "type": "function",
          "function": { "name": "read_file", "arguments": "{\"path\":\"README.md\"}" }
        }
      ],
      "reasoning_content": ""
    },
    { "role": "tool", "tool_call_id": "call_1", "content": "README.md\nsrc/" },
    { "role": "tool", "tool_call_id": "call_2", "content": "# archive001" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_dir",
        "description": "列出目录内容,目录名带 / 后缀。",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取一个文本文件的内容。",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low"
}
```

### 2.5 思考 + 工具 —— 回放 ✅

⚠️ 本路径的**关键回放规则**:开思考时,**每条 assistant 消息都得有 `reasoning_content`** ——
有内容就带真内容,没有就补**空串**;否则网关报 `content or tool_calls must be set` 一类错误。

```json
{
  "model": "deepseek-flash",
  "messages": [
    { "role": "system", "content": "你是 archive001,一个会调工具的 agent。" },
    { "role": "user", "content": "看看当前目录" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_1",
          "type": "function",
          "function": { "name": "list_dir", "arguments": "{}" }
        }
      ],
      "reasoning_content": "先看看目录"
    },
    { "role": "tool", "tool_call_id": "call_1", "content": "README.md\nsrc/" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_dir",
        "description": "列出目录内容,目录名带 / 后缀。",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取一个文本文件的内容。",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "thinking": { "type": "enabled" },
  "reasoning_effort": "low"
}
```

> 📌 **一处诚实的存疑**:DeepSeek 官方文档里,`reasoning_content` 作为**输入**字段只出现在
> **Beta 的「对话前缀续写」**场景(且要求 `prefix: true`)。而在普通模式下落库回传它,
> 是照搬 pi 的实测做法 —— pi 对 DeepSeek 恒定回传 `reasoning_content`(缺失时补 `""`)。
> **未经真实 API 验证**,已列入 `../progress/status.md` 的待办。

### 2.6 关思考 ✅

关思考时**才**允许带 `temperature`(思考模式下 temperature 不生效);`tool_choice` 反而更宽松。

```json
{
  "model": "deepseek-flash",
  "messages": [
    { "role": "system", "content": "你是 archive001,一个会调工具的 agent。" },
    { "role": "user", "content": "看看当前目录" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_dir",
        "description": "列出目录内容,目录名带 / 后缀。",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取一个文本文件的内容。",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "thinking": { "type": "disabled" },
  "temperature": 0
}
```

### 2.7 响应 ✅

`reasoning_content` 是**明文**;`arguments` 仍是 **JSON 字符串**。

```json
{
  "id": "chatcmpl-1",
  "choices": [
    {
      "index": 0,
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "content": null,
        "reasoning_content": "先看看目录",
        "tool_calls": [
          {
            "id": "call_1",
            "type": "function",
            "function": { "name": "list_dir", "arguments": "{}" }
          }
        ]
      }
    }
  ],
  "usage": { "total_tokens": 42, "completion_tokens_details": { "reasoning_tokens": 27 } }
}
```

解析成内部 item 列表(`llm/_domain.ts` 的 `Item`;wire 名在适配器里就被拆掉):

```json
[
  { "type": "reasoning", "text": "先看看目录" },
  { "type": "function_call", "callId": "call_1", "name": "list_dir", "arguments": "{}" }
]
```

## 3. `/responses`(可选路径)

形状与 OpenAI 的 Responses 基本一致,但**没有** `store` / `include`,而且思维链是明文。

### 3.1 最小单轮 ✅

```json
{
  "model": "deepseek-flash",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "看看当前目录" }]
    }
  ],
  "reasoning": { "effort": "low" }
}
```

### 3.2 system + user + 工具 ✅

```json
{
  "model": "deepseek-flash",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "看看当前目录" }]
    }
  ],
  "instructions": "你是 archive001,一个会调工具的 agent。",
  "tools": [
    {
      "type": "function",
      "name": "list_dir",
      "description": "列出目录内容,目录名带 / 后缀。",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    },
    {
      "type": "function",
      "name": "read_file",
      "description": "读取一个文本文件的内容。",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning": { "effort": "low" }
}
```

### 3.3 多轮 ✅

```json
{
  "model": "deepseek-flash",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "看看当前目录" }]
    },
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "目录里有 README.md 和 src/。" }]
    },
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "再看一下 README" }]
    }
  ],
  "instructions": "你是 archive001,一个会调工具的 agent。",
  "tools": [
    {
      "type": "function",
      "name": "list_dir",
      "description": "列出目录内容,目录名带 / 后缀。",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    },
    {
      "type": "function",
      "name": "read_file",
      "description": "读取一个文本文件的内容。",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning": { "effort": "low" }
}
```

### 3.4 并行工具调用 —— 回放 ✅

```json
{
  "model": "deepseek-flash",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "看看当前目录" }]
    },
    { "type": "function_call", "call_id": "call_1", "name": "list_dir", "arguments": "{}" },
    {
      "type": "function_call",
      "call_id": "call_2",
      "name": "read_file",
      "arguments": "{\"path\":\"README.md\"}"
    },
    { "type": "function_call_output", "call_id": "call_1", "output": "README.md\nsrc/" },
    { "type": "function_call_output", "call_id": "call_2", "output": "# archive001" }
  ],
  "instructions": "你是 archive001,一个会调工具的 agent。",
  "tools": [
    {
      "type": "function",
      "name": "list_dir",
      "description": "列出目录内容,目录名带 / 后缀。",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    },
    {
      "type": "function",
      "name": "read_file",
      "description": "读取一个文本文件的内容。",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning": { "effort": "low" }
}
```

### 3.5 思考 + 工具 —— 回放(明文,无需密文)✅

`reasoning` item 依然要**整体回传**、且排在 `function_call` 之前 —— 但它**没有 `encrypted_content`**,
所以不存在 OpenAI 那个"拿不到密文就不能回放"的限制。

```json
{
  "model": "deepseek-flash",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "看看当前目录" }]
    },
    { "type": "reasoning", "content": [{ "type": "reasoning_text", "text": "先看看目录" }] },
    { "type": "function_call", "call_id": "call_1", "name": "list_dir", "arguments": "{}" },
    { "type": "function_call_output", "call_id": "call_1", "output": "README.md\nsrc/" }
  ],
  "instructions": "你是 archive001,一个会调工具的 agent。",
  "tools": [
    {
      "type": "function",
      "name": "list_dir",
      "description": "列出目录内容,目录名带 / 后缀。",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    },
    {
      "type": "function",
      "name": "read_file",
      "description": "读取一个文本文件的内容。",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning": { "effort": "low" }
}
```

### 3.6 关思考 ✅

`effort: "none"` 是 DeepSeek **明确支持**的关思考写法(不像 OpenAI 有些模型会 400)。

```json
{
  "model": "deepseek-flash",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "看看当前目录" }]
    }
  ],
  "instructions": "你是 archive001,一个会调工具的 agent。",
  "tools": [
    {
      "type": "function",
      "name": "list_dir",
      "description": "列出目录内容,目录名带 / 后缀。",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    },
    {
      "type": "function",
      "name": "read_file",
      "description": "读取一个文本文件的内容。",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      }
    }
  ],
  "tool_choice": "auto",
  "reasoning": { "effort": "none" }
}
```

### 3.7 响应 ✅

思维链在 `content[].reasoning_text`(明文)。实测(2026-10-20)`deepseek-flash` 的真实返回:

```json
{
  "id": "18ee9d2a-678e-4c74-b3a1-4b3a11664711",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "reasoning",
      "id": "a6d1f292-b40d-4af3-b7fb-88928c54abf2",
      "status": "completed",
      "content": [{ "type": "reasoning_text", "text": "用户想列目录,用 path=\".\" 调 list_dir。" }],
      "summary": [],
      "encrypted_content": "18ee9d2a-678e-4c74-b3a1-4b3a11664711-0"
    },
    {
      "type": "function_call",
      "id": "adab41e6-eb5c-44fa-abdf-e9e8fce3ccfe",
      "status": "completed",
      "arguments": "{\"path\": \".\"}",
      "call_id": "call_00_S0rQ8jrMTFszGvTL6z3f2351",
      "name": "list_dir"
    }
  ]
}
```

⚠️ `encrypted_content` 看着像密文,实际是 `"<response_id>-0"` 这种**指针**;
回放时**不需要**它,也不需要 `id` / `summary`(实测见文末「回放实测证据」第 6 条)。

解析成内部 item 列表(**与 wire 同构**,几乎只做字段改名):

```json
[
  { "type": "reasoning", "text": "用户想列目录,用 path=\".\" 调 list_dir。" },
  {
    "type": "function_call",
    "callId": "call_00_S0rQ8jrMTFszGvTL6z3f2351",
    "name": "list_dir",
    "arguments": "{\"path\": \".\"}"
  }
]
```

## 4. 两条路径差异一览

|              | chat/completions                                                | /responses                                                   |
| ------------ | --------------------------------------------------------------- | ------------------------------------------------------------ |
| 思维链字段   | `message.reasoning_content`                                     | `output[].reasoning_text`                                    |
| 思考开关     | `thinking:{type:"enabled"/"disabled"}` + `reasoning_effort`     | `reasoning:{effort: none/low/high/max}`                      |
| 关思考       | `thinking:{type:"disabled"}`                                    | `effort:"none"`                                              |
| 工具参数编码 | JSON **字符串**                                                 | JSON **字符串**                                              |
| 回放约束     | 开思考时**每条** assistant 都要有 `reasoning_content`(空串也行) | 开思考时每轮 `function_call` 前要有**非空** `reasoning_text` |
| 服务端状态   | 无                                                              | 无(官方明说)                                                 |
| 本项目角色   | 兼容路径(item 折叠成 message)                                   | **主路径**(内部 `Item` 即其 `input[]` 形状)                  |

## 5. 参数速查(踩坑集中区)

| 参数               | 事实                                                                                                      | 本项目                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `thinking.type`    | `enabled` · `disabled`,**默认 `enabled`**(不传就是开)                                                     | 显式发送,不用默认值                                     |
| `reasoning_effort` | `none` · `low` · `high` · `max`,**没有 `medium`**;默认 **`high`**;`minimal`→`low`,`medium`/`xhigh`→`high` | 档位就用官方这四个词(`off` 单独表示不思考),不另造中间档 |
| `tool_choice`      | ⚠️ **思考模式下不支持 `required` 和"指定具体工具"**(会 400)                                               | 固定 `"auto"`                                           |
| `temperature`      | 思考模式下**不生效**(不报错);范围 ≤ 2,默认 1                                                              | 仅关思考时发 `0`                                        |
| `top_p`            | 仅思考模式生效,有效范围 0.95–1.0                                                                          | 不发                                                    |
| `max_tokens`       | 不设时:非思考默认 **8K**,思考默认 **64K**(`effort=max` 时 128K);上限 384K                                 | 不发,用默认                                             |
| `finish_reason`    | 多两个值:`insufficient_system_resource`(后端资源不足被打断)、`aborted`                                    | 未特殊处理                                              |

## 6. 📖 官方有、本项目未实现

| 场景                   | 关键形状                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| **流式**               | SSE,`reasoning_content` 也有 delta;`data: [DONE]` 收尾                                              |
| **对话前缀续写(Beta)** | `base_url` 要换成 `/beta`;`prefix: true` + 最后一条 assistant 的 `reasoning_content` 作为思维链输入 |
| **FIM 补全(Beta)**     | `/beta/completions`,代码补全专用(不是对话)                                                          |
| **图片 / 文件输入**    | `content` 用块数组:`{"type":"image_url"}` / `{"type":"file","file_id"}`                             |
| **JSON 模式**          | `response_format: {type:"json_object"}`(需在提示里说明要 JSON)                                      |
| **上下文硬盘缓存**     | 响应 `usage.prompt_cache_hit_tokens` / `miss_tokens` 可观测                                         |
| **Files API**          | 上传文件拿 `file-api-…` id                                                                          |
| **`logprobs`**         | 输出 token 的对数概率                                                                               |

## 7. 我方代码对应

| 环节                         | 位置                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| chat/completions 请求 + 解析 | `src/llm/chat-completions.ts`(`toWireMessages` / `toItems`)      |
| /responses 请求 + 解析       | `src/llm/responses.ts`(`toWireItem` / `toItems`)                 |
| 内部 item 模型               | `src/llm/_domain.ts`                                             |
| 路径选择                     | `packages/agent/src/llm/llm.ts`(按 `DEFAULT_WIRE`)               |
| 单元测试                     | `src/llm/chat-completions.test.ts` · `src/llm/responses.test.ts` |

## 8. 回放实测证据(2026-10-20,`deepseek-flash`)

| #   | 场景                                                         | 结果                                 |
| --- | ------------------------------------------------------------ | ------------------------------------ |
| 1   | chat:开思考 + 单轮工具 + assistant 缺 `reasoning_content`    | 400                                  |
| 2   | chat:同上但 `reasoning_content: ""`                          | 200                                  |
| 3   | chat:`thinking:{type:"disabled"}` + 缺该字段                 | 200                                  |
| 4   | responses:单轮工具 + 不带 reasoning item                     | 200                                  |
| 5   | responses:两轮工具 + 全不带 reasoning item                   | 400                                  |
| 6   | responses:两轮工具 + 两轮都带**重建**的最小 item             | 200                                  |
| 7   | responses:两轮工具 + 只给其中一轮                            | 400                                  |
| 8   | responses:重建 item 的空 `reasoning_text`                    | 400                                  |
| 9   | responses:`reasoning.effort="none"` + 两轮工具 + 无 item     | 200(关思考即免回放)                  |
| 10  | responses:assistant 文本用 `output_text` / `input_text` 回放 | 都 200                               |
| 11  | chat:`reasoning_effort` = low / high / max                   | 都 200,`reasoning_tokens` 随档位变化 |

结论(实现依据):

- **chat**:开思考时每条 assistant 都要有 `reasoning_content`,空串即可(1–3);
- **responses**:开思考时每轮 `function_call` 前都要有**非空** `reasoning_text`,
  第二轮起缺了必挂(4–8);关思考(`effort: "none"`)则完全不需要(9);
- reasoning item **用明文重建**就够,`id` / `summary` / `encrypted_content` 都不是必需品(6)。
