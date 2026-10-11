/**
 * DatePop——挑一天的小浮層（桌機；車次①契約 §2.2、§5.1）。
 *
 * 車次② D-筆-30 起是**薄殼**：本體搬到共用的 `src/ui/common/DatePicker.tsx`（今日頁推遲小卡也用它），
 * 這裡只轉呼叫並掛上 `.ns-notes-pop`——notes.css 依它調外距與位置（收件匣臨時券的左縮、
 * `.ns-notes-metaline`／`.ns-notes-field` 裡的 float 定位）。props 與車次①相同（凍結介面）。
 *
 * 兩個用處：收件匣車票「排某天」（快選 明天／後天／下週一＋日期欄，min＝今天）、
 * 筆記內容欄「改日期」（改 noted_at；只有日期欄，max＝今天——補記不記到未來）。
 * Esc 收起、點外面收起（帶 data-pop-toggle 的開關鈕除外），都由共用元件處理。
 */
import { DatePicker } from "../common/DatePicker";

export interface DatePopProps {
  label: string;
  /** 目前的日子（日期欄的初值）；null／省略＝空 */
  value?: string | null;
  min?: string;
  max?: string;
  /** 快選 chip（例：明天／後天／下週一） */
  quick?: { label: string; day: string }[];
  onPick(day: string): void;
  onClose(): void;
  float?: boolean;
}

export function DatePop(props: DatePopProps) {
  return <DatePicker {...props} className="ns-notes-pop" />;
}
