/**
 * 還在跑（車庫與回顧 D-主-217；原型 `running`）：還在跑的路線，每列圓牌＋名字＋「M.D 開業」＋›，點了開記錄簿。
 * 守則：寫開業日、不寫「跑了 N 天」。沒有還在跑的路線＝整段不畫。
 */
import { fmtMD } from "../../domain/depot";
import type { NodeRow } from "../../domain/node";
import { RouteBadge, RunPill } from "./depotParts";
import "./depot.css";

export interface RunningListProps {
  routes: readonly NodeRow[];
  openedOn: (route: NodeRow) => string;
  onOpen: (routeId: string) => void;
}

export function RunningList({ routes, openedOn, onOpen }: RunningListProps) {
  if (!routes.length) return null;
  return (
    <div className="ns-depot-running">
      <p className="ns-depot-run-h">
        還在跑
        <RunPill />
      </p>
      {routes.map((r) => (
        <button key={r.id} type="button" className="ns-depot-run-row" data-route-id={r.id} onClick={() => onOpen(r.id)}>
          <RouteBadge route={r} small />
          <span className="nm">{r.name}</span>
          <span className="d">{fmtMD(openedOn(r))} 開業</span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </button>
      ))}
    </div>
  );
}
