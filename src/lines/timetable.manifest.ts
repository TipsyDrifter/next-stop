/**
 * 時刻表線的登記檔・純資料（並行地基・契約 §5.1）。**只有時刻表線改這個檔。**
 *
 * 通車：`page.status` 改成 "open"（手機一起通車就把 `mobile.status` 也改）；元件填在 `./timetable.mount.tsx`。
 * 未通車（planned）時 `hotkeys`／`scenes` 必須是空陣列、`hotkeyFiles` 必須是空物件（`pnpm probe:registry` 守門）。
 * 純資料：不得 import React／store／Tauri API；型別一律 `import type`（probe 在 node 直接載入本檔）。
 */
import type { LineManifest } from "./types";

export const TIMETABLE = {
  id: "timetable",
  page: {
    status: "planned",
    label: "時刻表",
    navDigit: "5",
    guideTitle: "時刻表的快捷鍵",
  },
  mobile: { slot: "tab", status: "planned", label: "時刻表", latin: "TIMETABLE" },
  hotkeyScopes: ["timetable"],
  hotkeys: [],
  scenes: [],
  hotkeyFiles: {},
  syncTables: [],
  syncSettingsKeys: [],
} as const satisfies LineManifest;
