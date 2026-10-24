# 代码现状与风格

> 两层设计见 [`agent/loop.md`](agent/loop.md) / [`agent/llm.md`](agent/llm.md)。
> 这份是**当前写法的快照**,不是规范:每条都可以改,改了把理由写进 `docs/decisions/` 即可。

## 1. 分层与依赖

```
客户端包 ──► 内核(SDK) ──► Agent ──► Llm ──► platform
```

- 依赖目前是单向的;反向 import 会让"内核不认识客户端"这条边界消失。
- 客户端目前只从 `@archive001/agent` 导入(不走包内路径),好处是内核能自由搬文件。
- 内核对 Console / ANSI 无感知:它只发 `AgentEvent`,渲染留给客户端。

## 2. 文件与目录

| 现状                           | 说明                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| 每个包一份 `tsconfig.json`     | extends 根,自己写 `include` / `lib`(web 才有 `DOM`)                                 |
| `_constants / _domain / _util` | 见下表:常量 / 声明 / 跨模块小助手;`_domain` 只放声明(类型、Schema、错误类),不放函数 |
| `index.ts` 只转发              | `export { … } from "./xxx.ts"`;逻辑在 `xxx.ts`                                      |
| 一个客户端一个包               | `packages/client/<名字>`,互不依赖                                                   |
| 单复数                         | 装多个同类实例用复数(`_constants` / `tools`);一个角色用单数(`agent.ts` / `repl.ts`) |

**三件套的判据**(语义决定去处,不是"顺手放哪"):

| 文件            | 放什么                                       | 判据                                                                     | 例                                                                            |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `_constants.ts` | 常量与配置值                                 | 只有字面量 / 表达式,没有参数、没有分支                                   | env 名、`MAX_STEPS`、超时、提示词、端口、cookie 名                            |
| `_domain.ts`    | 类型 / Schema / 错误类 / 选项对象 / 服务形状 | **只有声明**;`Schema.Struct(...)` 算声明,`export const x = () => …` 不算 | `AgentEvent`、`Observer`、`Tool`、`AgentShape`、`TurnEvent`、`LlmError`       |
| `_util.ts`      | 跨模块共用的小助手                           | 纯函数 / 构造器,被**至少两处**或**公开 API** 用                          | `makeTool`、`runTool`、`formatError`、`truncate`、`paint`、`previewArguments` |

一条有意为之的例外,别当成错误:

**模块内的私有辅助留在模块里**(`chat-completions.ts` 的 `toWireTool`、`responses.ts` 的 `toWireItem`):
只服务本模块,搬走反而要多跳一层、多一次 import。

⚠️ 抽检口径(改完顺手跑一次):`grep -nE "^(export )?(const|function|class|interface|type) " <file>` 看每个顶层声明落在哪一类。

## 3. 命名

| 对象        | 现状                                                  | 例                                    |
| ----------- | ----------------------------------------------------- | ------------------------------------- |
| 类型        | 单数;集合用 `ReadonlyArray<T>`                        | `Item` 而不是 `Items`                 |
| 服务 Tag    | 单数,`XxxLive` 是它的 Layer                           | `Agent` / `AgentLive`                 |
| `Item` 助手 | 跟 `Item.type` 走:`xxxOf` 取 item,`xxxTextsOf` 取文本 | `functionCallsOf` / `messageTextsOf`  |
| wire 助手   | 带上被处理的类型                                      | `partTextsOf`(`WireResponsesPart`)    |
| 函数        | 动词开头                                              | `toItems` / `runTool` / `formatError` |
| 常量        | 单值单数,一组参数用复数                               | `MAX_STEPS` / `DEFAULT_SETTINGS`      |

## 4. 注释

