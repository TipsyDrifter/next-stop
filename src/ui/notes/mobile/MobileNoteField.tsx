/**
 * MobileNoteField——手機路線圖唯讀詳情的「筆記」一列（旅客筆記車次④契約 §5.0、§5.5-1、§5.7-1；D-筆-49／50）。
 *
 * 這是 `LineMount.nodeFields` 一筆（`notes.notes`）的 `Mobile`：
 *   - 支線／列車／車廂＝核心 `MobileRouteMap.tsx` 的 RowDetail 在欄位表之後渲染（與荷札列同一處），本元件畫
 *     `dl.ns-notes-mdetailrow`（沿 MobileTagRow 的結構）：`dt`「筆記」＋`dd` 列；
 *   - 路線＝同一個渲染插槽、畫在路線抬頭之下（接縫 #62）：`node.kind === "route"` ⇒ 交給 MobileRouteNotes 的可收合外框，列照樣由這裡給。
 * 列（≤5，直接掛的在前、底下節點的接在後帶「› 節點名」）：標題＋一行摘要（0-7）；44px 觸控高。
 *   點一列＝切到旅客筆記 tab、整頁開在那則（`requestMobileOpenNote`，0-12；MobileNotes 接手）；
 *   「還有 N 則 →」＝旅客筆記 tab 的筆記段套篩選（路線＝`routeId`；支線／列車／車廂＝`underNode`，P5——N 算的就是這些節點）；
 *   「＋ 記一則」＝捕捉面板預掛這個節點（0-2 甲；`openCapture("note", preset)`，落點「→ 筆記 · 路線 › 節點」）。
 * 資料：`notesStore.nodeNotes[node.id]`；沒有（第一次、或 store 清了快取）就 `loadNodeNotes(node.id, 底下的 ids)`。
 *   底下的 ids 從已載好的樹算（`nodeStore.tree`；手機路線圖第二層開著的就是這條路線的樹）：
 *   路線＝整棵樹（`tree.byId` 全部）、其餘＝`descendantIds(tree.childrenOf, id)`。樹換了（同步、別處改）ids 不同就重載一次。
 * 路線圖其他欄位仍唯讀；本列只讀筆記、新增走捕捉面板（寫入在 store）。
 * UI 丙-6 E19：「還沒有筆記」換共用 EmptyState 區段級（inline）；底下「＋ 記一則」是這一列唯一的新增入口，照留。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../../domain";
import { descendantIds, nodeNotesLine } from "../../../domain/notes";
import type { NoteListItem } from "../../../data/noteRepository";
import { useNodeStore } from "../../../store/nodeStore";
import { useNotesStore, type CapturePreset } from "../../../store/notesStore";
import { useUiStore } from "../../../store/uiStore";
import { IconPlus } from "./mobileDiaryBits";
import { MobileRouteNotes } from "./MobileRouteNotes";
import { EmptyState } from "../../common/EmptyState";
import "../notes-mobile.css";

/** 側板一列最多幾則（§3.3 `loadNodeNotes` 取 5） */
const MAX_ROWS = 5;

/** 這個節點底下的 id（不含自己）；樹不是這條路線的＝空（只算自己） */
function useUnderIds(node: NodeRow): string[] {
  const tree = useNodeStore((s) => s.tree);
  const openRouteId = useNodeStore((s) => s.routeId);
  return useMemo(() => {
    if (node.kind === "route") return openRouteId === node.id ? Object.keys(tree.byId).filter((id) => id !== node.id) : [];
    if (!tree.byId[node.id]) return [];
    return descendantIds(tree.childrenOf, node.id);
  }, [tree, openRouteId, node.id, node.kind]);
}

