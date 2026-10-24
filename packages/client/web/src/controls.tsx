// Base UI 原语的**样式封装**:库只提供行为(键盘 / 焦点 / ARIA / 定位),外观全部由这里决定。
// 因此这些组件长得像档案纸,而不是像某个 UI 框架。

import { Dialog } from "@base-ui-components/react/dialog";
import { Field } from "@base-ui-components/react/field";
import { Select } from "@base-ui-components/react/select";
import type { ReactNode } from "react";

/** `box` = 表单里的方框字段;`bare` = 状态栏里的裸字段(标签与值并排、没有框)。 */
export type FieldVariant = "box" | "bare";

const rootClass = (variant: FieldVariant): string =>
  variant === "bare" ? "flex items-baseline gap-2" : "flex flex-col gap-1";

const controlClass = (variant: FieldVariant): string =>
  variant === "bare" ? "bare-input" : "field";

/** 单选项下拉:触发器沿用 `.field`;弹层无边框 —— 纸白 + 阴影 + 顶部淡出发丝线。 */
export const SelectField = <T extends string>({
  label,
  ariaLabel,
  value,
  options,
  variant = "box",
  side = "bottom",
  onChange,
}: {
  readonly label?: string;
  readonly ariaLabel?: string;
  readonly value: T;
  readonly options: ReadonlyArray<T>;
  readonly variant?: FieldVariant;
  readonly side?: "top" | "bottom";
  readonly onChange: (next: T) => void;
}) => (
  <Field.Root className={label === undefined ? "flex" : rootClass(variant)}>
    {label !== undefined && <Field.Label className="label shrink-0">{label}</Field.Label>}
    <Select.Root
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next as T);
      }}
    >
      <Select.Trigger
        className={`${controlClass(variant)} flex items-center gap-1.5 text-left`}
        aria-label={ariaLabel ?? label}
      >
        <Select.Value />
        <span aria-hidden="true" className="text-[8px] leading-none text-muted">
          ▼
        </span>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={2} alignItemWithTrigger={false} side={side} className="z-50">
          <Select.Popup className="relative min-w-[var(--anchor-width)] bg-paper-hi py-1 shadow-[0_14px_34px_-16px_rgba(0,0,0,0.45)]">
            <div aria-hidden="true" className="hairline absolute inset-x-0 top-0" />
            {options.map((option) => (
              <Select.Item
                key={option}
                value={option}
                className="flex cursor-default items-center justify-between gap-4 px-2 py-1 font-mono text-[12px] text-ink outline-none data-[highlighted]:bg-ink data-[highlighted]:text-paper-hi"
              >
                <Select.ItemText>{option}</Select.ItemText>
                <Select.ItemIndicator className="text-[10px] text-signal" aria-hidden="true">
                  ▪
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </Field.Root>
);

/** 一行"标签 : 值";值用等宽字,标签用 10px 疏排 —— 与底栏同一套写法。 */
const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="flex items-baseline gap-4">
    <span className="label w-24 shrink-0">{label}</span>
    <span className="min-w-0 flex-1 font-mono text-[11px] break-all text-ink">{children}</span>
  </div>
);

/**
 * 设置弹层:现在**没有需要你填的东西**(密钥在宿主的 env 里),
 * 它是"这台机器上正在发生什么"的一张说明 + 唯一的破坏性动作(清空会话)。
 */
export const SettingsDialog = ({
  open,
  onOpenChange,
  host,
  onReset,
}: {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly host: { readonly hasKey: boolean; readonly cwd: string } | null;
  readonly onReset: () => void;
}) => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/25" />
      <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 bg-paper-hi px-6 pt-6 pb-6 shadow-[0_34px_80px_-30px_rgba(0,0,0,0.5)]">
        <div aria-hidden="true" className="hairline absolute inset-x-0 top-0" />
        <Dialog.Title className="font-display text-2xl leading-none font-bold tracking-tight">
          设置
        </Dialog.Title>
        <Dialog.Description className="label mt-2">
          密钥在宿主的环境变量里 · 浏览器不持有
        </Dialog.Description>

        <div className="mt-6 flex flex-col gap-3">
          <Row label="宿主">{typeof window === "undefined" ? "" : window.location.host}</Row>
          <Row label="工具目录">{host?.cwd ?? "—"}</Row>
          <Row label="密钥">
            {host === null ? (
              <span className="text-signal">连不上宿主</span>
            ) : host.hasKey ? (
              "已配置"
            ) : (
              <span className="text-signal">未配置(启动宿主时设置 DEEPSEEK_API_KEY)</span>
            )}
          </Row>
          <Row label="模型 / 档位">用输入框下沿切换</Row>
        </div>

        <p className="mt-6 text-[11px] leading-relaxed text-muted">
          工具直接跑在这台机器上,工作目录就是上面那个路径 —— 它由启动宿主时的{" "}
          <code className="font-mono">cwd</code> 决定。 宿主只监听 127.0.0.1,并校验 Host / Origin
          与一次性 cookie。
        </p>

        <div className="mt-6 flex items-baseline gap-6">
          <button type="button" onClick={onReset} className="bare-btn">
            清空会话
          </button>
          <Dialog.Close className="bare-btn ml-auto">关闭</Dialog.Close>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);
