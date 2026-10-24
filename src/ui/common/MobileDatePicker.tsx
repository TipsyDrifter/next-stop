/**
 * MobileDatePicker——手機的「挑一天」底部面板（旅客筆記車次② D-筆-30 抽出的共用元件；桌機版＝同目錄 `DatePicker`）。
 * 底子是旅客筆記車次①的 MobileDatePick。
 *
 * 長相：拉柄＋標題（虛線底）＋快選 chip 一排（與 `value` 同日的亮起）＋自畫月格 `DayGrid`（格高 44px）＋整寬「取消」。
 * 磨光⑤ S8（D-主-54：日期挑選統一成 App 自畫）起**一律**畫月格、不再退回原生日期欄；`marks` 只決定有沒有記號點
 * （旅客筆記車次③ 0-6 甲、D-筆-46 修訂：日記傳）。實體鍵盤的 Esc＝取消（返回鍵由呼叫端的 useBackLayer 管）。
 * 為什麼是底部面板而不是錨定小浮層：拇指按得到、暗幕點哪都關得掉；「取消」是清清楚楚的一格。
 * 樣式在 `./datepicker.css`（`.ns-mdatepick*`，每條掛 `[data-shell="mobile"]`；不依賴任何一條線的 class）。
 *
 * **殼＝共用 `MSheet`（UI 丙-4 C6；視覺規範 §2.4「手機底部 sheet」）**：拉柄、襯線標題、內容可捲、黏底「取消」＝殼的 foot；
 * 拖把手下滑／點暗幕／Esc 都是取消。`backId`＝呼叫端**已經用 useBackLayer 登記的那一層 id**、`backKind`＝它登記時的 kind：
 * MSheet 用同一個 id 登記 ⇒ backStack refcount 合併成一層，返回鍵按一次就關（不給會變兩層，契約 §7-2）。kind 以**第一次登記**
 * 為準（backStackCore push），而子元件 MSheet 的 effect 比呼叫端先跑——所以 backKind 一定要跟呼叫端那一行一樣，
 * 不然 z 序（sheet 45／dialog 47）與返回鍵的先後會跟呼叫端以為的不同。
 * UI 丙-7 T5：呼叫端全數補上 backId，舊殼（`.ns-mdatepick-veil > .ns-mdatepick`、自管 Esc）與它的 css 一起刪掉，backId 改成必填。
 */
import { MSheet } from "./MSheet";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { shortDayKey, type DateQuick } from "./DatePicker";
import { DayGrid } from "./DayGrid";
import "./datepicker.css";

export type { DateQuick } from "./DatePicker";

export interface MobileDatePickerProps {
  /** 面板標題（也是 dialog 的 aria-label） */
  title: string;
  /** 目前的值（同日的 chip 亮起；不在 chip 裡＝日期欄預填並亮起）；null＝沒有 */
  value: string | null;
  /** YYYY-MM-DD；含 */
  min?: string;
  /** YYYY-MM-DD；含 */
  max?: string;
  quick: readonly DateQuick[];
  onPick(day: string): void;
  onClose(): void;
  /** 舊的原生日期欄前的小字；磨光⑤ S8 起一律畫月格、不再顯示（保留 prop 免得呼叫端跟著改） */
  fieldLabel?: string;
  /** 有記號的日子（YYYY-MM-DD）；省略＝月格沒有記號點 */
  marks?: ReadonlySet<string>;
  /** 月格掛上時一次、之後每次換月：YYYY-MM（呼叫端補查那個月的記號） */
  onMonthChange?(month: string): void;
  /** 記號的意思（月格下的圖例與讀屏字，例「寫過日記」） */
  marksLabel?: string;
  /** 今天（月格的外框）；省略＝依 uiStore.dayStartHour 算的今天 */
  today?: string;
  /** 呼叫端已用 useBackLayer 登記的返回層 id（UI 丙-4 C6）：MSheet 用這個 id 登記 ⇒ 合併成同一層 */
  backId: string;
  /** 呼叫端登記那一層時的 kind（預設 "sheet"）；疊在全螢幕頁上的（DateChip）是 "dialog"。必須跟呼叫端一樣 */
  backKind?: "sheet" | "dialog";
}

export function MobileDatePicker({
  title,
  value,
  min,
  max,
  quick,
  onPick,
  onClose,
  marks,
  onMonthChange,
  marksLabel,
  today,
  backId,
  backKind = "sheet",
}: MobileDatePickerProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const chips = (
    <div className="ns-mdatepick-chips">
      {quick.map((q) => (
        <button
          key={q.label}
          type="button"
          className={"ns-mdatepick-chip" + (value === q.day ? " on" : "")}
          aria-pressed={value === q.day}
          onClick={() => onPick(q.day)}
        >
          {q.label}
          <span className="sub">{shortDayKey(q.day)}</span>
        </button>
      ))}
    </div>
  );
  const grid = (
    <DayGrid
      variant="mobile"
      value={value}
      today={today ?? todayKey(dayStartHour)}
      min={min}
      max={max}
      marks={marks}
      marksLabel={marksLabel}
      onMonthChange={onMonthChange}
      onPick={onPick}
    />
  );

  // 即時生效（點一天就收）＝沒有主鈕，foot 只有一顆整寬「取消」（§2.3 即時存沒有主鈕；取消在殼上、位置跟別的 sheet 一樣）。
  // 外包 .ns-mdatepick-sheet：讓 datepicker.css 把這張 sheet 的初始高放寬到裝得下整個月格（見那段的註解）
  return (
    <MSheet
      title={title}
      backId={backId}
      backKind={backKind}
      onClose={onClose}
      foot={
        <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
          取消
        </button>
      }
    >
      <div className="ns-mdatepick-sheet">
        {quick.length > 0 && chips}
        {grid}
      </div>
    </MSheet>
  );
}
