/**
 * 側板的單選欄（UI 丙-3 C2／C5）：選項放得下就用新 `Segmented`（規範 §2.2 右欄：表單內單選、2～5 段），
 * 放不下就換底線下拉 `.ns-select-wrap`（§2.5：≤7 個固定選項的下拉；路線、幹線多起來時也只能用它）。
 * 「現況／優先順序／所屬路線／所屬幹線」四欄共用，取代舊的 `common/fields.tsx` Segmented（ariaLabel／twoColumns 那支）。
 *
 * 放不放得下：側板控制項欄只有約 220px（--panel-w 340 扣內距與 56px 小標），新 Segmented 不換行、超出只能橫捲，
 * 所以這裡用字數估：≤4 段且全部標籤加起來 ≤13 字。現況「未開始／進行中／已完成／途中下車」剛好 13 字（丙-7 由「擱置」改名），
 * 原本 6px 內距擠不進、會落到下拉（控件種類跟著變）；丙-7 把 panel.css 的 .panel-seg 內距收成 4px，實測四段剛好 217/217，門檻放到 13。
 * 放不下的時候整組換成下拉，不半套（一半方格一半捲出去，使用者看不到後面的選項）。
 */
import { Segmented } from "../common/Segmented";

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
  title?: string;
}

/** 側板放得下一排分段鈕嗎（≤4 段、標籤合計 ≤13 字） */
export function fitsSegmented(options: readonly { label: string }[]): boolean {
  if (options.length > 4) return false;
  return options.reduce((n, o) => n + [...o.label].length, 0) <= 13;
}

export function Choice<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: V | null;
  options: readonly ChoiceOption<V>[];
  onChange: (v: V) => void;
  ariaLabel: string;
}) {
  if (fitsSegmented(options)) {
    return <Segmented options={options} value={value} onChange={onChange} aria-label={ariaLabel} className="panel-seg" />;
  }
  return (
    <span className="ns-select-wrap panel-select">
      <select
        className="techo-input"
        aria-label={ariaLabel}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value as V;
          if (v && v !== value) onChange(v);
        }}
      >
        {value === null && (
          <option value="" disabled>
            —
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
