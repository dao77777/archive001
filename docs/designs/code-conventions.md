# 代码现状与风格

> 两层设计见 [`agent/loop.md`](agent/loop.md) / [`agent/llm.md`](agent/llm.md)。
> 这份是**当前写法的快照**,不是规范:每条都可以改,改了把理由写进 `docs/decisions/` 即可。

## 1. 分层与依赖

```
客户端包 ──► 内核(SDK) ──► Agent ──► Llm ──► platform
```

- 依赖目前是单向的;反向 import 会让"内核不认识客户端"这条边界消失。
- 客户端目前只从 `@archive001/agent` 导入(不走包内路径),好处是内核能自由搬文件。
- 内核对 Console / ANSI 无感知:它只发 `ArchiveEntry`,渲染留给客户端。

## 2. 文件与目录

| 现状                           | 说明                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| 每个包一份 `tsconfig.json`     | extends 根,自己写 `include` / `lib`(web 才有 `DOM`)                                 |
| `_constants / _domain / _util` | 见下表:常量 / 声明 / 跨模块小助手;`_domain` 只放声明(类型、Schema、错误类),不放函数 |
| `index.ts` 只转发              | `export { … } from "./xxx.ts"`;逻辑在 `xxx.ts`                                      |
| 一个客户端一个包               | `packages/client/<名字>`,互不依赖                                                   |
| 单复数                         | 装多个同类实例用复数(`_constants` / `tools`);一个角色用单数(`llm.ts` / `repl.ts`)   |

**三件套的判据**(语义决定去处,不是"顺手放哪"):

| 文件            | 放什么                                 | 判据                                                           | 例                                                       |
| --------------- | -------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| `_constants.ts` | 常量与配置值                           | 只有字面量 / 表达式,没有参数、没有分支                         | env 名、`TOOL_MAX_OUTPUT`、超时、提示词、端口、cookie 名 |
| `_domain.ts`    | **跨文件共用**的类型 / Schema / 错误类 | **只有声明**,且**至少两个文件用**;自己一个文件用的放回那个文件 | `Item` / `LlmError`(llm)、`ArchiveEntry`(archive)        |
| `_util.ts`      | 跨模块共用的小助手                     | 纯函数 / 构造器,被**至少两处**或**公开 API** 用                | `formatError`、`paint`、`previewArguments`               |

一条有意为之的例外,别当成错误:

**模块内的私有辅助留在模块里**(`chat-completions.ts` 的 `toWireTool`、`responses.ts` 的 `toWireItem`、
`tool-executor.ts` 的 `runTool` / `truncate`):只服务本模块,搬走反而要多跳一层、多一次 import,
还容易让"这个函数谁都在用"的错觉留下来。

**branded 类型的构造器贴着类型放**(`archive/service.ts` 的 `makeArchiveEntryId` / `newArchiveEntryId`):
brand 的类型和造值方式是一条契约,拆到 `_util.ts` 会让"只有声明"这条更值钱的约定变成错觉;
运行期它们只是 identity / `randomUUID()`,没有逻辑可测。

**`make` = 输入决定值,`new` = 每次都是新身份**。检验:再调一次能不能得到"相等"的东西?
能 → `make`(`makeArchiveEntryId("e1")`、`Ref.make(0)`);
不能(第二次必然不同、无输入、碰随机源/时钟)→ `new`(`newArchiveEntryId()`)。
名字本身就是信息:在"不该造新身份"的地方出现 `new*` 会扎眼。不用 `create` 当第三个词。

⚠️ 抽检口径(改完顺手跑一次):`grep -nE "^(export )?(const|function|class|interface|type) " <file>` 看每个顶层声明落在哪一类。

### 文件级顺序(服务型模块)

一个"服务 + 实现"的文件固定四段(`XxxLive` 跟在其后,不再单独标段);**没有内容就整段去掉**(不留空框);`service.ts` 只有定义,不分段:

