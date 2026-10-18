/**
 * MobileTicket——手機的一列車票（v1.1.0 WP1 起；主線車次① 改吃票卡模型）。
 *
 * 為什麼另寫一支、不沿用桌機 TodayRow：桌機那一列是 `.ticket` 三欄票券（票根／票面／検印欄）＋
 *   hover 才現身的控件（執行日 chip、票種小字＝側板入口）＋拖曳把手；在 375px 寬的單欄裡
 *   票根 84px＋検印欄 76px 會把標題擠成兩三個字，而 hover 在觸控裝置上根本不存在。
 *   手機改成「一條票根色帶＋兩行文字＋右側 44px 印章區＋44px ⋯」，**語彙照搬、版面重排**：
 *     票根色＝route.color（無路線＝--route-none、虛線「臨」）、票號 No.MMDD-NN、
 *     誤點＝赭（--color-late）左緣＋「原定 M/D」＋「延誤 N 天」、繰越＝既有的繰越角印（SealCarryOver）、
 *     運休＝運休角印（SealSuspended）蓋在検印位、済＝済章（SealDone small，朱肉 filter 由 stamps.css 給）。
 *
 * 已知取捨（與桌機的差別，刻意）：
 *   - **不蓋延着／途中下車角印**：検印位被済／運休佔著、右側還有 ⋯，第三枚角印在 375px 裡只會疊字。
 *     誤點的語彙改由「赭色左緣＋赭 chip 原定 M/D＋延誤 N 天」承擔（桌機本來就同時畫這三件）；
 *     暫停（paused）只留 `.is-paused` 的整列退淡，検印位保持「検印」字樣＝還能蓋（別把入口藏掉）。
 *   - **不畫車廂格**（.cars 的小方格）：格子 ≤5 個在手機是 5 個 3px 的點，看不出來——只留「車票 n/N」數字。
 *   - **不開側板／完成卡**：票種小字（乘車券／定期券／臨時券）退成 meta 裡的純文字，不是按鈕。
 *
 * **主線車次①（契約 §3.7）**：props 改吃 `TicketCardModel`——今日子頁（`cardFromTodayRow`）與行程表串流
 *   （`cardFromDayRow`／`cardFromDue`）共用同一支，口徑全在 ticketCard.ts；本檔只畫欄位。DOM 與 class 與 v1.1.0 一個都不改，差別只有：
 *     - `card.serial === null` 不畫票號那一項（手機沒載過票號表，§0-1 第 12 條）
 *     - `card.late === "inday"`（串流原日的誤點票）畫「誤點中」chip＋「延誤 N 天」（原型 ticketEl :1016-1018）
 *     - `card.readOnly`（定期券歷史班次）⇒ 根 `.is-ro`、検印鈕 disabled（有章畫章、沒章畫「—」）、⋯ disabled
 *     - `!card.stampable && !card.readOnly` ⇒ 検印鈕仍可按，按了由 actions 吐 `card.stampHint`（toast）
 *
 * **主線②（契約 §4.5-1、D-主-12）**：meta 第一格是預定時刻 `span.tm`——`14:00 発・90 分`（沒填預計＝`14:00 発`）、
 *   跨日加緊湊小字「隔天01:00」、逐班覆寫加靛字「本班」。已過時刻、沒入鋏也沒蓋済（運休也算交代）⇒ `.tm.past` 轉赭
 *   （只換字色；誤點卡照印原時刻、多半就是赭，§0-1 第 19 條）。`now` 由呼叫端的 `useMinuteTick()` 給——一頁一個節拍，
 *   不每張卡各掛計時器。有時刻就不另印「預計 N 分」（併進 `.hz`）；本元件原本就不印預計，所以沒有要拿掉的項。
 */
import type { ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { isClockPast, nextDayNote } from "../../lib/date";
import { SealCarryOver, SealDone, SealSuspended } from "../stamps";
import type { TicketCardModel } from "../schedule/ticketCard";

/** YYYY-MM-DD → M/D（票面 chip 用） */
function mmdd(key: string): string {
  const p = key.split("-");
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : key;
}

/** 兩個日期 key 相差幾天（a − b）；不經 Date.parse，避免 date-only 被當 UTC 而跨日 */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()) / 86_400_000);
}

export interface MobileTicketProps {
  card: TicketCardModel;
  /** 票根的路線（代碼／色／名）；undefined＝無路線的臨時車票 */
  route: NodeRow | undefined;
  /** 「延誤 N 天」的基準（日界線今天） */
  today: string;
  /** 剛蓋章 → 播 stampIn */
  fresh: boolean;
  onComplete(card: TicketCardModel): void;
  /** ⋯＝開底部 sheet */
  onMore(card: TicketCardModel): void;
  /** useMinuteTick() 的現在（已過時刻轉赭用；主線② 契約 §3.7） */
  now: number;
}

/**
 * 票面時刻（D-主-12；結構同桌機 §4.3 的 `.tm`）。`card.time === null` ⇒ 不畫。
 * 赭的條件（自決）：沒交代（済／運休）、沒入鋏、`now ≥ 執行日＋時刻`。執行日＝`card.railDate`（誤點卡＝原定那天）。
 */
export function TicketTime({ card, today, now }: { card: TicketCardModel; today: string; now: number }) {
  const t = card.time;
  if (t === null) return null;
  const settled = card.done || card.suspended;
  const past = !settled && !card.doing && isClockPast(card.railDate ?? today, t, now);
  const nx = nextDayNote(t);
  const est = card.estimateMin !== null && card.estimateMin > 0 ? card.estimateMin : null;
  return (
    <span className={"tm" + (past ? " past" : "")} title={past ? "已過發車時刻、還沒入鋏也沒蓋済" : "預定時刻"}>
      <span className="hm">{t}</span>
      <span className="hz">発{est !== null && `・${est} 分`}</span>
      {/* 手機用緊湊寫法「隔天01:00」（原型 timeHTML compactNx） */}
      {nx && <span className="nx">{nx.replace(" ", "")}</span>}
      {card.timeOverridden && (
        <span className="once" title="只改了這一班的時刻">
          本班
        </span>
      )}
    </span>
  );
}

