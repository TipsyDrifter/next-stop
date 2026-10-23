/**
 * MobileTimeSheet——手機設預定時刻的底部 sheet（主線②；D-主-14、契約 §4.5-4；原型 `:1264-1350`）。
 *
 * 從 ⋯ sheet 的「幾點…」「每班時刻…」（mode="rule"）或「本班改時刻…」（mode="run"）開進來；DOM 沿兩子頁共用的
 * `.m-sheet-veil.techo-veil > .m-sheet.techo-card[role=dialog]`（UI 丙-1 前是退役的暖棕小卡）。由上而下：
 *   標題「幾點発車　·　票名」／「本班改時刻　·　票名」＋（run）「只改 M/D（週X）這一班；每班 07:00 不動」
 *   .ts-top    會存成的時刻（大字；營業日表記照寫）＋小字「＝隔天 01:00」「発」或赭「已過現在時刻」
 *   .ts-note   滾到日界線以後的小時（≥ 24）時：「比日界線 06:00 早＝算今天的深夜，記成 25:00」——**永遠佔一行**，
 *              出現／消失不推動下面的滾輪（手指正按在滾輪上，版面一跳 snap 就落錯格）
 *   常用時刻 chip（4 欄）→ 滾輪 MobileWheel → （rule）預計多久 chip（15／30／60／90／120／自訂）
 *   .ts-sum    「14:00 発 → 15:30 着（90 分）」／「・長度未定」
 *   .ts-foot   rule：「不排時刻」＋「確定」；run：「本班不排時刻」＋（覆寫中）「改回每班 07:00」＋「確定」
 *              （UI 丙-1：次鈕＝.ns-btn.btn-ghost、「確定」＝主鈕 .ns-btn.btn-seal；.ts-ghost 只剩佈局鉤子、舊的實心靛「確定」class 退役）
 *
 * 值：滾輪一定帶值（D-主-14）⇒ 「不排時刻」是一顆**直接送出**的鈕（原型 data-tclear 同款），不是切換狀態。
 *   所以契約寫的 `.ts-big.is-none`（「不排時刻」／「照每班」大字）在這支沒有出現的時機，沒有畫。
 * 預帶值（✎ 契約 §4.5-3）：有時刻＝現值；沒時刻 ⇒ rule：現在＋30 分向上取到 5 分、夾進這一天的範圍；現在不在這張卡的
 *   那一天（卡是別天的班）⇒ 09:00；run：每班時刻（沒有 ⇒ 同 rule）。
 * 確定：
 *   rule ⇒ `onCommit(time, estimateMin)`——預計沒變就不帶（`undefined`），值都沒變就直接關、不寫
 *   run  ⇒ 選的就是每班時刻 ⇒ 本來就照每班：直接關；覆寫中：等於「改回每班」（`onReset`，原型 commitSheet 同款）；
 *          其餘 `onCommit(time)` ⇒ setRunTime
 * 收據 toast 在呼叫端的動作（scheduleActions／useMobileToday），本元件不碰 store。
 * IME：自訂預計的數字框照三道護欄（isComposing／229／composition 旗標）；Enter＝收起鍵盤，不送出整張 sheet。
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { arrivalClock, clockMinutes, clockRange, clockText, isClockPast, nextDayNote, nowClockMinutes } from "../../lib/date";
import { mdw } from "../schedule/streamModel";
import type { TicketCardModel } from "../schedule/ticketCard";
import { MobileWheel } from "./MobileWheel";

/** 常用時刻 chip（✎ 契約 §4.5-4）；不在這一天範圍內的不出 */
const CHIP_TIMES = ["09:00", "10:00", "13:00", "14:00", "15:00", "16:00", "19:00", "21:00"];
/** 預計 chip（分） */
const EST_CHIPS = [15, 30, 60, 90, 120];
const EST_MAX = 600;
/** 現在不在那一天時的預帶值 09:00 */
const NINE = 9 * 60;

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

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
  /** rule＝單發票的時刻／定期券的每班時刻（＋預計）；run＝定期券這一班 */
  mode: "rule" | "run";
  /** 日界線今天 */
  today: string;
  dayStartHour: number;
  /** useMinuteTick() 的現在 */
  now: number;
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

