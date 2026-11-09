/**
 * RouteOverview——桌機路線圖的最上層「路線一覽」（丁 D-主-239／240；視覺真相＝prototypes/design-structure-獨立頁.html「路線 A」）。
 * 手機路線圖第一層本來就是路線清單，桌機之前一進路線圖就是某一條的大綱、幹線與路線只活在書封——補上＝雙端同等。
 *
 * 什麼時候畫：`uiStore.routeOverview`（gnav「路線圖」、Ctrl+2、大綱麵包屑「路線圖」）；點卡片／書封點路線＝進那條的大綱。
 * 版型：清單型（.sheet，內容 848 置中）。
 *   頁首＝眉標 Route Map・大標「路線圖」・一行「N 條路線運行中・近 30 天 6h50m・花 4,357」・日付印・「＋ 路線 ▾」・搜尋。
 *   每條幹線一段：段標「幹線 學習 ┄┄ 2 條 ⋯」→ 兩欄卡片 →「＋ 路線」；沒有路線的幹線＝虛線框一句＋「＋ 路線」。
 *   卡片：頂端路線色帶（視覺規範禁左彩條）・圓牌＋路線名＋⋯・「◎ 下一站 名稱 M/D（週）」・車站進度線（到站數÷車站數）・
 *     下排四格＝車票 d/t 済｜近 30 天時間｜近 30 天花費｜誤點（0 不畫）。數字見 `domain/routeOverview.ts`。
 *   卡片 ⋯（右鍵同一份）：打開大綱／路線詳情…／移到幹線 ▾／到站・收進車庫／刪除路線…；段標 ⋯ 另有幹線的「到站・收進車庫」
 *   （③ 的 `requestArrive`：確認框、復原 toast 同書封；接縫班 D-主-282）。
 *   頁底「車庫 N 條 ›」（有到站的路線才畫；點了進車庫頁）＝手機路線圖第一層、書封清單最底的同一個入口。
 * 只列還在跑的幹線與路線（`liveLines`／`liveRoutes`）；到站的歸 ③ 的車庫。
 * ⑫：頁首下多一列分頁「路線｜篩選」（內容在 board/FilterView）；卡上的「誤點 N」可點＝篩選清單預填這條路線＋誤點（契約 §7）。
 *   頁首與分頁列畫布寬（D-主-477），路線卡內容包在 .ns-rm-read 維持 848。
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import type { NodeRow } from "../../domain";
import { fmtDur } from "../../domain/timetable";
import { EMPTY_SUMMARY, type RouteSummary } from "../../domain/routeOverview";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useBoardStore } from "../../store/boardStore";
import { APPEND, moveWithUndo } from "../../store/batchActions";
import { FilterView } from "../board/FilterView";
import { openLateOfRoute } from "../board/openFilter";
import { OVERVIEW_PANEL, OverviewTabs } from "../board/RouteViewTabs";
import { EmptyState } from "../common/EmptyState";
import { PageHeader } from "../common/PageHeader";
import { PopMenu, hotkeyCaps, type PopMenuItem } from "../common/PopMenu";
import { IconChevron, IconDots, IconPlus } from "../common/icons";
import { rowContextMenu } from "../common/contextMenu";
import { roundelStyle } from "../common/roundel";
import { requestDeleteRoute } from "../panel/routeFlows";
import { requestArrive } from "../panel/arrivalFlows";
import { GNAV_ICONS } from "../sidebar/gnavIcons";
import { DateSeal } from "../stamps";
import { todayKey } from "../../lib/date";
import { OVERVIEW_DAYS, useRouteOverview } from "./useRouteOverview";
import { StationMark } from "../weekAims/parts";
import { useRouteNextAims, useStationCard, type RouteNextAims } from "../weekAims/StationCard";
import { hasTime, headParts, mdw, spendText } from "./routeSummaryText";
import "./routeOverview.css";

const ROUTE_OV = { zh: "這條路線", latin: "Route" };
const LINE_OV = { zh: "這條幹線", latin: "Line" };
/** 新增選單的幹線上限（同大綱頁：一層 ≤7 項＝幹線 6 條＋新增幹線） */
const ADD_MENU_LINES = 6;

