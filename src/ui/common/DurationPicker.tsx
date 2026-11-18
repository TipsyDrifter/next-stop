/**
 * DurationPicker——全站唯一指定「時 × 分雙排時長挑選器」與「目標時數挑選器」（v1.32 2A-2）。
 *
 * 兩種模式共用同一顆智慧輸入核心（`src/domain/duration.ts`）：
 *   1. `mode="matrix"`（預設，用於建票列、車票詳情雙端、手機時刻面板、時刻表發車／改塊預估）：
 *      - 第一排（小時）：`0h · 1h · 2h · 3h · 4h+`（值 ≥ 4h 時 `4h+` 亮起並顯示實際小時，點擊可展開／收合 `4h · 5h · 6h · 8h`）
 *      - 第二排（分鐘）：`00 · 10 · 15 · 20 · 30 · 40 · 45 · 50m`
 *      - 點兩下秒組時長：點 `1h` → `60m`，再點 `10m` → `70m`；點 `2h` + `30m` → `150m`；直接點 `30m` → `30m`；`0h + 00m` 或「不設」鈕清除為 `null`。
 *      - 智慧輸入框（`.techo-input`）：隨時可直接敲 `70`、`2.5h`、`1h10`、`1:30`、`90分`，非標準格值（如 `25m`）亦清晰顯示。
 *   2. `mode="goal"`（供時刻表 `GoalPanel.tsx` 使用）：
 *      - 依目標期間（日／週／月與區間）自動切換高頻大尺度快選排＋分鐘微調 chip（`00 · 15 · 30 · 45m`）＋同款智慧輸入框（支援 `12.5h`、`40h`、`10h30`）。
 *
 * 鍵盤與 IME 紀律：
 *   - 嚴格三道組字守門（`e.nativeEvent.isComposing || e.keyCode === 229 || composing.current`）
 *   - `Escape` 還原進入輸入框前的值並 `stopPropagation()`，絕不誤關外層浮層／側板／對話框。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  DURATION_DEFAULT_MAX,
  DURATION_GOAL_MAX,
  MATRIX_BASE_HOURS,
  MATRIX_EXT_HOURS,
  MATRIX_MINUTES,
  composeMatrixHour,
  composeMatrixMinute,
  formatDurationShort,
  parseDurationInput,
  splitDurationMatrix,
} from "../../domain/duration";
import type { GoalPeriod } from "../../domain/timetableStats";
import "./durationpicker.css";

const GOAL_DAY_PRESETS = [30, 60, 120, 180, 240] as const;
const GOAL_WEEK_PRESETS = [180, 300, 600, 900, 1200] as const;
const GOAL_LONG_PRESETS = [600, 1200, 1800, 2400, 3600] as const;
const GOAL_MINUTES = [0, 15, 30, 45] as const;

function goalPresetsOf(period: GoalPeriod | undefined): readonly number[] {
  if (period === "day") return GOAL_DAY_PRESETS;
  if (period === "week") return GOAL_WEEK_PRESETS;
  return GOAL_LONG_PRESETS;
}

export interface DurationPickerProps {
  /** 目前分鐘數；`null` 代表不設／未預估 */
  value: number | null;
  /** 值變更回呼 */
  onChange(next: number | null): void;
  /** `matrix`＝時×分雙排矩陣（預設）；`goal`＝目標大尺度時數 */
  mode?: "matrix" | "goal";
  /** `mode="goal"` 時依期間切換高頻快選（日／週／月或區間） */
  goalPeriod?: GoalPeriod;
  /** 是否允許清除為 `null`（`matrix` 預設 `true`、`goal` 預設 `false`） */
  allowNull?: boolean;
  /** 最大分鐘數（`matrix` 預設 `1440`＝24h、`goal` 預設 `60000`＝1000h） */
  maxMin?: number;
  /** 緊湊版（桌機側板 220px 控制欄、建票列浮層） */
  compact?: boolean;
  /**
   * 智慧輸入框打字時，只要當前草稿可合法解析就即時觸發 `onChange`（草稿型面板／表單傳 `true`：
   * 即使使用者不先 blur 直接點儲存鈕，父層 state 也已是最新值；直接寫庫的側板傳預設 `false`，於 Enter／blur 才送出）。
   */
  liveCommit?: boolean;
  /** 在智慧輸入框按 Enter 確認合法值後的額外動作（如收起建票浮層） */
  onEnter?(): void;
  /** 底部列右側附加動作（如發車面板的「收起／不預估」） */
  extra?: ReactNode;
  /** 是否顯示內建的 `× 不設` 清除鈕（預設 `!extra`：當外部已透過 `extra` 提供「不預估／收起」時自動隱藏，避免雙重清除鈕） */
  showClear?: boolean;
  /** 無障礙標籤前綴（預設「預估時長」或「目標時數」） */
  ariaLabel?: string;
  className?: string;
}