export function MobileTimeSheet({ card, mode, today, dayStartHour, now, onCommit, onClear, onReset, onClose }: MobileTimeSheetProps) {
  const range = clockRange(dayStartHour);
  const dayDate = card.railDate ?? today;
  /** 打開時的現值（rule＝每班／單發票的時刻；run＝這一班的有效時刻，覆寫成「不排」時退回每班） */
  const current = mode === "rule" ? card.ruleTime : (card.time ?? card.ruleTime);
  const currentMin = current !== null ? clockMinutes(current) : null;
  const initial =
    currentMin !== null && currentMin >= range.min && currentMin <= range.max
      ? currentMin
      : prefill(dayDate, dayStartHour, now);

  const [min, setMin] = useState(initial);
  const [est, setEst] = useState<number | null>(card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customRaw, setCustomRaw] = useState(() =>
    card.estimateMin !== null && card.estimateMin > 0 && !EST_CHIPS.includes(card.estimateMin) ? String(card.estimateMin) : "",
  );
  const composing = useRef(false);

  const time = clockText(min) ?? "";
  const nx = nextDayNote(time);
  const wrapped = min >= 1440;
  const settled = card.done || card.suspended;
  const past = !settled && !card.doing && isClockPast(dayDate, time, now);
  const sumEst = mode === "rule" ? est : card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null;
  const arrive = sumEst !== null ? arrivalClock(time, sumEst) : null;

  const chips = useMemo(
    () =>
      CHIP_TIMES.map((t) => ({ t, m: clockMinutes(t) ?? -1 }))
        .map((c) => (c.m < range.min ? { ...c, m: c.m + 1440, t: clockText(c.m + 1440) ?? c.t } : c))
        .filter((c) => c.m >= range.min && c.m <= range.max),
    [range.min, range.max],
  );

  const ruleTime = card.ruleTime;
  const customOn = est !== null && !EST_CHIPS.includes(est);

  const commit = () => {
    if (mode === "rule") {
      const timeSame = current === time;
      const estSame = est === (card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null);
      if (timeSame && estSame) {
        onClose();
        return;
      }
      onCommit(time, estSame ? undefined : est);
      return;
    }
    // run：選的就是每班時刻
    if (ruleTime !== null && time === ruleTime) {
      if (card.timeOverridden && onReset) onReset();
      else onClose();
      return;
    }
    if (card.timeOverridden && card.time === time) {
      onClose();
      return;
    }
    onCommit(time);
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

  const title = mode === "rule" ? "幾點発車" : "本班改時刻";

  return (
    <div className="m-sheet-veil techo-veil" role="presentation" onClick={onClose}>
      <div
        className="m-sheet techo-card ts-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${title}——${card.name}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <p className="m-sheet-title">
          {title}　·　{card.name}
        </p>
        <div className="ts">
          {mode === "run" && card.railDate && (
            <p className="ts-note ts-run">
              只改 {mdw(card.railDate)} 這一班；{ruleTime ? `每班 ${ruleTime} 不動` : "每班時刻不動"}
            </p>
          )}

          <div className="ts-top" aria-live="polite">
            <span className="ts-big">{time}</span>
            <span className="ts-sub">
              {nx && (
                <>
                  ＝隔天 <b className="hm">{nx.replace("隔天 ", "")}</b>
                  <br />
                </>
              )}
              {past ? <span className="ts-past">已過現在時刻</span> : "発"}
            </span>
          </div>
          {/* 永遠佔一行（理由見檔頭） */}
          <p className={"ts-note" + (wrapped ? " wrap" : "")} aria-live="polite">
            {wrapped ? `早於日界線 ${pad2(dayStartHour)}:00 算今天深夜，記為 ${time}` : " "}
          </p>

          <div className="ts-lbl">常用時刻</div>
          <div className="ts-chips">
            {chips.map((c) => (
              <button
                key={c.t}
                type="button"
                className={
                  "ts-chip" + (c.m === min ? " on" : "") + (!settled && isClockPast(dayDate, c.t, now) ? " is-past" : "")
                }
                aria-pressed={c.m === min}
                onClick={() => setMin(c.m)}
              >
                {c.t}
              </button>
            ))}
          </div>

          <MobileWheel value={min} dayStartHour={dayStartHour} onChange={setMin} />

          {mode === "rule" && (
            <>
              <div className="ts-lbl">預計多久</div>
              <div className="ts-chips est">
                {EST_CHIPS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className={"ts-chip" + (est === e ? " on" : "")}
                    aria-pressed={est === e}
                    onClick={() => {
                      setCustomOpen(false);
                      setEst((cur) => (cur === e ? null : e));
                    }}
                  >
                    {e}
                    <small>分</small>
                  </button>
                ))}
                {customOpen ? (
                  <span className="ts-custom">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={EST_MAX}
                      autoFocus
                      value={customRaw}
                      placeholder="45"
                      aria-label="自訂時間（分）"
                      onChange={(e) => onCustomChange(e.target.value)}
                      onKeyDown={onCustomKey}
                      onCompositionStart={() => {
                        composing.current = true;
                      }}
                      onCompositionEnd={() => {
                        composing.current = false;
                      }}
                      onBlur={() => setCustomOpen(false)}
                    />
                  </span>
                ) : (
                  <button
                    type="button"
                    className={"ts-chip word" + (customOn ? " on" : "")}
                    aria-pressed={customOn}
                    onClick={() => {
                      setCustomRaw(customOn && est !== null ? String(est) : "");
                      setCustomOpen(true);
                    }}
                  >
                    {customOn ? `${est} 分` : "自訂"}
                  </button>
                )}
              </div>
            </>
          )}

          <div className="ts-sum">
            <b className="hm">{time}</b> 発
            {sumEst !== null && arrive ? (
              <>
                {" "}
                → <b className="hm">{arrive}</b> 着（{sumEst} 分）
              </>
            ) : (
              "・時間未定"
            )}
          </div>

          <div className="ts-foot">
            {mode === "rule" ? (
              <button type="button" className="ns-btn btn-ghost ts-ghost" onClick={onClear}>
                不排時刻
              </button>
            ) : (
              <>
                <button type="button" className="ns-btn btn-ghost ts-ghost" onClick={onClear}>
                  本班不排時刻
                </button>
                {card.timeOverridden && onReset && (
                  <button type="button" className="ns-btn btn-ghost ts-ghost" onClick={onReset}>
                    {ruleTime ? `改回每班 ${ruleTime}` : "改回每班時刻"}
                  </button>
                )}
              </>
            )}
            <button type="button" className="ns-btn btn-seal" onClick={commit}>
              確定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
