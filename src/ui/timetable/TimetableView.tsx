/**
 * TimetableView——時刻表桌機頁（車次①a 契約 §5.2；乙席）。根 `div.page.ns-tt`，照今日頁殼契約（TodayView.tsx:132）。
 *
 *   div.page.ns-tt[data-view="split"|"axis"][data-layout="wide"|"narrow"]（tabIndex=0；鍵盤表掛這裡；sheet 開著時停用）
 *   ├─ header.ns-tt-head   .techo-overline「時刻表 — TIMETABLE」＋ h1.techo-title「時刻表」＋ 右側 div.ns-tt-switch（兩欄｜只看軸、鍵帽 V）
 *   ├─ div.ns-tt-cols
 *   │   ├─ div.ns-tt-col.is-left（split：RunDock desktop 在左欄頂端（D-時-22）＋ DepartBoard；寬 380px）
 *   │   └─ div.ns-tt-col.is-right（自己捲動）→ Axis scroller="self"；axis 視圖：RunDock 置於 Axis 上方、左欄不渲染
 *   └─ DesktopSheetHost
 *
 * - 進頁：`init("desktop")` → `autoAsk("enter", true)`；`useTimetableForeground({ ask: true })`（回前景重讀＋問，丙席實作）。
 * - 寬度不足 960px（ResizeObserver 量 .ns-tt）時 split 自動退成單欄（運行列＋發車台＋軸依序疊、整頁捲動），不改寫 view 設定。
 * - 視圖兩殼各記各的（settings key `timetable_view`，契約 0-6）；`V` 與頂端切換鈕都走 `store.toggleView／setView`。
 * - 車次①b：鍵盤表十個鍵全部接上（KEY_ACTIONS）；F2 的 body 後援監聽（①b①c 契約 0-13）。
 * - 車次③（③ 契約 §5.1、0-7；D-時-46；丙席）：切換鈕四格「兩欄｜V｜只看軸｜週｜統計」，鍵帽 1–4（整合席已登記
 *   `timetable.view.1`～`4` 並接上 KEY_ACTIONS；鍵帽照 manifest 由 formatChord 產）。週／統計：頁首下放運行列（同只看軸），下面一塊自己捲
 *   （data-view="week"|"stats"，§K）。#72：每次掛上（不只第一次 init）都 `ensureFreshDay()`。
 * - 車次④（④ 契約 0-7、§5.10；D-時-74；整合席）：第五格「日程」（鍵帽 5，`timetable.view.5`）；data-view="schedule"，頁首下運行列＋
 *   ScheduleView（自己 flex:1、時間軸自己捲）。←／→／T 在日程＝換日（同軸、共用 dayKey）；→ 可以翻到未來（日程能排明天以後）。
 *   從日程翻到未來再切回軸／兩欄時，dayKey 拉回今天（軸只看今天以前）。
 * - 車次⑤（⑤ 契約 0-6、§5.1；D-時-92、102、104；整合席）：第六格「方眼」（鍵帽 6，`timetable.view.6`）；data-view="grid"，頁首下運行列＋
 *   GridView（不包 `.ns-tt-vscroll`，方眼自己決定捲不捲；單欄版面由 §M 的 :has 認）。←／→／T 在方眼＝換日，照軸：→ 翻不過今天。
 *   「切回時未來日拉回今天」的排除清單不含 grid＝從日程翻到未來再切到方眼也拉回今天（方眼不能記未來，D-時-100）。
 * - 磨光③ 2-3：切換鈕右邊固定一顆「分類與設定」（鍵帽 E，`timetable.settings`）；頁首右側包成 div.ns-tt-head-tools。
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { TT_TEXT, useTimetableStore, type TimetableView as TimetableViewMode } from "../../store/timetableStore";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import { Kbd, RunDock } from "./parts/RunDock";
import { DepartBoard } from "./parts/DepartBoard";
import { Axis } from "./parts/Axis";
import { DesktopSheetHost } from "./DesktopSheetHost";
import { WeekView, rememberDeskAxisView } from "./week/WeekView";
import { StatsView } from "./stats/StatsView";
import { ScheduleView } from "./schedule/ScheduleView";
import { GridView } from "./grid/GridView";
import { useTimetableStatsStore } from "../../store/timetableStatsStore";
import { handleTimetableKey, useTimetableKeyboard, type TimetableKeyActions } from "./useTimetableKeyboard";
import { useTimetableForeground } from "./useTimetableForeground";
import { MIN, msOf } from "../../domain/timetable";
import { addDays } from "../../lib/date";
import "./timetable.css";

/** 兩欄撐不開的門檻（契約 §5.2） */
const NARROW_PX = 960;

