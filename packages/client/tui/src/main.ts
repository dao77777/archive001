// **TUI 客户端**(尚未实现):这个包目前只有骨架。
// 计划见 `docs/drafts/`:alt-screen + raw mode + 行级 diff 渲染,事件来源是 `@archive001/agent` 的 `AgentEvent`。
// 现在只打印说明并退出 —— 让包结构、`pnpm -r build`、`pnpm check` 先跑通。

import process from "node:process";

process.stdout.write("archive001 tui 还没实现;先用 `pnpm dev` 跑 REPL 客户端。\n");
