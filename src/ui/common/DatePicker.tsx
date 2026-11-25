/**
 * DatePicker——挑一天的小浮層（桌機；旅客筆記車次② D-筆-30 抽出的共用元件）。
 *
 * 長相＝上面一行小標＋快選 chip 一排（可省）＋自畫月格 `DayGrid`（可換月、今天外框、選中底色；給了 `marks` 才有記號點）
 * ＋（給了 `onClear` 才有）右下「清除」。底子是旅客筆記車次①的 DatePop。
 * 磨光⑤ S8（D-主-54：日期挑選統一成 App 自畫）起**一律**畫月格，不再退回原生日期欄——以前沒給 `marks` 的呼叫端
 * （今日頁推遲、售票口、筆記改日期）也是同一張格子；側板的日期欄（panel/fields.tsx `DateField`）、大綱日期 chip、
 * 變待辦、時刻表目標起訖也改用本元件（`anchor` 模式）。
 * 用處：旅客筆記（收件匣「排某天」、筆記「改日期」、日記「跳到哪一天／改日期」——日記兩處傳 marks）、今日頁推遲小卡的「選日期…」、
 * 售票口日期與篩選、側板執行日／締切日／起算日／預定到站日、大綱日期 chip、變待辦、時刻表目標起訖。
 * 手機版是同目錄的 `MobileDatePicker`（底部面板）。
 *
 * 三種擺法：
 *   - 內嵌（預設）：版面裡的一塊
 *   - `float`：絕對定位的浮動卡，位置由呼叫端 class 給
 *   - `anchor`（磨光⑤ S8）：掛到 body（portal）、`position: fixed` 貼在 anchor 下方（下方放不下就翻到上方），
 *     給會裁切的捲動容器（側板 `.panel` overflow hidden）、會 hover 位移的列（大綱）與 dialog 裡用。
 *     卡內按鍵一律不往上冒（Ctrl／⌘ 組合鍵放行給全域表），Tab 在卡內循環；收起時焦點還在卡裡（或掉到 body）就還給 anchor。
 *
 * 行為：
 *   - 開啟時焦點落在第一顆 chip（沒有 chip 就是月格上的那一天；anchor 模式反過來，月格優先），內嵌／float 並把自己捲進視野
 *   - 收起時焦點還在卡裡（或掉到 body）就還回去：anchor 模式還 anchor；內嵌／float 還「打開那一刻的焦點」（開關鈕；磨光⑤ 收尾）
 *   - Esc 收起（自理並 stopPropagation，不漏給頁面的鍵盤表）；點外面收起（mousedown capture；
 *     anchor 本身與帶 `data-pop-toggle` 的元素除外——那是開關鈕，讓它自己切換，否則會「關了又被它打開」）
 *   - 月格鍵盤：方向鍵移日、PageUp／PageDown 換月、Enter 選（DayGrid／monthGridMath `gridKeyAction`）
 * 樣式在 `./datepicker.css`（`.ns-datepick*`，不依賴任何一條線的 class）；呼叫端用 `className` 調位置。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { isGuideKey, matches } from "../shell/hotkeys";
import { createPortal } from "react-dom";
import {
  DATE_RANGE_PRESET_LABEL,
  dateRangePreset,
  formatDateRangeBadge,
  type DateRangePreset,
} from "../../domain/dateRange";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { placeBelow, tabStops, useOutsideDismiss } from "./anchorPop";
import { DayGrid } from "./DayGrid";
import { Segmented } from "./Segmented";
import { isPickableDay, stepRangePick, type DateQuickOption } from "./datePickRules";
import "./datepicker.css";

/** 一顆快選 chip */
export type DateQuick = DateQuickOption;

/** 一顆區間快選 chip（第四梯 4B · D-FB-7：週末／本週／下週／本月） */
export interface DateRangeQuick {
  label: string;
  from: string;
  to: string;
}

const RANGE_PRESET_ORDER: readonly DateRangePreset[] = ["weekend", "thisWeek", "nextWeek", "thisMonth"];

export function dateRangeQuickSet(today: string, weekStart: 0 | 1 = 1): DateRangeQuick[] {
  return RANGE_PRESET_ORDER.map((p) => {
    const r = dateRangePreset(p, today, weekStart);
    return { label: DATE_RANGE_PRESET_LABEL[p], from: r.from, to: r.to };
  });
}

const RANGE_MODE_OPTS = [
  { value: "single" as const, label: "乘車日" },
  { value: "range" as const, label: "期間自由券" },
];

