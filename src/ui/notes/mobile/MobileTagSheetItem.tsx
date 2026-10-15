/**
 * MobileTagSheetItem——手機票卡 ⋯ sheet 裡的「荷札…」一項（`ticketSheetItems` 一筆的 `Item`；契約 0-3，主對話 10-14 裁甲）。
 *
 * 長相借核心 sheet 的 `.m-sheet-item.m-sch-row`＋右側 `.m-sch-aside`「已掛 N 個」（沒掛就不寫），與「下週一」那幾列同一套；
 * 點了先 `close()` 收起 sheet，再開本線的荷札點選器（`NotesMobileOverlay` 畫，每個 tab 都在）。
 * 唯讀的卡（定期券的歷史班次）由 `MobileTicketSheet` 擋掉、不會畫到這裡。
 */
import { useEffect } from "react";
import { useTagStore } from "../../../store/tagStore";

export function MobileTagSheetItem({ nodeId, name, close }: { nodeId: string; name: string; close(): void }) {
  const count = useTagStore((s) => s.keysOf("node", nodeId).length);
  const openPicker = useTagStore((s) => s.openPicker);
  // sheet 打開時重載荷札索引：今日／行程表 tab 可能還沒進過旅客筆記頁，或索引是舊的——「已掛 N 個」才對得上
  useEffect(() => {
    void useTagStore.getState().loadIndex();
  }, []);
  return (
    <button
      type="button"
      className="m-sheet-item m-sch-row"
      onClick={() => {
        close();
        openPicker({ mode: "entity", entityType: "node", entityId: nodeId, name });
      }}
    >
      荷札…
      {count > 0 && <span className="m-sch-aside">已掛 {count} 個</span>}
    </button>
  );
}
