/**
 * MobileTagRow——手機路線圖唯讀詳情的「荷札」一列（旅客筆記車次③契約 0-4、§5.5、7.2-5；D-筆-42）。
 *
 * 這是 `LineMount.nodeFields` 的 `Mobile` 元件：路線圖（MobileRouteMap.tsx 的 RowDetail，整合席接）在欄位表 `</dl>` 之後渲染它；
 * 只在 spec 的 `kinds`（車票／列車／車廂）出現。自己畫 `dt`「荷札」＋`dd`：牌子一排＋「＋ 掛荷札」。
 *   點牌子 ⇒ `openTagPage(key, { label: 路線名, restore: 回路線圖 })`；「回到剛才」＝`revealOnRouteMap`
 *     回到那條路線、展開到這一列（磨光① A7；以前只能回第一層——契約 §8-9）；
 *   「＋ 掛荷札」⇒ 點選器（entity 模式；完成一次寫入、一次復原）。路線圖其他欄仍唯讀，只有這一欄能改（D-筆-42）。
 * 資料：`tagStore.keysOf("node", id)`（讀 index，不另查）；index 還沒載就載一次。
 * 樣式 `.ns-notes-mdetailrow`（notes-mobile.css；外觀對齊 `.m2-field` 的 52px 標籤欄，但不借核心 class）。
 */
import { useEffect } from "react";
import type { NodeRow } from "../../../domain";
import { useTagStore } from "../../../store/tagStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { revealOnRouteMap } from "../../mobile/routeMapReveal";
import { IconPlus } from "./mobileDiaryBits";
import { MTag } from "./mobileTagBits";
import "../notes-mobile.css";

export function MobileTagRow({ node }: { node: NodeRow }) {
  const index = useTagStore((s) => s.index);
  const keysOf = useTagStore((s) => s.keysOf);
  const nameOf = useTagStore((s) => s.nameOf);
  const openTagPage = useTagStore((s) => s.openTagPage);
  const openPicker = useTagStore((s) => s.openPicker);
  const routeName = useNodeStore((s) => (node.route_id ? (s.routes.find((r) => r.id === node.route_id)?.name ?? null) : null));

  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);

  // index 是依賴：掛摘之後 keysOf 的結果才會跟著換
  const keys = index ? keysOf("node", node.id) : [];

  const open = (key: string) =>
    void openTagPage(key, {
      label: routeName ?? "路線圖",
      // 磨光① A7：回到原來那條路線、展開到這一列（核心的請求槽）；沒有路線（理論上不會）就照舊只切 tab
      restore: () =>
        node.route_id ? revealOnRouteMap(node.route_id, node.id) : useUiStore.getState().setMobileTab("routemap"),
    });

  return (
    <dl className="ns-notes-mdetailrow">
      <dt>荷札</dt>
      <dd>
        {keys.length === 0 && <span className="none">沒有掛</span>}
        {keys.map((k) => (
          <MTag key={k} name={nameOf(k)} onOpen={() => open(k)} />
        ))}
        <button
          type="button"
          className="ns-notes-mtagadd"
          onClick={() => openPicker({ mode: "entity", entityType: "node", entityId: node.id, name: node.name })}
        >
          <IconPlus size={11} />
          掛荷札
        </button>
      </dd>
    </dl>
  );
}