export function DurationPicker({
  value,
  onChange,
  mode = "matrix",
  goalPeriod,
  allowNull = mode === "matrix",
  maxMin = mode === "goal" ? DURATION_GOAL_MAX : DURATION_DEFAULT_MAX,
  compact = false,
  liveCommit = false,
  onEnter,
  extra,
  showClear = !extra,
  ariaLabel = mode === "goal" ? "目標時數" : "預估時長",
  className,
}: DurationPickerProps) {
  const normValue = value !== null && Number.isFinite(value) && value > 0 ? Math.min(maxMin, Math.round(value)) : null;

  const [extOpen, setExtOpen] = useState(false);
  const [armedZero, setArmedZero] = useState(false);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [shake, setShake] = useState(false);

  const composing = useRef(false);
  const droppedRef = useRef(false);
  const focusOrigin = useRef<number | null>(normValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // 外部值變動且非聚焦打字時清除草稿錯誤與 0h 預備態
  useEffect(() => {
    if (normValue !== null) setArmedZero(false);
    if (!focused) {
      setDraft(normValue !== null ? formatDurationShort(normValue) : "");
      setErr(null);
    }
  }, [normValue, focused]);

  const parsedDraft = focused ? parseDurationInput(draft, { maxMin }) : undefined;
  const activeMin =
    focused && parsedDraft !== undefined && (parsedDraft !== null || allowNull) ? parsedDraft : normValue;

  const parts = splitDurationMatrix(activeMin);
  const shownInput = focused ? draft : normValue !== null ? formatDurationShort(normValue) : "";

  const triggerInvalid = (raw: string) => {
    const trimmed = raw.trim();
    setErr(`無法辨識「${trimmed.slice(0, 12)}」——可輸入如 70、1h10、2.5h`);
    setShake(false);
    window.requestAnimationFrame(() => setShake(true));
  };

  const commitDraft = (raw: string): boolean => {
    const res = parseDurationInput(raw, { maxMin });
    if (res === null) {
      if (allowNull) {
        setErr(null);
        setArmedZero(false);
        if (normValue !== null) onChange(null);
        return true;
      }
      // 不允許 null（如目標時數）：空白還原回進入焦點前的值
      setDraft(normValue !== null ? formatDurationShort(normValue) : "");
      setErr(null);
      return true;
    }
    if (res === undefined) {
      triggerInvalid(raw);
      setDraft(normValue !== null ? formatDurationShort(normValue) : "");
      return false;
    }
    setErr(null);
    setArmedZero(false);
    setDraft(formatDurationShort(res));
    if (res !== normValue) onChange(res);
    return true;
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const ok = commitDraft(e.currentTarget.value);
      if (ok) {
        if (onEnter) onEnter();
        else e.currentTarget.blur();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      droppedRef.current = true;
      const prev = focusOrigin.current;
      setErr(null);
      setDraft(prev !== null ? formatDurationShort(prev) : "");
      if (liveCommit && prev !== normValue) onChange(prev);
      e.currentTarget.blur();
    }
  };

  const pickHour = (h: number) => {
    setErr(null);
    if (h < 4) setExtOpen(false);
    if (h === 0 && normValue === null) {
      setArmedZero((z) => !z);
      return;
    }
    setArmedZero(false);
    const next = composeMatrixHour(normValue, h, { allowNull, maxMin });
    setDraft(next !== null ? formatDurationShort(next) : "");
    if (next !== normValue) onChange(next);
  };

  const pickMinute = (m: number) => {
    setErr(null);
    setArmedZero(false);
    const next = composeMatrixMinute(normValue, m, { allowNull, maxMin });
    setDraft(next !== null ? formatDurationShort(next) : "");
    if (next !== normValue) onChange(next);
  };

  const clearAll = () => {
    if (!allowNull) return;
    setErr(null);
    setArmedZero(false);
    setExtOpen(false);
    setDraft("");
    if (normValue !== null) onChange(null);
  };

  const rootCls =
    "ns-dur" +
    (mode === "goal" ? " is-goal" : " is-matrix") +
    (compact ? " is-compact" : "") +
    (className ? " " + className : "");

  if (mode === "goal") {
    const presets = goalPresetsOf(goalPeriod);
    const curMin = activeMin ?? 60;
    const curH = Math.floor(curMin / 60);
    const curM = curMin % 60;
    const isNonGrid = !presets.includes(curMin) && !(GOAL_MINUTES as readonly number[]).includes(curM);

    return (
      <div className={rootCls} role="group" aria-label={ariaLabel}>
        <div className="ns-dur-hours" role="group" aria-label={`${ariaLabel}快選`}>
          {presets.map((p) => {
            const isExact = curMin === p;
            const isHourMatch = p >= 60 && p % 60 === 0 && curH * 60 === p;
            const on = isExact || isHourMatch;
            return (
              <button
                key={p}
                type="button"
                className={"ns-dur-cell" + (on ? " is-on" : "")}
                aria-pressed={on}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setErr(null);
                  const clamped = Math.min(maxMin, p);
                  setDraft(formatDurationShort(clamped));
                  if (clamped !== normValue) onChange(clamped);
                }}
              >
                {formatDurationShort(p)}
              </button>
            );
          })}
        </div>

        <div className="ns-dur-mins" role="group" aria-label={`${ariaLabel}分鐘微調`}>
          {GOAL_MINUTES.map((m) => {
            const on = curM === m;
            const disabled = curH === 0 && m === 0;
            const label = m === 45 ? "45m" : String(m).padStart(2, "0");
            return (
              <button
                key={m}
                type="button"
                className={"ns-dur-cell" + (on ? " is-on" : "")}
                aria-pressed={on}
                disabled={disabled}
                aria-label={`${m} 分`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setErr(null);
                  const next = Math.min(maxMin, Math.max(1, curH * 60 + m));
                  setDraft(formatDurationShort(next));
                  if (next !== normValue) onChange(next);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="ns-dur-bar">
          <span className="ns-dur-inwrap">
            <input
              ref={inputRef}
              type="text"
              inputMode="text"
              className={
                "techo-input ns-dur-in" +
                (isNonGrid ? " is-custom" : "") +
                (shake ? " is-shake" : "")
              }
              value={shownInput}
              placeholder="10h / 12.5h / 90m"
              aria-label={`${ariaLabel}（可輸入 12.5h、10h30、90m）`}
              aria-invalid={err !== null || undefined}
              onAnimationEnd={() => setShake(false)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(e) => {
                composing.current = false;
                if (liveCommit) {
                  const v = parseDurationInput(e.currentTarget.value, { maxMin });
                  if (v !== undefined && v !== null && v !== normValue) onChange(v);
                }
              }}
              onFocus={() => {
                droppedRef.current = false;
                focusOrigin.current = normValue;
                setDraft(normValue !== null ? formatDurationShort(normValue) : "");
                setFocused(true);
              }}
              onChange={(e) => {
                const raw = e.target.value;
                setDraft(raw);
                if (err) setErr(null);
                if (liveCommit && !composing.current) {
                  const v = parseDurationInput(raw, { maxMin });
                  if (v !== undefined && v !== null && v !== normValue) onChange(v);
                }
              }}
              onBlur={(e) => {
                setFocused(false);
                if (droppedRef.current) {
                  droppedRef.current = false;
                  return;
                }
                commitDraft(e.currentTarget.value);
              }}
              onKeyDown={onInputKeyDown}
            />
          </span>
          {extra}
        </div>
        {err && (
          <p className="ns-dur-err" role="status" aria-live="polite">
            {err}
          </p>
        )}
      </div>
    );
  }

  const highHourOn = parts.hours !== null && parts.hours >= 4;
  const highHourLabel = highHourOn ? `${parts.hours}h` : "4h+";

  return (
    <div className={rootCls} role="group" aria-label={ariaLabel}>
      <div className="ns-dur-hours" role="group" aria-label={`${ariaLabel}・小時`}>
        {MATRIX_BASE_HOURS.map((h) => {
          const on = parts.hours === h;
          const armed = h === 0 && parts.hours === null && armedZero;
          return (
            <button
              key={h}
              type="button"
              className={"ns-dur-cell" + (on ? " is-on" : "") + (armed ? " is-armed" : "")}
              aria-pressed={on || armed}
              aria-label={`${h} 小時`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickHour(h)}
            >
              {h}h
            </button>
          );
        })}
        <button
          type="button"
          className={"ns-dur-cell" + (highHourOn ? " is-on" : "") + (extOpen ? " is-open" : "")}
          aria-pressed={highHourOn}
          aria-expanded={extOpen}
          aria-label={highHourOn ? `${parts.hours} 小時（點一下切換 4 至 8 小時選項）` : "4 小時以上"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setErr(null);
            setArmedZero(false);
            if (!highHourOn && !extOpen) {
              setExtOpen(true);
              const next = composeMatrixHour(normValue, 4, { allowNull, maxMin });
              setDraft(next !== null ? formatDurationShort(next) : "");
              if (next !== normValue) onChange(next);
            } else {
              setExtOpen((o) => !o);
            }
          }}
        >
          <span>{highHourLabel}</span>
          <span className="ns-dur-caret" aria-hidden="true">
            {extOpen ? "▴" : "▾"}
          </span>
        </button>
      </div>

      {extOpen && (
        <div className="ns-dur-ext" role="group" aria-label="4 至 8 小時">
          {MATRIX_EXT_HOURS.map((h) => {
            const on = parts.hours === h;
            return (
              <button
                key={h}
                type="button"
                className={"ns-dur-cell" + (on ? " is-on" : "")}
                aria-pressed={on}
                aria-label={`${h} 小時`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickHour(h)}
              >
                {h}h
              </button>
            );
          })}
        </div>
      )}

      <div className="ns-dur-mins" role="group" aria-label={`${ariaLabel}・分鐘`}>
        {MATRIX_MINUTES.map((m) => {
          const on = parts.mins === m;
          const disabled = !allowNull && (parts.hours ?? 0) === 0 && m === 0;
          const label = m === 50 ? "50m" : String(m).padStart(2, "0");
          return (
            <button
              key={m}
              type="button"
              className={"ns-dur-cell" + (on ? " is-on" : "")}
              aria-pressed={on}
              disabled={disabled}
              aria-label={`${m} 分`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickMinute(m)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="ns-dur-bar">
        <span className="ns-dur-inwrap">
          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            className={
              "techo-input ns-dur-in" +
              (parts.isCustomMin ? " is-custom" : "") +
              (shake ? " is-shake" : "")
            }
            value={shownInput}
            placeholder="70 / 1h10 / 2.5h"
            aria-label={`${ariaLabel}輸入（可輸入 70、1h10、2.5h）`}
            aria-invalid={err !== null || undefined}
            onAnimationEnd={() => setShake(false)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={(e) => {
              composing.current = false;
              if (liveCommit) {
                const v = parseDurationInput(e.currentTarget.value, { maxMin });
                if (v !== undefined && (v !== null || allowNull) && v !== normValue) onChange(v);
              }
            }}
            onFocus={() => {
              droppedRef.current = false;
              focusOrigin.current = normValue;
              setDraft(normValue !== null ? formatDurationShort(normValue) : "");
              setFocused(true);
            }}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              if (err) setErr(null);
              if (liveCommit && !composing.current) {
                const v = parseDurationInput(raw, { maxMin });
                if (v !== undefined && (v !== null || allowNull) && v !== normValue) onChange(v);
              }
            }}
            onBlur={(e) => {
              setFocused(false);
              if (droppedRef.current) {
                droppedRef.current = false;
                return;
              }
              commitDraft(e.currentTarget.value);
            }}
            onKeyDown={onInputKeyDown}
          />
        </span>
        {allowNull && showClear && normValue !== null && (
          <button
            type="button"
            className="ns-dur-clear"
            title="清除時長（不設）"
            aria-label={`清除${ariaLabel}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clearAll}
          >
            × 不設
          </button>
        )}
        {extra}
      </div>

      {err && (
        <p className="ns-dur-err" role="status" aria-live="polite">
          {err}
        </p>
      )}
    </div>
  );
}
