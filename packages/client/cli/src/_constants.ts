// CLI 自己读的环境变量名(内核不读 env;SDK 只接受传进来的设置)。

/** 密钥:用 `sops exec-env` 注入,不写进被跟踪文件 */
export const ENV_API_KEY = "DEEPSEEK_API_KEY";
/** 兜底:`DEEPSEEK_API_KEY` 未设时读它 */
export const ENV_API_KEY_FALLBACK = "API_KEY";
