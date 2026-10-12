/**
 * MobileTimetable——時刻表手機頁（車次①a 契約 §5.3；D-時-22；丙席）。
 * 回 Fragment，兩段都是 MobileShell 根 flex column 的直接子節點（與今日頁 `.m-page`＋`.m-newticket` 同構）：
 *   div.m-page.ns-tt-m[data-view]   頂端 sticky 切換鈕（發車台｜軸）＋ DepartBoard（4 欄）或 Axis（scroller="page"）
 *   div.ns-tt-mdock                 頁面與 tab bar 之間、不跟著捲走；內放 RunDock variant="mobile"
 *   MobileSheetHost                 store.sheet → panel（從底部升起）
 * 進頁：`store.init("mobile")` → `autoAsk("enter", true)`。回前景由 TimetableMobileAgent 處理，頁面不重複掛。
 * `mobileView` 的型別是 `ComponentType<{ onBack?: () => void }>`，tab 格的頁不會收到 onBack。
 */
import { useEffect } from "react";
import { useTimetableStore } from "../../../store/timetableStore";
import { Axis } from "../parts/Axis";
import { DepartBoard } from "../parts/DepartBoard";
import { RunDock } from "../parts/RunDock";
import { MobileSheetHost } from "./MobileSheetHost";
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
      .then(() => autoAsk("enter", true))
      .catch(() => undefined); // 載入失敗已寫進 store.error
  }, [init, autoAsk]);

  const mobileView: "board" | "axis" = view === "axis" ? "axis" : "board";

  return (
    <>
      <div className="m-page ns-tt-m" data-view={mobileView}>
        <div className="ns-tt-mtop">
          <div className="ns-tt-switch" role="group" aria-label="視圖">
            <button type="button" aria-pressed={mobileView === "board"} onClick={() => setView("board")}>
              發車台
            </button>
            <button type="button" aria-pressed={mobileView === "axis"} onClick={() => setView("axis")}>
              軸
            </button>
          </div>
        </div>
        {error && !ready && <p className="ns-tt-m-error">{error}</p>}
        {mobileView === "board" ? <DepartBoard /> : <Axis scroller="page" />}
      </div>
      <div className="ns-tt-mdock">
        <RunDock variant="mobile" />
      </div>
      <MobileSheetHost />
    </>
  );
}