/** 視圖切換六格（D-時-46；④ D-時-74 加日程；⑤ D-時-92 加方眼）；n＝鍵帽 1–6（鍵 id `timetable.view.<n>`，整合席登記） */
const VIEW_OPTIONS: { v: TimetableViewMode; label: string; n: number }[] = [
  { v: "split", label: TT_TEXT.weekUi.viewSplit, n: 1 },
  { v: "axis", label: TT_TEXT.weekUi.viewAxis, n: 2 },
  { v: "week", label: TT_TEXT.viewWeek, n: 3 },
  { v: "stats", label: TT_TEXT.viewStats, n: 4 },
  { v: "schedule", label: TT_TEXT.viewSchedule, n: 5 },
  { v: "grid", label: TT_TEXT.viewGrid, n: 6 },
];

/** 鍵帽字：manifest 有登記就照它（formatChord，不手抄）；還沒登記先印數字 */
function viewKeyCap(n: number): string {
  const h = hotkeyById(`timetable.view.${n}`);
  return h ? formatChord(h.chords[0]).join("+") : String(n);
}

/** S：運行中那一班至少跑了這麼久才切得開（＝SplitPanel 的「不到兩分鐘切不開」） */
const SPLIT_MIN_MS = 2 * MIN;

/**
 * 鍵盤表的接線（①a 三鍵＋①b 七鍵，契約 §5.9；③ 七鍵，③ 契約 §5.8）：一律在按下當下讀 store（不吃 render 時的快照）。
 * 回 false＝放行（不 preventDefault）。
 * ③：←／→／T 依 view 分派——週視圖＝`weekStep(±1)`／`weekToCurrent()`，統計＝`step(±1)`／`toCurrent()`，其餘照舊換日；
 * 已在本週／本期時 →、T 放行（同「看今天時 → 放行」）。D／W／M 只在統計視圖作用。
 * ④：日程＝換日（同軸、共用 dayKey），但 → 不卡在今天（日程能翻到未來排時刻）。
 * ⑤：方眼＝換日，照軸（→ 在今天放行，D-時-102）——走下面「其餘」那條，不另分支。
 */
const KEY_ACTIONS: TimetableKeyActions = {
  depart: () => useTimetableStore.getState().requestDepart(),
  arrive: () => {
    const s = useTimetableStore.getState();
    if (!s.running) return false;
    s.requestArrive();
    return true;
  },
  toggleView: () => useTimetableStore.getState().toggleView("desktop"),
  dayPrev: () => {
    const s = useTimetableStore.getState();
    if (s.view === "week") return useTimetableStatsStore.getState().weekStep(-1);
    if (s.view === "stats") return useTimetableStatsStore.getState().step(-1);
    void s.setDayKey(addDays(s.dayKey, -1));
  },
  dayNext: () => {
    const s = useTimetableStore.getState();
    if (s.view === "week" || s.view === "stats") {
      const st = useTimetableStatsStore.getState();
      if (s.view === "week" ? st.weekFollow : st.followCurrent) return false; // 已在本週／本期：未來翻不過去
      if (s.view === "week") st.weekStep(1);
      else st.step(1);
      return true;
    }
    if (s.view !== "schedule" && s.dayKey >= s.todayKey) return false; // 軸：看今天時放行；日程可以往未來翻
    void s.setDayKey(addDays(s.dayKey, 1));
    return true;
  },
  dayToday: () => {
    const s = useTimetableStore.getState();
    if (s.view === "week" || s.view === "stats") {
      const st = useTimetableStatsStore.getState();
      if (s.view === "week" ? st.weekFollow : st.followCurrent) return false;
      if (s.view === "week") st.weekToCurrent();
      else st.toCurrent();
      return true;
    }
    if (s.dayKey === s.todayKey) return false;
    void s.setDayKey(s.todayKey);
    return true;
  },
  restart: () => {
    const s = useTimetableStore.getState();
    if (!s.running) return false;
    s.openSheet({ kind: "restart", blockId: s.running.id });
    return true;
  },
  settings: () => useTimetableStore.getState().openSheet({ kind: "categories" }),
  split: () => {
    const s = useTimetableStore.getState();
    if (!s.running || Date.now() - msOf(s.running.started_at) < SPLIT_MIN_MS) return false;
    s.openSheet({ kind: "split", blockId: s.running.id });
    return true;
  },
  fill: () => useTimetableStore.getState().requestFillLatestGap(),
  showView: (v) => useTimetableStore.getState().setView(v),
  statsPeriod: (p) => {
    if (useTimetableStore.getState().view !== "stats") return false;
    useTimetableStatsStore.getState().setPeriod(p);
    return true;
  },
};

