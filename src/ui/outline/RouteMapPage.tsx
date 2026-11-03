/**
 * RouteMapPage——桌機「路線圖」頁（丁 D-主-239）：最上層＝路線一覽（RouteOverview），點進一條路線＝它的大綱（Outline）。
 * 看哪一層＝`uiStore.routeOverview`；兩邊各自是完整的元件（大綱的 hooks、鍵盤流不因為一覽而條件呼叫）。
 */
import { useUiStore } from "../../store/uiStore";
import { Outline } from "./Outline";
import { RouteOverview } from "./RouteOverview";

export function RouteMapPage() {
  const overview = useUiStore((s) => s.routeOverview);
  return overview ? <RouteOverview /> : <Outline />;
}