/** 進一條路線的大綱（＝書封點路線） */
function enterRoute(id: string, panel = false): void {
  const ui = useUiStore.getState();
  void useNodeStore.getState().openRoute(id);
  ui.setZoom(null);
  ui.select(null);
  if (panel) ui.setPanelOpen(true);
}

function routeMenu(route: NodeRow, lines: NodeRow[]): PopMenuItem[] {
  const others = lines.filter((l) => l.id !== route.line_id);
  return [
    { key: "open", label: "打開大綱", onSelect: () => enterRoute(route.id) },
    { key: "detail", label: "路線詳情…", hotkeyId: "global.panel.toggle", onSelect: () => enterRoute(route.id, true) },
    ...others.map(
      (l, k): PopMenuItem => ({
        key: `line:${l.id}`,
        label: `「${l.name}」`,
        group: "移到幹線",
        cut: k === 0,
        onSelect: () => void moveWithUndo([route.id], l.id, APPEND, `「${route.name}」已換到「${l.name}」幹線`),
      }),
    ),
    // 接縫班 D-主-282：同書封路線 ⋯（③ D-主-207）
    { key: "arrive", label: "到站・收進車庫", cut: true, onSelect: () => void requestArrive(route.id) },
    { key: "del", label: "刪除路線…", danger: true, cut: true, onSelect: () => void requestDeleteRoute(route) },
  ];
}

function lineMenu(line: NodeRow): PopMenuItem[] {
  const open = useUiStore.getState().openRouteDialog;
  return [
    { key: "edit", label: "編輯…", onSelect: () => open({ lineId: null, editId: line.id }) },
    { key: "add", label: "新增路線", onSelect: () => open({ lineId: line.id, editId: null }) },
    // 接縫班 D-主-282：幹線到站＝底下還在跑的路線一起收進車庫（同書封幹線 ⋯、手機幹線 ⋯）
    { key: "arrive", label: "到站・收進車庫", cut: true, onSelect: () => void requestArrive(line.id) },
  ];
}

function addMenu(lines: NodeRow[]): PopMenuItem[] {
  const open = useUiStore.getState().openRouteDialog;
  return [
    ...lines.slice(0, ADD_MENU_LINES).map(
      (l): PopMenuItem => ({ key: `route:${l.id}`, label: `新增路線到「${l.name}」`, onSelect: () => open({ lineId: l.id, editId: null }) }),
    ),
    { key: "line", label: "新增幹線", cut: lines.length > 0, onSelect: () => open({ lineId: null, editId: null }) },
  ];
}

/** 一顆 ⋯（常駐淡態）＋選單 */
function More({ label, overline, items }: { label: string; overline: { zh: string; latin: string }; items: () => PopMenuItem[] }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<PopMenuItem[] | null>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ns-ov-more"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-label={label}
        title="更多動作"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((cur) => (cur ? null : items()));
        }}
      >
        <IconDots size={14} />
      </button>
      {/* PopMenu 畫到 body，但 React 事件照元件樹冒泡：不截住的話，點選單項目會冒到卡片的 onClick＝順便開了那條的大綱（接縫班 D-主-282） */}
      {open && (
        <span className="ns-ov-menuhost" onClick={(e) => e.stopPropagation()}>
          <PopMenu anchor={btn.current} overline={overline} label={label} items={open} onClose={() => setOpen(null)} />
        </span>
      )}
    </>
  );
}

/** 車站進度線：實線到「到站數÷車站數」、虛線到終點、終點一枚 ◎ */
function StationTrack({ s, color }: { s: RouteSummary; color: string }) {
  const pct = s.stationsTotal > 0 ? Math.round((s.stationsArrived / s.stationsTotal) * 100) : 0;
  return (
    <div className="ns-ov-track" style={{ "--rc": color } as CSSProperties} aria-label={`車站 ${s.stationsArrived}/${s.stationsTotal} 到站`}>
      <i className="done" style={{ width: `${pct}%` }} />
      <i className="dot" style={{ left: `${pct}%` }} />
      <i className="end" />
    </div>
  );
}