export interface DatePickerProps {
  /** 小標（也是 dialog 的 aria-label） */
  label: string;
  /** 目前的日子（日期欄初值；`markValue` 時同日的 chip 亮起）；null／省略＝空 */
  value?: string | null;
  /** 跨日訖日（有值且 > value 時顯示區間連帶；僅 allowRange 時使用） */
  endValue?: string | null;
  /** 目前跨日區間是否為「多日乘車日」（true＝開啟時落在乘車日分頁；false＝落在期間自由券分頁） */
  isMultiDay?: boolean;
  /** YYYY-MM-DD；含 */
  min?: string;
  /** YYYY-MM-DD；含 */
  max?: string;
  /** 快選 chip（乘車日：今天／明天／後天／本週末／下週一；締切日：［＝同乘車日］／今天／明天／本週日／下週一） */
  quick?: readonly DateQuick[];
  /** 是否允許「乘車日（含多日拖曳與＋訖日）｜期間自由券」雙軌切換 */
  allowRange?: boolean;
  /** 自訂區間快選（省略且 allowRange=true 時預設用週末／本週／下週／本月） */
  rangeQuick?: readonly DateRangeQuick[];
  onPick(day: string): void;
  /** 區間選取回呼（end === null 表示單日；isMultiDay === true 表示多日乘車日，false 表示期間自由券） */
  onPickRange?(start: string, end: string | null, isMultiDay?: boolean): void;
  onClose(): void;
  /** true＝絕對定位的浮動卡（霧面票面，位置由呼叫端的 class 給 top／left）；false＝內嵌在版面裡的一塊 */
  float?: boolean;
  /** true＝無 anchor 時以 fixed 置中浮層渲染（供鍵盤觸發推遲小卡用） */
  centered?: boolean;
  /** true＝與 `value` 同日的 chip 亮起（預設 false） */
  markValue?: boolean;
  /** 加在根節點上的 class（呼叫端調 margin／top／left 用） */
  className?: string;
  /** 有記號的日子（YYYY-MM-DD）；省略＝月格沒有記號點（磨光⑤ S8 起不給也畫月格） */
  marks?: ReadonlySet<string>;
  /** 月格掛上時一次、之後每次換月：YYYY-MM（呼叫端補查那個月的記號；沒給就只有呼叫端原本給的那些） */
  onMonthChange?(month: string): void;
  /** 記號的意思（月格下的圖例與讀屏字，例「寫過日記」） */
  marksLabel?: string;
  /** 今天（月格的外框）；省略＝依 uiStore.dayStartHour 算的今天 */
  today?: string;
  /** 給了＝右下多一顆「清除」（可清空的欄位用；磨光⑤ S8）。呼叫端自己收起挑選器 */
  onClear?(): void;
  /** 「清除」那顆的字（例：執行日寫「無日期」）；省略＝清除 */
  clearLabel?: string;
  /** 給了＝掛到 body、貼著這個元素開（見檔頭「三種擺法」）；null／省略＝內嵌或 float */
  anchor?: HTMLElement | null;
}

/** "2026-10-05" → "10/5"（chip 小字；不經 Date.parse） */
export function shortDayKey(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return m && d ? `${m}/${d}` : key;
}

export { isPickableDay };

