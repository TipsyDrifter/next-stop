/**
 * MobileTicket——今日視圖手機版的一列車票（v1.1.0；WP1）。
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
 * **定期券口徑（全站同一把尺，照 TodayRow 檔頭）**：是不是定期券＝`parseRule(repeat_rule) !== null`；
 *   済了沒＝`occurrence ? occurrence.status==='done' : status==='done'`；
 *   這一列在講哪一天＝`occurrence?.due_on ?? scheduled_on`（蓋済後 scheduled_on 已被引擎推到下一班）。
 */
import type { ReactNode } from "react";
import { describeRule, parseRule, type NodeRow } from "../../domain";
import type { TodayRow as TodayRowData } from "../../data";
import { SealCarryOver, SealDone, SealSuspended } from "../stamps";

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
  row: TodayRowData;
  /** 票根的路線（代碼／色／名）；undefined＝無路線的臨時車票 */
  route: NodeRow | undefined;
  /** 這份今日資料算的是哪一天 */
  dateKey: string;
  /** 剛蓋章 → 播 stampIn */
  fresh: boolean;
  onComplete(id: string): void;
  /** ⋯＝開底部 action sheet */
  onMore(id: string): void;
}

export function MobileTicket({ row, route, dateKey, fresh, onComplete, onMore }: MobileTicketProps) {
  const rule = parseRule(row.repeat_rule);
  const done = row.occurrence ? row.occurrence.status === "done" : row.status === "done";
  const suspended = row.occurrence?.status === "skipped";
  const settled = done || suspended;
  const paused = row.status === "paused" && !settled;
  const late = row.bucket === "late";
  const due = row.bucket === "due";
  /** 這一列在講的那一天（定期券吃班次日，其餘吃 scheduled_on） */
  const railDate = row.occurrence?.due_on ?? row.scheduled_on;

  const accent = route?.color ?? "var(--route-none)";
  const badge = route?.code ?? (route ? route.name.slice(0, 1) : "臨");
  const lineName = route?.name ?? "無路線";
  const fare = rule ? "定期券" : row.parent_id === null ? "臨時券" : "乘車券";

  /* meta 第二行：路線名 ・ 票號 ・（誤點語彙／規則／子項）；用陣列串「・」，空項不留分隔 */
  const meta: ReactNode[] = [
    <span className="m-tk-line">{lineName}</span>,
    <span className="m-tk-serial">No.{row.serial}</span>,
    <span>{fare}</span>,
  ];
  if (late && railDate) {
    meta.push(<span className="m-tk-chip is-late">原定 {mmdd(railDate)}</span>);
    if (!settled) meta.push(<span className="m-tk-late-note">延誤 {diffDays(dateKey, railDate)} 天</span>);
  }
  // 締切浮上來的那一段（D-③-7）：沒排執行日、締切已到／已過；不蓋延着、只給赭 chip
  if (due && row.due_on) meta.push(<span className="m-tk-chip is-late">締切 {mmdd(row.due_on)}</span>);
  if (!late && !due && row.due_on) {
    meta.push(<span className={"m-tk-chip" + (row.due_on <= dateKey ? " is-late" : "")}>締切 {mmdd(row.due_on)}</span>);
  }
  if (rule) meta.push(<span>{describeRule(rule)}</span>);
  if (row.child_total > 0) {
    meta.push(
      <span>
        {row.kind === "train" ? "車廂" : "車票"} {row.child_done}/{row.child_total}
      </span>,
    );
  }
  // 繰越＝來歷不是結局：済蓋下後由 CSS 淡到 .38（沿桌機 .ticket.done .carry-seal 的規則）
  if (row.carried_from) {
    meta.push(<SealCarryOver className="m-tk-seal-inline" title={`自 ${mmdd(row.carried_from)} 繰越`} />);
  }

  return (
    <li className="m-tk-li">
      <article
        className={
          "m-tk" +
          ((late || due) && !settled ? " is-late-t" : "") +
          (done ? " is-done" : "") +
          (suspended ? " is-suspended" : "") +
          (paused ? " is-paused" : "")
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
          <p className="m-tk-title">{row.name}</p>
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

        {/* 検印區＝44px 觸控目標（鐵則 5）。単擊＝済／取消済／取消運休（分支見 useMobileToday.complete） */}
        <button
          type="button"
          aria-label={suspended ? "取消本班運休" : done ? "取消完成" : "蓋章完成"}
          aria-pressed={done}
          onClick={() => onComplete(row.id)}
          className="m-tk-stamp"
        >
          {suspended ? (
            <SealSuspended className="m-tk-seal-zone" title="運休（本班停駛）" />
          ) : done ? (
            <SealDone small fresh={fresh} className="m-tk-seal-zone" title="済" />
          ) : (
            <span className="m-tk-hint" aria-hidden>
              検印
            </span>
          )}
        </button>

        {/* ⋯＝底部 action sheet（v1.1.0 只有「推遲到明天」一項；拖曳排序／刪除不做） */}
        <button type="button" aria-label={`更多動作——${row.name}`} onClick={() => onMore(row.id)} className="m-tk-more">
          <span aria-hidden>⋯</span>
        </button>
      </article>
    </li>
  );
}
