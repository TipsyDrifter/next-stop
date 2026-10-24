/**
 * CategoryBadge——分類圓牌（車次①a 契約 §5.1；甲席 Stage 0）。
 * `span.ns-tt-badge[.is-sm|.is-lg]`，顏色經 `--c: var(--ns-tt-cat-N)`（N＝colorSlot(color_idx)，越界夾回 1–8）；
 * 內容＝glyph ?? name 的第一個字元 ?? "・"。`cat` 為 null（分類已不在）＝`.is-missing` 灰圈「？」。
 *
 * UI 丙-7 正在跑（使用者 10-24「全部赭框＋呼吸點」）：`live` ⇒ 外面包一層 RunMark，圓徽右上肩一顆呼吸的赭點。
 * 正在跑的那一班在所有視圖都同一種畫法：赭實線框（各卡自己的 .is-live）＋這顆點。
 */
import type { CSSProperties, ReactNode } from "react";
import { colorSlot, type TimeCategoryRow } from "../../domain/timetable";

export interface CategoryBadgeProps {
  cat: TimeCategoryRow | null;
  size?: "sm" | "md" | "lg";
  /** 磨光⑦：點得到（運行列的圓牌＝開編輯面板）。只給滑鼠／手指，不進 Tab 順序——鍵盤走旁邊的分類名 */
  onPress?: () => void;
  /** 正在跑的那一班：圓徽右上肩加呼吸赭點（RunMark） */
  live?: boolean;
}

/**
 * RunMark——「正在跑」的呼吸點，掛在一顆圓徽（分類圓牌、路線圓牌）的右上肩。
 * `span.ns-tt-runmark > {圓徽} ＋ i.ns-tt-live-dot.is-mark`；包層 inline-flex、不佔額外寬度，原本排版不動。
 */
export function RunMark({ children }: { children: ReactNode }) {
  return (
    <span className="ns-tt-runmark">
      {children}
      <i className="ns-tt-live-dot is-mark" aria-hidden="true" />
    </span>
  );
}

export function CategoryBadge({ cat, size = "md", onPress, live }: CategoryBadgeProps) {
  const sizeClass = (size === "sm" ? " is-sm" : size === "lg" ? " is-lg" : "") + (onPress ? " is-press" : "");
  let badge: ReactNode;
  if (!cat) {
    badge = (
      <span className={"ns-tt-badge is-missing" + sizeClass} aria-label="分類已刪除" onClick={onPress}>
        ？
      </span>
    );
  } else {
    const style = { "--c": `var(--ns-tt-cat-${colorSlot(cat.color_idx)})` } as CSSProperties;
    const text = cat.glyph ?? Array.from(cat.name)[0] ?? "・";
    badge = (
      <span className={"ns-tt-badge" + sizeClass} style={style} aria-hidden="true" onClick={onPress}>
        {text}
      </span>
    );
  }
  return live ? <RunMark>{badge}</RunMark> : badge;
}
