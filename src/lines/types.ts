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
import type { NodeKind, NodeRow } from "../domain";

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
  /**
   * 桌機書封的頁務件插槽（接縫 #50；旅客筆記③與售票口①共用）：該線 `page.status === "open"` 且當前頁＝該線時，
   * 取代書封的 `.lines-scroll`（「我的路線」）整段；全域三件（gnav、工具列、cover-foot）不動。
   * 元件自己負責 `flex:1; min-height:0; overflow:auto` 的捲動與 h2 總標（沿用 `.lines h2` 的樣式：中文＋拉丁字），
   * 樣式寫在該線自己的 CSS、class 用自己的前綴。未通車即使填了也不掛。
   */
  sidebarAux?: ComponentType;
  /**
   * 日曆格內記號插槽（旅客筆記車次② 0-2 乙）：該線 `page.status === "open"` 時，日曆頁換區間就呼叫
   * `(from, to)`（YYYY-MM-DD，含兩端），回「要畫記號的日 key」；格標頭列 `.ch` 末尾畫 `i.mark.mark-<line>`，
   * 三線固定順序；底色由 `calendar.css` 的 `.mark` 出（各線可用 `.mark-<line>` 自己改）。未通車即使填了也不畫。
   */
  calendarDayMarks?: (from: string, to: string) => Promise<readonly string[]>;
  /**
   * 捕捉目的地（旅客筆記車次② D-筆-36）：該線登記的捕捉框票根，排在旅客筆記內建四枚之後、三線固定順序。
   * 桌機看 `page.status`、手機看 `mobile.status`，`open` 才出現（`lineCaptureTargets(shell)`）；未通車即使填了也不出。
   */
  captureTargets?: readonly CaptureTargetSpec[];
  /**
   * 節點詳情的欄位列（接縫 #56；旅客筆記車次③ 0-2／0-4）：桌機任務側板（`TaskFields.tsx` 的列車／車廂、臨時車票、
   * 樹內車票三處）渲染 `Desktop`、手機路線圖唯讀詳情（`MobileRouteMap.tsx` 的 `RowDetail`）渲染 `Mobile`；
   * 只在 `kinds` 含該節點 kind 時出現。桌機看 `page.status`、手機看 `mobile.status`，`open` 才出（`lineNodeFields(shell)`）；
   * 三線固定順序、各線內照登記順序。未通車即使填了也不出。
   */
  nodeFields?: readonly NodeFieldSpec[];
  /**
   * Ctrl+P 快速跳轉的結果提供者（接縫 #56；旅客筆記車次③ 0-5）：該線 `page.status === "open"` 時生效
   * （`lineQuickJumpProviders()`）。打的字以 `prefix` 開頭 ⇒ 只問這一個（去掉前綴後的字傳進 `search`）；
   * 否則節點結果之後，每個提供者 `search(term, 4)` 的結果各成一組（組名＝`group`，空組不畫）。未通車即使填了也不出。
   */
  quickJump?: QuickJumpProviderSpec;
  /**
   * 導航上的線標記（接縫 #58；時刻表車次①b 0-1 甲）：畫在桌機書封該線 `.gnav-line` 按鈕的最後一個子節點、
   * 手機底部 tab 那一格的圖示之後（`shell` 告訴元件畫在哪一殼）。元件自己訂閱自己線的 store、沒東西要畫就回 null；
   * 位置與長相由該線自己的 CSS 寫（class 用自己的前綴）。桌機看 `page.status`、手機看 `mobile.status`，`open` 才畫
   * （`lineNavBadge(id, shell)`）。未通車即使填了也不畫。
   */
  navBadge?: ComponentType<{ shell: "desktop" | "mobile" }>;
  /**
   * 桌機書封 tooltip 的尾巴（接縫 #58）：**純函式、不訂閱**；Sidebar 只在該線按鈕 `onMouseEnter`／`onFocus` 時呼叫，
   * 回字串 ⇒ title 改成「原 title＋`・`＋hint」，回 null ⇒ 原 title。只看 `page.status`；未通車即使填了也不叫。
   */
  navHint?: () => string | null;
  /**
   * 手機票卡 ⋯ sheet 的附加項（接縫 #56 後半；旅客筆記車次③ 0-3）：`MobileTicketSheet` 在「取消」之前、
   * 卡片不是唯讀（`!card.readOnly`）時依序渲染各線的 `Item`；三線固定順序、各線內照登記順序。
   * 只看 `mobile.status`，`open` 才出（`lineTicketSheetItems()`）。未通車即使填了也不出。
   */
  ticketSheetItems?: readonly TicketSheetItemSpec[];
}

/** 手機票卡 ⋯ sheet 的一項（`LineMount.ticketSheetItems` 的一筆）。`Item` 自己畫 `.m-sheet-item`，點了先 `close()` 再做事。 */
export interface TicketSheetItemSpec {
  /** `<line>.<name>`，例 "notes.tags" */
  id: `${LineId}.${string}`;
  Item: ComponentType<{ nodeId: string; name: string; close(): void }>;
}

