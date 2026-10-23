/**
 * ClockInput——可打字的時刻框（全 App 一支；視覺規範 §2.5「時間」、丙-2 契約 §1 第 6 件）。
 * 丙-2 從 `ui/timetable/panels/ClockInput.tsx` 搬來（原檔改成 re-export，時刻表呼叫端不動）；行為來源：磨光⑥ 契約 §1-1、§1-5½；
 * D-時-142、143、144、147、148。
 *
 * 兩種長相，同一套行為：
 *   - `variant` 省略＝舊版 DOM（時刻表 Stepper 專用，丙-3 起改接新變體後移除）：
 *       span.ns-tt-timecol > span.ns-tt-stepper.is-a（left｜span.ns-tt-tinwrap > input.ns-tt-val.ns-tt-tin｜right）＋ span.ns-tt-thint
 *     兩側的微調鈕由 Stepper（timetable/panels/controls.tsx）從 `left`／`right` 塞進來；樣式在 timetable.css。
 *   - `variant="full"｜"compact"｜"mobile"`（新，樣式在 `./datefield.css` 的 `.ns-clock*`；長相＝prototypes/ui-brand「ClockInput」）：
 *       span.ns-clock.is-<variant>
 *         span.ns-clock-quick（relative＝現在／5 分前／10 分前）
 *         span.ns-clock-quick（quick＝常用時刻 chip；mobile 沒給就用 CLOCK_QUICK_DEFAULT）
 *         span.ns-clock-row（−1h −15 −5 −1｜span.ns-clock-inwrap > input.techo-input.ns-clock-in｜+1 +5 +15 +1h）
 *         span.ns-clock-foot（說明行：預覽／錯字／這個值的日期，跨天赭字＋前綴「＝隔天 10/23（五）」）
 *     微調鈕：full＝±1h ±15 ±5 ±1；compact 與 mobile＝只留 ±15。鈕是本元件自己畫（`.ns-btn.btn-ghost.ns-btn--sm.step`，長按加速同 Stepper）；
 *     呼叫端給了 `left`／`right` 就用呼叫端的。兩殼數值靠 `[data-shell="mobile"]` 的 token（--ctl-h-sm 24→36、--fs-sm…）整組換。
 *
 * 行為（長相＝原型 `prototypes/時刻表-補記選時間.html` 的 TimeField A 排法；不搬原型程式）：
 * - 外觀 HH:MM（fmtClock）；`inputMode="numeric"`；聚焦＝全選（擋掉點進來那一下 mouseup 取消全選）。不用 <input type="time">。
 * - 解析／換成毫秒一律 `domain/timetableClockInput.ts` resolveClockInput（內部用 lib/date parseClockInput：0830、8:30、2330、25:00、全形…）。
 * - 打字中：看得懂才預覽「→ 08:30」／「＝隔天 01:00」，看不懂先不報錯；Enter／失焦才判錯。
 * - 確定：Enter（成功後叫 onEnter，例：発車跳到着）、失焦。打錯：還原、抖一下（reduced-motion 不抖）、說明行寫錯在哪；
 *   失焦時打錯寫「已還原・…」，4 秒後收掉（焦點留在框裡時留到下一次輸入；之後離開框、或被送出鈕放回框裡，再算 4 秒）。
 * - 打錯（Enter 或失焦都算）記成「還沒看過」（`data-tt-unseen`），直到再打字、焦點回到框裡、Enter 確認或值被換掉。送出鈕的 `clockDraftsOk`
 *   只擋這種：Enter 打錯後眼睛多半已移到分類格，直接按補上不能默默送出舊值。說明行已收掉時，被放回框裡會再顯示一次。
 * - 外面的值變了（步進鈕、貼齊、同步）：框裡沒有草稿就跟著換；有草稿（打到一半）不洗掉。
 * - 失焦去「丟草稿」的鈕（帶 `data-tt-drop-draft`：時刻表貼齊 chip、本元件的常用／相對時刻 chip）⇒ 草稿直接丟、照鈕的語義做（D-時-144）；
 *   其餘（補上／改好了、分類格、面板空白處…）⇒ 先套用草稿。
 * - 手機：聚焦後把框捲進可見區（軟鍵盤升起時 visualViewport 變矮，兩邊都捲；同 notes/mobile/MobileDiaryEntry）。
 * - 磨光⑤ §8 甲′（D-主-65）：說明行沒事的時候寫這個值的日期「10/20（一）」——跟參考日（`refDay`）同一天淡字、不同天赭色。
 *   打字預覽／錯字說明出現時讓位給它們（預覽本身就寫「＝隔天」）。日期不放進 aria-live（步進每一下都念太吵）。
 * - 微調鈕（新變體）：夾在 [lo, hi]、到頭的鈕 disabled；框裡有草稿時先套用再走（打錯就不走、框抖一下）。
 *   長按加速：滑鼠 pointerdown 先走一步、停 HOLD_DELAY_MS 後連跳；手指 pointerdown 只起計時（捲動不誤觸），點一下的那一步交給 click。
 * - 常用時刻 chip（`quick`）：照打字同一套規則換成毫秒（resolveClockInput）；換不出來（不在範圍）⇒ disabled＋title 寫為什麼；等於目前值 ⇒ 亮起。
 * - 相對時刻 chip（`relative`）：現在／5 分前／10 分前＝按下那一刻的時鐘取整到分，夾在 [lo, hi]；整段都在範圍外 ⇒ disabled。
 *
 * ARIA 與鍵盤：
 * - 框：`aria-label={label}`、打錯時 `aria-invalid`；說明行的預覽／錯字在 `aria-live="polite"`。
 * - Enter＝確定（＋onEnter）；Esc＝草稿有改就還原並 stopPropagation（DialogShell／MobileSheetHost 的 Esc 掛在 window 冒泡階段，擋得住），
 *   沒改不攔（照舊關面板）；↑／↓＝±1 分（從草稿看得懂的值起算）；IME 組字中（isComposing／229）一律不處理。
 * - 微調鈕列 `role="group"`＋`aria-label`；每顆鈕 aria-label「{label}往前 15 分」；鍵盤 Enter／Space＝一次一步（click detail 0）。
 * - 快選列各自 `role="group"`；chip 是 `aria-pressed` 的按鈕。
 */
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { MIN, fmtClock } from "../../domain/timetable";
import {
  CLOCK_STEPS,
  HOLD_DELAY_MS,
  clockDateLabel,
  clockInputErrText,
  clockInputPreview,
  clockInputRefDay,
  clockStepLabel,
  holdGapMs,
  resolveClockInput,
  stepClockValue,
} from "../../domain/timetableClockInput";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { useShell } from "../mobile/useShell";

