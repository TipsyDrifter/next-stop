/**
 * TimePicker／MobileTimePicker——時間選擇器的兩個殼（庚 D-主-391；錶盤是 `TimeDial`，觸發與值的規則在 `ClockInput`）。
 * 一般不直接用：**用 `ClockInput` 就有點選**（`picker` 預設開著）。視覺規範 §2.5「時間」。
 *
 * - `TimePicker`（桌機）：掛 body 的錨定浮層，同 DatePicker 的 anchor 模式。點了即時生效；焦點留在時刻框（滑鼠點開時），Alt+↓ 開才移進錶盤。
 *   浮層蓋得住時刻框下面的說明行，所以頭上自己寫一次值與「＝隔天」。
 * - `MobileTimePicker`（手機）：`MSheet` 底部面板；值在「完成」才送出，取消、暗幕、返回鍵都不動原值（同 sheet 的語意）。
 *   上方可打字的框由呼叫端傳進來（`input`；ClockInput 畫，免得兩支互相 import）。鍵盤不自己跳，要打字才點它。
 * - 「現在」：按下那一刻的時鐘取整到分；不在範圍就反灰、title 寫為什麼。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MIN } from "../../domain/timetable";
import type { ClockInputBounds } from "../../domain/timetableClockInput";
import { clockInputErrText, clockInputPreview } from "../../domain/timetableClockInput";
import { placeBelow, tabStops, useOutsideDismiss } from "./anchorPop";
import { MSheet } from "./MSheet";
import { TimeDial } from "./TimeDial";
import "./timepicker.css";

/** 「現在」鈕的值與不能按的原因 */
function nowCell(b: ClockInputBounds): { ms: number; why: string | null } {
  const ms = Math.floor(Date.now() / MIN) * MIN;
  if (ms < b.lo) return { ms, why: clockInputErrText({ err: "range", side: "early" }, b.lo, b.hi) };
  if (ms > b.hi) return { ms, why: clockInputErrText({ err: "range", side: "late" }, b.lo, b.hi) };
  return { ms, why: null };
}

export function NowChip({ bounds, onPick }: { bounds: ClockInputBounds; onPick(ms: number): void }) {
  const { why } = nowCell(bounds);
  return (
    <button
      type="button"
      className="chip ns-chip ns-timepick-now"
      data-tt-drop-draft=""
      disabled={why !== null}
      title={why ?? undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const c = nowCell(bounds);
        if (c.why === null) onPick(c.ms);
      }}
    >
      現在
    </button>
  );
}

export interface TimePickerProps {
  /** 小標（也是 dialog 的 aria-label） */
  label: string;
  bounds: ClockInputBounds;
  /** 日期標籤的參考日（寫不寫「＝隔天」） */
  refDay: string;
  anchor: HTMLElement;
  onPick(ms: number): void;
  /** 收起、值留著（點外面、完成） */
  onClose(): void;
  /** 還原開之前的值再收（Esc） */
  onCancel(): void;
  /** 開的時候把焦點移進錶盤（鍵盤 Alt+↓）；滑鼠點開時焦點留在時刻框 */
  takeFocus: boolean;
}

export function TimePicker({ label, bounds, refDay, anchor, onPick, onClose, onCancel, takeFocus }: TimePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(rootRef, onClose, anchor);

  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const at = placeBelow(anchor, el);
    setPos((p) => at ?? p ?? { top: 12, left: 12 });
  }, [anchor]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);

  useEffect(() => {
    if (!takeFocus || !pos) return;
    rootRef.current?.querySelector<HTMLElement>(".ns-dial")?.focus({ preventScroll: true });
    // 只在開的那一下；pos 第一次有值才拿得到焦點（hidden 時 focus 無效）
  }, [takeFocus, pos !== null]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // 卡掛在 body，按鍵照 React 樹冒泡會落到開它的面板上：一律擋下；Ctrl／⌘ 組合鍵放行給全域表（同 DatePicker）
    if (e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && e.target instanceof Element && e.target.classList.contains("ns-dial")) {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      const stops = tabStops(rootRef.current);
      if (stops.length < 1) return;
      const k = stops.indexOf(document.activeElement as HTMLElement);
      const j = e.shiftKey ? (k <= 0 ? stops.length - 1 : k - 1) : k >= stops.length - 1 ? 0 : k + 1;
      e.preventDefault();
      stops[j]?.focus();
    }
  };

  const [pre, hm] = clockInputPreview(bounds.value, refDay);
  const card = (
    <div
      ref={rootRef}
      className="ns-timepick"
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? undefined : "hidden" }}
    >
      <div className="ns-timepick-head">
        <span className="ns-timepick-label">{label}</span>
        <span className="ns-timepick-read">
          {hm}
          {pre !== "→ " && <small>{pre.trim()}</small>}
        </span>
        <NowChip bounds={bounds} onPick={onPick} />
      </div>
      <TimeDial bounds={bounds} refDay={refDay} now={Date.now()} onPick={onPick} variant="desk" label={label} />
      <div className="ns-timepick-foot">
        <button type="button" className="ns-timepick-done" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
  return createPortal(card, document.body);
}

export interface MobileTimePickerProps {
  label: string;
  bounds: ClockInputBounds;
  refDay: string;
  /** sheet 上方可打字的框（ClockInput 畫好傳進來） */
  input: ReactNode;
  onPick(ms: number): void;
  /** 完成：框裡有沒打完的字先套用，打錯就不收 */
  onDone(): void;
  onCancel(): void;
}

export function MobileTimePicker({ label, bounds, refDay, input, onPick, onDone, onCancel }: MobileTimePickerProps) {
  // 每個實例各自一層；"dialog"＝可疊在全螢幕頁與別的 sheet 之上（同 DateChip）
  const layerId = "common.timepicker." + useId();
  return (
    <MSheet
      title={label}
      backId={layerId}
      backKind="dialog"
      onClose={onCancel}
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" onClick={onDone}>
            完成
          </button>
        </>
      }
    >
      <div className="ns-mtimepick">
        <div className="ns-mtimepick-top">
          {input}
          <NowChip bounds={bounds} onPick={onPick} />
        </div>
        <TimeDial bounds={bounds} refDay={refDay} now={Date.now()} onPick={onPick} variant="mobile" label={label} />
      </div>
    </MSheet>
  );
}
