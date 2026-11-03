/**
 * 車庫頁的分頁籤（車庫與回顧 D-主-216；兩殼共用一份）：乘車記錄｜走行圖｜年鑑。
 * 走行圖排在第二批（使用者 11-01 定案 3）：本班只佔位——灰顯、滑過「次期開業予定」（App 對未通車項目的既有說法）。
 */
import type { TabItem } from "../common/Tabs";
import type { DepotTab } from "../../store/depotStore";

export const DEPOT_TABS: readonly TabItem<DepotTab>[] = [
  { key: "ride", label: "乘車記錄" },
  { key: "map", label: "走行圖", disabled: true, why: "次期開業予定" },
  { key: "year", label: "年鑑" },
];
