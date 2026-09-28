/**
 * SyncBanner——同步告警的主畫面橫幅（v1.1.5；契約席立骨架、WP-C 落版面與兩殼掛載）。
 *
 * 拍板依據：決策記錄〈v1.1.5 Plan 拍板〉D-1.1.5-1（告警範圍）＋D-1.1.5-2（可以關、下次啟動再出）；
 *   《2026-09-25-v1.1.5-同步告警與復原碼契約.md》§2.5／§6.1／§6.5。
 *
 * 為什麼橫幅是主力（不是通知）：桌機點通知不會回到 App、dev build 顯示成 PowerShell、Android 外掛一票 open issue——
 *   通知只是「人不在 App 裡時的加分」，主人真正會看到的是這一行。所以本元件**完全不看通知成敗**。
 *
 * 形狀（WP-C）：
 *   * 桌機——逐字沿 `App.tsx` 的 `<BackupBanner/>`：主欄頂一行 `⚠ 字`＋兩顆既有樣式的鈕，掛在 BackupBanner 正下方。
 *     與 BackupBanner 唯一的差別是「先收起」寫成字鈕而不是 ×：拍板要的是「這次先不看、下次啟動再出」，
 *     × 讀起來像「知道了、永久關掉」，字才講得清楚這是暫時的。長句被 truncate 時整句掛在 title 上。
 *   * 手機——`MobileShell` 頂帶之後、頁面之前的一條紙色帶（class `m-sync-banner`，mobile.css 檔尾）：
 *     手機寬度塞不下一行，所以字在上、兩顆 44px 鈕在下；左緣一道色線沿 `.m2-sy-epoch` 的「要人處理」語彙。
 *     它是 Fragment 的直接子節點（flex column 才分得到高度），自己 `flex: none`，擠的是下面 `.m-page` 的捲動區。
 * 色（與 SyncDot 同一套語彙、不新增顏色）：stopped＝赭（`text-late`，故障）；其餘＝朱（`text-seal`，等人處理）。
 *   `needs_passphrase` 也是朱——它同樣是「要主人去做一件事」（設新密語），不是這台在忙。
 * 狀態來源：只讀 `uiStore.syncBanner`／`syncBannerDismissed`（由 syncStore 的轉變偵測寫）；**元件自己不算 phase**。
 * 「前往同步」＝`uiStore.openSyncPage(shell)`（桌機開設定落同步籤；手機切「更多」並由 MobileMore 進同步子頁）；
 * 「先收起」＝`dismissSyncBanner()`（本次啟動有效；同種告警不再出、換一種再出、重開 App 再出、狀態解除自動清）。
 * 同步關著的桌機：`alertKindOf` 恆 null ⇒ 本元件回 null、DOM 零節點（鐵則「桌機零改變」）。
 */
import { useUiStore } from "../../store/uiStore";
import { SYNC_ALERT_TEXT, SYNC_BANNER_DISMISS, type SyncAlertKind } from "../../store/syncStore";
import "./overlay.css";
import "../../styles/sync.css";

/**
 * 用復原碼加入之後、還沒設新密語（`status.needs_passphrase`）時，〈同步〉頁兩殼多出來的兩句（契約 §6.5）。
 * 放在這裡而不是 syncStore：它們只是版面上的提示（橫幅那句在 `SYNC_ALERT_TEXT.needs_passphrase`），
 * 兩殼同一份、由本檔匯出（沿 `CloudSnapshots.CLOUD_TEXT` 的前例）。
 */
export const NEEDS_PASSPHRASE_TEXT = {
  /** 狀態列多一行 */
  status: "這台是用復原碼加入的——請在下面的〈密語〉設一個新密語（現密語留白）。",
  /** 〈密語〉那一段頂上一句（現密語欄同時鎖住留白） */
  passphrase: "這台是用復原碼加入的，還沒有密語：現密語留白，直接設一個新的。設好之後其他裝置要用它加入；想換鑰匙，設好再來勾。",
  /** 現密語欄鎖住時的 placeholder */
  currentLocked: "現在的密語（用復原碼加入，留白）",
} as const;

export function SyncBanner({ shell }: { shell: "desktop" | "mobile" }) {
  const kind = useUiStore((s) => s.syncBanner) as SyncAlertKind | null;
  const dismissed = useUiStore((s) => s.syncBannerDismissed);
  const openSyncPage = useUiStore((s) => s.openSyncPage);
  const dismiss = useUiStore((s) => s.dismissSyncBanner);

  if (!kind || dismissed === kind) return null;
  const text = SYNC_ALERT_TEXT[kind];
  if (!text) return null; // 型別外的值（store 以 string 存）：寧可不出，也不畫一條空橫幅
  // 朱（要人處理）：改正待ち／鍵違い／信号待ち／請設新密語；赭（誤點）：停車中——與 SyncDot 同一套色語彙
  const tone = kind === "stopped" ? "text-late" : "text-seal";

  if (shell === "mobile") {
    return (
      <div role="alert" data-kind={kind} className={`m-sync-banner ${tone}`}>
        <p className="m-sync-banner-text">{text.banner}</p>
        <div className="m-sync-banner-actions">
          <button type="button" onClick={() => openSyncPage("mobile")} className="ns-btn btn-seal m-sync-banner-go">
            {text.cta}
          </button>
          <button type="button" onClick={dismiss} className="ns-btn btn-ghost m-sync-banner-go">
            {SYNC_BANNER_DISMISS}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" data-kind={kind} className={`ns-sync-banner flex items-center gap-3 px-8 pt-3 text-sm ${tone}`}>
      <span className="min-w-0 truncate" title={text.banner}>
        ⚠ {text.banner}
      </span>
      <button type="button" onClick={() => openSyncPage("desktop")} className="btn-gold ns-btn ns-btn--sm shrink-0">
        {text.cta}
      </button>
      <button type="button" onClick={dismiss} className="btn-ghost ns-btn ns-btn--sm shrink-0">
        {SYNC_BANNER_DISMISS}
      </button>
    </div>
  );
}