/** 節點詳情欄位列（`LineMount.nodeFields` 的一筆） */
export interface NodeFieldSpec {
  /** `<line>.<name>`，例 "notes.tags" */
  id: `${LineId}.${string}`;
  /** 欄位標籤（桌機＝`FieldRow` 的 `label`；手機由 `Mobile` 自己畫 `dt`） */
  label: string;
  /** 哪些節點 kind 出這一列（例 `["ticket","train","car"]`） */
  kinds: readonly NodeKind[];
  /** 桌機任務側板的欄位內容（渲染在 `FieldRow` 裡） */
  Desktop: ComponentType<{ node: NodeRow }>;
  /** 手機路線圖唯讀詳情的一列（自己畫 `dt`／`dd`）；不給＝手機不出 */
  Mobile?: ComponentType<{ node: NodeRow }>;
}

/** Ctrl+P 的一列結果（`QuickJumpProviderSpec.search` 回傳） */
export interface QuickJumpHit {
  /** 組內唯一（React key） */
  id: string;
  label: string;
  /** 右側淡字（例「12 處」） */
  aside?: string;
  /** 左側徽章（借核心 `.ns-kind-badge`；`dashed` ＝虛線框） */
  glyph?: { text: string; dashed?: boolean };
  /** 縮排層數（樹狀列用；0／不給＝不縮） */
  indent?: number;
  /** 選中（Enter／點擊）：QuickJump 先關掉自己再呼叫 */
  go(): void | Promise<void>;
}

/** Ctrl+P 的結果提供者（`LineMount.quickJump`） */
export interface QuickJumpProviderSpec {
  /** `<line>.<name>`，例 "notes.tags" */
  id: `${LineId}.${string}`;
  /** 組名（附加組模式的小標） */
  group: string;
  /** 前綴（例 "#"）：打的字以它開頭 ⇒ 只查這個提供者；不給＝只在附加組出現 */
  prefix?: string;
  /** `term`：前綴模式已去掉前綴（只打前綴＝空字串，提供者自己決定列什麼）；`limit`：附加組模式給 4 */
  search(term: string, limit: number): Promise<QuickJumpHit[]>;
}

/** 捕捉框落點列與存檔要的路線（＝捕捉框目前認到的路線前綴；主人按 × 取消過的不算） */
export interface CaptureRouteRef {
  id: string;
  name: string;
}

/** `CaptureTargetSpec.save` 的輸入 */
export interface CaptureSaveInput {
  /** 原文（含路線前綴；已去尾端空白） */
  text: string;
  /** 內文：`acceptsRoute` 且認到前綴 ⇒ 去掉前綴（與冒號後空白）；否則＝`text`。保證非空白 */
  body: string;
  /** `acceptsRoute` 且認到前綴 ⇒ 該路線 id；否則 null */
  routeId: string | null;
  /** 存檔當下的日界線今天（`todayKey(useUiStore.dayStartHour)`），YYYY-MM-DD */
  dayKey: string;
}

/** `CaptureTargetSpec.save` 的結果：null＝當作沒內容（框留著、不 toast） */
export interface CaptureSaveResult {
  /** 存檔成功的 toast 全文 */
  toast: string;
  /** 有給就在 toast 帶「復原」鈕；復原失敗由旅客筆記統一吐失敗 toast */
  undo?: () => Promise<void>;
}

/**
 * 一枚別線登記的捕捉票根（旅客筆記車次② D-筆-36）。旅客筆記的捕捉框（桌機 CaptureOverlay／手機 MobileCaptureSheet）
 * 把它畫在內建四枚（收件匣／待辦／筆記／日記）之後，Tab 輪替一起輪；存檔時呼叫 `save`。
 * `save` throw ⇒ 框不關、吐失敗 toast（錯誤訊息有內容就吐它）；回 null ⇒ 當空內容。
 */
export interface CaptureTargetSpec {
  /** `<line>.<name>`（例 "timetable.time"）；不得與內建四枚 id 相同，三線之間也不得重複 */
  id: `${LineId}.${string}`;
  /** 票根大字（例「時間」） */
  label: string;
  /** 票根小字（例「記一段時間」） */
  hint: string;
  /** 落點列「→」後面的字；`route`＝目前認到的路線前綴（`acceptsRoute` 為 false 時也照傳，給它決定要不要提） */
  destLabel(route: CaptureRouteRef | null): string;
  /** true＝吃路線前綴（save 拿到 routeId、body 去掉前綴）；false＝原文照留、routeId 恆 null（同日記） */
  acceptsRoute: boolean;
  save(input: CaptureSaveInput): Promise<CaptureSaveResult | null>;
}
