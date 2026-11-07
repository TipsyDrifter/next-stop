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
 *   → 「今天的列車」清單（區段標右側「済 N・隱藏」開關）＋清單尾常駐「＋ 新增車票…」／建票列（回饋甲 D-主-127、128、131）
 *   → 空狀態 1.0c 無班次／1.0d 全完成慶祝（語氣分開；UI 丙-3 A4 換共用 EmptyState）
 *   → page-foot
 *
 * ── UI 丙-3（契約 §1 A1～A5、§5 P1／P5）──
 *   - 頁首換共用 PageHeader（跟行程表同一副骨架）。紀念章走 `emblem`（P1＝A：日付印右邊、工具列左邊、92）；
 *     頁首寬 <704 時 PageHeader 自己把它退成 stats 列尾的 28px 小章＋「下一站 X N%」（`emblemCompact`）。
 *   - 手寫「還有 N 張」（P5）接在補述右邊，銀河不畫（today.css）；別線的 todayStats 插槽元件仍畫在 stats 列。
 *   - 「＋ 臨時車票」分裂鈕（AddSplit，主鈕＋▾）退役（A3）：頁首工具列第二格一顆「＋ 車票」（＝Enter；回饋甲改名，
 *     建票列可掛路線、不只臨時車票）；收件匣＝建票列「執行日」chip 清成無日期，`Shift+Enter` 照舊（開的就是無日期那種）。
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
import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import { capsOfHotkey } from "../shell/hotkeys";
import type { NodeRow } from "../../domain";
import type { TodayRow as TodayRowData } from "../../data";
import { TIME_FIXED_ORDER_MSG, manualOrderIds, timeOfRow } from "../../domain/scheduledTime";
import { dayCountParts, lateCount, lateCountText } from "../../domain/dayCount";
import { clockText, isClockPast, nowClockMinutes } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { DateSeal, SealDone, StationStamp } from "../stamps";
import { TodayBrief } from "../report/TodayBrief";
import { TodayRow } from "./TodayRow";
import { DoneToggleChip, NO_DEST, QuickAddLauncher, QuickAddRow, type QuickDefaults } from "../common/quickadd";
import { LogInlineInput } from "./LogInlineInput";
import { DeferPopover } from "./DeferPopover";
import { useTodayController } from "./useTodayController";
import { MoodStage } from "../ambience";
import { useTodayKeyboard } from "./useTodayKeyboard";
import { indexOfAnchor, useDragReorder } from "../common/dragReorder";
import { useSelectionStore } from "../../store/selectionStore";
import { SelectionBar } from "../common/selection/SelectionBar";
import { dragBatch } from "../common/selection/desktopSelection";
import { lineTodayStats } from "../../lines/runtime";
import { hotkeyCaps } from "../common/PopMenu";
import { EmblemMini, PageHeader } from "../common/PageHeader";
import { EmptyState } from "../common/EmptyState";
import { IconPlus } from "../common/icons";
import { WeekAimsBand } from "../weekAims/WeekAimsBand";
import { useStationCard } from "../weekAims/StationCard";
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

