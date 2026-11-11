// Web 客户端界面:档案风 —— 近白纸、近黑墨、一枚砖红、1px 细线。
// 美术参照只有风格(参照片见 docs/designs/client/web/style-references.md),题材是「档案」,不是航天。
// 只做渲染与输入:模型调用与工具在**本地宿主**(`src/host/`)里,浏览器这一侧只发输入、画事件流。

import {
  DEFAULT_SETTINGS,
  MAX_COMPOSER_HEIGHT,
  MODELS,
  SETTINGS_STORAGE_KEY,
  THINKING_LEVELS,
  type BehaviorSettings,
} from "./_constants.ts";
import { SelectField, SessionsDialog, SettingsDialog } from "./controls.tsx";
import { previewArgs, type Block } from "./_util.ts";
import { FolderMark } from "./folder-mark.tsx";
import { useAgent, type HostState } from "./use-agent.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const pad = (n: number): string => String(n).padStart(3, "0");

const loadSettings = (): BehaviorSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<BehaviorSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const App = () => {
  const [settings, setSettings] = useState<BehaviorSettings>(loadSettings);
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const { blocks, running, host, sessions, currentSession, send, openSession, newSession } =
    useAgent();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks]);

  // 输入框从一行起,内容多了向上撑高;超过上限就内部滚动
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [input]);

  const update = useCallback(
    <K extends keyof BehaviorSettings>(key: K, value: BehaviorSettings[K]) =>
      setSettings((previous: BehaviorSettings) => ({ ...previous, [key]: value })),
    [],
  );

  /** 档位点击切换:off → low → high → max → off */
  const cycleThinking = useCallback(
    () =>
      setSettings((previous: BehaviorSettings) => {
        const index = THINKING_LEVELS.indexOf(previous.thinking);
        const next = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length] ?? "off";
        return { ...previous, thinking: next };
      }),
    [],
  );

  // 旧持久化里如果存着不在表里的模型名,不丢掉:原样保留并排在最前
  const modelOptions = MODELS.includes(settings.model) ? MODELS : [settings.model, ...MODELS];

  // 回车即发送:先把输入框清空,再发出去(不要等答复回来才清)
  const submit = useCallback(() => {
    if (running || input.trim().length === 0) return;
    const text = input;
    setInput("");
    void send(text, settings);
  }, [input, running, send, settings]);

  const turns = blocks.filter((block) => block.kind === "user").length;

  return (
    <div className="relative z-10 flex h-full flex-col">
      <CropMarks />

      {/* 消息流:顶边用淡出遮罩收口 —— 滚动时内容淡出,不用一条线去挡切边 */}
      <div
        ref={scrollRef}
        className="relative z-10 flex-1 overflow-y-auto px-10 pt-12 pb-8 [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]"
      >
        {blocks.length === 0 ? (
          <Empty host={host} />
        ) : (
          <div className="mx-auto flex max-w-[76ch] flex-col gap-5">
            {blocks.map((block, index) => (
              <BlockView key={index} block={block} />
            ))}
            {running && <ThinkingBand />}
          </div>
        )}
      </div>

      {/* 底栏:输入 + 状态。两侧对齐的是**输入框的宽度范围**(max-w-76ch),不是页面四角 */}
      <footer className="relative z-10 px-10 pt-5 pb-6">
        <div className="mx-auto max-w-[76ch]">
          {/* 单行起步;回车即发送,所以要留 shift+enter 换行 */}
          <textarea
            ref={composerRef}
            value={input}
            placeholder="说点什么 · enter 发送 / shift+enter 换行"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            disabled={running}
            className="field w-full resize-none overflow-y-auto leading-relaxed"
          />

          {/* 输入框下沿:左端报状态,右端是动作与两个参数 —— 裸字,没有标签、没有框。
              模型与档位用**对比**区分:墨色小字 + ▾(下拉) vs 灰色疏排大写 + 一点就切。 */}
          <div className="mt-2 flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <span className="label">
              {running ? "思考中" : "就绪"} · 第{" "}
              <span className="numeral text-signal">{pad(turns)}</span> 轮
            </span>

            {/* ml-auto 而不是 justify-between:窄屏折行时,右组仍然贴右 */}
            <div className="ml-auto flex flex-wrap items-baseline gap-x-10 gap-y-2">
              {/* 会话:archive 里的多段记录,点开切换 */}
              <button
                type="button"
                onClick={() => setSessionsOpen(true)}
                className="bare-btn"
                title="archive 里的会话"
              >
                会话
              </button>

              {/* 设置:没有要填的东西,只有"这台机器上正在发生什么"+ 开新会话 */}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="bare-btn"
                title="宿主 / 工具目录 / 密钥状态"
              >
                设置
              </button>

              {/* 宿主缺密钥才占位:密钥在宿主那一侧,这里只报状态,没有可点的地方 */}
              {host !== null && !host.hasKey && (
                <span className="label text-signal">宿主未配置密钥</span>
              )}

              {/* 模型 + 档位是**一组**(本次会话的两个参数):紧靠,与外组拉开距离 */}
              <div role="group" aria-label="会话参数" className="flex items-baseline gap-3">
                <SelectField
                  ariaLabel="模型"
                  variant="bare"
                  side="top"
                  value={settings.model}
                  options={modelOptions}
                  onChange={(model) => update("model", model)}
                />

                <button
                  type="button"
                  onClick={cycleThinking}
                  title="点击切换思考档位"
                  className="bare-btn"
                >
                  {settings.thinking}
                </button>
              </div>
            </div>
          </div>
        </div>
      </footer>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        host={host}
        onReset={() => {
          void newSession();
          setSettingsOpen(false);
        }}
      />

      <SessionsDialog
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        sessions={sessions}
        currentSession={currentSession}
        onOpen={(id) => {
          setSessionsOpen(false);
          void openSession(id);
        }}
        onNew={() => {
          setSessionsOpen(false);
          void newSession();
        }}
      />
    </div>
  );
};

