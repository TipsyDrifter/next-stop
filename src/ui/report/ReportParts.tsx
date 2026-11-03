/**
 * 運行報告的內容（② 運行報告；契約 §3、§4）——桌機 ReportView 與手機 MobileReport 共用，`shell` 只換去處與少數排法。
 * 視覺真相＝prototypes/design-stats-review-運行報告.html?v=AC（桌機）／&device=mob（手機）。
 *
 * 結構：一年前的今天（有內容才出現）→ 五張卡（只答今天）→ 區段「每日運行實績」＋近 7／30 天 → 表格 → 圖例。
 * 守則：比較用中性 ▲▼（不用紅綠）；圖表墨色；朱只給済；赭只給誤點與締切；不寫「未記錄」、不寫連續天數、日記只標寫了的日子。
 * 互動：卡片右上「X ›」與卡內小元件各跳各的（§5）；表格整列＝那天的日記足跡；合計列不可點。
 * 每張卡是 <article>：滑鼠點卡的空白處＝跟右上連結同一個去處；鍵盤走裡面的按鈕（不做巢狀的互動元素）。
 */
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { deltaText, type OperationReport, type ReportDayRow, type ReportRow, type ReportSumRow } from "../../domain/report";
import { fmtDur } from "../../domain/timetable";
import { fmtDelta } from "../../domain/timetableStats";
import { moneyText } from "../../domain/ticket";
import { DateSeal, SealDone } from "../stamps";
import { GNAV_ICONS } from "../sidebar/gnavIcons";
import { Tabs } from "../common/Tabs";
import { goCalendar, goNode, goRoute, goToday, lineJump, type ReportShellKind } from "./reportJumps";
import type { ReportDays } from "../../store/reportStore";

const WEEK_ZH = "日一二三四五六";

function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const md = (key: string) => {
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
};
const wd = (key: string) => WEEK_ZH[dateOf(key).getDay()];

const money = (minor: number, dec: number) => moneyText(minor, dec, { whole: true });
const timeDelta = (ms: number) => fmtDelta(ms);

/** 路線小圓牌（票根語彙：路線色框＋代碼；臨時車票＝虛線「臨」） */
export function RouteBadge({ route, temp }: { route: { code: string | null; color: string | null; name: string } | null; temp?: boolean }) {
  if (!route || temp) {
    return (
      <span className="ns-rp-badge is-temp" aria-hidden="true">
        臨
      </span>
    );
  }
  return (
    <span className="ns-rp-badge" style={{ "--rc": route.color ?? "var(--route-preset-4)" } as CSSProperties} aria-hidden="true">
      {route.code ?? route.name.slice(0, 1)}
    </span>
  );
}