export function MobileTicket({ card, route, today, fresh, onComplete, onMore, now }: MobileTicketProps) {
  const { done, suspended, paused, late, railDate, readOnly } = card;
  const settled = done || suspended;

  const accent = route?.color ?? "var(--route-none)";
  const badge = route?.code ?? (route ? route.name.slice(0, 1) : "臨");
  const lineName = route?.name ?? "無路線";

  /* meta 第二行：路線名 ・ 票號 ・（誤點語彙／規則／子項）；用陣列串「・」，空項不留分隔 */
  const meta: ReactNode[] = [];
  if (card.time !== null) meta.push(<TicketTime card={card} today={today} now={now} />);
  meta.push(<span className="m-tk-line">{lineName}</span>);
  if (card.serial !== null) meta.push(<span className="m-tk-serial">No.{card.serial}</span>);
  meta.push(<span>{card.fare}</span>);
  if (late === "carry" && railDate) {
    meta.push(<span className="m-tk-chip is-late">原定 {mmdd(railDate)}</span>);
    if (!settled) meta.push(<span className="m-tk-late-note">延誤 {diffDays(today, railDate)} 天</span>);
  }
  if (late === "inday" && railDate) {
    meta.push(<span className="m-tk-chip is-late">誤點中</span>);
    meta.push(<span className="m-tk-late-note">延誤 {diffDays(today, railDate)} 天</span>);
  }
  // 締切浮上來的那一段（D-③-7）：沒排執行日、締切已到／已過；不蓋延着、只給赭 chip
  if (late === "due" && card.dueOn) meta.push(<span className="m-tk-chip is-late">締切 {mmdd(card.dueOn)}</span>);
  if (late !== "carry" && late !== "due" && card.dueOn) {
    meta.push(<span className={"m-tk-chip" + (card.dueOn <= today ? " is-late" : "")}>締切 {mmdd(card.dueOn)}</span>);
  }
  if (card.ruleText) meta.push(<span>{card.ruleText}</span>);
  if (card.children) {
    meta.push(
      <span>
        {card.kind === "train" ? "車廂" : "車票"} {card.children.done}/{card.children.total}
      </span>,
    );
  }
  // 繰越＝來歷不是結局：済蓋下後由 CSS 淡到 .38（沿桌機 .ticket.done .carry-seal 的規則）
  if (card.carriedFrom) {
    meta.push(<SealCarryOver className="m-tk-seal-inline" title={`自 ${mmdd(card.carriedFrom)} 繰越`} />);
  }

  return (
    <li className="m-tk-li">
      <article
        className={
          "m-tk" +
          (late !== null && !settled ? " is-late-t" : "") +
          (done ? " is-done" : "") +
          (suspended ? " is-suspended" : "") +
          (paused ? " is-paused" : "") +
          (readOnly ? " is-ro" : "")
        }
      >
        {/* 票根：只留一條路線色帶＋代碼（桌機那一欄的路線名／票號移到 meta 行） */}
        <span className="m-tk-stub" style={{ color: accent }} aria-hidden>
          <span className={route ? "m-tk-badge" : "m-tk-badge is-dashed"}>{badge}</span>
        </span>

        <div className="m-tk-body">
          {/* 標題在手機一律排印：桌機「臨時券＝手寫體」那條有 [data-theme="dark"] 的退回規則（銀河不手寫），
              手機要複製就得在 mobile.css 寫主題覆寫——違反 WP0「本檔不寫 [data-theme] 覆寫」的紀律；
              而 375px 寬的兩行標題用手寫體本來就難讀。臨時券的身分由 meta 的「臨時券」與虛線「臨」票根承擔。 */}
          <p className="m-tk-title">{card.name}</p>
          <div className="m-tk-meta">
            {/* 分隔的「・」跟在**前**一項後面（不是下一項前面）：meta 在 375px 常常換行，
                分隔號放前綴時換行後的第二行會以「・」開頭；放後綴則是上一行以「・」收尾＝續行的提示。 */}
            {meta.map((it, i) => (
              <span key={i} className="m-tk-mi">
                {it}
                {i < meta.length - 1 && (
                  <span className="m-tk-sep" aria-hidden>
                    ・
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>

        {/* 検印區＝44px 觸控目標（鐵則 5）。単擊＝済／取消済／取消運休（分支由 actions 決定）；唯讀列不可按 */}
        <button
          type="button"
          aria-label={readOnly ? "唯讀" : suspended ? "取消本班運休" : done ? "取消完成" : "蓋章完成"}
          aria-pressed={done}
          disabled={readOnly}
          onClick={() => onComplete(card)}
          className="m-tk-stamp"
        >
          {suspended ? (
            <SealSuspended className="m-tk-seal-zone" title="運休（本班停駛）" />
          ) : done ? (
            <SealDone small fresh={fresh} className="m-tk-seal-zone" title="済" />
          ) : (
            <span className="m-tk-hint" aria-hidden>
              {readOnly ? "—" : "検印"}
            </span>
          )}
        </button>

        {/* ⋯＝底部 sheet（四項＋定期券運休，P11）；唯讀列不開 */}
        <button
          type="button"
          aria-label={`更多動作——${card.name}`}
          disabled={readOnly}
          onClick={() => onMore(card)}
          className="m-tk-more"
        >
          <span aria-hidden>⋯</span>
        </button>
      </article>
    </li>
  );
}
