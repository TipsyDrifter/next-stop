/**
 * UketsukeSeal——受付章（墨・雙圈事務圓印 +4°；車次①契約 §5.5）。
 *
 * 為什麼本線自建：`Stamps.tsx` 的 `SealReceipt` 是**領収**（備份回執），`Stamps.tsx` 沒有受付章（它的檔頭指回本檔）；
 * 本線不改 `Stamps.tsx`／`stamps.css`（集中檔）。
 *
 * 造形規範：`prototypes/m3-mood-a-stamps.html`（事務圓印、墨、雙圈 外 1.6px／內 .8px、48px、字 12px、+4°）。
 * 樣式在 `notes.css`（乙席；照原型 `styles.css:453-477` 移植），class 名寫死：
 *   `.ns-notes-uke`＋選填 `.is-fresh`（stampIn 同款曲線）／`.mini`（42px；D-筆-31 由 26 放大）／`.ghost`（88px 淡輪廓）；
 *   旋轉角由 CSS 變數 `--ns-rot` 給。顏色只用 `--stamp-ink`（受付章是墨，朱紅只給済章）。
 * 裝飾性：`aria-hidden`——旁邊的文字（「已放進收件匣」、紙片內文）才是資訊。
 *
 * 落點：收件匣紙片右上、收件匣臨時券的 `.stamp-zone`、捕捉存進收件匣時的小章（mini fresh）、空狀態（ghost）。
 */
import type { CSSProperties } from "react";

export interface UketsukeSealProps {
  /** 印內日期的本地日 YYYY-MM-DD（顯示成「M.D」） */
  day: string;
  /** 48＝標準（預設）、42＝mini（車次② D-筆-31）、88＝ghost；26 是車次①的 mini，保留給舊呼叫端（同一個 class，實際 42px） */
  size?: 48 | 42 | 26 | 88;
  /** 剛蓋上去：播一次蓋章動畫（prefers-reduced-motion 由 CSS 處理成直接出現） */
  fresh?: boolean;
  className?: string;
}

const SIZE_CLASS: Record<48 | 42 | 26 | 88, string> = { 48: "", 42: "mini", 26: "mini", 88: "ghost" };

/** "2026-10-05" → "10.5" */
function sealDate(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return m && d ? `${m}.${d}` : "";
}

export function UketsukeSeal({ day, size = 48, fresh = false, className }: UketsukeSealProps) {
  const cls = ["ns-notes-uke", fresh ? "is-fresh" : "", SIZE_CLASS[size], className ?? ""].filter(Boolean).join(" ");
  return (
    <span aria-hidden="true" className={cls} style={{ "--ns-rot": "4deg" } as CSSProperties}>
      受付<small>{sealDate(day)}</small>
    </span>
  );
}
