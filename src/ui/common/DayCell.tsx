/**
 * DayCell——日曆的一格（視覺規範 §2.5「日曆格」；丙-2 契約 §1 第 11 件）。
 * 行程表月格、時刻表週欄、售票口日曆共用同一格：格高、今天標記（赭菱形）、有事標記（墨點）、選中（`--sel-bg`）。
 * 長相＝prototypes/ui-brand「日曆格 DayCell」；樣式在 `./datefield.css` 的 `.ns-daycells`（7 欄格線容器）／`.ns-daycell`。
 * 格寬由容器決定：`.ns-daycells` 撐滿父層寬、7 欄平分（minmax(0, 1fr)：格內清單再長也不撐歪欄寬）；本元件不定寬。
 * 本班只建、不套：行程表 `calendar/DayCell.tsx`（同名、行程表專用）與各線自畫的格丙-3～6 才改接。
 *
 *   div.ns-daycell[.is-today｜.is-on｜.is-out][data-day]
 *     button.ns-daycell-hit（蓋滿整格的點擊面；aria-label 念整格）
 *     span.ns-daycell-num（日數；今天赭字，數字左側同列一顆 ::before 赭菱形——照 ui-brand）
 *     span.dots > i×min(marks,3)（墨點 --stamp-ink；左下）
 *     button.ns-iconbtn.ns-daycell-add「＋」（onAdd 給了才有；右上；常駐淡態 --dim，格被 hover／聚焦時轉實——取代「hover 才出現的＋」）；不進 Tab 順序（月格只留 roving 一個 Tab stop），鍵盤走「格上 Enter 開日浮層 → 底端『＋ 車票』」
 *     div.ns-daycell-body（children：格內清單等）
 *
 * 窄格（格寬 <65px，例：手機殼一週 7 格每格約 45px）：「◆22」跟右上「＋」並排放不下，改由 CSS container query 挪位置——
 * 「＋」到右下、墨點改接在日數正下方；再窄到約 42px 以下菱形收掉、只留赭字。門檻與實量在 datefield.css 的 DayCell 段。
 *
 * 為什麼點擊面是一顆蓋滿的 button、而不是整格當 button：格內還要放「＋」與呼叫端的 children（票名列、可點的小牌），
 * 按鈕裡不能再放按鈕。數字、點、children 疊在點擊面上、預設不吃指標（點下去落到點擊面）；children 裡的 button／a／input 照常可點。
 *
 * ARIA 與鍵盤：
 * - 點擊面：`aria-label`「10月22日（今天），有 3 件」（可用 `ariaLabel` 整句覆寫）、選中 `aria-pressed`、今天 `aria-current="date"`；
 *   `tabIndex` 由呼叫端給（月格的 roving tabindex：只有焦點格 0、其餘 −1；方向鍵移格由外層格線處理，同 DayGrid／monthGridMath）。
 * - 區間外的格（`out`）：淡字、不可聚焦（tabIndex −1），仍可點（例：月格點上個月的日子換月）——不給 onClick 就 disabled。
 * - 「＋」：`aria-label`／`title`＝addLabel（預設「在這天新增」）；Enter／Space 原生按鈕。
 */
import type { ReactNode } from "react";
import { IconPlus } from "./icons";

export interface DayCellProps {
  /** YYYY-MM-DD */
  date: string;
  /** 是今天（赭字＋赭菱形） */
  today?: boolean;
  /** 有事的筆數（墨點，最多畫 3 顆；0／省略＝不畫） */
  marks?: number;
  /** 選中（--sel-bg 底、--sel-fg 字） */
  selected?: boolean;
  /** 不在目前區間（月格的上／下個月）：淡字、不可聚焦 */
  out?: boolean;
  /** 點這一格；anchor＝點擊面（開當日浮層時貼它） */
  onClick?(date: string, anchor: HTMLElement): void;
  /** 給了＝右上一顆常駐淡態「＋」 */
  onAdd?(date: string): void;
  /** 「＋」的 aria-label／title（預設「在這天新增」） */
  addLabel?: string;
  /** 墨點在讀屏裡念的單位（預設「件」：「有 3 件」） */
  marksUnit?: string;
  /** 整句覆寫點擊面的 aria-label */
  ariaLabel?: string;
  /** 點擊面的 tabIndex（roving tabindex 用；out 一律 −1） */
  tabIndex?: number;
  className?: string;
  children?: ReactNode;
}

export function DayCell({
  date,
  today = false,
  marks = 0,
  selected = false,
  out = false,
  onClick,
  onAdd,
  addLabel = "在這天新增",
  marksUnit = "件",
  ariaLabel,
  tabIndex,
  className,
  children,
}: DayCellProps) {
  const [, m, d] = date.split("-").map(Number);
  const dots = Math.max(0, Math.min(3, Math.floor(marks)));
  const said = ariaLabel ?? `${m}月${d}日` + (today ? "（今天）" : "") + (marks > 0 ? `，有 ${marks} ${marksUnit}` : "");
  const cls = ["ns-daycell", today && "is-today", selected && "is-on", out && "is-out", !onClick && "is-static", className].filter(Boolean).join(" ");
  return (
    <div className={cls} data-day={date}>
      <button
        type="button"
        className="ns-daycell-hit"
        aria-label={said}
        aria-pressed={selected}
        aria-current={today ? "date" : undefined}
        tabIndex={out ? -1 : tabIndex}
        disabled={!onClick}
        onClick={(e) => onClick?.(date, e.currentTarget)}
      />
      <span className="ns-daycell-num" aria-hidden>
        {d}
      </span>
      {dots > 0 && (
        <span className="dots" aria-hidden>
          {Array.from({ length: dots }, (_, i) => (
            <i key={i} />
          ))}
        </span>
      )}
      {onAdd && (
        <button type="button" className="ns-iconbtn ns-daycell-add" tabIndex={-1} aria-label={addLabel} title={addLabel} onClick={() => onAdd(date)}>
          <IconPlus />
        </button>
      )}
      {children != null && <div className="ns-daycell-body">{children}</div>}
    </div>
  );
}
