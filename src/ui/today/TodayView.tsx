/**
 * TodayView——今日視圖（UI Flow 1.0；M3 ③ WP2）＝首頁。結構與 class 逐字移植自
 *   prototypes/m3-mood-c2-pastel.html（粉彩：頁首 :661-690、清單 :691-809、誤點 :811-836）
 *   ＋ prototypes/m3-mood-c1-galaxy.html（銀河：頁首手寫統計 :589-593）
 *   ＋ prototypes/m3-mood-a-stamps.html（頁首日付印位置 :856-880；尺寸 92px＝① 比稿 Q8）
 * 兩主題共用同一份 DOM，文案差異用 .theme-pastel-only／.theme-galaxy-only 兩份都畫、CSS 擇一顯示。
 *
 * 版面（由上而下）：
 *   header.day（overline／日期＋週＋latin／手寫「還有 N 張」／日付印／day-stats／紀念章）
 *   → 誤點區（**置頂**＝r1 拍板，樣式逐字取原型 .sec.late／.ticket.late-t 只搬位置；含 D-③-7 的締切段）
 *   → 「今天的列車」清單（＋ Enter 開的臨時車票草稿列）
 *   → 空狀態 1.0c 無班次／1.0d 全完成慶祝（語氣分開）
 *   → page-foot
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
import { Fragment, useCallback, useRef, useState, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import type { TodayRow as TodayRowData } from "../../data";
import { timeOfRow } from "../../domain/scheduledTime";
import { dayCountParts } from "../../domain/dayCount";
import { clockText, isClockPast, nowClockMinutes } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { DateSeal, StationStamp } from "../stamps";
import { TodayRow } from "./TodayRow";
import { TicketDraftRow } from "./TicketDraftRow";
import { LogInlineInput } from "./LogInlineInput";
import { DeferPopover } from "./DeferPopover";
import { useTodayController } from "./useTodayController";
import { useTodayKeyboard } from "./useTodayKeyboard";
import { useTodayDnd } from "./useTodayDnd";
import { lineTodayStats } from "../../lines/runtime";
import { PopMenu, hotkeyCaps } from "../common/PopMenu";
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

/** 空狀態：原型 .sec 語彙（襯線標題＋虛線延伸）＋一句手帳口吻＋文字入口 */
function EmptyBlock({
  title,
  body,
  action,
  onAction,
  cheer,
}: {
  title: string;
  body?: string;
  action?: string;
  onAction?: () => void;
  cheer?: boolean;
}) {
  return (
    <div className={"empty" + (cheer ? " cheer" : "")}>
      <div className="sec">
        <h3>{title}</h3>
        <span className="rule" />
      </div>
      {body && <p className="empty-body">{body}</p>}
      {action && onAction && (
        <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onAction} className="empty-action">
          {action}
        </button>
      )}
    </div>
  );
}

/**
 * 「＋ 臨時車票」分裂鈕（10-20 磨光②；補 today.draft／today.inbox 的滑鼠入口）：
 *   主鈕＝Enter 同一條路（controller.openDraft：清單尾開草稿列）；▾＝小選單兩項——
 *   臨時車票（排今天）／放進收件匣（無日期）＝Shift+Enter 同一條路（controller.createInboxTicket：同款草稿列、
 *   提交後流入收件匣），對齊手機輸入列的「無日期」切換。
 * 形狀＝兩顆 .ns-btn.ns-btn--sm.btn-ghost 併成一組（中縫共用一條框線），不另畫新鈕。
 * 跟區段標題列其他鈕一樣 tabIndex=-1＋mousedown 不搶焦點：鍵盤流留在今日容器（Enter／Shift+Enter 本來就有）。
 */
