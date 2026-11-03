/**
 * MobileTimeSheet——手機設預定時刻的底部 sheet（主線②；D-主-14、契約 §4.5-4；原型 `:1264-1350`）。
 *
 * 從 ⋯ sheet 的「幾點…」「每班時刻…」（mode="rule"）或「本班改時刻…」（mode="run"）開進來。
 * **UI 丙-3（契約 §1 F4；視覺規範 §2.4「手機底部 sheet」、§2.5「時間」）**：殼換共用 `MSheet`、滾輪 `MobileWheel` 退役，
 *   改成全 App 同一支 `ClockInput variant="mobile"`（可打字 0830／25:00、±15、上方常用時刻 09:00／13:00／18:00／21:00、
 *   下方寫這個值的日期，跨天赭字）——兩殼同一種輸入。由上而下：
 *   標題「幾點発車・票名」／「本班改時刻・票名」
 *   （run）.m-tms-note「只改 M/D（週X）這一班；每班 07:00 不動」
 *   ClockInput（refDay＝這張卡的班次日：一定要給，不給它會拿時刻表的檢視日當參考日，日期字會錯）
 *   （滾到日界線以後的小時）.m-tms-note.is-wrap「早於日界線 03:00 算今天深夜，記為 25:00」——框裡寫 01:00、存的是營業日表記
 *   （rule）預計多久＝分段鈕 15 分／30 分／1h／1h30／2h＋「自訂…」chip（§2.5 長度選擇一套；再點選中的那段＝清掉，回「時間未定」）
 *   .m-tms-sum「14:00 発 → 15:30 着（90 分）」／「・時間未定」；比現在早（沒交代的票）補赭字「已過現在時刻」
 *   按鈕列黏底（MSheet foot）：rule「不排時刻」｜「確定」；run「本班不排時刻」｜（覆寫中）「改回每班 07:00」｜「確定」
 * 回饋甲（D-主-129）：手機詳情頁的「時段」兩格各開一張——開始＝rule＋`withLen={false}`（長度另有一列，只改開始＝整段平移）；
 *   結束＝mode="end"（標題「結束時刻」、範圍從開始後一分起、摘要「14:00 発 → 15:30 着（1h30）」、確定＝`onCommit(結束, 新長度)`、沒有「不排時刻」）。
 *   長度字與分段改用 panel/panelRules 那一份（LEN_PRESETS／lenText），側板與詳情頁同一組。
 * 返回層：⋯ sheet 的主人登記整個流程那一層，這裡把同一個 `backId` 傳給 MSheet ⇒ refcount 合併成一層。
 *
 * 值：框裡一定帶值（D-主-14）⇒ 「不排時刻」是一顆**直接送出**的鈕（原型 data-tclear 同款），不是切換狀態。
 *   內部存「營業日分鐘」（≥ 1440＝過了午夜、算這一天的深夜），ClockInput 吃毫秒：兩邊在 msOf／minOf 換算，範圍夾在這一天的日界線視窗。
 * 預帶值（✎ 契約 §4.5-3）：有時刻＝現值；沒時刻 ⇒ rule：現在＋30 分向上取到 5 分、夾進這一天的範圍；現在不在這張卡的
 *   那一天（卡是別天的班）⇒ 09:00；run：每班時刻（沒有 ⇒ 同 rule）。
 * 確定（框裡有沒打完的字先套用；打錯就不送、框抖一下）：
 *   rule ⇒ `onCommit(time, estimateMin)`——預計沒變就不帶（`undefined`），值都沒變就直接關、不寫
 *   run  ⇒ 選的就是每班時刻 ⇒ 本來就照每班：直接關；覆寫中：等於「改回每班」（`onReset`，原型 commitSheet 同款）；
 *          其餘 `onCommit(time)` ⇒ setRunTime
 * 收據 toast 在呼叫端的動作（scheduleActions／useMobileToday），本元件不碰 store。
 * IME：自訂預計的數字框照三道護欄（isComposing／229／composition 旗標）；Enter＝收起鍵盤，不送出整張 sheet。
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { arrivalClock, clockMinutes, clockRange, clockText, isClockPast, nowClockMinutes } from "../../lib/date";
import { mdw } from "../schedule/streamModel";
import type { TicketCardModel } from "../schedule/ticketCard";
import { ClockInput, type ClockInputHandle } from "../common/ClockInput";
import { MSheet } from "../common/MSheet";
import { Segmented } from "../common/Segmented";
import { msToClock } from "../panel/clockValue";
import { LEN_MAX, LEN_PRESETS, lenText } from "../panel/panelRules";
import "./mobile-polish.css";

/* 長度字與分段（回饋甲起與側板、詳情頁同一份：panel/panelRules）；lenText 照舊從這裡也拿得到 */
export { lenText };

