/**
 * 車庫頁（桌機；車庫與回顧 D-主-215～219；視覺＝prototypes/design-stats-review-車庫.html 方案 G-A）。
 *
 *   section.page.ns-depot（可聚焦；鍵盤＝useDepotKeyboard：記錄簿開著時 Esc 回車庫）
 *     └ .sheet
 *         ├ 沒開記錄簿：PageHeader 頁名式（眉標 車庫／Depot、大標「車庫」、補述「車庫裡 N 條幹線、M 條路線・済章 K 枚」、
 *         │   工具列［乘車記錄｜走行圖｜年鑑］［搜尋＝完整搜尋］）＋ DepotBody
 *         └ 開著記錄簿（bookId）：頂上一列「‹ 車庫」＋ RideBook（記錄簿做成頁，不是側板——D-主-218）
 *
 * 進頁：ensureStampDefs()（朱肉 filter）＋ load()；路線、車站換了（到站、回到運行、同步拉回）再 load 一次。
 * 焦點：開記錄簿＝焦點落頁根（Tab 第一站是「‹ 車庫」）；回車庫＝焦點回到剛才點的書背／列（找不到就落頁根）。捲動位置回車庫時還原。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { PageHeader } from "../common/PageHeader";
import { openFullSearch } from "../search/openFullSearch";
import { capsOfHotkey } from "../shell/hotkeys";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import { ensureStampDefs } from "../stamps/defs";
import { DepotBody } from "./DepotBody";
import { DEPOT_TABS } from "./depotTabs";
import { DepotSummary } from "./depotParts";
import { RideBook } from "./RideBook";
import { useDepotKeyboard } from "./useDepotKeyboard";
import "./depot.css";


export function DepotView() {
  useHotkeyRevision();
  const tab = useDepotStore((s) => s.tab);
  const bookId = useDepotStore((s) => s.bookId);
  const setTab = useDepotStore((s) => s.setTab);
  const openBook = useDepotStore((s) => s.openBook);
  const routes = useNodeStore((s) => s.routes);
  const stations = useNodeStore((s) => s.stations);
  const onKeyDown = useDepotKeyboard();
  const rootRef = useRef<HTMLElement>(null);
  const lastBook = useRef<string | null>(null);
  const savedTop = useRef(0);

  useEffect(() => {
    ensureStampDefs();
  }, []);
  useEffect(() => {
    void useDepotStore.getState().load();
  }, [routes, stations]);

  // 開／關記錄簿：捲動與焦點
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (bookId) {
      if (lastBook.current === null) savedTop.current = root.scrollTop;
      lastBook.current = bookId;
      root.scrollTop = 0;
      // 焦點落頁根（Esc 收得到；Tab 第一站＝「‹ 車庫」）——不直接聚焦返回鈕，免得滑鼠點書背後也冒出焦點框
      root.focus({ preventScroll: true });
    } else if (lastBook.current) {
      const id = lastBook.current;
      lastBook.current = null;
      root.scrollTop = savedTop.current;
      const el = root.querySelector<HTMLElement>(`[data-route-id="${CSS.escape(id)}"]`);
      (el ?? root).focus({ preventScroll: true });
    }
  }, [bookId]);

  return (
    <section ref={rootRef} className="page ns-depot" tabIndex={-1} onKeyDown={onKeyDown} aria-label="車庫">
      <div className="sheet">
        {bookId ? (
          <>
            <div className="ns-depot-backrow">
              <button
                type="button"
                className="ns-depot-back"
                onClick={() => openBook(null)}
                title="回車庫（Esc）"
                aria-label="回車庫"
              >
                <span aria-hidden="true">‹</span> 車庫
              </button>
            </div>
            <RideBook routeId={bookId} shell="desktop" onBack={() => openBook(null)} />
          </>
        ) : (
          <>
            <PageHeader
              variant="name"
              overline={{ zh: "車庫", latin: "Depot" }}
              title="車庫"
              aside={<DepotSummary className="ns-depot-aside" />}
              tabs={{ items: DEPOT_TABS, value: tab, onChange: setTab, "aria-label": "車庫分頁" }}
              search={{ onOpen: () => openFullSearch(), title: `搜尋（${capsOfHotkey("global.fullsearch")}）` }}
            />
            <DepotBody />
          </>
        )}
      </div>
    </section>
  );
}
