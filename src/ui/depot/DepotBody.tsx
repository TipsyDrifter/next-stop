/**
 * 車庫頁的內容（兩殼共用）：乘車記錄籤＝區段「車庫」（書架＋還在跑）＋印譜帳；走行圖籤＝RouteNetwork；年鑑籤＝Yearbook。
 * 頁開著時新冒出來的章（剛蓋下）在印譜帳跑一次 stampIn。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildShelf } from "../../domain/depot";
import type { NodeRow } from "../../domain/node";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { EmptyState } from "../common/EmptyState";
import { Album } from "./Album";
import { RouteNetwork } from "./RouteNetwork";
import { RunningList } from "./RunningList";
import { Shelf } from "./Shelf";
import { Yearbook } from "./Yearbook";
import { openedOf, useDayStartHour } from "./depotParts";
import "./depot.css";

/** 頁開著時新出現的章 id（第一次載入的不算） */
function useFreshStampIds(): ReadonlySet<string> {
  const stamps = useDepotStore((s) => s.stamps);
  const loaded = useDepotStore((s) => s.data !== null);
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(stamps.map((s) => s.id));
    if (seen.current) {
      const prev = seen.current;
      const added = [...ids].filter((id) => !prev.has(id));
      if (added.length) setFresh(new Set(added));
    }
    seen.current = ids;
  }, [stamps, loaded]);
  return fresh;
}

export function DepotBody() {
  const tab = useDepotStore((s) => s.tab);
  const data = useDepotStore((s) => s.data);
  const stamps = useDepotStore((s) => s.stamps);
  const openBook = useDepotStore((s) => s.openBook);
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  const h = useDayStartHour();
  const items = useMemo(() => buildShelf(lines, routes), [lines, routes]);
  const opened = useCallback((r: NodeRow) => openedOf(r, data, h), [data, h]);
  const fresh = useFreshStampIds();

  if (tab === "year") return <Yearbook onOpen={openBook} />;
  if (tab === "map") return <RouteNetwork onOpen={openBook} />;
  if (!data) return null; // 資料還沒到：留白，不先閃空狀態（§1.8）

  return (
    <>
      <div className="sec">
        <h3>車庫</h3>
        <span className="rule" />
        <span className="note">到站的幹線與路線</span>
      </div>
      <div className="ns-depot-garage">
        {items.length ? (
          <Shelf items={items} routeSeals={data.routeSeals} openedOn={opened} onOpen={openBook} />
        ) : (
          <EmptyState
            inline
            tone="first"
            title="車庫還是空的"
            desc="路線跑完了，在路線詳情按「到站・收進車庫」，就會停在這裡。"
          />
        )}
        <RunningList routes={liveRoutes} openedOn={opened} onOpen={openBook} />
      </div>
      <Album stamps={stamps} onOpen={openBook} freshIds={fresh} />
    </>
  );
}
