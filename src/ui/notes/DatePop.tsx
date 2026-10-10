/**
 * DatePop——挑一天的小浮層（桌機；車次①契約 §2.2、§5.1）。
 *
 * 兩個用處：收件匣車票「排某天」（快選 明天／後天／下週一＋日期欄，min＝今天）、
 * 筆記內容欄「改日期」（改 noted_at；只有日期欄，max＝今天——補記不記到未來）。
 * 原型 app.js inboxPop('someday')／noteEditor('noteDate')。
 * Esc 收起（自理並 stopPropagation）；點外面收起（notesBits.usePopDismiss）。
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { fmtShort, usePopDismiss } from "./notesBits";

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

export function DatePop({ label, value, min, max, quick, onPick, onClose, float = false }: DatePopProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  usePopDismiss(rootRef, onClose);

  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLElement>("button, input");
    first?.focus({ preventScroll: true });
    rootRef.current?.scrollIntoView({ block: "nearest" }); // 浮層別落在視野外
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  // 年份 ≥ 1970：鍵盤逐位輸入年份時會先經過 0002／0020 這種值，不能當成選好了
  const valid = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) && Number(d.slice(0, 4)) >= 1970 && (!min || d >= min) && (!max || d <= max);

  return (
    <div
      ref={rootRef}
      className={`ns-notes-pop${float ? " float" : ""}`}
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={float && !quick ? { width: 240 } : undefined}
    >
      <div className="ns-notes-poplabel">{label}</div>
      <div className="ns-notes-chips">
        {quick?.map((q) => (
          <button key={q.label} type="button" className="ns-notes-chip" onClick={() => onPick(q.day)}>
            {q.label}
            <span className="sub">{fmtShort(q.day)}</span>
          </button>
        ))}
        <input
          type="date"
          className="ns-notes-date"
          defaultValue={value ?? ""}
          min={min}
          max={max}
          aria-label="挑日期"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              const v = e.currentTarget.value;
              if (valid(v)) onPick(v);
            }
          }}
          onChange={(e) => {
            // 日期欄的 change 在用月曆點選時才完整；用鍵盤逐位輸入會中途觸發，只接受完整且在範圍內的值
            const v = e.target.value;
            if (valid(v) && v !== (value ?? "")) onPick(v);
          }}
        />
      </div>
    </div>
  );
}
