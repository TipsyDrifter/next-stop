/**
 * 排成車票（戊 D-主-256；原型場景 a-plan）。桌機＝錨在那句底下的小浮層；手機＝底部面板（MobileWeekAims 用 `PlanTicketForm`）。
 *
 * 票名預填那句（可改）、「放在」預設掛的路線或支線（可換到路線或它底下的支線／列車／車廂）、乘車日預設這一期還沒過的第一天（車站＝今天）＋往後那套快選。`weekOn` 收任何期間鍵。
 * 落點規則在純函式 `ticketPlacement`（路線不能直接放票 ⇒ 根層臨時車票＋路線標籤；支線／列車／車廂 ⇒ 建在它底下，D-主-281）。
 * Enter＝発券、Esc＝收起（自己吃掉，不連關外層）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AttachTarget } from "../../domain/notes";
import { planDefaultDay, stationIdOfKey, ticketPlacement, type WeekAimRow } from "../../domain/weekAims";
import { nodeRepo } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { AttachPicker } from "../common/AttachPicker";
import { MobileAttachPicker } from "../common/MobileAttachPicker";
import { DateChip } from "../common/DateChip";
import { IconChevron } from "../common/icons";
import { RouteMark, useAimPlaceOf } from "./parts";

/** 放在哪：路線（整條）或它底下的支線／列車／車廂；null＝沒掛（臨時車票） */
export interface PlanPlace {
  target: AttachTarget;
  name: string;
}

export interface PlanFormApi {
  name: string;
  setName(v: string): void;
  place: PlanPlace | null;
  setPlace(p: PlanPlace | null): void;
  day: string;
  setDay(d: string): void;
  busy: boolean;
  submit(): Promise<boolean>;
}

/** 表單狀態與送出（兩殼共用） */
export function usePlanForm(aim: WeekAimRow, weekOn: string, today: string): PlanFormApi {
  // 車站沒掛的句子：預設放在這條路線（已排也看這條路線，§2）
  const stationId = stationIdOfKey(weekOn);
  const stationRoute = useNodeStore((s) => (stationId ? (s.stations.find((x) => x.id === stationId)?.parent_id ?? null) : null));
  const at = useAimPlaceOf()(aim.node_id ?? stationRoute);
  const [name, setName] = useState(aim.text);
  const [place, setPlace] = useState<PlanPlace | null>(() => {
    if (!at) return null;
    if (at.node.id === at.route.id) return { target: { routeId: at.route.id, nodeId: null, nodeKind: "route" }, name: at.route.name };
    return { target: { routeId: at.route.id, nodeId: at.node.id, nodeKind: "branch" }, name: at.node.name };
  });
  const [day, setDay] = useState(() => planDefaultDay(today, weekOn));
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      let placement = ticketPlacement(null);
      if (place?.target.nodeId) {
        const n = await nodeRepo.getNode(place.target.nodeId);
        placement = n ? ticketPlacement(n) : ticketPlacement(null);
      } else if (place?.target.routeId) {
        placement = ticketPlacement({ id: place.target.routeId, kind: "route", route_id: null });
      }
      return await useWeekAimStore.getState().planTicket(aim, { name, ...placement, day });
    } finally {
      setBusy(false);
    }
  };
  return { name, setName, place, setPlace, day, setDay, busy, submit };
}

function PlaceLabel({ place }: { place: PlanPlace | null }) {
  const routes = useNodeStore((s) => s.routes);
  const route = place ? (routes.find((r) => r.id === place.target.routeId) ?? null) : null;
  if (!place) return <span className="nm">不掛（臨時車票）</span>;
  return (
    <>
      {route && <RouteMark route={route} />}
      <span className="nm">{place.target.nodeId ? `${route ? route.name + " › " : ""}${place.name}` : place.name}</span>
    </>
  );
}

/** 「放在」挑選結果 → PlanPlace（支線／列車／車廂的名字問 repository） */
async function placeOf(t: AttachTarget, routeName: string): Promise<PlanPlace> {
  if (!t.nodeId) return { target: t, name: routeName };
  const n = await nodeRepo.getNode(t.nodeId);
  return { target: t, name: n?.name ?? "" };
}

