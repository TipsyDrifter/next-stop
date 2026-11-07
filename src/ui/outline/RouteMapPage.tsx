/**
 * RouteMapPage——桌機「路線圖」頁（丁 D-主-239）：最上層＝路線一覽（RouteOverview），點進一條路線＝它的大綱（Outline）。
 * 看哪一層＝`uiStore.routeOverview`；兩邊各自是完整的元件（大綱的 hooks、鍵盤流不因為一覽而條件呼叫）。
 * ⑫：兩層各多一組分頁（大綱｜看板、路線｜篩選），記在 boardStore；偏好讀回來之前不畫，不然記著看板的人會先閃一下大綱。
 */
import { useEffect } from "react";
import { useBoardStore } from "../../store/boardStore";
import { useUiStore } from "../../store/uiStore";
import { Outline } from "./Outline";
import { RouteOverview } from "./RouteOverview";
import { useRouteMapViewKeys } from "./useOutlineKeyboard";

export function RouteMapPage() {
  const overview = useUiStore((s) => s.routeOverview);
  const ready = useBoardStore((s) => s.ready);
  useEffect(() => void useBoardStore.getState().ensureLoaded(), []);
  useRouteMapViewKeys();
  if (!ready) return <section className="page ns-outline" aria-label="路線圖" aria-busy="true" />;
  return overview ? <RouteOverview /> : <Outline />;
}