export function MobileNoteField({ node }: { node: NodeRow }) {
  // 依賴 `nodeNotes` 物件本身（不是「有沒有這一格」）：store 在查詢途中清快取時會丟掉那一趟的結果（世代號），
  // 只看「有沒有」的話清空前後都是「沒有」、不會重跑；看物件就每次清空都重跑（與桌機 NoteField 同）
  const nodeNotes = useNotesStore((s) => s.nodeNotes);
  const summary = nodeNotes[node.id];
  const loadNodeNotes = useNotesStore((s) => s.loadNodeNotes);
  const routeName = useNodeStore((s) => {
    const rid = node.kind === "route" ? node.id : node.route_id;
    return rid ? (s.routes.find((r) => r.id === rid)?.name ?? null) : null;
  });
  const under = useUnderIds(node);
  const idsKey = under.join(",");

  // 快取不在（第一次／store 清掉）或底下的節點換了 ⇒ 重載；同一組 ids 且快取在＝不重複叫。
  // 載入失敗＝store 不寫快取 ⇒ nodeNotes 不變、不會無限重試；`tried` 記下這一趟叫完了，失敗就顯示「還沒有筆記」而不是永遠的「…」
  const loadKey = node.id + "|" + node.updated_at + "|" + idsKey;
  const loadedKey = useRef<string | null>(null);
  const [tried, setTried] = useState<string | null>(null);
  useEffect(() => {
    if (nodeNotes[node.id] && loadedKey.current === loadKey) return;
    loadedKey.current = loadKey;
    setTried(null); // 重載開始＝回到「載入中」；不然快取剛被清時會先閃一下「還沒有筆記」
    let alive = true;
    void loadNodeNotes(node.id, idsKey ? idsKey.split(",") : []).finally(() => {
      if (alive) setTried(loadKey);
    });
    return () => {
      alive = false;
    };
  }, [nodeNotes, node.id, loadKey, idsKey, loadNodeNotes]);
  const loadFailed = !summary && tried === loadKey;

  const isRoute = node.kind === "route";
  const label = isRoute ? (routeName ?? node.name) : routeName ? `${routeName} › ${node.name}` : node.name;

  const openNote = (id: string) => {
    useNotesStore.getState().requestMobileOpenNote(id);
    useUiStore.getState().setMobileTab("notes");
  };
  const openMore = () => {
    const ns = useNotesStore.getState();
    useUiStore.getState().setMobileTab("notes");
    ns.setSection("notes");
    void ns.setNotesQuery(
      isRoute ? { routeId: node.id } : { underNode: { id: node.id, ids: [node.id, ...under], label: node.name } },
    );
  };
  const addHere = () => {
    const preset: CapturePreset = {
      nodeId: node.id,
      routeId: isRoute ? node.id : (node.route_id ?? null),
      label,
    };
    useNotesStore.getState().openCapture("note", preset);
  };

  const rows = (
    <NoteRows
      here={node.id}
      items={summary?.items ?? null}
      failed={loadFailed}
      total={summary?.total ?? 0}
      onOpen={openNote}
      onMore={openMore}
      onAdd={addHere}
    />
  );

  if (isRoute) return <MobileRouteNotes total={summary ? summary.total : null}>{rows}</MobileRouteNotes>;
  return (
    <dl className="ns-notes-mdetailrow ns-notes-mnf">
      <dt>筆記</dt>
      <dd>{rows}</dd>
    </dl>
  );
}

function NoteRows({
  here,
  items,
  failed,
  total,
  onOpen,
  onMore,
  onAdd,
}: {
  here: string;
  /** null＝還在載 */
  items: NoteListItem[] | null;
  /** items 還是 null、但這一趟載入已經叫完（失敗或結果被丟掉）⇒ 顯示「還沒有筆記」，不停在「…」 */
  failed: boolean;
  total: number;
  onOpen(id: string): void;
  onMore(): void;
  onAdd(): void;
}) {
  const shown = items ? items.slice(0, MAX_ROWS) : [];
  const rest = Math.max(0, total - shown.length);
  return (
    <div className="ns-notes-mnfbox">
      {items === null && !failed ? (
        <span className="ns-notes-mnfempty" aria-label="載入中">
          …
        </span>
      ) : shown.length === 0 ? (
        <EmptyState inline tone="first" className="ns-notes-mnfempty" title="還沒有筆記" />
      ) : (
        <ul className="ns-notes-mnflist">
          {shown.map((n) => {
            const line = nodeNotesLine(n, here);
            return (
              <li key={n.id}>
                <button type="button" className="ns-notes-mnfrow" onClick={() => onOpen(n.id)}>
                  <span className="t">{line.title}</span>
                  {(line.where || line.excerpt) && (
                    <span className="x">
                      {line.where && <span className="w">{line.where}</span>}
                      {line.excerpt && <span className="xs">{line.excerpt}</span>}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {items !== null && rest > 0 && (
        <button type="button" className="ns-notes-mnfmore" onClick={onMore}>
          還有 {rest} 則 →
        </button>
      )}
      <button type="button" className="ns-notes-mnfadd" onClick={onAdd}>
        <IconPlus size={11} />
        記一則
      </button>
    </div>
  );
}
