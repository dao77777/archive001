# 决策:`loop/llm.ts` 改名 `loop/engine.ts`(函数 `llmStateMachine` → `engine`)

> 已接受 · 2026-10-24 · 纯改名,行为不变 · 落点 `packages/agent/src/loop/engine.ts` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md#内部实体)

## 矛盾

`loop/` 里同时有:

```
packages/agent/src/llm/       ← 模型层(Llm 服务、两条 wire)
packages/agent/src/loop/llm.ts ← 循环层的状态机
```

两个 `llm` 指的是完全不同的东西:一个是"怎么跟模型说话",一个是"什么时候说、说完以后干什么"。
后果是实际的:

| 问题                | 表现                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| 读 import 得看目录  | `import { llmStateMachine } from "./llm.ts"`(loop 里)与 `from "../llm/llm.ts"` 长得很像 |
| 讨论时说不清        | "llm.ts 里那个循环"到底指模型层还是状态机,得补一句"loop 下的"                           |
| 事件名早就叫 engine | `ENGINE_START` / `ENGINE_END` / `ENGINE_ERROR`,代码里却叫 llm 状态机                    |
| 文档索引两处同名    | `llm.md`(模型层)与 `loop.md` 里的 `llm.ts` 混在一起                                     |

## 处理

文件改名 `loop/llm.ts` → `loop/engine.ts`,导出函数 `llmStateMachine` → `engine`:

```ts
// loop/loop.ts
run: engine(llm, inbox, executor, config, events.publish),
```

- 文件头注释改为"**实体二:engine(llm 的状态机)**" —— 保留"状态机"这个词,它仍然是状态机;
- `loop/` 下四个实体文件现在互不撞名:`inbox.ts` / `tool-executor.ts` / `engine.ts` / `events.ts`;
- 文档同步:`loop.md` 的实体表、`AGENTS.md` 的实体列表;`0010` 里"状态机搬到 `loop/llm.ts`"加一行注记。

## 为什么

- **名字跟事件走**:对外发的是 `ENGINE_*`,内部叫 engine 才对齐;`llm` 这个词留给 `llm/` 那一层;
- **`loop/` 自洽**:四个文件各是一个实体,名字一眼能分;
- **成本几乎为零**:只有一个 import 点,行为不变。

## 代价

- **历史指针会失效**:`docs/logs/` 里旧记录说 `loop/llm.ts` / `llmStateMachine`,不改(日志只增不改),
  搜索旧名字时会落到历史记录;
- **`llm` 与 `engine` 的新分工要记住**:`llm/` = 模型交互,`engine.ts` = 循环状态机 ——
  第一次读代码的人仍可能先猜"engine 是不是模型" ;
- **函数名 `engine(...)` 很短**,在 `loop.ts` 里 `run: engine(...)` 看不出它返回 `Effect<never>`;
  类型注解兜着,但要读签名。

## 复查条件

1. **`engine.ts` 继续长大**(回放规则、压缩、并发调度都塞进来):按职责拆文件
   (比如 `engine/loop.ts` + `engine/transcript.ts`),那时"一个文件一个实体"的说法要跟着改。
2. **出现第二个"引擎"概念**(比如多引擎 / 子代理):`engine` 这个名字不再唯一,
   改成 `conversation-engine` 或按层命名;别用 `engine2`。
3. **外部文档 / 包引用旧路径**(有人 `import ... from "@archive001/agent/loop/llm.ts"`):
   子路径本来不导出,若真出现,加一个 re-export 并标注 deprecated,不要直接删。