/**
 * 裁切标记:四角各两道短线,且在角上故意留缺口 —— 只提示"这是一张纸的边界",
 * 不围出闭合的框(闭合 = 没有出口)。整个界面只靠它占住四角。
 */
const CropMarks = () => (
  <div aria-hidden="true" className="pointer-events-none absolute inset-4">
    <span className="absolute top-0 left-2 h-px w-4 bg-rule" />
    <span className="absolute top-0 right-2 h-px w-4 bg-rule" />
    <span className="absolute bottom-0 left-2 h-px w-4 bg-rule" />
    <span className="absolute bottom-0 right-2 h-px w-4 bg-rule" />
    <span className="absolute top-2 left-0 h-4 w-px bg-rule" />
    <span className="absolute top-2 right-0 h-4 w-px bg-rule" />
    <span className="absolute bottom-2 left-0 h-4 w-px bg-rule" />
    <span className="absolute bottom-2 right-0 h-4 w-px bg-rule" />
  </div>
);

/** 空态:只讲两件事 —— 现在的状态、以及没有 key 时该点哪里。其余交给下沿。 */
const Empty = ({ host }: { readonly host: HostState | null }) => (
  <div className="relative mx-auto flex h-full max-w-[76ch] flex-col items-center justify-center gap-8 text-center">
    <span className="label absolute top-0 right-0 [writing-mode:vertical-rl]">档案 001</span>
    <FolderMark className="mark h-[300px] w-[340px] text-ink/45" />
    <div className="space-y-3">
      <p className="font-display text-4xl leading-none font-bold tracking-tight">启封</p>
      <p className="label">等待第一条记录</p>
      {host === null ? (
        <p className="text-sm text-muted">连不上本地宿主:先起 `pnpm web:host`。</p>
      ) : !host.hasKey ? (
        <p className="text-sm text-muted">宿主没有密钥:启动时设置 DEEPSEEK_API_KEY。</p>
      ) : (
        <p className="label normal-case break-all">工具目录 · {host.cwd}</p>
      )}
    </div>
  </div>
);

/**
 * 思考中:一条**暗带** —— 参照里主体总是出现在暗场里,这是唯一允许用黑底的地方。
 * 中心是发光的卷宗(卡片正被抽出);计时贴右下,状态贴左上,四面没有框。
 */
const ThinkingBand = () => {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSeconds((previous) => previous + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const stamp = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <section
      aria-label="思考中"
      className="relative flex h-[190px] items-center justify-center overflow-hidden bg-ink"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(251,250,249,0.10),transparent_62%)]"
      />
      {/* 一条红线:参照里"正在发生"总是用一根红横线标记 */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-signal" />
      <FolderMark className="mark h-[124px] w-[124px] text-paper drop-shadow-[0_0_12px_rgba(251,250,249,0.4)]" />
      <span className="label absolute top-3 left-4 text-paper/75">思考中</span>
      <span className="label numeral absolute right-4 bottom-3 text-signal-hi">{stamp}</span>
    </section>
  );
};

const BlockView = ({ block }: { readonly block: Block }) => {
  switch (block.kind) {
    case "user":
      // 提问:右对齐 + 右侧一根 1px 墨线(像登记簿上的边注),不填充、不反白
      return (
        <div className="flex justify-end">
          <p className="max-w-[62ch] border-r border-ink/40 pr-4 font-mono text-[12.5px] leading-[1.75] whitespace-pre-wrap text-ink">
            {block.text}
          </p>
        </div>
      );
    case "answer":
      return (
        <article className="max-w-[70ch] py-1 text-[14px] leading-[1.75] whitespace-pre-wrap">
          <div className="label mb-2 flex items-center gap-2">
            <span aria-hidden="true" className="h-px w-4 bg-rule" />
            答复
          </div>
          {block.text}
        </article>
      );
    case "text":
      return (
        <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted whitespace-pre-wrap">
          {block.text}
        </p>
      );
    case "thinking":
      return (
        <details className="max-w-[70ch] pb-1">
          <summary className="label flex cursor-pointer items-center gap-2 select-none">
            <span aria-hidden="true" className="h-px w-4 bg-rule" />
            思维链
          </summary>
          <pre className="mt-2 pl-6 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
            {block.text}
          </pre>
        </details>
      );
    case "tool":
      return (
        <div className="max-w-[70ch] font-mono text-[11px]">
          <div aria-hidden="true" className="hairline" />
          <div className="flex items-baseline gap-2 pt-2">
            <span className="label">工具</span>
            <span className="text-ink">{block.name}</span>
            <code className="truncate text-muted">{previewArgs(block.args)}</code>
            {block.output === undefined && <span className="label ml-auto">…</span>}
          </div>
          {block.output !== undefined && (
            <pre className="mt-2 max-h-56 overflow-auto pl-6 leading-relaxed whitespace-pre-wrap text-muted">
              {block.output}
            </pre>
          )}
        </div>
      );
    case "error":
      return (
        <div className="max-w-[70ch] border-l-2 border-signal py-1 pl-4 text-[12px] leading-relaxed text-signal">
          <div className="label mb-1 text-signal">错误</div>
          {block.text}
        </div>
      );
  }
};
