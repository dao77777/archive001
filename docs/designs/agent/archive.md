# 设计:archive 持久化

> 路径 `packages/agent/src/archive/`。**服务的契约 `service.ts` + 实现 `live.ts` 直接放在 `archive/` 根,
> 子服务各占一个目录**:`sink/{service,file,memory}.ts`、`projection/{service,live}.ts`;循环设计见
> [`loop.md`](loop.md);异步取舍见 [`../../decisions/0031-async-archive.md`](../../decisions/0031-async-archive.md)
> 与 [`0034`](../../decisions/0034-archive-batch-flush-lock.md) / [`0040`](../../decisions/0040-pending-count.md) / [`0041`](../../decisions/0041-flush-subscription-ref.md) / [`0042`](../../decisions/0042-failure-state.md) / [`0043`](../../decisions/0043-flush-on-close.md) / [`0044`](../../decisions/0044-flush-internal.md) / [`0045`](../../decisions/0045-append-tx.md) / [`0046`](../../decisions/0046-tx-closed-flag.md) / [`0048`](../../decisions/0048-in-flight-batch.md) / [`0049`](../../decisions/0049-worker-owns-close.md);
> 读侧(投影)见 [`0058`](../../decisions/0058-archive-projection.md)。

## 文件

| 位置                  | 契约                                                                                                                                            | 实现                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `archive/`(根)        | `service.ts`:`ArchiveShape` + `Archive`、`ArchiveEntryId` + 构造器、`ArchiveEntryPayloads` / `ArchiveEntryTag` / `ArchiveEntry`、`ArchiveError` | `live.ts`:`ArchiveLive`(缓存 / worker / drain / append)              |
| `archive/sink/`       | `service.ts`:`SinkShape`(只有 `read` / `write`)+ `Sink`                                                                                         | `file.ts`:`FileSinkLive`(一路径一文件)、`memory.ts`:`MemorySinkLive` |
| `archive/projection/` | `service.ts`:`InboxProjection` / `Projections`、`ProjectionShape` + `Projection`                                                                | `live.ts`:`ProjectionLive`(STM 折叠)                                 |

## 职责

把 `ArchiveEntry` 按发生顺序追加到磁盘,**不阻塞调用方**。

`ArchiveEntry` / `ArchiveEntryPayloads` / `ArchiveEntryTag` 都在 `archive/service.ts`;它引用 `loop/inbox/service.ts` 的
`InboxMessage`(type-only 环),不反向依赖 archive 实现。

```
Agent.publish ──(补 v/at)──► Archive.append([entry]) ──┬──► 缓存(立刻可见)
                                                        └──► TxQueue<ArchiveEntry> ──► worker ──► Sink.write(batch)
                                                                  │
                                                                  └─ append 返回“已入队 / 已在缓存”，不等写完

读侧:Archive.readAll ──► 缓存(构建时以 Sink.read 为底稿,之后只碰内存)
      Archive.projection(kind) ──► 只折出要的那一类(engine 每步取 "transcript")
```

- sink 是存储适配器:`write`(单 writer 顺序调用) + `read`(构建时读一次底稿;之后读侧只碰缓存);
- **缓存在写队列之前**:`append` 一成功就接进缓存,所以 `readAll` / `projection` 是"实时的已接收视图"
  —— 可能包含还没落盘的条目,但永远不碰文件、不会失败;
- 读不依赖写:worker 写挂掉之后读侧照样能用(sink 里少了一批,内存里还在);
- 队列里**只有 `ArchiveEntry`**,没有 entry/flush 两种消息;
- `append` 批量入队,成功只代表**进了队列**,不代表落盘;
- 单 worker:`Effect.forever(取一批 >>= 写一批)`,`takeBatch` 用 `TxQueue.takeBetween(queue, 1, SINK_BATCH_MAX)`
  取 1…1024 条(积压时分多批),写走 `sink.write`(含重试);取货与"标记在飞"同一事务;
  批量上限与重试策略是 `archive.ts` 文件内的常量(只有它用);
