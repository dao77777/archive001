# 决策:error 是内容,生命周期只有 start → end

> 已接受 · 2026-10-24 · 取代 [`0024`](0024-end-or-error.md)
> (error 不再作为异常终止符,也不带 kind)· 落点 `packages/agent/src/loop/` · 设计见
> [`../designs/agent/loop.md`](../designs/agent/loop.md)

## 矛盾

0024 把生命周期做成了二选一:

- `start → end` = 正常;
- `start → error` = 异常,且不再发 `end`。

但 error 是"发生了什么"的内容,不是生命周期本身:

| 问题                   | 说明                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| 每个 start 应该有 end  | 用 error 替代 end 后,消费者要判断有没有 end 才能知道生命周期闭没闭 |
| error 不是结束事件     | 它是容器里发生的事;结束仍然是 end                                  |
| `kind` 是内容字段      | 分类属于错误详情,不是生命周期结构                                  |
| 客户端要分两套终止逻辑 | 一套对 end,一套对 error                                            |

## 处理

- **生命周期只有 `start → end`**:
  - `engine.start/end`、`turn.start/end`、`step.start/end`;
  - `end` 不带 `reason`,也不表示成功 / 失败。
- **error 是内容事件**:

  ```ts
  step.error   { id, parentId: stepId,   message }
  turn.error   { id, parentId: turnId,   message }
  engine.error { id, parentId: engineId, message }
  ```

  - 去掉 `kind`(分类以后需要再加回内容字段);
  - 不属于 start/end 生命周期组。

- **出错后照常发所属层级的 end**:
  - 模型失败:`step.error` → `step.end` → `turn.error` → `turn.end`;
  - 没配置:`turn.error` → `turn.end`;
  - 引擎缺陷:`step.error` → `step.end` → `turn.error` → `turn.end` → `engine.error` → `engine.end`;
  - 中断:逐层 `end`,不发 error。
- 客户端:
  - 始终等自己的 `turn.end` 收尾;
  - 过程中看到 `step.error` / `turn.error` / `engine.error` 就记失败;
  - `engine.end` 时如果还没拿到回答,按"引擎已停止"失败。

## 为什么

- **结构闭合与业务结果分开**:end 只负责"这一层结束了";error 负责"为什么失败"。
- **每个 start 必有 end**:事件树可以只靠 start/end 配对遍历,error 是旁路内容。
- **error 可以自由分类**:以后加 `kind` / `code` 只影响内容,不影响生命周期。
- **客户端终止逻辑统一**:永远等 `turn.end`;失败信息从 error 内容里取。

## 代价

- **end 不表达成功 / 失败**:消费者不能只看 end,必须结合 error 内容。
- **error 与 end 都发**:同一次失败会多出 end 事件;但结构完整。
- **缺陷时三层 error 重复**:step / turn / engine 可能都带同一条 message;
  消费方按层级过滤展示。
- **没有 kind**:目前只能展示 message;需要分类时要重新加内容字段(而不是生命周期字段)。

## 复查条件

1. **需要错误分类 / 重试策略**:给 error 内容事件加 `kind` / `code`(仍然属于内容,
   不要做成 `start…error` 生命周期)。
2. **客户端只关心"这一轮成功没有"**:在客户端投影里把 `turn.error` 折算成 boolean,
   不要要求 end 带状态。
3. **end 与 error 的配对出现歧义**(比如 error 之后没等到 end):检查发布顺序;
   error 是内容,end 是终止符,顺序必须是 error 在前、end 在后。
4. **缺陷时重复 error 太吵**:只保留最内层 error,外层仍发 end;这仍然是内容策略,
   不改生命周期。