export function DatePicker({
  label,
  value,
  endValue,
  isMultiDay = false,
  min,
  max,
  quick,
  allowRange = false,
  rangeQuick,
  onPick,
  onPickRange,
  onClose,
  float = false,
  centered = false,
  markValue = false,
  className,
  marks,
  onMonthChange,
  marksLabel,
  today,
  onClear,
  clearLabel = "清除",
  anchor,
}: DatePickerProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);
  const effToday = today ?? todayKey(dayStartHour);
  const hasRangeVal = Boolean(value && endValue && endValue > value);
  const [mode, setMode] = useState<"single" | "range">(() => (allowRange && hasRangeVal && !isMultiDay ? "range" : "single"));
  const [pickingEnd, setPickingEnd] = useState(false);
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const effRangeQuick = allowRange
    ? (rangeQuick ?? dateRangeQuickSet(effToday, weekStart)).filter(
        (rq) => (!min || rq.to >= min) && (!max || rq.from <= max),
      )
    : [];
  const rootRef = useRef<HTMLDivElement>(null);
  const portaled = !!anchor || centered;
  useOutsideDismiss(rootRef, onClose, anchor);

  /* anchor／centered 模式：落位（落位前 visibility:hidden）；捲動／縮放視窗時跟著走 */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const el = rootRef.current;
    if (!portaled || !el) return;
    if (anchor) {
      const at = placeBelow(anchor, el);
      // 第一次就量不到（anchor 沒有框）也要現身——退到視窗左上的邊距，不讓卡永遠 hidden、焦點進不去
      setPos((p) => at ?? p ?? { top: 12, left: 12 });
      return;
    }
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const w = el.offsetWidth || 312;
    const h = el.offsetHeight || 360;
    const M = 12;
    const top = Math.max(M, Math.min(Math.round(vh * 0.2), vh - h - M));
    const left = Math.max(M, Math.round((vw - w) / 2));
    setPos({ top, left });
  }, [anchor, portaled]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    if (!portaled) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [portaled, place]);

  /* 磨光⑤ 收尾（自測 ③：售票口日期浮層 Esc 後焦點掉到頁面本身）：內嵌／float 沒有 anchor，改記「打開那一刻手上的焦點」——
   * 點或按開關鈕打開時就是那顆鈕（桌機 Chromium 點按鈕會聚焦它）。收起時跟 anchor 同一條規則還回去 */
  const [opener] = useState<HTMLElement | null>(() => {
    const a = typeof document === "undefined" ? null : document.activeElement;
    return a instanceof HTMLElement && a !== document.body ? a : null;
  });
  const returnTo = anchor ?? opener;

  useLayoutEffect(() => {
    if (!returnTo) return;
    const root = rootRef.current;
    return () => {
      const a = document.activeElement;
      const lost = !a || a === document.body || (root !== null && root.contains(a));
      if (!lost) return;
      queueMicrotask(() => {
        if (root?.isConnected) return; // 假卸載（StrictMode）或還掛著：不動
        const now = document.activeElement;
        if (now && now !== document.body && !(root?.contains(now) ?? false)) return; // 這期間呼叫端已經交給別處
        if (returnTo.isConnected) returnTo.focus({ preventScroll: true });
      });
    };
  }, [returnTo]);

  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current || (portaled && !pos)) return;
    focusedOnce.current = true;
    const root = rootRef.current;
    const chip = root?.querySelector<HTMLElement>(".ns-datepick-chip") ?? null;
    const day = root?.querySelector<HTMLElement>('[data-day][tabindex="0"]:not(:disabled)') ?? null;
    const first = (portaled ? (day ?? chip) : (chip ?? day)) ?? tabStops(root)[0];
    first?.focus({ preventScroll: true });
    if (!portaled) root?.scrollIntoView({ block: "nearest" }); // 浮層別落在視野外
  }, [portaled, pos]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isGuideKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (!portaled) return;
    if (e.ctrlKey || e.metaKey) {
      if (matches(e, "global.guide")) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.stopPropagation();
    if (e.key === "Tab") {
      const stops = tabStops(rootRef.current);
      if (stops.length < 1) return;
      const k = stops.indexOf(document.activeElement as HTMLElement);
      const j = e.shiftKey ? (k <= 0 ? stops.length - 1 : k - 1) : k >= stops.length - 1 ? 0 : k + 1;
      e.preventDefault();
      stops[j]?.focus();
    }
  };

  const togglePickEnd = () => {
    if (pickingEnd) {
      setPickingEnd(false);
      setDraftStart(null);
      return;
    }
    setPickingEnd(true);
    setDraftStart(value && isPickableDay(value, min, max) ? value : null);
  };

  const handleDayPick = (day: string) => {
    if (allowRange && mode === "range") {
      const step = stepRangePick(draftStart, day);
      if (step.kind === "start") {
        setDraftStart(step.draftStart);
        return;
      }
      setDraftStart(null);
      if (onPickRange) onPickRange(step.start, step.end, false);
      else onPick(step.start);
      return;
    }
    if (allowRange && mode === "single" && pickingEnd) {
      const step = stepRangePick(draftStart, day);
      if (step.kind === "start") {
        setDraftStart(step.draftStart);
        return;
      }
      setDraftStart(null);
      setPickingEnd(false);
      if (onPickRange) onPickRange(step.start, step.end, step.end !== null);
      else onPick(step.start);
      return;
    }
    setDraftStart(null);
    setPickingEnd(false);
    if (allowRange && onPickRange) onPickRange(day, null, false);
    else onPick(day);
  };

  const handleDragRange = (start: string, end: string) => {
    setDraftStart(null);
    setPickingEnd(false);
    if (onPickRange) onPickRange(start, end, true);
    else onPick(start);
  };

  const showSingleChips = (!allowRange || mode === "single") && Boolean(quick?.length);
  const showRangeChips = allowRange && mode === "range" && effRangeQuick.length > 0;
  const activeDraftStart = allowRange && (mode === "range" || pickingEnd) ? draftStart : null;
  const canDragMulti = allowRange && mode === "single" && !pickingEnd;
  const multiActive = allowRange && hasRangeVal && isMultiDay;

  const cls = [
    "ns-datepick",
    (float || portaled) && "float",
    portaled && "anchored",
    !quick?.length && !effRangeQuick.length && !allowRange && "bare",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const style: CSSProperties | undefined = portaled
    ? { position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? undefined : "hidden" }
    : undefined;
  const card = (
    <div ref={rootRef} className={cls} role="dialog" aria-label={label} onKeyDown={onKeyDown} style={style}>
      {allowRange ? (
        <div className="ns-datepick-head">
          <div className="ns-datepick-label">{label}</div>
          <Segmented<"single" | "range">
            compact
            options={RANGE_MODE_OPTS}
            value={mode}
            onChange={(next) => {
              setMode(next);
              setPickingEnd(false);
              setDraftStart(null);
            }}
            aria-label="乘車日或期間自由券"
          />
        </div>
      ) : (
        <div className="ns-datepick-label">{label}</div>
      )}
      {showSingleChips && (
        <div className="ns-datepick-chips">
          {quick!.map((q) => {
            const on = q.day !== "" && markValue && !hasRangeVal && value === q.day;
            return (
              <button
                key={q.label}
                type="button"
                className={"ns-datepick-chip" + (on ? " on" : "")}
                aria-pressed={markValue && q.day !== "" ? on : undefined}
                onClick={() => {
                  setDraftStart(null);
                  setPickingEnd(false);
                  if (q.day === "") {
                    onPick("");
                    return;
                  }
                  if (allowRange && onPickRange) onPickRange(q.day, null, false);
                  else onPick(q.day);
                }}
              >
                {q.label}
                {q.day && <span className="sub">{shortDayKey(q.day)}</span>}
              </button>
            );
          })}
        </div>
      )}
      {showRangeChips && (
        <div className="ns-datepick-chips" role="group" aria-label="期間自由券快選">
          {effRangeQuick.map((rq) => {
            const on = !isMultiDay && value === rq.from && endValue === rq.to;
            return (
              <button
                key={rq.label}
                type="button"
                className={"ns-datepick-chip" + (on ? " on" : "")}
                aria-pressed={on}
                onClick={() => {
                  setDraftStart(null);
                  setPickingEnd(false);
                  if (onPickRange) onPickRange(rq.from, rq.to, false);
                  else onPick(rq.from);
                }}
              >
                {rq.label}
                <span className="sub">{formatDateRangeBadge(rq.from, rq.to)}</span>
              </button>
            );
          })}
        </div>
      )}
      {allowRange && mode === "single" && (
        <div className="ns-datepick-multibar">
          <span className="ns-datepick-multihint" aria-live="polite">
            {pickingEnd
              ? draftStart
                ? `起日 ${shortDayKey(draftStart)} — 請點訖日（可換月）`
                : "先點起日，再點訖日（可換月）"
              : multiActive && value && endValue
                ? `多日 ${formatDateRangeBadge(value, endValue)}（點單日轉單日）`
                : "單點設單日・按住拖曳設多日"}
          </span>
          <button
            type="button"
            className={"ns-datepick-endbtn" + (pickingEnd ? " is-on" : "")}
            aria-pressed={pickingEnd}
            title={pickingEnd ? "取消挑選訖日" : "跨月或點選設定多日乘車日訖日"}
            onClick={togglePickEnd}
          >
            {pickingEnd ? "取消" : multiActive ? "改訖日" : "＋ 訖日"}
          </button>
        </div>
      )}
      {allowRange && mode === "range" && (
        <div className="ns-datepick-rangehint" aria-live="polite">
          {draftStart
            ? `已選起日 ${shortDayKey(draftStart)} — 請點訖日（再點同日＝單日）`
            : hasRangeVal && !isMultiDay && value && endValue
              ? `目前期間：${formatDateRangeBadge(value, endValue)}（點任一日重選起訖）`
              : "先點起日，再點訖日"}
        </div>
      )}
      <DayGrid
        variant="desk"
        value={value}
        endValue={allowRange ? endValue : null}
        draftStart={activeDraftStart}
        today={effToday}
        min={min}
        max={max}
        marks={marks}
        marksLabel={marksLabel}
        onMonthChange={onMonthChange}
        onPick={handleDayPick}
        allowDragRange={canDragMulti}
        onDragRange={canDragMulti ? handleDragRange : undefined}
      />
      {onClear && (
        <div className="ns-datepick-foot">
          <button type="button" className="ns-datepick-clear" onClick={onClear}>
            {clearLabel}
          </button>
        </div>
      )}
    </div>
  );
  return portaled ? createPortal(card, document.body) : card;
}
