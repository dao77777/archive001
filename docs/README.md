# docs 索引

> 目录约定见 `~/Code/AGENTS.md`。本文件只做导航。

| 文档                                                                               | 覆盖什么                                                                                                                                            | 什么时候看                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| [`designs/overview.md`](designs/overview.md)                                       | 包与依赖、内核分层、每层三件套                                                                                                                      | 第一次读代码前              |
| [`designs/agent/loop.md`](designs/agent/loop.md)                                   | 循环、数据流、事件、历史、工具                                                                                                                      | 改内核循环 / 加客户端事件时 |
| [`designs/agent/live-loop.md`](designs/agent/live-loop.md)                         | **常驻循环(未实现)**:一拍一调用、批与顺序、打断、关机                                                                                               | 要把 `run` 改成事件驱动时   |
| [`designs/agent/archive.md`](designs/agent/archive.md)                             | **archive(未实现)**:唯一状态源、9 种条目、四个投影、落盘与重启恢复、校验、append-only 的含义                                                        | 改内核状态 / 要重放时       |
| [`designs/agent/implementation-plan.md`](designs/agent/implementation-plan.md)     | **实施计划**:七阶段顺序、每步验收与回退点、目标用例数、10 个已知坑                                                                                  | 动手实现前 / 每次开工时     |
| [`designs/agent/llm.md`](designs/agent/llm.md)                                     | `Item` 模型、两条 wire、**回放契约**、选路、错误                                                                                                    | 改 `llm/` 时                |
| [`designs/client/web/ui.md`](designs/client/web/ui.md)                             | Web 界面:档案风、设计令牌、排版规则、主体(卷宗夹)                                                                                                   | 改 Web 界面时               |
| [`designs/client/web/host.md`](designs/client/web/host.md)                         | **本地宿主**(`effect/http`):路由分层、`/api/*`、会话与 reset、dev/prod 两条腿、安全闸                                                               | 改 Web 架构时               |
| [`designs/client/web/style-references.md`](designs/client/web/style-references.md) | **美术参照(仅风格)**「科罗廖夫十字」的拆解:色彩 / 字体 / 构图 / 运动(带实测);题材不借                                                               | 改视觉前                    |
| [`designs/code-conventions.md`](designs/code-conventions.md)                       | 分层、命名、注释、Effect v4、测试、工具链                                                                                                           | 动手写代码前                |
| [`knowledge/deepseek-api.md`](knowledge/deepseek-api.md)                           | DeepSeek 两条路径的全场景报文 + 回放实测证据                                                                                                        | 调报文 / 怀疑契约变了时     |
| [`decisions/`](decisions/)                                                         | 取舍记录:`0001` Effect v4 · `0002` Vite+ · `0003`/`0004` 历史 · `0005` 只留 DeepSeek · `0006` 本地宿主 · `0007` `effect/http` · `0008` archive 落盘 | 想改架构时                  |
| [`progress/status.md`](progress/status.md)                                         | 当前状态快照                                                                                                                                        | 接手项目时                  |
| [`logs/`](logs/)                                                                   | 原始流水(按天)                                                                                                                                      | 追溯"为什么变成现在这样"    |

`drafts/` 放未定稿想法(允许烂尾)。