function RouteCard({
  route,
  s,
  decimals,
  lines,
  next,
  onOpenStation,
}: {
  route: NodeRow;
  s: RouteSummary;
  decimals: number;
  lines: NodeRow[];
  /** 下一站與它的方針（整批載好，方針擴充 辛 §3 #7） */
  next: RouteNextAims | undefined;
  onOpenStation(id: string, anchor: HTMLElement): void;
}) {
  const color = route.color ?? "var(--route-preset-4)";
  const label = `路線「${route.name}」的動作`;
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enterRoute(route.id);
    }
  };
  return (
    <article
      className="ns-ov-card"
      style={{ "--rc": color } as CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`打開「${route.name}」的大綱`}
      onClick={() => enterRoute(route.id)}
      onKeyDown={onKey}
      onContextMenu={rowContextMenu(() => ({ overline: ROUTE_OV, label, items: routeMenu(route, lines) }))}
    >
      <header className="ns-ov-cardhead">
        <span aria-hidden className="ns-ov-roundel" style={roundelStyle(route.color)}>
          {route.code ?? ""}
        </span>
        <h3>{route.name}</h3>
        <More label={label} overline={ROUTE_OV} items={() => routeMenu(route, lines)} />
      </header>
      {next && s.nextStation ? (
        <button
          type="button"
          className="wa-ov-stn"
          aria-haspopup="dialog"
          title={`看「${next.station.name}」這一站`}
          onClick={(e) => {
            e.stopPropagation();
            onOpenStation(next.station.id, e.currentTarget);
          }}
        >
          <span className="ns-ov-next">
            <StationMark size={11} />
            下一站 <b>{s.nextStation.name}</b>
            {s.nextStation.expectedOn && <span className="d">{mdw(s.nextStation.expectedOn)}</span>}
          </span>
          {next.brief && <span className="wa-ov-aim">{next.brief}</span>}
        </button>
      ) : (
        <p className="ns-ov-next">
          <StationMark size={11} />
          <span className="d">還沒有下一站</span>
        </p>
      )}
      <StationTrack s={s} color={color} />
      <dl className="ns-ov-stats">
        <div>
          <dt>車票</dt>
          <dd>
            {s.ticketTotal > 0 ? (
              <>
                {s.ticketDone}/{s.ticketTotal}
                <small>済</small>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>近 {OVERVIEW_DAYS} 天時間</dt>
          <dd>{hasTime(s.timeMs) ? fmtDur(s.timeMs) : "—"}</dd>
        </div>
        <div>
          <dt>近 {OVERVIEW_DAYS} 天花費</dt>
          <dd>{s.spendMinor !== 0 ? spendText(s.spendMinor, decimals) : "—"}</dd>
        </div>
        {s.late > 0 && (
          <div className="is-late">
            <button
              type="button"
              className="ns-ov-latebtn"
              title="看這條路線誤點的車票"
              aria-label={`誤點 ${s.late} 張，看這條路線誤點的車票`}
              onClick={(e) => {
                e.stopPropagation();
                openLateOfRoute(route.id);
              }}
            >
              <dt>誤點</dt>
              <dd>
                <i aria-hidden>◆</i>
                {s.late}
              </dd>
            </button>
          </div>
        )}
      </dl>
    </article>
  );
}

export function RouteOverview() {
  useHotkeyRevision();
  const lines = useNodeStore((s) => s.liveLines);
  const routes = useNodeStore((s) => s.liveRoutes);
  const depotCount = useNodeStore((s) => s.routes.length - s.liveRoutes.length);
  const setQuickJumpOpen = useUiStore((s) => s.setQuickJumpOpen);
  const openRouteDialog = useUiStore((s) => s.openRouteDialog);
  const tab = useBoardStore((s) => s.overviewTab);
  const data = useRouteOverview();
  const nextAims = useRouteNextAims(routes);
  const stationCard = useStationCard();
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const dayKey = todayKey(dayStartHour);
  const [ty, tm, td] = dayKey.split("-").map(Number);
  const now = new Date(ty, tm - 1, td);
  const decimals = data?.decimals ?? 2;

  const parts = routes.length > 0 ? headParts(routes.length, data?.totalTimeMs ?? 0, data?.totalSpendMinor ?? 0, decimals, OVERVIEW_DAYS) : [];
  const stats = parts.length > 0 && (
    <>
      {parts.map((t, i) => (
        <span key={i} className="stat-part">
          {i > 0 && <span className="dot">・</span>}
          {t}
        </span>
      ))}
    </>
  );

  return (
    <section className="page ns-outline ns-ov" aria-label="路線一覽">
      <div className="sheet">
        <PageHeader
          variant="identity"
          overline={{ zh: "路線圖", latin: "Route Map" }}
          title="路線圖"
          stats={stats || undefined}
          stamp={<DateSeal date={now} size={76} title={`日付印 ${dayKey}`} />}
          add={{
            label: "路線",
            haspopup: true,
            title: "新增路線或幹線",
            onClick: (e) => {
              const el = e.currentTarget;
              setAddAnchor((cur) => (cur ? null : el));
            },
          }}
          search={{ onOpen: () => setQuickJumpOpen(true), title: `搜尋・跳轉（${hotkeyCaps("global.quickjump")}）` }}
        />
        {addAnchor && (
          <PopMenu
            anchor={addAnchor}
            overline={{ zh: "新增", latin: "New" }}
            label="新增路線或幹線"
            items={addMenu(lines)}
            onClose={() => setAddAnchor(null)}
          />
        )}
        <OverviewTabs />

        {tab === "filter" ? (
          <FilterView />
        ) : (
        <div id={OVERVIEW_PANEL.routes} role="tabpanel" aria-label="路線" className="ns-rm-read">
        {lines.length === 0 && (
          <EmptyState
            tone={depotCount > 0 ? "done" : "first"}
            stamp={null}
            title={depotCount > 0 ? "路線都收進車庫了" : "還沒有任何路線"}
            desc={depotCount > 0 ? "要開始新的，就建一條新幹線。" : "先建一條幹線（大方向，例如「學習」），再在底下開路線。"}
            action={{ label: "新增幹線", icon: <IconPlus />, onClick: () => openRouteDialog({ lineId: null, editId: null }) }}
          />
        )}

        {lines.map((line) => {
          const lr = routes.filter((r) => r.line_id === line.id);
          const label = `幹線「${line.name}」的動作`;
          return (
            <section key={line.id} className="ns-ov-line" aria-label={`幹線 ${line.name}`}>
              <div className="ns-ov-linehead" onContextMenu={rowContextMenu(() => ({ overline: LINE_OV, label, items: lineMenu(line) }))}>
                <span className="k">幹線</span>
                <h2>{line.name}</h2>
                <span className="rule" aria-hidden />
                {lr.length > 0 && <span className="n">{lr.length} 條</span>}
                <More label={label} overline={LINE_OV} items={() => lineMenu(line)} />
              </div>
              {lr.length === 0 ? (
                <div className="ns-ov-emptyline">
                  <span>這條幹線還沒有路線</span>
                  <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => openRouteDialog({ lineId: line.id, editId: null })}>
                    ＋ 路線
                  </button>
                </div>
              ) : (
                <>
                  <div className="ns-ov-grid">
                    {lr.map((r) => (
                      <RouteCard key={r.id} route={r} s={data?.byRoute[r.id] ?? EMPTY_SUMMARY} decimals={decimals} lines={lines} next={nextAims[r.id]} onOpenStation={stationCard.open} />
                    ))}
                  </div>
                  <button type="button" className="ns-ov-addroute" onClick={() => openRouteDialog({ lineId: line.id, editId: null })}>
                    ＋ 路線
                  </button>
                </>
              )}
            </section>
          );
        })}

        {/* 接縫班 D-主-282（丁 D-主-242 留的位置；視覺＝原型 design-structure-獨立頁 的 .garage）：到站的路線從這裡進車庫 */}
        {depotCount > 0 && (
          <button type="button" className="ns-ov-garage" title="到站的路線收在車庫" onClick={() => useUiStore.getState().setPage("depot")}>
            {GNAV_ICONS.depot(20)}
            <span className="gt">車庫</span>
            <span className="gs">到站的路線收在這裡</span>
            <span className="gn">
              <b>{depotCount}</b>條
              <IconChevron size={13} />
            </span>
          </button>
        )}
        </div>
        )}

        <footer className="page-foot">
          <span>私鐵手帳・路線一覽</span>
          <span className="fr">{routes.length} 條路線</span>
        </footer>
        {stationCard.node}
      </div>
    </section>
  );
}
