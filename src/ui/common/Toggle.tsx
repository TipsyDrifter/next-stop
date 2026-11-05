/**
 * Toggle——一顆「開／關」開關（role="switch"；樣式在 `./toggle.css`）。
 * 字也寫出來（開／關），不只靠滑塊位置。即選即存的設定列用：時刻表〈通知〉籤、提醒頁。
 * 原本寫在 timetable/panels/NoticeSettings.tsx（class 叫 `.ns-tt-toggle`）；提醒頁要用同一顆，搬到 common。
 */
export function Toggle({
  on,
  onFlip,
  label,
  disabled = false,
}: {
  on: boolean;
  onFlip(): void;
  /** 念給輔助工具聽的名字（畫面上的字只有開／關） */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={"ns-toggle" + (on ? " is-on" : "")}
      onClick={onFlip}
    >
      <span className="ns-toggle-knob" aria-hidden="true" />
      <span className="ns-toggle-text">{on ? "開" : "關"}</span>
    </button>
  );
}
