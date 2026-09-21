/**
 * App 殼——丙式主視圖的組裝層：天空氛圍層 ＋ 書封側欄 ＋ 路線大綱（主欄）＋ 詳情側板 ＋ 覆蓋層。
 * 對應 UI Flow 2.0 家族；今日視圖（1.0）／收件匣／日曆為 M3。
 *
 * M3 ③ 頁面殼（WP0）：`uiStore.page` 決定主欄渲染哪一頁——today＝<TodayView/>、routemap＝<Outline/>、
 *   calendar＝<CalendarView/>（⑤ 通車；WP1 先掛占位殼）。啟動落點＝today（決策 #12 首頁＝今日視圖）。
 *   切頁入口三處：gnav（Sidebar）、Ctrl+1／2／3（useGlobalHotkeys）、側欄「我的路線」點路線
 *   （＝切 routemap 並開該路線）。星空檔位沿 `density={today ? "full" : "reduced"}`——日曆頁走 reduced，零改動。
 *   全域三件（gnav／搜尋／設定）與側板、覆蓋層每頁常駐（Q7），故都留在 page 判斷之外。
 *
 * M3 ② 主題換裝收口：
 *   - <SkyLayer density="reduced" />＝路線圖頁的星空檔位（減量慢頻、無流星無列車；規格 §2 密度階梯）。
 *     今日頁換 density="full"＋train={false}＝全量星點＋流星、不掛列車與地面帶（拍板 D-③-1 甲）。
 *     天空是 position:fixed; z-index:0 的底層，掛在根 div 的第一個子節點；根 div 的 bg-paper 只是
 *     天空沒鋪上去時的保險底。書封／主欄／側板的 z-index ≥ 1 由 techo.css 負責（.cover 3／.page 1／.panel 2）。
 *   - ensureStampDefs()＝朱肉 filter（#inkbleed／#inkbleed-fine）的 SVG defs 掛進 document。
 *     函式冪等；DetailPanel 靜態 import 時已會掛一次，這裡顯式再呼叫一次，讓「大綱済章吃得到朱肉」
 *     不依賴側板是否曾經掛載過（大綱與側板的生命週期互不相干）。
 *   - 樣式檔的 import 集中在 src/index.css（注入順序見該檔檔頭）。
 *
 * M3 ⑥ 備份三件套（WP2）：
 *   - 啟動鉤子＝`loadSettings()` 之後才 `backupStore.boot()`（boot 要讀 settings 表，順序不能反；
 *     boot 自己有 inflight 去重，StrictMode 雙掛載只跑一趟）。
 *   - 連敗 ≥3 的啟動橫幅＝`<BackupBanner/>`，沿用下面 `⚠ {error}` 那一列的位置與語彙，
 *     多的只有「開啟設定」（直接落在備份籤）與可關閉的 ×（關掉只影響這次開啟，不寫 settings）。
 *     同一顆元件還扛 `needsRestart`（還原在「連線已關」之後失敗）的常駐橫幅——那一條不給關。
 *
 * M3 ⑦ 快捷鍵指引頁（WP2）：
 *   - `<HotkeyGuide/>`＝「?」情境卡（D-⑦-1 甲），掛在覆蓋層區 SettingsPanel 旁；讀 uiStore.hotkeyGuideOpen，
 *     開關由 useGlobalHotkeys（`?` 導航模式／`Ctrl+/` IME 備援）走 store 的 toggle。
 *     與設定、快速跳轉互斥（都是 DialogShell，兩層同開會互搶 window 層的 Esc）——互斥寫在 uiStore 的 setter，
 *     不靠這裡的掛載順序。當日清單／推遲小卡／月年跳轉三個本地 state 的浮層各自把 `?` 擋在自己的 onKeyDown。
 *
 * v1.1.1 ⑧ 同步地基（整合席接線）：
 *   - `loadSettings()` 之後 `useSyncStore.getState().boot(shell)`，effect cleanup `stop()`（契約 §9.4）。
 *     排在 loadSettings 之後的理由與備份同源——同步的節奏與 pull 後的 `loadSettings()` 回讀都預設
 *     settings 已經在 store 裡；同一條 promise 鏈接著走，不靠時序碰運氣。
 *   - 備份 boot 改成不接進這條鏈（`void`）：備份是桌機限定、同步兩殼都要，串在一起的話手機端
 *     會被 `if (mobile) return` 提早斷鏈、同步永遠 boot 不起來。
 *   - 同步總開關預設關（`sync_meta.enabled` 無列＝'0'）⇒ boot 只問一次 `sync_status()`（順手寫
 *     device_id／schema_gate 兩列，值沒變就不寫）就停手，桌機既有行為零改變（鐵則 1）。
 */
