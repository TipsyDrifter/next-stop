/**
 * 車庫頁的分頁籤（車庫與回顧 D-主-216；兩殼共用一份）：乘車記錄｜走行圖｜年鑑。
 * 走行圖在第三梯 ③-2 開業（D-主-551）。
 */
import type { TabItem } from "../common/Tabs";
import type { DepotTab } from "../../store/depotStore";

export const DEPOT_TABS: readonly TabItem<DepotTab>[] = [
  { key: "ride", label: "乘車記錄" },
  { key: "map", label: "走行圖" },
  { key: "year", label: "年鑑" },
];