| #   | 现状                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | 每个源文件以 `//` 文件头开始(在 imports 之前):1–3 行"是什么 + 边界",不用 ASCII 大框                                 |
| 2   | 分区用 `// ---` / 标题 / `// ---`,不编号                                                                            |
| 3   | 导出项要么自己有一行 `/** */`,要么所在分组已有说明;派生声明(`const X = Schema…` + `type X = typeof X.Type`)不重复写 |
| 4   | 行内 `//` 只写**为什么 / 坑 / 契约**,不复述代码                                                                     |
| 5   | 警告用 `⚠️` 开头,并写清"违反会怎样"                                                                                 |
| 6   | 中文全角标点;代码用反引号;英文与数字两侧留空格                                                                      |
| 7   | 引用写相对路径或 `docs/...`,不写绝对路径                                                                            |
| 8   | 现在注释里没有注释掉的旧代码、无主 TODO、作者日期                                                                   |

## 5. Effect

| 做法                                             | 原因                                            |
| ------------------------------------------------ | ----------------------------------------------- |
| Layer 接线显式:`Layer.provide(dep)(self)`        | `mergeAll` 只合并需求,不满足依赖                |
| 依赖在**构造时固化**进闭包(spawner / HttpClient) | 让 `run`、`execute` 对调用方零依赖(`R = never`) |
| 领域错误用 `Data.TaggedError`                    | 进类型系统,可 `Effect.catchTag` 精确处理        |
| **工具错误不抛**,转字符串观测                    | 模型要看到错误才能纠正                          |
| 入口才读环境变量                                 | 内核与 llm 层只接受显式参数                     |
| 资源用 `Effect.acquireRelease` / `ensuring`      | 终端、子进程、文件句柄需要还原                  |

## 6. 测试

| 现状                              | 说明                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| 文件名跟被测对象                  | `agent.test.ts` ↔ `agent.ts`;没有逻辑的 `index.ts` 不配测试 |
| 一个测试一个行为                  | 名字说清"给了什么 → 期望什么"                               |
| 厂商交互用**本地 mock HTTP 服务** | 不起真服务、不用真 key;断言 URL / 头 / body 形状            |
| 外部边界用假实现替换服务          | `Layer.succeed` 假 `Llm` / 假 `Toolbelt`,测循环不测网络     |
| 真 key 只用于 `pnpm smoke`        | 人工跑,不进 CI                                              |

## 7. 文档

- 一切进 `docs/`,按生命周期分目录(`drafts` → `designs` / `decisions` → `knowledge`),目录规则见 `~/Code/AGENTS.md`。
- `decisions/` 里的取舍一旦接受就冻结:改主意新开一条 supersede,原文留着当历史。
- `logs/` 只增不改;`progress/` 覆盖式。
- 增删文档同步 [`../README.md`](../README.md) 索引。

## 8. 前端(Web 客户端)

| 现状                                            | 原因                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| 交互原语用 **Base UI**,逐个 import 用到的部件   | 只借行为 / 无障碍 / 定位;不引入成体系的设计(避免两套视觉语言)    |
| 样式走 Tailwind + `styles.css` 的 `@theme` 令牌 | 美术方向见 [`client/web/ui.md`](client/web/ui.md),不另立样式系统 |
| 原语 → 我们的外观,一层封装(`src/controls.tsx`)  | 不散落在 `app.tsx` 里                                            |
| 目前没有图标库 / 动画库                         | 现有排版用文字与几何;两条 keyframes 够用                         |

## 9. 工具链注意

**`vp` 靠 git 枚举文件**(`git ls-files --cached --others --exclude-standard`)。于是:

- 项目目录被**任意一级父仓 `.gitignore`** 排除时,`vp check/lint/fmt` 会报「No files found」,
  本地再写 `.gitignore` 也救不回来(`vp test` / `vp pack` 不受影响,它们自己解析配置)。
- 判别:`git check-ignore -v <某个源文件>`,有输出就说明被忽略了。
- 本项目目前在 `~/Code` 的 git 下可见(就是因为踩过这个坑才从 `_lab/` 搬出来的)。
