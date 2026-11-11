// llm 层的常量:厂商名、两条 wire 的端点、缺省行为参数。
// 循环层的常量跟着各服务走(`loop/<服务>/live.ts`),没有集中的常量表。

import type { BehaviorSettings, Wire } from "./_domain.ts";

/** 错误信息里的厂商名 */
export const PROVIDER_NAME = "deepseek";

/** 两条 wire 的端点(都拼在 `{baseUrl}` 之下) */
export const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions";
export const RESPONSES_ENDPOINT = "/responses";

/**
 * 走哪条 wire —— **内部实现细节,不是用户配置**。
 * 要排障切到兼容路径时改这里(或直接调 `chat-completions.ts` 的 `complete`);
 * 调用方(agent / CLI / 客户端)看不到这个开关。
 */
export const DEFAULT_WIRE: Wire = "responses";

/** 缺省端点(不带结尾斜杠);`settings.ts` 与客户端都可以覆盖 */
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

/**
 * 缺省**行为**参数;入口可用环境变量覆盖,再按次传给 `complete(items, tools, settings)`。
 * 不含密钥:密钥没有"缺省值",必须由调用方给。
 */
export const DEFAULT_SETTINGS: BehaviorSettings = {
  model: "deepseek-flash",
  thinking: "high",
};
