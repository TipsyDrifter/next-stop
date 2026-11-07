/**
 * 路線圖頁首下那一列（⑫；原型 .subbar）：左邊分頁籤，右邊是這個分頁的控件。
 * 大綱｜看板、路線｜篩選各一組（契約 §1、§7：跟售票口、時刻表一樣用 Tabs 配鍵，鍵是 1、2）。
 * 頁首與這一列都是畫布寬、切分頁不跳（D-主-392 跟模組走）；有內容的列在 .ns-rm-read 裡維持 848。
 */
import type { ReactNode } from "react";
import { useBoardStore, type OverviewTab, type RouteLayout } from "../../store/boardStore";
import { capsOfHotkey } from "../shell/hotkeys";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import { Tabs } from "../common/Tabs";
import "./board.css";

/** 分頁內容的 id（ARIA：Tabs 的 aria-controls ↔ 內容的 role="tabpanel"） */
export const ROUTE_LAYOUT_PANEL: Readonly<Record<RouteLayout, string>> = { outline: "ns-route-panel-outline", board: "ns-route-panel-board" };
export const OVERVIEW_PANEL: Readonly<Record<OverviewTab, string>> = { routes: "ns-overview-panel-routes", filter: "ns-overview-panel-filter" };

export function RouteLayoutTabs({ children }: { children?: ReactNode }) {
  useHotkeyRevision();
  const value = useBoardStore((s) => s.routeLayout);
  const set = useBoardStore((s) => s.setRouteLayout);
  return (
    <div className="ns-bd-subbar">
      <Tabs<RouteLayout>
        size="md"
        aria-label="大綱或看板"
        value={value}
        onChange={set}
        getPanelId={(k) => ROUTE_LAYOUT_PANEL[k]}
        items={[
          { key: "outline", label: "大綱", hotkeyTitle: `大綱（${capsOfHotkey("outline.view.1")}）` },
          { key: "board", label: "看板", hotkeyTitle: `看板（${capsOfHotkey("outline.view.2")}）` },
        ]}
      />
      <span className="sp" />
      {children}
    </div>
  );
}

export function OverviewTabs() {
  useHotkeyRevision();
  const value = useBoardStore((s) => s.overviewTab);
  const set = useBoardStore((s) => s.setOverviewTab);
  return (
    <div className="ns-bd-subbar">
      <Tabs<OverviewTab>
        size="md"
        aria-label="路線或篩選"
        value={value}
        onChange={set}
        getPanelId={(k) => OVERVIEW_PANEL[k]}
        items={[
          { key: "routes", label: "路線", hotkeyTitle: `路線（${capsOfHotkey("outline.view.1")}）` },
          { key: "filter", label: "篩選", hotkeyTitle: `篩選（${capsOfHotkey("outline.view.2")}）` },
        ]}
      />
    </div>
  );
}
