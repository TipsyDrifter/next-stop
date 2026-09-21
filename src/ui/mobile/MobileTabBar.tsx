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
 */
import { useUiStore } from "../../store/uiStore";
import { COMING_SOON_TEXT, MOBILE_TABS, renderTabIcon } from "./tabs";

export function MobileTabBar() {
  const current = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);

  return (
    <nav className="m-tabbar" role="tablist" aria-label="主導航">
      {MOBILE_TABS.map((tab) => {
        const active = tab.key === current;
        const planned = tab.status === "planned";
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
            <span className="m-tab-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