import { useEffect, useState } from "react";
import { useNodeStore } from "./store/nodeStore";
import { useUiStore } from "./store/uiStore";
import { useBackupStore, BACKUP_FAIL_BANNER_STREAK } from "./store/backupStore";
import { useSyncStore } from "./store/syncStore";
import { useGlobalHotkeys } from "./ui/shell/useGlobalHotkeys";
import { SkyLayer } from "./ui/ambience";
import { ensureStampDefs } from "./ui/stamps";
import { Sidebar } from "./ui/sidebar/Sidebar";
import { RouteDialog } from "./ui/sidebar/RouteDialog";
import { Outline } from "./ui/outline/Outline";
import { TodayView } from "./ui/today/TodayView";
import { CalendarView } from "./ui/calendar/CalendarView";
import { DetailPanel } from "./ui/panel/DetailPanel";
import { CompleteCard } from "./ui/complete/CompleteCard";
import { ConfirmDialog } from "./ui/common/ConfirmDialog";
import { QuickJump } from "./ui/common/QuickJump";
import { SettingsPanel } from "./ui/settings/SettingsPanel";
import { HotkeyGuide } from "./ui/shell/HotkeyGuide";
import { Toast } from "./ui/common/Toast";
import { useShell } from "./ui/mobile/useShell";
import { useVisualViewportHeight } from "./ui/mobile/useViewportHeight";
import MobileShell from "./ui/mobile/MobileShell";
// 備份橫幅用到 .ns-btn／.ns-close（覆蓋層共用小件）——自己 import，不倚賴 Toast 先掛載
import "./ui/common/overlay.css";

