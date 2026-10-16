/**
 * NoteField——任務側板的「筆記」區（桌機；旅客筆記車次④契約 §5.0／§5.1；§0-0 定案 0-1 乙、0-2 甲、0-7「標題＋一行摘要」）。
 *
 * `nodeFields` 一筆的 `Desktop`，渲染在核心 `FieldRow label="筆記"` 裡（路線／支線／列車／車廂；車票不出，kinds 由 mount 給）。
 *
 *   div.ns-notes-nf
 *   ├ 載入中＝span.ns-notes-nfempty「…」；0 則＝「還沒有筆記」
 *   ├ ul.ns-notes-nflist > li.ns-notes-nfrow（≤5；直接掛的在前、底下節點的接在後）
 *   │   button：.t 標題 ／ .ex（.w「› 車廂名」＋ .xs 一行摘要；不叫 .x——會撞側板 panel.css 的 `.panel .x` 小叉）——點＝切到旅客筆記頁選中那則
 *   ├ total > 5 ⇒ button.ns-notes-nfmore「還有 N 則 → 到旅客筆記看」——路線套 routeId 篩選、其餘套 underNode（P5）
 *   └ button.ns-notes-nfadd「＋ 在這裡記一則」——開捕捉框、預掛這個節點（落點「→ 筆記 · 路線 › 節點」）
 *
 * 資料：`notesStore.nodeNotes[node.id]`（store 的 reloadLists／reload 會清空 ⇒ 看到快取消失就重載）。
 * 子孫 ids：路線＝已載的路線樹全部（`tree.byId`）；其餘＝`descendantIds(tree.childrenOf, id)`。
 * 側板開的節點不在目前載的樹裡（例：今日頁點開別條路線的列車）⇒ 自己 `listRouteTree(route_id)` 補查一次再算。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../domain";
import { descendantIds, nodeNotesLine } from "../../domain/notes";
import { nodeRepo } from "../../data";
import { indexTree, useNodeStore, type TreeIndex } from "../../store/nodeStore";
import { useNotesStore, type CapturePreset } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { IconPlus } from "./notesBits";
import { notesFlush } from "./notesFlush";
import { goNote } from "./tags/jump";
import "./notes-md.css";

/** 側板最多列幾則（store 的 loadNodeNotes 也只取 5） */
const SHOWN = 5;

/** 這個節點（含）與它底下所有節點的 id；樹沒載到它時回 null（呼叫端去補查） */
function idsFromTree(node: NodeRow, tree: TreeIndex, routeId: string | null): string[] | null {
  if (node.kind === "route") {
    if (routeId !== node.id) return null;
    return [node.id, ...Object.keys(tree.byId).filter((id) => id !== node.id)];
  }
  if (!tree.byId[node.id]) return null;
  return [node.id, ...descendantIds(tree.childrenOf, node.id)];
}

