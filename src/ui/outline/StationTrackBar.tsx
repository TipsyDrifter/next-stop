/**
 * StationTrackBar——路線主畫面「站點軌道條」（回饋專卷 第三梯 3A · D-FB-5；操作 6）。
 *
 * 雙端共用（桌機 Outline 頁首分頁列下方、手機 MobileRouteMap 第二層抬頭下方，大綱與看板分頁皆共享）：
 *   1. 有車站時：以私鐵軌道線串聯各站（● 已到站、◎ 下一站高亮、○ 未到站），每站直印站名、
 *      站內車票完成數 `済 d/t` ＋ 2px 微型進度線（根治舊版未蓋到站前恆 0% 的盲區）與預定／到站日。
 *   2. 無車站時（且非車庫唯讀）：顯示溫潤單行引導「◎ 設第一個車站（階段里程碑）…」，點開即原地新增第一站。
 *   3. 點擊站點：切換「單站聚焦篩選」（大綱與看板同步只顯示隸屬／繼承該站的子樹與卡片；建票預設自動帶入該站）。
 *   4. 拖放歸站：每個站點掛載 `data-drop-target` ＋ `data-drop-type="station"`，從大綱或看板直接把支線、列車、車廂、車票拖上站點即歸站（附復原 Toast）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { NodeRow } from "../../domain";
import { NO_STATION_COL } from "../../domain/board";
import { PARKED_ADD_WHY } from "../../domain/depot";
import { buildStationTrack } from "../../domain/stationTrack";
import type { OccurrenceLike } from "../../domain/taskFilter";
import { useNodeStore, type TreeIndex } from "../../store/nodeStore";
import { setCardsStation } from "../board/boardActions";
import { routeStations } from "../board/useRouteBoard";
import type { Verdict } from "../common/dragReorder";
import { addStation, toggleStationArrived } from "../panel/routeFlows";
import { useStationAimLists } from "../weekAims/StationCard";
import "./station-track.css";

export const STATION_DROP_TYPE = "station";

/* ═══════════════ 單站聚焦篩選（同路線大綱／看板共享） ═══════════════ */

const filterMap = new Map<string, string | null>();
const listeners = new Set<() => void>();

function emitFilterChange(): void {
  for (const fn of listeners) fn();
}

