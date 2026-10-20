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
  /**
   * 手機頁（MobileShell 的 `MOBILE_VIEWS` 取用，底部 tab 格的頁）。
   * 「更多」已不是 tab、也不再收子頁——入口是每頁頂帶右上的 ⋯（MobileTopBand）；
   * 目前沒有任何線的 mobileView 會收到 `onBack`，簽名保留 `onBack?` 只為相容。
   */
  mobileView: ComponentType<{ onBack?: () => void }> | null;
  /** 同步拉到東西／本機被整批換掉之後，重載這條線的畫面狀態 */
  reload: ((ctx: LineReloadContext) => Promise<void>) | null;
  /**
   * 同步 pull 套用完之後的「通知一聲」插槽（接縫 #54）：給那些畫面狀態之外、還有副作用要跟著新資料走的線——
   * 例如依拉下來的資料重排提醒／通知排程、重算只活在記憶體裡的衍生快取。**不是**重載畫面（畫面狀態用 `reload`，
   * 它有 `changed`／`wiped`／`shell` 可看）；這個插槽刻意不帶參數：要知道哪些表變了就用 `reload`，
   * 這裡只回答「剛拉完，現在資料是新的了」。
   * 時機：`refreshAfterPull` 在核心重載與各線 `reload` 都跑完之後逐線呼叫（含「本機資料被整批換掉」那一路）；
   * 桌機看 `page.status`、手機看 `mobile.status`，`open` 才呼叫（`lineAfterPulls(shell)`），三線固定順序；
   * 未通車即使填了也不呼叫。一條線丟錯（同步或非同步）只 warn、不拖累別條，也不等它。
   */
  afterPull?: () => void;
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
   * 樹內車票、支線四處，加 `RoutePanel.tsx` 概要尾端）渲染 `Desktop`、手機路線圖唯讀詳情（`MobileRouteMap.tsx` 的 `RowDetail`）渲染 `Mobile`；
   * 只在 `kinds` 含該節點 kind 時出現。桌機看 `page.status`、手機看 `mobile.status`，`open` 才出（`lineNodeFields(shell)`）；
   * 三線固定順序、各線內照登記順序。未通車即使填了也不出。
   */
  nodeFields?: readonly NodeFieldSpec[];
  /**
   * Ctrl+P 快速跳轉的結果提供者（接縫 #56；旅客筆記車次③ 0-5）：該線 `page.status === "open"` 時生效
   * （`lineQuickJumpProviders()`）。打的字以 `prefix` 開頭 ⇒ 只問這一個（去掉前綴後的字傳進 `search`）；
   * 否則節點結果之後，每個提供者 `search(term, 4)` 的結果各成一組（組名＝`group`，空組不畫）。未通車即使填了也不出。
   * 單值或陣列皆可（一條線要多組結果就給陣列，`lineQuickJumpProviders()` 統一攤平）；陣列內各提供者的 `id` 不可重複
   * （QuickJump 用 `<id>:<hit.id>` 當列 key）。前綴模式先到先得：兩個提供者用同一個 `prefix` 時只問陣列裡排前面的。
   */
  quickJump?: QuickJumpProviderSpec | readonly QuickJumpProviderSpec[];
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
  /**
   * 手機路線圖第一層每條路線列尾的小字（接縫 #63；第一個用的是售票口②的「本月花費」）：`RouteList`（`MobileRouteMap.tsx`）
   * 在每條路線的 `.m2-route-name` 之後、`.m2-route-go` 之前依序渲染各線的元件，收 `route`（該列的路線節點）。
   * 只看 `mobile.status`，`open` 才畫（`lineRouteListAsides()`）；未通車／planned 即使填了也不生效；三線固定順序。
   * **元件只能回 `span`／純文字，不得放任何可點的東西——它渲染在一顆 `button`（`.m2-route`）裡面**；沒東西要畫就回 null。
   * 沒有任何線填值＝DOM 與地基完全相同。
   */
  routeListAside?: ComponentType<{ route: NodeRow }>;
  /**
   * 刪除確認框的附加句（接縫 #62；旅客筆記車次④ 0-13）：桌機四個刪除入口（路線面板、路線／幹線對話框、任務側板的子項刪除、
   * 大綱的刪除流）在 `askConfirm` 之前呼叫核心的 `collectDeleteHints(node, descendantIds)`，逐線問一次：
   * 回字串 ⇒ 接在原 `body` 後面（以一個空白隔開）、回 null／空字串 ⇒ 原句一字不動。
   * `descendantIds`＝呼叫端已知的底下節點 id（不含 node 自己）；呼叫端沒載到底下的樹（例：路線／幹線對話框）傳 `[]`，該線自己補查。
   * 只看 `page.status`（四個入口都在桌機），`open` 才叫（`lineNodeDeleteHints()`）；未通車即使填了也不叫；三線固定順序。
   * 一條線丟錯當作沒有句子、不擋刪除。沒有任何線填值＝確認框文字與地基完全相同。
   */
  nodeDeleteHints?: (node: NodeRow, descendantIds: readonly string[]) => Promise<string | null>;
  /**
   * 日曆當日清單浮層底部的一段（接縫 #62；旅客筆記車次④ 0-14、D-筆-28）：`DayPopover` 在締切段之後依序渲染各線的元件，
   * 收 `day`（YYYY-MM-DD）與 `close`（關掉浮層）；元件自己畫一個 `.pop-sec`（借核心 class）、沒東西要畫就回 null。
   * 只看 `page.status`，`open` 才畫（`lineCalendarDayAux()`）；未通車即使填了也不畫；三線固定順序。
   * 沒有任何線填值＝DOM 與地基完全相同。
   */
  calendarDayAux?: ComponentType<{ day: string; close(): void }>;
  /**
   * 今日列的附加動作／標記（接縫 #66；時刻表車次② 0-1 甲）：桌機 `TodayRow` 在 `.meta` 尾端依序渲染各線的 `Desktop`
   * （收 `nodeId`／`name`／`selected`）；手機 `MobileTicket` 在 `.m-tk-meta` 之後依序渲染 `Mobile`（今日子頁與行程表串流共用，
   * 收 `readOnly`／`railDate`／`today` 讓元件自己決定只在哪一張卡畫）。元件沒東西要畫就回 null；樣式寫在該線自己的 CSS。
   * `hotkeys`：今日頁鍵盤的處理函式，鍵＝該線 manifest `hotkeys` 裡 scope "today" 的 hotkey id，收「選中那一列的 id」；
   * 沒選中任何列時不呼叫、鍵照常放行。只看 `page.status`（`lineTodayHotkey(id)`）。
   * 桌機看 `page.status`、手機看 `mobile.status`，`open` 才出（`lineTodayRowActions(shell)`）；三線固定順序、各線內照登記順序。
   * 未通車即使填了也不出。沒有任何線填值＝DOM 與鍵盤行為與地基完全相同。
   */
  todayRowActions?: readonly TodayRowActionSpec[];
  /**
   * 今日統計列的附加段（接縫 #66；時刻表車次② 0-14「專注」）：有任何一條通車的線填值時，桌機 `TodayView` 頁首 `.day-stats`
   * 的核心「專注」（今日清單 time_spent_min 合計）改由各線元件畫；手機 `MobileToday` 統計列尾端依序渲染。
   * `lead`＝前面已經有東西（元件要自己畫分隔「・」）；`wrap`＝核心沒畫統計列（手機今天沒有車票）⇒ 元件有內容時自己包
   * `<p className="m-today-stats">`、沒內容回 null（核心永遠不留空的 `<p>`）；桌機恆 false。
   * 桌機看 `page.status`、手機看 `mobile.status`，`open` 才出（`lineTodayStats(shell)`）；三線固定順序。
   * 未通車即使填了也不出。沒有任何線填值＝DOM 與地基完全相同。
   */
  todayStats?: ComponentType<{ shell: "desktop" | "mobile"; dateKey: string; lead: boolean; wrap: boolean }>;
  /**
   * 同步頁「最近兩台撞到的」清單列的名字（接縫：主線車次③ 契約 §3.3）：核心表由主線自己填，
   * 三線各自填自己的表（`tbl` 一定是該線 manifest `syncTables` 裡的名字）。
   * 回 `{ label, open?, cols? }`：`label`＝這一筆在主人眼裡叫什麼；`open`＝點了跳過去（沒給＝列不可點；`shell` 告訴你要用桌機還是手機的導航）；
   * `cols`＝欄名中文（「兩邊都改了」那一類印「○○ 的 {欄}」；沒給就印欄名原文）。
   * 回 null＝這一筆現在找不到了（又被刪了、或還沒拉到）⇒ 清單印「（現在找不到了）」。
   * 桌機看 `page.status`、手機看 `mobile.status`，`open` 才叫（`lineSyncRowLabel(tbl, shell)`）；未通車即使填了也不叫。
   * 一條線丟錯當作 null。沒有任何線填值＝清單列印泛稱，DOM 與沒有插槽時相同。
   */
  syncRowLabel?: (tbl: string, rowId: string, shell: "desktop" | "mobile") => Promise<SyncRowLabel | null>;
  /**
   * 這條線掛在荷札上的實體（時刻表⑥ 契約 0-6；零行為插槽）。荷札的 `taggings` 用 `'<頁面id>:<自訂>'` 當 entity_type 的別線實體：
   * - **存活**（`existsSql`／`aliveMemory`）：不分 status，裝上就生效（資料正確性）——荷札的計數、清單、刪除影響都只算還在的；
   *   沒登記的別線類型照舊一律算存活。登記經 `installLineMounts` 交給 `data/tagEntityAlive.ts`。
   * - **荷札頁怎麼畫**（`group`、`describe`）：旅客筆記荷札頁的「別處」那段，有登記的類型依 `group` 分段、用 `describe` 畫列；
   *   桌機看 `page.status`、手機看 `mobile.status`，`open` 才用（`lineTagEntities(shell)`）。沒登記＝照舊印原始 entity_type 字串、段名「別處」。
   * - **重載**（`tables`）：同步的 `changed` 含這些表 ⇒ 荷札的 index 重載（實體存活可能變了）。
   * 沒有任何線填值＝SQL、DOM、重載條件與沒有插槽時逐字相同。
   */
  tagEntities?: readonly TagEntitySpec[];
}

