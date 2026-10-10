/**
 * 三線的元件掛點彙整（並行地基・契約 §5.1；增補 2026-10-05 增補二）。
 *
 * 集中檔怎麼用（各線不必改本檔，改自己的 `<line>.mount.tsx`）：
 *   - `pageViews.tsx`／`MobileShell.tsx`／`MobileMore.tsx`：取 `LINE_MOUNTS[id].desktopView／mobileView`
 *   - `syncStore.ts`／`useGlobalHotkeys.ts`：**不 import 本檔**，改查 `./runtime`（不 import 元件）——
 *     本檔被求值時把 `LINE_MOUNTS` 交給 `installLineMounts()`（修正席，評審發現 2：store 與 hook 在 App 的
 *     import 清單裡排在核心元件之前，直接 import 本檔會把線的元件樹提早求值、改到核心 CSS 的注入順序）
 *   - `App.tsx`／`MobileShell.tsx`：`lineOverlays(shell)`——通車且有填浮層的線，依固定順序掛在最後
 *   - `Sidebar.tsx`：`lineSidebarTools()`（在 `./runtime`）——通車且有填 `sidebarTool` 的線，依固定順序掛在書封搜尋鈕左側。
 *     Sidebar 在 App 的 import 清單裡排在 `pageViews.tsx` 之前，與 store／hook 同理不得 import 本檔
 *   - `lineGlobalHotkeyHandler(id)`（通車的線登記的全域快捷鍵處理函式）與同步後重載的走訪在 `./runtime`
 *
 * 守門：未通車（planned）的線即使填了浮層／側欄工具／全域快捷鍵也不生效（與契約決策 7「未通車不佔快捷鍵」一致）。
 * 三線零筆登記時，兩個查詢函式恆回空陣列／null ⇒ 集中檔多出來的程式碼不產生任何 DOM 節點、不攔任何按鍵。
 */
import type { ComponentType } from "react";
import { LINE_MANIFESTS } from "./index.ts";
import type { LineId, LineMount } from "./types";
import { NOTES_MOUNT } from "./notes.mount";
import { TIMETABLE_MOUNT } from "./timetable.mount";
import { TICKET_MOUNT } from "./ticket.mount";
import { installLineMounts } from "./runtime";

export const LINE_MOUNTS: Readonly<Record<LineId, LineMount>> = {
  notes: NOTES_MOUNT,
  timetable: TIMETABLE_MOUNT,
  ticket: TICKET_MOUNT,
};
installLineMounts(LINE_MOUNTS);

/**
 * 要常駐掛載的全域浮層（三線固定順序 notes → timetable → ticket）。
 * 桌機看 `page.status`、手機看 `mobile.status`；`open` 且有填才算。
 */
export function lineOverlays(shell: "desktop" | "mobile"): { id: LineId; Overlay: ComponentType }[] {
  const out: { id: LineId; Overlay: ComponentType }[] = [];
  for (const m of LINE_MANIFESTS) {
    const mount = LINE_MOUNTS[m.id];
    const status = shell === "desktop" ? m.page.status : m.mobile.status;
    const Overlay = shell === "desktop" ? mount.desktopOverlay : mount.mobileOverlay;
    if (status === "open" && Overlay) out.push({ id: m.id, Overlay });
  }
  return out;
}
