/**
 * 售票口線・桌機入口（車次①契約 §2.0／§2.2；乙席）。
 * mount 檔只 import 本檔：桌機頁的真身在 `./TicketView`（帳簿＋詳情板＋對話框宿主），
 * 書封頁務件在 `./TicketSide`（經 mount 的 sidebarAux 掛，D-票-22）。
 */
export { TicketView } from "./TicketView";
export { TicketSide } from "./TicketSide";
// 第②階段（②契約 §2.1、0-12、0-19）：路線側板「花費」列、Ctrl+P「帳目」組——mount 由整合席填
export { RouteSpendField } from "./view/RouteSpendField";
export { TICKET_QUICK_JUMP } from "./quickJump";
