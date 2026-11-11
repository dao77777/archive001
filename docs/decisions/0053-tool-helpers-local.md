# 决策:`runTool` 与 `truncate` 就地放在 `tool-executor.ts`

> 已接受 · 2026-10-24 · 收尾 [`0052`](0052-tool-output-truncation.md) 的落点
> (`truncate` 同时从 SDK 导出里去掉)· 落点 `packages/agent/src/loop/tool-executor.ts` ·
> 规范见 [`../designs/code-conventions.md`](../designs/code-conventions.md)

## 矛盾

截断挪进执行器后(0052),两个助手还挂在公共位置的"欠":

| 助手       | 原先在哪                  | 真实使用方              |
| ---------- | ------------------------- | ----------------------- |
| `runTool`  | `loop/_util.ts`(模块助手) | 只有 `tool-executor.ts` |
| `truncate` | `_util.ts` + SDK 导出     | 只有 `tool-executor.ts` |

`_util.ts` 的判据是"被至少两处或公开 API 用"。这两个函数都不满足:

- **`runTool`**:只有执行器按名派发,别处没有第二处调用;
- **`truncate`**:技术上仍是"公开 API"(`@archive001/agent` 导出),但没有任何包 import 它;
  它存在只是为了"以后客户端可能想截断长输出" —— 一个没有使用方的公开导出,只是把 `_util.ts`
  变成杂物间,并让读者以为截断发生在多处。

## 处理

两个函数搬进 `tool-executor.ts`,改成模块私有:

```ts
// tool-executor.ts
const runTool = (tools, name, rawArguments) => …; // 按名找,找不到回观测
const truncate = (text, limit) => …;              // 超限即切 + 注明原始长度
```

连带改动:

- `loop/_util.ts` 只留 `makeTool`(仍然是 SDK 导出),文件头注释说明派发 / 截断在执行器;
- `_util.ts` 只留 `formatError`;`index.ts` 不再导出 `truncate`;
- `code-conventions.md` 的 `_util.ts` 例表删掉这两个,并把它们列进"模块内私有辅助"的例外;
- `overview.md` 的三件套表同步。

## 为什么

- **判据一致**:单一使用方的纯函数留在模块里,和 `toWireTool` / `toWireItem` 同一个道理;
- **截断只有一个入口**:看不见 `truncate` 的导出,就不会有客户端再自己截一遍,出现两层后缀;
- **`_util.ts` 保持诚实**:里面每一样东西都真的被多处用;要加东西时先回答"谁在用";
- **SDK 面收窄**:没有使用方的导出留着只会变成兼容负担。

## 代价

- **`truncate` 不再是公开 API**:外部若已 import 会编译失败(本仓库没有使用方);
  以后客户端真要"显示用截断",得重新在 `_util.ts` 写一个(大概率语义也不同:按显示宽度);
- **执行器文件变长**:一个文件里同时有派发、截断、批循环与 worker,阅读时要多扫二十行;
- **`runTool` 不能单独测**:没有 `makeTool` 那样的 SDK 口子,只能通过执行器 / 循环间接覆盖
  (现在靠 `loop.test.ts` 的"未知工具"用例)。

## 复查条件

1. **`truncate` 出现第二个使用方**(客户端显示、日志裁剪、archive 脱敏):按判据搬回 `_util.ts`
   并重新导出,本条 supersede;搬的时候想清楚是不是同一个语义。
2. **想单独测派发逻辑**(未知工具、重名工具、参数透传):先把 `runTool` 抽成可注入的
   函数或 `_util.ts` 助手,再补测试,不要为了测试把执行器拆散。
3. **执行器继续长大**(加并发、重试、取消):按职责拆分文件(派发 / 截断 / worker),
   而不是把助手又搬回 `_util.ts`。
