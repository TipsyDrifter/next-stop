/**
 * TimeDial——時間選擇器的站鐘錶盤（庚 D-主-420；v1.32 2A-1 互動數位標頭升級）。
 * 桌機浮層、手機 sheet、攤開在面板裡（`ClockInput picker="inline"`）都是這一支，`variant` 只換大小。
 *
 *   頂部互動標頭（`.ns-dial-head`）：`[HH] : [MM]`（＋跨天提示如 `隔天`／`前一天` 赭字）
 *     - 點 `[HH]` 切撥時（`mode = "h"`）、點 `[MM]` 切撥分（`mode = "m"`）；作用中的那一半帶強調底線與淡底。
 *     - 再點一下作用中的半邊、或焦點在標頭／錶盤直接敲數字鍵 `0–9`，即可直接打字輸入時刻（如 `1430`、`9:30`、`2500`、`25:00`），
 *       統一走 `resolveClockInput(raw, bounds)` 驗證與換算毫秒：合法即 `onPick(ms)` 更新指針、按 `Enter` 收起；
 *       不合法則還原並短暫微震＋顯示範圍提示；按 `Escape` 取消草稿（`stopPropagation` 不誤關外層彈窗）。
 *   錶盤：
 *     - 時：外圈 1–12、內圈 00、13–23。實際落在別天的赭字＋title 寫哪一天；現在那個小時細圈。
 *     - 分：一圈 00、05…55，外緣 60 道刻度。指針與圓頭指著目前的值。
 *     - 滑鼠點錶盤或跨半邊切換時保留 `mousedown preventDefault`，不搶外部 `ClockInput` 焦點。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  DIAL_INNER_R,
  DIAL_OUTER_R,
  dialAngle,
  dialHourAt,
  dialHourSlot,
  dialMinuteAt,
  dialPoint,
  dialStepHour,
  dialStepMinute,
  hourEnabled,
  minuteNearest,
  otherDayNote,
  timeCellMs,
  wallParts,
} from "../../domain/timePick";
import {
  clockInputErrText,
  resolveClockInput,
  type ClockInputBounds,
} from "../../domain/timetableClockInput";
import "./timepicker.css";

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;
const keepFocus = (e: MouseEvent): void => e.preventDefault();
const isDigitStart = (key: string): boolean => /^[0-9\uff10-\uff19]$/.test(key);
const isCompleteClockToken = (raw: string): boolean => {
  const s = raw.trim();
  return (
    /^[0-9\uff10-\uff19]{4}$/.test(s) ||
    /^[0-9\uff10-\uff19]{1,2}[:\uff1a.\uff0e][0-9\uff10-\uff19]{2}$/.test(s)
  );
};

type DialMode = "h" | "m";
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_LABELS = Array.from({ length: 12 }, (_, i) => i * 5);
const TICKS = Array.from({ length: 60 }, (_, i) => i);
/** 圓頭半徑（viewBox 100） */
const KNOB_R = 6.2;
/** 動超過這麼多才算拖（px） */
const DRAG_PX = 4;
const ERR_STICKY_MS = 2800;

export interface TimeDialProps {
  /** 目前值、範圍、日界線、基準日（同 resolveClockInput） */
  bounds: ClockInputBounds;
  /** 參考日（營業日 key）：跟它不同天的小時畫赭字 */
  refDay: string;
  /** 現在（毫秒）：細圈畫在哪個小時 */
  now: number;
  onPick(ms: number): void;
  variant: "desk" | "mobile";
  /** 讀屏用的名稱（欄位名，例「開始時刻」） */
  label: string;
  /** 標頭輸入按 Enter 確定後的收起回呼（選填，如桌機 TimePicker 浮層） */
  onCommitClose?(): void;
}

function hasExternalEditableFocus(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && !a.readOnly && !a.classList.contains("ns-dial-in");
}

