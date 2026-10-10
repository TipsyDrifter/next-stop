/**
 * 售票口線的登記檔・純資料（並行地基・契約 §5.1）。**只有售票口線改這個檔。**
 *
 * 通車：`page.status` 改成 "open"（手機一起通車就把 `mobile.status` 也改）；元件填在 `./ticket.mount.tsx`。
 * 未通車（planned）時 `hotkeys`／`scenes` 必須是空陣列、`hotkeyFiles` 必須是空物件（`pnpm probe:registry` 守門）。
 * 純資料：不得 import React／store／Tauri API；型別一律 `import type`（probe 在 node 直接載入本檔）。
 */
import type { LineManifest } from "./types";

export const TICKET = {
  id: "ticket",
  page: {
    status: "planned",
    label: "售票口",
    navDigit: "6",
    guideTitle: "售票口的快捷鍵",
  },
  mobile: { slot: "more", status: "planned", label: "售票口（記帳）", latin: "TICKET OFFICE" },
  hotkeyScopes: ["ticket"],
  hotkeys: [],
  scenes: [],
  hotkeyFiles: {},
  syncTables: [],
  syncSettingsKeys: [],
} as const satisfies LineManifest;
