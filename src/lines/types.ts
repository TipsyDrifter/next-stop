/**
 * 三線登記處的型別（並行地基・契約 2026-09-29 §5.1；增補 2026-10-05 增補二）。
 *
 * 三條功能線（旅客筆記／時刻表／售票口）各有兩份登記檔：
 *   - `<line>.manifest.ts`＝純資料（頁面狀態、手機入口、快捷鍵、同步表名…），probe 會在 node 直接載入
 *   - `<line>.mount.tsx`  ＝元件與重載掛點（桌機頁、手機頁、同步後重載、全域浮層、全域快捷鍵處理函式）
 * 集中檔（pages.ts、hotkeys.ts、Sidebar.tsx、App.tsx、MobileShell.tsx、syncStore.ts…）在地基時就把三份登記檔
 * 接進來了，之後各線**只改自己的登記檔**（契約決策 1）。
 *
 * 本檔是純型別：不得 import React 執行期、store、Tauri API（型別一律 `import type`）。
 */
import type { ComponentType } from "react";
import type { Hotkey } from "../ui/shell/hotkeys";
import type { Scene } from "../ui/shell/hotkeyRows";

export type LineId = "notes" | "timetable" | "ticket";
export type LineStatus = "planned" | "open";

export interface LineManifest {
  id: LineId;
  /** 桌機頁面 */
  page: {
    status: LineStatus;
    /** gnav 與 tooltip 上的頁名 */
    label: string;
    /** 全域鍵位的數字鍵（公約 §六預配）；`status` 改成 open 時 Ctrl+<數字> 才生效（契約決策 7） */
    navDigit: "4" | "5" | "6";
    /** 「?」情境卡的大標 */
    guideTitle: string;
  };
  /** 手機入口：底部 tab 的一格，或「更多」頁的一列 */
  mobile: { slot: "tab" | "more"; status: LineStatus; label: string; latin: string };
  /** 這條線擁有的快捷鍵 scope；第一個＝桌機頁面的 scope */
  hotkeyScopes: readonly string[];
  hotkeys: readonly Hotkey[];
  /** 設定「快捷鍵」籤的分組 */
  scenes: readonly Scene[];
  /**
   * scope → 接線的 hook 檔（相對 `src/`）；probe 用（每個 wired id 要以字串字面值出現在對應檔裡）。
   * 該線的全域快捷鍵（scope "global"）處理函式寫在 mount 檔時，登記 `global: "lines/<line>.mount.tsx"`。
   */
  hotkeyFiles: Readonly<Record<string, string>>;
  /** 同步表名；必須與 Rust `sync/tables/<line>.rs` 的 name 逐一相同、順序相同（`pnpm probe:registry` 對帳） */
  syncTables: readonly string[];
  /** 要同步的 settings 鍵；必須與 Rust `sync/tables/<line>.rs` 的 `SETTINGS_KEYS` 相同 */
  syncSettingsKeys: readonly string[];
}

/** 同步重載的情境 */
export interface LineReloadContext {
  /** 這次拉到有變動的表名（含核心表） */
  changed: readonly string[];
  /** true＝本機資料被整批換掉（一起清空、改用另一台的…），畫面上的選取狀態要一起清 */
  wiped: boolean;
  shell: "desktop" | "mobile";
}

export interface LineMount {
  desktopView: ComponentType | null;
  /** tab 格的頁，或「更多」的子頁（後者會收到 onBack） */
  mobileView: ComponentType<{ onBack?: () => void }> | null;
  /** 同步拉到東西／本機被整批換掉之後，重載這條線的畫面狀態 */
  reload: ((ctx: LineReloadContext) => Promise<void>) | null;
  /**
   * 桌機全域浮層（增補二）：該線 `page.status === "open"` 時常駐掛在 App 覆蓋層區的最後，自己決定何時顯示。
   * 未通車即使填了也不掛。
   */
  desktopOverlay?: ComponentType;
  /** 手機全域浮層／浮動鈕（增補二）：該線 `mobile.status === "open"` 時常駐掛在 MobileShell 的最後 */
  mobileOverlay?: ComponentType;
  /**
   * 該線的全域快捷鍵（不限頁面）處理函式（增補二）。鍵＝該線 manifest `hotkeys` 裡登記的 hotkey id
   * （scope 必須是 "global"）。該線 `page.status === "open"` 時 `useGlobalHotkeys` 在既有 switch 之前查這張表，
   * 查到就 `preventDefault` 並呼叫。未通車即使填了也不生效。
   */
  globalHotkeyHandlers?: Readonly<Record<string, () => void>>;
  /**
   * 桌機書封側欄的工具列插槽（旅客筆記車次① 0-1 甲）：該線 `page.status === "open"` 時渲染在書封搜尋鈕
   * （`.gnav-search`）的左側，三線固定順序；樣式由該線自己的 CSS 寫。未通車即使填了也不掛。
   */
  sidebarTool?: ComponentType;
}