| #   | 段   | 放什么                                         | 例                                        |
| --- | ---- | ---------------------------------------------- | ----------------------------------------- |
| 1   | 常量 | 只本文件用的字面量 / 表达式                    | `SINK_BATCH_MAX`、`SINK_RETRY_SCHEDULE`   |
| 2   | 工具 | 不碰状态的纯函数 / 守卫                        | `hasRejected`、`hasEntries`、`removeById` |
| 3   | 类型 | 本文件的类型声明:内部数据形状在前,对外形状在后 | `Step`、`InboxProjection`、`Projections`  |
| 4   | 服务 | `XxxShape` + `Xxx` Tag                         | `ProjectionShape` / `Projection`          |

顺序的道理:常量与工具是**零件**,类型是**数据长什么样**,服务是**对外承诺什么**,实现是**怎么跑**。
实现(`XxxLive` / `FileSinkLive` / `MemorySinkLive`)紧跟在后面,不另立段;它的 `Effect.gen` 内部
**照样分块**(依赖 → 状态 → 方法 → 初始化 → 对外方法),空段整段去掉。
"方法"与"对外方法"的界线是**有没有交出去**:`Sink.of({ write, read })` 里的 `write` / `read` 属于对外方法,
只被本文件内部调用的(`takeBatch` / `writeBatch` / `foldEntry`)才归"方法"。

**契约与实现分文件**:一个服务一个目录,目录里 `service.ts` 是契约(`XxxShape` + `Xxx` Tag + 方法签名里用到的类型),
`live.ts` / 其它文件是实现(`archive/` 与 `loop/` 都是这套样板,见 `0081`)。
`service.ts` **只有定义**:不加四段分区,文件头说清"是什么"即可。

**服务对象的字段先提成具名常量,组装处只做 `Xxx.of({ a, b })`**(`archive.ts` 的
`append` / `errors` / `readAll` / `projection`、`sink/file.ts` 的 `write` / `read`):字面量里内联实现会让
"对外有哪几个能力"和"每个能力怎么实现"黏在一起,也挡住单个字段的 `/** */` 说明。
`XxxLive` 紧跟"服务"段之后,**不再单独加段标题**(它在文件末尾、只有一份,不需要导航)。
自己一个文件用的类型 / 函数不搬进 `_domain.ts` / `_util.ts`(见 0063);服务自己的类型放它的 `service.ts`(`Tool` 在 `tool-executor/service.ts`、`LoopConfig` 在 `loop/service.ts`)。

⚠️ 抽检口径:`grep -nE "^(export )?(const|function|class|interface|type) " <file>` 逐条对照上表。

## 3. 注释

> 可抄的完整样板(文件头 / 分区 / `service.ts` + `live.ts` 骨架)：[`../examples/service-file-layout.md`](../examples/service-file-layout.md)。

| #   | 现状                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 每个源文件以 `//` 文件头开始(在 imports 之前):1–3 行"是什么 + 边界"。要放数据流示意、或说明超过几行时,用 `// ═══` **双线**上下各一条框住,两条之间不再夹线(见 `archive/service.ts`) |
| 2   | 文件内分区用 `// ---` / 标题 / `// ---` **单线**三条,标题写"这一段做什么",不编号                                                                                                   |
| 2b  | **视觉层次固定**:文件头 `═` 双线 > 分区 `─` 单线 > 单条 `/** */`;三种框同宽(78 列),缩进跟代码走                                                                                    |
| 3   | 导出项要么自己有一行 `/** */`,要么所在分组已有说明;派生声明(`const X = Schema…` + `type X = typeof X.Type`)不重复写                                                                |
| 4   | 行内 `//` 只写**为什么 / 坑 / 契约**,不复述代码                                                                                                                                    |
| 5   | 警告用 `⚠️` 开头,并写清"违反会怎样"                                                                                                                                                |
| 6   | 中文全角标点;代码用反引号;英文与数字两侧留空格                                                                                                                                     |
| 7   | 引用写相对路径或 `docs/...`,不写绝对路径                                                                                                                                           |
| 8   | 注释里没有注释掉的旧代码、无主 TODO、作者日期                                                                                                                                      |
| 9   | **注释只写现状**,不写历史("以前是 X""改成 Y""已被 Z 取代")—— 历史在 `docs/logs/` 与 `docs/decisions/`                                                                              |