export function TimeDial({ bounds, refDay, now, onPick, variant, label, onCommitClose }: TimeDialProps) {
  const [mode, setMode] = useState<DialMode>("h");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [errText, setErrText] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  const { h: curH, m: curM } = wallParts(bounds.value);
  const nowH = wallParts(now).h;
  const dialRef = useRef<HTMLDivElement>(null);
  const hourBtnRef = useRef<HTMLButtonElement>(null);
  const minBtnRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const selectModeRef = useRef<"all" | "end" | null>(null);
  const editOriginRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const skipBlurRef = useRef(false);
  const errTimer = useRef<number>(0);
  /** 這一次按壓：動過了沒、點到過能選的小時沒（有 ⇒ 放開切到分） */
  const press = useRef<{ id: number; x: number; y: number; moved: boolean; hit: boolean } | null>(null);

  useEffect(() => () => clearTimeout(errTimer.current), []);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (selectModeRef.current === "all") {
      el.select();
    } else if (selectModeRef.current === "end") {
      el.setSelectionRange(el.value.length, el.value.length);
    }
    selectModeRef.current = null;
  }, [editing]);

  const showErr = (msg: string): void => {
    clearTimeout(errTimer.current);
    setErrText(msg);
    setShake((n) => n + 1);
    errTimer.current = window.setTimeout(() => {
      setErrText(null);
    }, ERR_STICKY_MS);
  };

  const clearErr = (): void => {
    clearTimeout(errTimer.current);
    setErrText(null);
  };

  const openEdit = (seed: string, selectAll: boolean): void => {
    clearErr();
    skipBlurRef.current = false;
    composingRef.current = false;
    editOriginRef.current = bounds.value;
    setDraft(seed);
    selectModeRef.current = selectAll ? "all" : "end";
    setEditing(true);
  };

  const hourNote = (h: number): string | null => {
    const ms = minuteNearest(h, curM, bounds);
    return ms === null ? null : otherDayNote(ms, refDay);
  };

  /** 指標落在錶面哪裡 → 改值。snap＝點一下（分鐘落到 5 分一格） */
  const applyAt = (e: PointerEvent<HTMLDivElement>, snap: boolean): void => {
    const el = dialRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = e.clientY - rect.top - rect.height / 2;
    const angle = dialAngle(dx, dy);
    const r = Math.hypot(dx, dy) / rect.width;
    if (mode === "h") {
      const h = dialHourAt(angle, r);
      const ms = h === null ? null : minuteNearest(h, curM, bounds);
      if (ms === null) return;
      if (press.current) press.current.hit = true;
      if (ms !== bounds.value) onPick(ms);
    } else {
      const m = dialMinuteAt(angle, r, snap);
      const ms = m === null ? null : minuteNearest(curH, m, bounds);
      if (ms !== null && ms !== bounds.value) onPick(ms);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    if (editing) {
      skipBlurRef.current = true;
      editOriginRef.current = null;
      composingRef.current = false;
      setEditing(false);
    }
    clearErr();
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, hit: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
    p.moved = true;
    applyAt(e, false);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved) applyAt(e, true);
    if (mode === "h" && p.hit) setMode("m");
    press.current = null;
  };

  const onDialKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current || e.altKey || e.ctrlKey || e.metaKey) return;
    if (isDigitStart(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      openEdit(e.key, false);
      return;
    }
    let ms: number | null = null;
    if (e.key === "Enter") {
      if (mode !== "h") return; // 分：往上冒（桌機浮層＝收起）
      setMode("m");
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowDown") {
      const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1;
      if (mode === "m") ms = dialStepMinute(curH, curM, dir, bounds);
      else {
        const h = dialStepHour(curH, dir, bounds);
        ms = h === null ? null : minuteNearest(h, curM, bounds);
      }
    } else if ((e.key === "PageUp" || e.key === "PageDown") && mode === "m") {
      ms = dialStepMinute(curH, curM, e.key === "PageUp" ? 5 : -5, bounds);
    } else return;
    e.preventDefault();
    e.stopPropagation();
    clearErr();
    if (ms !== null && ms !== bounds.value) onPick(ms);
  };

  const onSegKeyDown = (seg: DialMode) => (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current || e.altKey || e.ctrlKey || e.metaKey) return;
    if (isDigitStart(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      openEdit(e.key, false);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      const next: DialMode = seg === "h" ? "m" : "h";
      setMode(next);
      (next === "h" ? hourBtnRef.current : minBtnRef.current)?.focus({ preventScroll: true });
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === "ArrowUp" ? 1 : -1;
      let ms: number | null = null;
      if (seg === "m") {
        setMode("m");
        ms = dialStepMinute(curH, curM, dir, bounds);
      } else {
        setMode("h");
        const h = dialStepHour(curH, dir, bounds);
        ms = h === null ? null : minuteNearest(h, curM, bounds);
      }
      clearErr();
      if (ms !== null && ms !== bounds.value) onPick(ms);
    }
  };

  const onEditChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value;
    setDraft(next);
    clearErr();
    const isIme = composingRef.current || ("isComposing" in e.nativeEvent && Boolean(e.nativeEvent.isComposing));
    if (isIme) return;
    if (isCompleteClockToken(next)) {
      const base = editOriginRef.current !== null ? { ...bounds, value: editOriginRef.current } : bounds;
      const r = resolveClockInput(next, base);
      if ("ms" in r && r.ms !== bounds.value) {
        onPick(r.ms);
      }
    }
  };

  const onEditKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurRef.current = true;
      const origin = editOriginRef.current;
      editOriginRef.current = null;
      clearErr();
      if (origin !== null && origin !== bounds.value) onPick(origin);
      setEditing(false);
      setDraft("");
      dialRef.current?.focus({ preventScroll: true });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const raw = draft.trim();
      const origin = editOriginRef.current;
      if (raw === "") {
        skipBlurRef.current = true;
        editOriginRef.current = null;
        clearErr();
        if (origin !== null && origin !== bounds.value) onPick(origin);
        setEditing(false);
        dialRef.current?.focus({ preventScroll: true });
        return;
      }
      const base = origin !== null ? { ...bounds, value: origin } : bounds;
      const r = resolveClockInput(raw, base);
      if ("ms" in r) {
        skipBlurRef.current = true;
        editOriginRef.current = null;
        clearErr();
        if (r.ms !== bounds.value) onPick(r.ms);
        setEditing(false);
        if (onCommitClose) onCommitClose();
        else dialRef.current?.focus({ preventScroll: true });
      } else {
        const restoreMs = origin ?? bounds.value;
        if (origin !== null && origin !== bounds.value) onPick(origin);
        const wp = wallParts(restoreMs);
        setDraft(`${pad2(wp.h)}:${pad2(wp.m)}`);
        showErr(clockInputErrText(r, bounds.lo, bounds.hi));
        requestAnimationFrame(() => editRef.current?.select());
      }
    }
  };

  const onEditBlur = (): void => {
    composingRef.current = false;
    if (skipBlurRef.current) {
      skipBlurRef.current = false;
      return;
    }
    const origin = editOriginRef.current;
    editOriginRef.current = null;
    const raw = draft.trim();
    if (raw === "") {
      if (origin !== null && origin !== bounds.value) onPick(origin);
      setEditing(false);
      return;
    }
    const curText = `${pad2(curH)}:${pad2(curM)}`;
    if (raw === curText) {
      setEditing(false);
      return;
    }
    const base = origin !== null ? { ...bounds, value: origin } : bounds;
    const r = resolveClockInput(raw, base);
    if ("ms" in r) {
      clearErr();
      if (r.ms !== bounds.value) onPick(r.ms);
      setEditing(false);
    } else {
      if (origin !== null && origin !== bounds.value) onPick(origin);
      setEditing(false);
      showErr(clockInputErrText(r, bounds.lo, bounds.hi));
    }
  };

  // 指針：時＝指到那個數字；分＝一圈 60 格，落在兩個數字中間也照實指
  const curSlot = dialHourSlot(curH);
  const tipSlot = mode === "h" ? curSlot.slot : curM;
  const tipSlots = mode === "h" ? 12 : 60;
  const tipR = mode === "h" && curSlot.inner ? DIAL_INNER_R : DIAL_OUTER_R;
  const tip = dialPoint(tipSlot, tipSlots, tipR);
  // 指針停在圓頭邊上，不從選中的數字上劃過
  const handEnd = dialPoint(tipSlot, tipSlots, tipR - KNOB_R / 100);
  const curNote = otherDayNote(bounds.value, refDay);
  // 時、指外圈：指針穿過內圈那格，在那裡斷開一段，不從數字上劃過
  const gap = mode === "h" && !curSlot.inner;
  const gapIn = dialPoint(curSlot.slot, 12, DIAL_INNER_R - 0.05);
  const gapOut = dialPoint(curSlot.slot, 12, DIAL_INNER_R + 0.05);

  return (
    <div className={"ns-dial-wrap is-" + variant}>
      <div
        className={"ns-dial-head" + (shake ? " is-shake" : "") + (errText ? " is-bad" : "")}
        onAnimationEnd={() => setShake(0)}
      >
        {editing ? (
          <input
            ref={editRef}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
            className="techo-input ns-dial-in"
            value={draft}
            placeholder={`${pad2(curH)}:${pad2(curM)}`}
            aria-label={`${label}・直接輸入時刻`}
            aria-invalid={errText !== null}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              const next = e.currentTarget.value;
              setDraft(next);
              if (isCompleteClockToken(next)) {
                const base = editOriginRef.current !== null ? { ...bounds, value: editOriginRef.current } : bounds;
                const r = resolveClockInput(next, base);
                if ("ms" in r && r.ms !== bounds.value) {
                  onPick(r.ms);
                }
              }
            }}
            onChange={onEditChange}
            onKeyDown={onEditKeyDown}
            onBlur={onEditBlur}
          />
        ) : (
          <>
            <button
              ref={hourBtnRef}
              type="button"
              className={"ns-dial-seg" + (mode === "h" ? " is-on" : "")}
              aria-label={`${label}・時（目前 ${pad2(curH)} 時，點選切換撥時或再點輸入）`}
              aria-pressed={mode === "h"}
              data-tt-drop-draft=""
              onMouseDown={(e) => {
                if (mode !== "h" && hasExternalEditableFocus()) e.preventDefault();
              }}
              onClick={() => {
                if (mode === "h") openEdit(`${pad2(curH)}:${pad2(curM)}`, true);
                else {
                  setMode("h");
                  clearErr();
                }
              }}
              onKeyDown={onSegKeyDown("h")}
            >
              {pad2(curH)}
            </button>
            <span className="ns-dial-sep" aria-hidden="true">
              :
            </span>
            <button
              ref={minBtnRef}
              type="button"
              className={"ns-dial-seg" + (mode === "m" ? " is-on" : "")}
              aria-label={`${label}・分（目前 ${pad2(curM)} 分，點選切換撥分或再點輸入）`}
              aria-pressed={mode === "m"}
              data-tt-drop-draft=""
              onMouseDown={(e) => {
                if (mode !== "m" && hasExternalEditableFocus()) e.preventDefault();
              }}
              onClick={() => {
                if (mode === "m") openEdit(`${pad2(curH)}:${pad2(curM)}`, true);
                else {
                  setMode("m");
                  clearErr();
                }
              }}
              onKeyDown={onSegKeyDown("m")}
            >
              {pad2(curM)}
            </button>
          </>
        )}
        {curNote && <span className="ns-dial-daytag">{curNote}</span>}
      </div>
      {errText && (
        <div className="ns-dial-err" role="status" aria-live="polite">
          {errText}
        </div>
      )}
      <div
        ref={dialRef}
        className={"ns-dial is-" + mode}
        role="slider"
        tabIndex={0}
        aria-label={`${label}・${mode === "h" ? "時" : "分"}`}
        aria-valuemin={0}
        aria-valuemax={mode === "h" ? 23 : 59}
        aria-valuenow={mode === "h" ? curH : curM}
        aria-valuetext={mode === "h" ? `${curNote ? curNote + " " : ""}${curH} 時` : `${curM} 分`}
        data-tt-drop-draft=""
        onMouseDown={keepFocus}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
        }}
        onKeyDown={onDialKeyDown}
      >
        <svg className="ns-dial-face" viewBox="0 0 100 100" aria-hidden="true">
          <circle className="ring" cx="50" cy="50" r="49.4" />
          {mode === "m" &&
            TICKS.map((t) => {
              const a = dialPoint(t, 60, 0.494);
              const b = dialPoint(t, 60, t % 5 === 0 ? 0.47 : 0.48);
              return <line key={t} className="tick" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            })}
          {gap ? (
            <>
              <line className="hand" x1="50" y1="50" x2={gapIn.x} y2={gapIn.y} />
              <line className="hand" x1={gapOut.x} y1={gapOut.y} x2={handEnd.x} y2={handEnd.y} />
            </>
          ) : (
            <line className="hand" x1="50" y1="50" x2={handEnd.x} y2={handEnd.y} />
          )}
          <circle className="knob" cx={tip.x} cy={tip.y} r={KNOB_R} />
          <circle className="hub" cx="50" cy="50" r="1.3" />
          {mode === "m" && curM % 5 !== 0 && <circle className="hub" cx={tip.x} cy={tip.y} r="1" />}
        </svg>
        {mode === "h"
          ? HOURS.map((h) => {
              const { slot, inner } = dialHourSlot(h);
              const at = dialPoint(slot, 12, inner ? DIAL_INNER_R : DIAL_OUTER_R);
              const ok = hourEnabled(h, bounds);
              const note = ok ? hourNote(h) : null;
              const cls =
                "ns-dial-n" +
                (inner ? " is-inner" : "") +
                (h === curH ? " is-sel" : "") +
                (h === nowH ? " is-now" : "") +
                (note ? " is-next" : "") +
                (ok ? "" : " is-off");
              return (
                <span key={h} className={cls} style={{ left: `${at.x}%`, top: `${at.y}%` }} title={note ?? undefined} aria-hidden="true">
                  {inner ? pad2(h) : h}
                </span>
              );
            })
          : MINUTE_LABELS.map((m) => {
              const at = dialPoint(m, 60, DIAL_OUTER_R);
              const cls = "ns-dial-n" + (m === curM ? " is-sel" : "") + (timeCellMs(curH, m, bounds) === null ? " is-off" : "");
              return (
                <span key={m} className={cls} style={{ left: `${at.x}%`, top: `${at.y}%` }} aria-hidden="true">
                  {pad2(m)}
                </span>
              );
            })}
      </div>
    </div>
  );
}