/** 這一列済了沒（定期券看班次；運休不算）——「済 N・隱藏」開關數的就是這個 */
function isDoneRow(r: TodayRowData): boolean {
  return r.occurrence ? r.occurrence.status === "done" : r.status === "done";
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
  useHotkeyRevision();
  const containerRef = useRef<HTMLDivElement>(null);
  const c = useTodayController(containerRef);
  const onKeyDown = useTodayKeyboard(c.keys, c.blocked);
  // 拖曳排序（回饋乙：換成共用元件 useDragReorder；只有 today 分區、沒時刻的票能手排，同 Alt+↑↓ 的 moveToday）
  const [todayList, setTodayList] = useState<HTMLUListElement | null>(null);
  const [lateList, setLateList] = useState<HTMLUListElement | null>(null);
  // 已完成開關（回饋甲 D-主-131）：只藏「今天的列車」裡済的票；頁首「完成 d/t」照舊算全部（c.stats 不動）
  const todayHideDone = useUiStore((s) => s.todayHideDone);
  const toggleTodayHideDone = useUiStore((s) => s.toggleTodayHideDone);
  const doneToday = c.todayRows.filter(isDoneRow).length;
  const shownToday = todayHideDone ? c.todayRows.filter((r) => !isDoneRow(r)) : c.todayRows;
  const manual = manualOrderIds(c.todayRows);
  const picked = useSelectionStore((s) => (s.scope === "today" ? s.ids : null));
  useDragReorder({
    root: todayList,
    // 畫面上有的才給拖（藏起來的済票不在 DOM 裡）；落點換算照舊對全部的手排順序
    items: manual.filter((id) => shownToday.some((r) => r.id === id)).map((id) => ({ id })),
    // 多選裡拖其中一張＝整批（只帶能手排的那幾張；回饋乙 ☎3③）
    dragIds: (id) => dragBatch("today", id, manual, (x) => manual.includes(x)),
    canDrag: (id) => (manual.includes(id) ? true : TIME_FIXED_ORDER_MSG),
    onRefuse: (_id, why) => useUiStore.getState().showToast({ message: why }, 3500),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      // 一張一張放、每張都對最新的順序換算：第一張照落點錨，其餘接在前一張後面（多張一起拖保持相對順序）
      void (async () => {
        let prev: string | null = null;
        for (const id of ids) {
          const latest = manualOrderIds(useNodeStore.getState().today.rows);
          const at = prev === null ? indexOfAnchor(latest, id, place) : latest.filter((x) => x !== id).indexOf(prev) + 1;
          if (at === null || at < 0) return;
          const r = await useNodeStore.getState().moveToday(id, at);
          if (!r.ok) {
            useUiStore.getState().showToast({ message: r.reason ?? "沒有排成功——請再試一次" }, 3500);
            return;
          }
          prev = id;
        }
      })();
    },
  });
  // 誤點區的票拖不動也要回話（「拖不動又不回話」＝啞巴 UI；理由同一句、出自 store）
  useDragReorder({
    root: lateList,
    items: c.lateRows.map((r) => ({ id: r.id })),
    slots: false,
    canDrag: () => `誤點區的票不能拖——要排到今天請按 ${capsOfHotkey("today.schedule.today")}`,
    onRefuse: (_id, why) => useUiStore.getState().showToast({ message: why }, 3500),
    onDrop: () => undefined,
  });
  const stations = useNodeStore((s) => s.stations);
  const routes = useNodeStore((s) => s.routes);
  const todayById = useNodeStore((s) => s.today.byId);
  const lookupToday = useCallback((id: string) => todayById[id], [todayById]);
  // 推遲小卡的那一列：⑤ 起由呼叫端注入（小卡不再自己查 today.byId，才共用得了日曆浮層）
  const deferRow = useNodeStore((s) => (c.deferTarget ? (s.today.byId[c.deferTarget.id] ?? null) : null));
  // 現在（主線②）：赭色、現在線、「下一班」每分鐘自己更新
  const now = useMinuteTick();
  // 現在線、小標的位置照畫面上那幾列算（隱藏已完成時列數變了）；下一班本來就跳過済票，結果一樣
  const tl = timeline(shownToday, c.dateKey, now);
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

  // 紀念章：全部路線中「預定到站日最近且未到站」的車站（D-③-2 甲；沒有就不畫）。
  // 車庫與回顧 D-主-206 #10：只看還在跑的路線（收進車庫的路線的車站不再預告）
  const nextStation: NodeRow | undefined = stations
    .filter((s) => !s.arrived_on && s.expected_on && routes.some((r) => r.id === s.parent_id && !r.arrived_on))
    .sort((a, b) => (a.expected_on ?? "").localeCompare(b.expected_on ?? ""))[0];
  const stationRoute = nextStation ? routes.find((r) => r.id === nextStation.parent_id) : undefined;
  const routeStations = nextStation ? stations.filter((s) => s.parent_id === nextStation.parent_id) : [];
  const milestonePct = routeStations.length
    ? (routeStations.filter((s) => s.arrived_on).length / routeStations.length) * 100
    : 0;

  /** 紀念章上的站名（章面窄：六字以上截成五字＋…） */
  const stampName = nextStation ? (nextStation.name.length > 6 ? `${nextStation.name.slice(0, 5)}…` : nextStation.name) : "";

  // 紀念章點了開車站小卡（方針擴充 辛 §3 #7）
  const stationCard = useStationCard();

  const noRows = c.rows.length === 0 && !c.draft;
  const setQuickJumpOpen = useUiStore((s) => s.setQuickJumpOpen);

  // 建票列（回饋甲 D-主-127、128）：預設掛到無路線；Enter 開的＝執行日今天、Shift+Enter 開的＝無日期（進收件匣）
  const draftKind = c.draft?.kind ?? null;
  const quickDefaults: QuickDefaults | null = useMemo(
    () => (draftKind ? { dest: NO_DEST, scheduledOn: draftKind === "inbox" ? null : c.dateKey, noDateLabel: true } : null),
    [draftKind, c.dateKey],
  );

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
    <>
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
          // ② 運行報告 D-主-184：日期下方的「今日小結」一行（點了進運行報告）
          below={<TodayBrief shell="desktop" />}
          stamp={<DateSeal date={day} size={76} title={`日付印 ${c.dateKey}`} />}
          emblem={
            nextStation ? (
              <button
                type="button"
                className="wa-emblem"
                aria-haspopup="dialog"
                aria-label={`下一站 ${nextStation.name}，里程 ${Math.round(milestonePct)}%，看這一站`}
                title={`下一站 ${nextStation.name}，里程 ${Math.round(milestonePct)}%`}
                onClick={(e) => stationCard.open(nextStation.id, e.currentTarget)}
              >
                <StationStamp
                  size={92}
                  arcLabel={`${stationRoute?.code ? `${stationRoute.code} LINE · ` : ""}NEXT STATION`}
                  caption="下一站"
                  name={stampName}
                  percent={milestonePct}
                  statusText="進行中"
                  title={`下一站 ${nextStation.name}，里程 ${Math.round(milestonePct)}%`}
                />
              </button>
            ) : undefined
          }
          emblemCompact={
            nextStation ? (
              <button
                type="button"
                className="wa-emblem-c"
                aria-haspopup="dialog"
                title={`下一站 ${nextStation.name}，里程 ${Math.round(milestonePct)}%`}
                onClick={(e) => stationCard.open(nextStation.id, e.currentTarget)}
              >
                <EmblemMini percent={milestonePct} />
                下一站 <b>{stampName}</b> {Math.round(milestonePct)}%
              </button>
            ) : undefined
          }
          // 空狀態出現時「＋」交給空狀態那一顆（同一動作同頁一個入口，規範 §2.7）；第一次載入回來前也先不畫，免得閃一下
          add={
            c.loaded && !noRows
              ? { label: "車票", onClick: c.openDraft, title: `新增車票（${hotkeyCaps("today.draft")}）` }
              : undefined
          }
          search={{ onOpen: () => setQuickJumpOpen(true), title: `搜尋（${hotkeyCaps("global.quickjump")}）` }}
        />

        {/* 週方針（戊 D-主-262）：頁首下方一張告示；落點等甲、② 的頁首改動合進來再對 */}
        <WeekAimsBand />
        {stationCard.node}

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
              <ul ref={setLateList} role="listbox" aria-label="誤點" className="ticket-list">
                {c.lateRows.map((r) => (
                  <Fragment key={r.id}>
                    <TodayRow
                      row={r}
                      route={c.routeOf(r)}
                      selected={c.selectedId === r.id}
                      picked={!!picked?.includes(r.id)}
                      fresh={c.freshId === r.id}
                      dateKey={c.dateKey}
                      actions={c.row}
                      onFreshEnd={c.clearFresh}
                      dndProps={{ "data-drag-id": r.id }}
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
            desc="寫一張車票，或從路線圖挑一班。"
            action={{ label: "車票", icon: <IconPlus />, onClick: c.openDraft }}
            secondary={{ label: "去路線圖", onClick: () => useUiStore.getState().openRouteMap() }}
          />
        ) : (
          <>
            <div className="sec">
              <h3>今天的列車</h3>
              <span className="rule" />
              <span className="note">{total} 張</span>
              {/* 已完成開關（回饋甲 D-主-131；預設顯示＝済票留原位到日界線） */}
              {doneToday > 0 && (
                <DoneToggleChip count={doneToday} showing={!todayHideDone} onToggle={toggleTodayHideDone} />
              )}
            </div>
            <ul ref={setTodayList} role="listbox" aria-label="今天的列車" className="ticket-list">
              {shownToday.map((r, i) => (
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
                    picked={!!picked?.includes(r.id)}
                    fresh={c.freshId === r.id}
                    dateKey={c.dateKey}
                    actions={c.row}
                    onFreshEnd={c.clearFresh}
                    dndProps={{ "data-drag-id": r.id }}
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
              {nowAt === shownToday.length && nowText !== null && <NowLine text={nowText} />}
            </ul>
            {/* 清單尾（回饋甲 D-主-128）：收著＝常駐淡色列「＋ 新增車票…」；開著＝建票列（Enter／頁首「＋ 車票」開，Shift+Enter＝無日期）。
                另一份 ul：listbox 裡只放選項 */}
            <ul className="ticket-list today-tail">
              {c.draft && quickDefaults ? (
                <QuickAddRow
                  // 換一種（Enter↔Shift+Enter）＝照新的預設重開
                  key={c.draft.kind}
                  defaults={quickDefaults}
                  here={{ kind: "today", dateKey: c.dateKey }}
                  onClose={(byKeyboard) => (byKeyboard ? c.closeDraft() : c.dismissDraft())}
                  onCreated={(row, stays) => {
                    if (stays) useUiStore.getState().select(row.id);
                  }}
                />
              ) : (
                <QuickAddLauncher label="新增車票…" onOpen={c.openDraft} />
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

        <SelectionBar scope="today" lookup={lookupToday} />
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
    <MoodStage done={c.stats.done} allDone={allDone} dateKey={c.dateKey} loaded={c.loaded} />
    </>
  );
}
