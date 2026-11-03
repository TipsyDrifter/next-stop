/**
 * 車庫頁的鍵盤（車庫與回顧 D-主-215）：只有一顆——記錄簿開著時 Esc 回車庫。
 * 掛在頁根的 onKeyDown（同大綱）；鍵位查 registry（`resolveHotkey("depot", e)`），id 以字串字面值出現（probe 比對）。
 */
import type { KeyboardEvent } from "react";
import { resolveHotkey } from "../shell/hotkeys";
import { useDepotStore } from "../../store/depotStore";

export function useDepotKeyboard(): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    const id = resolveHotkey("depot", e)?.id;
    if (id === "depot.back" && useDepotStore.getState().bookId) {
      e.preventDefault();
      useDepotStore.getState().openBook(null);
    }
  };
}
