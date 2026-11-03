/**
 * StampNotifier——蓋章的那一刻跳一則 toast（車庫與回顧 D-主-212）。不畫東西，只把畫法註冊給 depotStore。
 *   一枚：「蓋了一枚駅スタンプ：{短說法}」＋左邊一枚 32px 小章；好幾枚：「蓋了 N 枚駅スタンプ」，小章放第一枚。
 *   4 秒、沒有動作鈕；不排程、不推播、不提醒「快到了」。回填那一趟 store 不會叫。
 * 小章上的代碼／路線名照當下 nodeStore 查（查不到就省略）。
 */
import { useEffect } from "react";
import { setStampNotifier, useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { stampShort, type KeyedStamp } from "../../domain/stamps";
import { ensureStampDefs } from "../stamps/defs";
import { StampImpression } from "./StampImpression";

function routeOf(s: KeyedStamp): { code: string | null; name: string | null } {
  const ns = useNodeStore.getState();
  let routeId: string | null = null;
  if (s.kind === "station") routeId = ns.stations.find((st) => st.id === s.subject_id)?.route_id ?? null;
  else if (s.kind === "route" || s.kind === "route_year") routeId = s.subject_id;
  const r = routeId ? ns.routes.find((x) => x.id === routeId) : undefined;
  return { code: r?.code ?? null, name: r?.name ?? null };
}

/**
 * toast 是單槽：剛到站時畫面上是「收進車庫了〔復原〕」，蓋章 toast 直接蓋上去會把「復原」吃掉。
 * 有動作鈕的 toast 還在 ⇒ 等它收掉再出（最多等 15 秒）；出之前再對一次章還在不在（按了復原、章被收回就不出）。
 */
function showWhenFree(fresh: readonly KeyedStamp[], show: (list: readonly KeyedStamp[]) => void): void {
  if (!useUiStore.getState().toast?.actionLabel) {
    show(fresh);
    return;
  }
  const deadline = Date.now() + 15_000;
  const un = useUiStore.subscribe((s) => {
    if (s.toast?.actionLabel && Date.now() < deadline) return;
    un();
    const alive = new Set(useDepotStore.getState().stamps.map((x) => x.id));
    const still = fresh.filter((x) => alive.has(x.id));
    if (still.length) show(still);
  });
}

export function StampNotifier() {
  useEffect(() => {
    ensureStampDefs();
    setStampNotifier((all) => showWhenFree(all, (fresh) => {
      if (!fresh.length) return;
      const first = fresh[0];
      const r = routeOf(first);
      const lead = (
        <StampImpression
          stamp={first}
          size={32}
          routeCode={r.code}
          routeName={r.name}
        />
      );
      const message = fresh.length === 1 ? `蓋了一枚駅スタンプ：${stampShort(first)}` : `蓋了 ${fresh.length} 枚駅スタンプ`;
      useUiStore.getState().showToast({ message, lead }, 4000);
    }));
    return () => setStampNotifier(null);
  }, []);
  return null;
}
