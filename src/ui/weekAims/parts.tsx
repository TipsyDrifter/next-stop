/**
 * 週方針的小件（戊）：掛的地方（路線或支線，D-主-281）的標（點了進那裡）、検印小圈／済小章、打勾圖示、「已排」那一行。兩殼共用。
 */
import { useMemo } from "react";
import type { NodeRow } from "../../domain";
import { planHint, type PlanCount, type WeekAimRow } from "../../domain/weekAims";
import { roundelStyle } from "../common/roundel";
import { jumpToNode } from "../common/QuickJump";
import { jumpToNodeMobile } from "../mobile/routeMapReveal";
import { useNodeStore } from "../../store/nodeStore";
import { useWeekAimStore } from "../../store/weekAimStore";

/** 一句掛的地方：路線本身（node＝route）或路線裡的一條支線 */
export interface AimPlace {
  route: NodeRow;
  node: NodeRow;
}

/** 標上的字：路線＝路線名；支線＝支線名（圓牌是所屬路線的） */
export function aimPlaceName(p: AimPlace): string {
  return p.node.id === p.route.id ? p.route.name : p.node.name;
}

/** 完整的位置字：「路線」或「路線 › 支線」（title、說明用） */
export function aimPlacePath(p: AimPlace): string {
  return p.node.id === p.route.id ? p.route.name : `${p.route.name} › ${p.node.name}`;
}

/** node_id → 掛的地方；路線看 nodeStore.routes、支線看 weekAimStore.aimNodes（載週時記下的）。找不到＝null */
export function useAimPlaceOf(): (id: string | null) => AimPlace | null {
  const routes = useNodeStore((s) => s.routes);
  const extra = useWeekAimStore((s) => s.aimNodes);
  return useMemo(() => {
    const byId = new Map(routes.map((r) => [r.id, r]));
    return (id: string | null) => {
      if (!id) return null;
      const r = byId.get(id);
      if (r) return { route: r, node: r };
      const n = extra[id];
      const owner = n?.route_id ? byId.get(n.route_id) : undefined;
      return n && owner ? { route: owner, node: n } : null;
    };
  }, [routes, extra]);
}

/** 路線圓牌（亮盤深字，17px）＋路線或支線名；點了進那裡（桌機路線圖／手機路線圖第二層） */
export function RouteTag({ place, shell, onGo }: { place: AimPlace; shell: "desktop" | "mobile"; onGo?: () => void }) {
  return (
    <button
      type="button"
      className="wa-tag"
      title={`看「${aimPlacePath(place)}」`}
      onClick={(e) => {
        e.stopPropagation();
        onGo?.();
        void (shell === "mobile" ? jumpToNodeMobile(place.node) : jumpToNode(place.node));
      }}
    >
      <RouteMark route={place.route} />
      {aimPlaceName(place)}
    </button>
  );
}

/** 只有圓牌（寫方針框的 chip、挑選器外的標示） */
export function RouteMark({ route }: { route: Pick<NodeRow, "code" | "name" | "color"> }) {
  return (
    <span className="wa-rd" aria-hidden style={roundelStyle(route.color)}>
      {route.code ?? route.name.slice(0, 1)}
    </span>
  );
}

/** 検印小圈（還沒済）／済小章；點了切換。済只給朱（.ns-imp 的印色） */
export function AimStamp({ aim }: { aim: WeekAimRow }) {
  const done = aim.done_at !== null;
  return (
    <button
      type="button"
      className="wa-stamp"
      aria-pressed={done}
      aria-label={`${done ? "取消済" : "蓋済"}：${aim.text}`}
      title={done ? "取消済" : "蓋済"}
      onClick={(e) => {
        e.stopPropagation();
        void useWeekAimStore.getState().toggleDone(aim);
      }}
    >
      {done ? (
        <span className="ns-imp wa-seal" aria-hidden>
          済
        </span>
      ) : (
        <span className="wa-ring" aria-hidden />
      )}
    </button>
  );
}

/** 「已排 2 張・済 1」／「排的票都済了」；數字加粗。沒有＝null */
export function PlanLine({ aim, count, emptyText }: { aim: WeekAimRow; count: PlanCount | undefined; emptyText?: string }) {
  const hint = aim.node_id || count ? planHint(aim.done_at !== null, count) : null;
  if (!hint) return emptyText ? <p className="wa-sub">{emptyText}</p> : null;
  const parts = hint.split(/(\d+)/);
  return (
    <p className="wa-sub">
      {parts.map((p, i) => (/^\d+$/.test(p) ? <b key={i}>{p}</b> : <span key={i}>{p}</span>))}
    </p>
  );
}

/** 打勾（「已帶到下週」用；icons.tsx 沒有這一枚，形狀同原型 ICON.check） */
export function IconCheckMini() {
  return (
    <svg className="ns-ico" width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3.2 8.4 6.4 11.4 12.8 4.6" />
    </svg>
  );
}
