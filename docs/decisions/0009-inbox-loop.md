# 决策:循环改成 inbox 驱动的常驻状态机

> 已接受 · 2026-10-24 · **接口部分被 [`0010`](0010-run-is-the-loop.md) 取代**(三个实体与 inbox 结构不变) ·
> `inbox.takeAll` 后来被 [`0050`](0050-inbox-take-ready.md) 换成 `takeReady`(攒到就位归 inbox) ·
> 复查条件 4(工具并发)由 [`0056`](0056-tool-batch-concurrency.md) 落实:批内并发、按调用顺序写回 ·
> 落点 `packages/agent/src/loop/`(设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md))

## 矛盾

旧实现把"一次请求"当成一个函数调用栈:

```
run(prompt) → 组 items → 调模型 → 有调用就顺序执行 → 回填 → 再调 → 返回正文
```

所有状态(历史、本轮已产出、待回填的调用)都活在**这一次 run 的局部变量**里。带来两个限制:

| 想要                                                | 旧结构下的冲突                                             |
| --------------------------------------------------- | ---------------------------------------------------------- |
| 等工具时用户还能插一句话,和下一条结果一起送给模型   | 工具结果在 run 内部同步执行,外部消息没有入口可以插进这一轮 |
| "idle / 生成中 / 等工具"是显式状态,能被观察和推理   | 状态隐含在 for 循环的第几步里;每加一种输入就得改控制流     |
| 工具执行从 llm 的回合逻辑里拆出去,能独立排队 / 观测 | 工具执行嵌在 loop 里,只能顺序内联                          |

## 处理

拆成三个实体,只通过 inbox 交接:

- **inbox**(`inbox.ts`):`Queue<InboxMessage>`,消息只有 prompt 与 tool result 两种;
- **llm 状态机**(`loop.ts` 的 `Agent`):idle / generating / waiting 三态;
  等结果时若混入新 prompt,取走 inbox 全部消息,并进 transcript 时**结果在前、prompt 在后**;
- **tool executor**(`tool-executor.ts`):常驻 worker,按提交顺序执行一批 `function_call`,
  每条结果写回 inbox。

`Layer.effect` 里 `forkScoped` 一个永不退出的引擎;`run(input, settings, tools, observe?)` 的签名不变,
内部变成"造 `Deferred` → 推进 inbox → 等回答"。工具轮整批留在 transcript 里(含 reasoning),
因为 responses 的回放契约要求 `function_call` 前有 `reasoning_text`。

> ⚠️ 上一段是当时的样子,已被 [`0010`](0010-run-is-the-loop.md) 改掉:
> `run` 不再是请求-应答入口,而是无限循环本身;塞消息改走 `Inbox.ask` / `Inbox.offer`。

## 为什么

- **一个入口,而不是四份状态**:prompt 和工具结果走同一条队列,谁先谁后由状态机一次决定;
  不需要在 executor 里猜"现在能不能继续调模型"。
- **回放顺序只有一个地方会错**:`function_call_output` 必须紧跟 `function_call`;
  这个约束被收敛到"并进 transcript"那十行,而不是散在两条路径里。
- **客户端零改动**:`run` 仍是请求-应答;REPL / CLI / web 宿主 / smoke 都不认识 inbox。
- **生命周期跟层走**:executor worker 与引擎都 `forkScoped`,web 的 reset(关旧 scope)天然把
  在飞的一轮一起停掉,不需要额外的"清历史"接口。
- **错误不再杀会话**:`LlmError` 交给等回答的 `run`,循环回 idle;旧实现里一次 400 会让整个 run 退出。

## 代价

- **中断不再等于取消**:`run` 被中断只丢掉回答口,已在飞的生成会继续跑完。
  旧实现里"浏览器断开 = 这一轮中断";现在 web 断流可能继续烧 token,直到本轮结束或 scope 关闭。
- **合并轮次,没有逐条路由**:等工具时进来的 prompt 并进当前轮,共享同一次回答;
  `settings` / `tools` / `observe` 以后一条 prompt 为准。两个客户端同时提问会得到同一句话。
- **工具事件的观察者是派发时的**:合并进来的新 prompt 的 `observe` 看不到本轮的工具事件。
- **transcript 常驻且无上限**:跨轮保留工具轮的 reasoning,历史只会变长;上下文压缩仍未做。
- **测试里多了一处调度假设**:构造"prompt + 结果混合"需要在工具闸门上 yield 几次,
  没有直接的 inbox 观察口(靠 `Queue.takeAll` 的天然行为,不另加 API)。
- **多一层队列 / 纤维**:单轮延迟多一次 hop;排查时要同时看 Agent 与 executor 两个 fiber。

## 复查条件

1. **web 断流必须立刻停 token**:给 prompt 加取消信号,生成与工具执行都 `race` 它;
   那时把 `run` 的中断映射成 `cancel` 消息,并接受 executor 要能跳过剩余任务。
2. **出现并发客户端 / 需要逐条回答**:停止合并 prompt,一轮只认队首 prompt;
   或给事件加 turn id,把回答按 id 路由。
3. **同一轮需要不同 `settings` / `tools`**:不能再"后一条覆盖前一条";改成一层一个会话配置,
   或按 prompt 分组生成。
4. **工具需要并发**:把 executor 的批内循环换成 `Effect.forEach(..., { concurrency })`,
   但要先想清楚多个写文件工具同时跑的顺序语义。
5. **transcript 长到必须压缩**:先做摘要 / 截断,再谈跨会话持久化;
   压缩时不能把 `function_call` 与它的 output 拆开。
