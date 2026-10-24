# drafts

未定稿草稿,允许烂尾。定稿后移到 `designs/` / `decisions/` / `knowledge/`。

候选想法(尚未展开):

- **`edit_file` 工具**(精确替换,少一次全文件重写)
- **流式输出**(`Stream` + 增量渲染思维链/正文;chat 与 responses 的 SSE 事件名不同)
- **上下文压缩**:超过 N 条时让模型总结早期消息
- **工具并发执行**(`Effect.all({ concurrency })`)
- **`effect/cli` 子命令**(`run` / `chat` / `tools`)
- **JSONL 会话持久化** → 已定设计:[`../designs/agent/archive.md`](../designs/agent/archive.md)(archive 落盘,含 reasoning)。剩下的是落地。
- **Responses 的内置工具**(web_search / file_search / code_interpreter):
  需要给 `llm/responses.ts` 的 `toItems` 加分支,并想清楚这些 item 怎么回放
- **重放历史里的 reasoning 到模型**:目前跨轮历史不带思维链(`remember` 里不写)。archive 已经记下了,
  要不要回喂、回喂哪几轮,是**策略**问题(成本 vs 收益),不是实现问题 —— 改 `historyOf` 一行。