/** 預計多久的分段（分；§2.5 長度選擇一套） */
const EST_SEGS = LEN_PRESETS.map(String);
type EstSeg = string;
const EST_MAX = LEN_MAX;
/** 現在不在那一天時的預帶值 09:00 */
const NINE = 9 * 60;
/** end 模式：還沒有長度時，結束從開始後多久起（同側板時段的結束格） */
const END_SEED_MIN = 60;

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

const EST_OPTS = EST_SEGS.map((v) => ({ value: v, label: lenText(Number(v)) }));

/**
 * 時刻動作的收據（契約 §3.10；行程表的 scheduleActions 與今日子頁的 useMobileToday 同一組字，放在這裡兩邊都 import 得到、不成環）：
 *   每班／單發票「時刻改成 14:00」、本班「本班改成 09:30」、清成沒時刻（兩種都是）「已改成不排時刻」、改回每班「改回每班時刻」
 */
export function timeReceipt(kind: "rule" | "run" | "reset", time: string | null): string {
  if (kind === "reset") return "改回每班時刻";
  if (time === null) return "已改成不排時刻";
  return kind === "run" ? `本班改成 ${time}` : `時刻改成 ${time}`;
}

export interface MobileTimeSheetProps {
  card: TicketCardModel;
  /**
   * rule＝單發票的時刻／定期券的每班時刻（＋預計）；run＝定期券這一班；
   * end＝時段的結束（回饋甲 D-主-129，詳情頁「時段」第二格）：開始＝card.ruleTime，框的範圍從開始後一分起（等於或早於開始＝打錯規則擋下），
   *   確定 ⇒ `onCommit(結束, 新長度)`；沒有「不排時刻」鈕（清長度在「長度」列）
   */
  mode: "rule" | "run" | "end";
  /** rule：要不要「預計多久」那組（預設要；詳情頁的長度另有一列，傳 false＝只改開始、長度不動＝整段平移） */
  withLen?: boolean;
  /** 日界線今天 */
  today: string;
  dayStartHour: number;
  /** useMinuteTick() 的現在 */
  now: number;
  /** 返回層 id（⋯ sheet 的主人登記的那一層；同 id 合併） */
  backId?: string;
  /** rule：estimateMin 為 undefined＝預計沒變、不送；run：只用 time */
  onCommit(time: string, estimateMin?: number | null): void;
  /** 「不排時刻」（rule）／「本班不排時刻」（run） */
  onClear(): void;
  /** run 且覆寫中：「改回每班 …」 */
  onReset?(): void;
  onClose(): void;
}

/** 沒時刻時的預帶值（理由見檔頭） */
function prefill(dayDate: string, dayStartHour: number, now: number): number {
  const r = clockRange(dayStartHour);
  const nowMin = nowClockMinutes(dayDate, dayStartHour, now);
  // 09:00（契約寫成 `dayStartHour*60 + 540`，那只在日界線 00 時是 09:00；這裡照字面意思取 09:00，比日界線早就記成 33:00）
  if (nowMin === null) return NINE < r.min ? NINE + 1440 : NINE;
  const up = Math.ceil((nowMin + 30) / 5) * 5;
  if (up > r.max) return Math.floor(r.max / 5) * 5;
  return Math.max(up, r.min);
}

/** 營業日分鐘 → 這一天的牆鐘毫秒（≥ 1440 由 Date 進位到隔天；同 lib/date clockInstant） */
function msOf(day: string, min: number): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, Math.floor(min / 60), min % 60).getTime();
}

