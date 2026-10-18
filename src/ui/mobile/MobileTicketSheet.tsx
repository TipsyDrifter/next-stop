/**
 * MobileTicketSheet——手機票卡 ⋯ 的底部 sheet（主線車次①；P11、契約 §4.6）。兩子頁共用：
 *   今日子頁：onDefer ⇒ useMobileToday.defer、onSkip ⇒ useMobileToday.skip
 *   行程表串流：onDefer ⇒ scheduleActions.defer、onSkip ⇒ scheduleActions.suspend
 *
 * 為什麼是底部 sheet 而不是桌機那張 DeferPopover：小卡是 anchor 定位＋日期選擇＋定期券分支的完整浮層，
 *   一張錨在票旁的小卡在 375px 會遮住列；底部 sheet 拇指按得到、暗幕點哪都關得掉。
 *   「取消」是清清楚楚的一格，不只依賴點暗幕——觸控裝置上暗幕關閉是隱性知識。
 *
 * 項目（由上而下；原型 openTicketSheet :1655-1672 的文案）：
 *   定期券且非唯讀 ｜「本班運休」或「取消運休」（card.suspended 決定）＋ aside railDate。不出「編輯規則…」（手機沒有側板）
 *   已交代的非定期券｜一行說明「已蓋済——先取消済章才能推遲」（不可點）
 *   其餘            ｜①推遲到明天／往後推一天／排到明天（sheetDeferItems）②下週一 ③選日期…（共用 MobileDatePicker，min＝今天）
 *                    ④清除執行日（aside：回到締切 M/D／進收件匣；本來就沒排 ⇒ 不可點的一行）
 * DOM 沿 v1.1.0 的 MobileActionSheet（`.m-sheet-veil.techo-veil > .m-sheet.ns-card`）。
 * 「選日期…」不翻成原型那張月曆 sheet，改開共用的 `MobileDatePicker`（旅客筆記車次② 抽出的共用件；接縫 33）。
 *
 * **主線②（契約 §4.5-3）**：時刻項。
 *   非定期券、未交代｜「選日期…」之後插「幾點…」（aside：`14:00・90 分`／「未排」）→ 開 MobileTimeSheet（rule）
 *   定期券、非唯讀  ｜最上面「本班改時刻…」（aside：覆寫中「本班 09:30」／「本班 不排時刻」，否則「每班 07:00」）→ run；
 *                    「每班時刻…」（aside「07:00」／「未排」）→ rule（原型沒畫，雙端同等補——桌機側板的「幾點」就是每班，✎）
 *   已交代的非定期券、唯讀卡｜不出時刻項（唯讀卡的 ⋯ 本來就 disabled）。
 *   時刻 sheet 與「選日期…」同一種接法：本 sheet 收起、改畫子面板；子面板關了＝整個流程結束。
 */
import { useState } from "react";
import { MobileDatePicker } from "../common/MobileDatePicker";
import { useUiStore } from "../../store/uiStore";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { MobileTimeSheet } from "./MobileTimeSheet";
import { mdw, sheetDeferItems } from "../schedule/streamModel";
import type { TicketCardModel } from "../schedule/ticketCard";
// 各線附加項：查 `lines/runtime`、不 import `lines/mounts`（理由見 runtime.ts 檔頭）
import { lineTicketSheetItems } from "../../lines/runtime";

/** M/D（aside 的「回到締切 M/D」） */
function md(key: string): string {
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
}

export interface MobileTicketSheetProps {
  card: TicketCardModel;
  today: string;
  /** null＝清除執行日 */
  onDefer(day: string | null): void;
  /** 定期券版：本班運休（true）／取消運休（false） */
  onSkip(skip: boolean): void;
  /** 每班／單發票的時刻（＋預計）；time=null＝不排時刻；estimateMin 為 undefined＝預計沒變（主線②） */
  onSetTime(time: string | null, estimateMin?: number | null): void;
  /** 定期券這一班的時刻；null＝本班不排時刻 */
  onSetRunTime(time: string | null): void;
  /** 定期券這一班改回每班時刻 */
  onClearRunTime(): void;
  onClose(): void;
}

