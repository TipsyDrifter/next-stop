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
 *
 * 主線階段①（P3）：今日 tab 停在「行程表」子頁時，標題換「行程表／SCHEDULE」；日付印的條件不變（仍是今日 tab 就蓋）。
 *   子頁讀 `scheduleUiStore.mobileSub`；`tabs.ts` 是集中檔不動，所以字寫在這裡而不是登記表。
 *
 * 售票口線車次①（D-票-20；《2026-10-11-售票口-車次①帳本-契約.md》§2.6 #7、0-28）：第五格讓給售票口後，
 *   「更多」的入口改成 `.m-band-end` 最右的 ⋯ 鈕（`.m-band-more`，樣式在 mobile.css）。每一頁都有、排在日付印之後；
 *   在「更多」頁時 `aria-pressed="true"`（底部五格此時都不亮），點任一格 tab 離開——不記上一格、不加返回鈕。
 *
 * 磨光①（加工單 global.quickjump；契約 §2.4、§9.5 D-4）：⋯ 左邊加放大鏡（`.m-band-search`，外形同 ⋯），每一頁都有；
 *   點了開手機搜尋 `MobileQuickJump`（開關是本元件的本地狀態，面板自己 portal 到 body、自己登記返回層）。手機上唯一的搜尋入口。
 *
 * UI 丙-2（契約 §1 #16；視覺規範 §2.0「手機殼」、§2.1 桌機↔手機、§1.7 圖示語意；活樣本 ui-brand §2.1 手機頂帶）：
 *   - 右上的 ⋯ 改成齒輪 `IconGear`（§1.7：設定／管理＝齒輪，⋯ 只代表列的動作）。**行為不變**：還是開「更多」頁
 *     （全域設定在裡面）、在「更多」頁時 `aria-pressed="true"`；class 仍是 `.m-band-more`（樣式、截圖場景都認它）、
 *     aria-label 仍是「更多」（＝它開的那一頁的名字），補 `title`（§2.3：圖示鈕一定有 aria-label＋title）。
 *   - 新增兩個插槽（本班只加插槽、不接線，丙-3 起各頁接）：
 *       `tabsRow?: ReactNode`＝頂帶下一列的分頁籤列（放 common/Tabs，≤4 段一列、超過橫捲露半格——Tabs 自己管）；
 *       `manage?: {label, onClick}`＝那一列末端的「管理」文字鈕（`.ns-btn.btn-text.ns-btn--sm`，開線內管理的 sheet 清單）。
 *     兩個都沒給 ⇒ 不畫那一列，頂帶 DOM 與丙-1 逐字相同。給了 ⇒ 在 `<header class="m-band">` 後面多一個兄弟節點
 *     `.ns-tabrow`（樣式在 common/tabs.css，U1 席；只有「管理」沒有籤時的留白 `.ns-tabrow-fill` 在 common/msheet.css）。
 *     插槽列不在頂帶裡：頂帶是書封（深面），籤列是頁的一部分（玻璃），兩種材質分開兩列（§1.5、法則 01）。
 * UI 丙-3 F2（契約 §1 F2；視覺規範 §2.2「手機今日｜行程表」）：今日 tab 的兩子頁切換接進 tabsRow——呼叫端（MobileShell，集中檔）
 *   沒給 tabsRow 而且在今日 tab ⇒ 本元件自己讀 `scheduleUiStore.mobileSub` 畫共用 `Tabs`（今日｜行程表），舊的 `.m-sch-seg` 退役。
 *   籤的長相、←→／Home／End、底線滑塊都歸 Tabs；左右滑換頁照舊在內容區（MobileSegmentedBar.tsx 的 useSubSwipe）。
 * ARIA／鍵盤：齒輪與放大鏡都是原生 <button>（Enter／Space），焦點框照書封慣例燙金（mobile.css）；分頁籤的 ←→ 由 Tabs 自己處理。
 */
import { useState, type ReactNode } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { DateSeal } from "../stamps";
import { SyncDot } from "../common/SyncDot";
import { IconGear } from "../common/icons";
import { Tabs, type TabItem } from "../common/Tabs";
import "../common/msheet.css";
import { useScheduleUiStore, type MobileSub } from "../schedule/scheduleUiStore";
import { renderTabIcon, type MobileTab, type MobileTabIcon } from "./tabs";
import { MobileQuickJump } from "./MobileQuickJump";

/** 頂帶下一列末端的「管理」文字鈕（§2.0、§2.1：線內管理 → sheet 清單） */
export interface MobileTopBandManage {
  label: string;
  onClick: () => void;
}

