/**
 * controls——六個面板共用的小件（車次①a 契約 §5.4；丙席）。
 * 兩殼共用表單本體：桌機由 DesktopSheetHost 包進 DialogShell、手機由 MobileSheetHost 包進 .m-sheet；
 * 這裡只有 DOM 與行為，樣式在 timetable.css §F（class 一律 `.ns-tt-*`）。
 *
 * - 時間一律毫秒；stepper 以「分鐘」步進、顯示 `fmtClock`。
 * - W1（蓋到既有紀錄的赭字）由 `useCoverWarn` 經 store.previewCover 預演，不寫入。
 * - 面板只讀 store、只叫 store 的動作（契約 §2.6-3）。
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { MIN, fmtClock, type TimeBlockRow } from "../../../domain/timetable";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";

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

/** 依 id 找畫面上拿得到的那一塊（運行中／看的那天／今天／本週） */
export function useBlock(id: string): TimeBlockRow | null {
  return useTimetableStore((s) => {
    if (s.running?.id === id) return s.running;
    return (
      s.dayBlocks.find((b) => b.id === id) ??
      s.todayBlocks.find((b) => b.id === id) ??
      s.weekBlocks.find((b) => b.id === id) ??
      null
    );
  });
}

/**
 * W1 預演：`active` 時向 store.previewCover 問「這段寫下去會蓋掉幾塊」，回赭字全文（沒蓋到＝空字串）。
 * 失敗靜默（預演只是提示，寫入時 repository 還會再算一次）。
 */
export function useCoverWarn(start: number, end: number | null, exceptId: string | null, active: boolean): string {
  const previewCover = useTimetableStore((s) => s.previewCover);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!active) {
      setText("");
      return;
    }
    let alive = true;
    previewCover(start, end, exceptId)
      .then((sum) => {
        if (alive) setText(TT_TEXT.cover(sum));
      })
      .catch(() => {
        if (alive) setText("");
      });
    return () => {
      alive = false;
    };
  }, [previewCover, start, end, exceptId, active]);
  return text;
}

/** 副標（`warn`＝赭字） */
export function Sub({ children, warn = false, num = false }: { children: ReactNode; warn?: boolean; num?: boolean }) {
  return <p className={"ns-tt-panel-sub" + (warn ? " is-warn" : "") + (num ? " is-num" : "")}>{children}</p>;
}

/** 一列：左欄標籤（発車／到着／切在／之後…）＋右欄內容 */
export function Row({ k, children, top = false }: { k: string; children: ReactNode; top?: boolean }) {
  return (
    <div className={"ns-tt-row" + (top ? " is-top" : "")}>
      <span className="ns-tt-row-k">{k}</span>
      <span className="ns-tt-row-v">{children}</span>
    </div>
  );
}

/** 時刻 stepper：負步進在左、正步進在右，中間 HH:MM；夾在 [lo, hi] */
export function Stepper({
  value,
  steps,
  lo,
  hi,
  onChange,
  label,
}: {
  value: number;
  /** 分鐘；例 [-30, -5, 5, 30] */
  steps: readonly number[];
  lo: number;
  hi: number;
  onChange(next: number): void;
  label: string;
}) {
  const neg = steps.filter((d) => d < 0);
  const pos = steps.filter((d) => d > 0);
  const step = (d: number): void => onChange(clamp(value + d * MIN, lo, hi));
  const btn = (d: number) => (
    <button
      key={d}
      type="button"
      className="ns-tt-step"
      onClick={() => step(d)}
      disabled={d < 0 ? value <= lo : value >= hi}
      aria-label={`${label}${d > 0 ? "＋" : "－"}${Math.abs(d)} 分`}
    >
      {d > 0 ? `+${d}` : `−${Math.abs(d)}`}
    </button>
  );
  return (
    <span className="ns-tt-stepper" role="group" aria-label={label}>
      {neg.map(btn)}
      <span className="ns-tt-val" aria-live="polite">
        {fmtClock(value)}
      </span>
      {pos.map(btn)}
    </span>
  );
}

/** 選項 chip（出發幾分前／之後怎麼辦…） */
export function Opt({ on, onClick, children, solid = false }: { on: boolean; onClick(): void; children: ReactNode; solid?: boolean }) {
  return (
    <button type="button" className={"ns-tt-opt" + (on ? " is-on" : "") + (solid ? " is-solid" : "")} aria-pressed={on} onClick={onClick}>
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
