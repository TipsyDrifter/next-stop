/**
 * Segmented——分段鈕：表單內的單選（視覺規範 §2.2 右欄；UI 丙-2 共用元件庫 #3）。
 *
 * 用途：記一筆 支出／收入／轉帳、分類管理 支出／收入、長度組（＋旁邊一顆「自訂…」chip）、主題三選。2～5 段。
 * 不用：切頁的視圖或子頁 → `Tabs`（襯線底線籤）；多選或篩選 → chip。
 * 位置：表單內該欄位；手機殼撐滿一列（每段平分）。
 *
 * 長相（樣式在 `./tabs.css` 下半，活樣本 prototypes/ui-brand/index.html §9）：
 *   相連方格、1px `--color-dash` 框、`--radius-ctl`、黑體 `--fs-ui` 500、字距 .12em；
 *   選中＝`--sel-bg` 底＋`--sel-fg` 字；高 `--ctl-seg`（桌機 32、手機 44）；`compact`＝`--ctl-h-sm`（24／36）＋`--fs-sm`。
 *   禁用段＝`--disabled`＋not-allowed＋不響應 hover，`title` 寫為什麼（§1.8）。
 *   `value` 可為 null＝這一組目前沒有選中（例：長度選了旁邊的「自訂…」chip）。
 *
 * ARIA：容器 `role="radiogroup"`＋`aria-label`（必填）；每段 `role="radio"`＋`aria-checked`＋`.is-on`（§2.10）。
 * 鍵盤：一個 Tab stop（選中段；沒有選中時是第一個可用段）；←→（與 ↑↓，radiogroup 慣例）換選項——
 *   焦點與選中一起走、循環、跳過禁用；Home／End 到第一／最後；Space／Enter 由按鈕原生 click 選中目前這段。
 *   處理過的鍵 preventDefault＋stopPropagation（不讓頁面的導航表再吃一次）。
 * 樣式不在本檔 import：`tabs.css` 由 `src/index.css` 集中 @import。
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { rovingDir, stepRoving } from "./Tabs";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** 滑過的說明；禁用時寫「為什麼不能選」 */
  title?: string;
}

export interface SegmentedProps<V extends string = string> {
  options: readonly SegmentedOption<V>[];
  /** null＝這一組沒有選中 */
  value: V | null;
  onChange: (value: V) => void;
  /** 緊湊：高 --ctl-h-sm、字 --fs-sm（長度組那種） */
  compact?: boolean;
  /** 讀屏用名稱：這一組在選什麼（例「類型」「長度」「主題」） */
  "aria-label": string;
  className?: string;
}

export function Segmented<V extends string = string>({
  options,
  value,
  onChange,
  compact = false,
  "aria-label": ariaLabel,
  className,
}: SegmentedProps<V>) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = options.map((o) => !!o.disabled);
  const selIndex = options.findIndex((o) => o.value === value);
  const tabStop = selIndex >= 0 && !disabled[selIndex] ? selIndex : stepRoving(disabled, -1, "first");

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = rovingDir(e.key, true);
    if (dir === null) return;
    const from = btnRefs.current.findIndex((b) => b === e.target);
    const next = stepRoving(disabled, from >= 0 ? from : selIndex, dir);
    if (next < 0) return;
    e.preventDefault();
    e.stopPropagation();
    btnRefs.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  };

  const cls = ["ns-seg", compact ? "ns-seg--sm" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <div className={cls} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            className={on ? "is-on" : undefined}
            aria-checked={on}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
