/**
 * CategoryBadge——分類圓牌（車次①a 契約 §5.1；甲席 Stage 0）。
 * `span.ns-tt-badge[.is-sm|.is-lg]`，顏色經 `--c: var(--ns-tt-cat-N)`（N＝colorSlot(color_idx)，越界夾回 1–8）；
 * 內容＝glyph ?? name 的第一個字元 ?? "・"。`cat` 為 null（分類已不在）＝`.is-missing` 灰圈「？」。
 */
import type { CSSProperties } from "react";
import { colorSlot, type TimeCategoryRow } from "../../domain/timetable";

export interface CategoryBadgeProps {
  cat: TimeCategoryRow | null;
  size?: "sm" | "md" | "lg";
  /** 磨光⑦：點得到（運行列的圓牌＝開編輯面板）。只給滑鼠／手指，不進 Tab 順序——鍵盤走旁邊的分類名 */
  onPress?: () => void;
}

export function CategoryBadge({ cat, size = "md", onPress }: CategoryBadgeProps) {
  const sizeClass = (size === "sm" ? " is-sm" : size === "lg" ? " is-lg" : "") + (onPress ? " is-press" : "");
  if (!cat) {
    return (
      <span className={"ns-tt-badge is-missing" + sizeClass} aria-label="分類已刪除" onClick={onPress}>
        ？
      </span>
    );
  }
  const style = { "--c": `var(--ns-tt-cat-${colorSlot(cat.color_idx)})` } as CSSProperties;
  const text = cat.glyph ?? Array.from(cat.name)[0] ?? "・";
  return (
    <span className={"ns-tt-badge" + sizeClass} style={style} aria-hidden="true" onClick={onPress}>
      {text}
    </span>
  );
}