export function TimetableView() {
  const view = useTimetableStore((s) => s.view);
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const ready = useTimetableStore((s) => s.ready);
  const error = useTimetableStore((s) => s.error);
  const setView = useTimetableStore((s) => s.setView);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  // 進頁：載入 → 問一聲（契約 0-10「進頁」觸發點）。③ #72：init 只有第一次真的讀；之後每次掛上都檢查換日
  useEffect(() => {
    const store = useTimetableStore.getState();
    void store
      .init("desktop")
      .then(() => useTimetableStore.getState().ensureFreshDay())
      .then(() => useTimetableStore.getState().autoAsk("enter", true))
      .catch(() => undefined); // 載入失敗寫在 store.error，頁面上顯示
  }, []);
  // 記住上次的兩欄／只看軸（週視圖點塊跳軸時回到它；日程、方眼不算——rememberDeskAxisView 只收 split／axis）
  useEffect(() => rememberDeskAxisView(view), [view]);
  // ④：日程翻到未來後切回軸／兩欄 ⇒ dayKey 拉回今天（軸的 → 本來就翻不過今天）。⑤：方眼不在排除清單（同軸，不能記未來）
  useEffect(() => {
    if (view === "schedule" || view === "week" || view === "stats") return;
    const s = useTimetableStore.getState();
    if (s.dayKey > s.todayKey) void s.setDayKey(s.todayKey);
  }, [view]);
  useTimetableForeground({ ask: true });

  // 寬度不足就退成單欄；只量根節點，不改 view 設定
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(w < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 鍵盤表只在這一頁、沒有輸入框聚焦時作用：進頁把焦點放到根節點（Ctrl+5 直達後 N／Enter／V 立刻可用）
  useEffect(() => {
    const el = rootRef.current;
    if (el && (document.activeElement === document.body || document.activeElement === null)) el.focus();
  }, []);

  // 面板關掉（被點的鈕整棵 unmount）、toast 動作鈕按完（「改 10 分前」「撤回」在 App 根的 Toast 裡）之後，瀏覽器把焦點退回
  // body；body 上的 keydown 不經過 .page ⇒ N／Enter／V 失效。沒人持有焦點時把焦點還給根節點（同今日頁 useTodayController 的做法）。
  useEffect(() => {
    if (sheet !== null || typeof document === "undefined") return;
    const el = rootRef.current;
    if (el && (document.activeElement === document.body || document.activeElement === null)) el.focus();
  }, [sheet, running]);

  const onKeyDown = useTimetableKeyboard(KEY_ACTIONS, sheet !== null);

  // F2（①b①c 契約 0-13）：全域疊層（設定、Ctrl+P、`?`、旅客筆記的捕捉框…）關掉後焦點落在 body，body 上的 keydown
  // 不經過 .page ⇒ 在 window 掛後援，只在 target 是 body、沒有任何對話框開著、時刻表沒有面板開著時交給同一支 handler。
  // 焦點本來就在 .page 裡時 target 不是 body，不會重複觸發。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target !== document.body) return;
      if (document.querySelector('[aria-modal="true"], .ns-dialog') !== null) return;
      if (useTimetableStore.getState().sheet !== null) return;
      handleTimetableKey(e, KEY_ACTIONS, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const viewKey = hotkeyById("timetable.view");
  const mode: "split" | "axis" | "week" | "stats" | "schedule" | "grid" =
    view === "week" || view === "stats" || view === "schedule" || view === "grid" ? view : view === "axis" ? "axis" : "split"; // 手機記的 board 在桌機＝兩欄
  const split = mode === "split";
  const stacked = narrow && split; // 單欄疊放：運行列 → 發車台 → 軸（整頁捲動）

  return (
    <div
      ref={rootRef}
      className="page ns-tt"
      data-view={mode}
      data-layout={narrow ? "narrow" : "wide"}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="時刻表"
    >
      <header className="ns-tt-head">
        <div className="ns-tt-head-main">
          <p className="techo-overline">時刻表 — TIMETABLE</p>
          <h1 className="techo-title">時刻表</h1>
        </div>
        <div className="ns-tt-head-tools">
          <div className="ns-tt-switch" role="group" aria-label="視圖">
            {VIEW_OPTIONS.map((o, i) => (
              <Fragment key={o.v}>
                <button type="button" aria-pressed={mode === o.v} onClick={() => setView(o.v)}>
                  {o.label}
                  <kbd className="ns-tt-kbd" aria-hidden="true">
                    {viewKeyCap(o.n)}
                  </kbd>
                </button>
                {/* V（兩欄⇄只看軸；在週／統計按 V 回兩欄）的鍵帽留在前兩格之間（§5.1） */}
                {i === 0 && viewKey && (
                  <span className="ns-tt-switch-v" title={viewKey.label} aria-hidden="true">
                    <kbd className="ns-tt-kbd">{formatChord(viewKey.chords[0]).join("+")}</kbd>
                  </span>
                )}
              </Fragment>
            ))}
          </div>
          {/* 磨光③ 2-3：「分類與設定」固定入口（每個視圖都在）；按下放掉焦點，面板關掉後 Enter 才回到「到着」 */}
          <button
            type="button"
            className="ns-btn btn-ghost ns-tt-setbtn"
            onClick={(e) => {
              e.currentTarget.blur();
              useTimetableStore.getState().openSheet({ kind: "categories" });
            }}
          >
            {TT_TEXT.settingsBtn}
            <Kbd id="timetable.settings" />
          </button>
        </div>
      </header>

      {error && !ready && <p className="ns-tt-error">⚠ {error}</p>}

      <div className="ns-tt-cols">
        {stacked ? (
          <div className="ns-tt-col is-stack">
            <RunDock variant="desktop" />
            <DepartBoard />
            <Axis scroller="page" />
          </div>
        ) : split ? (
          <>
            <div className="ns-tt-col is-left">
              <RunDock variant="desktop" />
              <DepartBoard />
            </div>
            <div className="ns-tt-col is-right">
              <Axis scroller="self" />
            </div>
          </>
        ) : mode === "axis" ? (
          <div className="ns-tt-col is-right is-full">
            <RunDock variant="desktop" />
            <Axis scroller={narrow ? "page" : "self"} />
          </div>
        ) : mode === "schedule" ? (
          <div className="ns-tt-col is-right is-wide">
            <RunDock variant="desktop" />
            <ScheduleView />
          </div>
        ) : mode === "grid" ? (
          <div className="ns-tt-col is-right is-wide">
            <RunDock variant="desktop" />
            <GridView shell="desktop" />
          </div>
        ) : (
          <div className="ns-tt-col is-right is-wide">
            <RunDock variant="desktop" />
            <div className="ns-tt-vscroll">{mode === "week" ? <WeekView shell="desktop" /> : <StatsView />}</div>
          </div>
        )}
      </div>

      <DesktopSheetHost />
    </div>
  );
}
