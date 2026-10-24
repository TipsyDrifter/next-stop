/**
 * controls——六個面板共用的小件（車次①a 契約 §5.4；丙席）。
 * 兩殼共用表單本體：桌機由 DesktopSheetHost 包進 DialogShell、手機由 MobileSheetHost 包進 MSheet（UI 丙-4 C3）；
 * 這裡只有 DOM 與行為，樣式在 timetable.css §F（class 一律 `.ns-tt-*`）。
 *
 * - 時間一律毫秒；時刻欄＝全 App 那支 ClockInput（UI 丙-4 C5；磨光⑥ 契約 §1-1；D-時-142、147、148）。
 * - 按鈕列（UI 丙-4 C1）：`<Actions>` 在宿主給了黏底列（`TtFootContext`）時 portal 進殼的 foot，本文怎麼捲按鈕都在底；
 *   沒給（即時存的面板、桌機日程浮層以外的行內用法）就照舊畫在面板裡。面板程式不用知道自己在哪個殼。
 * - W1（蓋到既有紀錄的赭字）由 `useCoverWarn` 經 store.previewCover 預演，不寫入。
 * - 面板只讀 store、只叫 store 的動作（契約 §2.6-3）。
 */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { findBlockIn, type TimeBlockRow } from "../../../domain/timetable";
import { clockInputRefDay } from "../../../domain/timetableClockInput";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { ClockInput, type ClockInputHandle } from "../../common/ClockInput";
import { useShell } from "../../mobile/useShell";

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
 * 時刻欄（磨光⑥ 契約 §1-1、§1-5½；D-時-142、147、148）：五處（補記／改一塊的発車與到着、其實到幾點、改出發時間、切開）同一支。
 * UI 丙-4 C5：換成全 App 那支 `ClockInput` 的新變體——桌機 `full`（−1h −15 −5 −1｜框｜+1 +5 +15 +1h，同舊排法）、手機 `mobile`
 * （±15＋可打字；規範 §2.5 手機只留 ±15，細調靠打字 2330／0815）。微調鈕、長按加速、草稿先套用再走、到頭 disabled 都是元件自己的，
 * 這裡不再自畫鈕（舊的 left／right 塞鈕與 `.ns-tt-stepper.is-a` DOM 退役）。
 * - 手機不給常用時刻 chip（`quick=[]`）：面板的範圍多半只有一段空白或一塊的長度，09:00／13:00 幾乎都是灰的；
 *   貼齊（接上一塊／接到現在）由面板自己的 chip 給。
 * - onEnter／autoFocus／enterKeyHint 是補記面板要的選填項（発車 Enter 跳到着、開面板游標在框裡）。
 * - refDay（磨光⑤ 甲′）：框下的日期標籤跟哪一天比（面板用 usePanelRefDay 算一次、每一格傳同一個）。
 *   步進穿過日界線值照算（真的跨天是正當的）——靠日期標籤讓人看得到、靠 BlockPanel 的長塊確認問得到。
 */
const NO_QUICK: readonly string[] = [];
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
  const mobile = useShell() === "mobile";
  return (
    <ClockInput
      variant={mobile ? "mobile" : "full"}
      quick={NO_QUICK}
      value={value}
      lo={lo}
      hi={hi}
      onChange={onChange}
      label={label}
      onEnter={onEnter}
      autoFocus={autoFocus}
      enterKeyHint={enterKeyHint}
      refDay={refDay}
      handleRef={handleRef}
    />
  );
}

/**
 * 送出鈕先叫這支（D-時-144）：面板裡有剛打錯、還沒回去看過的時刻框（Enter 或失焦時已還原＋抖過）⇒ 焦點放回那個框、回 false
 * （不送出；說明行再顯示一次）。再按一次才送出——拿到的是還原後的值，人已經看過了。
 * 合法的草稿在失焦那一刻已經套用（pointerdown 早於 click），送出時拿到的就是新值。
 * UI 丙-4 C2：按鈕抬進殼的黏底列後已經不在 `.ns-tt-panel` 裡——從按鈕往上找面板會找不到、**默默放行打錯的時刻**。
 * 改成：按鈕在面板裡（行內畫的）就找面板；不在就找它所在的 dialog／sheet 根（`[role=dialog]`），再往下找面板裡的框。
 * 框的 class 不寫死（ClockInput 新舊 DOM 的 input class 不同），只認 `data-tt-unseen`。
 */
export function clockDraftsOk(from: Element | null): boolean {
  const root = from?.closest(".ns-tt-panel") ?? from?.closest('[role="dialog"]') ?? null;
  const bad = root?.querySelector<HTMLInputElement>(".ns-tt-panel input[data-tt-unseen]") ?? null;
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

/**
 * 黏底按鈕列的容器（UI 丙-4 C1）：宿主（DesktopSheetHost／MobileSheetHost／PlanPopover）把殼的 foot 插槽裡那個空 div 放進來。
 * undefined＝這個宿主不給 foot（即時存的面板）⇒ `<Actions>` 照舊畫在面板裡；null＝給了、但 div 還沒掛上（第一拍）⇒ 先不畫。
 */
export const TtFootContext = createContext<HTMLElement | null | undefined>(undefined);

/**
 * 宿主用：`enabled` 時回 foot 插槽要放的空容器（`div.ns-tt-foot`）與它的元素（給 `TtFootContext`）；不給 foot 時兩個都是 undefined。
 * 容器沒有子元素（面板這一拍沒畫按鈕列：合併確認、連結子頁、找不到這一塊）時，殼的那一列由 timetable.css 收掉（`:has(> .ns-tt-foot:empty)`）。
 */
export function useTtFoot(enabled: boolean): { foot: ReactNode; el: HTMLElement | null | undefined } {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  if (!enabled) return { foot: undefined, el: undefined };
  return { foot: <div ref={setEl} className="ns-tt-foot" />, el };
}

/**
 * 底部動作列（規範 §2.3：一面板一顆 `btn-seal`、取消在左主鈕右；次要動作 `.is-aux` 排最左）。
 * 宿主給了 foot ⇒ portal 進殼的黏底列（DialogShell `.ns-dialog-foot`／MSheet `.ns-msheet-foot`）；沒給 ⇒ 行內（UI 丙-4 C1）。
 * GoalPanel（T3）等新面板直接用它就好，不用管殼。
 */
export function Actions({ children }: { children: ReactNode }) {
  const footEl = useContext(TtFootContext);
  const row = <div className="ns-tt-actions">{children}</div>;
  if (footEl === undefined) return row;
  if (footEl === null) return null;
  return createPortal(row, footEl);
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