/** 一張卡：右上「X ›」是看得見的入口；點卡的空白處同一個去處 */
function Card({
  icon,
  name,
  go,
  goLabel,
  wide,
  children,
}: {
  icon: ReactNode;
  name: string;
  go: (() => void) | null;
  goLabel: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const onCard = (e: MouseEvent<HTMLElement>) => {
    if (!go || (e.target as HTMLElement).closest("button")) return;
    go();
  };
  return (
    <article className={`ns-rp-card${wide ? " is-wide" : ""}${go ? " is-link" : ""}`} onClick={onCard} aria-label={name}>
      <header className="ns-rp-ch">
        {icon}
        <span className="cn">{name}</span>
        {go && (
          <button type="button" className="go" onClick={go}>
            {goLabel} <span aria-hidden="true">›</span>
          </button>
        )}
      </header>
      {children}
    </article>
  );
}

function Cmp({ label, text }: { label: string; text: string }) {
  return (
    <p className="ns-rp-cmp">
      {label} <span className="d">{text}</span>
    </p>
  );
}

/* ═══════════ 一年前的今天 ═══════════ */

function YearAgo({ r, shell }: { r: OperationReport; shell: ReportShellKind }) {
  if (!r.yearAgo) return null;
  const { day, text } = r.yearAgo;
  const go = lineJump("notes", { diary: day }, shell);
  return (
    <button type="button" className="ns-rp-ago" onClick={go ?? undefined} disabled={!go}>
      <DateSeal date={dateOf(day)} size={shell === "mobile" ? 44 : 40} title={`日付印 ${day}`} />
      <span className="k">一年前的今天</span>
      <span className="t">{text}</span>
      {go && (
        <span className="go" aria-hidden="true">
          日記 ›
        </span>
      )}
    </button>
  );
}

/* ═══════════ 五張卡 ═══════════ */

function RideCard({ r, shell, routes }: { r: OperationReport; shell: ReportShellKind; routes: Readonly<Record<string, NodeRow>> }) {
  const c = r.ride;
  const max = Math.max(1, ...c.routes.map((x) => x.n));
  return (
    <Card icon={GNAV_ICONS.today(15)} name="乘車" go={() => goToday(shell)} goLabel="今日">
      <div className="ns-rp-big">
        <b className="num">{c.seals}</b>
        <span className="u">張済</span>
        {c.seals > 0 && <SealDone small className="ns-rp-seal" />}
      </div>
      {c.late > 0 && (
        <div className="ns-rp-kl">
          <button type="button" className="ns-rp-late" onClick={() => goToday(shell)}>
            誤點 <span className="n">{c.late}</span>
          </button>
        </div>
      )}
      {c.routes.length > 0 && (
        <div className="ns-rp-tops">
          <p className="ns-rp-mini">今天跑的路線</p>
          {c.routes.map((x) => {
            const route = x.routeId ? routes[x.routeId] ?? null : null;
            const name = route?.name ?? "臨時車票";
            const inner = (
              <>
                <RouteBadge route={route} temp={!route} />
                <span className="nm">{name}</span>
                <span className="tb" aria-hidden="true">
                  <i style={{ "--w": (x.n / max).toFixed(2) } as CSSProperties} />
                </span>
                <span className="num">{x.n}</span>
              </>
            );
            return route ? (
              <button key={x.routeId} type="button" className="ns-rp-top" onClick={() => void goRoute(route.id, shell)} aria-label={`${name} 済 ${x.n} 張`}>
                {inner}
              </button>
            ) : (
              <div key="temp" className="ns-rp-top" aria-label={`${name} 済 ${x.n} 張`}>
                {inner}
              </div>
            );
          })}
        </div>
      )}
      <Cmp label={`比上週${wd(r.today)}`} text={deltaText(c.cmp)} />
    </Card>
  );
}

function TimeCard({ r, shell }: { r: OperationReport; shell: ReportShellKind }) {
  const c = r.time!;
  const total = c.cats.reduce((a, x) => a + x.ms, 0);
  return (
    <Card icon={GNAV_ICONS.timetable(15)} name="時刻表" go={lineJump("timetable", "stats", shell)} goLabel="統計">
      <div className="ns-rp-big">
        <b className="num">{fmtDur(c.ms)}</b>
        <span className="u">已記錄</span>
      </div>
      {total > 0 && (
        <>
          <div className="ns-rp-stack" role="img" aria-label="分類占比">
            {c.cats.map((x, i) => (
              <i key={x.id} className={`s${i + 1}`} style={{ flexGrow: x.ms }} title={`${x.name} ${fmtDur(x.ms)}`} />
            ))}
          </div>
          <ul className="ns-rp-lg">
            {c.cats.map((x, i) => (
              <li key={x.id}>
                <i className={`s${i + 1}`} aria-hidden="true" />
                <span className="nm">{x.name}</span>
                <span className="num">{fmtDur(x.ms)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Cmp label={`比上週${wd(r.today)}`} text={timeDelta(c.cmp)} />
    </Card>
  );
}

function MoneyCard({ r, shell }: { r: OperationReport; shell: ReportShellKind }) {
  const c = r.money!;
  const stats = lineJump("ticket", "stats", shell);
  const b = c.budget;
  const monthN = b ? Number(b.month.slice(5, 7)) : 0;
  return (
    <Card icon={GNAV_ICONS.ticket(15)} name="售票口" go={stats} goLabel="看帳">
      <div className="ns-rp-big">
        <b className="amt">{money(c.spent, c.decimals)}</b>
        <span className="u">今天花了</span>
      </div>
      {c.topCats.length > 0 && (
        <div className="ns-rp-kl">
          {c.topCats.map((x, i) => (
            <span key={x.name} className="ns-rp-cat">
              {i > 0 && <span className="sep" aria-hidden="true">・</span>}
              {x.name} <b className="amt">{money(x.minor, c.decimals)}</b>
            </span>
          ))}
        </div>
      )}
      {b && (
        <button type="button" className="ns-rp-bud" onClick={stats ?? undefined} disabled={!stats}>
          <span className="bl">
            <span>
              {monthN}月預算{b.remaining >= 0 ? "剩" : "超出"}
            </span>
            <span>
              <b className="amt">{money(Math.abs(b.remaining), c.decimals)}</b> / {money(b.budget, c.decimals)}
            </span>
          </span>
          <span className="meter" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, b.budget > 0 ? (b.used / b.budget) * 100 : 0)).toFixed(1)}%` }} />
          </span>
        </button>
      )}
      <Cmp label={`比上週${wd(r.today)}`} text={deltaText(c.cmp, (n) => money(n, c.decimals))} />
    </Card>
  );
}

function NotesCard({ r, shell }: { r: OperationReport; shell: ReportShellKind }) {
  const c = r.notes!;
  const diary = c.diary ? lineJump("notes", { diary: r.today }, shell) : null;
  return (
    <Card icon={GNAV_ICONS.notes(15)} name="旅客筆記" go={lineJump("notes", "home", shell)} goLabel="筆記">
      <div className="ns-rp-big">
        <b className="num">{c.count}</b>
        <span className="u">則{c.diary ? "・寫了日記" : ""}</span>
      </div>
      {diary && (
        <div className="ns-rp-kl">
          <button type="button" className="ns-rp-link" onClick={diary}>
            看今天的日記 ›
          </button>
        </div>
      )}
      <Cmp label={`比上週${wd(r.today)}`} text={deltaText(c.cmp)} />
    </Card>
  );
}

function DueCard({ r, shell, routes }: { r: OperationReport; shell: ReportShellKind; routes: Readonly<Record<string, NodeRow>> }) {
  const c = r.due;
  return (
    <Card icon={GNAV_ICONS.calendar(15)} name="締切" go={() => goCalendar(shell)} goLabel="行程表" wide>
      <div className="ns-rp-big">
        <b className="num">{c.count}</b>
        <span className="u">個・7 天內</span>
      </div>
      {c.items.length > 0 && (
        <div className="ns-rp-due">
          {c.items.map((x, i) => (
            <button key={x.nodeId} type="button" className={`ns-rp-duer${i === 0 ? " is-first" : ""}`} onClick={() => void goNode(x.nodeId, shell)}>
              <span className="dd">
                {md(x.day)}
                <small>（{wd(x.day)}）</small>
              </span>
              <RouteBadge route={x.routeId ? routes[x.routeId] ?? null : null} temp={x.temp || !x.routeId} />
              <span className="nm">{x.name}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ═══════════ 每日運行實績 ═══════════ */

const DAY_TABS = [
  { key: "7", label: "近 7 天" },
  { key: "30", label: "近 30 天" },
] as const;

function Bar({ v, max }: { v: number; max: number }) {
  if (max <= 0) return null;
  return (
    <span className="tb" aria-hidden="true">
      <i style={{ "--w": Math.max(0, v / max).toFixed(2) } as CSSProperties} />
    </span>
  );
}

function DayRowView({ row, r, shell }: { row: ReportDayRow; r: OperationReport; shell: ReportShellKind }) {
  const go = lineJump("notes", { diary: row.day }, shell);
  const dec = r.money?.decimals ?? 0;
  const label = `${md(row.day)}（${wd(row.day)}）的日記足跡`;
  return (
    <button type="button" className={`ns-rp-row${row.isToday ? " is-today" : ""}`} onClick={go ?? undefined} disabled={!go} aria-label={go ? label : undefined}>
      <span className="rc-d">
        <span className="num">{md(row.day)}</span>
        <span className="wd">{wd(row.day)}</span>
        {row.isToday && <span className="today">今天</span>}
      </span>
      <span className="rc-c">
        <span className="l1">
          <span className="num">{row.seals}</span>
          {row.late > 0 && <span className="late">誤點 {row.late}</span>}
        </span>
        <Bar v={row.seals} max={r.max.seals} />
      </span>
      {row.timeMs !== null && (
        <span className="rc-c">
          <span className="l1">
            <span className="num">{fmtDur(row.timeMs)}</span>
          </span>
          <Bar v={row.timeMs} max={r.max.timeMs} />
        </span>
      )}
      {row.spent !== null && (
        <span className="rc-c">
          <span className="l1">
            <span className="amt">{money(row.spent, dec)}</span>
          </span>
          <Bar v={row.spent} max={r.max.spent} />
        </span>
      )}
      {row.notes !== null && (
        <span className="rc-c">
          <span className="l1">
            {row.notes > 0 ? <span className="num">{row.notes}</span> : <span className="zero">—</span>}
            {row.diary && <span className="dia" title="寫了日記" />}
          </span>
        </span>
      )}
      <span className="rc-c">
        <span className="l1">{row.due > 0 ? <span className="due">{row.due}</span> : <span className="zero">—</span>}</span>
      </span>
      {r.hasDayNotes && (
        <span className="rc-ev">
          {row.dayNotes.map((t, i) => (
            <span key={i} className="ev">
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function SumRowView({ row, r }: { row: ReportSumRow; r: OperationReport }) {
  const dec = r.money?.decimals ?? 0;
  const label = row.which === "this" ? "本週" : row.which === "last" ? "上週" : `${md(row.weekOf)}`;
  const sub = row.which === "week" ? " 那週" : "合計";
  const cmp = row.cmp;
  const c = (text: string | null) => (text !== null && cmp ? <span className="cmpx" title={row.cmpLabel ?? undefined}>{text}</span> : null);
  return (
    <div className={`ns-rp-row is-sum${row.reference ? " is-ref" : ""}`}>
      <span className="rc-d">
        {label}
        <span className="dk">{sub}</span>
      </span>
      <span className="rc-c">
        <span className="l1">
          <span className="num">{row.seals}</span>
          {c(cmp ? deltaText(cmp.seals) : null)}
        </span>
      </span>
      {row.timeMs !== null && (
        <span className="rc-c">
          <span className="l1">
            <span className="num">{fmtDur(row.timeMs)}</span>
            {c(cmp && cmp.timeMs !== null ? timeDelta(cmp.timeMs) : null)}
          </span>
        </span>
      )}
      {row.spent !== null && (
        <span className="rc-c">
          <span className="l1">
            <span className="amt">{money(row.spent, dec)}</span>
            {c(cmp && cmp.spent !== null ? deltaText(cmp.spent, (n) => money(n, dec)) : null)}
          </span>
        </span>
      )}
      {row.notes !== null && (
        <span className="rc-c">
          <span className="l1">
            <span className="num">{row.notes}</span>
            <span className="cmpx">日記 {row.diaryDays} 天</span>
          </span>
        </span>
      )}
      <span className="rc-c">
        <span className="l1">
          <span className="num">{row.due}</span>
        </span>
      </span>
      {r.hasDayNotes && <span className="rc-ev" />}
    </div>
  );
}

function ReportTable({ r, shell }: { r: OperationReport; shell: ReportShellKind }) {
  // 欄：日期｜乘車｜（時刻表）｜（售票口）｜（筆記）｜締切｜（記事）。桌機締切窄欄 64、記事寬欄；手機日期 46、其餘均分、記事改成跨整列一行
  const mid = 1 + (r.time ? 1 : 0) + (r.money ? 1 : 0) + (r.notes ? 1 : 0);
  const grid =
    shell === "desktop"
      ? `96px repeat(${mid}, minmax(0, 1fr)) 64px${r.hasDayNotes ? " minmax(0, 1.5fr)" : ""}`
      : `46px repeat(${mid + 1}, minmax(0, 1fr))`;
  const evCol = r.hasDayNotes && shell === "desktop";
  return (
    <>
      <div className="ns-rp-table" style={{ "--rp-grid": grid } as CSSProperties} role="group" aria-label="每日運行實績">
        <div className="ns-rp-row is-head" aria-hidden="true">
          <span>日期</span>
          <span>
            {GNAV_ICONS.today(14)}乘車
          </span>
          {r.time && (
            <span>
              {GNAV_ICONS.timetable(14)}時刻表
            </span>
          )}
          {r.money && (
            <span>
              {GNAV_ICONS.ticket(14)}售票口
            </span>
          )}
          {r.notes && (
            <span>
              {GNAV_ICONS.notes(14)}筆記
            </span>
          )}
          <span>
            {GNAV_ICONS.calendar(14)}締切
          </span>
          {evCol && <span>記事</span>}
        </div>
        {r.rows.map((row: ReportRow) =>
          row.kind === "day" ? (
            <DayRowView key={row.day} row={row} r={r} shell={shell} />
          ) : (
            <SumRowView key={`sum-${row.weekOf}${row.reference ? "-ref" : ""}`} row={row} r={r} />
          ),
        )}
      </div>
      <p className="ns-rp-legend">
        {r.notes && (
          <span>
            <span className="dia" aria-hidden="true" />
            寫了日記
          </span>
        )}
        <span>
          <span className="late">{shell === "mobile" ? "●" : "誤點"}</span>還沒交代的票
        </span>
        {r.hasDayNotes && <span>◎ 車站到着、路線到站</span>}
      </p>
    </>
  );
}

/* ═══════════ 整頁內容 ═══════════ */

export function ReportBody({
  r,
  shell,
  days,
  onDays,
  routes,
}: {
  r: OperationReport;
  shell: ReportShellKind;
  days: ReportDays;
  onDays: (d: ReportDays) => void;
  routes: readonly NodeRow[];
}) {
  const byId: Record<string, NodeRow> = {};
  for (const x of routes) byId[x.id] = x;
  return (
    <>
      <YearAgo r={r} shell={shell} />
      <div className="ns-rp-grid">
        <RideCard r={r} shell={shell} routes={byId} />
        {r.time && <TimeCard r={r} shell={shell} />}
        {r.money && <MoneyCard r={r} shell={shell} />}
        {r.notes && <NotesCard r={r} shell={shell} />}
        <DueCard r={r} shell={shell} routes={byId} />
      </div>
      <div className="sec ns-rp-sec">
        <h3>每日運行實績</h3>
        <span className="rule" />
        <Tabs
          items={DAY_TABS}
          value={String(days) as "7" | "30"}
          onChange={(k) => onDays(k === "30" ? 30 : 7)}
          size="md"
          aria-label="天數"
          className="ns-rp-days"
        />
      </div>
      <ReportTable r={r} shell={shell} />
    </>
  );
}