function subscribeFilter(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getRouteStationFilter(routeId: string | null | undefined): string | null {
  if (!routeId) return null;
  return filterMap.get(routeId) ?? null;
}

export function setRouteStationFilter(routeId: string, stationId: string | null): void {
  const prev = filterMap.get(routeId) ?? null;
  if (prev === stationId) return;
  if (stationId === null) filterMap.delete(routeId);
  else filterMap.set(routeId, stationId);
  emitFilterChange();
}

export function useRouteStationFilter(routeId: string | null | undefined): [string | null, (next: string | null) => void] {
  const value = useSyncExternalStore(
    subscribeFilter,
    () => getRouteStationFilter(routeId),
    () => null,
  );
  const set = useCallback(
    (next: string | null) => {
      if (routeId) setRouteStationFilter(routeId, next);
    },
    [routeId],
  );
  return [value, set];
}

/** 驗證目前路線的單站篩選是否仍有效（車站被刪除時自動退回 null，不卡死空畫面） */
export function resolveActiveStationFilter(
  rawFilter: string | null,
  stations: readonly Pick<NodeRow, "id" | "parent_id">[],
  routeId: string | null | undefined,
): string | null {
  if (!rawFilter || !routeId) return null;
  if (rawFilter === NO_STATION_COL) return NO_STATION_COL;
  return stations.some((s) => s.parent_id === routeId && s.id === rawFilter) ? rawFilter : null;
}

/* ═══════════════ 拖曳至站點歸站（大綱／看板雙端共用） ═══════════════ */

const ASSIGNABLE_KINDS = new Set(["branch", "train", "car", "ticket"]);

export function stationTargetVerdict(
  ids: readonly string[],
  targetId: string,
  routeId: string | null | undefined,
  parked = false,
): Verdict {
  if (parked) return PARKED_ADD_WHY;
  if (!routeId || !ids.length) return "這裡放不下";
  const ns = useNodeStore.getState();
  const desired = targetId === NO_STATION_COL ? null : targetId;
  if (desired !== null) {
    const validSt = ns.stations.some((s) => s.id === desired && s.parent_id === routeId);
    if (!validSt) return "找不到這個車站";
  }
  const nodes = ids.map((id) => ns.tree.byId[id]).filter((n): n is NodeRow => !!n);
  if (!nodes.length) return "這裡放不下";
  if (nodes.some((n) => !ASSIGNABLE_KINDS.has(n.kind) || n.route_id !== routeId)) {
    return "只有這條路線的支線、列車、車廂或車票能掛車站";
  }
  const already = nodes.every((n) => n.station_id === desired);
  if (already) return desired === null ? "已經是未排站" : "已經掛在這一站";
  return true;
}

export function dropOnStation(ids: readonly string[], targetId: string, routeId: string | null | undefined): void {
  if (!routeId || !ids.length) return;
  const ns = useNodeStore.getState();
  const nodes = ids.flatMap((id) => ns.tree.byId[id] ?? []).filter((n) => ASSIGNABLE_KINDS.has(n.kind) && n.route_id === routeId);
  if (!nodes.length) return;
  const desired = targetId === NO_STATION_COL ? null : targetId;
  if (desired === null) {
    void setCardsStation(nodes, null, "還沒排站");
    return;
  }
  const st = routeStations(ns.stations, routeId).find((s) => s.id === desired);
  if (!st) return;
  void setCardsStation(nodes, desired, `「${st.name}」`);
}

/* ═══════════════ StationTrackBar 元件 ═══════════════ */

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

export interface StationTrackBarProps {
  route: NodeRow;
  tree: TreeIndex;
  occurrences: Readonly<Record<string, OccurrenceLike | undefined>>;
  parked: boolean;
  onOpenStationCard?(stationId: string, anchor?: HTMLElement): void;
  className?: string;
}

export function StationTrackBar({
  route,
  tree,
  occurrences,
  parked,
  onOpenStationCard,
  className,
}: StationTrackBarProps) {
  const allStations = useNodeStore((s) => s.stations);
  const [rawFilter, setFilter] = useRouteStationFilter(route.id);
  const activeFilter = resolveActiveStationFilter(rawFilter, allStations, route.id);

  // 若篩選的車站已被刪除，順手清掉殘留鍵
  useEffect(() => {
    if (rawFilter !== null && activeFilter === null) {
      setFilter(null);
    }
  }, [rawFilter, activeFilter, setFilter]);

  const track = useMemo(
    () =>
      buildStationTrack({
        routeId: route.id,
        stations: allStations,
        nodes: Object.values(tree.byId),
        byId: tree.byId,
        occurrences,
        routeArrived: !!route.arrived_on,
      }),
    [route.id, route.arrived_on, allStations, tree.byId, occurrences],
  );

  const stationIds = useMemo(() => track.stops.map((s) => s.station.id), [track.stops]);
  const aimsOf = useStationAimLists(stationIds);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAdding(false);
    setDraft("");
  }, [route.id, parked]);

  useEffect(() => {
    if (adding) {
      const id = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
      return () => window.clearTimeout(id);
    }
  }, [adding]);

  const submitStation = async (keepOpen: boolean) => {
    const name = draft.trim();
    if (!name || busy) {
      if (!name && !keepOpen) setAdding(false);
      return;
    }
    setBusy(true);
    try {
      const created = await addStation(route.id, name);
      if (created) {
        setDraft("");
        if (keepOpen) {
          window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
        } else {
          setAdding(false);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const color = route.color ?? "var(--accent)";
  const rcStyle = { "--rc": color } as CSSProperties;

  if (track.stops.length === 0 && parked) return null;

  const inlineForm = (placeholder: string) => (
    <form
      className="ns-stbar-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submitStation(false);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        className="techo-input ns-stbar-input"
        aria-label="新增車站名稱"
        placeholder={placeholder}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submitStation(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft("");
            setAdding(false);
          }
        }}
      />
      <button type="button" className="ns-btn ns-btn--sm btn-seal" disabled={busy || !draft.trim()} onClick={() => void submitStation(false)}>
        建立
      </button>
      <button
        type="button"
        className="ns-btn ns-btn--sm btn-text"
        disabled={busy}
        onClick={() => {
          setDraft("");
          setAdding(false);
        }}
      >
        取消
      </button>
    </form>
  );

  if (track.stops.length === 0) {
    return (
      <div className={`ns-stbar is-empty${className ? " " + className : ""}`} style={rcStyle} role="region" aria-label="路線車站軌道">
        {adding ? (
          inlineForm("第一個車站名稱（例：N5 單字）…")
        ) : (
          <button type="button" className="ns-stbar-empty" onClick={() => setAdding(true)}>
            <span className="mark" aria-hidden>
              ◎
            </span>
            <span>設第一個車站（階段里程碑）…</span>
          </button>
        )}
      </div>
    );
  }

  const activeStop = activeFilter && activeFilter !== NO_STATION_COL ? track.stops.find((s) => s.station.id === activeFilter) : undefined;

  return (
    <div className={className} style={rcStyle}>
      <div className="ns-stbar" role="region" aria-label="路線車站軌道">
        <div className="ns-stbar-left">
          <button
            type="button"
            className={"ns-stbar-all" + (activeFilter === null ? " is-on" : "")}
            aria-pressed={activeFilter === null}
            title="顯示這條路線全部項目"
            onClick={() => setFilter(null)}
          >
            全部
          </button>
          <button
            type="button"
            className={"ns-stbar-all" + (activeFilter === NO_STATION_COL ? " is-on" : "")}
            data-drop-target={NO_STATION_COL}
            data-drop-type={STATION_DROP_TYPE}
            aria-pressed={activeFilter === NO_STATION_COL}
            title="篩選未排站的項目（把項目拖到這裡可解除車站）"
            onClick={() => setFilter(activeFilter === NO_STATION_COL ? null : NO_STATION_COL)}
          >
            未排站{track.unassignedTotal > 0 ? ` ${track.unassignedDone}/${track.unassignedTotal}` : ""}
          </button>
        </div>

        <div className="ns-stbar-rail">
          {track.stops.map((stop, idx) => {
            const st = stop.station;
            const isActive = activeFilter === st.id;
            const aimLen = aimsOf(st.id).length;
            const prevArrived = idx > 0 && track.stops[idx - 1].isArrived;
            return (
              <div key={st.id} className="ns-stbar-item">
                {idx > 0 && <span aria-hidden className={"ns-stbar-link" + (prevArrived ? " is-solid" : "")} />}
                <div
                  className={
                    "ns-stbar-stop" +
                    (stop.isArrived ? " is-arrived" : "") +
                    (stop.isNext ? " is-next" : "") +
                    (isActive ? " is-active" : "")
                  }
                  data-drop-target={st.id}
                  data-drop-type={STATION_DROP_TYPE}
                >
                  <button
                    type="button"
                    className="ns-stbar-main"
                    aria-pressed={isActive}
                    title={
                      isActive
                        ? "再點一次顯示全部項目"
                        : `篩選「${st.name}」的支線、列車與車票（亦可直接拖曳項目到此歸站）`
                    }
                    onClick={() => setFilter(isActive ? null : st.id)}
                  >
                    <span className="ns-stbar-top">
                      <span className="ns-stbar-dot" aria-hidden>
                        {stop.isArrived ? "●" : stop.isNext ? "◎" : "○"}
                      </span>
                      <span className="ns-stbar-name">{st.name}</span>
                    </span>
                    <span className="ns-stbar-meta">
                      <span className="ns-stbar-cnt">
                        済 <b>{stop.ticketDone}/{stop.ticketTotal}</b>
                      </span>
                      {(st.arrived_on || st.expected_on) && (
                        <span className="ns-stbar-date">{st.arrived_on ? `着 ${md(st.arrived_on)}` : md(st.expected_on!)}</span>
                      )}
                    </span>
                    {stop.ticketTotal > 0 && (
                      <span className="ns-stbar-prog" aria-hidden>
                        <span className="ns-stbar-prog-bg">
                          <span className="ns-stbar-prog-fill" style={{ width: `${stop.ticketPct}%` }} />
                        </span>
                      </span>
                    )}
                  </button>

                  <span className="ns-stbar-acts">
                    {onOpenStationCard && (
                      <button
                        type="button"
                        className={"ns-stbar-aim" + (aimLen > 0 ? " has-aims" : "")}
                        aria-haspopup="dialog"
                        aria-label={`車站「${st.name}」的方針`}
                        title={aimLen > 0 ? `本站方針 ${aimLen} 條` : "編輯本站方針"}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenStationCard(st.id, e.currentTarget);
                        }}
                      >
                        {aimLen > 0 ? `方針 ${aimLen}` : "方針"}
                      </button>
                    )}
                    {!parked && (
                      <button
                        type="button"
                        className={"ns-stbar-arr" + (stop.isArrived ? " is-arrived" : "")}
                        aria-pressed={stop.isArrived}
                        aria-label={stop.isArrived ? `取消「${st.name}」到站` : `標記「${st.name}」到站`}
                        title={stop.isArrived ? "已到站（再點取消）" : "蓋「着」標記到站（今天）"}
                        onClick={(e) => {
                          e.stopPropagation();
                          const btn = e.currentTarget;
                          toggleStationArrived(
                            st,
                            onOpenStationCard ? { onReview: () => onOpenStationCard(st.id, btn) } : undefined,
                          );
                        }}
                      >
                        着
                      </button>
                    )}
                  </span>
                </div>
              </div>
            );
          })}

          {!parked &&
            (adding ? (
              inlineForm("新增車站名稱…")
            ) : (
              <button type="button" className="ns-stbar-addbtn" title="在這條路線尾端新增車站" onClick={() => setAdding(true)}>
                ＋ 車站
              </button>
            ))}
        </div>
      </div>

      {activeFilter !== null && (
        <div className="ns-stbar-filter-banner" role="status">
          <span>
            {activeStop ? (
              <>
                單站聚焦：<b>◎ {activeStop.station.name}</b>（新建項目將預設掛入本站）
              </>
            ) : (
              <>
                篩選中：<b>未排站項目</b>
              </>
            )}
          </span>
          <button type="button" className="ns-btn ns-btn--sm btn-text" onClick={() => setFilter(null)}>
            顯示全部
          </button>
        </div>
      )}
    </div>
  );
}
