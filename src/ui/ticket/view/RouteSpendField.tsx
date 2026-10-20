/**
 * RouteSpendField——路線側板「花費」列的內容（②契約 §5.2、0-11、0-12；乙席）。經 mount 的 `nodeFields`
 * （`{ id: "ticket.spend", label: "花費", kinds: ["route"], Desktop: RouteSpendField }`，整合席填）渲染在 RoutePanel 的
 * `FieldRow label="花費"` 裡（標籤由 FieldRow 畫；時刻表線另登記自己的「時間」列，兩列各自獨立）。長相照原型 routePanelHtml()：
 *
 *   span.ns-tk-spend
 *   ├─ b.ns-tk-spend-v       「本月 1,230／累計 18,420」（spendText；載入中「…」；兩個都 0 仍顯示）
 *   └─ button.ns-tk-spend-go 淡字「看明細 ›」⇒ 售票口頁、清單、篩選「路線＝這條」（全部期間、全部類型）
 *
 * 口徑（0-11）：本月＝今天所在月（不跟售票口頁首的月份走）、累計＝全部期間；只算 route_id 直掛的支出淨額（store.loadRouteSpend）。
 * mount／node.id 變／store.routeSpend[node.id] 消失（refresh 作廢）⇒ 再叫 loadRouteSpend；store 自己擋重複查詢。
 * `ticket.css` 要讓 RoutePanel 吃到：本檔自己 import（vite 只注入一次）。
 */
import { useEffect } from "react";
import type { NodeRow } from "../../../domain/node";
import { MAIN_CURRENCY } from "../../../domain/ticket";
import { VIEW_TEXT, spendText } from "../../../domain/ticketView";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { useRouteSpendFresh } from "../resume";
import "../ticket.css";

export function RouteSpendField({ node }: { node: NodeRow }) {
  const v = useTicketStore((s) => s.routeSpend[node.id]);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const have = v !== undefined;

  useEffect(() => {
    if (have) return;
    // 售票口頁還沒開過：先 warm（起手列＋幣別小數位）再查；失敗維持「…」
    void (async () => {
      try {
        await useTicketStore.getState().warm();
        await useTicketStore.getState().loadRouteSpend(node.id);
      } catch {
        /* 讀不到就維持「…」；下次 mount 再試 */
      }
    })();
  }, [node.id, have]);
  useRouteSpendFresh(node.id); // 頁面一直開著跨月：回前景時補叫（store 偵測跨月、整批作廢 ⇒ 上面的 effect 重載）

  return (
    <span className="ns-tk-spend">
      <b className="ns-tk-spend-v" aria-live="polite">
        {v ? spendText(v.month, v.total, dec) : "…"}
      </b>
      <button
        type="button"
        className="ns-tk-spend-go"
        title="到售票口看這條路線的帳"
        onClick={() => {
          useUiStore.getState().setPage("ticket");
          void useTicketStore.getState().drillToList({ routeId: node.id, from: null, toExcl: null, kinds: [], accountId: null });
        }}
      >
        {VIEW_TEXT.spendDetail} ›
      </button>
    </span>
  );
}
