/**
 * MobileTabBar——手機殼底部的 5 格 tab（v1.1.0；WP1）。
 *
 * 拍板依據：D-1.1-2「底部 5 格＝今日・路線圖・旅客筆記・時刻表・更多；未通車格灰顯、點了只顯示
 *   一行『次期開業予定』；tab 定義做成 registry 資料」。本檔**一格都不手抄**——五格逐筆由
 *   `MOBILE_TABS` map 出來、圖示由 `renderTabIcon()` 畫，新功能通車＝改 registry 那一筆的 status。
 *
 * 未通車格（status: 'planned'）**仍然可點**：點了切頁顯示 <ComingSoon/>，不是 `disabled`。
 *   拍板原話是「點了只顯示一行」——`disabled` 的格子按下去毫無反應，主人會以為是壞掉而不是還沒通車。
 *   無障礙上用 `aria-disabled` 宣告「這格現在沒東西」，但保留可聚焦、可點擊（灰顯 .42 由 WP0 的 .is-planned 給）。
 *
 * a11y：`role="tablist"`／每格 `role="tab"`＋`aria-selected`；planned 格的 `aria-label` 補上
 *   「——次期開業予定」，讀螢幕的人不必先點進去才知道。切頁走 `uiStore.setMobileTab`（順手收桌機疊層）。
 *
 * UI 丙-2（契約 §1 #17；視覺規範 §2.0「時刻表運行中徽落在 tab 圖示右上（赭色膠囊）」、§2.9 運行中小牌、§1.4 --radius-pill）：
 *   線標記外面包一層 `span.m-tab-live`（display: contents，不佔版面、不改定位——徽仍以 .m-tab 為定位框），
 *   由 common/msheet.css 把裡面的運行中小牌從「分類色實心圓＋一字」改成「赭膠囊＋一字」：淡赭底 --danger-bg、
 *   赭框、赭字、--radius-pill，前面一顆赭點（同 ui-brand `.ns-live`）——不再跟圓印同形。
 *   徽的資料、彈出／到着淡出／待確認外圈的動畫都還是時刻表線的 NavBadge（不動那支）；只換形與色。
 *   只包時刻表那一格；旅客筆記那格的線標記（若有）DOM 照舊、不受影響。
 *   桌機書封 gnav 上同一枚小牌（核對 L19）不在本席範圍，仍是圓牌（handoff 給時刻表線／丙-3）。
 */
import { lineNavBadge } from "../../lines/runtime";
import { useUiStore } from "../../store/uiStore";
import "../common/msheet.css";
import { COMING_SOON_TEXT, MOBILE_TABS, renderTabIcon } from "./tabs";

export function MobileTabBar() {
  const current = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);

  return (
    <nav className="m-tabbar" role="tablist" aria-label="主選單">
      {MOBILE_TABS.map((tab) => {
        const active = tab.key === current;
        const planned = tab.status === "planned";
        // 導航上的線標記（接縫 #58）：只有功能線那兩格查；沒通車或沒填＝null ⇒ 這一格與沒有插槽時逐字相同
        const Badge = tab.key === "notes" || tab.key === "timetable" ? lineNavBadge(tab.key, "mobile")?.Badge ?? null : null;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={planned || undefined}
            aria-label={planned ? `${tab.label}——${COMING_SOON_TEXT}` : undefined}
            onClick={() => setMobileTab(tab.key)}
            className={"m-tab" + (active ? " is-active" : "") + (planned ? " is-planned" : "")}
          >
            {renderTabIcon(tab.icon)}
            {Badge &&
              (tab.key === "timetable" ? (
                <span className="m-tab-live">
                  <Badge shell="mobile" />
                </span>
              ) : (
                <Badge shell="mobile" />
              ))}
            <span className="m-tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
