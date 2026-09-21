/**
 * Outline——丙式主視圖的主欄（路線大綱）＝攤開的紙頁。結構與 class 1:1 照抄 prototypes/m1-c-techo.html（CSS 在 styles/techo.css）：
 * .page > .sheet > header.day（.overline 幹線 — 代碼／zoom 麵包屑・.date-line 路線名＋類型＋代碼・
 *   .day-stats「車票 n/N 済・進度 P%・節點 M」〔件一 m3-ext-routemap.html 定稿口徑〕・右側 .station-stamp 下一站）
 * ＋ .sec「列車」＋ .ticket-list（OutlineRow／DraftRow 完整車票）＋（有過期者）.sec.late「誤點」＋ LateRow ＋ .page-foot。
 * 鍵盤流掛在容器（tabIndex=0），狀態與流程在 useOutlineController。對應 UI Flow 2.0／2.0a／2.0b／2.0c／2.0d／2.0e。
 * 取捨：原型沒有的控件（隱藏已完成）做成 hover 才現身的小字；列不做虛擬捲動；拖曳排序之後實作（鍵盤 Alt+↑↓ 已有）。
 */
import { useEffect, useRef, useState } from "react";
import { KIND_LABEL, type NodeKind, type NodeRow } from "../../domain";
import { ancestorsOf, serialOf, useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { StationStamp } from "../stamps";
import { Breadcrumb } from "./Breadcrumb";
import { DraftRow, LateRow, OutlineRow, type CarStats } from "./OutlineRow";
import { useOutlineController } from "./useOutlineController";
import { useOutlineKeyboard } from "./useOutlineKeyboard";
import "./outline.css";

/** 情境 5：載入 >200ms 才顯示安靜指示，避免閃爍 */
function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [flag, ms]);
  return on;
}

/** 兩個日期 key（YYYY-MM-DD）相差幾天（a − b） */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(ay, am - 1, ad).getTime() - new Date(by, bm - 1, bd).getTime()) / 86_400_000);
}

/** 頁尾「Day N / 365」 */
function dayOfYear(): { day: number; total: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const end = new Date(now.getFullYear() + 1, 0, 1);
  const day = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - start.getTime()) / 86_400_000) + 1;
  const total = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return { day, total };
}

/** 頁首「下一站」紀念章＝E4 印章家族的 StationStamp（src/ui/stamps）；
 * className 沿用件一的 .station-stamp 只為拿 techo.css 的版位（margin／flex:none），墨色全由 stamps.css 出。 */
function NextStationStamp({ code, station, pct }: { code: string | null; station: NodeRow; pct: number }) {
  const percent = Math.round(pct * 100);
  return (
    <StationStamp
      className="station-stamp"
      size={122}
      arcLabel={`${code ? `${code} LINE · ` : ""}NEXT STATION`}
      caption="下一站"
      name={station.name.length > 6 ? `${station.name.slice(0, 5)}…` : station.name}
      percent={percent}
      statusText="進行中"
      title={`下一站 ${station.name}，進度 ${percent}%`}
    />
  );
}