/** 桌機小浮層 */
export function PlanTicketPop({ aim, weekOn, today, onClose }: { aim: WeekAimRow; weekOn: string; today: string; onClose(): void }) {
  const f = usePlanForm(aim, weekOn, today);
  const routes = useNodeStore((s) => s.routes);
  const [picking, setPicking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
    rootRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  // 點浮層外面＝收起（日期挑選器掛在 body，點它不算外面）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || rootRef.current?.contains(t)) return;
      if (t.closest?.(".ns-datepick, .ns-datepicker, [role='dialog']")) return;
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const go = async () => {
    if (await f.submit()) onClose();
  };

  return (
    <div
      ref={rootRef}
      className="techo-card wa-pop"
      role="dialog"
      aria-label="排成車票"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="wa-poplabel">排成車票</div>
      <div className="fld">
        <span className="techo-label">票名</span>
        <input
          ref={inputRef}
          className="techo-input"
          value={f.name}
          aria-label="票名"
          onChange={(e) => f.setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void go();
            }
          }}
        />
      </div>
      <div className="fld">
        <span className="techo-label">放在</span>
        <span>
          <button
            type="button"
            className={"chip ns-chip wa-chip" + (f.place ? "" : " is-empty") + (picking ? " is-open" : "")}
            aria-haspopup="dialog"
            aria-expanded={picking}
            title="換一個地方（路線，或路線裡的支線、列車、車廂）"
            onClick={() => setPicking((v) => !v)}
          >
            <PlaceLabel place={f.place} />
            <IconChevron size={12} />
          </button>
        </span>
        {picking && (
          <AttachPicker
            depth="node"
            kinds={["branch", "train", "car"]}
            routeSelectable
            float
            label="放在哪條路線、支線或列車"
            value={f.place?.target ?? { routeId: null, nodeId: null, nodeKind: null }}
            onPick={(t) => {
              setPicking(false);
              const r = routes.find((x) => x.id === t.routeId);
              void placeOf(t, r?.name ?? "").then(f.setPlace);
            }}
            onClear={() => {
              setPicking(false);
              f.setPlace(null);
            }}
            clearLabel="不掛（臨時車票）"
            onClose={() => setPicking(false)}
          />
        )}
      </div>
      <div className="fld is-top">
        <span className="techo-label">乘車日</span>
        <DateChip date={f.day} onPick={(d) => d && f.setDay(d)} quick="forward" label="乘車日" today={today} />
      </div>
      <div className="foot">
        <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="ns-btn btn-seal" disabled={f.busy || !f.name.trim()} onClick={() => void go()}>
          発券
        </button>
      </div>
    </div>
  );
}

/** 手機底部面板的表單本文（殼由 MobileWeekAims 給） */
export function PlanTicketForm({ f, today, foot }: { f: PlanFormApi; today: string; foot?: ReactNode }) {
  const routes = useNodeStore((s) => s.routes);
  const [picking, setPicking] = useState(false);
  return (
    <div className="wa-mform">
      <div className="fld">
        <span className="techo-label">票名</span>
        <input className="techo-input" value={f.name} aria-label="票名" onChange={(e) => f.setName(e.target.value)} />
      </div>
      <div className="fld">
        <span className="techo-label">放在</span>
        <span>
          <button
            type="button"
            className={"chip ns-chip wa-chip" + (f.place ? "" : " is-empty")}
            aria-haspopup="dialog"
            onClick={() => setPicking(true)}
          >
            <PlaceLabel place={f.place} />
            <IconChevron size={12} />
          </button>
        </span>
      </div>
      <div className="fld">
        <span className="techo-label">乘車日</span>
        <DateChip date={f.day} onPick={(d) => d && f.setDay(d)} quick="forward" label="乘車日" today={today} />
      </div>
      {foot}
      {picking && (
        <MobileAttachPicker
          title="放在哪條路線、支線或列車"
          depth="node"
          kinds={["branch", "train", "car"]}
          routeSelectable
          value={f.place?.target ?? null}
          backKind="dialog"
          onPick={(t, names) => {
            setPicking(false);
            const r = routes.find((x) => x.id === t.routeId);
            f.setPlace({ target: t, name: t.nodeId ? (names.node ?? "") : (r?.name ?? names.route) });
          }}
          onClear={() => {
            setPicking(false);
            f.setPlace(null);
          }}
          clearLabel="不掛（臨時車票）"
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
