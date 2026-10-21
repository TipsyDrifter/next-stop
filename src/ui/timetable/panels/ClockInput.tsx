/**
 * ClockInput——時刻表面板的可打字時刻框（磨光⑥ 契約 §1-1、§1-5½；D-時-142、143、144）。
 * Stepper（controls.tsx）內部用：兩側的微調鈕由 Stepper 從 `left`／`right` 塞進來，這裡畫
 *   span.ns-tt-timecol
 *     span.ns-tt-stepper.is-a（left｜span.ns-tt-tinwrap > input.ns-tt-val.ns-tt-tin｜right）
 *     span.ns-tt-thint（說明行：疊在 stepper 底下、置中；aria-live）
 *
 * 行為（長相＝原型 `prototypes/時刻表-補記選時間.html` 的 TimeField A 排法；不搬原型程式）：
 * - 外觀 HH:MM（fmtClock）；`inputMode="numeric"`；聚焦＝全選（擋掉點進來那一下 mouseup 取消全選）。不用 <input type="time">。
 * - 解析／換成毫秒一律 `domain/timetableClockInput.ts` resolveClockInput（內部用 lib/date parseClockInput）。
 * - 打字中：看得懂才預覽「→ 08:30」／「＝隔天 01:00」，看不懂先不報錯；Enter／失焦才判錯。
 * - 確定：Enter（成功後叫 onEnter，例：発車跳到着）、失焦。打錯：還原、抖一下（reduced-motion 不抖）、說明行寫錯在哪；
 *   失焦時打錯寫「已還原・…」，4 秒後收掉（焦點留在框裡時留到下一次輸入；之後離開框、或被送出鈕放回框裡，再算 4 秒）。
 * - 打錯（Enter 或失焦都算）記成「還沒看過」，直到再打字、焦點回到框裡、Enter 確認或值被換掉。送出鈕的 `clockDraftsOk`
 *   只擋這種：Enter 打錯後眼睛多半已移到分類格，直接按補上不能默默送出舊值。說明行已收掉時，被放回框裡會再顯示一次。
 * - Esc：草稿有改 ⇒ 還原、stopPropagation（DialogShell／MobileSheetHost 的 Esc 都掛在 window 冒泡階段，React 的
 *   stopPropagation 擋得住，同 ui/panel/TimeField）；沒改 ⇒ 不攔，照舊關面板。
 * - ↑／↓ ＝ ±1 分（從草稿看得懂的值起算）；IME 組字中（isComposing／229）一律不處理。
 * - 外面的值變了（步進鈕、貼齊、同步）：框裡沒有草稿就跟著換；有草稿（打到一半）不洗掉。
 * - 失焦去「丟草稿」的鈕（貼齊 chip，帶 `data-tt-drop-draft`）⇒ 草稿直接丟、照鈕的語義做（D-時-144）；
 *   其餘（補上／改好了、分類格、面板空白處…）⇒ 先套用草稿。送出鈕再用 `clockDraftsOk` 檢查有沒有剛打錯、還沒看過的框。
 * - 手機：聚焦後把框捲進可見區（軟鍵盤升起時 visualViewport 變矮，兩邊都捲；同 notes/mobile/MobileDiaryEntry）。
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { MIN, fmtClock } from "../../../domain/timetable";
import { clockInputErrText, clockInputPreview, clockInputRefDay, resolveClockInput } from "../../../domain/timetableClockInput";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { useShell } from "../../mobile/useShell";

export interface ClockInputHandle {
  /** 框裡有沒打完的草稿 */
  dirty(): boolean;
  /** 套用草稿：成功回新值（沒草稿＝目前值）；打錯 ⇒ 還原＋抖＋說明，回 null */
  flush(): number | null;
  focus(): void;
  /** 打錯過幾次（Stepper 用來判斷「這一下點按之間失焦打錯了」：手指點鈕時失焦早於 click） */
  fails(): number;
}

type Hint = { kind: "ok"; pre: string; hm: string } | { kind: "err"; text: string } | null;

/** 失焦時打錯的說明留多久 */
const STICKY_MS = 4000;