/** 空狀態：原型 .sec（襯線標題＋虛線延伸）＋一句手帳口吻＋文字入口 */
function EmptyBlock({ title, body, action, onAction }: { title: string; body?: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty">
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

export function Outline() {
  const containerRef = useRef<HTMLDivElement>(null);
  const c = useOutlineController(containerRef);
  const onKeyDown = useOutlineKeyboard(c.keys);
  const toggleHideDone = useUiStore((s) => s.toggleHideDone);
  const expand = useUiStore((s) => s.expand);
  const stations = useNodeStore((s) => s.stations);
  const serials = useNodeStore((s) => s.serials);
  const showLoading = useDelayedFlag(c.loading, 200);
  const doy = dayOfYear();

  if (!c.routeId) {
    return (
      <section className="page ns-outline" aria-label="路線大綱">
        <div className="sheet">
          <EmptyBlock title="選一條路線開始鋪軌" body="左側書封是你的路線網絡——點一條路線，這一頁就是它的大綱。" />
          <footer className="page-foot">
            <span>私鐵手帳・路線大綱</span>
            <span className="fr">
              Day {doy.day} / {doy.total}
            </span>
          </footer>
        </div>
      </section>
    );
  }

  const title = c.zoom ? c.zoom.name : (c.route?.name ?? "…");
  const code = c.route?.code ?? null;
  const draft = c.edit?.mode === "draft" ? c.edit : null;
  const hasAnyNode = c.rootChildren.length > 0;
  const accent = c.route?.color ?? undefined;

  // 頁首統計＝件一定稿口徑（m3-ext-routemap.html：車票 n/N 済・進度 P%・節點 M）：
  // 進度＝子樹「車票済／總車票」自動彙總；節點＝範圍內全部節點（列車＋車廂＋車票，車站不在樹裡）。
  let total = 0;
  let ticketTotal = 0;
  let ticketDone = 0;
  const collectStats = (id: string) => {
    const n = c.tree.byId[id];
    if (!n) return;
    total += 1;
    if (n.kind === "ticket") {
      ticketTotal += 1;
      // 定期券的済蓋在「目前班次」上（nodes.status 一路是 todo）——票面看得到済章，頁首就得跟著算
      if (c.isDoneNode(n)) ticketDone += 1;
    }
    for (const k of c.tree.childrenOf[id] ?? []) collectStats(k);
  };
  for (const id of c.rootChildren) collectStats(id);
  const ticketPct = ticketTotal > 0 ? Math.round((ticketDone / ticketTotal) * 100) : 0;
  // 整條路線的進度（車站紀念章的進度弧）
  let routeTotal = 0;
  let routeOpen = 0;
  for (const id of c.tree.roots) {
    const cc = c.counts[id];
    const n = c.tree.byId[id];
    routeTotal += 1 + (cc?.total ?? 0);
    routeOpen += (n?.status === "done" ? 0 : 1) + (cc?.open ?? 0);
  }
  const routePct = routeTotal > 0 ? (routeTotal - routeOpen) / routeTotal : 0;
  // 下一站：這條路線尚未到站的第一個車站
  const nextStation = stations
    .filter((s) => s.parent_id === c.routeId && !s.arrived_on)
    .sort((a, b) => a.position - b.position)[0];

  /** 票號＝store 的 serials 表（當日全域發券序；大綱票根／側板票頭／今日列同一枚號碼） */
  const serial = (node: NodeRow): string => serialOf(serials, node.id);
  /** 車廂格＝直屬子項進度；格子名稱依子項種類（全是車票→車票；有車廂→車廂；支線底下→列車） */
  const carsOf = (id: string, kind: NodeKind): CarStats | null => {
    const kids = c.tree.childrenOf[id] ?? [];
    if (!kids.length) return null;
    let done = 0;
    let hasCar = false;
    let allTicket = true;
    for (const k of kids) {
      const n = c.tree.byId[k];
      if (!n) continue;
      if (n.status === "done") done++;
      if (n.kind === "car") hasCar = true;
      if (n.kind !== "ticket") allTicket = false;
    }
    const label = allTicket ? "車票" : hasCar ? "車廂" : kind === "branch" ? "列車" : "車廂";
    return { total: kids.length, done, label };
  };

  // 誤點：目前範圍內執行日過期且未完成者（依原定日排序）。
  // 定期券「這一班」已經有結局（済／運休）就不算誤點——済／運休之後引擎會把 scheduled_on 推到下一班，
  // 但補済舊班次的那一瞬間 scheduled_on 仍可能落在過去，所以先看 currentOccurrences（＝已交代）。
  const lateNodes: NodeRow[] = [];
  for (const id in c.tree.byId) {
    const n = c.tree.byId[id];
    if (n.status === "done" || c.currentOccurrences[id]) continue;
    if (!n.scheduled_on || n.scheduled_on >= c.today) continue;
    if (c.zoom && !ancestorsOf(c.tree, c.routeId, id).includes(c.zoom.id)) continue;
    lateNodes.push(n);
  }
  lateNodes.sort((a, b) => (a.scheduled_on! < b.scheduled_on! ? -1 : a.scheduled_on! > b.scheduled_on! ? 1 : 0));
  const pickLate = (id: string) => {
    expand(ancestorsOf(c.tree, c.routeId, id));
    c.row.select(id);
    c.row.focusContainer();
  };

  let empty: { title: string; body?: string; action?: string } | null = null;
  if (c.rows.length === 0 && !draft) {
    if (!hasAnyNode && c.zoom) {
      empty = {
        title: `「${c.zoom.name}」底下還沒有內容`,
        body: `按 Enter 在這${KIND_LABEL[c.zoom.kind]}底下新增第一筆；Esc 回上一層。`,
        action: "新增第一筆",
      };
    } else if (!hasAnyNode) {
      empty = {
        title: "這條路線還沒有列車",
        body: "按 Enter 新增第一班——列車是一件要完成的事，車廂是它的子任務，車票是最末端的待辦。",
        action: "新增第一班列車",
      };
    } else {
      empty = { title: "已完成的班次都收起來了", body: "關掉「隱藏已完成」就能看到它們。" };
    }
  }

  return (
    <section ref={containerRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="路線大綱" className="page ns-outline">
      <div className="sheet">
        {/* 頁首（原型 header.day） */}
        <header className="day">
          <div className="day-head">
            {c.zoom ? (
              <Breadcrumb items={c.crumbs} onJump={c.zoomTo} />
            ) : (
              <p className="overline">
                {c.line?.name ?? "路線"}
                {code ? ` — ${code}` : ""}
              </p>
            )}
            <div className="date-line">
              <span className="d">{title}</span>
              <span className="w">{c.zoom ? KIND_LABEL[c.zoom.kind] : "路線"}</span>
              {code && <span className="latin">{code} Line</span>}
            </div>
            {total > 0 && (
              <p className="day-stats" title="車票済／全部・子樹進度・節點數">
                {ticketTotal > 0 && (
                  <>
                    車票 <b>{ticketDone}/{ticketTotal}</b> 済<span className="dot">・</span>
                    進度 <b>{ticketPct}%</b>
                    <span className="dot">・</span>
                  </>
                )}
                節點 <b>{total}</b>
                {/* 原型沒有的控件：hover 才現身（開啟中則常駐） */}
                <button type="button" tabIndex={-1} aria-pressed={c.hideDone} onMouseDown={(e) => e.preventDefault()} onClick={toggleHideDone} className="hide-done">
                  {c.hideDone ? "顯示已完成" : "隱藏已完成"}
                </button>
              </p>
            )}
          </div>
          {nextStation && <NextStationStamp code={code} station={nextStation} pct={routePct} />}
        </header>

        {showLoading && c.rows.length === 0 && (
          <div className="sec">
            <span className="rule" />
            <span className="note">讀取中…</span>
          </div>
        )}

        {empty ? (
          <EmptyBlock title={empty.title} body={empty.body} action={empty.action} onAction={empty.action ? c.startFirstDraft : undefined} />
        ) : (
          <>
            <div className="sec">
              <h3>列車</h3>
              <span className="rule" />
              <span className="note">發券 {total} 張</span>
            </div>
            <ul role="tree" aria-label={`${title} 的大綱`} className="ticket-list">
              {c.rows.map((r) => {
                if (r.type === "draft") {
                  if (!draft || !c.draftHandlers) return null;
                  return (
                    <DraftRow key={`draft:${draft.parentId}:${draft.afterId ?? "$end"}`} depth={r.depth} kind={draft.kind} accent={accent} handlers={c.draftHandlers} />
                  );
                }
                const node = c.tree.byId[r.id];
                if (!node) return null;
                const renaming = c.edit?.mode === "rename" && c.edit.id === r.id ? c.renameHandlers : null;
                return (
                  <OutlineRow
                    key={r.id}
                    node={node}
                    depth={r.depth}
                    hasChildren={(c.tree.childrenOf[r.id]?.length ?? 0) > 0}
                    collapsed={!!c.collapsed[r.id]}
                    selected={c.selectedId === r.id}
                    fresh={c.freshId === r.id}
                    today={c.today}
                    cars={carsOf(r.id, node.kind)}
                    accent={accent}
                    serial={serial(node)}
                    occurrence={c.currentOccurrences[r.id] ?? null}
                    rename={renaming}
                    actions={c.row}
                    onFreshEnd={c.clearFresh}
                  />
                );
              })}
            </ul>
          </>
        )}

        {lateNodes.length > 0 && (
          <>
            <div className="sec late">
              <h3>誤點</h3>
              <span className="rule" />
              <span className="note">{lateNodes.length} 班</span>
            </div>
            <div className="ticket-list" aria-label="誤點">
              {lateNodes.map((n) => (
                <LateRow
                  key={n.id}
                  node={n}
                  daysLate={diffDays(c.today, n.scheduled_on!)}
                  railDate={c.currentOccurrences[n.id]?.due_on ?? n.scheduled_on}
                  accent={accent}
                  serial={serial(n)}
                  onPick={pickLate}
                />
              ))}
            </div>
          </>
        )}

        <footer className="page-foot">
          <span>私鐵手帳・{c.route?.name ?? "路線大綱"}</span>
          <span className="fr">
            Day {doy.day} / {doy.total}
          </span>
        </footer>
      </div>
    </section>
  );
}
