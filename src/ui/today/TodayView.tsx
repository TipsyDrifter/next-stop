/**
 * TodayView——今日視圖（UI Flow 1.0；M3 ③ WP2）＝首頁。結構與 class 逐字移植自
 *   prototypes/m3-mood-c2-pastel.html（粉彩：頁首 :661-690、清單 :691-809、誤點 :811-836）
 *   ＋ prototypes/m3-mood-c1-galaxy.html（銀河：頁首手寫統計 :589-593）
 *   ＋ prototypes/m3-mood-a-stamps.html（頁首日付印位置 :856-880；尺寸 92px＝① 比稿 Q8）
 * 兩主題共用同一份 DOM，文案差異用 .theme-pastel-only／.theme-galaxy-only 兩份都畫、CSS 擇一顯示。
 *
 * 版面（由上而下）：
 *   PageHeader 身分式（UI 丙-3 A1：眉標 {今日, Today}／大標月日 34／補述週幾＋latin＋粉彩手寫「還有 N 張」／
 *     stats 完成・專注（或別線 todayStats）・下一班／日付印 92／紀念章 92／工具列「＋ 臨時車票」＋搜尋，第四格空）
 *   → 誤點區（**置頂**＝r1 拍板，樣式逐字取原型 .sec.late／.ticket.late-t 只搬位置；含 D-③-7 的締切段）
 *   → 「今天的列車」清單（＋ Enter 開的臨時車票草稿列）
 *   → 空狀態 1.0c 無班次／1.0d 全完成慶祝（語氣分開；UI 丙-3 A4 換共用 EmptyState）
 *   → page-foot
 *
 * ── UI 丙-3（契約 §1 A1～A5、§5 P1／P5）──
 *   - 頁首換共用 PageHeader（跟行程表同一副骨架）。紀念章走 `emblem`（P1＝A：日付印右邊、工具列左邊、92）；
 *     頁首寬 <704 時 PageHeader 自己把它退成 stats 列尾的 28px 小章＋「下一站 X N%」（`emblemCompact`）。
 *   - 手寫「還有 N 張」（P5）接在補述右邊，銀河不畫（today.css）；別線的 todayStats 插槽元件仍畫在 stats 列。
 *   - 「＋ 臨時車票」分裂鈕（AddSplit，主鈕＋▾）退役（A3）：頁首工具列第二格一顆「＋ 臨時車票」（＝Enter）；
 *     收件匣走草稿列既有的「無日期」切換，`Shift+Enter` 照舊。
 *   - 空狀態（A4）：沒有任何車票＝EmptyState first（一顆「＋ 臨時車票」次鈕），這時頁首的「＋」隱藏（規範 §2.7、§3.1-5）；
 *     全部交代＝EmptyState done（慶祝，不給鈕；清單還在，頁首「＋」照留）。
 *   - 每列常駐 ⋯（A5）：TodayRow 的 `menu`，項目由 controller 的 `menuFor` 算。
 *
 * 紀念章（D-③-2 甲）：全部路線中「預定到站日最近且未到站」的車站，沒有就不畫。
 *   進度弧＝該路線的**里程進度**（已到站數／車站總數）——今日頁沒有整棵路線樹可算節點完成率
 *   （nodeStore.tree 只裝當前開啟的那條路線），里程是這一頁唯一取得到又不會說謊的口徑；知情項，見交付說明。
 * day-stats「專注」＝今日清單 time_spent_min 合計，為零省略該段（§6 開放問題 6 技術自決）。
 *   有通車的線填了插槽 `todayStats`（接縫 #66；時刻表車次② 0-14）⇒ 這一段改由線的元件畫（核心合計不畫）；沒有線填＝照舊。
 *
 * 頁面殼契約（WP0）：根節點帶 .page（z-index 蓋過 SkyLayer）與 .ns-today（CSS 前綴）；
 *   天空由 App.tsx 統一掛（density full／train false），本檔不碰。側欄「我的路線」在今日頁保留（Sidebar 負責）。
 */
