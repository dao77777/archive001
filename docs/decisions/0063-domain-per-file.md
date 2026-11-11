# 决策:`_domain.ts` 只留跨文件共用的声明,其余各回各家

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/loop/` · 规范见
> [`../designs/code-conventions.md`](../designs/code-conventions.md) ·
> 设计见 [`../designs/agent/inbox.md`](../designs/agent/inbox.md) 等实体文档

## 矛盾

`loop/_domain.ts` 长到 170 行,把五类完全不同的东西堆在一起:

| 里面有什么                                                     | 实际谁用                                      |
| -------------------------------------------------------------- | --------------------------------------------- |
| `EntryInput` / `EventPublisher` / `EventsShape`                | `events.ts`(发事件的口子)                     |
| `InboxPayloads` / `InboxMessage` / `ReadyBatch` / `InboxShape` | `inbox.ts`(消息 + 服务)                       |
| `ToolBatch` / `ToolExecutorShape`                              | `tool-executor.ts`                            |
| `AgentShape` / `PromptInput`                                   | `loop.ts`(Agent 对外形状)                     |
| `Spawner` / `ToolInputError`                                   | `builtin-tools.ts` / `_util.ts`               |
| `Tool` / `AgentConfig`                                         | 真的跨文件(`makeTool`、executor、engine 都要) |

后果是实打实的:

- **想知道 inbox 能交什么,得先跳到 `_domain.ts`** —— 而实现就在 `inbox.ts`,看起来像两个模块;
- **改一个实体要动两个文件**:服务形状在 `_domain`,实现在隔壁;
- **`_util.ts` 判据被打破**:它说"只放跨模块共用的助手",却成了"循环层所有声明的仓库";
- **读者以为一切都是共享的**:`Spawner` 只给 `builtin-tools` 用,却和 `AgentShape` 并排。

## 处理

按"归谁"分发,`_domain.ts` 只留**跨文件共用**的两个声明:

```
loop/
├── _domain.ts        ← Tool(工具契约) + AgentConfig(会话配置)
├── inbox.ts          ← InboxPayloads / InboxTag / InboxMessage / ReadyBatch / InboxShape
├── events.ts         ← EntryInput / EventPublisher / EventsShape
├── tool-executor.ts  ← ToolBatch / ToolExecutorShape
├── loop.ts           ← AgentShape / PromptInput
├── _util.ts          ← ToolInputError(makeTool 报的错)
└── builtin-tools.ts  ← Spawner(平台服务实例类型)
```

- 类型与它的服务/实现**同一个文件**:改形状不再跨文件;
- `_domain.ts` 25 行,只剩"真被多处引用"的两条,并把判据写进文件头;
- 外部引用跟着改:`archive/_domain.ts` / `archive/project.ts` 的 `InboxMessage` 改成
  `../loop/inbox.ts`(type-only),`index.ts` 的 SDK 导出按来源拆成两条。

## 为什么

- **一个词一个家**:`InboxShape` 就该在 `inbox.ts` 第一屏能看到;`AgentShape` 在 `loop.ts`;
- **减少"看一眼声明再跳到实现"的往返**:形状 + 实现同文件,改起来是一处;
- **`_domain.ts` 的判据重新可执行**:"被至少两个文件用"才进来,不是"想放声明就放这里";
- **服务边界更清楚**:`Spawner` 只是 `builtin-tools` 的平台依赖,不该出现在循环的公共面。

## 代价

- **出现了 type-only 环**:`archive/_domain.ts` → `loop/inbox.ts`,而 `inbox.ts` → `archive/_domain.ts`
  (`newArchiveEntryId`) —— 两边都是 `import type` / 单侧值导入,运行时没有循环,但读 import 图会看到往返;
- **`loop.ts` ↔ `engine.ts` 也有一对**:`engine.ts` 需要 `AgentConfig`/`EventPublisher`/`InboxShape`/
  `ToolExecutorShape`,分别从 `_domain` / `events` / `inbox` / `tool-executor` 拿,import 段变长;
- **`inbox.ts` 变成 190 行**:消息类型、就位规则、服务实现在一起;想看"就位规则"要先滚过类型;
- **一次性的迁移成本**:所有 `from "./_domain.ts"` 的引用都要对一遍来源(这次动了 10 个文件);
- **`_domain.ts` 只剩两条**:以后有人可能觉得"干脆删掉",那时 `Tool`/`AgentConfig` 要另找地方
  (见复查条件 1)。

## 复查条件

1. **`_domain.ts` 只剩一条或为零**:把 `Tool` / `AgentConfig` 并进各自最常用的一方
   (比如 `_util.ts` / `loop.ts`),然后删掉这个文件;**不要**为了"目录整齐"保留空壳。
2. **type-only 环真的出事**(比如有人改成值导入、或 `vp pack` 的 d.ts 生成报循环):
   把这些共享类型抽到一个中立的 `types.ts`(仍然只放声明),但只在真出问题时做。
3. **实体文件继续膨胀**(`inbox.ts` 过 250 行):按"消息类型 / 就位规则 / 服务"拆成
   `inbox/_domain.ts` + `inbox/inbox.ts`,而不是把声明塞回 `loop/_domain.ts`。
4. **新增一个实体**(比如 `turn.ts`):同样的判据 —— 自己的形状与消息放自己文件,
   跨实体的才进 `_domain.ts`。