export default function App() {
  const loadSidebar = useNodeStore((s) => s.loadSidebar);
  const openRoute = useNodeStore((s) => s.openRoute);
  const routes = useNodeStore((s) => s.routes);
  const routeId = useNodeStore((s) => s.routeId);
  const error = useNodeStore((s) => s.error);
  const loadSettings = useUiStore((s) => s.loadSettings);
  const page = useUiStore((s) => s.page);
  const today = page === "today";
  // v1.1.0 手機殼：判準是「視窗寬度 <768」不是平台（useShell.ts 檔頭有理由）。
  // 桌機視窗 minWidth 960（tauri.conf.json）永遠落不進 <768 → 桌機走的仍是原本那一支分支，行為零改變。
  const shell = useShell();
  const mobile = shell === "mobile";

  // 桌機才掛全域快捷鍵（評審 S4）：手機殼沒有 QuickJump／SettingsPanel／HotkeyGuide 這三顆元件，
  // 但外接／藍牙鍵盤按 Ctrl+P 或 `?` 仍會把 uiStore 的 quickJumpOpen／hotkeyGuideOpen 設成 true
  // ——元件沒掛載＝主人看不到任何東西，狀態卻殘留著；Ctrl+1/2/3 還會去改桌機的 `page`。
  // 傳 shell 判斷而不是在手機分支裡「補關」，是因為源頭不發生最乾淨。
  useGlobalHotkeys(!mobile);

  // 軟鍵盤退路（評審 B2）：只在手機殼生效；WebView 不回報視覺視窗變化時等同沒掛。
  useVisualViewportHeight(mobile);

  useEffect(() => {
    ensureStampDefs();
    // 備份 boot 要讀 settings 表，所以排在 loadSettings 之後（同一條 promise 鏈，不靠時序碰運氣）。
    // 手機端**不叫 boot**（D-1.1-1 甲：Android 不掛 backup plugin）——invoke 會 reject，
    // boot 會把它記成一次失敗、累計 backup_fail_streak，並往 settings 表多寫三個 key。不會壞但會髒。
    //
    // v1.1.1 同步接線（契約 §9.4）：`syncStore.boot(shell)` 也排在 loadSettings 之後——
    // 兩殼都叫（桌機＝primary 推、手機＝replica 拉），沒啟用時 boot 只問一次狀態就停手
    // （runCycle 自己擋，enabled=0 ⇒ 零背景動作、側欄不畫點）。boot 可重入、stop 只拆監聽，
    // 所以 StrictMode 的 boot→stop→boot 不會掉排程。
    void loadSettings().then(() => {
      if (!mobile) void useBackupStore.getState().boot();
      return useSyncStore.getState().boot(shell);
    });
    void loadSidebar();
    return () => {
      useSyncStore.getState().stop();
    };
  }, [loadSettings, loadSidebar, mobile, shell]);

  // 啟動時自動開第一條路線（有路線但尚未選取）
  useEffect(() => {
    if (!routeId && routes.length > 0) void openRoute(routes[0].id);
  }, [routeId, routes, openRoute]);

  return (
    // data-shell 是手機樣式層的唯一鉤子（mobile.css 每條規則都掛它或 max-width:767px）；
    // 桌機得到 data-shell="desktop"，沒有任何 CSS 選它 → 桌機視覺零改變。
    <div data-shell={shell} className="flex h-screen bg-paper text-ink overflow-hidden">
      {/* 手機一律 reduced：省電，且銀河帶寬 1180px 的橫溢由根 div 的 overflow hidden 擋掉 */}
      <SkyLayer density={!mobile && today ? "full" : "reduced"} train={false} />
      {mobile ? (
        <MobileShell />
      ) : (
        <>
          <Sidebar />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {error && <div className="px-8 pt-3 text-sm text-late">⚠ {error}</div>}
            <BackupBanner />
            {page === "calendar" ? <CalendarView /> : today ? <TodayView /> : <Outline />}
            {/* 完成卡留在桌機樹：它是 `absolute bottom-6`、定位脈絡就是這顆 <main>，
                搬到根層會改到桌機位置（鐵則 1 不允許）。手機 v1.1.0 不開完成卡（契約 §2.7）。 */}
            <CompleteCard />
          </main>
          <DetailPanel />
          <QuickJump />
          <SettingsPanel />
          <HotkeyGuide />
          <RouteDialog />
        </>
      )}
      {/* 兩殼共用的覆蓋層：MobileShell 不再各掛一份（契約 §2.3、§3） */}
      <ConfirmDialog />
      <Toast />
    </div>
  );
}

/**
 * 備份連敗 ≥3 的啟動橫幅（三層通知的第三層；決策 9）。
 * 位置與字級沿主欄既有的 `⚠ {error}` 一列——不發明新形狀，只多兩顆既有樣式的鈕。
 * 關閉是本次開啟有效（不落 settings）：連敗還在，下次啟動照樣提醒。
 */
function BackupBanner() {
  const failStreak = useBackupStore((s) => s.failStreak);
  const lastError = useBackupStore((s) => s.lastError);
  const needsRestart = useBackupStore((s) => s.needsRestart);
  const openSettings = useUiStore((s) => s.openSettings);
  const [dismissed, setDismissed] = useState(false);

  // 還原在「pool 已關」之後失敗：這個進程再也寫不進資料庫了，橫幅不給關（關掉只會讓主人
  // 在一個寫不進去的 App 裡繼續打字）。DB 檔本身沒被動過，重開就好。
  if (needsRestart) {
    return (
      <div role="alert" className="flex items-center gap-3 px-8 pt-3 text-sm text-late">
        <span className="min-w-0 truncate">
          ⚠ 還原沒有完成，資料庫的連線已經關掉了——請關掉私鐵手帳再重新開一次（資料庫檔案沒有被改動）
        </span>
      </div>
    );
  }

  if (dismissed || failStreak < BACKUP_FAIL_BANNER_STREAK) return null;

  return (
    <div role="status" className="flex items-center gap-3 px-8 pt-3 text-sm text-late">
      <span className="min-w-0 truncate">
        ⚠ 自動備份已經連續 {failStreak} 次沒成功{lastError ? `：${lastError}` : ""}
      </span>
      <button
        type="button"
        onClick={() => openSettings("backup")}
        className="btn-gold ns-btn ns-btn--sm shrink-0"
      >
        開啟設定
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="關閉提醒"
        className="ns-close ns-close--sm shrink-0"
      >
        ×
      </button>
    </div>
  );
}
