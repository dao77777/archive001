# 决策：用 Effect-TS v4 重写整个项目

> 已接受 · 2026-10-16 · 所属设计 [`../designs/overview.md`](../designs/overview.md) · 落点 `src/` 全部

## 矛盾

初版是**零依赖**写法:`fetch` + 一个 `while` 循环 + 手写工具表。它很短、很好懂,但:

| 问题           | 表现                                                          |
| -------------- | ------------------------------------------------------------- |
| 关注点混在一起 | HTTP、文件、shell、REPL、配置全在一个平面函数里,没有依赖注入  |
| 错误靠约定     | 工具失败返回字符串、LLM 失败 `throw`,类型上区分不出来         |
| Schema 写两遍  | 喂给模型的 JSON Schema 手写一次,运行时校验再手写一次,必然漂移 |
| 不可测         | 想测循环就得真发 HTTP                                         |

同时本项目的目的之一是**学 Effect**——但不想为了用框架而牺牲「最简」。

## 处理

按 Effect 惯例整体重写:

- `Context.Service` + `Layer`:`AppConfig` / `Llm` / `Toolbelt` / `Agent` 四个服务;
- `Schema` 一处定义(消息协议 + 工具参数),`Schema.toJsonSchemaDocument` 生成工具描述;
- `Data.TaggedError` 建模领域错误;
- 平台能力走 `HttpClient` / `FileSystem` / `Path` / `ChildProcessSpawner` / `Terminal`;
- 入口 `NodeRuntime.runMain`,依赖图在 `main.ts` 显式接线。

循环本身仍是 `Effect.gen` 里一个 `for`,**没有**用花哨抽象隐藏它。

## 为什么

- **可测**:把 `Llm` 换成脚本化 stub(`agent.test.ts`)就能测循环,不发网络请求。
- **错误进类型**:`Effect<A, LlmError>` 让「哪里会失败」写在签名里。
- **Schema 一处定义**:这是本仓库里收益最直接的一条。
- 落选候选:① 保持手写(学习价值低);② 用现成 agent SDK(目标是**自己写**一个 agent);③ Effect v3(本机 `effect-web` 已是 v4,且 v3 已不再演进)。

## 代价

- **代码量翻倍**:约 300 行 → 约 840 行(含 236 行测试)。
- **Effect v4 API 标为 unstable**,且包结构刚从 `@effect/*` 合并进 `effect`,`HttpClientResponse.schemaJson` 之类接口较绕,踩坑不少(要点见 `../designs/code-conventions.md` §5)。
- **类型体操**:`Layer` 的参数顺序、`Context.Service.Shape` 等反直觉,新人上手成本高。
- 对「最简」这个目标而言,它是**减分**的;对「学 Effect」是**加分**的。

## 复查条件

若 Effect 从「帮助」变成「理解障碍」——例如一个没接触过 Effect 的人 **30 分钟读不懂 `agent.ts`**:
退回分层手写版本,**保留** `domain.ts` 的 Schema 与 `makeTool` 工厂(Layer 才是可去的那层)。
