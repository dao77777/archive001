# 决策:engine 变成 `Engine` 服务(Layer),自持状态、只暴露 `configure`

> 已接受 · 2026-10-24 · 落点 `packages/agent/src/loop/engine.ts` ·
> 设计见 [`../designs/agent/loop.md`](../designs/agent/loop.md#内部实体)

## 矛盾

engine 一直是个**工厂函数**:`engine(llm, inbox, executor, config, publish) → Effect<never>`,
由 `loop.ts` 在装配时调用,状态(`config`、`transcript`、`dispatchedCalls`、turn/step id)全在它的闭包里。

| 问题               | 说明                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 状态与装配混在一处 | 配置的"有没有"在 `loop.ts`(`config` 变量 + `readConfig` 抛错),transcript 在 engine —— 同一个引擎的状态被两个文件分着管 |
| 参数表越来越长     | `llm / inbox / executor / config / publish` 五个参数,里面三个是其它实体的形状                                          |
| 只能整装整换       | 想清 transcript、想看引擎到哪一步,只能把整层换掉;没有 `Engine` 可以拿来问一句                                          |
| 与其它实体不对称   | `Inbox` / `ToolExecutor` / `Events` 都是"服务 Tag + `XxxLive` 层",只有 engine 是函数                                   |

## 处理

`engine` 函数改成 `Engine` 服务 + `EngineLive` 层,状态留在层的闭包里,外面只能通过接口改:

```ts
export interface EngineShape {
  /** 无限循环(消费 inbox → 调模型 → 派工具 …);调用方负责它的生命周期。 */
  readonly run: Effect.Effect<never>;
  /** 换配置(settings / tools):下一次生成生效。 */
  readonly configure: (config: AgentConfig) => Effect.Effect<void>;
}

export class Engine extends Context.Service<Engine, EngineShape>()("Engine") {}

export const EngineLive: Layer.Layer<Engine, never, Llm | Inbox | ToolExecutor | Events> = ...
```

- 依赖从参数变成 `yield* Llm / Inbox / ToolExecutor / Events`;
- `config`、`transcript`、`dispatchedCalls`、turn/step/engine id 全在 `EngineLive` 的闭包里(`run` 开头复位);
- `loop.ts` 变成纯接线:`configure: engine.configure`、`run: engine.run`、`send: inbox.offer`、
  `events: events.stream`;装配链 `AgentRuntime ← EngineLive ← ToolExecutorLive ← InboxLive ← EventsLive`。

## 为什么

- **状态归一个主人**:引擎自己的状态(配置 / transcript / 生命周期 id)只由它维护,外面只调
  `configure` / `run`,不会出现"两个文件各管一半";
- **与其它实体同形**:四个实体都是服务 + `Live` 层,读装配链时不用记"哪个是函数";
- **参数表消失**:`engine(...)` 的五个参数没了,依赖由 layer 解析;
- **留出可控的口子**:以后想加 `reset`(清 transcript)、`state`(只读投影)时,
  在 `EngineShape` 上加方法即可,不用改装配。

## 代价

- **engine 依赖具体服务标签**:以前只依赖形状(`LlmShape` 等),测试可以随手塞假实现;
  现在必须给 `Llm | Inbox | ToolExecutor | Events` 的 layer(测试里已有,但耦合更实);
- **装配链更长**:`AgentLive` 四层 provide,顺序错了会在建层时报缺依赖;
- **状态跨 `run` 存活**:`transcript` / `config` 在层里,`run` 被重复执行**不会**自动清空
  (现在靠 `run` 开头显式复位)—— 漏了复位就会出现"串轮";
- **"未配置"的判定回到 engine**:`readConfig` 抛缺陷(装配错误),文案也在 engine;与
  "外面决定错误"相比,这是把责任收进引擎的代价;
- **不再是纯函数**:`EngineLive` 需要 Effect 运行时,单独测引擎(不建整层)比以前难。

## 复查条件

1. **需要"清历史 / 重来"**:在 `EngineShape` 加 `reset`(清 transcript + 生命周期 id),web 的 reset 就能从"换层"改成"调 reset";别在外面改状态。
2. **需要读引擎内部状态**(调试 / 投影校验):加只读的 `state: Effect<EngineState>`,不要暴露可变引用。
3. **多引擎 / 子代理**:`Engine` 变成需要 tag 或参数化的工厂(`EngineLive(config)`),`run` 改成 `start` 返回 handle。
4. **引擎要能脱离整层单测**:把 llm / inbox / executor 三个依赖改成"形状参数 + 默认取服务",
   或者给 `EngineLive` 一个测试版(`EngineTestLive`)—— 那时本条 supersede。