export interface MobileTopBandProps {
  tab: MobileTab;
  /** 頂帶下一列：該頁的分頁籤列（common/Tabs）。省略＝不畫這一列 */
  tabsRow?: ReactNode;
  /** 籤列末端的「管理」文字鈕。省略＝不畫 */
  manage?: MobileTopBandManage;
}

/** 今日 tab 的兩子頁（UI 丙-3 F2） */
const TODAY_SUBS: readonly TabItem<MobileSub>[] = [
  { key: "today", label: "今日" },
  { key: "schedule", label: "行程表" },
];

/** 頂帶日付印的尺寸（見檔頭「尺寸自決」） */
const MOBILE_SEAL_SIZE = 46;

/** 放大鏡（同 ⋯ 的 16 viewBox／1.3 筆觸；形狀同售票口合計帶的搜尋鈕） */
const ICON_SEARCH: MobileTabIcon = [
  { tag: "circle", attrs: { cx: 7, cy: 7, r: 4.4 } },
  { tag: "path", attrs: { d: "M10.3 10.3 13.6 13.6" } },
];

/** YYYY-MM-DD → 本地 Date（不經 Date.parse，避免 date-only 字串被當 UTC 而跨日；同 TodayView 的 dateOf） */
function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function MobileTopBand({ tab, tabsRow, manage }: MobileTopBandProps) {
  const storedKey = useNodeStore((s) => s.today.dateKey);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const sub = useScheduleUiStore((s) => s.mobileSub);
  const setMobileSub = useScheduleUiStore((s) => s.setMobileSub);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const today = tab.key === "today";
  const dateKey = storedKey ?? todayKey(dayStartHour);
  const schedule = today && sub === "schedule";
  const [searching, setSearching] = useState(false);
  // 今日 tab：呼叫端沒給籤列就畫「今日｜行程表」（UI 丙-3 F2）
  const row =
    tabsRow ?? (today ? <Tabs items={TODAY_SUBS} value={sub} onChange={setMobileSub} aria-label="今日分頁" /> : null);
  const hasRow = row != null || manage != null;

  return (
    <>
      <header className="m-band">
        <div className="m-band-name">
          <div className="m-band-title">{schedule ? "行程表" : tab.label}</div>
          <div className="m-band-latin">{schedule ? "SCHEDULE" : tab.latin}</div>
        </div>
        {/* v1.1.1 WP8：同步狀態點掛在頂帶右端（今日頁在日付印左邊）。
            沒加入同步時（v1.1.3 的說法；舊稱「未啟用」）`SyncDot` 整顆不渲染，`.m-band-end` 就是個空的 flex 容器——
            v1.1.0 的版面（頁名＋日付印）逐像素不變。 */}
        <div className="m-band-end">
          <SyncDot className="m-band-sync-dot" />
          {today && <DateSeal date={dateOf(dateKey)} size={MOBILE_SEAL_SIZE} title={`日付印 ${dateKey}`} />}
          {/* 磨光①：手機搜尋的唯一入口（外接鍵盤的 Ctrl+P 在手機殼不掛，D-4） */}
          <button type="button" className="m-band-search" aria-label="搜尋" onClick={() => setSearching(true)}>
            {renderTabIcon(ICON_SEARCH, 20)}
          </button>
          {/* 售票口線車次①（D-票-20、0-28）：「更多」的全域入口；在「更多」頁時呈按下狀態，點任一格 tab 離開。
              UI 丙-2：圖示 ⋯ → 齒輪（§1.7；全域設定在「更多」頁裡），行為與 class 不變 */}
          <button
            type="button"
            className="m-band-more"
            aria-label="更多"
            title="更多"
            aria-pressed={tab.key === "more"}
            onClick={() => setMobileTab("more")}
          >
            <IconGear size={20} />
          </button>
        </div>
        {searching && <MobileQuickJump onClose={() => setSearching(false)} />}
      </header>
      {/* UI 丙-2 插槽：頂帶下一列＝分頁籤列＋末端「管理」文字鈕；都沒有就不畫（丙-1 版面逐字不變）。今日 tab 有「今日｜行程表」（丙-3） */}
      {hasRow && (
        <div className="ns-tabrow">
          {row ?? <span className="ns-tabrow-fill" aria-hidden="true" />}
          {manage && (
            <span className="mgr">
              <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={manage.onClick}>
                {manage.label}
              </button>
            </span>
          )}
        </div>
      )}
    </>
  );
}
