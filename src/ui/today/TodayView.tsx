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
 *
 * 頁面殼契約（WP0）：根節點帶 .page（z-index 蓋過 SkyLayer）與 .ns-today（CSS 前綴）；
 *   天空由 App.tsx 統一掛（density full／train false），本檔不碰。側欄「我的路線」在今日頁保留（Sidebar 負責）。
 */
import { Fragment, useRef } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { DateSeal, StationStamp } from "../stamps";
import { TodayRow } from "./TodayRow";
import { TicketDraftRow } from "./TicketDraftRow";
import { LogInlineInput } from "./LogInlineInput";
import { DeferPopover } from "./DeferPopover";
import { useTodayController } from "./useTodayController";
import { useTodayKeyboard } from "./useTodayKeyboard";
import { useTodayDnd } from "./useTodayDnd";
import "./today.css";

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

export function TodayView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const c = useTodayController(containerRef);
  const onKeyDown = useTodayKeyboard(c.keys, c.blocked);
  const dnd = useTodayDnd(c.rows, c.moveTo);
  const stations = useNodeStore((s) => s.stations);
  const routes = useNodeStore((s) => s.routes);
  // 推遲小卡的那一列：⑤ 起由呼叫端注入（小卡不再自己查 today.byId，才共用得了日曆浮層）
  const deferRow = useNodeStore((s) => (c.deferTarget ? (s.today.byId[c.deferTarget.id] ?? null) : null));

  const day = dateOf(c.dateKey);
  const doy = dayOfYear(day);

  // 頁首統計：完成／還有幾張以「今天的列車」為母數（誤點區另計，照 C2 的 #today-list 口徑）。
  // 口徑統一交給 controller 的 c.stats：定期券看班次（済／運休都算已交代），M3 ④。
  const { total, done, left, allDone } = c.stats;
  const focusMin = c.rows.reduce((sum, r) => sum + (r.time_spent_min ?? 0), 0);

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
              {/* 頁邊手寫（粉彩三處手寫之一）：全部蓋完＝「都完成了」（C2 script 逐字） */}
              {total > 0 && <span className="margin-note">{left === 0 ? "都完成了" : `還有 ${left} 張`}</span>}
              {/* 頁首日付印一枚（a38／規格 §6；位置照 A、尺寸 92px 照 ① 比稿 Q8） */}
              <DateSeal date={day} size={92} title={`日付印 ${c.dateKey}`} />
            </div>
            <p className="day-stats">
              {total > 0 && (
                <>
                  <span className="theme-pastel-only">
                    完成{" "}
                    <b>
                      {done}/{total}
                    </b>
                  </span>
                  <span className="theme-galaxy-only">
                    {left === 0 ? (
                      <>
                        <b>{total}</b> 張全蓋完了
                      </>
                    ) : (
                      <>
                        蓋了 <b>{done}</b> 張，還有 <b>{left}</b> 張
                      </>
                    )}
                  </span>
                </>
              )}
              {total > 0 && focusMin > 0 && <span className="sep">・</span>}
              {focusMin > 0 && (
                <>
                  專注 <b>{fmtMinutes(focusMin)}</b>
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
        {noRows ? (
          <EmptyBlock
            title="今天還沒有班次"
            body="按 Enter 開一張臨時車票；或到路線圖（Ctrl+2）選一班列車，按 T 排上今天。"
            action="開一張臨時車票"
            onAction={c.openDraft}
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
                  <TodayRow
                    row={r}
                    route={c.routeOf(r)}
                    selected={c.selectedId === r.id}
                    fresh={c.freshId === r.id}
                    dateKey={c.dateKey}
                    actions={c.row}
                    onFreshEnd={c.clearFresh}
                    dndProps={dnd.rowProps(r.id, i)}
                  />
                  {c.logTarget === r.id && (
                    <li role="presentation" className="log-row">
                      <LogInlineInput nodeId={r.id} onDone={c.closeLog} onCancel={c.closeLog} />
                    </li>
                  )}
                </Fragment>
              ))}
              {c.draft && (
                <TicketDraftRow
                  afterId={c.draft.afterId}
                  kind={c.draft.kind}
                  onCommit={c.commitDraft}
                  onCancel={c.closeDraft}
                />
              )}
            </ul>
          </>
        )}

        {/* 1.0d 全完成慶祝（語氣與 1.0c 分開：這裡是收工，不是招募） */}
        {allDone && !c.draft && (
          <EmptyBlock
            cheer
            title="今天的班次都到站了"
            body="剩下的時間是你的。明天要跑的，可以到路線圖先排好。"
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