/** 一種掛在荷札上的別線實體（`LineMount.tagEntities` 的一筆） */
export interface TagEntitySpec {
  /** 跟 `taggings.entity_type` 完全一樣（`'<頁面id>:<自訂>'`；不可用 node／note） */
  type: `${string}:${string}`;
  /** 荷札頁的段名（例「時刻表」）；同一條線的幾種 type 給同一個 group 就併成一段 */
  group: string;
  /** SQL 片段：`g.entity_id` 指到的實體還在（`g`＝taggings 的別名），例 `EXISTS (SELECT 1 FROM x WHERE x.id = g.entity_id AND x.deleted_at IS NULL)` */
  existsSql: string;
  /** mock 模式的同一個判斷 */
  aliveMemory(id: string): Promise<boolean>;
  /** 荷札頁的列：label 主字、sub 小字、open 點了去哪；回 null 或缺這個 id＝退回原始字串 */
  describe(ids: readonly string[]): Promise<Readonly<Record<string, TagEntityRow | null>>>;
  /** 同步 `changed` 含其中任一 ⇒ 荷札 index 重載 */
  tables: readonly string[];
}

export interface TagEntityRow {
  label: string;
  sub?: string;
  open?: () => void;
}

/** 今日列附加動作（`LineMount.todayRowActions` 的一筆） */
export interface TodayRowActionSpec {
  /** `<line>.<name>` */
  id: `${LineId}.${string}`;
  /** 桌機今日列 `.meta` 尾端 */
  Desktop?: ComponentType<{ nodeId: string; name: string; selected: boolean }>;
  /** 手機票卡 `.m-tk-meta` 之後（今日子頁與行程表串流共用；`railDate`／`readOnly` 照 `TicketCardModel`，`today`＝日界線今天） */
  Mobile?: ComponentType<{ nodeId: string; name: string; readOnly: boolean; railDate: string | null; today: string }>;
  /** hotkey id（該線 manifest 登記、scope "today"）→ 處理函式（收選中列的 id） */
  hotkeys?: Readonly<Record<string, (nodeId: string) => void>>;
}