- 关闭时外面什么都不做:scope 关掉 → worker 被中断 → 它自己的 finalizer 跑 `drain`
  (关闸 → 收拢"在飞的一批 + 队列残余" → 写进 sink),然后退出。

## 条目

`ArchiveEntry` 就是"事件 + v / at",没有嵌套的 `event`、也没有 seq:

```ts
type ArchiveEntry<T extends ArchiveEntryTag = ArchiveEntryTag> = {
  v: 1;
  at: number; // Agent.publish 时间（epoch ms）
  _tag: T;
  id: ArchiveEntryId;
  sessionId?: SessionId; // 所属会话;旧文件没有,读入时补 LEGACY_SESSION_ID
  parentId?: ArchiveEntryId;
} & ArchiveEntryPayloads[T];
```

一行一个 JSON:

```json
{"v":1,"at":...,"sessionId":"...","_tag":"ENGINE_START","id":"..."}
```

- `id` / `parentId` 是 branded 的 `ArchiveEntryId`:类型与构造器(`makeArchiveEntryId` / `newArchiveEntryId`)
  贴着放在 `archive.ts`,和 inbox id、`callId` 都是字符串但不是同一类,不能混传;
- `sessionId` 是 branded 的 `SessionId`(`newSessionId` / `makeSessionId`):一个文件里可以有多段会话,
  entry 按它分组;旧文件没有这个字段,`ArchiveRuntime` 读入时归到 `LEGACY_SESSION_ID`;
- 还没有 `archiveId` / `seq`;顺序由**文件行序**决定(单 writer、append-only);
- `at` 只是诊断时间,不承担排序。

## API

```ts
interface ArchiveShape {
  /** 批量入队;成功 = 已经进队列,不代表落盘。没有 sessionId 的条目挂到当前会话。 */
  readonly append: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void, ArchiveError>;
  readonly readAll: Effect.Effect<ReadonlyArray<ArchiveEntry>>; // 所有会话
  readonly readSession: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<ArchiveEntry>>;
  readonly currentSession: Effect.Effect<SessionId>;
  readonly sessions: Effect.Effect<ReadonlyArray<SessionId>>;
  readonly startSession: Effect.Effect<SessionId>; // 开新会话并切过去
  readonly useSession: (sessionId: SessionId) => Effect.Effect<void>;
  readonly projection: <K extends keyof Projections>(kind: K) => Effect.Effect<Projections[K]>;
}

interface SinkShape {
  /** 批量写；同一时间只会有一个调用（单 writer）。 */
  readonly write: (entries: ReadonlyArray<ArchiveEntry>) => Effect.Effect<void, ArchiveError>;
}
```

- `append` 的失败只表示“没进队列 / 正在关闭 / writer 已失败”；
- 收尾不对外暴露：它就是 layer 关闭的一部分（关闸 → 唤醒 worker → 等它写完退出）；
- `Sink` **没有 flush**：不要求 fsync，只要求批量写完成。

## 文件

```
~/.local/state/archive001/sessions/
├── b6818317-52e7-4013-ae9b-9f8d2369a180.jsonl   ← 一个会话一个文件
└── 0f2c…-.jsonl
```

- **文件名 = 会话 id**(只留 `[A-Za-z0-9_-]`;被改过的补短哈希,防 `/`、`..` 逃出目录与撞名);
- 写:一批条目按 `sessionId` 分组,各自追加到自己的文件;路径由 `file.ts` 固定,**调用方不知道写到哪**;
- 读:目录下每个 `*.jsonl`,各自解析后按 `at` **稳定**归并
  (`ArchiveRuntime` 用"最后一条"决定默认回到哪段会话,所以不能拿目录顺序凑);
- **不兼容旧格式**:条目没有 `sessionId` 直接失败,没有"兜底会话";分文件之前的数据已删除;
- 目录 `0700`、文件 `0600`;只追加(`flag: "a"`),单 writer;
- 不 fsync;关闭只保证写进 sink,不保证落盘;
- 进程被 `kill -9` 时,队列里未写的条目会丢——这是 fire-and-forget 的代价。

