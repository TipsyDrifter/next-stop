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
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { DayGrid } from "./DayGrid";
import { isPickableDay } from "./datePickRules";
import "./datepicker.css";

/** 一顆快選 chip */
export interface DateQuick {
  label: string;
  /** YYYY-MM-DD */
  day: string;
}

export interface DatePickerProps {
  /** 小標（也是 dialog 的 aria-label） */
  label: string;
  /** 目前的日子（日期欄初值；`markValue` 時同日的 chip 亮起）；null／省略＝空 */
  value?: string | null;
  /** YYYY-MM-DD；含 */
  min?: string;
  /** YYYY-MM-DD；含 */
  max?: string;
  /** 快選 chip（例：明天／後天／下週一；今天／昨天／前天） */
  quick?: readonly DateQuick[];
  onPick(day: string): void;
  onClose(): void;
  /** true＝絕對定位的浮動卡（霧面票面，位置由呼叫端的 class 給 top／left）；false＝內嵌在版面裡的一塊 */
  float?: boolean;
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
  /** 給了＝掛到 body、貼著這個元素開（見檔頭「三種擺法」）；null／省略＝內嵌或 float */
  anchor?: HTMLElement | null;
}

/** "2026-10-05" → "10/5"（chip 小字；不經 Date.parse） */
export function shortDayKey(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return m && d ? `${m}/${d}` : key;
}

export { isPickableDay };

/** 點浮層外面就收起；anchor 本身與帶 `data-pop-toggle` 的元素（開關鈕）除外 */
function useOutsideDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, anchor?: HTMLElement | null): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      const t = e.target;
      if (!el || !(t instanceof Node)) return;
      if (el.contains(t)) return;
      if (anchor?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle]")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [ref, onClose, anchor]);
}

/** 卡裡 Tab 會停的元素（月格只有 roving 那一格是 tabIndex 0） */
function tabStops(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>("button, input") ?? []).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
}

/** anchor 模式的落點：anchor 下方 6px、左緣對齊；下方放不下翻到上方；夾進視窗（同 PopMenu）。anchor 沒有框（被收起）＝null，留在原處 */
function placeBelow(anchor: HTMLElement, el: HTMLElement): { top: number; left: number } | null {
  const { offsetWidth: w, offsetHeight: h } = el;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = document.documentElement.clientHeight || window.innerHeight;
  const M = 12;
  const r = anchor.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  let top = r.bottom + 6;
  if (top + h > vh - M) top = Math.max(M, r.top - h - 6);
  const left = Math.max(M, Math.min(r.left, vw - w - M));
  return { top: Math.round(top), left: Math.round(left) };
}

export function DatePicker({
  label,
  value,
  min,
  max,
  quick,
  onPick,
  onClose,
  float = false,
  markValue = false,
  className,
  marks,
  onMonthChange,
  marksLabel,
  today,
  onClear,
  anchor,
}: DatePickerProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const rootRef = useRef<HTMLDivElement>(null);
  const anchored = !!anchor;
  useOutsideDismiss(rootRef, onClose, anchor);

  /* anchor 模式：落位（落位前 visibility:hidden）；捲動／縮放視窗時跟著 anchor 走 */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const el = rootRef.current;
    if (!anchor || !el) return;
    const at = placeBelow(anchor, el);
    // 第一次就量不到（anchor 沒有框）也要現身——退到視窗左上的邊距，不讓卡永遠 hidden、焦點進不去
    setPos((p) => at ?? p ?? { top: 12, left: 12 });
  }, [anchor]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, place]);

  /* 磨光⑤ 收尾（自測 ③：售票口日期浮層 Esc 後焦點掉到頁面本身）：內嵌／float 沒有 anchor，改記「打開那一刻手上的焦點」——
   * 點或按開關鈕打開時就是那顆鈕（桌機 Chromium 點按鈕會聚焦它）。收起時跟 anchor 同一條規則還回去 */
  const [opener] = useState<HTMLElement | null>(() => {
    const a = typeof document === "undefined" ? null : document.activeElement;
    return a instanceof HTMLElement && a !== document.body ? a : null;
  });
  const returnTo = anchor ?? opener;

  /* 收起時：焦點還在卡裡或掉到 body ⇒ 還給 anchor（內嵌／float＝開它的那個元素）；呼叫端已經把焦點交給別處就不搶。
   * 卸載前（節點還在）先看焦點在不在卡裡，等這一輪提交完（microtask）卡真的不在了才還——dev 的 StrictMode 會「假卸載再掛回」，
   * 當場就還會把剛開的卡的焦點搶回開關鈕（float 卡開著焦點卻在鈕上、Esc 漏給頁面；磨光⑤ 收尾實測） */
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

  /* 開啟時焦點：第一顆 chip → 月格上的那一天 → 第一顆可按的鈕。anchor 模式等落位後才 focus（hidden 時 focus 是 no-op）。
   * anchor 模式改成月格那一天優先（磨光⑤ S8）：這些是「改一個日期欄」，點開就該能方向鍵＋Enter 選；「今天」快選 Tab 得到 */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current || (anchored && !pos)) return;
    focusedOnce.current = true;
    const root = rootRef.current;
    const chip = root?.querySelector<HTMLElement>(".ns-datepick-chip") ?? null;
    const day = root?.querySelector<HTMLElement>('[data-day][tabindex="0"]:not(:disabled)') ?? null;
    const first = (anchored ? (day ?? chip) : (chip ?? day)) ?? tabStops(root)[0];
    first?.focus({ preventScroll: true });
    if (!anchored) root?.scrollIntoView({ block: "nearest" }); // 浮層別落在視野外
  }, [anchored, pos]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (!anchored) return;
    // anchor 模式：卡掛在 body，按鍵照 React 樹冒泡會落到開它的列／側板／dialog 的鍵盤表上——一律擋下。
    // Ctrl／⌘ 組合鍵放行給全域表（Ctrl+/ 例外，指引頁不疊在卡上；同 PopMenu）
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "/") {
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

  const cls = ["ns-datepick", (float || anchored) && "float", anchored && "anchored", !quick?.length && "bare", className]
    .filter(Boolean)
    .join(" ");
  const style: CSSProperties | undefined = anchored
    ? { position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? undefined : "hidden" }
    : undefined;
  const card = (
    <div ref={rootRef} className={cls} role="dialog" aria-label={label} onKeyDown={onKeyDown} style={style}>
      <div className="ns-datepick-label">{label}</div>
      <div className="ns-datepick-chips">
        {quick?.map((q) => {
          const on = markValue && value === q.day;
          return (
            <button
              key={q.label}
              type="button"
              className={"ns-datepick-chip" + (on ? " on" : "")}
              aria-pressed={markValue ? on : undefined}
              onClick={() => onPick(q.day)}
            >
              {q.label}
              <span className="sub">{shortDayKey(q.day)}</span>
            </button>
          );
        })}
      </div>
      <DayGrid
        variant="desk"
        value={value}
        today={today ?? todayKey(dayStartHour)}
        min={min}
        max={max}
        marks={marks}
        marksLabel={marksLabel}
        onMonthChange={onMonthChange}
        onPick={onPick}
      />
      {onClear && (
        <div className="ns-datepick-foot">
          <button type="button" className="ns-datepick-clear" onClick={onClear}>
            清除
          </button>
        </div>
      )}
    </div>
  );
  return anchored ? createPortal(card, document.body) : card;
}
