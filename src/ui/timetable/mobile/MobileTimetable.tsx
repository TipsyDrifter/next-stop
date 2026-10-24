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
 * 磨光③ 2-3：頂端切換列右邊（六格之外）固定一顆 button.ns-tt-msetbtn「設定」（aria-label／title「分類與設定」）開分類與設定。
 * UI 丙-4 F1：頂端切換列換成今日頂帶下一列同款 `.ns-tabrow`——<Tabs scroll>（發車台／軸／週／統計／日程／方眼；
 *   超過 4 段末段露半格＝還能捲）＋末端 span.mgr 文字鈕「管理」（＝手機唯一的分類與設定入口，A3）。
 *   籤列仍住在頁內 sticky 的 div.ns-tt-mtop（不走 MobileTopBand 的 tabsRow 插槽：那要改集中檔 MobileShell）。
 *   舊方格切換鈕與 .ns-tt-msetbtn 退役。
 */
import { useEffect, useMemo } from "react";
import type { TimetableView } from "../../../store/timetableStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { Tabs, type TabItem } from "../../common/Tabs";
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
  const openSheet = useTimetableStore((s) => s.openSheet);

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
  const tabs = useMemo<readonly TabItem<MobileView>[]>(() => {
    const T = TT_TEXT.weekUi;
    return [
      { key: "board", label: T.viewBoard },
      { key: "axis", label: T.viewAxisMobile },
      { key: "week", label: TT_TEXT.viewWeek },
      { key: "stats", label: TT_TEXT.viewStats },
      { key: "schedule", label: TT_TEXT.viewSchedule },
      { key: "grid", label: TT_TEXT.viewGrid },
    ];
  }, []);

  return (
    <>
      <div className="m-page ns-tt-m" data-view={mobileView}>
        {/* UI 丙-4 F1：頁內 sticky 的籤列＝.ns-tabrow 同款（籤＋末端「管理」同一片玻璃） */}
        <div className="ns-tt-mtop ns-tabrow">
          <Tabs items={tabs} value={mobileView} onChange={setView} scroll aria-label="時刻表檢視" />
          <span className="mgr">
            <button
              type="button"
              className="ns-btn btn-text ns-btn--sm"
              // 可讀名＝看得到的「管理」（讀屏與語音控制都對得上）；開的是什麼放 title
              title={TT_TEXT.settingsBtn}
              onClick={() => openSheet({ kind: "categories" })}
            >
              {TT_TEXT.settingsBtnShort}
            </button>
          </span>
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
