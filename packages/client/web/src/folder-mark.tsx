// 卷宗夹:一叠卡片装在夹子里,最上面那张正被抽出一点。
// 主题是「档案」(这是档案的载体本身),不是航天;几何语言(多条 1px 细线、虚线疏密、一个几何主体)
// 借自参照片,题材不借 —— 影片里的十字只留在 style-references.md 里当拆解样本。

interface FolderMarkProps {
  readonly className?: string;
}

export const FolderMark = ({ className = "" }: FolderMarkProps) => (
  <svg viewBox="-120 -120 240 240" className={className} aria-hidden="true" fill="none">
    {/* 整组上移 14:夹子轮廓偏下(标签位在上面),不上移会显得重心压低 */}
    <g stroke="currentColor" transform="translate(0 -14)">
      {/* 卷宗夹外轮廓:左上一段凸起,是夹子的标签位 */}
      <path
        d="M-104 92 V-58 H-26 V-34 H104 V92 Z"
        strokeWidth="1"
        strokeOpacity="1"
        strokeLinejoin="miter"
      />

      {/* 标签位:一条档号线 + 一个装订孔 */}
      <line x1="-94" y1="-46" x2="-52" y2="-46" strokeWidth="0.6" strokeOpacity="0.8" />
      <circle cx="-40" cy="-46" r="3.2" strokeWidth="0.6" strokeOpacity="0.8" />

      {/* 卡片:略微歪一点(手插进去的卡不会正),抽出动画在 .mark-card */}
      <g className="mark-card" transform="rotate(-1.4)">
        <rect x="-84" y="-20" width="168" height="98" strokeWidth="0.8" strokeOpacity="0.95" />
        {/* 卡片自己的装订孔 */}
        <circle cx="-70" cy="-6" r="2.8" strokeWidth="0.6" strokeOpacity="0.8" />
        <line x1="-56" y1="12" x2="68" y2="12" strokeWidth="0.6" strokeOpacity="0.75" />
        <line x1="-68" y1="34" x2="68" y2="34" strokeWidth="0.6" strokeOpacity="0.75" />
        <line
          x1="-68"
          y1="56"
          x2="20"
          y2="56"
          strokeWidth="0.5"
          strokeOpacity="0.6"
          strokeDasharray="1 4"
        />
      </g>
    </g>
  </svg>
);
