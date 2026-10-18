/**
 * TaskCategoryPanel——從任務發車、第一次碰到的路線先選分類（車次② 契約 §5.2；乙席；長相＝原型 `v-f.js` askcatBody）。
 * sheet `{ kind: "taskCategory", nodeId }`；標題「『{任務}』算哪一類？」由 host 給（`sheetTitle`）。
 *
 *   div.ns-tt-panel.ns-tt-panel-taskcat
 *   ├ Sub：TASK_CATEGORY_NOTE（掛路線）／TASK_CATEGORY_NOTE_NO_ROUTE（沒掛路線的臨時車票：只查節點那段，每一張第一次都會跳）
 *   ├ div.ns-tt-taskcat-for：路線圓牌＋「時間會連到『{任務}』」
 *   ├ CategoryGrid（compact；運行中那班的分類 is-live）
 *   └ Sub 小字：記錯了也沒關係（到站後在軸上改那一塊的分類——連結跟著留，下次就照新的；換車會開一班沒連的，不算）
 *
 * 點一格 ⇒ `onDone()` → `departWithLink(cat, { nodeId, routeId: null })`（長時間運行待確認時 store 先問「其實到幾點」）。
 * 節點在面板開著時被刪（同步）⇒ 照樣發車（連到已刪的節點，顯示「（原車票已刪除）」）——不擋（✎二-9）。
 */
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { CategoryGrid } from "../parts/CategoryGrid";
import { RouteRoundel, useRouteById } from "../parts/LinkPicker";
import { Sub, type PanelProps } from "./controls";

export function TaskCategoryPanel({ onDone }: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const running = useTimetableStore((s) => s.running);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const departWithLink = useTimetableStore((s) => s.departWithLink);
  const routeById = useRouteById();
  const nodeId = sheet?.kind === "taskCategory" ? sheet.nodeId : "";
  const info = linkInfo[nodeId];
  const routeId = info && !info.missing ? info.routeId : null;
  const name = info && !info.missing ? info.name : "這張車票";

  const pick = (cat: string): void => {
    onDone();
    void departWithLink(cat, { nodeId, routeId: null });
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-taskcat">
      <Sub>{routeId ? TT_TEXT.TASK_CATEGORY_NOTE : TT_TEXT.TASK_CATEGORY_NOTE_NO_ROUTE}</Sub>
      <div className="ns-tt-taskcat-for">
        <RouteRoundel route={routeId ? (routeById[routeId] ?? null) : null} />
        <span>
          時間會連到「<b>{name}</b>」
        </span>
      </div>
      <CategoryGrid selected={null} onPick={pick} compact runningId={running?.category_id ?? null} />
      <Sub>記錯了也沒關係：到站後點軸上這一塊改分類，下次就照新的。</Sub>
    </div>
  );
}
