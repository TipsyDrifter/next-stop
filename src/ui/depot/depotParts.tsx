/**
 * 車庫頁的小零件（兩殼共用）：路線徽、運行中膠囊、書背的小済印、印章的上下文（代碼、路線名、開業日）、
 * 頁首補述那一句、開業日的退路。
 */
import { useMemo, type CSSProperties } from "react";
import type { DepotData } from "../../data/depotRepository";
import type { NodeRow } from "../../domain/node";
import type { StampRow } from "../../domain/stamps";
import { dayKeyOf } from "../../lib/date";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import "./depot.css";

/** 路線色（null＝預設第 4 色） */
export const routeColor = (r: Pick<NodeRow, "color"> | null | undefined): string => r?.color ?? "var(--route-preset-4)";

export const rcStyle = (r: Pick<NodeRow, "color"> | null | undefined): CSSProperties => ({ "--rc": routeColor(r) }) as CSSProperties;

/** 路線徽：外框圓、路線色，寫代碼；沒有代碼＝一顆路線色小點 */
export function RouteBadge({ route, small }: { route: Pick<NodeRow, "code" | "color">; small?: boolean }) {
  return (
    <span className={"ns-depot-badge" + (small ? " is-sm" : "")} style={rcStyle(route)} aria-hidden="true">
      {route.code ? route.code : <i />}
    </span>
  );
}

export function RunPill() {
  return <span className="ns-depot-pill">運行中</span>;
}

export function MiniSumi() {
  return (
    <span className="ns-depot-mini-sumi" aria-hidden="true">
      済
    </span>
  );
}

/** 開業日：車庫資料有就用，沒有（資料還沒到）退回路線建立那天 */
export function openedOf(route: Pick<NodeRow, "id" | "created_at">, data: DepotData | null, dayStartHour: number): string {
  return data?.openedOn[route.id] ?? dayKeyOf(route.created_at, dayStartHour);
}

export interface StampCtx {
  /** 點了開記錄簿的路線（車站章＝它所在的路線；路線章、開業一年章＝那條路線）；沒有＝不可點 */
  routeId: string | null;
  routeCode: string | null;
  routeName: string | null;
  openedOn: string | null;
}

const NONE: StampCtx = { routeId: null, routeCode: null, routeName: null, openedOn: null };

/** 一枚章的上下文（查不到就留空，章上省略那一段） */
export function useStampCtx(): (s: Pick<StampRow, "kind" | "subject_id">) => StampCtx {
  const routes = useNodeStore((s) => s.routes);
  const stations = useNodeStore((s) => s.stations);
  const data = useDepotStore((s) => s.data);
  return useMemo(() => {
    const routeById = new Map(routes.map((r) => [r.id, r] as const));
    const stationById = new Map(stations.map((st) => [st.id, st] as const));
    const opened = data?.openedOn ?? {};
    return (s) => {
      if (!s.subject_id) return NONE;
      if (s.kind === "station") {
        const st = stationById.get(s.subject_id);
        const r = st?.route_id ? routeById.get(st.route_id) : undefined;
        return r ? { routeId: r.id, routeCode: r.code, routeName: r.name, openedOn: opened[r.id] ?? null } : NONE;
      }
      if (s.kind === "route" || s.kind === "route_year") {
        const r = routeById.get(s.subject_id);
        return r ? { routeId: r.id, routeCode: r.code, routeName: r.name, openedOn: opened[r.id] ?? null } : NONE;
      }
      if (s.kind === "line") {
        // 幹線的開業日＝底下路線最早的那天
        let first: string | null = null;
        for (const r of routes) if (r.line_id === s.subject_id && opened[r.id] && (!first || opened[r.id] < first)) first = opened[r.id];
        return { ...NONE, openedOn: first };
      }
      return NONE;
    };
  }, [routes, stations, data]);
}

/** 頁首補述：車庫裡 N 條幹線、M 條路線・済章 K 枚（幹線 0 條就不寫那段） */
export function DepotSummary({ className }: { className: string }) {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const liveLines = useNodeStore((s) => s.liveLines);
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  // 済章＝車庫裡這幾條路線的済（AVD O-2：用全部的済讀起來像在講車庫裡的路線）
  const data = useDepotStore((s) => s.data);
  const seals = data ? routes.reduce((sum, r) => sum + (r.arrived_on ? (data.routeSeals[r.id] ?? 0) : 0), 0) : null;
  const nLines = lines.length - liveLines.length;
  const nRoutes = routes.length - liveRoutes.length;
  return (
    <span className={className}>
      車庫裡
      {nLines > 0 && (
        <>
          <b>{nLines}</b>條幹線、
        </>
      )}
      <b>{nRoutes}</b>條路線
      {seals !== null && (
        <>
          ・済章<b>{seals.toLocaleString("en-US")}</b>枚
        </>
      )}
    </span>
  );
}

export const useDayStartHour = () => useUiStore((s) => s.dayStartHour);
