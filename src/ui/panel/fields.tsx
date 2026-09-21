/**
 * 詳情側板欄位積木（UI Flow 2.1 共用）：版面列、區段標題、文字／多行／日期／數字輸入、分段選擇、操作鈕。
 * 文字類 blur／Enter 才提交（避免每鍵重整），Esc 先還原草稿、草稿乾淨時才放行給面板關閉；數字空字串→null。
 * 已知取捨：日期欄位配合原生 date picker 採「改動後 400ms 去抖提交＋blur／Enter 立即送出」，不等 Enter 才寫。
 * 視覺＝原型語彙（techo.css 原型逐字移植段＋panel.css）：區段＝.sec、小標＝.overline 字型（.lbl）、輸入＝透明底＋.dash 底線、
 * 選項與按鈕＝.status 小方標（選中 ink 邊）；原型沒有的控件（清除叉）hover 才現身。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** 側板內 input／textarea 的樣式由 panel.css 依元素統一給（透明底＋底線）；此常數保留給使用端掛額外 class */
export const inputClass = "";

/* ───────────── 版面 ───────────── */

/** 兩欄表單列：左小標（.lbl＝原型 .overline 字型）、右控制項；`top`＝多行控制項時小標對齊頂部（父層用 `.fields`） */
export function FieldRow({ label, children, top }: { label: string; children: ReactNode; top?: boolean }) {
  return (
    <div className={`field ${top ? "top" : ""}`}>
      <span className="lbl">{label}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** 區段標題（原型 .sec）：襯線小標＋虛線延伸＋右側淡注記 */
export function SectionRule({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="sec">
      <h3>{title}</h3>
      <span className="rule" />
      {aside && <span className="note">{aside}</span>}
    </div>
  );
}

/** 操作列：上方撕線、左右兩組鈕 */
export function ActionsRow({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="actions">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

export function ActionButton({
  children,
  onClick,
  ariaLabel,
  tone = "normal",
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaLabel: string;
  tone?: "normal" | "danger";
  title?: string;
}) {
  // 次鈕＝原型 .status 小方標（idle 色階）；危險鈕走誤點（late）色
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      className={`status ${tone === "danger" ? "late" : "idle"}`}
    >
      {children}
    </button>
  );
}

/* ───────────── 去抖提交 ───────────── */

/** 把連續變動收斂成一次提交；卸載時會把還沒送出的補送，避免面板關閉吃掉最後一筆 */
export function useDebouncedCommit<T>(fn: (v: T) => void, ms: number) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ v: T } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    if (p) {
      pending.current = null;
      fnRef.current(p.v);
    }
  }, []);
  const schedule = useCallback(
    (v: T) => {
      pending.current = { v };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, ms);
    },
    [flush, ms],
  );
  useEffect(() => flush, [flush]);
  return { schedule, flush, cancel };
}

/* ───────────── 文字 ───────────── */

interface CommitInputProps {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  /** 必填：空字串不提交、還原成原值 */
  required?: boolean;
  className?: string;
  autoFocus?: boolean;
  /** 標題用：改渲染成單列 textarea 讓長名稱折行（field-sizing:content），Enter 仍＝提交、不換行 */
  wrap?: boolean;
}

/** 單行文字：blur／Enter 提交（去前後空白）；Esc 在有改動時還原、否則放行（讓面板關閉） */
export function CommitInput({ value, onCommit, ariaLabel, placeholder, required, className, autoFocus, wrap }: CommitInputProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const committed = useRef(value);

  useEffect(() => {
    committed.current = value;
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    const next = draft.replace(/\s*\n\s*/g, " ").trim();
    if (next === committed.current || (required && !next)) {
      setDraft(committed.current);
      return;
    }
    committed.current = next;
    setDraft(next);
    onCommit(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape" && draft !== committed.current) {
      e.preventDefault();
      e.stopPropagation();
      setDraft(committed.current);
    }
  };
  const onFocus = () => {
    focused.current = true;
  };
  const onBlur = () => {
    focused.current = false;
    commit();
  };

  if (wrap) {
    return (
      <textarea
        rows={1}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={className}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\n/g, ""))}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}

interface CommitTextareaProps {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
}

