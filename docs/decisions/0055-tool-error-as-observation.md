# 决策:失败转观测由 `runTool` 统一做,`Tool.execute` 允许失败

> 已接受 · 2026-10-24 · 接在 [`0052`](0052-tool-output-truncation.md) /
> [`0054`](0054-tool-output-head-and-tail.md) 之后(`runTool` 现在三件事:派发、转观测、截断)·
> 落点 `packages/agent/src/loop/tool-executor.ts` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md#工具)

## 矛盾

"工具永不失败"以前是**在 `makeTool` 里**兑现的:

```ts
// loop/_util.ts
    }).pipe(Effect.catch((error) => Effect.succeed(`错误:${formatError(error)}`))),
```

| 问题               | 说明                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| 只有 `makeTool` 兜 | 调用方直接实现的 `Tool`(测试桩、第三方包、手写对象)没有这层 catch,一次 `fail` 就能让执行器崩        |
| 缺陷完全没兜       | 工具里抛异常是**缺陷**(die),`Effect.catch` 抓不到;执行器 worker 直接死,之后所有工具结果都不会回来   |
| 契约撒了谎         | `Tool.execute` 标成 `Effect.Effect<string>`(永不失败),实现方被迫自己兜底或干脆违约                  |
| 三处各管一段       | 参数错误在 `makeTool` 吞,未知工具在 `runTool` 造,输出超长又在别处截 —— "什么叫一条观测"没有单一定义 |

## 处理

失败转观测挪进 `runTool`,并顺带把缺陷也兜住;`Tool.execute` 的类型改成允许失败:

```ts
// _domain.ts
readonly execute: (rawArguments: string) => Effect.Effect<string, unknown>;

// tool-executor.ts
Option.match(Option.fromUndefinedOr(tools.find((tool) => tool.definition.name === name)), {
  onNone: () => Effect.succeed(`错误:未知工具 ${name}`),
  onSome: (tool) => tool.execute(rawArguments),
}).pipe(
  Effect.catch((error) => Effect.succeed(`错误:${formatError(error)}`)), // 类型化失败
  Effect.catchDefect((defect) => Effect.succeed(`错误:${formatError(defect)}`)), // 抛异常 / die
  Effect.map((text) => truncate(text, TOOL_MAX_OUTPUT)), // 输出上限
);
```

- `makeTool` 去掉 `.pipe(Effect.catch(…))`:参数非法 → `ToolInputError` 照常失败,由执行器转;
- `builtin-tools.test.ts` 那条改用 `Effect.result` 断言"工具以 `ToolInputError` 失败";
- `loop.test.ts` 新增:一个 `Effect.fail`、一个 `Effect.die`,两条观测都是 `错误:…`,循环照常跑完。

## 为什么

- **"观测"只有一个定义**:`runTool` 的返回值就是回喂给模型的东西 —— 派发、转观测、截断都在它一处;
- **契约与实现一致**:工具可以失败、可以抛,`Tool` 类型不再装作永不失败;想自己兜底的实现也仍然成立
  (它的输出本来就是字符串,`runTool` 不会再加前缀);
- **缺陷不再杀执行器**:`Effect.die` 被 `catchDefect` 兜住,worker 不会因为一个坏工具静默死掉
  (死掉的后果是所有后续工具结果都不回来,agent 永远等下去);
- **`catchDefect` 不碰中断**:执行器被停时中断仍能正常传播,不会被误记成"工具错误";
- **`makeTool` 只做一件事**:Schema → JSON Schema + 参数校验,不再兼管观测的兜底语义。

## 代价

- **`Tool.execute` 的错误类型变宽**(`never` → `unknown`):外部若显式标注 `Effect<string, never>` 会不兼容;
  想"证明自己不会失败"的工具失去了类型层面的表达,只能靠实现;
- **直接调 `tool.execute` 的代码不再自动兜底**:绕过执行器(比如自己写个循环、单测直接调)会遇到失败,
  必须走 `runTool` 的路径(它是私有的,只能通过 `Agent`);
- **前缀可能叠加**:工具若自己返回 `错误:…` 字符串(内置 `bash` 超时就是这样)不走 catch,没问题;
  但若工具 `fail` 的消息本身以 `错误:` 开头,会得到 `错误:错误:…`;
- **缺陷被当成普通观测**:真正的实现 bug(比如解构 undefined)从此只表现为"模型收到一条错误"，
  不会让执行器崩掉提醒你 —— 排查得靠 archive 里的观测文本;
- **错误信息不做分类**:所有失败都是同一个 `错误:` 前缀,模型无法区分"参数错"与"环境炸了"
  (现在只能读文案)。

## 复查条件

1. **缺陷被吞掉导致难以发现 bug**:把 `catchDefect` 的结果同时记一条 `Effect.logError` 或事件,
   或在 `ToolBatch` 里区分 typed failure 与 defect 的处理;保留"执行器不崩"这个前提。
2. **模型需要按错误类型决策**(重试 / 换参数 / 放弃):把观测改成结构化(比如 `错误[参数]:…`),
   仍由 `runTool` 生成;不要退回让每个工具自己写前缀。
3. **想给工具"不截断 / 不兜底"的例外**:先证明有工具必须如此(比如流式输出);
   否则不开特例 —— 一旦开了,`runTool` 就不再是唯一定义。
4. **需要直接测 `runTool`**(未知工具、fail、die、截断的组合):把 `runTool` 导出成内部模块
   (`tool-executor` 内的子模块或 `loop/_util.ts` 的助手),不要为测试在别处复制一份逻辑。
