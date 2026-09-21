/**
 * MonthJump——月／年快速跳轉小卡（M3 ⑤-b 追加 1；主人真機驗收回饋「翻遠日期不該一直按 ‹ ›」）。
 *
 * 入口：頁首 `.date-line` 的月份大字（「9月 2026年」）整組變成一顆無邊框鈕 → `openJump(anchor)` →
 *   CalendarView 渲染本元件。月視圖與週視圖同一顆鈕、同一張卡。
 *
 * 視覺（**沒有原型**——件二 `m3-ext-calendar.html` 沒畫過這個控件）：
 *   照「原型沒有的控件」慣例（拍板 ⑤-b 第 1 條、移植規格 §0 鐵律），**一個新形狀都不發明**，
 *   全部拼既有語彙：
 *     紙卡／眉標／腳註 ＝ `.techo-card`／`.techo-overline`／`.techo-foot`（＝推遲小卡 DeferPopover 同一套形制）
 *     年份 ‹ ›        ＝ 頁首控制列的 `.chev`（calendar.css:84，同一顆按鈕）
 *     月份 chip       ＝ `.opts` ＋ `.status` 小方標（techo.css:336／panel.css:122-132，
 *                        ＝ 側板重複規則編輯器的星期 chip 同一套語彙）
 *     今日            ＝ 頁首控制列的 `.today-chip`（calendar.css:85，同一顆按鈕）
 *     今天所在的月    ＝ 金菱形小記（＝月格 `.cell.today .dnum::before` 的同一枚菱形，尺寸收小）
 *   本元件掛在 `.ns-calendar` 之內（CalendarView 的 section 裡）→ `.chev`／`.today-chip` 直接吃得到。
 *
 * 定位與關閉：逐條沿推遲小卡（`DeferPopover.tsx:110-156`）——量完 anchor 與自身尺寸再落座、
 *   溢出翻到大字上方、clamp 進視窗、`position:fixed` z 60、點卡外／Esc 關、點回大字讓大字自己 toggle。
 *
 * 跳轉語義（一句話：**卡上顯示的永遠是游標現在在哪**，沒有暫存的草稿年）：
 *   年 ‹ ›／年份欄 Enter ＝ 立刻跳到「該年・目前月」，**卡不關**（還要選月份）
 *   月份 chip           ＝ 跳到「目前年・該月」並關卡、焦點回容器
 *   今日                ＝ `goToday()` 並關卡
 *   週視圖的「跳到某月」＝ 該月 1 日所在的那一週（由 `jumpTo` 決定，本元件不管視圖）。
 *
 * 鍵盤（本卡開著時格層鍵盤表整張停用，見 `useCalendarController.blocked`）：
 *   月份 chip 上 `←→` ±1 月、`↑↓` ±4（＝上下一列）移動焦點・`Enter／Space` 由按鈕自己啟動
 *   年份欄裡方向鍵留給 number input 自己（±1 年）・`Enter` 套用
 *   `Tab` 在卡內循環・`Esc` 關閉（自己攔並 stopPropagation，免得冒泡上去被格層 Esc 護欄再關一次）
 *   IME 護欄：組字中（isComposing／keyCode 229）一律不攔（沿 useCalendarKeyboard 鐵則 1）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { isEditableTarget } from "../shell/hotkeys";
import { dateOf, useCalendar, YEAR_MAX, YEAR_MIN } from "./useCalendarController";
import "./monthjump.css";

export interface MonthJumpProps {
  /** 被點的月份大字鈕（定位錨；null＝靠上置中，沿推遲小卡的無錨分支） */
  anchor: HTMLElement | null;
}