## 关闭:worker 自己的 finalizer

没有 `pending` 计数、没有 `closing` 信号、没有 layer 级 finalizer —— **外面不参与关闭**。

```ts
queue: TxQueue<ArchiveEntry>; // 已接受、还没人取
writing: TxRef<Option<ReadonlyArray<ArchiveEntry>>>; // worker 手上正在写的那批
```

一条 entry 只可能在两处:**队列里**,或 **worker 手上**。worker 自己的 finalizer 读的正是这两处:

```ts
// 中断时(scope 关闭 / 纤维被 interrupt)在 onInterrupt 里做:
{
  closed = true;                                     // 先关闸:append 一律失败,队列不再增长
  const rest = [...writing, ...TxQueue.clear(queue)]; // 手上这批在前,队列残余在后
  writing = None;
  if (rest.length > 0) sink.write(rest).retry(...);   // 一次写完
}
```

worker 本体只剩循环:

```ts
while (true) {
  batch = tx(takeAll(queue) + writing = Some(batch)); // 取货即认领,同一事务
  sink.write(batch).retry(...);
  writing = None;                                     // 写成功才放下
}
```

- 取货与 `writing = Some` **必须同一事务**:释放逻辑拿"`writing` + 队列"当全部残余,
  分开提交会在两次提交之间丢一批;
- 写成功之后才清 `writing`;在它之前被中断,这批就由 `onInterrupt` 里的收尾补写;
- 收尾用 **`Effect.onInterrupt`** 挂,不是 `addFinalizer` / `ensuring`:那两个在**失败时也会跑**,
  而"失败之后不写"是语义的一部分;`onInterrupt` 只挑中断,失败路径天然不需要额外判断;
- 收尾先关闸再清队列,所以"关闸前已接受"的都在 `clear` 里,关闸后 `append` 直接失败;
- 顺序由拼接决定:手上这批先于队列残余。

**为什么释放放在 worker 里**:

- **只有 worker 知道"手上有没有活"**:那份信息本来在栈上,只有中断时栈没了才需要 `writing`
  这个记账;外面想知道就得维护镜像 + 判据(见 [`0048`](../../decisions/0048-in-flight-batch.md));
- **单写者**:释放和正常写入是同一个纤维,不存在"谁先谁后";
- **不需要交互**:没有信号、没有 join、没有"等 idle",layer 里连 finalizer 都不用注册。

代价(必须知道):

- ⚠️ **中断发生在写盘中间时,这一批会被再写一遍**:sink 的结局不可知,补写是唯一能"不丢"的做法,
  代价和重试一样 —— JSONL 里可能出现半行 / 重复行。这是刻意选的"宁可重复";
- 关闭要等这段收尾写完(sink 卡住 = 关闭卡住),而且其中的写也会被二次中断截断;
- `Effect.forkScoped` 必须带 `startImmediately: true`:否则 scope 关得比"第一次调度"还快时,
  fiber 一行都没跑、`onInterrupt` 根本没注册上,释放逻辑连存在都没存在过;
- 失败路径不补写(失败语义):`catch` 里关闸 + 置 `failure`,队列丢弃,`writing` 一并作废。

## 门与释放

没有 `OPEN / FLUSHING / CLOSED` 状态字段,只有三样东西:

| 东西                                             | 作用                                        |
| ------------------------------------------------ | ------------------------------------------- |
| `closed: TxRef<boolean>`                         | 事务内闸门;`true` 后 append 失败,且不再打开 |
| `writing: TxRef<Option<Batch>>`                  | worker 手上正在写的那批;中断时由收尾补写    |
| `failure: SubscriptionRef<Option<ArchiveError>>` | 失败状态:worker 失败时变成 `Some`           |

- `append`:在 `Effect.tx` 里 `TxRef.get(closed)` → `TxQueue.offerAll(queue, entries)`:
  - 已关闭 → 事务整体失败,不会入队;
  - 入队失败 / 事务中断 → 整个事务回滚,不需要手写 rollback。
