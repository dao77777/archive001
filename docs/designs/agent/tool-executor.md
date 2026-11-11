# 设计:tool-executor

> 路径 `packages/agent/src/loop/tool-executor/service.ts`。inbox 见 [`inbox.md`](inbox.md),循环见 [`loop.md`](loop.md)。

## 一句话

模型要调的一组工具在它这里跑完,每条结果变成**一条能直接回喂模型的观测**,写回 inbox。

## 形状

```ts
submit({ calls, tools }); // engine 派一批过来,不等待结果
```

结果不走返回值,而是 `inbox.offer(FUNCTION_CALL_OUTPUT)` ——
"下一步什么时候开始"由 engine 判断,执行器不知道。

## worker

```
engine ──submit──► jobs(queue) ──► worker: forever( take >>= executeBatch )
                                                  │
                                                  └─► forEach(calls, runTool >>= inbox.offer, { concurrency: 4 })
```

- **跨批串行**:`Queue.take` 一批跑完才取下一批(不同 step 本来就依赖前一步结果);
- **批内并发**:跑工具与写回**在同一个并发任务里**,谁先完成谁先写回(`TOOL_CONCURRENCY = 4`);
- 跟着层的 scope 一起被中断(`forkScoped`)。

## 一条观测的三道加工

```
tool.execute
      │
      ├─ fail / 抛异常(die) / 工具不存在 ──► "错误:<原因>"
      │
      └─ 正常输出 ──► 截断到 TOOL_MAX_OUTPUT(8000)
                        ├─ 头 4000
                        ├─ "...[中间已截断 N 字符]..."
                        └─ 尾 4000
                              │
                              ▼
                        inbox.offer
```

| 加工       | 规则                                                         | 常量                         |
| ---------- | ------------------------------------------------------------ | ---------------------------- |
| 失败转观测 | `fail`、`die`、找不到工具 → 都是 `错误:…`;工具不必自己兜底   | —                            |
| 截断       | 超长留头尾各一半,中间写明省略多少(报错/exit code 通常在尾部) | `TOOL_MAX_OUTPUT`            |
| 写回       | 只交给 `inbox.offer`,事件由 inbox 发                         | `TOOL_CONCURRENCY`(批内并发) |

## 顺序:谁保证什么

| 顺序                                 | 谁                                    |
| ------------------------------------ | ------------------------------------- |
| **写回顺序 = 完成顺序**(不保序)      | executor                              |
| `functionCallOutputs` 按**调用顺序** | inbox(`takeReady` 按 `awaiting` 排好) |
| `FUNCTION_CALL_OUTPUT` 紧跟 `CALL`   | engine(按 inbox 交给的顺序追加)       |

并发只让子进程 / I/O 重叠;为此 `INBOX_OFFER` 与 archive 里的观测顺序**不保证**与调用顺序一致。

## 谁负责什么

| 事                               | 谁                  |
| -------------------------------- | ------------------- |
| 排队、就位、发 `INBOX_*`         | inbox(`inbox.md`)   |
| 派批、重排、拼 transcript        | engine(`engine.ts`) |
| 并发执行、失败转观测、截断、写回 | **executor**        |

## 不做什么

- 不决定"下一轮什么时候开始",不重试工具(只有内置 `bash` 自己的 timeout);
- 不做工具级限流:并发上限是整批一个数,不区分读 / 写工具;
- 不区分工具语义:它拿到的只是 `{ calls, tools }`,谁是 `bash`、谁是 `write_file` 它不关心。
