/**
 * TicketAgent——售票口線的全域代理（車次①契約 §3.8.4；甲席）。回 null、零 DOM。
 *
 * 掛在 mount 的 `desktopOverlay` 與 `mobileOverlay`（兩殼永不同時渲染 ⇒ 只會有一個實例）：
 *   - App 一啟動就 `warm()`：起手三列、帳戶名（捕捉框的落點「售票口 · 現金」才寫得出來）
 *   - 掛沙盒除錯入口 `window.__nsTicket.importFromPath(path)`（0-34）：＝對話框選完之後的同一條路，
 *     CDP 進不了原生選檔對話框，沙盒席以它帶複本路徑。權限與對話框相同（Rust command 本來就收任意路徑）。
 */
import { useEffect } from "react";
import { useTicketStore } from "../../store/ticketStore";

declare global {
  interface Window {
    __nsTicket?: { importFromPath(p: string): Promise<void> };
  }
}

export function TicketAgent() {
  useEffect(() => {
    // warm 失敗（例：Stage 0 的 SQLite 骨架）不讓它變成未處理的 rejection；進頁時 init 會再試、失敗寫進 error
    void useTicketStore
      .getState()
      .warm()
      .catch((e) => console.warn("[ticket] warm 失敗", e));
    window.__nsTicket = {
      importFromPath: (p: string) => {
        useTicketStore.getState().openDialog({ kind: "import" });
        return useTicketStore.getState().importFromPath(p);
      },
    };
  }, []);
  return null;
}
