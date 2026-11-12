# 决策:Web 宿主压到三个文件,`_constants` / `_domain` / `_util` 内联

> 已接受 · 2026-11-12 · **`postJson` 一段已被 [`0088`](0088-http-api-declarative.md) 取代** · 所属设计 [`../designs/client/web/host.md`](../designs/client/web/host.md)
> 落点 `packages/client/web/src/host/` · 部分取代 [`0007-effect-http-host.md`](0007-effect-http-host.md) 的"文件拆分"一段

## 矛盾

0007 把宿主拆成 7 个文件(`main` / `routes` / `session` / `guard` / `_util` / `_domain` / `_constants`),
理由写的是"每层可单独读"。实际效果相反:

| 想回答的问题            | 要跳的文件                                       |
| ----------------------- | ------------------------------------------------ |
| 这个请求会被拦吗?       | `main`(谁装在前面)→ `guard`(判据)→ `_util`(实现) |
| `/api/turn` 收什么字段? | `routes`(路由)→ `_domain`(Schema)→ 再回 `routes` |
| 令牌 cookie 叫什么?     | `routes`(用)→ `guard`(种)→ `_constants`(名)      |

- 三个 `_` 文件合计 **128 行**,却贡献了 7 个文件里的 5 处跳转;每个都只服务 `host/` 内部
  (全仓 grep:除 host 自己,没有任何包引用它们)。
- 按 [`code-conventions.md`](../../code-conventions.md) 的判据,`_domain` 要"至少两个文件用"、
  `_util` 要"至少两处或公开 API 用";这里勉强满足的只是"文件数",不是"信息量"——
  `TOKEN_COOKIE` 一个字符串单独占一个文件。
- `guard.ts` 只有 `routes.ts` 一个消费者,却被抬成独立文件 + 独立测试文件。

## 处理

`host/` 从 7 个文件收敛到 4 个(加 1 个测试),边界只有一条:**框架 / 业务**。

| 文件                | 层   | 内容                                                             |
| ------------------- | ---- | ---------------------------------------------------------------- |
| `main.ts`           | 装配 | 常量(端口 / 绑定)+ 页面(prod `dist/` / dev 提示)+ 拼装 + `run`   |
| `framework.ts`      | 框架 | `postJson` / 响应与 NDJSON / 安全判据 / `nodeServer` / `run`     |
| `api.ts`            | 业务 | 安全闸策略、请求体 Schema、四条路由 + 404                        |
| `session.ts`        | 业务 | `Session` 服务 + `TurnEvent` / `SessionSummary` / `SessionShape` |
| `framework.test.ts` | 测试 | 框架层纯判定的单测(原 `_util.test.ts`,跟着被测物搬)              |

删除:`_constants.ts`、`_domain.ts`、`_util.ts`、`guard.ts`、`routes.ts`。

细节:

- `api.ts` 用 `// ── 安全闸 / 请求体 / 路由` 分区,**阅读顺序 = 请求经过顺序**;
  纯判定(`isLoopbackHost` / `isSameOrigin` / `hasToken` / `encodeNdjsonLine`)搬进 `framework.ts` 并导出给测试。
- `Guard` 仍是**全局**闸:由 `main.ts` 与页面层一起 `Layer.mergeAll`,静态产物也照旧被守(不变)。
- 请求体 Schema 直接写在路由旁边(`TurnBodySchema` / `OpenSessionBodySchema`),不再单开声明文件。
- 带 body 的路由统一走 `postJson(path, schema, handler)`:handler 第一参数即解好的 body,
  `effect/http` 的"形状藏在 effect 里"就不成问题;超长 body 的 413 一并收进助手。
- `session.ts` 顺手收掉 `titleOf` 里的重复 `_tag` 判断(外层与内层各判一次)。

## 为什么

- **一个文件读完一条链路**:拦不拦 → 收什么 → 干什么,都在 `api.ts` 里顺序排好,不用来回跳。
- **判据回到"谁在用"**:`host/` 的这些都只有一个使用方,内联才是诚实的;真要复用,
  客户端侧(`src/_util.ts`)本来就有自己的一份。
- **改动面窄**:只有 `host/` 内部与两个注释、设计文档跟着改;浏览器代码、API 形状、鉴权语义一行没动。

## 代价

- `api.ts` 207 行、`session.ts` 214 行,过了"一屏"的长度;靠分区注释撑,不靠文件边界。
- 通用约定被打破:`host/` 不再有 `_constants` / `_domain` / `_util`,新人按 `code-conventions.md`
  去找会扑空(已在 `code-conventions.md` 留一句指过来)。
- 纯判定的单测现在 `import "./api.ts"`,会连带加载 `session.ts` → `@archive001/agent/live`;
  单测 430ms(含 import 82%),比只引一个工具文件慢,但仍在"零等待"范围。

## 复查条件

1. **`api.ts` 超 300 行或出现第 5 条路由** → 按"能花钱 / 只读 / 配置"切开,而不是再拆三个 `_` 文件;
   优先切"路由组"(`routes/turn.ts` 这类),让测试能只引它。
2. **某段纯判定被第二个包引用**(例如 `repl` 也要回环判断)→ 那时它才够格进 `_util`;
   别再为了"目录整齐"把它留在 `api.ts` 复制。
3. **要给路由写集成测试**(现在只有纯判定)→ 抽 `app.ts` 只出 `Routes` Layer,`main.ts` 只留进程装配;
   这一步是因为"测试要绕开 `runMain`",不是因为"文件太多"。

## 补充(同日):框架件单独放 `framework.ts`

第一版把框架件和业务混在 `api.ts`(144 行里约一半是 `effect/http` 的接线)。被指出"框架层的东西该单独放"
之后,当场拆开:

| 进 `framework.ts`(换业务也能用)                                                                                                                               | 留在 `api.ts`(archive001 的事)                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `postJson`(schema → 签名 + 413)、错误族(`HTTP_ERR_BAD_REQUEST` / `_UNAUTHORIZED` / `_NOT_FOUND` / `_TOO_LARGE` / `_SERVICE_UNAVAILABLE`,一律 thunk)、`ndjson` | 令牌 cookie 名、`Guard` / `RequireToken` 策略 |
| `isLoopbackHost` / `isSameOrigin` / `hasToken` / `newTokenCookie`                                                                                             | 请求体 Schema(Turn / OpenSession)             |
| `nodeServer`(EADDRINUSE 说人话)/ `run`(日志 + `Layer.launch`)                                                                                                 | 四条路由 + JSON 404                           |

- **代价**:文件从 3 个回到 4 个(+1 测试);读一条请求要跨两个文件。
- **为什么还是做**:这不是"按层切文件",是**一条真实接缝** —— 左列跟 `archive001` 没有任何关系,
  改业务时不该碰到;真有第二个本地宿主时,这个文件能整体搬走。
- **没做的事**:不抽成独立包(`packages/platform/http`)。只有一个消费者时不值得为它建包边界;
  等第二个使用方出现再搬。
