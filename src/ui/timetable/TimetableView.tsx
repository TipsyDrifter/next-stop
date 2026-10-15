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
 */
import { useEffect, useRef, useState } from "react";
import { useTimetableStore, type TimetableView as TimetableViewMode } from "../../store/timetableStore";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import { RunDock } from "./parts/RunDock";
import { DepartBoard } from "./parts/DepartBoard";
import { Axis } from "./parts/Axis";
import { DesktopSheetHost } from "./DesktopSheetHost";
import { handleTimetableKey, useTimetableKeyboard, type TimetableKeyActions } from "./useTimetableKeyboard";
import { useTimetableForeground } from "./useTimetableForeground";
import { MIN, msOf } from "../../domain/timetable";
import { addDays } from "../../lib/date";
import "./timetable.css";

/** 兩欄撐不開的門檻（契約 §5.2） */
const NARROW_PX = 960;

const VIEW_OPTIONS: { v: TimetableViewMode; label: string }[] = [
  { v: "split", label: "兩欄" },
  { v: "axis", label: "只看軸" },
];

/** S：運行中那一班至少跑了這麼久才切得開（＝SplitPanel 的「不到兩分鐘切不開」） */
const SPLIT_MIN_MS = 2 * MIN;

/**
 * 鍵盤表的接線（①a 三鍵＋①b 七鍵，契約 §5.9）：一律在按下當下讀 store（不吃 render 時的快照）。
 * 回 false＝放行（不 preventDefault）。
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
    void s.setDayKey(addDays(s.dayKey, -1));
  },
  dayNext: () => {
    const s = useTimetableStore.getState();
    if (s.dayKey === s.todayKey) return false;
    void s.setDayKey(addDays(s.dayKey, 1));
    return true;
  },
  dayToday: () => {
    const s = useTimetableStore.getState();
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

  // 進頁：載入 → 問一聲（契約 0-10「進頁」觸發點）
  useEffect(() => {
    const store = useTimetableStore.getState();
    void store
      .init("desktop")
      .then(() => useTimetableStore.getState().autoAsk("enter", true))
      .catch(() => undefined); // 載入失敗寫在 store.error，頁面上顯示
  }, []);
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
  const split = view !== "axis";
  const stacked = narrow && split; // 單欄疊放：運行列 → 發車台 → 軸（整頁捲動）

  return (
    <div
      ref={rootRef}
      className="page ns-tt"
      data-view={split ? "split" : "axis"}
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
        <div className="ns-tt-switch" role="group" aria-label="視圖">
          {VIEW_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.v}
              aria-pressed={view === o.v || (o.v === "split" && split)}
              onClick={() => setView(o.v)}
            >
              {o.label}
            </button>
          ))}
          {viewKey && (
            <kbd className="ns-tt-kbd" aria-hidden="true" title={viewKey.label}>
              {formatChord(viewKey.chords[0]).join("+")}
            </kbd>
          )}
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
        ) : (
          <div className="ns-tt-col is-right is-full">
            <RunDock variant="desktop" />
            <Axis scroller={narrow ? "page" : "self"} />
          </div>
        )}
      </div>

      <DesktopSheetHost />
    </div>
  );
}