/** `LineMount.syncRowLabel` 的回傳：同步頁清單列的名字與跳轉 */
export interface SyncRowLabel {
  label: string;
  open?: () => void | Promise<void>;
  cols?: Readonly<Record<string, string>>;
  /**
   * 「兩邊都改了」那一類的值格式化（接縫 #77）：`(欄名, 原值)` ⇒ 要印的字；回 null＝這個欄退回 `fmtMergeValue`。
   * 例：時刻欄把 UTC ISO 印成本地「10/19 14:35」、外鍵欄把 uuid 印成名字。不給＝照原樣印。
   */
  fmt?: (col: string, v: unknown) => string | null;
  /** 補一句（接縫 #77）：接在方向句後面、括號包起來（只放清單列；toast 不放，兩行上限）。不給＝不多任何東西 */
  note?: string;
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
  /**
   * 內容是多行的欄位（例：旅客筆記的筆記區）⇒ 桌機 `FieldRow` 的標籤靠上對齊，不垂直置中（接縫 #62；0-18）。
   * 預設 false；不填＝既有欄位位置不動。
   */
  top?: boolean;
  /**
   * 桌機任務側板畫在哪一段（接縫 #66；時刻表車次② 0-1）：預設 `"status"`（既有位置）；`"amount"`＝列車／車廂面板的「分量」段，
   * 有任何一筆 amount 欄位時取代原本的「花費」那一列（只有列車／車廂面板畫，別的面板不出 amount 欄位）。
   * 手機路線圖詳情不分段。不填＝既有欄位位置不動。
   */
  section?: "status" | "amount";
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
