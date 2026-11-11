// ═══════════════════════════════════════════════════════════════════════════
// ToolExecutor:一批 `function_call` 批内并发跑完,结果 `inbox.offer` 写回
//
// submit(toolBatch) ──► jobs 队列 ──► worker ──► runTool(并发,上限 TOOL_CONCURRENCY)
//                                        └─► inbox.offer(完成一个写一个)
//
// 它不决定"下一轮什么时候开始"(那是 engine 的事),也不发事件:`INBOX_OFFER` 由 inbox 自己发。
// ═══════════════════════════════════════════════════════════════════════════

import { Effect, Layer, Option, Queue } from "effect";
import { formatError } from "../../_util.ts";
import type { Tool } from "./service.ts";
import { Inbox, type InboxShape } from "../inbox/service.ts";
import { ToolExecutor, type ToolBatch } from "./service.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/**
 * 单条工具输出回喂给模型的字符上限(头 + 尾合计)。
 * 由 `runTool` 统一截断,工具自己不管;超长时中间省略、两头都留。
 */
export const TOOL_MAX_OUTPUT = 8_000;
/** 同一批 `function_call` 同时跑几个(批内并发上限;写回仍按完成顺序) */
export const TOOL_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/**
 * 回喂给模型前截断:超长时**保留头尾**,中间注明被截掉多少。
 *
 * 尾巴必须留 —— 报错、`exit code`、测试失败摘要通常都在最后几行;
 * 只留头部会把这些信息切掉,模型反而看不到关键线索。
 */
const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) return text;

  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  const dropped = text.length - limit;
  return `${text.slice(0, head)}\n...[中间已截断 ${dropped} 字符]...\n${text.slice(text.length - tail)}`;
};

/**
 * 按名字找工具并执行,返回**可以直接回喂给模型**的观测。
 *
 * 这是"工具永不失败"的唯一实现处:找不到工具、参数非法、工具 `fail` / 抛异常(die),
 * 全部变成一条 `错误:…` 观测。工具自己不必兜底 —— 而且兜不兜都行,这里一定会兜住,
 * 模型看到错误才能自我纠正。输出也在这里统一截断。
 */
const runTool = (
  tools: ReadonlyArray<Tool>,
  name: string,
  rawArguments: string,
): Effect.Effect<string> =>
  Option.match(Option.fromUndefinedOr(tools.find((tool) => tool.definition.name === name)), {
    // 没这个名字的工具:回一条错误观测,模型自己纠
    onNone: (): Effect.Effect<string, unknown> => Effect.succeed(`错误:未知工具 ${name}`),
    // 找到就执行(失败 / 抛异常由下面的 catch 兜)
    onSome: (tool): Effect.Effect<string, unknown> => tool.execute(rawArguments),
  }).pipe(
    Effect.catch((error) => Effect.succeed(`错误:${formatError(error)}`)),
    // `catchDefect` 不碰中断:执行器被停时不会把中断误当成工具错误
    Effect.catchDefect((defect) => Effect.succeed(`错误:${formatError(defect)}`)),
    Effect.map((text) => truncate(text, TOOL_MAX_OUTPUT)),
  );

/**
 * 执行一批调用:**跑工具与写回都并发**,完成一个写回一个。
 *
 * 写回顺序 = 完成顺序,不保序:`INBOX_OFFER` / archive 里观测的顺序只反映完成时间。
 * 这不破坏回放契约 —— 状态机并进 transcript 时按 `pending`(调用顺序)重排,
 * `FUNCTION_CALL_OUTPUT` 仍然紧跟它自己的 `FUNCTION_CALL`。
 */
const executeBatch = (inbox: InboxShape, toolBatch: ToolBatch): Effect.Effect<void> =>
  Effect.forEach(
    toolBatch.calls,
    (call) =>
      runTool(toolBatch.tools, call.name, call.arguments).pipe(
        // 结果只交给 inbox:`INBOX_OFFER` 由它自己发,执行器不管事件
        Effect.flatMap((output) =>
          inbox.offer({
            _tag: "FUNCTION_CALL_OUTPUT" as const,
            id: crypto.randomUUID(),
            payload: { callId: call.callId, name: call.name, output },
          }),
        ),
      ),
    { concurrency: TOOL_CONCURRENCY, discard: true },
  );

/** `ToolExecutor` 服务:一批批执行,观测写回 inbox。 */
export const ToolExecutorLive: Layer.Layer<ToolExecutor, never, Inbox> = Layer.effect(
  ToolExecutor,
  Effect.gen(function* () {
    // -----------------------------------------------------------------------
    // 依赖
    // -----------------------------------------------------------------------
    const inbox = yield* Inbox;

    // -----------------------------------------------------------------------
    // 状态
    // -----------------------------------------------------------------------
    /** 待执行的批:跨批串行,批内并发。 */
    const jobs = yield* Queue.unbounded<ToolBatch>();

    // -----------------------------------------------------------------------
    // 初始化:起常驻 worker
    // -----------------------------------------------------------------------
    // 跟着层的 scope 一起被中断
    yield* Effect.forever(
      Queue.take(jobs).pipe(Effect.flatMap((toolBatch) => executeBatch(inbox, toolBatch))),
    ).pipe(Effect.forkScoped);

    // -----------------------------------------------------------------------
    // 对外方法
    // -----------------------------------------------------------------------
    /** 交一批:只入队,不等跑完。 */
    const submit = (toolBatch: ToolBatch): Effect.Effect<void> =>
      Queue.offer(jobs, toolBatch).pipe(Effect.asVoid);

    return ToolExecutor.of({ submit });
  }),
);
