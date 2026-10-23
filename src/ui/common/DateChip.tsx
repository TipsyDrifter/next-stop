/**
 * DateChip——「挑一天」的觸發器（視覺規範 §2.5「日期」：觸發統一成日期 chip；丙-2 契約 §1 第 5 件）。
 * 框 chip 顯示「10/22（四）」或「無日期」；點了開挑選器——桌機＝共用 `DatePicker`（anchor 模式：掛 body、貼在 chip 下方的 docked popover），
 * 手機＝共用 `MobileDatePicker`（底部 sheet）；兩殼用 `useShell` 分，本體兩支都不動。
 * 側板底線字、推遲清單項、變待辦 chip、日記大字、大綱日期 chip（帶旗子＝補記）都換成它（丙-3～6 套用）。
 * 長相＝prototypes/ui-brand「日期 chip（觸發器）」；樣式在 `./datefield.css` 的 `.ns-datechip*`。
 *
 *   span.ns-datechip-wrap
 *     button.ns-datechip[.is-empty｜.is-late｜.is-open]（svg 日曆或旗子＋字）
 *     button.ns-iconbtn.ns-datechip-clear ×（clearable 且有值才有）
 *     span.ns-datechip-quick（quick 給了才有）> button.chip.ns-chip…
 *
 * 規則：
 * - 快選兩套（§2.5）：往後 `forward`＝今天／明天／後天／下週一；往前 `backward`＝今天／昨天／前天。畫在 chip 右側一列
 *   （ui-brand 手機表單樣本「10/22（四）明天 後天」）；跟目前值同一天的亮起（`--sel-bg`）；落在可選範圍外的 disabled＋title。
 * - 能不能挑過去（E20 手機補記）：`allowPast` 省略時，`backward` 預設可以、其餘預設不行（min＝今天）；給了 `min` 以 `min` 為準。
 *   兩殼同一條規則（磨光⑦ D-主-67：執行日改到過去＝補記）。
 * - 旗子：`late`＝過期赭字赭框（同票面 `.chip.late` 的意思）；`backfill`＝圖示換成旗子、title「補記」（大綱日期 chip）。
 * - 清除：`clearable` 且有值 ⇒ chip 右邊一顆淡態 ×（兩殼同一個位置；桌機浮層裡另有「清除」，同 DateField）⇒ `onPick(null)`。
 * - 挑了跟目前值一樣的日子不叫 `onPick`（同 panel/fields DateField）。
 *
 * ARIA 與鍵盤：
 * - chip：`aria-haspopup="dialog"`、`aria-expanded`、`aria-label`＝「{label}：10/22（四）」；Enter／Space 開關（原生 button）。
 * - 桌機浮層的鍵盤（方向鍵移日、PageUp／PageDown 換月、Enter 選、Esc 收、Tab 在卡內循環、收起還焦點給 chip）全在 DatePicker／DayGrid。
 * - 手機 sheet：Esc＝取消（MobileDatePicker）；返回鍵由本元件 `useBackLayer` 登記成 "dialog" 層（可疊在全螢幕頁之上）；收起後焦點還給 chip。
 * - 快選 chip 是 `aria-pressed` 的按鈕、在 `role="group"` 裡；× 有 `aria-label`＋`title`。
 */
import { useCallback, useId, useRef, useState } from "react";
import { addDays, todayKey } from "../../lib/date";
import { useUiStore } from "../../store/uiStore";
import { useBackLayer } from "../mobile/backStack";
import { useShell } from "../mobile/useShell";
import { DatePicker, type DateQuick } from "./DatePicker";
import { IconCalendar, IconClose, IconFlag } from "./icons";
import { MobileDatePicker } from "./MobileDatePicker";

const WEEK_ZH = "日一二三四五六";

/** "2026-10-22" → "10/22（四）"（chip 的字；壞字串原樣回傳） */
export function dateChipText(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return `${m}/${d}（${WEEK_ZH[new Date(y, m - 1, d).getDay()]}）`;
}

/** 嚴格晚於 today 的最近週一（今天就是週一 ⇒ 七天後；同 schedule/streamModel nextMonday） */
function nextMondayOf(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(today, (8 - dow) % 7 || 7);
}

/** 快選兩套（§2.5）：往後＝今天／明天／後天／下週一；往前＝今天／昨天／前天 */
export function dateQuickSet(kind: "forward" | "backward", today: string): DateQuick[] {
  if (kind === "backward") {
    return [
      { label: "今天", day: today },
      { label: "昨天", day: addDays(today, -1) },
      { label: "前天", day: addDays(today, -2) },
    ];
  }
  return [
    { label: "今天", day: today },
    { label: "明天", day: addDays(today, 1) },
    { label: "後天", day: addDays(today, 2) },
    { label: "下週一", day: nextMondayOf(today) },
  ];
}

