/**
 * MobileTopBand——手機殼頁首的那一條書封色帶（v1.1.0；WP1）。
 *
 * 拍板依據：D-1.1-2「頁首＝一條書封色帶（--color-book 底、--color-book-ink 字）放頁名＋日付印（今日頁）」。
 * 為什麼是「書封色帶」不是「紙上的標題」：桌機唯一的深色面是書封側欄（theme.css 的「對比分層」紀律），
 *   手機沒有側欄，那一塊深色就改由頂帶承擔——App 的顏色結構（深＝導航、淺＝紙）兩殼一致。
 *
 * 日付印只在今日頁出現，日期吃的是**今日視圖同一套規則**：
 *   `nodeStore.today.dateKey`（loadToday 算出來的那一天）→ 還沒載完就退回 `todayKey(uiStore.dayStartHour)`，
 *   與 useTodayController／useMobileToday 的 `today.dateKey ?? todayKey(dayStartHour)` 逐字相同。
 *   熬夜跨日界線時 useMobileToday 會重載並改寫 today.dateKey，這裡跟著換，不必自己再算一次時間。
 *
 * 尺寸自決（與契約 §2.3 的「76 檔位」不同，理由記在這裡）：契約寫「頂帶高度有限，用 76 不用 92」，
 *   但 WP0 的 `--m-band-h` 是 52px——76px 的印會把頂帶撐到 ~80px，加上 safe-top 與 60px 的底部 tab，
 *   394×853dp 的畫面會被殼件吃掉 20%。故取 `MOBILE_SEAL_SIZE = 46`（印章是向量，縮放不失真；
 *   外圈「私鐵手帳／NEXT STOP」細字退成裝飾，中央的月.日仍清楚）。要改回 76 只要動這一個常數。
 * 深底配色不必在這裡處理——WP0 已寫 `.m-band .ns-date-seal { color: var(--color-book-ink) }`（契約 §5-6）。
 */
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { DateSeal } from "../stamps";
import { SyncDot } from "../common/SyncDot";
import type { MobileTab } from "./tabs";

/** 頂帶日付印的尺寸（見檔頭「尺寸自決」） */
const MOBILE_SEAL_SIZE = 46;

/** YYYY-MM-DD → 本地 Date（不經 Date.parse，避免 date-only 字串被當 UTC 而跨日；同 TodayView 的 dateOf） */
function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function MobileTopBand({ tab }: { tab: MobileTab }) {
  const storedKey = useNodeStore((s) => s.today.dateKey);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = tab.key === "today";
  const dateKey = storedKey ?? todayKey(dayStartHour);

  return (
    <header className="m-band">
      <div className="m-band-name">
        <div className="m-band-title">{tab.label}</div>
        <div className="m-band-latin">{tab.latin}</div>
      </div>
      {/* v1.1.1 WP8：同步狀態點掛在頂帶右端（今日頁在日付印左邊）。
          沒加入同步時（v1.1.3 的說法；舊稱「未啟用」）`SyncDot` 整顆不渲染，`.m-band-end` 就是個空的 flex 容器——
          v1.1.0 的版面（頁名＋日付印）逐像素不變。 */}
      <div className="m-band-end">
        <SyncDot className="m-band-sync-dot" />
        {today && <DateSeal date={dateOf(dateKey)} size={MOBILE_SEAL_SIZE} title={`日付印 ${dateKey}`} />}
      </div>
    </header>
  );
}
