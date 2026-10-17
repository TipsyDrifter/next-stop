/**
 * RouteSpendAside——手機路線圖第一層每條路線列尾的「本月 1,230」小字（②契約 0-13、§5.3；丙席擁有）。
 * 經 mount 的 `routeListAside`（接縫 #63，已在本分支）登記（整合席填）。
 *
 * **只回 span／文字、不放可點的東西**（它在主線的 `button.m2-route` 裡面）；本月為 0 或還沒載到 ⇒ null，不佔位。
 * 只放本月（累計在統計「依路線」切面看）。數字＝`store.routeSpend[route.id].month`（`routeSpendOf` 同義的 SQL），
 * 字＝`asideText`。mount、route.id 變、或 refresh 清掉 routeSpend（任何寫入後）⇒ 再叫一次 `loadRouteSpend`（已有值就不重查）。
 * 樣式在 ticket-mobile.css「路線列尾小字」分區（`[data-shell="mobile"] .m2-route .ns-tk-maside`）——本檔 import 它，
 * 因為路線圖頁不會 import 售票口的 css（vite 只注入一次）。
 */
import { useEffect } from "react";
import type { NodeRow } from "../../../domain/node";
import { useTicketStore } from "../../../store/ticketStore";
import { MAIN_CURRENCY } from "../../../domain/ticket";
import { asideText } from "../../../domain/ticketView";
import { useRouteSpendFresh } from "../resume";
import "../ticket-mobile.css";

export function RouteSpendAside({ route }: { route: NodeRow }) {
  const spend = useTicketStore((s) => s.routeSpend[route.id]);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const loadRouteSpend = useTicketStore((s) => s.loadRouteSpend);
  const missing = spend === undefined;

  useEffect(() => {
    if (missing) void loadRouteSpend(route.id);
  }, [route.id, missing, loadRouteSpend]);
  useRouteSpendFresh(route.id); // 頁面一直開著跨月：回前景時補叫（store 偵測跨月、整批作廢 ⇒ 上面的 effect 重載）

  if (!spend) return null;
  const text = asideText(spend.month, dec);
  return text === null ? null : <span className="ns-tk-maside">{text}</span>;
}
