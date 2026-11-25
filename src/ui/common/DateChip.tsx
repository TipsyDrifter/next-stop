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
 *   UI 丙-4 C6：同一個 id＋kind "dialog" 傳給 MobileDatePicker（換 MSheet 殼）⇒ refcount 合併成一層，返回鍵一次就關。
 * - 快選 chip 是 `aria-pressed` 的按鈕、在 `role="group"` 裡；× 有 `aria-label`＋`title`。
 */
import { useCallback, useId, useRef, useState } from "react";
import { formatDateRangeBadge } from "../../domain/dateRange";
import { todayKey } from "../../lib/date";
import { useUiStore } from "../../store/uiStore";
import { useBackLayer } from "../mobile/backStack";
import { useShell } from "../mobile/useShell";
import { backwardQuickSet, dueQuickSet, scheduledQuickSet } from "./datePickRules";
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

/**
 * 區間 chip 顯示字（v1.37 2A-2 雙軌）：
 * - 無訖日或起訖同日 → `"10/2（五）"`
 * - 多日乘車日（`isMultiDay === true`）或誤點原定（`bare === true`）→ `"10/2–10/4"`
 * - 期間自由券（`isMultiDay === false`）→ `"期間 10/2–10/4"`
 */
export function dateChipRangeText(
  start: string,
  end?: string | null,
  isMultiDay = false,
  bare = false,
): string {
  if (!end || end <= start) return dateChipText(start);
  const badge = formatDateRangeBadge(start, end);
  return isMultiDay || bare ? badge : `期間 ${badge}`;
}

/** 快選兩套（v1.37 2A-1 統一收斂至 datePickRules）：往後＝今天／明天／後天／本週末／下週一；往前＝今天／昨天／前天 */
export function dateQuickSet(kind: "forward" | "backward", today: string, weekStart: 0 | 1 = 1): DateQuick[] {
  return kind === "backward" ? backwardQuickSet(today) : scheduledQuickSet(today, weekStart);
}

export interface DateChipProps {
  /** YYYY-MM-DD；null＝無日期 */
  date: string | null;
  /** 跨日訖日（有值且 > date 時顯示區間；僅 allowRange 時使用） */
  endDate?: string | null;
  /** 是否為多日乘車日（僅 allowRange 時使用：true＝顯示 10/2–10/4，false＝顯示 期間 10/2–10/4） */
  isMultiDay?: boolean;
  /** 挑了一天（或清除＝null） */
  onPick(date: string | null): void;
  /** 區間選取回呼（start=null 表示清除；isMultiDay=true 表多日乘車日、false 表期間自由券） */
  onPickRange?(start: string | null, end: string | null, isMultiDay?: boolean): void;
  /** 是否允許挑選乘車日（含多日）與期間自由券雙軌 */
  allowRange?: boolean;
  /** 行內外顯快選列：往後／往前；省略＝不在 chip 外再畫一排 */
  quick?: "forward" | "backward";
  /** 面板內部快選預設（scheduled＝乘車日 5 顆；due＝締切日含＝同乘車日；省略時 allowRange 預設走 scheduled） */
  preset?: "scheduled" | "due";
  /** 締切日用：所屬票的乘車日（有值時在締切日面板首位顯示「＝同乘車日」） */
  syncScheduledOn?: string | null;
  /** 自訂面板內快選（覆蓋 preset） */
  pickerQuick?: readonly DateQuick[];
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
  endDate,
  isMultiDay = false,
  onPick,
  onPickRange,
  allowRange = false,
  quick,
  preset,
  syncScheduledOn,
  pickerQuick,
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
  const weekStart = useUiStore((s) => s.weekStart);
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
    if (allowRange && onPickRange) {
      if (d !== date || (endDate ?? null) !== null || isMultiDay) onPickRange(d, null, false);
      return;
    }
    if (d !== date) onPick(d);
  };

  const pickRange = (start: string, end: string | null, nextMulti = false): void => {
    const normEnd = end && end > start ? end : null;
    const effMulti = normEnd ? Boolean(nextMulti) : false;
    if (mobile) closeSheet();
    else setOpen(false);
    if (onPickRange) {
      if (start !== date || normEnd !== (endDate ?? null) || effMulti !== Boolean(isMultiDay)) {
        onPickRange(start, normEnd, effMulti);
      }
    } else if (start !== date) {
      onPick(start);
    }
  };

  const text = date
    ? allowRange
      ? dateChipRangeText(date, endDate, isMultiDay, flag === "late")
      : dateChipText(date)
    : emptyText;
  const backfill = flag === "backfill";
  const quicks = quick ? dateQuickSet(quick, today, weekStart) : [];
  const rawPopQuick: readonly DateQuick[] =
    pickerQuick ??
    (preset === "due"
      ? dueQuickSet(today, { scheduledOn: syncScheduledOn, weekStart })
      : preset === "scheduled" || allowRange
        ? scheduledQuickSet(today, weekStart)
        : quick
          ? dateQuickSet(quick, today, weekStart)
          : []);
  const popQuicks = rawPopQuick.filter((q) => q.day === "" || inRange(q.day));
  const hasRangeVal = Boolean(allowRange && date && endDate && endDate > date);

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
            const on = !hasRangeVal && date === q.day;
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
            endValue={allowRange ? endDate : null}
            isMultiDay={allowRange ? isMultiDay : false}
            allowRange={allowRange}
            min={lo}
            max={max}
            quick={popQuicks}
            today={today}
            onPick={(d) => pick(d)}
            onPickRange={allowRange ? pickRange : undefined}
            onClear={clearable && date ? () => pick(null) : undefined}
            onClose={closeSheet}
            backId={layerId}
            backKind="dialog"
          />
        ) : (
          <DatePicker
            anchor={chipRef.current}
            label={label}
            value={date}
            endValue={allowRange ? endDate : null}
            isMultiDay={allowRange ? isMultiDay : false}
            allowRange={allowRange}
            quick={popQuicks}
            markValue
            min={lo}
            max={max}
            today={today}
            onPick={(d) => pick(d)}
            onPickRange={allowRange ? pickRange : undefined}
            onClear={clearable && date ? () => pick(null) : undefined}
            onClose={close}
          />
        ))}
    </span>
  );
}