export interface ClockInputHandle {
  /** 框裡有沒打完的草稿 */
  dirty(): boolean;
  /** 套用草稿：成功回新值（沒草稿＝目前值）；打錯 ⇒ 還原＋抖＋說明，回 null */
  flush(): number | null;
  focus(): void;
  /** 打錯過幾次（Stepper 用來判斷「這一下點按之間失焦打錯了」：手指點鈕時失焦早於 click） */
  fails(): number;
}

/** 新變體：full＝±1h ±15 ±5 ±1；compact＝只留 ±15；mobile＝±15＋上方常用時刻 chip（§2.5） */
export type ClockVariant = "full" | "compact" | "mobile";

/** 手機變體沒給 `quick` 時的常用時刻（§2.5「09:00／13:00／…」；補滾輪「一撥就好」的手感） */
export const CLOCK_QUICK_DEFAULT: readonly string[] = ["09:00", "13:00", "18:00", "21:00"];

/** 相對時刻快選（§2.5：現在／5 分前／10 分前） */
export const CLOCK_RELATIVE: readonly { label: string; ago: number }[] = [
  { label: "現在", ago: 0 },
  { label: "5 分前", ago: 5 },
  { label: "10 分前", ago: 10 },
];

/** 各變體的微調鈕（分） */
export const CLOCK_VARIANT_STEPS: Readonly<Record<ClockVariant, readonly number[]>> = {
  full: CLOCK_STEPS,
  compact: [-15, 15],
  mobile: [-15, 15],
};

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
  refDay,
  variant,
  quick,
  relative = false,
}: {
  value: number;
  lo: number;
  hi: number;
  onChange(next: number): void;
  label: string;
  onEnter?(): void;
  autoFocus?: boolean;
  enterKeyHint?: "done" | "next";
  /** 框左側（舊版 DOM：Stepper 的 −鈕；新變體：給了就取代內建的 −鈕） */
  left?: ReactNode;
  /** 框右側（同上，＋鈕） */
  right?: ReactNode;
  handleRef?: Ref<ClockInputHandle>;
  /** 日期標籤的參考日（營業日 key；磨光⑤ 甲′）。面板裡的每一格要同一個——沒給就用掛上那一刻這一格的值算一次 */
  refDay?: string;
  /** 省略＝舊版 DOM（時刻表 Stepper）；給了＝新的 `.ns-clock` 長相與內建微調鈕 */
  variant?: ClockVariant;
  /** 常用時刻 chip（例 ["09:00","13:00"]；打字同一套解析）。mobile 變體沒給＝CLOCK_QUICK_DEFAULT；只在新變體畫 */
  quick?: readonly string[];
  /** 相對時刻列（現在／5 分前／10 分前）；只在新變體畫 */
  relative?: boolean;
}) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const viewDay = useTimetableStore((s) => s.dayKey);
  const [ownRefDay] = useState(() => clockInputRefDay(value, viewDay, dayStartHour));
  const dateRef = refDay ?? ownRefDay;
  const date = clockDateLabel(value, dateRef);
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

  /** 套用草稿（給步進鈕與外部 handle）：焦點正要離開框（按的是步進鈕）⇒ 接下來那次失焦不再處理 */
  const flush = (): number | null => {
    if (!isDirty()) return live.current.value;
    if (focused.current) settled.current = true;
    return commit(true);
  };

  useImperativeHandle(handleRef, () => ({
    dirty: isDirty,
    flush,
    focus: () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    },
    fails: () => failCount.current,
  }));

  /* ───────── 新變體的內建微調鈕（同 timetable/panels/controls.tsx Stepper 的長按規則） ───────── */

  const hold = useRef<{ timer: number; btn: HTMLButtonElement | null; off: (() => void) | null }>({ timer: 0, btn: null, off: null });
  /** 這一下是手指按的；連跳過了沒（有 ⇒ 放開後的 click 不再走）；按下時框打錯過幾次（click 前失焦打錯 ⇒ 不走） */
  const touch = useRef({ on: false, repeated: false, fails: 0 });
  const stopHold = (): void => {
    clearTimeout(hold.current.timer);
    hold.current.btn?.classList.remove("is-held");
    hold.current.off?.();
    hold.current = { timer: 0, btn: null, off: null };
  };
  useEffect(() => stopHold, []);
  /** 按下就掛上視窗層的停止條件（Alt+Tab、通知搶走焦點時不會有 pointerup；放開在鈕外也要停），stop 時拆掉 */
  const arm = (): void => {
    window.addEventListener("blur", stopHold);
    window.addEventListener("pointerup", stopHold, true);
    window.addEventListener("pointercancel", stopHold, true);
    hold.current.off = () => {
      window.removeEventListener("blur", stopHold);
      window.removeEventListener("pointerup", stopHold, true);
      window.removeEventListener("pointercancel", stopHold, true);
    };
  };
  /** 走 d 分；走不動（到頭、草稿打錯）回 false */
  const stepBy = (d: number): boolean => {
    const base = isDirty() ? flush() : live.current.value;
    if (base === null) return false;
    const L = live.current;
    const nv = stepClockValue(base, d, L.lo, L.hi);
    if (nv !== L.value) {
      live.current = { ...L, value: nv }; // 連跳時下一步不等重畫
      L.onChange(nv);
    }
    return nv !== base;
  };
  /** 連跳：firstDelay 後開始，每一步之後等 holdGapMs */
  const startHold = (b: HTMLButtonElement, d: number, firstDelay: number): void => {
    b.classList.add("is-held");
    hold.current.btn = b;
    let n = 0;
    const tick = (): void => {
      if (!stepBy(d)) return stopHold();
      hold.current.timer = window.setTimeout(tick, holdGapMs(n++));
    };
    hold.current.timer = window.setTimeout(tick, firstDelay);
  };
  const stepBtn = (d: number) => (
    <button
      key={d}
      type="button"
      className="ns-btn btn-ghost ns-btn--sm step"
      data-d={d}
      disabled={d < 0 ? value <= lo : value >= hi}
      aria-label={`${label}${d > 0 ? "往後" : "往前"} ${Math.abs(d) === 60 ? "1 小時" : `${Math.abs(d)} 分`}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        stopHold();
        const b = e.currentTarget;
        arm();
        if (e.pointerType === "touch") {
          touch.current = { on: true, repeated: false, fails: failCount.current };
          // 先不走：按滿 HOLD_DELAY_MS 才算長按（期間開始捲動 ⇒ pointercancel ⇒ stop，什麼都沒動）
          hold.current.timer = window.setTimeout(() => {
            touch.current.repeated = true;
            if (stepBy(d)) startHold(b, d, holdGapMs(0));
          }, HOLD_DELAY_MS);
          return;
        }
        touch.current.on = false;
        if (!stepBy(d)) return stopHold();
        startHold(b, d, HOLD_DELAY_MS);
      }}
      onPointerUp={stopHold}
      onPointerCancel={stopHold}
      onPointerLeave={stopHold}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (e.detail === 0) {
          stepBy(d); // 鍵盤：一次一步
          return;
        }
        if (!touch.current.on) return; // 滑鼠：pointerdown 已經走過
        const t = touch.current;
        touch.current = { on: false, repeated: false, fails: 0 };
        if (t.repeated) return; // 長按連跳過了
        if (failCount.current !== t.fails) return; // 點下去那一刻框失焦打錯（已還原＋抖）：不走
        stepBy(d);
      }}
    >
      {clockStepLabel(d)}
    </button>
  );

  /** 快選 chip：直接換成這個值（夾在 [lo, hi]）；草稿在失焦時已因 data-tt-drop-draft 丟掉 */
  const setAbs = (ms: number): void => {
    const L = live.current;
    const nv = Math.max(L.lo, Math.min(ms, L.hi));
    show(nv);
    clearErr();
    setHint(null);
    if (nv !== L.value) {
      live.current = { ...L, value: nv };
      L.onChange(nv);
    }
  };

  /* ───────── 框（兩種長相共用同一顆 input 的行為） ───────── */

  const inputProps = {
    ref: inputRef,
    type: "text",
    inputMode: "numeric" as const,
    autoComplete: "off",
    spellCheck: false,
    maxLength: 6,
    enterKeyHint,
    "aria-label": label,
    "aria-invalid": invalid,
    "data-tt-unseen": unseen ? "" : undefined,
    value: text,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
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
    },
    onFocus: (e: FocusEvent<HTMLInputElement>) => {
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
    },
    onMouseUp: (e: MouseEvent<HTMLInputElement>) => {
      // 點進來那一下：mouseup 會把全選取消，擋掉
      if (justFocused.current) {
        e.preventDefault();
        justFocused.current = false;
      }
    },
    onBlur: (e: FocusEvent<HTMLInputElement>) => {
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
    },
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
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
    },
  };

  /* ───────── 舊版 DOM（variant 省略；時刻表 Stepper） ───────── */

  if (!variant) {
    return (
      <span className="ns-tt-timecol">
        <span className="ns-tt-stepper is-a" role="group" aria-label={label}>
          {left}
          <span className={"ns-tt-tinwrap" + (shake ? " is-shake" : "") + (invalid ? " is-bad" : "")} onAnimationEnd={() => setShake(0)}>
            <input {...inputProps} className="ns-tt-val ns-tt-tin" />
          </span>
          {right}
        </span>
        <span className={"ns-tt-thint" + (hint ? " is-" + hint.kind : "")}>
          <span className="ns-tt-thint-msg" aria-live="polite">
            {hint?.kind === "ok" ? (
              <>
                {hint.pre}
                <b className="ns-tt-num">{hint.hm}</b>
              </>
            ) : hint?.kind === "err" ? (
              hint.text
            ) : null}
          </span>
          {!hint && <span className={"ns-tt-tdate ns-tt-num" + (date.other ? " is-other" : "")}>{date.text}</span>}
        </span>
      </span>
    );
  }

  /* ───────── 新變體（.ns-clock；datefield.css） ───────── */

  const steps = CLOCK_VARIANT_STEPS[variant];
  // 新變體的日期跨天時補前綴「＝隔天 」（＝前一天／＝N 天後；同打字預覽 clockInputPreview 的寫法），三個變體一致；舊版 DOM 不動
  const datePre = date.other ? clockInputPreview(value, dateRef)[0] : "";
  const quickList = quick ?? (variant === "mobile" ? CLOCK_QUICK_DEFAULT : undefined);
  const nowMin = Math.floor(Date.now() / MIN) * MIN;
  const rangeErr = (ms: number): string | null =>
    ms < lo ? clockInputErrText({ err: "range", side: "early" }, lo, hi) : ms > hi ? clockInputErrText({ err: "range", side: "late" }, lo, hi) : null;

  return (
    <span className={"ns-clock is-" + variant}>
      {relative && (
        <span className="ns-clock-quick" role="group" aria-label={`${label}・相對時刻`}>
          {CLOCK_RELATIVE.map((q) => {
            const why = rangeErr(nowMin - q.ago * MIN);
            return (
              <button
                key={q.label}
                type="button"
                className="chip ns-chip"
                data-tt-drop-draft=""
                disabled={why !== null}
                title={why ?? undefined}
                onClick={() => setAbs(Math.floor(Date.now() / MIN) * MIN - q.ago * MIN)}
              >
                {q.label}
              </button>
            );
          })}
        </span>
      )}
      {quickList && quickList.length > 0 && (
        <span className="ns-clock-quick" role="group" aria-label={`${label}・常用時刻`}>
          {quickList.map((q) => {
            const r = resolve(q);
            const ms = "ms" in r ? r.ms : null;
            const on = ms === value;
            return (
              <button
                key={q}
                type="button"
                className={"chip ns-chip ns-clock-tmx" + (on ? " is-on" : "")}
                data-tt-drop-draft=""
                aria-pressed={on}
                disabled={ms === null}
                title={"ms" in r ? undefined : clockInputErrText(r, lo, hi)}
                onClick={() => {
                  if (ms !== null) setAbs(ms);
                }}
              >
                {q}
              </button>
            );
          })}
        </span>
      )}
      <span className="ns-clock-row" role="group" aria-label={label}>
        {left ?? steps.filter((d) => d < 0).map(stepBtn)}
        <span className={"ns-clock-inwrap" + (shake ? " is-shake" : "") + (invalid ? " is-bad" : "")} onAnimationEnd={() => setShake(0)}>
          <input {...inputProps} className="techo-input ns-clock-in" />
        </span>
        {right ?? steps.filter((d) => d > 0).map(stepBtn)}
      </span>
      <span className={"ns-clock-foot" + (hint ? " is-" + hint.kind : "")}>
        <span className="ns-clock-msg" aria-live="polite">
          {hint?.kind === "ok" ? (
            <>
              {hint.pre}
              <b>{hint.hm}</b>
            </>
          ) : hint?.kind === "err" ? (
            hint.text
          ) : null}
        </span>
        {!hint && (
          <span className={"ns-clock-date" + (date.other ? " is-other" : "")}>
            {datePre}
            {date.text}
          </span>
        )}
      </span>
    </span>
  );
}
