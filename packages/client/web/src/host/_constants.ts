// 宿主的常量:端口、绑定地址、令牌 Cookie、环境变量名。
// 宿主是**客户端自己的后端**(和 cli / repl 平级),内核不认识它。

import process from "node:process";

/** 监听端口;process-compose 与本地开发都用它 */
export const HOST_PORT = Number(process.env.PORT ?? 5180);

/** 只绑回环:这台机器之外一律连不上 */
export const HOST_BIND = "127.0.0.1";

/**
 * 一次性令牌的 Cookie 名。`HttpOnly` 让 JS 读不到,`SameSite=Strict` 让别的站点带不上 ——
 * 配合下面两道校验,把"任意网页都能 fetch 本地端口"这件事堵死。
 */
export const TOKEN_COOKIE = "archive001_token";

/** API 前缀 */
export const API_PREFIX = "/api";

/** 请求体上限:一次 turn 只是一句话,给 64KB 绰绰有余 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 密钥:**只有这一项**从环境变量读(与 cli 保持一致) */
export const ENV_API_KEY = "DEEPSEEK_API_KEY";
export const ENV_API_KEY_FALLBACK = "API_KEY";
