/**
 * MobileDatePick——手機的「挑一天」底部面板（車次①契約 §5.3；桌機的對應是乙席 DatePop）。
 * 車次② D-筆-30 起本體搬到共用的 `src/ui/common/MobileDatePicker.tsx`，這裡是轉呼叫的薄殼（下面的說明仍是它的行為）。
 *
 * 兩個用處：
 *   1. 收件匣車票「排某天」——快捷 chip（明天／後天／下週一）＋原生日期欄（min＝今天），不給清除。
 *   2. 筆記整頁改日期（noted_at 補記）——快捷 chip（今天／昨天）＋原生日期欄（max＝今天）。
 * 變待辦預覽的「執行日」不走這裡：那一欄 chip 常駐在欄位裡（契約 §5.2 同形），不必再開一層。
 *
 * 為什麼是底部面板而不是錨定小浮層：拇指按得到、暗幕點哪都關得掉（與 MobileToday 的 action sheet 同一套理由）。
 * 「取消」是清清楚楚的一格，不只依賴點暗幕。
 * 以 portal 掛到 body：從收件匣卡片／筆記整頁開的時候，元件樹在 `.m-page`（z-index 1 的疊放脈絡）裡，
 * 不搬出去的話 fixed 暗幕再高的 z-index 也蓋不過 tab bar（實測被壓在底部分頁列下面）。
 * `[data-shell="mobile"]` 也掛在 <html> 上（useShell.ts），所以樣式選擇器照樣命中。
 *
 * 也放了手機各元件共用的幾支日期小工具（`shortDay`／`nextMonday`／`shiftIsoToDay`）——
 * 契約 §2.3 沒有另開 util 檔的位子，放在最貼近日期的這一支。
 */
import { addDays } from "../../../lib/date";
import { MobileDatePicker, type DateQuick } from "../../common/MobileDatePicker";

/** "2026-10-05" → "10/5" */
export function shortDay(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return m && d ? `${m}/${d}` : key;
}

/** 兩個日期 key 相差幾天（a − b）；不經 Date.parse，避免 date-only 被當 UTC 而跨日 */
export function diffDayKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()) / 86_400_000);
}

/** 下一個週一（今天是週一＝下週一） */
export function nextMonday(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(key, (8 - dow) % 7 || 7);
}

/**
 * 改筆記日期時保留原本的時刻：把 iso 平移 (toDay − fromDay) 天。
 * 以「日界線換算後的日」相減，所以凌晨 1 點（日界線 3 點之前）記的那則改到 10/5，換算後仍落在 10/5。
 */
export function shiftIsoToDay(iso: string, fromDay: string, toDay: string): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + diffDayKeys(toDay, fromDay));
  return d.toISOString();
}

export type { DateQuick } from "../../common/MobileDatePicker";

export interface MobileDatePickProps {
  title: string;
  /** 目前的值（chip 亮起／日期欄預填）；null＝沒有 */
  value: string | null;
  min?: string;
  max?: string;
  quick: readonly DateQuick[];
  onPick(day: string): void;
  onClose(): void;
}

/** 車次② D-筆-30 起是薄殼：本體在共用的 `src/ui/common/MobileDatePicker.tsx`；props 與車次①相同（凍結介面） */
export function MobileDatePick(props: MobileDatePickProps) {
  return <MobileDatePicker {...props} />;
}
