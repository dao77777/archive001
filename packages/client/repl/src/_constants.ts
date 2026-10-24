// 客户端的表现层常量:ANSI 码、预览尺寸、提示符;以及**入口读哪些 env**。

/** 入口**只读密钥**这一个环境变量(读 env 是客户端的事,SDK 不读) */
export const ENV_API_KEY = "DEEPSEEK_API_KEY";
/** 兜底:`DEEPSEEK_API_KEY` 未设时读它 */
export const ENV_API_KEY_FALLBACK = "API_KEY";

/** ANSI SGR 颜色码 */
export const ANSI_DIM = "2";
export const ANSI_CYAN = "36";
export const ANSI_RED = "31";

/** 提示符用纯文本:ANSI 会干扰 readline 的宽度计算 */
export const REPL_PROMPT = "> ";

/** 工具参数预览:每个值最多显示多少字符 */
export const ARGUMENT_PREVIEW_CHARS = 120;
/** 思维链预览行数 */
export const REASONING_PREVIEW_LINES = 8;
/** 工具输出预览行数 */
export const TOOL_OUTPUT_PREVIEW_LINES = 6;