export function MobileTimeSheet({
  card,
  mode,
  withLen = true,
  today,
  dayStartHour,
  now,
  backId,
  onCommit,
  onClear,
  onReset,
  onClose,
}: MobileTimeSheetProps) {
  const dayRange = clockRange(dayStartHour);
  const dayDate = card.railDate ?? today;
  const isEnd = mode === "end";
  /** end：開始（營業日分鐘）與現在的結束（開始＋長度；沒有長度＝null） */
  const startMin = isEnd && card.ruleTime !== null ? clockMinutes(card.ruleTime) : null;
  const curEst = card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null;
  const endMin = startMin !== null && curEst !== null ? startMin + curEst : null;
  /** 框的範圍：end＝開始後一分起、到這一天的終點（現有結束更晚就放寬到它）；其餘＝這一天的日界線視窗 */
  const range =
    startMin !== null
      ? { min: startMin + 1, max: Math.max(dayRange.max, startMin + 1, endMin ?? 0) }
      : dayRange;
  /** 打開時的現值（rule＝每班／單發票的時刻；run＝這一班的有效時刻，覆寫成「不排」時退回每班；end＝開始＋長度） */
  const current = mode === "rule" ? card.ruleTime : isEnd ? (endMin !== null ? clockText(endMin) : null) : (card.time ?? card.ruleTime);
  const currentMin = current !== null ? clockMinutes(current) : null;
  const initial =
    currentMin !== null && currentMin >= range.min && currentMin <= range.max
      ? currentMin
      : startMin !== null
        ? Math.min(startMin + END_SEED_MIN, range.max)
        : prefill(dayDate, dayStartHour, now);

  const [min, setMin] = useState(initial);
  const [est, setEst] = useState<number | null>(card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customRaw, setCustomRaw] = useState(() =>
    card.estimateMin !== null && card.estimateMin > 0 && !EST_SEGS.some((v) => Number(v) === card.estimateMin)
      ? String(card.estimateMin)
      : "",
  );
  const composing = useRef(false);
  const clock = useRef<ClockInputHandle>(null);

  /** ClockInput 的毫秒 → 營業日分鐘（夾在 [lo, hi] 裡，一定換得回來；萬一換不回來就留原值） */
  const minOf = (ms: number): number => {
    // end 的範圍可能超過這一天的日界線視窗（長度很長）：照 refDay 起算的牆鐘分鐘換（側板 clockValue 同一支）
    if (isEnd) {
      const t = msToClock(ms, dayDate);
      return (t !== null ? clockMinutes(t) : null) ?? min;
    }
    return nowClockMinutes(dayDate, dayStartHour, ms) ?? min;
  };

  const time = clockText(min) ?? "";
  const wrapped = min >= 1440;
  const settled = card.done || card.suspended;
  const past = !isEnd && !settled && !card.doing && isClockPast(dayDate, time, now);
  const sumEst = mode === "rule" ? est : card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null;
  const arrive = sumEst !== null ? arrivalClock(time, sumEst) : null;

  const ruleTime = card.ruleTime;
  const estSeg = est !== null && !customOpen ? (EST_SEGS.find((v) => Number(v) === est) ?? null) : null;
  const customOn = est !== null && estSeg === null;

  const commit = () => {
    // 框裡有沒打完的字：先套用（打錯＝還原＋抖一下，不送）
    let t = time;
    const h = clock.current;
    if (h?.dirty()) {
      const v = h.flush();
      if (v === null) return;
      t = clockText(minOf(v)) ?? time;
    }
    if (isEnd) {
      // end：結束−開始＝新長度（範圍已擋掉等於或早於開始）；沒變就直接關
      const m = clockMinutes(t);
      const len = m !== null && startMin !== null && m > startMin ? m - startMin : null;
      if (len === null || len === curEst) {
        onClose();
        return;
      }
      onCommit(t, len);
      return;
    }
    if (mode === "rule") {
      const timeSame = current === t;
      const estSame = est === (card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null);
      if (timeSame && estSame) {
        onClose();
        return;
      }
      onCommit(t, estSame ? undefined : est);
      return;
    }
    // run：選的就是每班時刻
    if (ruleTime !== null && t === ruleTime) {
      if (card.timeOverridden && onReset) onReset();
      else onClose();
      return;
    }
    if (card.timeOverridden && card.time === t) {
      onClose();
      return;
    }
    onCommit(t);
  };

  const onCustomKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  const onCustomChange = (raw: string) => {
    setCustomRaw(raw);
    const v = Number.parseInt(raw, 10);
    setEst(Number.isFinite(v) && v > 0 ? Math.min(v, EST_MAX) : null);
  };

  const title = mode === "rule" ? "幾點発車" : isEnd ? "結束時刻" : "本班改時刻";

  return (
    <MSheet
      title={`${title}・${card.name}`}
      backId={backId}
      onClose={onClose}
      foot={
        <>
          {isEnd ? null : mode === "rule" ? (
            <button type="button" className="ns-btn btn-ghost" onClick={onClear}>
              不排時刻
            </button>
          ) : (
            <>
              <button type="button" className="ns-btn btn-ghost" onClick={onClear}>
                本班不排時刻
              </button>
              {card.timeOverridden && onReset && (
                <button type="button" className="ns-btn btn-ghost" onClick={onReset}>
                  {ruleTime ? `改回每班 ${ruleTime}` : "改回每班時刻"}
                </button>
              )}
            </>
          )}
          <button type="button" className="ns-btn btn-seal" onClick={commit}>
            確定
          </button>
        </>
      }
    >
      {mode === "run" && card.railDate && (
        <p className="m-tms-note">
          只改 {mdw(card.railDate)} 這一班；{ruleTime ? `每班 ${ruleTime} 不動` : "每班時刻不動"}
        </p>
      )}

      <ClockInput
        variant="mobile"
        value={msOf(dayDate, min)}
        lo={msOf(dayDate, range.min)}
        hi={msOf(dayDate, range.max)}
        onChange={(ms) => setMin(minOf(ms))}
        label={mode === "rule" ? "預定時刻" : isEnd ? "結束時刻" : "本班時刻"}
        refDay={dayDate}
        handleRef={clock}
      />
      {wrapped && (
        <p className="m-tms-note is-wrap" aria-live="polite">
          早於日界線 {pad2(dayStartHour)}:00 算今天深夜，記為 {time}
        </p>
      )}

      {mode === "rule" && withLen && (
        <div className="m-tms-grp">
          <span className="techo-label">預計多久</span>
          <div className="m-tms-est">
            <Segmented
              compact
              options={EST_OPTS}
              value={estSeg}
              onChange={(v: EstSeg) => {
                setCustomOpen(false);
                // 再點選中的那段＝清掉（回「時間未定」；舊 chip 的手感）
                setEst((cur) => (cur === Number(v) ? null : Number(v)));
              }}
              aria-label="預計多久"
            />
            {customOpen ? (
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={EST_MAX}
                autoFocus
                value={customRaw}
                placeholder="45"
                aria-label="自訂預計（分）"
                onChange={(e) => onCustomChange(e.target.value)}
                onKeyDown={onCustomKey}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={() => {
                  composing.current = false;
                }}
                onBlur={() => setCustomOpen(false)}
                className="techo-input m-tms-custom"
              />
            ) : (
              <button
                type="button"
                className="chip ns-chip"
                aria-pressed={customOn}
                onClick={() => {
                  setCustomRaw(customOn && est !== null ? String(est) : "");
                  setCustomOpen(true);
                }}
              >
                {customOn && est !== null ? lenText(est) : "自訂…"}
              </button>
            )}
          </div>
        </div>
      )}

      {isEnd && startMin !== null ? (
        <p className="m-tms-sum">
          <b className="hm">{card.ruleTime}</b> 発 → <b className="hm">{time}</b> 着（{lenText(Math.max(1, min - startMin))}）
        </p>
      ) : (
        <p className="m-tms-sum">
          <b className="hm">{time}</b> 発
          {sumEst !== null && arrive ? (
            <>
              {" "}
              → <b className="hm">{arrive}</b> 着（{lenText(sumEst)}）
            </>
          ) : (
            "・時間未定"
          )}
          {past && <span className="m-tms-past">已過現在時刻</span>}
        </p>
      )}
    </MSheet>
  );
}