- 关闭:没有显式步骤。scope 关闭 → `forkScoped` 的中断 → worker 的 `onInterrupt`(收尾)。
- 失败:关闸 + 置 `failure`,队列里剩下的不写(失败语义),worker 自行退出。

### 写盘为什么在事务外

`sink.write` 是 I/O,还带重试,进不了 `Effect.tx`(事务体会重跑,而且整段不可中断)。
这不影响正确性:只有 worker 一个写者,`writing` 只是给"中断后的自己"留的记账,不是给别人的判据。

- 为什么不用 `Semaphore(1)` 做闸门 → [`../../decisions/0046-tx-closed-flag.md`](../../decisions/0046-tx-closed-flag.md)。

## 重试

`sink.write(batch)` 失败后会重试，而不是立刻把 archive 判死：

```ts
const retrySchedule = Schedule.recurs(SINK_RETRY_TIMES).pipe(
  Schedule.addDelay(() => Effect.succeed(SINK_RETRY_DELAY)),
);

yield * sink.write(batch).pipe(Effect.retry(retrySchedule));
```

- `SINK_RETRY_TIMES = 3`：第一次尝试之外最多再试 3 次；
- `SINK_RETRY_DELAY = "10 millis"`：固定间隔（本地磁盘够用，不做指数退避）；
- 重试的是**同一批**，成功一次就继续；
- 3 次后仍失败 → 进入下面的失败流程。

⚠️ 文件 sink 的 `writeAll` 失败时可能已经写入了一部分字节；重试会再写一遍，
极端情况下 JSONL 里会出现半行 / 重复行。当前接受这个代价；要严格避免需要
sink 侧支持幂等或失败后截断。

## 失败

- 重试耗尽后 worker 失败，两件事按顺序：
  1. `TxRef.set(closed, true)`（关闸，之后 `append` 直接在事务里失败）；
  2. `SubscriptionRef.set(failure, Option.some(error))`（失败状态，`errors` 的来源）。
     之后 worker 退出，队列里还没写的条目丢弃（失败之后不写）。
- `append` **不订阅失败**：只查事务内的 `closed`，所以失败之后仍然是一条 `TxRef.get` 就返回，
  不做任何 `Stream` 订阅 / 纤维 fork。
- 失败本身走 `ArchiveShape.errors`（`changes(failure)` 过滤 `Some`，一次性）：
  - 新订阅者先拿到当前值，所以已经挂了再订阅也能收到；
  - `Agent` 把它转成 `ARCHIVE_ERROR` 内容事件推到自己的总线（见下）。
- 事务保证 `append` 要么整体提交、要么整体回滚：`append` 只碰 `closed` 和队列，没有第二份状态要同步。

`Agent.publish` 对 `append` 失败仍然是 `Effect.ignore`：实时事件继续，不阻断对话；archive 的终态
错误由 `Agent.events` 上的 `ARCHIVE_ERROR` 暴露（绕过 archive 直接推总线，因为它自己就是坏的）。

## 关闭

`ArchiveLive` **不注册任何 finalizer**。关闭就是 scope 关闭:

- 用 `forkScoped`,**不是 `forkChild`**:`forkChild` 依附的是"构建 layer 的那个 fiber",
  那个 fiber 不归我们管(有人在 `Layer.buildWithScope` 的短命 fiber 里建层,worker 就当场死掉:
  实测 builder 结束即停摆,而 scope 还开着)。`forkScoped` 依附 layer 的 scope,才是"随服务生灭";
- `{ startImmediately: true }` 让 worker 立刻开跑(见下);
- scope 关闭时,那个 finalizer 中断 worker → worker 的 `onInterrupt` 跑 `drain`:
  关闸 → 收拢(在飞的批 + 队列残余,同一事务) → 写进 sink → 退出;
- `Scope.close` 会等中断完成,所以"关闭返回"⇒ "残留已经写进 sink";
- worker 已因失败退出时,中断是空操作,队列按失败语义丢弃;
- 没有超时:sink 卡住时,关闭也会卡住。

## 能从 archive 恢复什么（读侧）

