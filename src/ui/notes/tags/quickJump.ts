/**
 * NOTES_QUICK_JUMP——Ctrl+P 的荷札結果（桌機；旅客筆記車次③契約 0-5；接縫 #56 `LineMount.quickJump`）。
 *
 * 由整合席在 `notes.mount.tsx` 填 `quickJump: NOTES_QUICK_JUMP`（QuickJump.tsx 的 provider 接線同一批）；本檔只是提供者。
 *   前綴 `#`：打 `#高` ⇒ 只列荷札（含虛資料夾、數量）；只打 `#` ⇒ 整棵樹（全部展開、`indent`＝深度）
 *   沒有前綴：一般結果之後多一組「荷札」（limit 由 QuickJump 給 4）
 *   選了 ⇒ 進荷札頁並選好，「‹ 回到剛才 <開啟時的頁名>」
 */
import type { QuickJumpHit, QuickJumpProviderSpec } from "../../../lines/types";
import { flattenTree, type TagNode } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { pageBackRef } from "./backRefs";

function hitOf(x: TagNode, indent: number): QuickJumpHit {
  return {
    id: x.key,
    label: x.name,
    aside: x.real ? `${x.direct} 處` : `虛資料夾・${x.total} 處`,
    glyph: { text: "札", dashed: !x.real },
    indent,
    go: () => useTagStore.getState().openTagPage(x.key, pageBackRef()),
  };
}

export const NOTES_QUICK_JUMP: QuickJumpProviderSpec = {
  id: "notes.tags",
  group: "荷札",
  prefix: "#",
  async search(term, limit) {
    const st = useTagStore.getState();
    if (!st.index) await st.loadIndex();
    const idx = useTagStore.getState().index;
    if (!idx) return [];
    const t = term.trim();
    if (!t) {
      const all = Object.fromEntries(Object.keys(idx.byKey).map((k) => [k, 1]));
      return flattenTree(idx, all, "").map((r) => hitOf(r.node, r.node.depth - 1));
    }
    return useTagStore
      .getState()
      .suggest(t, { includeVirtual: true, limit })
      .items.map((it) => hitOf(idx.byKey[it.key], 0))
      .filter((h) => !!h.label);
  },
};
