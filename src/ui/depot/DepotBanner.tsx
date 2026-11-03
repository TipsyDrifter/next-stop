/**
 * 路線圖看已到站的路線時，頂上那一行（車庫與回顧 D-主-206 #3；兩殼共用）：
 * 「已收進車庫・M/D 到站」＋次鈕「回到運行」。只有從記錄簿「在路線圖打開」才走得進已到站的路線。
 */
import type { NodeRow } from "../../domain";
import { fmtMD } from "../../domain/depot";
import { requestDepart } from "../panel/arrivalFlows";
import "./depotBanner.css";

export function DepotBanner({ route }: { route: NodeRow }) {
  if (!route.arrived_on) return null;
  return (
    <div className="ns-depot-banner" role="status">
      <span className="t">
        已收進車庫・{fmtMD(route.arrived_on)} 到站
      </span>
      <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={() => void requestDepart(route.id)}>
        回到運行
      </button>
    </div>
  );
}