/** 多行文字：blur／Ctrl+Enter 提交；Enter 換行；Esc 同單行規則 */
export function CommitTextarea({ value, onCommit, ariaLabel, placeholder, rows = 2 }: CommitTextareaProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const committed = useRef(value);

  useEffect(() => {
    committed.current = value;
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    const next = draft.trim();
    if (next === committed.current) {
      setDraft(committed.current);
      return;
    }
    committed.current = next;
    setDraft(next);
    onCommit(next);
  };

  return (
    <textarea
      aria-label={ariaLabel}
      placeholder={placeholder}
      rows={rows}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draft !== committed.current) {
          e.preventDefault();
          e.stopPropagation();
          setDraft(committed.current);
        }
      }}
    />
  );
}

/* ───────────── 日期 ───────────── */

interface DateFieldProps {
  value: string | null;
  onCommit: (v: string | null) => void;
  ariaLabel: string;
  className?: string;
}

/** 原生 date：選到完整日期後 400ms 去抖寫回；blur／Enter 立即送；清除叉（hover 現身）→null */
export function DateField({ value, onCommit, ariaLabel, className }: DateFieldProps) {
  const [draft, setDraft] = useState(value ?? "");
  const focused = useRef(false);
  const sent = useRef<string | null>(value);
  const send = useCallback(
    (v: string | null) => {
      sent.current = v;
      onCommit(v);
    },
    [onCommit],
  );
  const { schedule, flush, cancel } = useDebouncedCommit<string | null>(send, 400);

  useEffect(() => {
    if (!focused.current) setDraft(value ?? "");
  }, [value]);

  const settle = () => {
    if (draft) {
      flush();
    } else {
      cancel();
      if (value !== null || sent.current !== null) send(null);
    }
  };

  return (
    <div className="date">
      <input
        type="date"
        aria-label={ariaLabel}
        className={className}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (v) schedule(v);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          settle();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            settle();
          }
        }}
      />
      {(value || draft) && (
        <button
          type="button"
          aria-label={`清除${ariaLabel}`}
          title="清除"
          onClick={() => {
            cancel();
            setDraft("");
            send(null);
          }}
          className="x"
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}

/** 原型圖標語彙：1.3px 細線幾何 inline SVG */
export function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />
    </svg>
  );
}

/* ───────────── 數字 ───────────── */

interface NumberFieldProps {
  value: number | null;
  onCommit: (v: number | null) => void;
  ariaLabel: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

/** 數字：blur／Enter 提交；空字串→null；非數字還原；取整、夾在 min～max */
export function NumberField({ value, onCommit, ariaLabel, unit, min = 0, max, step, placeholder }: NumberFieldProps) {
  const toText = (v: number | null) => (v === null ? "" : String(v));
  const [draft, setDraft] = useState(toText(value));
  const focused = useRef(false);
  const committed = useRef<number | null>(value);

  useEffect(() => {
    committed.current = value;
    if (!focused.current) setDraft(toText(value));
  }, [value]);

  const commit = () => {
    const raw = draft.trim();
    let next: number | null;
    if (raw === "") {
      next = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        setDraft(toText(committed.current));
        return;
      }
      next = Math.max(min, Math.round(n));
      if (max !== undefined) next = Math.min(max, next);
    }
    setDraft(toText(next));
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
  };

  return (
    <div className="num">
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && draft !== toText(committed.current)) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(toText(committed.current));
          }
        }}
      />
      {unit && <span className="meta">{unit}</span>}
    </div>
  );
}

/* ───────────── 分段選擇 ───────────── */

interface SegmentedProps<T extends string> {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T | null) => void;
  ariaLabel: string;
  /** 再按一次已選項＝清除 */
  clearable?: boolean;
  /** 四個選項在 320 側板放不下一排 → 2×2 */
  twoColumns?: boolean;
}

/** 原型 .status 小方標一排：未選＝idle 色階、選中＝ink 邊（選取不只靠顏色：aria-pressed） */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel, clearable, twoColumns }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={`opts ${twoColumns ? "grid2" : ""}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-label={o.label}
            aria-pressed={active}
            onClick={() => onChange(active && clearable ? null : o.value)}
            className={`status ${active ? "on" : "idle"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