export function NoteField({ node }: { node: NodeRow }) {
  const tree = useNodeStore((s) => s.tree);
  const openRouteId = useNodeStore((s) => s.routeId);
  const routes = useNodeStore((s) => s.routes);

  // 樹裡找得到＝同步算；找不到＝補查那條路線的樹（結果記在本地，key 帶 node.id 免得換節點後誤用）
  const fromTree = useMemo(() => idsFromTree(node, tree, openRouteId), [node, tree, openRouteId]);
  const [fetched, setFetched] = useState<{ for: string; ids: string[] } | null>(null);
  const routeOfNode = node.kind === "route" ? node.id : node.route_id;
  useEffect(() => {
    if (fromTree || !routeOfNode) return;
    let alive = true;
    void nodeRepo
      .listRouteTree(routeOfNode)
      .then((rows) => {
        if (!alive) return;
        const t = indexTree(rows, routeOfNode);
        const ids =
          node.kind === "route"
            ? [node.id, ...Object.keys(t.byId).filter((id) => id !== node.id)]
            : [node.id, ...descendantIds(t.childrenOf, node.id)];
        setFetched({ for: node.id, ids });
      })
      .catch((e) => {
        console.warn("NoteField.listRouteTree 失敗", e);
        if (alive) setFetched({ for: node.id, ids: [node.id] });
      });
    return () => {
      alive = false;
    };
  }, [fromTree, routeOfNode, node.id, node.kind]);
  const ids = fromTree ?? (fetched?.for === node.id ? fetched.ids : routeOfNode ? null : [node.id]);
  const idsKey = ids ? ids.join(",") : "";

  // 載入：換節點、子孫變了、節點本身改過（updated_at）、快取被 store 清掉都重載。
  // 依賴 `nodeNotes` 物件本身（不是「有沒有這一格」）：store 在查詢途中清快取時會丟掉那一趟的結果（世代號），
  // 只看「有沒有」的話清空前後都是「沒有」、不會重跑；看物件就每次清空都重跑。載入失敗＝store 不 set ⇒ 不會無限重試。
  const nodeNotes = useNotesStore((s) => s.nodeNotes);
  const summary = nodeNotes[node.id];
  const lastKey = useRef<string | null>(null);
  const [tried, setTried] = useState<string | null>(null);
  useEffect(() => {
    if (!ids) return;
    const key = `${node.id}|${node.updated_at}|${idsKey}`;
    if (nodeNotes[node.id] && lastKey.current === key) return;
    lastKey.current = key;
    let alive = true;
    void useNotesStore
      .getState()
      .loadNodeNotes(node.id, ids.slice(1))
      .finally(() => {
        if (alive) setTried(key);
      });
    return () => {
      alive = false;
    };
    // ids 以 idsKey 代表（陣列每次 render 都是新的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.updated_at, idsKey, nodeNotes]);

  // 重載中（快取剛被清）先留著上一次的列，不閃成「…」把側板高度拉來拉去
  const kept = useRef<{ for: string; s: NonNullable<typeof summary> } | null>(null);
  if (summary) kept.current = { for: node.id, s: summary };
  const shown = summary ?? (kept.current?.for === node.id ? kept.current.s : undefined);

  const routeName = routeOfNode ? (routes.find((r) => r.id === routeOfNode)?.name ?? null) : null;
  const label = node.kind === "route" ? node.name : routeName ? `${routeName} › ${node.name}` : node.name;

  const openOne = async (id: string) => {
    await notesFlush.fn?.();
    useUiStore.getState().setPage("notes");
    await goNote(id);
  };

  const openMore = async () => {
    await notesFlush.fn?.();
    useUiStore.getState().setPage("notes");
    const st = useNotesStore.getState();
    st.setSection("notes");
    // 篩選換成這一個（搜尋字清掉：從側板來的人要看的是「這裡的全部」）
    if (node.kind === "route") await st.setNotesQuery({ routeId: node.id });
    else await st.setNotesQuery({ underNode: { id: node.id, ids: ids ?? [node.id], label: node.name } });
  };

  const add = () => {
    const preset: CapturePreset = { nodeId: node.id, routeId: routeOfNode ?? null, label };
    useNotesStore.getState().openCapture("note", preset);
  };

  const addBtn = (
    <button type="button" className="ns-notes-nfadd" onClick={add} title={`記一則掛在「${label}」的筆記`}>
      <IconPlus size={11} />
      在這裡記一則
    </button>
  );

  if (!shown) {
    const loading = !ids || tried !== `${node.id}|${node.updated_at}|${idsKey}`;
    return (
      <div className="ns-notes-nf">
        <span className="ns-notes-nfempty">{loading ? "…" : "還沒有筆記"}</span>
        {addBtn}
      </div>
    );
  }
  if (!shown.items.length) {
    return (
      <div className="ns-notes-nf">
        <span className="ns-notes-nfempty">還沒有筆記</span>
        {addBtn}
      </div>
    );
  }

  const rest = shown.total - Math.min(shown.items.length, SHOWN);
  return (
    <div className="ns-notes-nf">
      <ul className="ns-notes-nflist">
        {shown.items.slice(0, SHOWN).map((n) => {
          const line = nodeNotesLine(n, node.id);
          return (
            <li key={n.id} className="ns-notes-nfrow">
              <button type="button" title="開這一則" onClick={() => void openOne(n.id)}>
                <span className="t">{line.title}</span>
                {(line.where || line.excerpt) && (
                  <span className="ex">
                    {line.where && <span className="w">{line.where}</span>}
                    {line.excerpt && <span className="xs">{line.excerpt}</span>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {rest > 0 && (
        <button type="button" className="ns-notes-nfmore" onClick={() => void openMore()}>
          還有 {rest} 則 → 到旅客筆記看
        </button>
      )}
      {addBtn}
    </div>
  );
}
