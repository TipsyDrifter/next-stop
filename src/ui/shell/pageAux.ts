/**
 * pageAux——核心頁（不是功能線的頁）的書封頁務件登記表（丁 D-主-235；規則 D-主-234）。**本檔不 import 任何元件。**
 *
 * 規則：頁務件＝這一頁的目錄或篩選，點了留在這頁。
 *   - 功能線的頁照舊走 `LineMount.sidebarAux`（`lines/runtime.ts` 的 `lineSidebarAux`）。
 *   - 核心頁（完整搜尋、②運行報告、③車庫…）在 `pageViews.tsx` 的 `installPageSidebarAux({...})` 登記一筆。
 *   - 都沒登記：今日、路線圖、行程表三頁畫「我的路線」（任務三頁的目錄就是路線網）；其他頁側欄只剩全域三件。
 *
 * 為什麼是「裝進來」而不是直接 import：`Sidebar.tsx` 在 App 的 import 清單排在 `pageViews.tsx` 之前，
 * 直接 import 頁務件元件會把它們的元件樹與 CSS 提早求值（`src/index.css` 檔頭的注入順序鐵律；同 `lines/runtime.ts` 的理由）。
 * `pageViews.tsx` 求值時把表交進來，Sidebar 在執行期才查。沒裝（probe 只載入 store）＝都當沒登記。
 */
import type { ComponentType } from "react";
import type { PageId } from "./pages";

/** 側欄畫「我的路線」的頁（任務三頁；D-主-234） */
export const MY_LINES_PAGES: ReadonlySet<PageId> = new Set<PageId>(["today", "routemap", "calendar"]);

let installed: Partial<Record<PageId, ComponentType>> = {};

/** 只給 `pageViews.tsx` 呼叫 */
export function installPageSidebarAux(map: Partial<Record<PageId, ComponentType>>): void {
  installed = map;
}

/** 這一頁登記的頁務件；沒有＝null */
export function pageSidebarAux(page: PageId): ComponentType | null {
  return installed[page] ?? null;
}
