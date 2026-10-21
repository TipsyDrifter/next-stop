/**
 * controls——六個面板共用的小件（車次①a 契約 §5.4；丙席）。
 * 兩殼共用表單本體：桌機由 DesktopSheetHost 包進 DialogShell、手機由 MobileSheetHost 包進 .m-sheet；
 * 這裡只有 DOM 與行為，樣式在 timetable.css §F（class 一律 `.ns-tt-*`）。
 *
 * - 時間一律毫秒；stepper 以「分鐘」步進、中間是可打字的時刻框（ClockInput，磨光⑥ 契約 §1-1；D-時-142、147、148）。
 * - W1（蓋到既有紀錄的赭字）由 `useCoverWarn` 經 store.previewCover 預演，不寫入。
 * - 面板只讀 store、只叫 store 的動作（契約 §2.6-3）。
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { findBlockIn, type TimeBlockRow } from "../../../domain/timetable";
import { CLOCK_STEPS, HOLD_DELAY_MS, clockInputRefDay, clockStepLabel, holdGapMs, stepClockValue } from "../../../domain/timetableClockInput";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { ClockInput, type ClockInputHandle } from "./ClockInput";

export interface PanelProps {
  /** 確認或取消後由 host 關（longRun 面板確認走 store.resolveLongRun，它自己收 sheet；略過才叫這支） */
  onDone(): void;
}

/** 夾在 [lo, hi]；lo > hi（區間退化）時回 lo */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/** 面板掛上時的「現在」（一個面板的生命週期內固定，步進的上限才不會每秒跑掉） */
export function useNowOnce(): number {
  const [now] = useState(() => Date.now());
  return now;
}

/**
 * 面板的參考日（磨光⑤ §8 甲′；D-主-65）：時刻框旁的日期跟它同一天＝淡字、不同天＝赭色。
 * 一個面板只算一次、所有框共用（`anchor`＝這一塊的開始；落在看的那一天裡＝看的那一天，否則＝它自己那一天，同 clockInputRefDay）。
 * 不能每格各自算：補記到着的初值常在隔天（那段空白一路到隔天日界線），各自算就會把隔天當「同一天」畫成淡字。
 */
export function usePanelRefDay(anchor: number): string {
  const viewDay = useTimetableStore((s) => s.dayKey);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [ref] = useState(() => clockInputRefDay(anchor, viewDay, dayStartHour));
  return ref;
}

/** 依 id 找畫面上拿得到的那一塊（運行中／看的那天／今天／本週）；都沒有再看 `sheetBlock`（面板從清單外的塊開起來，如統計頁的待確認，③ 評審 #1） */
export function useBlock(id: string): TimeBlockRow | null {
  return useTimetableStore((s) => findBlockIn(id, s.running, [s.dayBlocks, s.todayBlocks, s.weekBlocks]) ?? (s.sheetBlock?.id === id ? s.sheetBlock : null));
}

/**
 * W1 預演：`active` 時向 store.previewCover 問「這段寫下去會蓋掉幾塊」，回赭字全文（沒蓋到＝空字串）。
 * 失敗靜默（預演只是提示，寫入時 repository 還會再算一次）。
 * 磨光⑥ §1-5½：長按連跳時值每 45–170ms 換一次——離上一次問不到 COVER_BURST_MS 就等值停下來 COVER_SETTLE_MS 再問（第一次、
 * 單按照舊立刻問），不打爆 previewCover。
 */
