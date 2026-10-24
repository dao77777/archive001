# 决策：用 Vite+ 管理工具链

> 已接受 · 2026-10-16 · 所属设计 [`../designs/overview.md`](../designs/overview.md) · 落点 `vite.config.ts`、`package.json`

## 矛盾

项目需要**格式 / lint / 类型检查 / 测试 / 打包**五件事,但它是个 **Node CLI**,不是 web 应用;
而 Vite+ 的定位是「web 开发的统一工具链」。

|          | 传统拼装                                          | Vite+                            |
| -------- | ------------------------------------------------- | -------------------------------- |
| 配置     | prettier + eslint + vitest + tsup + tsconfig 五套 | 一个 `vite.config.ts`            |
| 速度     | 各自为政                                          | Oxc 系(oxfmt/oxlint/tsgolint),快 |
| 本机先例 | ——                                                | `~/Code/effect-web` 已在用       |

## 处理

装 **项目本地** `vite-plus`,`package.json` 脚本全部转发给 `vp check / test / pack / lint / fmt`;
CLI 打包用 `vp pack`(tsdown);类型检查由 `vp check` 的 tsgolint 承担。

## 为什么

- 一个配置文件代替五套 rc,符合「不散落配置」的取向;
- Oxc 工具链明显快;
- 与工作区既有的 `effect-web` 保持一致,减少认知负担;
- `vp pack` 直接支持 Node 平台 + 单文件可执行(CLI 场景够用)。

落选候选:① eslint+prettier+vitest+tsup 手拼(配置多、慢);② 只用 `tsc` + `node --test`(缺少 lint/fmt 且没有统一入口);③ Bun 全家桶(本机有 bun,但工作区既有约定是 Vite+)。

## 代价

- **vitest 必须 pin 到 vp 内置版本**(当前 `5.0.4`),否则 mock / `expect` / runner 状态会分裂——升级 `vite-plus` 时要同步。
- **Vite+ 靠 git 枚举文件**:项目一旦被父仓 `.gitignore` 忽略,`vp check/lint/fmt` 会「找不到文件」(本项目在 `_lab/` 时踩过;判别方法见 `../designs/code-conventions.md` §8)。
- Vite+ 主要为前端设计,Node CLI 属于边缘用法,遇到问题可查的资料少。
- 没有 dev server,故**不登记** `~/Code/process-compose.yaml`。

## 复查条件

若出现下列任一情况,退回「vitest + tsdown + oxlint 各自独立配置」:
① Vite+ 因 git 枚举/工作区根导致命令在 CI 或换机后失效;
② `vite-plus` 与 `vitest` 版本对齐反复引发测试异常;
③ 需要 Vite+ 明确不支持的 Node 构建目标。
