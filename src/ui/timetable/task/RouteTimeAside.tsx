/**
 * RouteTimeAside——手機路線圖第一層每條路線列尾的本月時數「3h」（③ 契約 §5.6、D-時-53；丙席）。
 * 經 mount 的 `routeListAside`（接縫 #63）登記，排在售票口的「本月花費」之後（三線固定順序：manifest 順序）。
 *
 * **只回 span、不放可點的東西**（它在主線的 `button.m2-route` 裡面）；本月不到 1 分鐘或還沒讀到 ⇒ null，不佔位。
 * 數字＝連到這條路線的時間塊（`store.linkedBlocks({ routeId })`，同側板「時間」列的路線那一份）在「日界線的這個月 1 號起
 * 到現在」的聯集長度（`unionMs`，重疊不重複計）；只算時間塊、不含手填（同 `useLinkedTime` 的 monthMs）。
 * 重查：`route.id`、`timetableStore.rev`（寫入、同步、回前景）、日界線變了；有運行中那班 ⇒ 每分鐘重算（不重查）。
 * 樣式：timetable.css §K `.m2-route .ns-tt-route-aside`（本檔 import timetable.css——路線圖頁不見得載過時刻表頁）。
 */
import { useEffect, useState } from "react";
import type { NodeRow } from "../../../domain/node";
import { MIN, fmtDur, msOf } from "../../../domain/timetable";
import { monthStartKey, toLinkedSpan, unionMs, type LinkedSpan } from "../../../domain/timetableLink";
import { dayWindow, todayKey } from "../../../lib/date";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { useNow } from "../useNow";
import "../timetable.css";

export function RouteTimeAside({ route }: { route: NodeRow }) {
  const rev = useTimetableStore((s) => s.rev);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [data, setData] = useState<{ id: string; spans: LinkedSpan[] } | null>(null);

  useEffect(() => {
    let alive = true;
    useTimetableStore
      .getState()
      .linkedBlocks({ routeId: route.id })
      .then(
        (rows) => {
          if (alive) setData({ id: route.id, spans: rows.map(toLinkedSpan) });
        },
        (e: unknown) => console.warn("[tt:route-aside] 讀時間失敗：", e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [route.id, rev]);

  const now = useNow(60_000);
  if (!data || data.id !== route.id) return null;
  const start = msOf(dayWindow(monthStartKey(todayKey(dayStartHour, new Date(now))), dayStartHour).start);
  const monthMs = unionMs(data.spans, now, { start, end: now });
  if (monthMs < MIN) return null;
  return <span className="ns-tt-route-aside ns-tt-num">{fmtDur(monthMs)}</span>;
}
