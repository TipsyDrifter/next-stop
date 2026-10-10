/**
 * pages——桌機頁面登記表（並行地基・契約 §6；增補 2026-10-05 增補一）。純資料＋純函式。
 *
 * 六頁：核心三頁（今日／路線圖／日曆，寫在這裡）＋三條功能線（旅客筆記／時刻表／售票口，
 * 值來自 `src/lines/<line>.manifest.ts`）。各線通車只改自己的登記檔，本檔不必碰。
 *
 * 誰在查它：
 *   - 側欄 gnav：上排 `corePages()`、下排 `linePages()`（增補一：位置固定，通車只把那一枚的反灰復原）、
 *     鍵帽註記 `openPages()` 的數字串
 *   - 快捷鍵：`hotkeys.ts` 的 `navHotkeys()`（只產 open 的頁）、`useGlobalHotkeys` 的 `pageOfNavHotkey()`
 *   - `uiStore.setPage` 與 `?page=`（`isOpenPageId`）：未通車的頁不接受（契約決策 8）
 *   - 「?」情境卡的大標（`guideTitle`）與 `pageScope()`（`hotkeyScope`）
 *
 * probe 在 node 直接載入本檔（經 `hotkeys.ts`）：不得 import React／store／Tauri API，值 import 一律含 `.ts`。
 */
import type { HotkeyScope } from "./hotkeys";
import { LINE_MANIFESTS, type LineHotkeyScope, type LineId } from "../../lines/index.ts";

export type CorePageId = "today" | "routemap" | "calendar";
export type PageId = CorePageId | LineId;

export interface PageDef {
  id: PageId;
  label: string;
  status: "open" | "planned";
  navDigit: string;
  /** 一律是 `global.nav.${id}` */
  navHotkeyId: string;
  hotkeyScope: HotkeyScope;
  guideTitle: string;
}

const CORE_PAGES: readonly PageDef[] = [
  {
    id: "today",
    label: "今日",
    status: "open",
    navDigit: "1",
    navHotkeyId: "global.nav.today",
    hotkeyScope: "today",
    guideTitle: "今日視圖的快捷鍵",
  },
  {
    id: "routemap",
    label: "路線圖",
    status: "open",
    navDigit: "2",
    navHotkeyId: "global.nav.routemap",
    hotkeyScope: "outline",
    guideTitle: "路線圖的快捷鍵",
  },
  {
    id: "calendar",
    label: "日曆",
    status: "open",
    navDigit: "3",
    navHotkeyId: "global.nav.calendar",
    hotkeyScope: "calendar",
    guideTitle: "日曆的快捷鍵",
  },
];

const LINE_PAGES: readonly PageDef[] = LINE_MANIFESTS.map((m) => ({
  id: m.id,
  label: m.page.label,
  status: m.page.status,
  navDigit: m.page.navDigit,
  navHotkeyId: `global.nav.${m.id}`,
  // 第一個 scope＝桌機頁面的 scope（契約 §5.1）
  hotkeyScope: m.hotkeyScopes[0] as LineHotkeyScope,
  guideTitle: m.page.guideTitle,
}));

/** 順序＝gnav 的顯示順序：今日、路線圖、日曆、旅客筆記、時刻表、售票口 */
export const PAGES: readonly PageDef[] = [...CORE_PAGES, ...LINE_PAGES];

/** 啟動落點（決策 #12 首頁＝今日視圖） */
export const DEFAULT_PAGE: PageId = "today";

export function pageById(id: PageId): PageDef {
  const p = PAGES.find((x) => x.id === id);
  if (!p) throw new Error(`pages: 未登錄的頁「${id}」`);
  return p;
}

/** 已通車的頁（PAGES 順序）：快捷鍵 Ctrl+數字、鍵帽註記、`?page=` 都只認這些 */
export function openPages(): readonly PageDef[] {
  return PAGES.filter((p) => p.status === "open");
}

/** 未通車的頁（PAGES 順序） */
export function plannedPages(): readonly PageDef[] {
  return PAGES.filter((p) => p.status === "planned");
}

/** 核心三頁（gnav 上排；固定順序今日、路線圖、日曆） */
export function corePages(): readonly PageDef[] {
  return CORE_PAGES;
}

/** 三條功能線的頁（gnav 下排；固定順序旅客筆記、時刻表、售票口，不論通車與否） */
export function linePages(): readonly PageDef[] {
  return LINE_PAGES;
}

/** 是不是已通車的頁 id（`?page=` 的守門；未通車的頁與亂打的字串都回 false） */
export function isOpenPageId(v: string | null | undefined): v is PageId {
  return PAGES.some((p) => p.id === v && p.status === "open");
}

/** `global.nav.<頁>` → 該頁 id；只回已通車的頁，其他一律 null */
export function pageOfNavHotkey(hotkeyId: string): PageId | null {
  return PAGES.find((p) => p.navHotkeyId === hotkeyId && p.status === "open")?.id ?? null;
}
