/**
 * ComingSoon——未通車的 tab 點下去看到的那一頁（v1.1.0；WP1）。
 *
 * 拍板依據：D-1.1-2「旅客筆記／時刻表為『未通車』灰顯，點了只顯示一行『次期開業予定』」。
 * 一行就是一行：模組名＋`COMING_SOON_TEXT`，零互動、零「敬請期待」的行銷語氣——
 *   鐵道站牌寫「次期開業予定」的口吻本身就是承諾，不必再加一句。
 *
 * 為什麼未通車頁**不各自開元件檔**：MobileShell 以 `tab.status === 'planned'` 判斷先於 key 的 switch，
 *   registry 再多幾筆 planned 也共用這一支；某天通車＝改 registry 的 status＋在 MobileShell 加一行對照。
 */
import { COMING_SOON_TEXT, type MobileTab } from "./tabs";

export function ComingSoon({ tab }: { tab: MobileTab }) {
  return (
    <div className="m-page m-coming">
      <p className="m-coming-name">{tab.label}</p>
      <p className="m-coming-latin">{tab.latin}</p>
      <p className="techo-overline m-coming-text">{COMING_SOON_TEXT}</p>
    </div>
  );
}