读侧挂在 **`Archive` 服务**上,投影状态在它依赖的 **`Projection` 服务**里:

```ts
const archive = yield * Archive;
const entries = yield * archive.readAll; // 所有会话的已接收条目(只碰内存,不会失败)
const sessions = yield * archive.sessions; // 有哪些会话
const current = yield * archive.currentSession; // 当前会话 id

const transcript = yield * archive.projection("transcript"); // 当前会话的对话历史(跨 run)
const inbox = yield * archive.projection("inbox"); // 当前会话:{ queue, staged }
const sessionA = yield * archive.readSession(a); // 某一会话的原始条目
yield * archive.useSession(a); // 切过去;没有条目时就是空会话
```

`Archive.projection(kind)` 只是转发给 `Projection.get(kind)`;想要什么就取什么,不用订阅两个服务。

| 状态               | 怎么来的                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- |
| `queue` / `staged` | 一张表按 `taken` 分:没取走的进 `queue`,取了没进 step 的进 `staged`;进过 step 的删掉 |
| `transcript`       | 按 step 折叠:有调用的 step 整批产出进,纯问答轮只留非空正文(逐条);**跨 run 保留**    |
| 每次请求的 items   | `SYSTEM_MESSAGE_SET.text`(当时的状态)+ 折叠到该步的 transcript(所见即所喂)          |

其余状态(阶段 / 待回填调用 / 每轮明细)**先不做**,要加时在 `project.ts` 加一个读函数即可
(事件 schema 不变),见 [`0078`](../../decisions/0078-projection-transcript-and-inbox-only.md)。

折叠状态(`project.ts` 的 `FoldState`)= `inbox`(id → 正文 + 是否取走)+ `transcript` + 当前 `step`,
只有这三样;被 step 用掉的消息从 `inbox` 里删掉,所以 `queue` / `staged` 是同一张表的两个子集。

- 缓存底稿在**构建时**从 `Sink.read` 读一次,之后只碰内存;
- **构建时 `projection.init(底稿)`**(重置 + 全量折叠),之后 `append` 只 `projection.advance(...)`
  (只入队,读到再折):"建"和"加"两个语义分开,见 [`0079`](../../decisions/0079-projection-init.md);
- **会话由 `sessionId` 分组**:`init(底稿)` 后默认选中最后一段;`Projection.setSession(id)` 从
  `allEntries` 按 `sessionId` 重折当前会话。`ENGINE_START` 不清 transcript,只清未闭合的 step;
  会话边界是 archive 里的 session,不再是层实例(见 [`0086`](../../decisions/0086-archive-sessions.md));
- **条目先进缓存、再推进投影**:`append` 成功后把同一批交给 `projection.advance(...)`
  (与条目缓存一起包成不可中断);`advance` 只入队,**折叠发生在读时**(`get`),没人读就不折;
- 返回的是**已接收**的条目:刚 `append`、还在队列 / 在飞的批也在里面;代价是"读到了但还没落盘";
- 读时把目标数组拷一份,不把内部状态递出去;
- 文件 sink 的读会**在坏行处截断**(单 writer 追加,半行只可能出现在尾部);
- 缓存是**整份日志驻留内存**,并且只跟自己的写入保持同步:两个实例共用同一个文件时,
  A 的追加不会出现在 B 的缓存里(B 要重新建实例才会重读)。

**恢复不了**:`configure` 的内容(模型 / 档位 / 工具定义没有事件)、`ARCHIVE_ERROR`(不落盘)、
中断与正常的区别(只有 END 序列)、同一 step 内 reasoning / 正文 / 调用的真实交错顺序(按事件顺序近似)、
并发工具的真实完成时间(写回顺序 = 完成顺序,见 0057)、会话的标题 / 时间等元数据(只有 id)。

## 还没做

- 增量读（`entries(fromLine)`;现在只有一次性 `readAll`）；
- 显式的"选会话"入口(客户端现在默认最后一段;`useSession` / `startSession` 是底层口子)；
- 文件轮转 / 压缩 / 跨进程锁；
- fsync / 至少一次落盘保证。
