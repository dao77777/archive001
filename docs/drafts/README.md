# drafts

未定稿草稿,允许烂尾。定稿后移到 `designs/` / `decisions/` / `knowledge/`。

候选想法(尚未展开):

- **`edit_file` 工具**(精确替换,少一次全文件重写)
- **流式输出**(`Stream` + 增量渲染思维链/正文;chat 与 responses 的 SSE 事件名不同)
- **上下文压缩**:超过 N 条时让模型总结早期消息
- **工具并发执行**(`Effect.all({ concurrency })`)
- **`effect/cli` 子命令**(`run` / `chat` / `tools`)
- **JSONL 会话持久化**:把多轮 `Item[]` 落盘;`reasoning` 要不要一起存、落盘前怎么处理,见
  [`../decisions/0008`](../decisions/0008-archive-persisted.md)(那条决策还成立,只是没有设计了)。
- **Responses 的内置工具**(web_search / file_search / code_interpreter):
  需要给 `llm/responses.ts` 的 `toItems` 加分支,并想清楚这些 item 怎么回放
- **重放历史里的 reasoning 到模型**:现在工具轮的 reasoning 会随 `function_call` 一起留在 transcript(回放契约要求),
  纯问答轮仍不带。要不要把纯问答轮的思维链也回喂、带哪几轮,是**策略**问题(成本 vs 收益),不是实现问题。