const COVER_BURST_MS = 250;
const COVER_SETTLE_MS = 180;
export function useCoverWarn(start: number, end: number | null, exceptId: string | null, active: boolean): string {
  const previewCover = useTimetableStore((s) => s.previewCover);
  const [text, setText] = useState("");
  const lastAsk = useRef(0);
  useEffect(() => {
    if (!active) {
      setText("");
      return;
    }
    let alive = true;
    const ask = (): void => {
      lastAsk.current = Date.now();
      previewCover(start, end, exceptId)
        .then((sum) => {
          if (alive) setText(TT_TEXT.cover(sum));
        })
        .catch(() => {
          if (alive) setText("");
        });
    };
    const burst = Date.now() - lastAsk.current < COVER_BURST_MS;
    const timer = burst ? window.setTimeout(ask, COVER_SETTLE_MS) : 0;
    if (!burst) ask();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [previewCover, start, end, exceptId, active]);
  return text;
}

/** 副標（`warn`＝赭字） */
export function Sub({ children, warn = false, num = false }: { children: ReactNode; warn?: boolean; num?: boolean }) {
  return <p className={"ns-tt-panel-sub" + (warn ? " is-warn" : "") + (num ? " is-num" : "")}>{children}</p>;
}

/** 一列：左欄標籤（発車／到着／切在／之後…）＋右欄內容 */
export function Row({ k, children, top = false, time = false }: { k: string; children: ReactNode; top?: boolean; /** 放 Stepper 的列（磨光⑥：說明行疊在底下、chip 換行） */ time?: boolean }) {
  return (
    <div className={"ns-tt-row" + (top ? " is-top" : "") + (time ? " is-time" : "")}>
      <span className="ns-tt-row-k">{k}</span>
      <span className="ns-tt-row-v">{children}</span>
    </div>
  );
}

/**
 * 時刻 stepper（磨光⑥ 契約 §1-1、§1-5½；D-時-142、147、148）：五處（補記／改一塊的発車與到着、其實到幾點、改出發時間、切開）
 * 同一排鈕 −1h −15 −5 −1 ｜可打字的時刻框（ClockInput）｜ +1 +5 +15 +1h；手機兩側各 2×2（timetable.css §F）。夾在 [lo, hi]，
 * 到頭的鈕 disabled。
 * - 長按加速：按下先走一步、停 HOLD_DELAY_MS 後連跳（holdGapMs 逐步縮短）；放開、移出、到頭、視窗失焦就停。pointer 事件。
 *   滑鼠在 pointerdown 就走第一步，click 只接鍵盤（Enter／Space，detail＝0）＝一次一步。
 *   手指（評審 #2）：pointerdown 只起計時、不先走（捲面板時手指常落在鈕上，pointerdown 早於瀏覽器判定成捲動）；
 *   點一下的那一步交給 click（捲動不會發 click），按滿 HOLD_DELAY_MS 才開始連跳，連跳過就不再讓 click 多走一步。
 * - 框裡有草稿時按步進鈕：先套用草稿再走（原型行為；打錯就不走、框抖一下）。
 * - onEnter／autoFocus／enterKeyHint 是補記面板要的選填項（発車 Enter 跳到着、開面板游標在框裡）。
 * - refDay（磨光⑤ 甲′）：框下的日期標籤跟哪一天比（面板用 usePanelRefDay 算一次、每一格傳同一個）。
 *   步進穿過日界線值照算（真的跨天是正當的）——靠日期標籤讓人看得到、靠 BlockPanel 的長塊確認問得到。
 */
export function Stepper({
  value,
  lo,
  hi,
  onChange,
  label,
  onEnter,
  autoFocus,
  enterKeyHint,
  handleRef,
  refDay,
}: {
  value: number;
  lo: number;
  hi: number;
  onChange(next: number): void;
  label: string;
  onEnter?(): void;
  autoFocus?: boolean;
  enterKeyHint?: "done" | "next";
  handleRef?: Ref<ClockInputHandle>;
  refDay?: string;
}) {
  const clock = useRef<ClockInputHandle | null>(null);
  const live = useRef({ value, lo, hi, onChange });
  live.current = { value, lo, hi, onChange };
  const hold = useRef<{ timer: number; btn: HTMLButtonElement | null; off: (() => void) | null }>({ timer: 0, btn: null, off: null });
  /** 這一下是手指按的；連跳過了沒（有 ⇒ 放開後的 click 不再走）；按下時框打錯過幾次（click 前失焦打錯 ⇒ 不走） */
  const touch = useRef({ on: false, repeated: false, fails: 0 });
  const stop = (): void => {
    clearTimeout(hold.current.timer);
    hold.current.btn?.classList.remove("is-held");
    hold.current.off?.();
    hold.current = { timer: 0, btn: null, off: null };
  };
  useEffect(() => stop, []);

  /** 按下就掛上視窗層的停止條件（Alt+Tab、通知搶走焦點時不會有 pointerup；放開在鈕外也要停），stop 時拆掉 */
  const arm = (): void => {
    window.addEventListener("blur", stop);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    hold.current.off = () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
    };
  };
  /** 連跳：firstDelay 後開始，每一步之後等 holdGapMs */
  const startHold = (b: HTMLButtonElement, d: number, firstDelay: number): void => {
    b.classList.add("is-held");
    hold.current.btn = b;
    let n = 0;
    const tick = (): void => {
      if (!step(d)) return stop();
      hold.current.timer = window.setTimeout(tick, holdGapMs(n++));
    };
    hold.current.timer = window.setTimeout(tick, firstDelay);
  };

  /** 走 d 分；走不動（到頭、草稿打錯）回 false */
  const step = (d: number): boolean => {
    const c = clock.current;
    const base = c && c.dirty() ? c.flush() : live.current.value;
    if (base === null) return false;
    const nv = stepClockValue(base, d, live.current.lo, live.current.hi);
    if (nv !== live.current.value) {
      live.current = { ...live.current, value: nv }; // 連跳時下一步不等重畫
      live.current.onChange(nv);
    }
    return nv !== base;
  };

  const btn = (d: number) => (
    <button
      key={d}
      type="button"
      className="ns-tt-step"
      data-d={d}
      disabled={d < 0 ? value <= lo : value >= hi}
      aria-label={`${label}${d > 0 ? "往後" : "往前"} ${Math.abs(d) === 60 ? "1 小時" : `${Math.abs(d)} 分`}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        stop();
        const b = e.currentTarget;
        arm();
        if (e.pointerType === "touch") {
          touch.current = { on: true, repeated: false, fails: clock.current?.fails() ?? 0 };
          // 先不走：按滿 HOLD_DELAY_MS 才算長按（期間開始捲動 ⇒ pointercancel ⇒ stop，什麼都沒動）
          hold.current.timer = window.setTimeout(() => {
            touch.current.repeated = true;
            if (step(d)) startHold(b, d, holdGapMs(0));
          }, HOLD_DELAY_MS);
          return;
        }
        touch.current.on = false;
        if (!step(d)) return stop();
        startHold(b, d, HOLD_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (e.detail === 0) {
          step(d); // 鍵盤：一次一步
          return;
        }
        if (!touch.current.on) return; // 滑鼠：pointerdown 已經走過
        const t = touch.current;
        touch.current = { on: false, repeated: false, fails: 0 };
        if (t.repeated) return; // 長按連跳過了
        if ((clock.current?.fails() ?? 0) !== t.fails) return; // 點下去那一刻框失焦打錯（已還原＋抖）：同滑鼠，不走
        step(d);
      }}
    >
      {clockStepLabel(d)}
    </button>
  );
  return (
    <ClockInput
      value={value}
      lo={lo}
      hi={hi}
      onChange={onChange}
      label={label}
      onEnter={onEnter}
      autoFocus={autoFocus}
      enterKeyHint={enterKeyHint}
      refDay={refDay}
      handleRef={(h) => {
        clock.current = h;
        if (typeof handleRef === "function") handleRef(h);
        else if (handleRef) (handleRef as { current: ClockInputHandle | null }).current = h;
      }}
      left={CLOCK_STEPS.filter((d) => d < 0).map(btn)}
      right={CLOCK_STEPS.filter((d) => d > 0).map(btn)}
    />
  );
}

/**
 * 送出鈕先叫這支（D-時-144）：面板裡有剛打錯、還沒回去看過的時刻框（Enter 或失焦時已還原＋抖過）⇒ 焦點放回那個框、回 false
 * （不送出；說明行再顯示一次）。再按一次才送出——拿到的是還原後的值，人已經看過了。
 * 合法的草稿在失焦那一刻已經套用（pointerdown 早於 click），送出時拿到的就是新值。
 */
export function clockDraftsOk(from: Element | null): boolean {
  const root = from?.closest(".ns-tt-panel") ?? null;
  const bad = root?.querySelector<HTMLInputElement>("input.ns-tt-tin[data-tt-unseen]") ?? null;
  if (!bad) return true;
  bad.focus();
  bad.select();
  return false;
}

/** 選項 chip（出發幾分前／之後怎麼辦…） */
export function Opt({
  on,
  onClick,
  children,
  solid = false,
  dropDraft = false,
}: {
  on: boolean;
  onClick(): void;
  children: ReactNode;
  solid?: boolean;
  /** 貼齊鈕（接上一塊…）：按下時時刻框的草稿直接丟、照鈕的語義做（磨光⑥ D-時-144） */
  dropDraft?: boolean;
}) {
  return (
    <button
      type="button"
      className={"ns-tt-opt" + (on ? " is-on" : "") + (solid ? " is-solid" : "")}
      aria-pressed={on}
      onClick={onClick}
      data-tt-drop-draft={dropDraft ? "" : undefined}
    >
      {children}
    </button>
  );
}

/** chip 列 */
export function Opts({ children }: { children: ReactNode }) {
  return <span className="ns-tt-opts">{children}</span>;
}

/** 底部動作列 */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="ns-tt-actions">{children}</div>;
}

/* ── 車次①b（①b①c 契約 §5.1–§5.6；乙席） ── */

/** 預估的五個選項（發車面板、預估面板共用；分） */
export const ESTIMATE_OPTIONS: readonly (readonly [number, string])[] = [
  [30, "30 分"],
  [60, "1h"],
  [90, "1h30"],
  [120, "2h"],
  [180, "3h"],
];

/**
 * 展開段（＝原型 `.ve-merge／.ve-seggrid／.ve-mgr-x` 的 grid 0fr→1fr）：掛上那一刻播一次展開（高度補間＋內容淡入），
 * 收起＝直接拿掉（React 不留退場節點；原型同樣只播展開）。樣式在 §F `.ns-tt-expand`。
 */
export function Expand({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={"ns-tt-expand" + (className ? " " + className : "")}>
      <div className="ns-tt-expand-in">{children}</div>
    </div>
  );
}

/**
 * 合併預覽時軸上要描金邊的塊（D-時-33：「軸上那兩塊描金邊」）。只是畫面提示，不進 store：
 * BlockPanel 的二次確認行開著時寫入、關掉／unmount 時清空；Axis 訂閱它畫 `.is-mhl`。
 */
let mergeMarks: readonly string[] = [];
const mergeMarkSubs = new Set<() => void>();
export function setMergeMarks(ids: readonly string[]): void {
  if (ids.length === mergeMarks.length && ids.every((x, i) => x === mergeMarks[i])) return;
  mergeMarks = ids.slice();
  mergeMarkSubs.forEach((f) => f());
}
export function useMergeMarks(): readonly string[] {
  return useSyncExternalStore(
    (cb) => {
      mergeMarkSubs.add(cb);
      return () => {
        mergeMarkSubs.delete(cb);
      };
    },
    () => mergeMarks,
  );
}
