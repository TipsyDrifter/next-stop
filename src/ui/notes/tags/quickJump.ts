/**
 * NOTES_QUICK_JUMP——Ctrl+P 的荷札結果（桌機；旅客筆記車次③契約 0-5；接縫 #56 `LineMount.quickJump`）。
 *
 * 由整合席在 `notes.mount.tsx` 填 `quickJump: NOTES_QUICK_JUMP`（QuickJump.tsx 的 provider 接線同一批）；本檔只是提供者。
 *   前綴 `#`：打 `#高` ⇒ 只列荷札（含虛資料夾、數量）；只打 `#` ⇒ 整棵樹（全部展開、`indent`＝深度）
 *   沒有前綴：一般結果之後多一組「荷札」（limit 由 QuickJump 給 4）
 *   選了 ⇒ 進荷札頁並選好，「‹ 回到剛才 <開啟時的頁名>」
 * 磨光①：登記 `shells: ["desktop","mobile"]`，手機搜尋（MobileQuickJump）也列；手機的「回到剛才」＝開啟時的 tab。
 */
import type { QuickJumpHit, QuickJumpProviderSpec } from "../../../lines/types";
import { flattenTree, type TagNode } from "../../../domain/tags";
import { useTagStore, type TagBackRef } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { mobileTabByKey } from "../../mobile/tabs";
import { pageBackRef } from "./backRefs";

/**
 * 「‹ 回到剛才」：桌機＝開啟時的頁（`pageBackRef`）；手機搜尋（磨光①）＝開啟時的 tab——
 * `pageBackRef` 讀的是桌機的 `page`、回去叫 `setPage`，在手機殼上會寫成桌機頁名、按了也回不去。
 * 開啟時就在旅客筆記 tab ⇒ 不給（回去等於沒動，按了沒反應、返回鍵還白吃一下）；荷札頁改顯示「‹ 荷札」。
 */
function backRef(): TagBackRef | undefined {
  if (typeof document === "undefined" || document.documentElement.getAttribute("data-shell") !== "mobile") return pageBackRef();
  const tab = useUiStore.getState().mobileTab;
  if (tab === "notes") return undefined;
  return { label: mobileTabByKey(tab).label, restore: () => useUiStore.getState().setMobileTab(tab) };
}

function hitOf(x: TagNode, indent: number): QuickJumpHit {
  return {
    id: x.key,
    label: x.name,
    aside: x.real ? `${x.direct} 處` : `虛資料夾・${x.total} 處`,
    glyph: { text: "札", dashed: !x.real },
    indent,
    go: () => useTagStore.getState().openTagPage(x.key, backRef()),
  };
}

export const NOTES_QUICK_JUMP: QuickJumpProviderSpec = {
  id: "notes.tags",
  group: "荷札",
  prefix: "#",
  // go() 自己分殼（`openTagPage` 手機切 tab）⇒ 手機搜尋也列（磨光①，契約 §0-4）
  shells: ["desktop", "mobile"],
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