function AddSplit({
  onDraft,
  onInbox,
  returnFocus,
}: {
  onDraft: () => void;
  onInbox: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="add-split" role="group" aria-label="新增車票">
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDraft}
        title={`開一張臨時車票（${hotkeyCaps("today.draft")}）`}
        className="ns-btn ns-btn--sm btn-ghost add-main"
      >
        ＋ 臨時車票
      </button>
      <button
        ref={moreRef}
        type="button"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="更多新增方式"
        title="更多新增方式"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="ns-btn ns-btn--sm btn-ghost add-more"
      >
        ▾
      </button>
      {open && (
        <PopMenu
          anchor={moreRef.current}
          overline="新增 — NEW"
          label="新增車票"
          onClose={close}
          returnFocus={returnFocus}
          items={[
            { key: "draft", label: "臨時車票（排今天）", hotkeyId: "today.draft", onSelect: onDraft },
            { key: "inbox", label: "放進收件匣（無日期）", hotkeyId: "today.inbox", onSelect: onInbox },
          ]}
        />
      )}
    </span>
  );
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

  const noRows = c.rows.length === 0 && !c.draft;

  return (
    <section
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="今日"
      className="page ns-today"
    >
      <div className="sheet">
        {/* ═══ 頁首（原型 header.day） ═══ */}
        <header className="day">
          <div className="day-head">
            <p className="overline">
              <span className="theme-pastel-only">Today</span>
              <span className="theme-galaxy-only">今天 — TODAY</span>
            </p>
            <div className="date-line">
              <span className="d">
                {day.getMonth() + 1}月{day.getDate()}日
              </span>
              <span className="w">{WEEK_ZH[day.getDay()]}</span>
              <span className="latin">
                {MONTH_EN[day.getMonth()]} {day.getDate()}, {WEEK_EN[day.getDay()]}
              </span>
              {/* 頁邊手寫（粉彩三處手寫之一）：全部蓋済＝「都完成了」（C2 script 逐字）。
                  磨光⑤ N11：運休算結清不算完成——有運休的結清寫「都結清了」，不然跟底下「完成 2/3・全部結清」打架 */}
              {countParts && (
                <span className="margin-note">
                  {left > 0 ? `還有 ${left} 張` : countParts.done === countParts.total ? "都完成了" : "都結清了"}
                </span>
              )}
              {/* 頁首日付印一枚（a38／規格 §6；位置照 A、尺寸 92px 照 ① 比稿 Q8） */}
              <DateSeal date={day} size={92} title={`日付印 ${c.dateKey}`} />
            </div>
            <p className="day-stats">
              {/* 磨光⑤ N11：兩主題同一句「完成 d/t・還有 l 張」（全結清＝「全部結清」），與手機今日、串流今日列同一把尺 */}
              {countParts && (
                <>
                  完成{" "}
                  <b>
                    {countParts.done}/{countParts.total}
                  </b>
                  <span className="sep">・</span>
                  {countParts.tail}
                </>
              )}
              {lineStats.length ? (
                // 別線的統計段（插槽 todayStats，接縫 #66）：取代核心「專注」；分隔「・」由元件看 lead 自己畫
                lineStats.map((S, i) => <S key={i} shell="desktop" dateKey={c.dateKey} lead={total > 0} wrap={false} />)
              ) : (
                <>
                  {total > 0 && focusMin > 0 && <span className="sep">・</span>}
                  {focusMin > 0 && (
                    <>
                      專注 <b>{fmtMinutes(focusMin)}</b>
                    </>
                  )}
                </>
              )}
              {/* 下一班（主線②；原型 :999）：今天分區第一張還沒交代、時刻還沒到的票 */}
              {total > 0 && (
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
                </>
              )}
            </p>
          </div>

          {nextStation && (
            <StationStamp
              className="station-stamp"
              size={122}
              arcLabel={`${stationRoute?.code ? `${stationRoute.code} LINE · ` : ""}NEXT STATION`}
              caption="下一站"
              name={nextStation.name.length > 6 ? `${nextStation.name.slice(0, 5)}…` : nextStation.name}
              percent={milestonePct}
              statusText="進行中"
              title={`下一站 ${nextStation.name}，里程 ${Math.round(milestonePct)}%`}
            />
          )}
        </header>

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
                aria-label={`誤點 ${c.lateRows.length} 件，${c.lateCollapsed ? "展開" : "收起"}`}
                title={c.lateCollapsed ? "展開誤點區" : "收起誤點區"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={c.toggleLate}
                className="note fold"
              >
                {c.lateRows.length} 件
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
          <EmptyBlock
            title="今天還沒有班次"
            body="按 Enter 開一張臨時車票；或到路線圖（Ctrl+2）選一班列車，按 T 排進今天。"
            action="開一張臨時車票"
            onAction={c.openDraft}
          />
        ) : (
          <>
            <div className="sec">
              <h3>今天的列車</h3>
              <span className="rule" />
              <span className="note">{total} 張</span>
              <AddSplit
                onDraft={c.openDraft}
                onInbox={c.createInboxTicket}
                returnFocus={() => containerRef.current}
              />
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
          <EmptyBlock
            cheer
            title="今天的班次都到站了"
            body="剩下的時間是你的。明天的事，可以先去行程表排好。"
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
