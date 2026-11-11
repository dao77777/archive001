# 决策:`_tag` 全大写,step 内容与 `Item` 命名对齐

> 已接受 · 2026-10-24 · 细化 [`0025`](0025-error-as-content.md)
> (error 作为内容、生命周期只有 start→end 不变)· 落点
> `packages/agent/src/loop/` 与 `packages/agent/src/llm/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md) 与
> [`../designs/agent/llm.md`](../designs/agent/llm.md)
> · 复查条件 4(`SYSTEM_MESSAGE` 每步重复)由 [`0067`](0067-system-message-as-state.md) 落实(改成 `SET` / `CLEAR` 状态事件)。

## 矛盾

事件和 `Item` 用了两套命名:

| 位置        | 之前                                         | 问题                                                                   |
| ----------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| 事件 `_tag` | `engine.start` / `turn.end` / `tool.call`    | 小写 + 点号,和 `Item` 对不上                                           |
| `Item.type` | `message` + `role`                           | 角色藏在 `role` 里,事件侧却要区分 `USER_MESSAGE` / `ASSISTANT_MESSAGE` |
| step 内容   | `prompt` / `thinking` / `text` / `tool.call` | 和模型层的 item 名字不同,回放/对照要翻译                               |
| inbox 消息  | `prompt` / `tool_result`                     | 同样是 Item 语义,却另起名字                                            |

## 处理

- **所有 `_tag` 全大写**,点号改成下划线:
  - `ENGINE_START/END/ERROR`、`TURN_START/END/ERROR`、`STEP_START/END/ERROR`;
  - `INBOX_OFFER/TAKE`;
  - `SYSTEM_MESSAGE`、`USER_MESSAGE`、`ASSISTANT_MESSAGE`、`REASONING`、`FUNCTION_CALL`、`FUNCTION_CALL_OUTPUT`。
- **`Item` 拆成角色化类型**(字段仍是 `type`):
  ```ts
  | { type: "SYSTEM_MESSAGE"; text }
  | { type: "USER_MESSAGE"; text }
  | { type: "ASSISTANT_MESSAGE"; text }
  | { type: "REASONING"; text }
  | { type: "FUNCTION_CALL"; callId; name; arguments }
  | { type: "FUNCTION_CALL_OUTPUT"; callId; output }
  ```
- **step 内容事件与 Item 同名**:
  - `SYSTEM_MESSAGE { text }`(这一步用的系统提示);
  - `USER_MESSAGE { promptIds }`(这一步新吃进来的 prompt,引用);
  - `FUNCTION_CALL_OUTPUT { callId, output }`(这一步新消费的工具结果);
  - `REASONING { text }` / `ASSISTANT_MESSAGE { text }` / `FUNCTION_CALL { callId, name, arguments }`。
- **inbox 消息也用同一套名字**:
  - `USER_MESSAGE { id, text }`;
  - `FUNCTION_CALL_OUTPUT { callId, name, output }`.
- 客户端渲染 / 测试 / 文档里的 tag 全部同步;宿主终止行改成 `ANSWER` / `ERROR`。

## 为什么

- **一套词汇**:事件、Item、inbox 消息、投影都用同一组名字,读代码不用来回翻译。
- **角色成为类型**:`SYSTEM_MESSAGE` / `USER_MESSAGE` / `ASSISTANT_MESSAGE` 比 `message + role` 更难写错。
- **step 自解释**:step 的内容事件就是它消费/产出的 item 列表;回放时不用再猜。
- **大写显眼**:`_tag` 是结构常量,和变量/字段区分明显;grep 也更容易。

## 代价

- **大范围重命名**:事件、Item、inbox、适配器、测试、文档全部要改;旧日志/旧决策里的名字不再匹配。
- **`Item.type` 仍是 `type` 而不是 `_tag`**:和事件字段名不完全统一,只是值统一。
- **step 内容变多**:每步都发 `SYSTEM_MESSAGE`,工具结果再发一次 `FUNCTION_CALL_OUTPUT`;
  和 inbox 事件有重复。
- **`FUNCTION_CALL_OUTPUT` 在 inbox 和 step 两处出现**:类型不同(一个是消息,一个是事件),
  但名字相同,排查时要看上下文。

## 复查条件

1. **重复内容成为体积瓶颈**:`SYSTEM_MESSAGE` / `FUNCTION_CALL_OUTPUT` 可以只在变化时发,
   或在 archive 写入前做去重;不要改回小写/别名。
2. **`Item.type` 与事件 `_tag` 的字段名不一致造成困惑**:再决定是否把 `Item` 也改成 `_tag`;
   那会是又一次全量迁移。
3. **需要兼容旧事件日志**:写一层旧 tag → 新 tag 的迁移映射,不要同时保留两套发布路径。
4. **`SYSTEM_MESSAGE` 每步重复太吵**:改为在 system 变化时发一次,step 只引用;
   前提是能保证回放时能重建。
