/**
 * MobileTimetable——時刻表手機頁（車次①a 契約 §5.3；D-時-22；丙席）。
 * 回 Fragment，兩段都是 MobileShell 根 flex column 的直接子節點（與今日頁 `.m-page`＋`.m-newticket` 同構）：
 *   div.m-page.ns-tt-m[data-view]   頂端 sticky 切換鈕（發車台｜軸）＋ DepartBoard（4 欄）或 Axis（scroller="page"）
 *   div.ns-tt-mdock                 頁面與 tab bar 之間、不跟著捲走；內放 RunDock variant="mobile"
 *   MobileSheetHost                 store.sheet → panel（從底部升起）
 * 進頁：`store.init("mobile")` → `autoAsk("enter", true)`。回前景由 TimetableMobileAgent 處理，頁面不重複掛。
 * `mobileView` 的型別是 `ComponentType<{ onBack?: () => void }>`，tab 格的頁不會收到 onBack。
 * 車次③（③ 契約 §5.1、0-7；D-時-46；丙席）：切換鈕四格「發車台｜軸｜週｜統計」；週＝WeekView（每小時 28px），統計＝乙席的
 * MobileStats；底部運行列照舊。#72：每次掛上都 `ensureFreshDay()`（init 只有第一次真的讀）。
 * 車次④（④ 契約 0-7、§5.10；D-時-74；整合席）：第五格「日程」＝MobileTtSchedule（切換鈕下面；.m-page 改直欄不捲由 §L 的 :has 處理）。
 *   從日程翻到未來再切回軸時，dayKey 拉回今天（同桌機）。
 * 車次⑤（⑤ 契約 0-6、§5.2；D-時-92、101、108；整合席）：第六格「方眼」＝GridView shell="mobile"（切換鈕下面；整頁不捲由 §M 的 :has 處理）；
 *   塗色列 MobileGridDock 是 .m-page 之外、.ns-tt-mdock 之後的兄弟節點（程式地圖 §九-6；Toast 抬高靠後續兄弟選擇器，不 portal）。
 *   「切回時未來日拉回今天」的排除清單不含 grid（方眼照軸，不能記未來）。
 */
import { useEffect } from "react";
import type { TimetableView } from "../../../store/timetableStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { Axis } from "../parts/Axis";
import { DepartBoard } from "../parts/DepartBoard";
import { RunDock } from "../parts/RunDock";
import { MobileSheetHost } from "./MobileSheetHost";
import { WeekView } from "../week/WeekView";
import { MobileStats } from "../stats/MobileStats";
import { MobileTtSchedule } from "../schedule/MobileTtSchedule";
import { GridView, MobileGridDock } from "../grid/GridView";
import "../timetable.css";

export function MobileTimetable(_props: { onBack?: () => void }) {
  const view = useTimetableStore((s) => s.view);
  const error = useTimetableStore((s) => s.error);
  const ready = useTimetableStore((s) => s.ready);
  const setView = useTimetableStore((s) => s.setView);
  const init = useTimetableStore((s) => s.init);
  const autoAsk = useTimetableStore((s) => s.autoAsk);

  useEffect(() => {
    void init("mobile")
      .then(() => useTimetableStore.getState().ensureFreshDay())
      .then(() => autoAsk("enter", true))
      .catch(() => undefined); // 載入失敗已寫進 store.error
  }, [init, autoAsk]);

  // ④：日程翻到未來後切回軸／發車台 ⇒ dayKey 拉回今天（軸的日期列翻不過今天）。⑤：方眼不在排除清單（同軸）
  useEffect(() => {
    if (view === "schedule" || view === "week" || view === "stats") return;
    const s = useTimetableStore.getState();
    if (s.dayKey > s.todayKey) void s.setDayKey(s.todayKey);
  }, [view]);

  type MobileView = Extract<TimetableView, "board" | "axis" | "week" | "stats" | "schedule" | "grid">;
  const mobileView: MobileView =
    view === "axis" || view === "week" || view === "stats" || view === "schedule" || view === "grid" ? view : "board"; // 桌機記的 split 在手機＝發車台
  const T = TT_TEXT.weekUi;
  const options: { v: MobileView; label: string }[] = [
    { v: "board", label: T.viewBoard },
    { v: "axis", label: T.viewAxisMobile },
    { v: "week", label: TT_TEXT.viewWeek },
    { v: "stats", label: TT_TEXT.viewStats },
    { v: "schedule", label: TT_TEXT.viewSchedule },
    { v: "grid", label: TT_TEXT.viewGrid },
  ];

  return (
    <>
      <div className="m-page ns-tt-m" data-view={mobileView}>
        <div className="ns-tt-mtop">
          <div className="ns-tt-switch" role="group" aria-label="視圖">
            {options.map((o) => (
              <button type="button" key={o.v} aria-pressed={mobileView === o.v} onClick={() => setView(o.v)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {error && !ready && <p className="ns-tt-m-error">{error}</p>}
        {mobileView === "board" ? (
          <DepartBoard />
        ) : mobileView === "axis" ? (
          <Axis scroller="page" />
        ) : mobileView === "week" ? (
          <WeekView shell="mobile" />
        ) : mobileView === "schedule" ? (
          <MobileTtSchedule />
        ) : mobileView === "grid" ? (
          <GridView shell="mobile" />
        ) : (
          <MobileStats />
        )}
      </div>
      <div className="ns-tt-mdock">
        <RunDock variant="mobile" />
      </div>
      {mobileView === "grid" && <MobileGridDock />}
      <MobileSheetHost />
    </>
  );
}
