# 服务型文件的注释与分块样板

> 出处：`packages/agent/src/archive/{archive,sink,project}/`
> 依据：[`../designs/code-conventions.md`](../designs/code-conventions.md) §3「注释」与 §2「文件级顺序」。
> 用途：新增一个"契约 + 实现"的服务时，照着摆。

## 一、三层视觉层次

| 层级   | 记号                                | 作用                        | 宽度  |
| ------ | ----------------------------------- | --------------------------- | ----- |
| 文件头 | `// ═══` **双线**，首尾各一条       | 这个文件是什么 + 数据流示意 | 78 列 |
| 分区   | `// ---` **单线**三条（上下夹标题） | 这一段在做什么              | 78 列 |
| 单条   | `/** */`                            | 这个声明是什么              | ——    |

规则：

1. **文件头**：标题一行说"是什么 / 边界"，下面可放数据流示意图与 2–3 行说明；首尾两条双线之间**不再夹线**。
2. **分区**：标题写"这一段做什么"；**没有内容就整段去掉**，不留空框。
3. **方法分区直接列标识符**（`// 方法:takeBatch / writeBatch / drain`），不写中文描述 —— 方便 `grep`。
4. 行内 `//` 只写**为什么 / 坑 / 契约**，不复述代码；警告用 `⚠️` 开头并写清"违反会怎样"。
5. 注释只写**现状**，不写历史（"以前是 X""改成 Y"）—— 历史进 `docs/logs/` 与 `docs/decisions/`。

## 二、`service.ts`：只有定义

契约文件不分段，文件头 + 逐条定义即可（**没有**常量 / 工具 / 类型 / 服务 四个框）。

```ts
// ═══════════════════════════════════════════════════════════════════════════
// Example 契约:数据形状 + 服务形状
// ═══════════════════════════════════════════════════════════════════════════

import { Context, type Effect } from "effect";

/** 一条记录。 */
export interface ExampleRecord {
  readonly id: string;
}

/** 服务的形状。 */
export interface ExampleShape {
  /** 读一条;数据来自内存,不会失败。 */
  readonly get: (id: string) => Effect.Effect<ExampleRecord | undefined>;
}

/** 服务 Tag(实现见 `ExampleLive`)。 */
export class Example extends Context.Service<Example, ExampleShape>()("Example") {}
```

## 三、`live.ts`：实现

文件级分区固定四段：**常量 → 工具 → 类型 → 服务**（契约在 `service.ts` 时可省），
`XxxLive` 紧跟其后、**不单独标段**；它的 `Effect.gen` 内部按
**依赖 → 状态 → 方法 → 初始化 → 对外方法** 分块。任一空段整段去掉（下面每段都给了一行示例，
实际文件里没有内容的就删掉）。

```ts
// ═══════════════════════════════════════════════════════════════════════════
// Example:一句话说清它做什么
//
//   caller ──► append ──► 内存缓存 ──► worker ──► sink.write
//        └─ 返回"已接收",不等写完
//
// 一到两句补充:为什么这么摆、读侧看到的是什么。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Layer, Ref } from "effect";
import { Example, type ExampleRecord } from "./service.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 单批上限:积压时分多批,单批不会被无限放大。 */
const BATCH_MAX = 1024;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** 这批里有没有要处理的条目。 */
const hasEntries = (records: ReadonlyArray<ExampleRecord>): boolean => records.length > 0;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
/** 实现内部的数据形状:不进方法签名(如 `projection/live.ts` 的 `Step`)。 */
interface Pending {
  readonly id: string;
  readonly at: number;
}

/** 只依赖一个 `Sink`;具体实现由调用方提供。 */
export const ExampleLive: Layer.Layer<Example> = Layer.effect(
  Example,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const sink = yield* Sink;

    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------
    /** 已接收的记录;`append` 一进来就写这里,读侧立刻可见。 */
    const recordsRef = yield* Ref.make<ReadonlyArray<ExampleRecord>>([]);

    // -----------------------------------------------------------------------
    // 方法:takeBatch / writeBatch
    // -----------------------------------------------------------------------
    /** 取一批:取货即认领,同一事务。 */
    const takeBatch = Ref.modify(recordsRef, (records) => [records.slice(0, BATCH_MAX), []]);

    // -----------------------------------------------------------------------
    // 初始化:读底稿 → 填缓存 → 起 worker
    // -----------------------------------------------------------------------
    const initial = yield* readInitial(); // 底稿读失败按缺陷处理
    yield* Ref.set(recordsRef, initial);

    // worker:唯一碰队列、唯一写 sink 的纤维
    yield* Effect.forever(takeBatch.pipe(Effect.flatMap(writeBatch))).pipe(Effect.forkScoped);

    // -----------------------------------------------------------------------
    // 对外方法
    // -----------------------------------------------------------------------
    /** 读一条:只碰内存,不碰文件。 */
    const get = (id: string): Effect.Effect<ExampleRecord | undefined> =>
      Ref.get(recordsRef).pipe(Effect.map((records) => records.find((r) => r.id === id)));

    return Example.of({ get });
  }),
);
```

## 四、目录形态（一个服务一个目录）

```
example/
├── service.ts       契约:XxxShape + Xxx Tag + 方法签名里用到的类型(只有定义,不分段)
├── live.ts          实现:XxxLive(常量 → 工具 → 类型,然后 XxxLive)
└── live.test.ts     测试紧挨被测文件
```

多实现版本(如 `packages/agent/src/archive/sink/`):

```
sink/
├── service.ts       SinkShape + Sink
├── file.ts          FileSinkLive
├── memory.ts        MemorySinkLive
└── file.test.ts
```

`file.ts` / `memory.ts` 和 `live.ts` 一样是"四段 + 实现"，函数体同样分块:
`依赖 → 初始化 → 对外方法(write / read)`(见 `packages/agent/src/archive/sink/file.ts`)。
分块看的是**这段代码对谁可见**：`Sink.of` 里交出去的 `write` / `read` 是"对外方法"，
只在本文件内部被别的函数调用的才是"方法"。

## 五、自检

- `grep -nE "^(export )?(const|function|class|interface|type) " <file>` —— 逐条看它落在哪一段;
- 空段还在不在(有框无内容 = 删掉);
- 文件头首尾两条双线之间是否夹了多余的线(有就删)。
