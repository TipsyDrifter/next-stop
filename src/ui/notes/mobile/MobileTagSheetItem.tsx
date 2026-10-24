/**
 * MobileTagSheetItem——手機票卡 ⋯ sheet 裡的「荷札…」一項（`ticketSheetItems` 一筆的 `Item`；契約 0-3，主對話 10-14 裁甲）。
 *
 * 長相：UI 丙-6 S8 起是共用 `MSheetItem`（核心 ⋯ 已換 MSheet list：52px 列、同一個 hover、↑↓ Home End 走得到這一列）＋
 *   右側淡字「已掛 N 個」（沒掛就不寫）——用核心同一張 sheet 的 `.m-tks-aside`（mobile-polish.css，MobileTicketSheet 自己載入），
 *   跟「下週一 10/27」那幾列的右側小字同一套。舊的 `.m-sheet-item.m-sch-row`／`.m-sch-aside` 不再用。
 * 點了先 `close()` 收起 sheet，再開本線的荷札點選器（`NotesMobileOverlay` 畫，每個 tab 都在）。
 * 唯讀的卡（定期券的歷史班次）由 `MobileTicketSheet` 擋掉、不會畫到這裡。
 */
import { useEffect } from "react";
import { useTagStore } from "../../../store/tagStore";
import { MSheetItem } from "../../common/MSheet";

export function MobileTagSheetItem({ nodeId, name, close }: { nodeId: string; name: string; close(): void }) {
  const count = useTagStore((s) => s.keysOf("node", nodeId).length);
  const openPicker = useTagStore((s) => s.openPicker);
  // sheet 打開時重載荷札索引：今日／行程表 tab 可能還沒進過旅客筆記頁，或索引是舊的——「已掛 N 個」才對得上
  useEffect(() => {
    void useTagStore.getState().loadIndex();
  }, []);
  return (
    <MSheetItem
      onClick={() => {
        close();
        openPicker({ mode: "entity", entityType: "node", entityId: nodeId, name });
      }}
    >
      荷札…
      {count > 0 && <span className="m-tks-aside">已掛 {count} 個</span>}
    </MSheetItem>
  );
}