import { Fragment, useRef, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import type { TodayRow as TodayRowData } from "../../data";
import { timeOfRow } from "../../domain/scheduledTime";
import { dayCountParts, lateCount, lateCountText } from "../../domain/dayCount";
import { clockText, isClockPast, nowClockMinutes } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { DateSeal, SealDone, StationStamp } from "../stamps";
import { TodayRow } from "./TodayRow";
import { TicketDraftRow } from "./TicketDraftRow";
import { LogInlineInput } from "./LogInlineInput";
import { DeferPopover } from "./DeferPopover";
import { useTodayController } from "./useTodayController";
import { useTodayKeyboard } from "./useTodayKeyboard";
import { useTodayDnd } from "./useTodayDnd";
import { lineTodayStats } from "../../lines/runtime";
import { hotkeyCaps } from "../common/PopMenu";
import { EmblemMini, PageHeader } from "../common/PageHeader";
import { EmptyState } from "../common/EmptyState";
import { IconPlus } from "../common/icons";
import "./today.css";
// 票面時刻（.tm）、「未定時・照手排」小標、現在線、頁首「下一班」的樣式寫在 schedule.css（today.css 本班不准碰）
import "../schedule/schedule.css";

const WEEK_ZH = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** YYYY-MM-DD → 本地 Date（不經 Date.parse，避免 date-only 字串被當 UTC 而跨日） */
function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 分鐘 → 1h20m／45m（C2 day-stats 的「專注」欄位口徑） */
function fmtMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h${pad2(m)}m` : `${h}h`;
}

/** 頁尾「Day N / 365」 */
function dayOfYear(d: Date): { day: number; total: number } {
  const start = new Date(d.getFullYear(), 0, 1);
  const end = new Date(d.getFullYear() + 1, 0, 1);
  const day = Math.floor((d.getTime() - start.getTime()) / 86_400_000) + 1;
  return { day, total: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

/** 這一列交代了沒（済或運休；定期券看班次結局）——與 TodayRow 的口徑同一條 */
function isSettled(r: TodayRowData): boolean {
  return r.occurrence ? r.occurrence.status === "done" || r.occurrence.status === "skipped" : r.status === "done";
}

/**
 * 今天分區的時刻資訊（主線② D-主-10；原型 :985-1000 deskTodayHTML）：
 *   subgrpAt  「未定時・照手排」小標插在第幾列之前（有時刻與沒時刻的都有才畫；否則 -1）
 *   nowAt     現在線插在第幾列之前：最後一張「時刻 ≤ 現在」的有時刻列之後；全在未來＝第一張之前；今天沒有有時刻列＝-1
 *   next      下一班＝第一張還沒交代、時刻還沒到的列
 * 排序由 repository 負責（有時刻的在前、照時刻），這裡只讀，不重排。
 */
function timeline(rows: TodayRowData[], dateKey: string, now: number) {
  let lastTimed = -1;
  let lastPast = -1;
  let firstUntimed = -1;
  let next: { row: TodayRowData; time: string } | null = null;
  rows.forEach((r, i) => {
    const t = timeOfRow(r);
    if (t === null) {
      if (firstUntimed < 0) firstUntimed = i;
      return;
    }
    lastTimed = i;
    const day = r.occurrence?.due_on ?? r.scheduled_on ?? dateKey;
    if (isClockPast(day, t, now)) lastPast = i;
    else if (!next && !isSettled(r)) next = { row: r, time: t };
  });
  const timedIdx = rows.map((r, i) => (timeOfRow(r) !== null ? i : -1)).filter((i) => i >= 0);
  return {
    subgrpAt: lastTimed >= 0 && firstUntimed >= 0 ? firstUntimed : -1,
    nowAt: timedIdx.length === 0 ? -1 : lastPast < 0 ? timedIdx[0] : lastPast + 1,
    next: next as { row: TodayRowData; time: string } | null,
  };
}

/** 現在線（原型 :246-250 .nowline）：赭色圓點＋實線＋「現在 15:10」（UI 丙-1 前是靛；視覺規範 §2.10） */
function NowLine({ text }: { text: string }): ReactNode {
  return (
    <li role="presentation" aria-hidden className="nowline">
      <span>{text}</span>
    </li>
  );
}

export function TodayView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const c = useTodayController(containerRef);
  const onKeyDown = useTodayKeyboard(c.keys, c.blocked);
  const dnd = useTodayDnd(c.rows, c.moveTo);
  const stations = useNodeStore((s) => s.stations);
  const routes = useNodeStore((s) => s.routes);
  // 推遲小卡的那一列：⑤ 起由呼叫端注入（小卡不再自己查 today.byId，才共用得了日曆浮層）
  const deferRow = useNodeStore((s) => (c.deferTarget ? (s.today.byId[c.deferTarget.id] ?? null) : null));
  // 現在（主線②）：赭色、現在線、「下一班」每分鐘自己更新
  const now = useMinuteTick();
  const tl = timeline(c.todayRows, c.dateKey, now);
  // 現在線的字與手機今日子頁、時段畫布同一把尺：營業日表記（日界線 06:00、現在 01:30 ⇒「25:30」），
  // 現在不在 dateKey 這個營業日上（nowClockMinutes＝null）就不畫線
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const nowMin = nowClockMinutes(c.dateKey, dayStartHour, now);
  const nowText = nowMin === null ? null : clockText(nowMin);
  const nowAt = nowText === null ? -1 : tl.nowAt;

  const day = dateOf(c.dateKey);
  const doy = dayOfYear(day);

  // 頁首統計：完成／還有幾張以「今天的列車」為母數（誤點區另計，照 C2 的 #today-list 口徑）。
  // 口徑統一交給 controller 的 c.stats：定期券看班次（済／運休都算已交代），M3 ④。
  const { total, left, allDone } = c.stats;
  const countParts = dayCountParts(c.stats);
  const focusMin = c.rows.reduce((sum, r) => sum + (r.time_spent_min ?? 0), 0);
  /** 別線的統計段（插槽 todayStats，接縫 #66）；沒有線填＝空陣列，頁首照舊畫核心「專注」 */
  const lineStats = lineTodayStats("desktop");

  // 紀念章：全部路線中「預定到站日最近且未到站」的車站（D-③-2 甲；沒有就不畫）
  const nextStation: NodeRow | undefined = stations
    .filter((s) => !s.arrived_on && s.expected_on)
    .sort((a, b) => (a.expected_on ?? "").localeCompare(b.expected_on ?? ""))[0];
  const stationRoute = nextStation ? routes.find((r) => r.id === nextStation.parent_id) : undefined;
  const routeStations = nextStation ? stations.filter((s) => s.parent_id === nextStation.parent_id) : [];
  const milestonePct = routeStations.length
    ? (routeStations.filter((s) => s.arrived_on).length / routeStations.length) * 100
    : 0;

  /** 紀念章上的站名（章面窄：六字以上截成五字＋…） */
  const stampName = nextStation ? (nextStation.name.length > 6 ? `${nextStation.name.slice(0, 5)}…` : nextStation.name) : "";

  const noRows = c.rows.length === 0 && !c.draft;
  const setQuickJumpOpen = useUiStore((s) => s.setQuickJumpOpen);

  /**
   * stats 列（大標下一行）的各段，「・」由後一段自己帶（別線元件看 lead 自己畫，同一個規矩）。
   * 磨光⑤ N11：兩主題同一句「完成 d/t・還有 l 張」（全結清＝「全部結清」），與手機今日、串流今日列同一把尺。
   */
  const stats: ReactNode[] = [];
  if (countParts) {
    stats.push(
      <>
        完成{" "}
        <b>
          {countParts.done}/{countParts.total}
        </b>
        <span className="sep">・</span>
        {countParts.tail}
      </>,
    );
  }
  if (lineStats.length) {
    // 別線的統計段（插槽 todayStats，接縫 #66）：取代核心「專注」；分隔「・」由元件看 lead 自己畫
    lineStats.forEach((S, i) =>
      stats.push(<S key={`line-${i}`} shell="desktop" dateKey={c.dateKey} lead={total > 0} wrap={false} />),
    );
  } else if (focusMin > 0) {
    stats.push(
      <>
        {total > 0 && <span className="sep">・</span>}
        專注 <b>{fmtMinutes(focusMin)}</b>
      </>,
    );
  }
  // 下一班（主線②；原型 :999）：今天分區第一張還沒交代、時刻還沒到的票
  if (total > 0) {
    stats.push(
      <>
        <span className="sep">・</span>
        <span className="next-run">
          {tl.next ? (
            <>
              下一班 <b className="tmx">{tl.next.time}</b>　{tl.next.row.name}
            </>
          ) : (
            "今天沒有下一班了"
          )}
        </span>
      </>,
    );
  }

  return (
    <section
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="今日"
      className="page ns-today"
    >
      <div className="sheet">
        {/* ═══ 頁首（UI 丙-3 A1：PageHeader 身分式） ═══ */}
        <PageHeader
          variant="identity"
          overline={{ zh: "今日", latin: "Today" }}
          title={`${day.getMonth() + 1}月${day.getDate()}日`}
          aside={
            <>
              <span>{WEEK_ZH[day.getDay()]}</span>
              <span className="ns-pagehead-latin">
                {MONTH_EN[day.getMonth()]} {day.getDate()}, {WEEK_EN[day.getDay()]}
              </span>
              {/* 頁邊手寫（粉彩三處手寫之一；§5 P5 接在補述右邊、銀河不畫）：全部蓋済＝「都完成了」（C2 script 逐字）。
                  磨光⑤ N11：運休算結清不算完成——有運休的結清寫「都結清了」，不然跟底下「完成 2/3・全部結清」打架 */}
              {countParts && (
                <span className="margin-note">
                  {left > 0 ? `還有 ${left} 張` : countParts.done === countParts.total ? "都完成了" : "都結清了"}
                </span>
              )}
            </>
          }
          stats={
            stats.length ? (
              <>
                {stats.map((part, i) => (
                  <span key={i} className="stat-part">{part}</span>
                ))}
              </>
            ) : undefined
          }
          stamp={<DateSeal date={day} size={76} title={`日付印 ${c.dateKey}`} />}
          emblem={
            nextStation ? (
              <StationStamp
                size={92}
                arcLabel={`${stationRoute?.code ? `${stationRoute.code} LINE · ` : ""}NEXT STATION`}
                caption="下一站"
                name={stampName}
                percent={milestonePct}
                statusText="進行中"
                title={`下一站 ${nextStation.name}，里程 ${Math.round(milestonePct)}%`}
              />
            ) : undefined
          }
          emblemCompact={
            nextStation ? (
              <span title={`下一站 ${nextStation.name}，里程 ${Math.round(milestonePct)}%`}>
                <EmblemMini percent={milestonePct} />
                下一站 <b>{stampName}</b> {Math.round(milestonePct)}%
              </span>
            ) : undefined
          }
          // 空狀態出現時「＋」交給空狀態那一顆（同一動作同頁一個入口，規範 §2.7）；第一次載入回來前也先不畫，免得閃一下
          add={
            c.loaded && !noRows
              ? { label: "臨時車票", onClick: c.openDraft, title: `開一張臨時車票（${hotkeyCaps("today.draft")}）` }
              : undefined
          }
          search={{ onOpen: () => setQuickJumpOpen(true), title: `搜尋（${hotkeyCaps("global.quickjump")}）` }}
        />

        {/* ═══ 誤點區（置頂＝r1；含 D-③-7 浮上來的締切段） ═══ */}
        {c.lateRows.length > 0 && (
          <>
            <div className="sec late">
              <h3>誤點</h3>
              <span className="rule" />
              <button
                type="button"
                tabIndex={-1}
                aria-expanded={!c.lateCollapsed}
                aria-label={`誤點 ${lateCountText(lateCount(c.lateRows, c.dateKey))}，${c.lateCollapsed ? "展開" : "收起"}`}
                title={c.lateCollapsed ? "展開誤點區" : "收起誤點區"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={c.toggleLate}
                className="note fold"
              >
                {/* 接縫 #104：數還沒交代的（今天補済、留在原位的那張不算），與行程表誤點列同一支 lateCount */}
                {lateCountText(lateCount(c.lateRows, c.dateKey))}
                <span className="caret" aria-hidden>
                  ▾
                </span>
              </button>
            </div>
            {!c.lateCollapsed && (
              <ul role="listbox" aria-label="誤點" className="ticket-list">
                {c.lateRows.map((r) => (
                  <Fragment key={r.id}>
                    <TodayRow
                      row={r}
                      route={c.routeOf(r)}
                      selected={c.selectedId === r.id}
                      fresh={c.freshId === r.id}
                      dateKey={c.dateKey}
                      actions={c.row}
                      onFreshEnd={c.clearFresh}
                      now={now}
                      menu={(anchor) => c.menuFor(r, anchor)}
                    />
                    {c.logTarget === r.id && (
                      <li role="presentation" className="log-row">
                        <LogInlineInput nodeId={r.id} onDone={c.closeLog} onCancel={c.closeLog} />
                      </li>
                    )}
                  </Fragment>
                ))}
              </ul>
            )}
          </>
        )}

        {/* ═══ 今天的列車 ═══ */}
        {/* 磨光⑤ S10：第一次 loadToday 回來前清單區留白（不放骨架、不畫空狀態）——否則開頁先閃「今天還沒有班次」 */}
        {!c.loaded ? null : noRows ? (
          <EmptyState
            className="today-empty"
            tone="first"
            stamp={
              <span className="stamp">
                <span className="hint">検印</span>
              </span>
            }
            title="今天還沒有班次"
            desc="寫一張臨時車票，或從路線圖挑一班。"
            action={{ label: "臨時車票", icon: <IconPlus />, onClick: c.openDraft }}
            secondary={{ label: "去路線圖", onClick: () => useUiStore.getState().setPage("routemap") }}
          />
        ) : (
          <>
            <div className="sec">
              <h3>今天的列車</h3>
              <span className="rule" />
              <span className="note">{total} 張</span>
            </div>
            <ul role="listbox" aria-label="今天的列車" className="ticket-list">
              {c.todayRows.map((r, i) => (
                <Fragment key={r.id}>
                  {/* 現在線與「未定時・照手排」小標（主線② D-主-10）：裝飾列，不是選項、不收落點 */}
                  {i === nowAt && nowText !== null && <NowLine text={nowText} />}
                  {i === tl.subgrpAt && (
                    <li role="presentation" className="subgrp">
                      不排時間・手動排序</li>
                  )}
                  <TodayRow
                    row={r}
                    route={c.routeOf(r)}
                    selected={c.selectedId === r.id}
                    fresh={c.freshId === r.id}
                    dateKey={c.dateKey}
                    actions={c.row}
                    onFreshEnd={c.clearFresh}
                    dndProps={dnd.rowProps(r.id, i)}
                    now={now}
                    menu={(anchor) => c.menuFor(r, anchor)}
                  />
                  {c.logTarget === r.id && (
                    <li role="presentation" className="log-row">
                      <LogInlineInput nodeId={r.id} onDone={c.closeLog} onCancel={c.closeLog} />
                    </li>
                  )}
                </Fragment>
              ))}
              {/* 有時刻的票全都過了、而且後面沒有未定時的票 ⇒ 現在線畫在最後 */}
              {nowAt === c.todayRows.length && nowText !== null && <NowLine text={nowText} />}
              {c.draft && (
                <TicketDraftRow
                  afterId={c.draft.afterId}
                  kind={c.draft.kind}
                  onCommit={c.commitDraft}
                  onCancel={c.closeDraft}
                  // 磨光⑤ K3：「無日期」切換＝換成另一種草稿（跟 Enter／Shift+Enter 開的是同兩種）
                  onKindChange={(k) => (k === "inbox" ? c.createInboxTicket() : c.openDraft())}
                />
              )}
            </ul>
          </>
        )}

        {/* 1.0d 全完成慶祝（語氣與 1.0c 分開：這裡是收工，不是招募） */}
        {c.loaded && allDone && !c.draft && (
          <EmptyState
            className="today-cheer"
            tone="done"
            stamp={<SealDone />}
            title="今天的班次都到站了"
            desc="剩下的時間是你的。明天的事，可以先去行程表排好。"
          />
        )}

        <footer className="page-foot">
          <span>私鐵手帳・今天</span>
          <span className="fr">
            Day {doy.day} / {doy.total}
          </span>
        </footer>
      </div>

      {/* 推遲小卡（WP3 填內容；WP2 是空殼，事件已接）。⑤ 起資料由呼叫端注入（DeferRow） */}
      {c.deferTarget && deferRow && (
        <DeferPopover row={deferRow} anchor={c.deferTarget.anchor} onClose={c.closeDefer} />
      )}
    </section>
  );
}