export function MobileTicketSheet({
  card,
  today,
  onDefer,
  onSkip,
  onSetTime,
  onSetRunTime,
  onClearRunTime,
  onClose,
}: MobileTicketSheetProps) {
  /** 「選日期…」按下去：sheet 收起、改開日期面板（面板關了＝整個流程結束） */
  const [picking, setPicking] = useState(false);
  /** 「幾點…」「每班時刻…」（rule）／「本班改時刻…」（run）按下去：改畫時刻 sheet */
  const [timeMode, setTimeMode] = useState<"rule" | "run" | null>(null);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const now = useMinuteTick();

  if (timeMode) {
    return (
      <MobileTimeSheet
        card={card}
        mode={timeMode}
        today={today}
        dayStartHour={dayStartHour}
        now={now}
        onCommit={(time, est) => {
          if (timeMode === "run") onSetRunTime(time);
          else onSetTime(time, est);
          onClose();
        }}
        onClear={() => {
          if (timeMode === "run") onSetRunTime(null);
          else if (card.ruleTime !== null) onSetTime(null);
          onClose();
        }}
        onReset={
          timeMode === "run"
            ? () => {
                onClearRunTime();
                onClose();
              }
            : undefined
        }
        onClose={onClose}
      />
    );
  }

  if (picking) {
    return (
      <MobileDatePicker
        title="選擇執行日"
        value={card.scheduledOn}
        min={today}
        quick={[]}
        onPick={(d) => {
          onDefer(d);
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  const settled = card.done || card.suspended;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  /** aside 的時刻字（拉丁數字，.hm） */
  const hm = (t: string) => <b className="hm">{t}</b>;
  const est = card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null;

  let items;
  if (card.isRepeat && !card.readOnly) {
    items = (
      <>
        {card.railDate && (
          <button type="button" onClick={() => setTimeMode("run")} className="m-sheet-item m-sch-row">
            本班改時刻…
            <span className="m-sch-aside">
              {card.timeOverridden ? (
                <>本班 {card.time !== null ? hm(card.time) : "不排時刻"}</>
              ) : card.ruleTime !== null ? (
                <>每班 {hm(card.ruleTime)}</>
              ) : (
                "未排"
              )}
            </span>
          </button>
        )}
        <button type="button" onClick={() => setTimeMode("rule")} className="m-sheet-item m-sch-row">
          每班時刻…
          <span className="m-sch-aside">{card.ruleTime !== null ? hm(card.ruleTime) : "未排"}</span>
        </button>
        <button type="button" onClick={run(() => onSkip(!card.suspended))} className="m-sheet-item m-sch-row">
          {card.suspended ? "取消運休" : "本班運休"}
          {card.railDate && <span className="m-sch-aside">{mdw(card.railDate)}</span>}
        </button>
      </>
    );
  } else if (card.readOnly) {
    // 最後一道守門：定期券的歷史班次不出單發票那組項目（推遲／幾點…／清除執行日）
    items = <p className="m-sheet-item is-disabled">歷史班次唯讀</p>;
  } else if (settled) {
    items = <p className="m-sheet-item is-disabled">已蓋済——先取消済章才能推遲</p>;
  } else {
    const { first, monday } = sheetDeferItems(card.railDate, card.scheduledOn, today);
    items = (
      <>
        <button type="button" onClick={run(() => onDefer(first.day))} className="m-sheet-item m-sch-row">
          {first.label}
          <span className="m-sch-aside">{mdw(first.day)}</span>
        </button>
        <button type="button" onClick={run(() => onDefer(monday))} className="m-sheet-item m-sch-row">
          下週一<span className="m-sch-aside">{mdw(monday)}</span>
        </button>
        <button type="button" onClick={() => setPicking(true)} className="m-sheet-item">
          選日期…
        </button>
        <button type="button" onClick={() => setTimeMode("rule")} className="m-sheet-item m-sch-row">
          幾點…
          <span className="m-sch-aside">
            {card.ruleTime !== null ? (
              <>
                {hm(card.ruleTime)}
                {est !== null && `・${est} 分`}
              </>
            ) : (
              "未排"
            )}
          </span>
        </button>
        {card.scheduledOn === null ? (
          <p className="m-sheet-item is-disabled">清除執行日（本來就沒排）</p>
        ) : (
          <button type="button" onClick={run(() => onDefer(null))} className="m-sheet-item m-sch-row">
            清除執行日
            <span className="m-sch-aside">{card.dueOn ? `回到締切 ${md(card.dueOn)}` : "進收件匣"}</span>
          </button>
        )}
      </>
    );
  }

  return (
    <div className="m-sheet-veil techo-veil" role="presentation" onClick={onClose}>
      <div
        className="m-sheet ns-card"
        role="dialog"
        aria-modal="true"
        aria-label={`車票動作——${card.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="m-sheet-title">{card.name}</p>
        {items}
        {/* 各線附加項（接縫 #56 後半；旅客筆記：荷札…）——唯讀的卡（定期券歷史班次）不出 */}
        {!card.readOnly &&
          lineTicketSheetItems().map(({ id, Item }) => <Item key={id} nodeId={card.nodeId} name={card.name} close={onClose} />)}
        <button type="button" onClick={onClose} className="m-sheet-item is-cancel">
          取消
        </button>
      </div>
    </div>
  );
}
