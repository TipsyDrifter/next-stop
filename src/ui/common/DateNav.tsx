/**
 * DateNav——翻日期導覽（視覺規範 §2.5「日期」、§3 入口表「翻日期」；丙-2 契約 §1 第 4 件）。
 * 「‹ 標題 ›」＋「今天」chip；要換年的再加「« »」（兩殼都有）。取代各頁 8 種自畫的翻頁列（丙-3～6 套用）。
 * 長相＝prototypes/ui-brand「DateNav（翻日期）」：箭頭＝`.ns-iconbtn`（28×28，手機 44；overlay.css）、標題＝襯線 700 `--fs-h3`、
 * 「今天」＝選項 chip `.chip.ns-chip`。樣式在 `./datefield.css` 的 `.ns-datenav*`；手機只靠 `[data-shell="mobile"]` 的 token 換尺寸。
 *
 *   div.ns-datenav[role=group]
 *     button.ns-iconbtn «（onPrevYear 給了才有）
 *     button.ns-iconbtn ‹
 *     span.t（或 button.t：給了 onTitle＝點標題開月份跳轉／DatePicker）
 *     button.ns-iconbtn ›
 *     button.ns-iconbtn »（onNextYear 給了才有）
 *     button.chip.ns-chip「今天」
 *
 * 狀態：「今天」chip 一律可按（主席 10-22 裁：一般 chip，按了＝回今天；已在今天就是原地不動）——不因 `isToday` 禁用、長相不變，
 *   `isToday` 只補 title「已經在今天」；`prevDisabled`／`nextDisabled`（例：日記不能翻到未來）⇒ 該箭頭 disabled。
 *
 * ARIA 與鍵盤：
 * - 外層 `role="group"`＋`aria-label`（預設「翻日期」）；標題 `aria-live="polite"`——按箭頭後讀屏念出新的日期。
 * - 每顆箭頭 `aria-label`＋`title`（依 `unit`：前一天／後一天、上一週／下一週、上個月／下個月、上一年／下一年；« »＝上一年／下一年）。
 *   `unit="year"`（UI 丙-5：售票口統計的年模式）＝‹ › 一下走一年；這時不要再給 onPrevYear／onNextYear（« » 會跟 ‹ › 同一個意思）。
 * - 標題是按鈕時帶 `aria-haspopup="dialog"`＋`aria-expanded`（由 `titleExpanded` 給）。
 * - 全部是原生 button：Tab 依序走、Enter／Space 觸發；不攔方向鍵（頁面的 ←→ 快捷鍵另在 hotkeys 表，不在這裡重綁）。
 */
import type { ReactNode } from "react";
import { IconBack, IconChevron, IconFirst, IconLast } from "./icons";

/** 箭頭一下走多遠（決定 aria-label／title 的字） */
export type DateNavUnit = "day" | "week" | "month" | "year";

const UNIT_WORDS: Readonly<Record<DateNavUnit, readonly [string, string]>> = {
  day: ["前一天", "後一天"],
  week: ["上一週", "下一週"],
  month: ["上個月", "下個月"],
  year: ["上一年", "下一年"],
};

export interface DateNavProps {
  /** 中間的標題（「10/22（四）」「2026年10月」…） */
  title: ReactNode;
  onPrev(): void;
  onNext(): void;
  /** 回到今天（月檢視＝回到本月） */
  onToday(): void;
  /** 給了＝最左多一顆「«」（上一年） */
  onPrevYear?(): void;
  /** 給了＝最右多一顆「»」（下一年） */
  onNextYear?(): void;
  /** 目前就在今天（或本月）：「今天」chip 照樣可按、長相不變，只補 title「已經在今天」（10-22 裁定：不禁用） */
  isToday?: boolean;
  /** 箭頭的單位（預設 day） */
  unit?: DateNavUnit;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  /** 「今天」chip 的字（預設「今天」） */
  todayLabel?: string;
  /** 給了＝標題變成按鈕（開月份跳轉、DatePicker…）；參數是標題那顆鈕，給 anchor 用 */
  onTitle?(anchor: HTMLElement): void;
  /** 標題按鈕開著的浮層狀態（aria-expanded） */
  titleExpanded?: boolean;
  /** 整組的 aria-label（預設「翻日期」） */
  label?: string;
  className?: string;
}

/** 箭頭圖示（icons.tsx；§1.7 同一個意思不畫第二份）：‹＝IconBack、›＝IconChevron、«＝IconFirst、»＝IconLast */
const GLYPH = { back: IconBack, fwd: IconChevron, first: IconFirst, last: IconLast } as const;

export function DateNav({
  title,
  onPrev,
  onNext,
  onToday,
  onPrevYear,
  onNextYear,
  isToday = false,
  unit = "day",
  prevDisabled = false,
  nextDisabled = false,
  todayLabel = "今天",
  onTitle,
  titleExpanded,
  label = "翻日期",
  className,
}: DateNavProps) {
  const [prevWord, nextWord] = UNIT_WORDS[unit];
  const arrow = (word: string, Glyph: (typeof GLYPH)[keyof typeof GLYPH], onClick: () => void, disabled = false) => (
    <button type="button" className="ns-iconbtn" aria-label={word} title={word} disabled={disabled} onClick={onClick}>
      <Glyph />
    </button>
  );
  return (
    <div className={"ns-datenav" + (className ? " " + className : "")} role="group" aria-label={label}>
      {onPrevYear && arrow("上一年", GLYPH.first, onPrevYear)}
      {arrow(prevWord, GLYPH.back, onPrev, prevDisabled)}
      {onTitle ? (
        <button
          type="button"
          className="t is-btn"
          aria-haspopup="dialog"
          aria-expanded={titleExpanded}
          aria-live="polite"
          onClick={(e) => onTitle(e.currentTarget)}
        >
          {title}
        </button>
      ) : (
        <span className="t" aria-live="polite">
          {title}
        </span>
      )}
      {arrow(nextWord, GLYPH.fwd, onNext, nextDisabled)}
      {onNextYear && arrow("下一年", GLYPH.last, onNextYear)}
      <button
        type="button"
        className="chip ns-chip"
        title={isToday ? `已經在${todayLabel}` : undefined}
        onClick={onToday}
      >
        {todayLabel}
      </button>
    </div>
  );
}
