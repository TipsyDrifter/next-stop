/**
 * 時刻表線・桌機入口（車次①a 契約 §2.0／§2.2；乙席）。
 * mount 檔只 import 本檔；桌機頁的真身在 `./TimetableView`（兩欄⇄只看軸、運行列、發車台、軸、面板宿主）。
 */
export { TimetableView } from "./TimetableView";
// ①a 補充契約（系統匣）：桌機全域代理，App 一開就把運行中送到系統匣
export { TimetableDesktopAgent } from "./TimetableDesktopAgent";