export function ClockInput({
  value,
  lo,
  hi,
  onChange,
  label,
  onEnter,
  autoFocus = false,
  enterKeyHint = "done",
  left,
  right,
  handleRef,
}: {
  value: number;
  lo: number;
  hi: number;
  onChange(next: number): void;
  label: string;
  onEnter?(): void;
  autoFocus?: boolean;
  enterKeyHint?: "done" | "next";
  left?: ReactNode;
  right?: ReactNode;
  handleRef?: Ref<ClockInputHandle>;
}) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const viewDay = useTimetableStore((s) => s.dayKey);
  const mobile = useShell() === "mobile";
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setTextState] = useState(() => fmtClock(value));
  const [hint, setHint] = useState<Hint>(null);
  const [invalid, setInvalid] = useState(false);
  /** 打錯、還沒回來看過（送出鈕的 clockDraftsOk 只擋這種；評審 #1：Enter 打錯也算） */
  const [unseen, setUnseen] = useState(false);
  /** 上一次打錯的說明（說明行收掉後被送出鈕放回框裡時再顯示） */
  const lastErr = useRef("");
  const [shake, setShake] = useState(0);

  // 事件處理裡一律讀最新值（長按連跳、blur 都可能比重畫早）
  const textRef = useRef(text);
  const shownRef = useRef(value); // 框裡乾淨的字代表的值
  const live = useRef({ value, lo, hi, onChange, onEnter, dayStartHour });
  live.current = { value, lo, hi, onChange, onEnter, dayStartHour };
  const focused = useRef(false);
  const justFocused = useRef(false);
  /** 這一次失焦不用再處理（步進鈕在 pointerdown 已經 flush 過） */
  const settled = useRef(false);
  /** 失焦前按下的是不是「丟草稿」的鈕（pointerdown 一定早於失焦；有的引擎點按鈕不給焦點，只看 relatedTarget 不夠） */
  const pressedDrop = useRef(false);
  const stickyTimer = useRef(0);
  const failCount = useRef(0);

  const setText = (s: string): void => {
    textRef.current = s;
    setTextState(s);
  };
  const isDirty = (): boolean => textRef.current !== fmtClock(shownRef.current);
  const show = (v: number): void => {
    shownRef.current = v;
    setText(fmtClock(v));
  };
  /** 下一次畫完（框裡換成新字之後）把字全選，方便接著打或接著按 ↑↓ */
  const wantSelect = useRef(false);
  const [selectTick, setSelectTick] = useState(0);
  const selectAll = (): void => {
    wantSelect.current = true;
    setSelectTick((n) => n + 1);
  };
  useLayoutEffect(() => {
    if (!wantSelect.current) return;
    wantSelect.current = false;
    const el = inputRef.current;
    if (el && document.activeElement === el) el.select();
  }, [selectTick, text]);
  const resolve = (raw: string) => {
    const L = live.current;
    // 基準日跟說明行同一支（真機代驗 D1：到着停在日界線那一刻時，dayKeyOf 會算成下一天）
    return resolveClockInput(raw, { value: L.value, lo: L.lo, hi: L.hi, dayStartHour: L.dayStartHour, baseDay: clockInputRefDay(L.value, viewDay, L.dayStartHour) });
  };

  /** 錯字說明 STICKY_MS 後收掉（只收畫面；「還沒看過」留著，送出鈕照樣擋） */
  const collapseLater = (): void => {
    clearTimeout(stickyTimer.current);
    stickyTimer.current = window.setTimeout(() => {
      setHint((h) => (h?.kind === "err" ? null : h));
      setInvalid(false);
    }, STICKY_MS);
  };
  /** 打錯的狀態整個作廢（又動過這一格了） */
  const clearErr = (): void => {
    clearTimeout(stickyTimer.current);
    setHint((h) => (h?.kind === "err" ? null : h));
    setInvalid(false);
    setUnseen(false);
  };

  // 外面的值變了：沒草稿就跟著換；先前打錯的說明作廢（步進鈕、貼齊都算動過這一格）
  const mounted = useRef(false);
  useEffect(() => {
    if (!isDirty()) show(value); // 有草稿：留著，確定時再跟最新的值比
    if (mounted.current) clearErr();
    mounted.current = true;
  }, [value]);

  useEffect(() => () => clearTimeout(stickyTimer.current), []);

  useEffect(() => {
    const down = (e: PointerEvent): void => {
      const t = e.target instanceof Element ? e.target : null;
      pressedDrop.current = t?.closest("[data-tt-drop-draft]") != null;
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus(); // 面板內捲時捲到看得見（scroll-margin 讓開底部黏住的按鈕列，timetable.css）
    el.select();
  }, [autoFocus]);

  // 手機：軟鍵盤升起時把框捲進可見區
  const reveal = (): void => {
    if (!mobile) return;
    const vv = window.visualViewport;
    const go = (): void => {
      window.setTimeout(() => inputRef.current?.scrollIntoView({ block: "nearest" }), 60);
    };
    go();
    if (vv) {
      vv.addEventListener("resize", go);
      inputRef.current?.addEventListener("blur", () => vv.removeEventListener("resize", go), { once: true });
    }
  };

  const fail = (r: Exclude<ReturnType<typeof resolve>, { ms: number }>, leaving: boolean): void => {
    const L = live.current;
    failCount.current++;
    show(L.value);
    const why = clockInputErrText(r, L.lo, L.hi);
    lastErr.current = "已還原・" + why;
    setHint({ kind: "err", text: leaving ? lastErr.current : why });
    setInvalid(true);
    setUnseen(true); // Enter 打錯也算：人在框裡，眼睛不一定在
    setShake((n) => n + 1);
    clearTimeout(stickyTimer.current);
    if (leaving) collapseLater();
    else selectAll();
  };

  /** 確定；成功回新值（沒草稿＝目前值），打錯回 null */
  const commit = (leaving: boolean): number | null => {
    const L = live.current;
    const raw = textRef.current;
    if (!isDirty()) return L.value;
    if (raw.trim() === "") {
      show(L.value);
      setHint(null);
      return L.value;
    }
    const r = resolve(raw);
    if ("ms" in r) {
      show(r.ms);
      setHint(null);
      setInvalid(false);
      if (r.ms !== L.value) {
        live.current = { ...L, value: r.ms };
        L.onChange(r.ms);
      }
      return r.ms;
    }
    fail(r, leaving);
    return null;
  };

  useImperativeHandle(handleRef, () => ({
    dirty: isDirty,
    flush: () => {
      if (!isDirty()) return live.current.value;
      // 焦點正要離開框（按的是步進鈕）：接下來那次失焦不再處理
      if (focused.current) settled.current = true;
      return commit(true);
    },
    focus: () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    },
    fails: () => failCount.current,
  }));

  return (
    <span className="ns-tt-timecol">
      <span className="ns-tt-stepper is-a" role="group" aria-label={label}>
        {left}
        <span className={"ns-tt-tinwrap" + (shake ? " is-shake" : "") + (invalid ? " is-bad" : "")} onAnimationEnd={() => setShake(0)}>
          <input
            ref={inputRef}
            className="ns-tt-val ns-tt-tin"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
            enterKeyHint={enterKeyHint}
            aria-label={label}
            aria-invalid={invalid}
            data-tt-unseen={unseen ? "" : undefined}
            value={text}
            onChange={(e) => {
              justFocused.current = false;
              settled.current = false; // 按步進鈕時焦點沒離開框（有的引擎點按鈕不給焦點）：又打字了，下一次失焦照常處理
              setText(e.target.value);
              setInvalid(false);
              setUnseen(false);
              clearTimeout(stickyTimer.current);
              const raw = e.target.value;
              if (raw.trim() === "") return setHint(null);
              const r = resolve(raw);
              if ("ms" in r) {
                const [pre, hm] = clockInputPreview(r.ms, clockInputRefDay(live.current.value, viewDay, live.current.dayStartHour));
                setHint({ kind: "ok", pre, hm });
              } else setHint(null); // 打到一半不報錯
            }}
            onFocus={(e) => {
              focused.current = true;
              justFocused.current = true;
              settled.current = false;
              pressedDrop.current = false;
              if (unseen) {
                // 回到框裡看過了：送出鈕不再擋。說明行已收掉（例：送出鈕隔了幾秒才把焦點放回來）就再顯示一次；4 秒後收
                setUnseen(false);
                if (hint?.kind !== "err") {
                  setHint({ kind: "err", text: lastErr.current });
                  setInvalid(true);
                }
                collapseLater();
              }
              e.currentTarget.select();
              reveal();
            }}
            onMouseUp={(e) => {
              // 點進來那一下：mouseup 會把全選取消，擋掉
              if (justFocused.current) {
                e.preventDefault();
                justFocused.current = false;
              }
            }}
            onBlur={(e) => {
              focused.current = false;
              justFocused.current = false;
              if (settled.current) {
                settled.current = false;
                return;
              }
              const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
              const drop = pressedDrop.current || to?.closest("[data-tt-drop-draft]") != null;
              pressedDrop.current = false;
              if (drop) {
                show(live.current.value);
                setHint(null);
                return;
              }
              if (isDirty()) commit(true);
              else if (hint?.kind === "ok") setHint(null);
              else if (hint?.kind === "err") collapseLater(); // Enter 打錯後離開、或看過再離開：4 秒後收（評審 #6）
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                const v = commit(false);
                if (v === null) return;
                clearErr(); // 還原後再按一次 Enter＝確認目前值，也算看過
                selectAll(); // 確定後全選：留在這格接著打＝整格換掉，不會接在舊字後面（真機代驗觀察）；焦點跳走的話無作用
                live.current.onEnter?.();
              } else if (e.key === "Escape") {
                if (!isDirty()) return; // 沒草稿：照舊關面板
                e.preventDefault();
                e.stopPropagation();
                show(live.current.value);
                setHint(null);
                setInvalid(false);
                selectAll();
              } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                const L = live.current;
                let base = L.value;
                if (isDirty()) {
                  const r = resolve(textRef.current);
                  if ("ms" in r) base = r.ms;
                }
                const nv = Math.max(L.lo, Math.min(base + (e.key === "ArrowUp" ? MIN : -MIN), L.hi));
                show(nv);
                setHint(null);
                setInvalid(false);
                setUnseen(false);
                if (nv !== L.value) {
                  live.current = { ...L, value: nv };
                  L.onChange(nv);
                }
                selectAll();
              }
            }}
          />
        </span>
        {right}
      </span>
      <span className={"ns-tt-thint" + (hint ? " is-" + hint.kind : "")} aria-live="polite">
        {hint?.kind === "ok" ? (
          <>
            {hint.pre}
            <b className="ns-tt-num">{hint.hm}</b>
          </>
        ) : hint?.kind === "err" ? (
          hint.text
        ) : null}
      </span>
    </span>
  );
}
