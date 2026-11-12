# 决策:宿主改用 `effect/http-api` 声明端点,handler 拿类型化的 `payload`

> 已接受 · 2026-11-12 · 所属设计 [`../designs/client/web/host.md`](../designs/client/web/host.md)
> 落点 `packages/client/web/src/host/` · 部分取代 [`0087-web-host-flat.md`](0087-web-host-flat.md) 的 `postJson` 一段

## 矛盾

0087 之后剩一个手工助手:

```ts
const turn = postJson(`${API_PREFIX}/turn`, TurnBodySchema, (body) => …);
```

它只解决"**POST + JSON**"这一种组合。`effect/http` 里每种来源各有解码器
(`schemaBodyJson` / `schemaBodyForm` / `schemaBodyUrlParams` / `schemaBodyMultipart` /
`schemaSearchParams` / `schemaHeaders` / `schemaCookies`,路径参数走 `HttpRouter.params`),
但 `HttpRouter.add` 的 handler 只有 `(request: HttpServerRequest)`,**每加一种来源就要再写一个助手**,
签名还会越来越像 `route(method, path, parts?, handler)` —— 等于把 http-api 重写一个不完整的私有版。

同时 `postJson` 内部要手写 413、错误响应要手写状态码,和 `HTTP_ERR_*` 的 thunk 各管一段。

## 处理

改用 `effect/http-api`,契约与实现都是声明式的:

```ts
// 声明:收什么 / 回什么 / 错什么,一处说清
E.post("turn", "/api/turn", {
  payload: TurnBody,
  success: HttpApiSchema.StreamUint8Array({ contentType: "application/x-ndjson; charset=utf-8" }),
  error: [BadRequest, ServiceUnavailable],
});

// 实现:payload 的类型就是 TurnBody 解出来的类型
handle("turn", ({ payload }) => Effect.gen(function* () {
  if (apiKey === undefined) return yield* Effect.fail({ _tag: "ServiceUnavailable", error: … });
  return session.turn(payload.input.trim(), settings).pipe(Stream.map(encodeNdjsonLine));
}));
```

配套调整:

| 原来                                                  | 现在                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `postJson(path, schema, handler)`                     | 端点里的 `payload: schema`,handler 直接解构 `{ payload }`                     |
| `HTTP_ERR_BAD_REQUEST` / `_SERVICE_UNAVAILABLE`       | `HttpApiSchema.status(400/503)(Struct({ _tag, error }))` + `Effect.fail(...)` |
| `RequireToken` 路由级中间件                           | 合进 `Guard`:按路径集合(`turn` / `reset` / `sessions/open`)判令牌             |
| 413 在 `postJson` 里                                  | 合进 `Guard`:带 body 的请求先看 `content-length`                              |
| `ndjson(stream)` 返回 `HttpServerResponse`            | handler 直接返回 `Stream<Uint8Array>`,`content-type` 来自 success schema      |
| `/api/turn` 手动 `content-type: application/x-ndjson` | 由 `StreamUint8Array({ contentType })` 提供(实测一致)                         |

`main.ts` 只多一行装配:`HttpApiBuilder.layer(Api).pipe(Layer.provide(ApiLive), Layer.provide(Etag.layer))`,
其余(静态产物、dev 提示、JSON 404、`Guard`)照旧合并进 `HttpRouter`。

## 为什么

- **一处声明、处处有型**:payload / 响应 / 错误都在端点定义里;handler 不可能"忘记解 body",
  也不可能返回没声明过的形状。
- **不再自己写解码助手**:第二种来源(表单、multipart、path 参数、query)出现时只要在端点里加字段,
  不需要再造 `postForm` / `getWithParams`。
- **`Schema` 的错误直接回 400**,不用每条路由手写 `badRequest`;状态码来自 `HttpApiSchema.status`,
  同一个端点能同时声明 400 与 503。
- **白拿**:类型化 client 与 OpenAPI(`HttpApiSwagger`)以后要用时不必重写路由层。

## 代价

- **契约与实现分两处**:读"这端点收什么"要去上面看声明,读"怎么处理"在下面 —— 一条路由不再是一整块。
- **多一层依赖**:`HttpApiBuilder.layer` 额外要 `Etag.Generator`(已挂 `Etag.layer`)、`FileSystem` / `Path` /
  `HttpPlatform`(随 `NodeHttpServer` 来),以及 group 服务。
- **错误体从 `{ error }` 变成 `{ _tag, error }`**:带 body 的 400 / 503 多了 `_tag`(为了让同一端点的两种错误
  能被区分开);而 `Schema` 解码失败(如 `{"input":123}`)是 http-api 自己的 **空体 400**,文案不如以前。
- **401 / 404 / 413 仍是 `framework.ts` 的裸响应**(它们由中间件与兜底路由产生,不参与端点类型)—— 错误家族
  因此分成了"闸里三条"和"端点里两条"两半。
- **`cache-control: no-store` 没了**(http-api 自己定响应头);NDJSON 目前不缓存也不受影响。
- `effect/http-api` 与 `effect/http` 一样标着 `@stability unstable`,升 Effect 要一起看。

## 复查条件

1. **想同时拿到 401/404/413 的文案** → 把这三条也写成 `Schema.Class`(带 `httpApiStatus` 注解 + `HttpServerRespondable`)
   并入端点错误,`framework.ts` 的 `HTTP_ERR_*` 随之删除;代价是每个端点都要把三条错误列进 `error`。
2. **需要 Swagger / 类型化 client** → 直接 `HttpApiSwagger.layer(Api)`,并把 `api.ts` 的 Schema 提到可导出位置。
3. **`api.ts` 超 300 行或端点超 8 条** → 按组拆(`groups/turn.ts` / `groups/sessions.ts`),`HttpApi.make(...).add(...)`;
   不要退回 `HttpRouter.add` + 手写助手。
4. **`StreamUint8Array` 行为变了**(它同样标 unstable)→ 退回 `HttpRouter.add` 单写 `/api/turn`
   (其余保持 http-api),这是唯一一条值得为稳定性单独开洞的路由。
