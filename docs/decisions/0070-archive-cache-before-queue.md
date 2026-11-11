# 决策:缓存前移到写队列之前;archive 成为唯一状态源,engine 不再本地存 transcript

> 已接受 · 2026-10-24 · 取代 [`0060`](0060-archive-read-cache.md) 的"缓存 = 已落盘" ·
> 落点 `packages/agent/src/archive/archive.ts` + `loop/engine.ts` ·
> 设计见 [`../designs/agent/archive.md`](../designs/agent/archive.md) 与
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

`0060` 把缓存放在**写盘成功之后**,于是两个后果:

| 问题                 | 说明                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| 读不到"刚发生的事"   | 刚 `append` 的条目要等 worker 落盘才可读;跨进程 / 跨实例不共享                   |
| 引擎只能靠自己记历史 | transcript 在 engine 的 `Ref` 里,archive 里也有同一份事实 —— 两份状态            |
| 不一致就有 bug       | 我们刚为了让投影和引擎一致,把三处规则(观测在前、正文逐条、system 状态)挨个对齐过 |

核心矛盾:**既然 archive 已经把"发生了什么"全记下来了,为什么引擎还要自己留一份?**

## 处理

两件事一起做:

### ① 缓存在写队列之前

```
append ──┬──► 缓存(立刻可见)
         └──► TxQueue ──► worker ──► sink.write(落盘)
readAll / projection ──► 缓存(构建时以 sink 已有内容为底稿,之后只碰内存)
```

- `append` 成功入队后**立刻**写缓存;worker 只负责落盘,不再碰缓存;
- 缓存底稿在**构建时**从 sink 读一次(此时还没有任何写入,所以不存在"读到的和写下的对不齐");
  底稿读失败按缺陷处理(读不到文件不是可恢复的运行期错误);
- 于是 `readAll` / `projection` **不会失败**(只碰 `Ref`),`ArchiveError` 从这两个签名上消失;
- 锁也不再需要:`append` 是原子 `Ref.update`,读是 `Ref.get`,worker 是唯一写者。

### ② engine 不再本地存 transcript

```ts
/** 这一轮之前的 transcript:从 archive 投影,本地不留副本。 */
const transcriptOf = archive.projection("transcript"); // 引擎没有 id(见 0072)
```

- 每次生成前投影一次(3.2 的输入事件已经写进 archive,所以投影出的历史天然包含这批输入);
- 引擎不再有 `transcript` Ref,也没有"产出进历史"的步骤 —— `project` 的 `STEP_END` 规则
  ([`0069`](0069-answer-texts-per-item.md))就是历史规则;
- `EngineLive` 因此多依赖一个 `Archive`。

## 为什么

- **一份事实**:archive 记事件,`project` 是唯一的解释器;引擎的"历史"就是它的输出,
  不会出现"本地历史与 archive 不一致";
- **实时**:`append` 立刻可读,读侧不用等落盘,外部环境拿到的是"到现在为止"的全部;
- **读写解耦**:读只碰内存 ⇒ sink 写失败 / 卡住都不影响引擎继续对话(只有底稿读失败会挡住启动);
- **代码变少**:engine 里少了 transcript 的两处更新与 set/clear,archive 里少了加载合并与锁。

## 代价

- **"读到" ≠ "落盘"**:`readAll` / `projection` 可能包含还在队列 / 在飞的条目。进程此刻崩溃,
  这些条目只在内存里 —— 缓存不再是"持久化视图",而是"已接收视图"。
  (档案文件本身仍然是 append-only 的权威副本,只是读侧不再以它为准。)
- **每步一次全量投影**:`projection(engineId)` 仍会把整份 archive 折一遍再挑这一段,O(entries);
  长会话里是 O(n²)。
  目前靠"条目小、步数有限"扛,真成瓶颈要改成增量投影。
- **构建时要读一次文件**:`FileArchiveSinkLive` 的整个 JSONL 会在启动时读进来(内存与启动时间);
  底稿读失败 = 进程起不来(以前可以"带着坏的 archive 启动")。
- **写盘失败不再影响读** —— 这既是优点也是坑:档案坏了、`readAll` 仍然"看起来正常",
  要靠 `errors` / `ARCHIVE_ERROR` 才知道落盘已经停了。
- **`EngineLive` 依赖变多**:`Llm | Inbox | ToolExecutor | Events | Archive`;单独测引擎要建更多层。

## 复查条件

1. **投影成为性能瓶颈**(长会话每步 O(n)):给 `project` 加增量折叠(保留 `ProjectedEngine` 快照 +
   只折新条目),或在 archive 里维护"每个 engine 的 transcript"缓存 —— 但不要让引擎再存一份。
2. **需要一个"已落盘"视图**(审计 / 恢复必须只信文件):在 `ArchiveShape` 上补 `durable`(直接读 sink),
   两个视图并列,不要改回"读以文件为准"。
3. **构建期读失败要能降级**:允许"空底稿 + 明确告警"启动(比如只当实时会话用、不需要旧历史),
   并把选择暴露给调用方,而不是在 archive 里悄悄假设。
4. **写盘长期失败但对话正常**,用户以为有档案:在客户端用 `ARCHIVE_ERROR` 明确提示"本次不落盘",
   或让 `errors` 决定 UI 状态。
