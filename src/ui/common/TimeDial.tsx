/**
 * TimeDial——時間選擇器的站鐘錶盤（庚 D-主-420；比稿 `prototypes/庚-時間選擇器.html` C 案；使用者 11-05 定案）。
 * 桌機浮層、手機 sheet、攤開在面板裡（`ClockInput picker="inline"`）都是這一支，`variant` 只換大小。
 *
 *   時：外圈 1–12、內圈 00、13–23。實際落在別天的赭字＋title 寫哪一天（同時刻框跨天赭字）；現在那個小時細圈（同月格的今天）。
 *   分：一圈 00、05…55，外緣 60 道刻度。指針與圓頭指著目前的值。下方「時｜分」切換。
 *
 * 規則（純函式在 `domain/timePick.ts`，跟打字同一支 resolveClockInput）：
 * - 整個錶面都是點擊範圍，看角度與半徑（兩圈中間為界），不必點準數字。
 * - 點時：不能選的小時不動；目前的分鐘在那個小時不能選 ⇒ 換到最近可選的一分；放開後自動切到分（同原型）。
 * - 點分：點一下落到 5 分一格、拖動到 1 分；超出範圍停在最近可選的一分。
 * - 放開才算點（手指落下還沒動不改值，磨光⑥ 的教訓）；拖動中值跟著走。`touch-action: none`：在錶面上拖不會捲 sheet。
 * - 按下不搶焦點（mousedown preventDefault）：桌機焦點留在時刻框，照樣能接著打字。帶 `data-tt-drop-draft`：框裡打到一半的字以點的為準。
 *
 * ARIA 與鍵盤：錶面 `role="slider"`，一個 Tab stop；方向鍵 ±1（時跳過不能選的）、PageUp／PageDown ±5 分、
 * 時的 Enter＝切到分；分的 Enter 往上冒（桌機浮層＝收起）。數字是裝飾（aria-hidden），讀屏靠 aria-valuetext。
 * 樣式在 `./timepicker.css`。
 */
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
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
import type { ClockInputBounds } from "../../domain/timetableClockInput";
import { Segmented } from "./Segmented";
import "./timepicker.css";

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;
const keepFocus = (e: MouseEvent): void => e.preventDefault();

type DialMode = "h" | "m";
const MODE_OPTS = [
  { value: "h" as const, label: "時" },
  { value: "m" as const, label: "分" },
];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_LABELS = Array.from({ length: 12 }, (_, i) => i * 5);
const TICKS = Array.from({ length: 60 }, (_, i) => i);
/** 圓頭半徑（viewBox 100） */
const KNOB_R = 6.2;
/** 動超過這麼多才算拖（px） */
const DRAG_PX = 4;

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
}

export function TimeDial({ bounds, refDay, now, onPick, variant, label }: TimeDialProps) {
  const [mode, setMode] = useState<DialMode>("h");
  const { h: curH, m: curM } = wallParts(bounds.value);
  const nowH = wallParts(now).h;
  const dialRef = useRef<HTMLDivElement>(null);
  /** 這一次按壓：動過了沒、點到過能選的小時沒（有 ⇒ 放開切到分） */
  const press = useRef<{ id: number; x: number; y: number; moved: boolean; hit: boolean } | null>(null);

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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
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
    if (ms !== null && ms !== bounds.value) onPick(ms);
  };

  // 指針：時＝指到那個數字；分＝一圈 60 格，落在兩個數字中間也照實指
  const curSlot = dialHourSlot(curH);
  const tipSlot = mode === "h" ? curSlot.slot : curM;
  const tipSlots = mode === "h" ? 12 : 60;
  const tipR = mode === "h" && curSlot.inner ? DIAL_INNER_R : DIAL_OUTER_R;
  const tip = dialPoint(tipSlot, tipSlots, tipR);
  // 指針停在圓頭邊上，不從選中的數字上劃過
  const handEnd = dialPoint(tipSlot, tipSlots, tipR - KNOB_R / 100);
  const curNote = hourNote(curH);
  // 時、指外圈：指針穿過內圈那格，在那裡斷開一段，不從數字上劃過
  const gap = mode === "h" && !curSlot.inner;
  const gapIn = dialPoint(curSlot.slot, 12, DIAL_INNER_R - 0.05);
  const gapOut = dialPoint(curSlot.slot, 12, DIAL_INNER_R + 0.05);

  return (
    <div className={"ns-dial-wrap is-" + variant}>
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
        onKeyDown={onKeyDown}
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
      <div className="ns-dial-mode" onMouseDown={keepFocus}>
        <Segmented compact={variant === "desk"} options={MODE_OPTS} value={mode} onChange={setMode} aria-label={`${label}・選時或分`} />
      </div>
    </div>
  );
}