/** 一列四顆（3 列 × 4 欄）——與 monthjump.css 的 `grid-template-columns: repeat(4, 1fr)` 同一個數字 */
const COLUMNS = 4;

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export function MonthJump({ anchor }: MonthJumpProps) {
  const c = useCalendar();
  const cur = dateOf(c.cursor);
  const year = cur.getFullYear();
  const month = cur.getMonth() + 1;

  const todayDate = dateOf(c.today);
  const todayYear = todayDate.getFullYear();
  const todayMonth = todayDate.getMonth() + 1;

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /**
   * 年份輸入的打字緩衝：正在打的時候不跳（「2」「20」「202」都是合法數字，逐字跳會亂飛），
   * Enter／失焦才套用；游標的年變了（按 ‹ › 或點今日）就把緩衝同步回來。
   */
  const [draft, setDraft] = useState(String(year));
  useEffect(() => setDraft(String(year)), [year]);

  /* ── 定位：與推遲小卡同一套量法（DeferPopover.tsx:110-129） ── */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const M = 12;
    if (!anchor) {
      setPos({ top: Math.round(vh * 0.24), left: Math.round((vw - w) / 2) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 8;
    if (top + h > vh - M) top = Math.max(M, r.top - h - 8); // 溢出就翻到大字上方
    const left = Math.max(M, Math.min(r.left, vw - w - M));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [anchor]);

  /**
   * 落位之後把焦點放在「目前這個月」那顆 chip（鍵盤流不中斷）。
   * ⚠ 一定要等 pos 落位——落位前是 `visibility:hidden`，`.focus()` 對它是 no-op（DeferPopover.tsx:131-137 同一條坑）。
   * guard 用 ref 不用 deps：之後年份變動重新 render 時不把焦點從 ‹ › 或年份欄搶回來。
   */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    ref.current?.querySelector<HTMLButtonElement>("button[data-mj-month].on")?.focus();
  }, [pos]);

  /* ── 點卡外＝關閉；點回月份大字不處理，交給它自己 toggle ── */
  const closeJump = c.closeJump;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      closeJump();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, closeJump]);

  /** 年 ‹ ›：立刻跳到該年的同一個月，卡不關（還要選月份）。到界就不動（jumpTo 自己夾） */
  const stepYear = (delta: number) => c.jumpTo(year + delta, month);

  /** 年份欄套用：空／非數字／出界一律退回目前年（不靜默跳到 1970） */
  const applyDraft = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < YEAR_MIN || n > YEAR_MAX) {
      setDraft(String(year));
      return;
    }
    if (n !== year) c.jumpTo(n, month);
  };

  const pickMonth = (m: number) => {
    c.jumpTo(year, m);
    closeJump(); // closeJump 自己把焦點送回容器
  };

  const pickToday = () => {
    c.goToday();
    closeJump();
  };

  /** ↑↓←→ 在月份 chip 之間移動；Esc 自己收（不冒泡）；Tab 在卡內循環 */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // M3 ⑦：跳轉卡開著時 `?`／Ctrl+/ 都不叫快捷鍵指引（開關是本地 state，全域表看不到；不擋會再疊一張卡、Esc 互搶）。
    // 年份欄裡打 `?` 仍是打字，只擋導航模式那一下；Ctrl+/ 連年份欄裡都擋（備援鍵的「輸入框」指視圖裡的行內
    // 輸入框，不是跳轉卡裡的）。React 的 stopPropagation 會一路擋到 window（mock 頁實測）。
    if ((e.key === "?" && !isEditableTarget(e.target)) || (e.key === "/" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeJump();
      return;
    }
    if (e.key === "Tab") {
      const focusables = Array.from(ref.current?.querySelectorAll<HTMLElement>("button, input") ?? []).filter(
        (el) => !(el as HTMLButtonElement).disabled,
      );
      if (focusables.length < 2) return;
      const k = focusables.indexOf(document.activeElement as HTMLElement);
      const j = e.shiftKey ? (k <= 0 ? focusables.length - 1 : k - 1) : k >= focusables.length - 1 ? 0 : k + 1;
      e.preventDefault();
      e.stopPropagation();
      focusables[j]?.focus();
      return;
    }
    // 年份欄裡的方向鍵／Enter 歸它自己（number input 的 ↑↓ ＝ ±1 年；Enter 由 input 的 handler 套用）
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el.dataset.mjMonth === undefined) return;

    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button[data-mj-month]") ?? []);
    const i = items.indexOf(el);
    if (i < 0) return;
    const delta =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -COLUMNS : e.key === "ArrowDown" ? COLUMNS : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation(); // 別讓 Ctrl 沒按的方向鍵冒泡到格層（那邊會換日）
    items[(i + delta + items.length) % items.length]?.focus();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="跳到其他月份"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className="ns-monthjump techo-card"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      <p className="techo-overline ns-mj-head">
        <span className="theme-pastel-only">Jump</span>
        <span className="theme-galaxy-only">跳轉 — JUMP</span>
      </p>

      {/* 第一列：‹ 2026 › */}
      <div className="ns-mj-year">
        <button
          type="button"
          className="chev"
          title="上一年"
          aria-label="上一年"
          disabled={year <= YEAR_MIN}
          onClick={() => stepYear(-1)}
        >
          ‹
        </button>
        <input
          type="number"
          className="ns-mj-yin"
          aria-label="年份"
          min={YEAR_MIN}
          max={YEAR_MAX}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={applyDraft}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              applyDraft();
            }
          }}
        />
        <button
          type="button"
          className="chev"
          title="下一年"
          aria-label="下一年"
          disabled={year >= YEAR_MAX}
          onClick={() => stepYear(1)}
        >
          ›
        </button>
      </div>

      {/* 第二區：十二個月份小方標（3 列 × 4 欄；今天所在的月帶金菱形） */}
      <div className="opts ns-mj-months" role="group" aria-label="月份">
        {MONTHS.map((m) => {
          const isToday = year === todayYear && m === todayMonth;
          return (
            <button
              key={m}
              type="button"
              data-mj-month={m}
              className={`status${m === month ? " on" : ""}${isToday ? " has-today" : ""}`}
              aria-pressed={m === month}
              aria-current={isToday ? "date" : undefined}
              title={isToday ? `${year}年${m}月（今天在這個月）` : `${year}年${m}月`}
              onClick={() => pickMonth(m)}
            >
              {m}月
            </button>
          );
        })}
      </div>

      {/* 第三列：今日 */}
      <div className="ns-mj-now">
        <button type="button" className="today-chip" title="跳回今天所在的月份（Home）" onClick={pickToday}>
          今日
        </button>
      </div>

      <div className="techo-foot ns-mj-foot">←→ 選月・Enter 跳・Esc 關閉</div>
    </div>
  );
}