export interface DateChipProps {
  /** YYYY-MM-DD；null＝無日期 */
  date: string | null;
  /** 挑了一天（或清除＝null） */
  onPick(date: string | null): void;
  /** 快選列：往後／往前；省略＝沒有快選列 */
  quick?: "forward" | "backward";
  /** late＝過期赭字；backfill＝旗子圖示＋「補記」 */
  flag?: "late" | "backfill";
  /** 可以挑今天以前（E20 手機補記）；省略＝backward 可以、其餘不行 */
  allowPast?: boolean;
  /** 欄位名（aria-label 前綴、挑選器標題；預設「日期」） */
  label?: string;
  /** YYYY-MM-DD（含）；給了就以它為準（蓋過 allowPast 的 min＝今天） */
  min?: string;
  /** YYYY-MM-DD（含） */
  max?: string;
  /** 有值時可清成無日期（× 與浮層「清除」） */
  clearable?: boolean;
  disabled?: boolean;
  /** 今天（快選與月格外框的基準）；省略＝依 uiStore.dayStartHour 算 */
  today?: string;
  /** 沒值時的字（預設「無日期」） */
  emptyText?: string;
  className?: string;
}

export function DateChip({
  date,
  onPick,
  quick,
  flag,
  allowPast,
  label = "日期",
  min,
  max,
  clearable = false,
  disabled = false,
  today: todayProp,
  emptyText = "無日期",
  className,
}: DateChipProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayProp ?? todayKey(dayStartHour);
  const mobile = useShell() === "mobile";
  const chipRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const past = allowPast ?? quick === "backward";
  const lo = min ?? (past ? undefined : today);
  const inRange = (d: string): boolean => (!lo || d >= lo) && (!max || d <= max);

  // 手機 sheet 的返回鍵；"dialog"＝可疊在全螢幕頁（full）之上（backStack 檔頭）。每個實例各自一層
  const layerId = "common.datechip." + useId();
  const closeSheet = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => chipRef.current?.focus({ preventScroll: true }));
  }, []);
  useBackLayer(layerId, open && mobile, closeSheet, "dialog");

  const pick = (d: string | null): void => {
    if (mobile) closeSheet();
    else setOpen(false);
    if (d !== date) onPick(d);
  };

  const text = date ? dateChipText(date) : emptyText;
  const backfill = flag === "backfill";
  const quicks = quick ? dateQuickSet(quick, today) : [];

  return (
    <span className={"ns-datechip-wrap" + (className ? " " + className : "")}>
      <button
        ref={chipRef}
        type="button"
        className={
          "ns-datechip" + (date ? "" : " is-empty") + (flag === "late" ? " is-late" : "") + (open ? " is-open" : "")
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}：${text}${backfill ? "（補記）" : ""}`}
        title={backfill ? "補記" : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {backfill ? <IconFlag /> : <IconCalendar />}
        {text}
      </button>
      {clearable && date && !disabled && (
        <button
          type="button"
          className="ns-iconbtn ns-datechip-clear"
          aria-label={`清除${label}`}
          title="清除"
          onClick={() => pick(null)}
        >
          <IconClose />
        </button>
      )}
      {quicks.length > 0 && (
        <span className="ns-datechip-quick" role="group" aria-label={`${label}・快選`}>
          {quicks.map((q) => {
            const on = date === q.day;
            const ok = inRange(q.day);
            return (
              <button
                key={q.label}
                type="button"
                className={"chip ns-chip" + (on ? " is-on" : "")}
                aria-pressed={on}
                disabled={disabled || !ok}
                title={ok ? dateChipText(q.day) : "不在可選的範圍內"}
                onClick={() => pick(q.day)}
              >
                {q.label}
              </button>
            );
          })}
        </span>
      )}
      {open &&
        (mobile ? (
          <MobileDatePicker
            title={label}
            value={date}
            min={lo}
            max={max}
            quick={[]}
            today={today}
            onPick={(d) => pick(d)}
            onClose={closeSheet}
          />
        ) : (
          <DatePicker
            anchor={chipRef.current}
            label={label}
            value={date}
            markValue
            min={lo}
            max={max}
            today={today}
            onPick={(d) => pick(d)}
            onClear={clearable && date ? () => pick(null) : undefined}
            onClose={close}
          />
        ))}
    </span>
  );
}
