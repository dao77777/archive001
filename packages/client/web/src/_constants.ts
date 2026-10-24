// Web 客户端的常量与默认值。
// 行为参数的缺省值与内核保持一致(`DEFAULT_SETTINGS` 来自 SDK);
// **密钥与端点不在客户端**:它们由本地宿主(`src/host/`)持有,浏览器只发模型 / 档位。

import { DEFAULT_SETTINGS, type BehaviorSettings } from "@archive001/agent";

export { DEFAULT_SETTINGS };
export type { BehaviorSettings };

/** 行为参数(model / thinking):可持久化 */
export const SETTINGS_STORAGE_KEY = "archive001.web.settings";

/** 输入框向上撑高的上限(px),超过就内部滚动 */
export const MAX_COMPOSER_HEIGHT = 180;

/** 思考档位由弱到强;点击依次循环 */
export const THINKING_LEVELS: ReadonlyArray<BehaviorSettings["thinking"]> = [
  "off",
  "low",
  "high",
  "max",
];

/**
 * 界面上能选到的模型。**只能选,不能手打** —— 写错的模型名会以 400 的形式回来。
 * 旧持久化里出现的其它名字不会被丢掉,仍会原样保留并排在第一位。
 */
export const MODELS: ReadonlyArray<string> = ["deepseek-flash", "deepseek-v4-pro"];
