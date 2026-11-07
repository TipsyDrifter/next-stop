/**
 * ticketStore——售票口線的畫面狀態與流程（車次①契約 §3.8、§3.9；甲席 Stage 0 全文）。
 *
 * **UI 只讀 store、只叫 store 的動作，不直接碰 repository**（契約 §2.5-2；§8 有 grep 牙齒）。兩殼共用一份
 * （篩選帳戶、月份、選取、表單草稿），兩殼永不同時渲染。
 *
 * - serial 佇列（同 timetableStore）：所有寫入、`refresh`、捕捉框的 `addQuickEntry` 都經 `serial()`。
 *   `refresh` 本身不排隊（呼叫端包 `serial(() => get().refresh())`），排進佇列的函式裡不得再呼叫 `serial`（會互等）。
 * - 時間：日＝`todayKey(useUiStore.getState().dayStartHour)`；時刻＝`new Date().toISOString()`；改時刻用 domain 的 `atOf`。
 * - 錯誤：寫入失敗 toast（`RangeError` 吐它的 message，其餘 `TK_TEXT.saveFail`），回 `false`／不改狀態；
 *   `error` 只給 `init`／`refresh` 載入失敗。
 * - toast 與固定文案集中在 `TK_TEXT`（契約 §5.7、0-33）；顯示端不手抄。
 * - 售票口④（Stage 0 資料席）：荷札（帳／定期帳規則／願望／常用票種，實體 `ticket:*`）經 `tagRepo` 寫、讀 `tagStore.index`；
 *   本機寫過荷札 ⇒ refresh 開頭重載 index（tagStore.reload 只認同步的 changed，同時刻表⑥）。記一筆草稿是 `TicketDraft`
 *   （多荷札、定期快設、從哪個願望／常用票種來）；備註記憶懶載；願望與常用票種跟預算／規則一起在 warm／refresh 重讀。
 * - 售票口④ 第二輪（Stage 0 資料席）：分類不限層數——統計以某分類為根（`statsRoot`／`setStatsRoot`，「進入 ›」與麵包屑）、
 *   「移到…」（`moveCategoryUnder`）、「常用」與備註帶分類排除上層封存的（`categoryArchivedUp`）；帳戶頁（`view === "accounts"`，
 *   `accountCards` 在進頁與 refresh 時一次查完）。
 * - 己-2「記住上次」（D-主-416～418；本機、不同步）：視圖、統計的期間／切面／收支（兩殼各記，冷啟動第一次 init 套回）；
 *   轉帳的轉入帳戶（存轉帳時記「從哪轉出 → 轉進哪」，新轉帳轉入還空著就預填）。純函式在 domain/ticketPrefs。
 */
import { create } from "zustand";
import { ticketRepo } from "../data/ticketRepository";
import { settingsRepo } from "../data";
import { useUiStore } from "./uiStore";
import { useNodeStore } from "./nodeStore";
import { addDays, todayKey } from "../lib/date";
import {
  guessTransferTo,
  parseFacet,
  parseFacetKind,
  parseStatsSpan,
  parseTicketView,
  parseTransferMemo,
  rememberTransfer,
  type TransferMemo,
} from "../domain/ticketPrefs";
import type { LineReloadContext, CaptureSaveInput, CaptureSaveResult, CaptureRouteRef } from "../lines/types";
import {
  MAIN_CURRENCY,
  USAGE_DAYS,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  UNCAT_NAME,
  accountTotals,
  addMonths,
  bareName,
  categoryArchivedUp,
  defaultAccountId,
  draftToInput,
  frequentAccountIds,
  frequentCategoryIds,
  groupByDay,
  localTime,
  moneyText,
  monthOf,
  monthRange,
  monthSum,
  orderAccounts,
  parseAmount,
  parseQuickEntry,
  parseRate,
  quickAmountText,
  quickToast,
  signedText,
  type AccountRow,
  type CategoryRow,
  type CurrencyRow,
  type EntryRow,
  type EntryDraft,
  type EntryPatch,
  type AccountGroup,
  type CategoryKind,
  type DayGroup,
  type EntryCtx,
  type QuickCtx,
} from "../domain/ticket";
import {
  DEFAULT_ENTRY_SORT,
  EMPTY_FILTER,
  GONE_KEY,
  UNSPLIT_KEY,
  VIEW_TEXT,
  accountCards,
  accountsRange,
  breakdown,
  calendarCells,
  facetAllowed,
  filterToQuery,
  isAmountSort,
  isFilterActive,
  keywordTokens,
  matchesKeyword,
  monthlyTrend,
  nearestDayWithEntries,
  parseEntrySort,
  periodOf,
  periodRange,
  routeCtx,
  shortDay,
  sortEntries,
  statsOverview,
  stepPeriod,
  trendMonths,
  trendRange,
  type AccountCard,
  type CalendarCell,
  type EntryFilter,
  type EntrySort,
  type Facet,
  type Period,
  type StatsData,
  type StatsSpan,
  type TicketView,
  type ViewCtx,
} from "../domain/ticketView";
import {
  amountInputText,
  budgetLines,
  draftFromRepeat,
  draftToRepeatInput,
  effectiveBudget,
  overBudgetDay,
  parseBudgetAmount,
  parseFixedRule,
  ruleFromEntry,
  type BudgetLine,
  type BudgetRow,
  type BudgetScope,
  type RepeatDraft,
  type RepeatRow,
} from "../domain/ticketPlan";
import { describeRule, type FixedRepeatRule } from "../domain/repeat";
import {
  isRepeatMade,
  noRepeat,
  quickFollowDay,
  quickRepeat,
  quickRepeatDraft,
  quickRepeatLabel,
  quickSourceOfEntry,
  type RepeatQuick,
  type RepeatQuickFreq,
} from "../domain/ticketPlan";
import { NO_TAG_KEY, matchesTagFilter } from "../domain/ticketView";
import {
  TK_TAG_ENTRY,
  TK_TAG_REPEAT,
  TK_TAG_TEMPLATE,
  TK_TAG_WISH,
  cleanTagNames,
  entityTagMap,
  splitQuickTags,
  tagNameOf,
  type TicketTagType,
} from "../domain/ticketTags";
import {
  AIDS_TEXT,
  EMPTY_WISH_VIEW,
  lastCategoryForNote as lastCategoryOf,
  noteRecallItems,
  templateDraftSeed,
  templateFromEntry,
  wishDraftSeed,
  wishView,
  type NoteUse,
  type TemplateRow,
  WR_KIND_BUY_ID,
  type WishAction,
  type WishKindRow,
  type WishRow,
  type WishTargetKind,
  type WishView,
} from "../domain/ticketAids";
import type { RecallItem } from "../domain/recall";
import { keyOf } from "../domain/tags";
import { tagRepo } from "../data/tagRepo";
import { useTagStore } from "./tagStore";

export type TicketShell = "desktop" | "mobile";

/**
 * 記一筆的草稿（售票口④）：EntryDraft（存成帳的那些欄）＋
 *   tags          荷札名稱（存檔後 `tagRepo.setTags('ticket:entry')`；有定期也掛到規則上）
 *   repeat        「定期」那一列（不重複｜每日｜每週｜每月＋星期幾／幾號＋結束日；D-票-66）
 *   wishId        從願望「買了」開的（存了把願望標成已買）
 *   fromTemplateId 從哪個常用票種填的（只給畫面標示；存檔不用）
 * 改記帳日時，星期幾／幾號沒被點改過就跟著新日子走（setDraft 內 quickFollowDay）。
 */
export interface TicketDraft extends EntryDraft {
  tags: string[];
  repeat: RepeatQuick;
  wishId: string | null;
  fromTemplateId: string | null;
}
/** 詳情板（桌機右側）／全螢幕面板（手機）現在畫什麼；兩殼共用 */
export type TicketPanel = { kind: "none" } | { kind: "new" } | { kind: "entry"; id: string } | { kind: "account"; id: string };
export type TicketDialog =
  /* then（磨光③ 2-16、D-票-60）：建好之後接著做什麼——意圖放在 dialog 本身，被別的對話框蓋掉或取消就跟著消失。
     new＝openNew 因為沒帳戶才開這裡 ⇒ 建完直接打開記一筆、帳戶選好（seed＝原本 openNew 帶的，例如某一天）；
     pick＝從帳戶選單開的 ⇒ 建完選上它（填回草稿） */
  | { kind: "newAccount"; then?: { new: Partial<TicketDraft> } | { pick(accountId: string): void } }
  | { kind: "categories" }
  /* 磨光⑥ 契約 §2-1（D-票-61）：帳戶順序（群組內 ⋯ 選單上移／下移，兩殼共用本體 dialogs/AccountOrder） */
  | { kind: "accountOrder" }
  | { kind: "currencies" }
  /* 第③階段（③契約 §3.8）：預算對話框、定期帳管理、規則編輯器（id null＝新建；seed＝「設成定期…」帶的預填） */
  | { kind: "budgets" }
  | { kind: "repeats" }
  | { kind: "repeat"; id: string | null; seed?: Partial<RepeatDraft> }
  /* 售票口④（D-票-68）：管帳「常用票種…」（改名、刪除、排序）；帳目詳情「存成常用…」取名（entryId＝來源那筆） */
  | { kind: "templates" }
  | { kind: "saveTemplate"; entryId: string };

export interface TicketStore {
  ready: boolean; // init 完成
  loading: boolean;
  /** 只給「載入失敗」用；寫入失敗一律 toast（同時刻表 §3.7） */
  error: string | null;
  currencies: CurrencyRow[];
  curByCode: Record<string, CurrencyRow>;
  accounts: AccountRow[];
  accById: Record<string, AccountRow>; // 含封存
  categories: CategoryRow[];
  catById: Record<string, CategoryRow>; // 含封存
  balances: Record<string, number>; // 帳戶幣別
  totals: { asset: number; liability: number; net: number }; // 主幣別（accountTotals）
  hasAny: boolean;
  month: string; // 頁首的月 "YYYY-MM"
  loadedMonths: string[]; // month 起往前接續載入的月（含 month），新到舊
  entries: EntryRow[]; // loadedMonths 的帳（已套 filter），新到舊
  days: DayGroup[]; // groupByDay(entries, filterAccountId)
  monthSum: { income: number; expense: number } | null; // filter＝全部時才有（只算 month）
  filterAccountId: string | null;
  selectedId: string | null;
  panel: TicketPanel;
  draft: TicketDraft | null; // panel.kind === "new" 時（售票口④：多 tags／repeat／wishId／fromTemplateId）
  savedAt: number | null; // 舊票即時存成功的時間（「已存」淡字）
  lastAccountId: string | null;
  recent: { income: string[]; expense: string[] }; // 最近用過 8 個
  /** 記一筆的「常用」（磨光⑥ §2-3；只改顯示順序）：分類＝30 天次數多的在前、不滿 8 個用 recent 補；帳戶＝30 天前 3 名（帳戶 ≤ 3 個時空）。warm／refresh 跟 recent 一起重讀 */
  frequent: { income: string[]; expense: string[]; accounts: string[] };
  dialog: TicketDialog | null;

  /* 載入 */
  warm(): Promise<void>; // 冪等：ensureStarterRows → 幣別／帳戶／分類 → lastAccountId → recent（App 一啟動由 TicketAgent 叫）
  init(shell: TicketShell): Promise<void>; // 冪等：warm → month＝今天所在月 → refresh
  refresh(): Promise<void>; // 重讀全部（保留 month／loadedMonths／filter；selectedId 不在了就清）
  reload(ctx: LineReloadContext): Promise<void>; // mount 指到這裡（§3.9）

  /* 月份與清單 */
  setMonth(month: string): Promise<void>; // loadedMonths 重設為 [month]
  stepMonth(delta: 1 | -1): Promise<void>; // [ ] 與 ‹ ›；不超過今天所在月
  loadOlderMonth(): Promise<void>; // 捲到底：接上 loadedMonths 最後一個月的前一個月
  setFilter(accountId: string | null): Promise<void>;
  cycleFilter(): Promise<void>; // Tab：全部 → 未封存帳戶依序 → 全部
  select(id: string | null): void;
  moveSelection(delta: 1 | -1): void; // 跨日分組；到邊界不動
  requestEscape(): void; // 新票有內容 ⇒ askConfirm「放棄這一筆？」；否則 panel none／取消選取

  /* 記一筆（新票：明確存檔，0-8） */
  openNew(seed?: Partial<TicketDraft>): void; // 預設：expense、帳戶＝defaultAccountId、今天（日界線）、現在、帳戶幣別；④：沒荷札、不重複
  setDraft(patch: Partial<TicketDraft>): void; // 換帳戶 ⇒ 幣別跟著換（收支）；kind 換成 transfer ⇒ categoryId 清空；④：改日期 ⇒ 定期的星期幾／幾號跟著走（沒點改過的話）
  /**
   * saveDraft（④）：先驗（帳、荷札名稱、定期規則都合法才寫）→ 建帳 → setTags('ticket:entry') → 有定期 ⇒ 建規則（從下一班起）＋
   * 掛同一組荷札（'ticket:repeat'）＋連上這筆 → 有 wishId ⇒ 願望標成已買 → 實體化一次（起算在過去才會補記）→ toast（復原＝刪這筆＋刪剛建的規則）。
   * again ⇒ 留 kind／帳戶／分類／日期，清金額、備註、荷札、定期（回不重複）、wishId、fromTemplateId
   */
  saveDraft(opts: { again: boolean }): Promise<boolean>;
  /* 舊票：即時存（UI 用 panel/fields.tsx:76 useDebouncedCommit 去抖後呼叫） */
  openEntry(id: string): void;
  openAccount(id: string): void;
  closePanel(): void;
  updateEntry(id: string, patch: EntryPatch): Promise<void>; // 成功 ⇒ savedAt = Date.now()、refresh
  deleteEntry(id: string): Promise<void>; // 軟刪＋toast「已刪除這一筆」帶「復原」（restoreEntry）

  /* 帳戶 */
  /** 回新帳戶（失敗 toast、回 null）；當下 dialog 帶 then ⇒ 接著 openNew／pick（2-16） */
  createAccount(input: { name: string; group: AccountGroup; currency: string; openingText: string }): Promise<AccountRow | null>;
  updateAccount(id: string, patch: { name?: string; group?: AccountGroup; currency?: string }): Promise<void>;
  archiveAccount(id: string): void; // askConfirm（§5.7 封存確認）→ setAccountArchived(id, true)
  unarchiveAccount(id: string): Promise<void>;
  moveAccount(id: string, delta: 1 | -1): Promise<void>;
  adjustBalance(accountId: string, targetText: string): Promise<boolean>; // 備註「餘額調整」；toast「已精算 ±N」／「餘額沒有變」

  /* 分類與幣別 */
  /** 回新分類（失敗 toast、回 null）；回來時已 refresh 過（catById 裡有它）⇒ 呼叫端可直接 setDraft({ categoryId: row.id })「建完選上」（UI 丙-5 D1） */
  createCategory(input: { kind: CategoryKind; name: string; parentId: string | null }): Promise<CategoryRow | null>;
  renameCategory(id: string, name: string): Promise<void>;
  setCategoryArchived(id: string, archived: boolean): Promise<void>;
  moveCategory(id: string, delta: 1 | -1): Promise<void>;
  createCurrency(input: { code: string; name: string; decimals: number; rateText: string }): Promise<boolean>;
  updateCurrency(id: string, patch: { name?: string; rateText?: string }): Promise<void>;

  /* 對話框 */
  openDialog(d: TicketDialog): void;
  closeDialog(): void;

  /* 捕捉目的地（§3.10） */
  addQuickEntry(input: CaptureSaveInput): Promise<CaptureSaveResult>;
  quickDestLabel(route: CaptureRouteRef | null): string; // 同步；warm 前＝「售票口」

  /* ═══ 第②階段「看帳」（②契約 §3.4；①的欄位與動作一個都不改） ═══ */

  /* 視圖（0-10；0-17 原本不持久化、冷啟動回清單——己-2 B5 D-主-418 翻案：記本機、冷啟動回上次，見 KEY_TICKET_VIEW） */
  view: TicketView; // "list" | "calendar" | "stats" | "accounts"（頁首四格；壬 D-主-513 拿掉 "wish"）
  setView(v: TicketView): Promise<void>; // 進 stats ⇒ 載 statsEntries；進 accounts ⇒ 載 accountCards；離開清單 ⇒ 詳情板（entry／account）收起
  /* 統計（0-6～0-9） */
  span: StatsSpan; // "month" | "year"
  setSpan(s: StatsSpan): Promise<void>;
  period: Period; // span=month ⇒ { month, key: month }；span=year ⇒ { year, key: "YYYY" }（年模式 [ ] 只動它，month 不動）
  facet: Facet; // 側欄已篩帳戶時被迫 "category"（facetAllowed）
  setFacet(f: Facet): void;
  facetKind: "expense" | "income";
  setFacetKind(k: "expense" | "income"): void;
  drill: string | null; // 展開中的主分類 key
  setDrill(key: string | null): void;
  /**
   * 售票口④ 第二輪（D-票-78）：統計分類切面以哪個分類為根（null＝全部分類）。`setStatsRoot(id)`＝「進入 ›」／麵包屑回某一層
   * （同時收起 drill、重算 stats）；麵包屑的字用 `statsCrumbs(statsRoot, catById)`。換切面、換收支、那個分類不在了 ⇒ 回 null；換期間保留
   */
  statsRoot: string | null;
  setStatsRoot(id: string | null): void;
  statsEntries: EntryRow[]; // trendRange(period) 的帳（已套 filterAccountId）
  stats: StatsData | null; // 純函式從 statsEntries 算
  /* 月曆（0-2、0-16） */
  calendar: CalendarCell[][] | null; // calendarCells(month 的 entries, month, weekStart, today)；entries／weekStart 變就重算
  jumpToDay(dayKey: string): Promise<void>; // 切清單、確保那個月、選中那天第一筆；沒帳 ⇒ pendingDay＝最接近的日、dayNotice
  pendingDay: string | null; // UI 捲到這一天的日分組頭後叫 consumePendingDay
  consumePendingDay(): void;
  dayNotice: string | null; // 「10/8 沒有紀錄」（jumpToDay 那天沒帳）；UI 顯示 3 秒後叫 clearDayNotice（Stage 0 加；契約 0-16 的淡字）
  clearDayNotice(): void;
  /* 搜尋與篩選（0-14、0-15） */
  searchOpen: boolean;
  filter: EntryFilter; // text＋五欄
  results: EntryRow[] | null; // isFilterActive(filter) 才有；queryEntries → matchesKeyword；新到舊
  resultDays: DayGroup[]; // groupByDay(results, filterAccountId)；金額排序是平面清單 ⇒ 空陣列（畫面直接畫 results）
  /** 搜尋結果的排序（磨光⑥ §2-4）：results 已照它排好；金額排序（isAmountSort）不分日。選擇存本機 `ticket_result_sort`（手機 `_mobile`），closeSearch 回 dateDesc */
  resultSort: EntrySort;
  setResultSort(sort: EntrySort): void; // 立刻重排現有 results（不重查）＋存本機；失敗吞掉
  /** 一般清單頁首的「排序」：開搜尋、期間＝現在看的那個月、套上 sort（金額排序需要有邊界的範圍）；已有搜尋條件就只換排序 */
  searchMonthSorted(sort: EntrySort): Promise<void>;
  openSearch(): void; // view 非 list ⇒ 先切清單
  closeSearch(): void; // filter 回 EMPTY_FILTER、results null
  setFilterText(text: string): Promise<void>; // 去抖由 UI 做（150ms），store 直接查
  patchFilter(p: Partial<EntryFilter>): Promise<void>; // 開著搜尋
  drillToList(p: Partial<EntryFilter>): Promise<void>; // 統計下鑽：切清單 → filter＝{ 期間＝period、帳戶＝側欄篩選、…p } → 查
  jumpToEntry(id: string): Promise<void>; // quickJump：關搜尋 → 切清單 → 那筆的月 → 選中並攤開
  /* 路線花費（0-11、0-12） */
  routeSpend: Record<string, { month: number; total: number }>; // route id → 已算好的值；refresh 清空
  loadRouteSpend(routeId: string): Promise<void>; // serial 外（純讀）；已有值就不重查
  /* Ctrl+P「帳目」組（0-19；本線授權乙席加）：全部期間 queryEntries → matchesKeyword → 新到舊取 limit；純讀、不進 serial、不動頁面的 filter／results */
  searchEntries(text: string, limit: number): Promise<EntryRow[]>;

  /* ═══ 第③階段「管帳」（③契約 §3.8；①②的欄位與動作一個都不改） ═══ */

  /* 預算（0-10、0-11） */
  budgets: BudgetRow[]; // warm／refresh 重讀（未刪；含預設與所有月的覆寫）
  budgetLines: BudgetLine[] | null; // 月模式統計：budgetLines(budgets, statsEntries, period.key, categories, today, ctx)；年模式 null；已篩帳戶 null
  overDay: string | null; // refresh：overBudgetDay(本月 entries, effectiveBudget(total, month))（月曆「超」格；已篩帳戶 null）
  setBudget(scope: BudgetScope, month: string | null, amountText: string): Promise<boolean>; // parseAmount（主幣別、不允許負與 0）→ repo → refresh；失敗 toast
  removeBudget(scope: BudgetScope, month: string | null): Promise<void>;
  /* 定期帳（0-6～0-8） */
  repeats: RepeatRow[]; // warm／refresh 重讀（含暫停）
  repeatBlocked: Record<string, string>; // 上次實體化被擋的規則 id → 原因（記憶體）
  repeatDraft: RepeatDraft | null; // dialog.kind === "repeat" 時
  openRepeatEditor(id: string | null, seed?: Partial<RepeatDraft>): void; // id ⇒ 從列建草稿；null ⇒ 預設（expense、defaultAccountId、每月今天的日號、start 今天、09:00）
  /** 規則編輯器的「取消」／Esc（Stage 0 加）：從管理頁開的回管理頁，從大票「設成定期…」開的直接關 */
  closeRepeatEditor(): void;
  setRepeatDraft(patch: Partial<RepeatDraft>): void;
  saveRepeatDraft(): Promise<boolean>; // draftToRepeatInput → create／update →（新建且有 fromEntryId ⇒ linkEntryToRepeat）→ 實體化一次 → refresh → toast「已設定期：每月 1 日 · 房租」
  pauseRepeat(id: string): Promise<void>;
  resumeRepeat(id: string): Promise<void>;
  skipNextRepeat(id: string): Promise<void>; // 提前跳過下一班（D-票-82）＋ toast「復原」
  unskipRepeat(id: string, day: string): Promise<void>; // 取消跳過（管理頁「已跳過 11/1」與 toast 的復原共用）
  deleteRepeat(id: string): Promise<void>; // 軟刪＋toast「已刪除這條規則」帶「復原」
  makeRepeatFromEntry(id: string): void; // 大票「設成定期…」：seed＝那筆（ruleFromEntry）＋ fromEntryId ⇒ openRepeatEditor(null, seed)
  materialize(reason: "startup" | "afterPull" | "day" | "manual"): Promise<void>; // serial(repo.materializeRepeats(today(), dayStart())) → 有插入或補刪 ⇒ refresh；blocked 寫進 repeatBlocked；④：記出來的每筆帶規則的荷札

  /* ═══ 售票口④（契約 §1～§6；Stage 0 資料席。①②③的欄位與動作語義不變，只加） ═══ */

  /** 帳的資料變了幾次（refresh、實體化各 +1）；今日頁的定期提示拿它當重查的依據 */
  entriesVersion: number;

  /* 記一筆的「定期」（D-票-66） */
  /** 點「不重複｜每日｜每週｜每月」：星期幾／幾號從草稿的記帳日帶，結束日保留 */
  setDraftRepeat(freq: RepeatQuickFreq): void;
  /** 既有帳「不重複　設成定期…」那列的快設：沒連規則的帳直接從這筆建規則（從下一班起、帶這筆的荷札）、不開編輯器；已連規則 ⇒ 不動、回 false */
  setEntryRepeatQuick(entryId: string, quick: RepeatQuick): Promise<boolean>;
  /** 今日頁提示（D-票-72）：那天由定期規則記出來、還在的帳（isRepeatMade）。dayKey＝日界線日＝帳的 occurred_on（同一口徑，不換算） */
  repeatEntriesOn(dayKey: string): Promise<EntryRow[]>;
  /** 今日頁點「定期 N 筆」（代驗 O5）：選中並攤開那天第一筆定期帳（jumpToEntry）；那天已經沒有 ⇒ 退回 jumpToDay */
  jumpToRepeatDay(dayKey: string): Promise<void>;

  /* 定期帳規則的荷札（代驗 G1；ticket:repeat） */
  /**
   * 規則編輯器的荷札草稿：names＝畫面上的、orig＝打開時讀到的（改過沒＝兩者比）。openRepeatEditor 時讀：
   * 改既有規則＝它現在掛的；從帳「設成定期…」＝那筆帳的；全新＝空。null＝還在讀或讀不到（荷札列不畫、存檔不動規則的荷札）。
   * 存規則時整份寫進 ticket:repeat（在實體化之前：當場補記的就帶新的）；已經記出來的帳不追溯。
   */
  repeatTags: { names: string[]; orig: string[] } | null;
  setRepeatTags(names: string[]): void;

  /* 備註記憶（D-票-70、71） */
  /** 候選（自己所有還在的帳的備註；次數＋最近一次）；null＝還沒載。存檔／刪除／同步後（refresh）背景重載 */
  noteRecall: RecallItem[] | null;
  /** 第一次聚焦備註欄時叫；已載就不動 */
  loadNoteRecall(): Promise<void>;
  /** 選了以前的備註：同 kind 上次那筆的分類（還在、沒封存、不是未分類）；沒有＝null。呼叫端只在分類還空著時帶 */
  lastCategoryForNote(kind: CategoryKind, text: string): string | null;

  /* 常用票種（D-票-68） */
  templates: TemplateRow[]; // warm／refresh 重讀；position 順序
  /** 點小卡：整張填進草稿（類型、金額、帳戶、分類、備註、路線、荷札）；沒開草稿就開一張。帳戶／分類已不在就不填那欄 */
  applyTemplate(id: string): Promise<void>;
  /** 帳目詳情「存成常用…」：整筆照抄＋荷札；toast「已存成常用「午餐」」；dialog 是 saveTemplate 就關掉。失敗 toast、回 null */
  saveTemplateFromEntry(entryId: string, name: string): Promise<TemplateRow | null>;
  renameTemplate(id: string, name: string): Promise<void>;
  /** 軟刪＋toast「已刪除這個常用票種」帶「復原」 */
  deleteTemplate(id: string): Promise<void>;
  moveTemplateTo(id: string, index: number): Promise<void>;

  /* 願望清單（D-票-69） */
  wishes: WishRow[]; // 未刪（含已買）
  /** 派生：想買（position 順序）／已買（那筆的日期新到舊、實際花了多少）／合計 */
  wish: WishView;
  /** 頂端那列直接加（排在想買最上面）；amountText 空＝沒估（主幣別）；tags 掛 'ticket:wish'。失敗 toast、回 null */
  createWish(input: { name: string; amountText: string; note?: string; categoryId?: string | null; tags?: string[]; kindId?: string }): Promise<WishRow | null>;
  updateWish(id: string, patch: { name?: string; amountText?: string; note?: string; categoryId?: string | null; kindId?: string }): Promise<void>;
  /** 軟刪＋toast「已刪除這個願望」帶「復原」 */
  deleteWish(id: string): Promise<void>;
  /** 在「等候」那一組裡搬到第 index 個（拖曳） */
  moveWishTo(id: string, index: number): Promise<void>;
  /** 「記一筆」實現：開記一筆（支出、金額＝預估、備註＝名稱、分類、願望的荷札、wishId）；存了那一項移到實現了。桌機在售票口頁開；候車室頁先跳售票口再叫它 */
  buyWish(id: string): Promise<void>;
  /** 其他動作的實現（壬 D-主-520）：target＝開出的記錄（null＝清掉回到等候）；呼叫端自己建記錄、帶荷札 */
  setWishTarget(id: string, target: { kind: WishTargetKind; id: string } | null): Promise<void>;

  /* 候車室種類（番線；wr_kinds，D-主-519） */
  wishKinds: WishKindRow[]; // 未刪、position（＝番線）順序
  /** 失敗 toast、回 null */
  createWishKind(input: { name: string; action: WishAction }): Promise<WishKindRow | null>;
  updateWishKind(id: string, patch: { name?: string; action?: WishAction }): Promise<void>;
  /** 還有願望掛著會失敗（toast 說明）；刪成了 toast 帶「復原」 */
  deleteWishKind(id: string): Promise<void>;
  moveWishKindTo(id: string, index: number): Promise<void>;

  /* 帳戶與分類拖曳（契約 §5）：搬到第 index 個（0 起算；群組內／同層）。上下移照舊 moveAccount／moveCategory */
  moveAccountTo(id: string, index: number): Promise<void>;
  moveCategoryTo(id: string, index: number): Promise<void>;

  /* ═══ 售票口④ 第二輪（Stage 0 資料席） ═══ */
  /**
   * 「移到…」換上層、拖曳換歸屬（D-票-78）：parentId null＝頂層；index＝在新那一層排第幾（省略＝最後）。
   * 不能移（防環、別 kind、未分類、封存）⇒ toast 原因、回 false。能不能移由 UI 先用 domain 的 `moveUnderError` 判斷（灰掉目標）
   */
  moveCategoryUnder(id: string, parentId: string | null, index?: number): Promise<boolean>;
  /** 帳戶頁（D-票-79）每個帳戶（含封存）的卡片數字；`setView("accounts")` 時載，之後每次 refresh 重算；沒載過＝null */
  accountCards: Record<string, AccountCard> | null;
}

export const TK_TEXT = {
  saved: (amount: string, label: string, account: string) => `已記 ${amount} ${label} · ${account}`, // §5.7
  savedTransfer: (amount: string, from: string, to: string) => `已記 ⇄ ${amount} ${from} → ${to}`, // 0-33
  pendingCat: "（分類待補）", // §5.7
  undo: "復原",
  deleted: "已刪除這一筆", // 0-33
  adjusted: (signed: string) => `已精算 ${signed}`, // §5.7
  adjustSame: "餘額沒有變", // 0-33
  adjustNote: "餘額調整",
  openingNote: "初始餘額",
  archiveTitle: (name: string) => `要封存「${name}」嗎？`, // §5.7 拆成標題＋內文
  archiveBody: "封存後仍會算進總額，也能從清單篩選出來。",
  archiveConfirm: "封存",
  discardTitle: "放棄這一筆？",
  discardConfirm: "放棄",
  saveFail: "存檔失敗——請再試一次", // RangeError 改吐 message
  destBase: "售票口",
  /* 第②階段（②契約 §3.4、§5.5）：字串本體在 domain 的 VIEW_TEXT（純函式也要用同一份） */
  found: VIEW_TEXT.found,
  noDay: VIEW_TEXT.noDay,
  spend: VIEW_TEXT.spend,
  spendDetail: VIEW_TEXT.spendDetail,
  noRoute: VIEW_TEXT.noRoute,
  routeGone: VIEW_TEXT.routeGone,
  catGone: VIEW_TEXT.catGone,
  accGone: VIEW_TEXT.accGone,
  unsplit: VIEW_TEXT.unsplit,
  refunds: VIEW_TEXT.refunds,
  emptyStats: VIEW_TEXT.emptyStats,
  emptyResults: VIEW_TEXT.emptyResults,
  /* 第③階段（③契約 §3.8、§5.7） */
  budgetSet: (label: string, amt: string) => `已設 ${label} 預算 ${amt}`,
  budgetSetMonth: (label: string, m: number, amt: string) => `已設 ${label} ${m} 月預算 ${amt}`, // 修正-資料：設單月覆寫（評審）
  budgetRemoved: "已刪除這個預算",
  budgetMonthCleared: (m: number) => `已還原 ${m} 月的單月設定`, // 修正-資料：清單月覆寫不是刪預算（評審）
  repeatSaved: (desc: string) => `已設定期：${desc}`,
  repeatSavedFilled: (n: number) => ` · 補記了 ${n} 筆`, // Stage 0 加：存規則時起算日在過去、當場補記的筆數（接在 repeatSaved 後面）
  repeatDeleted: "已刪除這筆定期帳",
  repeatPaused: "已暫停",
  repeatResumed: "已開始，明天起算",
  repeatResumedNext: (d: string) => `已開始，下一班 ${d}`, // 修正-資料：直接帶下一班（每週規則不一定是明天；評審 nit）
  repeatSkipped: (d: string, next: string | null) => (next ? `已跳過 ${d}，下一班 ${next}` : `已跳過 ${d}，之後沒有班了`), // D-票-82
  repeatBlocked: (why: string) => `這筆定期帳無法入帳：${why}`,
  materialized: (n: number) => `定期帳記了 ${n} 筆`,
  budgetAllAccounts: "預算看全部帳戶",
  /* 售票口④ */
  savedRepeat: (label: string) => ` · 定期：${label}`, // 接在 saved 後面（記一筆時順便設了定期）
  savedWish: " · 已移到「已買」", // 接在 saved 後面（從願望「買了」記的）
  tagsFail: "荷札沒掛上——帳已經記好了，可以在詳情再掛一次",
  repeatFail: "定期沒設上——帳已經記好了，可以在詳情再設一次", // 記一筆時順便設定期、規則那一步失敗
  repeatTagsFail: "荷札沒掛上——定期帳已經存好了，可以再打開改一次", // 規則編輯器存檔、荷札那一步失敗
  wishFail: "帳已經記好了，但願望沒移到「已買」（可能已經刪了）",
  templateSaved: (name: string) => `已存成常用「${name}」`,
  templateDeleted: "已刪除這個常用票種",
  wishDeleted: "已刪除這個願望",
  kindDeleted: "已刪除這個種類",
  wishHead: AIDS_TEXT.wishHead,
  boughtHead: AIDS_TEXT.boughtHead,
} as const;

/* ───────── §3.8.3 常數與模組層狀態 ───────── */

export const RECENT_LIMIT = 8;
/** 搜尋結果排序的本機設定鍵（手機加 `_mobile`；不同步） */
export const KEY_RESULT_SORT = "ticket_result_sort";
/**
 * 己-2「記住上次」（D-主-416～418）：本機設定鍵，不同步（不進 manifest syncSettingsKeys）。前四個手機加 `_mobile`（兩殼各記，同 KEY_RESULT_SORT）。
 * 冷啟動第一次 init 讀回來套上（之後換殼、資料整批換掉都不再套——不在用到一半時把畫面跳走）。
 */
export const KEY_TICKET_VIEW = "ticket_view"; // B5：清單／月曆／統計／帳戶／願望
export const KEY_STATS_SPAN = "ticket_stats_span"; // B1：統計的期間 月／年
export const KEY_STATS_FACET = "ticket_stats_facet"; // B1：切面 分類／帳戶／路線／荷札（讀回過 facetAllowed）
export const KEY_STATS_KIND = "ticket_stats_kind"; // B1：收支 支出／收入
/** B2：轉帳的轉入帳戶記憶（JSON，domain/ticketPrefs 的 TransferMemo）；一台一份、不分殼——帳戶是同一批 */
export const KEY_TRANSFER_TO = "ticket_transfer_to";
export const DEFAULT_KIND = "expense" as const;
/** serial 佇列：寫入、refresh 不交錯 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

let warmPromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;
let lastShell: TicketShell = "desktop";
/** 己-2：「記住上次」已經讀回來套過了沒（只套一次）；套完之後視圖一變就寫（見檔尾的訂閱） */
let prefsApplied = false;
/** 己-2 B2：轉入帳戶記憶（warm 時讀一次，存轉帳時更新並寫回） */
let transferMemo: TransferMemo = {};
const prefKey = (k: string, shell: TicketShell): string => (shell === "mobile" ? `${k}_mobile` : k);
const savePref = (k: string, v: string): void => void settingsRepo.set(prefKey(k, lastShell), v).catch(() => undefined);
/** 路線花費的世代：refresh 清空 routeSpend 時 +1，舊世代還在路上的查詢結果丟掉（不把寫入前的數字蓋回去） */
let routeSpendGen = 0;
/** routeSpend 目前算的是哪個月的「本月」（跨月時 loadRouteSpend 把整批作廢重查） */
let routeSpendMonth = "";
const routeSpendInflight = new Set<string>();
/** 第③階段：規則編輯器從哪裡開的（「取消」回去的地方；管理頁＝repeats、大票＝null） */
let repeatBack: TicketDialog | null = null;
/** 規則編輯器荷札的讀取世代：每次打開 +1，讀回來時世代不同（已關、又開了別條）就丟掉 */
let repeatTagGen = 0;

/* ───────── 售票口④ 的模組層狀態與荷札工具 ───────── */

/** 本機經 tagRepo 寫過售票口的荷札、還沒重載 index（refresh 開頭看；同時刻表⑥ 的 blockTagsWritten） */
let ticketTagsWritten = false;
/** 備註歷史（listNoteUses 的原始列；lastCategoryForNote 查表用）；null＝沒載 */
let noteUses: NoteUse[] | null = null;
/** 備註記憶的世代：作廢時 +1，舊世代還在路上的結果丟掉 */
let noteGen = 0;

/** setTags 的收據有沒有真的寫（空收據＝本來就是這樣） */
function receiptWrote(r: { createdTagIds: string[]; createdTaggingIds: string[]; tagsBefore: unknown[]; taggingsBefore: unknown[] }): boolean {
  return r.createdTagIds.length > 0 || r.createdTaggingIds.length > 0 || r.tagsBefore.length > 0 || r.taggingsBefore.length > 0;
}

/** 整份換掉某個售票口實體的荷札（名稱已 cleanTagNames 過）；寫了就記一筆「index 要重載」。失敗往上丟 */
async function writeTags(type: TicketTagType, id: string, names: readonly string[]): Promise<void> {
  const r = await tagRepo.setTags(type, id, names);
  if (receiptWrote(r.receipt)) ticketTagsWritten = true;
}

/** 某個售票口實體現在掛的荷札名稱（直接問 repository：index 可能還沒載或還沒重載） */
async function tagNamesFor(type: TicketTagType, id: string): Promise<string[]> {
  return (await tagRepo.listTagsOf(type, id)).map((t) => t.name);
}

/** 篩選／統計要用荷札時先確定 index 載過（荷札頁沒開過時是 null） */
async function ensureTagIndex(): Promise<void> {
  const ts = useTagStore.getState();
  if (!ts.index) await ts.loadIndex();
}

/** refresh 開頭：本機寫過荷札而且 index 已經載過 ⇒ 重載（沒載過的留給要用的人第一次載） */
async function syncTagIndex(): Promise<void> {
  if (!ticketTagsWritten) return;
  ticketTagsWritten = false;
  const ts = useTagStore.getState();
  if (ts.index) await ts.loadIndex();
}

/** 看帳的荷札情境（ViewCtx 的 entryTags／tagName；index 沒載＝都沒掛） */
function tagCtx(): { entryTags: Record<string, string[]>; tagName: (key: string) => string } {
  const idx = useTagStore.getState().index;
  return { entryTags: entityTagMap(idx, TK_TAG_ENTRY), tagName: tagNameOf(idx) };
}

const isUnfilterableKey = (k: string | null | undefined): boolean => k === GONE_KEY || k === UNSPLIT_KEY || k === NO_TAG_KEY;

const dayStart = (): number => useUiStore.getState().dayStartHour;
const today = (): string => todayKey(dayStart());
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const toast = (message: string, actionLabel?: string, onAction?: () => void): void =>
  useUiStore.getState().showToast(actionLabel ? { message, actionLabel, onAction } : { message });

function failToast(e: unknown): void {
  toast(e instanceof RangeError ? e.message : TK_TEXT.saveFail);
}

const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

function byId<T extends { id: string }>(rows: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const r of rows) out[r.id] = r;
  return out;
}

function byCode(rows: readonly CurrencyRow[]): Record<string, CurrencyRow> {
  const out: Record<string, CurrencyRow> = {};
  for (const r of rows) out[r.code] = r;
  return out;
}

/**
 * 新票草稿的分類基線：openNew 時是 null；「存並繼續」後＝留下來的分類（0-6「留帳戶分類」）——
 * 那是系統代填的預設值，不是主人輸入的內容，取消時不該為它問「放棄這一筆？」
 */
let draftBaseCategoryId: string | null = null;

function draftHasContent(d: TicketDraft | null): boolean {
  if (!d) return false;
  return (
    d.amountText.trim() !== "" ||
    d.note.trim() !== "" ||
    d.categoryId !== draftBaseCategoryId ||
    d.mainOverrideText !== null ||
    d.toAmountText !== null ||
    d.tags.length > 0 || // 售票口④
    d.repeat.freq !== "none"
  );
}

export const useTicketStore = create<TicketStore>((set, get) => {
  /** 帳戶／分類／幣別＋上一筆帳戶＋最近分類（warm 與 refresh 共用） */
  async function loadMeta(): Promise<void> {
    const [currencies, accounts, categories, lastAccountId, rin, rex, usage] = await Promise.all([
      ticketRepo.listCurrencies(),
      ticketRepo.listAccounts(),
      ticketRepo.listCategories(),
      ticketRepo.lastUsedAccountId(),
      ticketRepo.recentCategoryIds("income", RECENT_LIMIT),
      ticketRepo.recentCategoryIds("expense", RECENT_LIMIT),
      ticketRepo.usageSince(addDays(today(), 1 - USAGE_DAYS)), // 含今天共 30 天（日界線日）
    ]);
    const kindOf = byId(categories);
    // 任何一層上層封存了的分類在完整分類樹裡看不到（categoryForest 連整棵藏起來）⇒「常用」也不列，免得列得到卻找不到（D-票-63、78）
    const hiddenUnderArchived = (id: string): boolean => {
      const c = kindOf[id];
      return !!c && categoryArchivedUp(c, kindOf);
    };
    const usedBy = (k: CategoryKind) => usage.categories.filter((u) => kindOf[u.id]?.kind === k && !hiddenUnderArchived(u.id));
    const recentOf = (ids: string[]) => ids.filter((id) => !hiddenUnderArchived(id));
    set({
      currencies,
      curByCode: byCode(currencies),
      accounts,
      accById: byId(accounts),
      categories,
      catById: byId(categories),
      lastAccountId,
      recent: { income: rin, expense: rex },
      frequent: {
        income: frequentCategoryIds(usedBy("income"), recentOf(rin)),
        expense: frequentCategoryIds(usedBy("expense"), recentOf(rex)),
        accounts: frequentAccountIds(usage.accounts, accounts),
      },
    });
    // 統計的根已不在（同步刪掉）⇒ 回全部分類
    const root = get().statsRoot;
    if (root !== null && !kindOf[root]) set({ statsRoot: null, drill: null });
  }

  /** domain 要的情境（含封存；store 的列都是未刪的） */
  function entryCtx(): EntryCtx {
    const s = get();
    return { accById: s.accById, catById: s.catById, curByCode: s.curByCode };
  }

  function decimalsOf(code: string): number {
    return get().curByCode[code]?.decimals ?? 2;
  }

  /** 寫入共用殼：serial → refresh → 成功回呼；失敗 toast */
  async function write<T>(fn: () => Promise<T>, after?: (r: T) => void): Promise<boolean> {
    try {
      const r = await serial(fn);
      await serial(() => get().refresh());
      after?.(r);
      return true;
    } catch (e) {
      failToast(e);
      return false;
    }
  }

  /** 存檔 toast 的全文（§5.7、0-33） */
  function savedText(row: EntryRow): string {
    const s = get();
    const dec = decimalsOf(row.currency);
    const acc = s.accById[row.account_id]?.name ?? "";
    if (row.kind === "transfer") {
      const to = row.to_account_id ? (s.accById[row.to_account_id]?.name ?? "") : "";
      return TK_TEXT.savedTransfer(moneyText(row.amount_minor, dec), acc, to);
    }
    const cur = s.curByCode[row.currency];
    const amount = quickAmountText(row.kind, row.amount_minor, dec) + (cur && cur.is_main !== 1 ? ` ${row.currency}` : "");
    const cat = row.category_id ? s.catById[row.category_id] : undefined;
    const label = cat && !isUncat(cat.id) ? bareName(cat.name) : row.note ? Array.from(row.note).slice(0, 12).join("") : UNCAT_NAME;
    return TK_TEXT.saved(amount, label, acc);
  }

  /** 看帳的情境：entryCtx＋路線（nodeStore.routes，側欄順序）＋荷札（售票口④；tagStore.index，沒載＝都沒掛） */
  function viewCtx(): ViewCtx {
    return { ...entryCtx(), ...routeCtx(useNodeStore.getState().routes), ...tagCtx() };
  }

  /** 從 statsEntries 重算 stats（純函式；不讀 repo） */
  function computeStats(): StatsData {
    const s = get();
    const r = periodRange(s.period);
    return {
      period: s.period,
      overview: statsOverview(s.statsEntries, r),
      trend: monthlyTrend(s.statsEntries, trendMonths(s.period)),
      breakdown: breakdown(s.statsEntries, r, facetAllowed(s.facet, s.filterAccountId), s.facetKind, viewCtx(), { catRoot: s.statsRoot }),
    };
  }

  /** 帳戶頁：讀走勢第一個月起到最後的帳（全部帳戶、一次），配現在的餘額算每張卡。不排隊：呼叫端在 serial 裡（refresh 內）或包 serial */
  async function loadAccountCards(): Promise<void> {
    const month = monthOf(today());
    const r = accountsRange(month);
    const entries = await ticketRepo.listEntries(r.from, r.toExcl, null);
    const s = get();
    set({ accountCards: accountCards(s.accounts, s.balances, entries, month) });
  }

  /** 讀 trendRange(period) 的帳＋重算 stats。不排隊：呼叫端在 serial 裡（refresh 內）或包 serial */
  async function loadStats(): Promise<void> {
    const s = get();
    const r = trendRange(s.period);
    const statsEntries = await ticketRepo.listEntries(r.from, r.toExcl, s.filterAccountId);
    set({ statsEntries });
    set({ stats: computeStats(), budgetLines: computeBudgetLines() });
  }

  /** 月曆格（只用 month 那個月的帳；本月外的格空著） */
  function computeCalendar(entries: readonly EntryRow[], month: string): CalendarCell[][] {
    const own = entries.filter((e) => monthOf(e.occurred_on) === month);
    return calendarCells(own, month, useUiStore.getState().weekStart, today());
  }

  /** 依 filter 查 results（不排隊：呼叫端在 serial 裡）；filter 不作用 ⇒ 清掉 */
  async function runQuery(): Promise<void> {
    const f = get().filter;
    if (!isFilterActive(f)) {
      set({ results: null, resultDays: [] });
      return;
    }
    // 側欄選了帳戶（0-10：三個視圖都只看該帳戶）⇒ 搜尋沒自己指定帳戶時沿用它；不放進 filter（不出 chip、文字清空就回一般清單）
    const rows = await ticketRepo.queryEntries(filterToQuery(f.accountId === null ? { ...f, accountId: get().filterAccountId } : f, get().categories));
    const tokens = keywordTokens(f.text);
    // 售票口④：篩荷札、或關鍵字要比對荷札名 ⇒ 先確定荷札 index 載過（載不到就當都沒掛，不擋搜尋）
    const tagKeys = f.tagKeys ?? [];
    if (tagKeys.length > 0 || tokens.length > 0) await ensureTagIndex().catch(() => undefined);
    if (get().filter !== f) return; // 查的途中 filter 又變了：讓排在後面的那一次寫
    const ctx = viewCtx();
    setResults(rows.filter((e) => matchesKeyword(e, tokens, ctx) && matchesTagFilter(e, tagKeys, ctx)), get().resultSort);
  }

  /** 結果依 sort 排好寫進 store；日期排序按日分組（舊到新＝groupByDay 依輸入順序開組），金額排序是平面清單 */
  function setResults(list: readonly EntryRow[], sort: EntrySort): void {
    const results = sortEntries(list, sort);
    set({ results, resultDays: isAmountSort(sort) ? [] : groupByDay(results, get().filterAccountId) });
  }

  /** 排序的本機鍵（手機另記；不同步、不進 manifest，前例 timetableGridStore） */
  const sortKey = (shell: TicketShell): string => (shell === "mobile" ? `${KEY_RESULT_SORT}_mobile` : KEY_RESULT_SORT);
  /** 已讀過哪個殼的鍵（null＝還沒讀） */
  let sortLoadedShell: TicketShell | null = null;
  /** 讀的途中使用者先選了排序 ⇒ 讀回來的舊值不蓋掉它 */
  let sortChangedWhileLoading = false;

  async function loadResultSort(shell: TicketShell): Promise<void> {
    if (sortLoadedShell === shell) return;
    sortLoadedShell = shell;
    sortChangedWhileLoading = false;
    let sort: EntrySort = DEFAULT_ENTRY_SORT;
    try {
      sort = parseEntrySort(await settingsRepo.get(sortKey(shell)));
    } catch {
      /* 本機鍵讀不到就用預設（日期・新到舊） */
    }
    if (sortChangedWhileLoading || sort === get().resultSort) return;
    set({ resultSort: sort });
    const r = get().results;
    if (r) setResults(r, sort);
  }

  /** 己-2 B1／B5：讀這個殼上次的視圖與統計設定（讀不到＝全用預設，跟沒記過一樣） */
  async function readPrefs(shell: TicketShell): Promise<{ view: TicketView; span: StatsSpan; facet: Facet; facetKind: "expense" | "income" }> {
    const get1 = (k: string) => settingsRepo.get(prefKey(k, shell)).catch(() => null);
    const [view, span, facet, kind] = await Promise.all([get1(KEY_TICKET_VIEW), get1(KEY_STATS_SPAN), get1(KEY_STATS_FACET), get1(KEY_STATS_KIND)]);
    return { view: parseTicketView(view), span: parseStatsSpan(span), facet: parseFacet(facet), facetKind: parseFacetKind(kind) };
  }

  /** 己-2 B2：新轉帳的轉入帳戶——草稿是轉帳、還沒挑轉入時，照記憶猜一個 */
  function withGuessedTo(d: TicketDraft): TicketDraft {
    if (d.kind !== "transfer" || d.toAccountId !== null) return d;
    const to = guessTransferTo(transferMemo, d.accountId, get().accById);
    return to ? { ...d, toAccountId: to } : d;
  }

  /* ───────── 第③階段的內部工具（③契約 §3.8） ───────── */

  /**
   * 預算＋規則（warm 與 refresh 共用）。讀不到（例：Stage 0 的 SQLite 骨架）只 console.warn、保留舊值——
   * 第③階段的表讀不到不准拖垮①②的帳本。
   */
  async function loadPlan(): Promise<void> {
    try {
      const [budgets, repeats] = await Promise.all([ticketRepo.listBudgets(), ticketRepo.listRepeats()]);
      set({ budgets, repeats });
    } catch (e) {
      console.warn("[ticket] 讀預算／定期帳失敗", e);
    }
  }

  /** 月模式、沒篩帳戶才有（✎-2、✎-11）；資料＝statsEntries（trendRange 涵蓋 period 那個月，0-11） */
  function computeBudgetLines(): BudgetLine[] | null {
    const s = get();
    if (s.span !== "month" || s.filterAccountId !== null) return null;
    return budgetLines(s.budgets, s.statsEntries, s.period.key, s.categories, today(), entryCtx());
  }

  /** 月曆「超」格（✎-6）：本月總預算被超過的那一天；已篩帳戶 ⇒ null（預算看全部帳戶） */
  function computeOverDay(entries: readonly EntryRow[], month: string): string | null {
    const s = get();
    if (s.filterAccountId !== null) return null;
    const eff = effectiveBudget(s.budgets, { kind: "total" }, month);
    return overBudgetDay(entries, month, eff ? eff.row.amount_minor : null);
  }

  /** 主幣別（預算一律主幣別，§1-6） */
  function mainCur(): { code: string; decimals: number } {
    const s = get();
    for (const c of s.currencies) if (c.is_main === 1) return { code: c.code, decimals: c.decimals };
    return { code: MAIN_CURRENCY, decimals: s.curByCode[MAIN_CURRENCY]?.decimals ?? 2 };
  }

  function scopeLabel(scope: BudgetScope): string {
    if (scope.kind === "total") return "總預算";
    const c = get().catById[scope.categoryId];
    return c ? bareName(c.name) : "（分類已刪除）";
  }

  /** "2026-10" → 10（覆寫 toast 用） */
  function monthNum(month: string): number {
    return parseInt(month.slice(5, 7), 10);
  }

  /**
   * 使用者正在看售票口頁（實體化的 toast 只在這裡出，§3.8）。
   * 殼看 <html data-shell>（useShell 同步；同 tagStore.isMobileShell）——不看 lastShell：啟動那一次實體化時 init(shell) 還沒跑、
   * lastShell 還是預設的 desktop，手機停在今日頁也會被當成「在售票口」（評審-UI should-3）。
   */
  function onTicketPage(): boolean {
    const ui = useUiStore.getState();
    const mobile = typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile";
    return mobile ? (ui.mobileTab as string) === "ticket" : (ui.page as string) === "ticket";
  }

  /** 規則的一句話（toast 用）：「每月 1 日 · 房租」；轉帳「每月 5 日 · 帳戶 → 悠遊卡」 */
  function repeatDesc(rule: FixedRepeatRule, kind: RepeatRow["kind"], accountId: string, toAccountId: string | null, categoryId: string | null, note: string): string {
    const s = get();
    if (kind === "transfer") {
      return `${describeRule(rule)} · ${s.accById[accountId]?.name ?? ""} → ${toAccountId ? (s.accById[toAccountId]?.name ?? "") : ""}`;
    }
    const cat = categoryId ? s.catById[categoryId] : undefined;
    const label = cat && !isUncat(cat.id) ? bareName(cat.name) : note ? Array.from(note).slice(0, 12).join("") : UNCAT_NAME;
    return `${describeRule(rule)} · ${label}`;
  }

  /**
   * 實體化一次（0-6-3）：serial 裡叫 repo；blocked 寫進 repeatBlocked；有插入或補刪 ⇒ 重讀（ready 才整頁 refresh，否則只重讀規則）。
   * 回插入幾筆；失敗回 null（呼叫端決定要不要出聲）。
   * 售票口④：記出來的每一筆帶規則的荷札（同一個 serial 節裡、refresh 之前）。taggings 的 id＝uuid v5(type|帳 id|荷札 id)，
   * 帳 id 又是 materializeId(規則, 班次日)——兩台各記也是同一列，同步後只有一份。
   */
  async function runMaterialize(): Promise<number | null> {
    try {
      await get().warm();
      const res = await serial(async () => {
        const r = await ticketRepo.materializeRepeats(today(), dayStart());
        await carryRepeatTags(r.rows);
        return r;
      });
      const blocked: Record<string, string> = {};
      for (const b of res.blocked) blocked[b.id] = b.reason;
      set({ repeatBlocked: blocked });
      if (res.inserted > 0 || res.reconciled > 0) {
        if (get().ready) await serial(() => get().refresh());
        else {
          await loadPlan();
          set({ entriesVersion: get().entriesVersion + 1 });
        }
      } else await loadPlan(); // 游標可能推了（沒插入也會推）
      return res.inserted;
    } catch (e) {
      console.warn("[ticket] 定期帳實體化失敗", e);
      return null;
    }
  }

  /* ───────── 售票口④ 的內部工具 ───────── */

  /** 實體化記出來的帳掛上規則的荷札（規則沒掛就不寫）；失敗只 warn——帳已經記好，荷札之後可以在詳情補 */
  async function carryRepeatTags(rows: readonly { id: string; repeat_id: string }[]): Promise<void> {
    if (!rows.length) return;
    const byRepeat = new Map<string, string[]>();
    for (const r of rows) {
      const list = byRepeat.get(r.repeat_id);
      if (list) list.push(r.id);
      else byRepeat.set(r.repeat_id, [r.id]);
    }
    for (const [repeatId, ids] of byRepeat) {
      try {
        const names = await tagNamesFor(TK_TAG_REPEAT, repeatId);
        if (!names.length) continue;
        for (const id of ids) await writeTags(TK_TAG_ENTRY, id, names);
      } catch (e) {
        console.warn("[ticket] 定期帳記出來的帳沒掛上規則的荷札", e);
      }
    }
  }

  /** 願望＋常用票種（warm 與 refresh 共用；讀不到只 warn、保留舊值——同 loadPlan） */
  async function loadAids(): Promise<void> {
    try {
      const [wishes, wishKinds, templates] = await Promise.all([ticketRepo.listWishes(), ticketRepo.listWishKinds(), ticketRepo.listTemplates()]);
      const linked = wishes.filter((w) => w.entry_id !== null).map((w) => w.entry_id as string);
      const entries = linked.length ? await ticketRepo.getEntries(linked) : [];
      // 「實現了沒」看開出的記錄還在不在（壬 D-主-520、521；讀時判斷）
      const refs = wishes
        .filter((w) => w.target_kind !== null && w.target_id !== null)
        .map((w) => ({ target_kind: w.target_kind as NonNullable<WishRow["target_kind"]>, target_id: w.target_id as string }));
      const targets = refs.length ? await ticketRepo.getWishTargets(refs) : {};
      const kindById: Record<string, WishKindRow | undefined> = {};
      for (const k of wishKinds) kindById[k.id] = k;
      set({ wishes, wishKinds, templates, wish: wishView(wishes, byId(entries), targets, kindById) });
    } catch (e) {
      console.warn("[ticket] 讀願望／常用票種失敗", e);
    }
  }

  /** 備註記憶作廢：載過的話背景重載（不擋 refresh；世代對不上的結果丟掉） */
  function invalidateNoteRecall(): void {
    noteGen++;
    if (noteUses === null) return;
    noteUses = null;
    void get().loadNoteRecall();
  }

  /** 草稿的荷札名稱：不合法 ⇒ RangeError「#名稱：理由」（整筆不寫） */
  /** 兩份荷札名稱指的是同一組荷札（比 key、不管順序；名稱已 cleanTagNames 過或是 repository 讀的） */
  function sameNames(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const k = new Set(a.map((x) => keyOf(x) ?? x));
    return b.every((x) => k.has(keyOf(x) ?? x));
  }

  function draftTagNames(names: readonly string[]): string[] {
    const r = cleanTagNames(names);
    if (!r.ok) throw new RangeError(`#${r.name.replace(/^#/, "")}：${r.reason}`);
    return r.names;
  }

  /** 主幣別的金額欄（願望用；空＝null） */
  function mainAmountOrNull(text: string): number | null {
    if (text.trim() === "") return null;
    const main = mainCur();
    return parseAmount(text, main, { allowNegative: false, allowZero: true });
  }

  /** 要拿來寫資料的那一筆：排在寫入佇列後面直接問 repository（畫面快取可能是舊的，例如統計頁載過的那份） */
  function freshEntry(id: string): Promise<EntryRow | null> {
    return serial(() => ticketRepo.getEntry(id));
  }

  return {
    ready: false,
    loading: false,
    error: null,
    currencies: [],
    curByCode: {},
    accounts: [],
    accById: {},
    categories: [],
    catById: {},
    balances: {},
    totals: { asset: 0, liability: 0, net: 0 },
    hasAny: false,
    month: monthOf(todayKey(useUiStore.getState().dayStartHour)),
    loadedMonths: [],
    entries: [],
    days: [],
    monthSum: null,
    filterAccountId: null,
    selectedId: null,
    panel: { kind: "none" },
    draft: null,
    savedAt: null,
    lastAccountId: null,
    recent: { income: [], expense: [] },
    frequent: { income: [], expense: [], accounts: [] },
    dialog: null,
    view: "list",
    span: "month",
    period: periodOf(monthOf(todayKey(useUiStore.getState().dayStartHour)), "month"),
    facet: "category",
    facetKind: "expense",
    drill: null,
    statsRoot: null,
    statsEntries: [],
    stats: null,
    calendar: null,
    pendingDay: null,
    dayNotice: null,
    searchOpen: false,
    filter: EMPTY_FILTER,
    results: null,
    resultDays: [],
    resultSort: DEFAULT_ENTRY_SORT,
    routeSpend: {},
    budgets: [],
    budgetLines: null,
    overDay: null,
    repeats: [],
    repeatBlocked: {},
    repeatDraft: null,
    repeatTags: null,
    entriesVersion: 0,
    noteRecall: null,
    templates: [],
    wishes: [],
    wishKinds: [],
    wish: EMPTY_WISH_VIEW,
    accountCards: null,

    /* ───────── 載入 ───────── */

    warm() {
      if (!warmPromise) {
        warmPromise = (async () => {
          await serial(() => ticketRepo.ensureStarterRows());
          await Promise.all([
            loadMeta(),
            loadPlan(),
            loadAids(),
            // 己-2 B2：轉入帳戶記憶（讀不到＝沒記過）
            settingsRepo.get(KEY_TRANSFER_TO).then(
              (raw) => void (transferMemo = parseTransferMemo(raw)),
              () => undefined,
            ),
          ]); // 第③階段：預算＋規則；④：願望＋常用票種（讀不到都不擋 warm）
        })().catch((e) => {
          warmPromise = null; // 失敗可重試
          throw e;
        });
      }
      return warmPromise;
    },

    init(shell) {
      lastShell = shell;
      void loadResultSort(shell);
      if (!initPromise) {
        initPromise = (async () => {
          set({ loading: true, error: null });
          try {
            await get().warm();
            // 己-2 B1／B5：冷啟動第一次讀回上次的統計設定與視圖（之後的 init——換殼、整批換資料——不再套）
            const prefs = prefsApplied ? null : await readPrefs(shell);
            if (prefs) set({ span: prefs.span, facet: facetAllowed(prefs.facet, get().filterAccountId), facetKind: prefs.facetKind });
            const m = monthOf(today());
            set({ month: m, loadedMonths: [m], period: periodOf(m, get().span) });
            await serial(() => get().refresh());
            // 上次停在別的視圖 ⇒ 照 setView 走一遍（統計、帳戶頁要載自己的資料）；ready 之前切好，進頁不先閃清單
            if (prefs && prefs.view !== "list" && get().view === "list") await get().setView(prefs.view);
            prefsApplied = true;
            if (get().error === null) set({ ready: true });
          } catch (e) {
            set({ error: errText(e) });
            throw e;
          } finally {
            set({ loading: false });
          }
        })().catch((e) => {
          initPromise = null; // 失敗可重試
          throw e;
        });
      }
      return initPromise;
    },

    async refresh() {
      try {
        await syncTagIndex().catch(() => undefined); // 售票口④：本機寫過荷札 ⇒ index 重載（篩選／統計／搜尋用的是它）
        const s0 = get();
        const months = s0.loadedMonths.length ? s0.loadedMonths : [s0.month];
        const filter = s0.filterAccountId;
        const [, , , balances, hasAny, ...lists] = await Promise.all([
          loadMeta(),
          loadPlan(), // 第③階段
          loadAids(), // 售票口④
          ticketRepo.balances(),
          ticketRepo.hasAnyEntry(),
          ...months.map((m) => {
            const r = monthRange(m);
            return ticketRepo.listEntries(r.from, r.toExcl, filter);
          }),
        ]);
        const entries: EntryRow[] = [];
        for (const l of lists as EntryRow[][]) for (const e of l) entries.push(e);
        const s = get();
        const ids = new Set(entries.map((e) => e.id));
        const keepSel = s.selectedId !== null && ids.has(s.selectedId);
        const panelGone = s.panel.kind === "entry" && !ids.has(s.panel.id);
        if (filter !== null && !s.accById[filter]) {
          // 篩選的帳戶被刪了（同步）⇒ 回全部，就地重算一次。refresh 跑在 serial 裡：
          // 不得 await setFilter（它會再排一次 serial、等的正是自己這一節 ⇒ 死結）
          set({ filterAccountId: null });
          await get().refresh();
          return;
        }
        set({
          balances: balances as Record<string, number>,
          totals: accountTotals(s.accounts, balances as Record<string, number>, s.curByCode),
          hasAny: hasAny as boolean,
          entries,
          days: groupByDay(entries, filter),
          monthSum: filter === null ? monthSum(entries, s.month) : null,
          selectedId: keepSel ? s.selectedId : null,
          panel: panelGone ? { kind: "none" } : s.panel,
          error: null,
        });
        // 第②階段（②契約 §3.4）：路線花費作廢重查、月曆重算、統計與搜尋結果跟著重讀（本身已在 serial 裡，不再排隊）
        routeSpendGen++;
        set({ routeSpend: {}, calendar: computeCalendar(entries, get().month) });
        // 第③階段（③契約 §3.8）：月曆「超」格重算；統計預算卡在 loadStats 裡一起算
        set({ overDay: computeOverDay(entries, get().month) });
        if (get().view === "stats") await loadStats();
        if (get().view === "accounts") await loadAccountCards(); // 售票口④ 第二輪：帳戶頁開著才重查（沒開過＝不查）
        if (isFilterActive(get().filter)) await runQuery();
        // 售票口④：帳變了 ⇒ 備註記憶作廢（載過就背景重載）、今日頁的定期提示重查
        invalidateNoteRecall();
        set({ entriesVersion: get().entriesVersion + 1 });
      } catch (e) {
        set({ error: errText(e) });
      }
    },

    async reload(ctx) {
      const touched = ctx.wiped || ctx.changed.some((t) => t.startsWith("tk_"));
      if (!touched) return;
      if (ctx.wiped) {
        set({ panel: { kind: "none" }, draft: null, selectedId: null, dialog: null, filterAccountId: null, ready: false });
        // 第②階段：視圖回清單、搜尋清空、統計與路線花費作廢（②契約 §3.4）
        routeSpendGen++;
        set({
          view: "list", searchOpen: false, filter: EMPTY_FILTER, results: null, resultDays: [], resultSort: DEFAULT_ENTRY_SORT, drill: null, statsRoot: null, accountCards: null,
          statsEntries: [], stats: null, pendingDay: null, dayNotice: null, routeSpend: {},
        });
        // 第③階段：草稿與預算／規則作廢（實體化不在 reload 裡，在 afterPull，③契約 §3.8）
        repeatBack = null;
        repeatTagGen++;
        set({ repeatDraft: null, repeatTags: null, budgets: [], budgetLines: null, overDay: null, repeats: [], repeatBlocked: {} });
        // 售票口④：願望、常用票種、備註記憶作廢
        noteUses = null;
        noteGen++;
        set({ wishes: [], wishKinds: [], templates: [], wish: EMPTY_WISH_VIEW, noteRecall: null });
        warmPromise = null; // 整批換掉：重走 warm（起手三列可能要重種）＋init
        initPromise = null;
        await get().init(lastShell);
        return;
      }
      await serial(() => get().refresh());
      // lastAccountId／recent 也可能變：refresh 內一併重讀
    },

    /* ───────── 月份與清單 ───────── */

    async setMonth(month) {
      set({ month, loadedMonths: [month], period: periodOf(month, get().span) });
      await serial(() => get().refresh());
    },

    async stepMonth(delta) {
      // 第②階段（0-10）：統計「年」模式的 [ ] ＝切年、month 不動；不超過今年
      if (get().view === "stats" && get().span === "year") {
        const p = stepPeriod(get().period, delta);
        if (p.key > today().slice(0, 4)) return;
        set({ period: p, drill: null });
        await serial(loadStats);
        return;
      }
      const next = addMonths(get().month, delta);
      if (next > monthOf(today())) return;
      await get().setMonth(next);
    },

    async loadOlderMonth() {
      const lm = get().loadedMonths;
      const last = lm.length ? lm[lm.length - 1] : get().month;
      set({ loadedMonths: [...(lm.length ? lm : [get().month]), addMonths(last, -1)] });
      await serial(() => get().refresh());
    },

    async setFilter(accountId) {
      set({ filterAccountId: accountId, facet: facetAllowed(get().facet, accountId) }); // 篩帳戶 ⇒「帳戶」切面回分類（0-8）
      await serial(() => get().refresh());
    },

    async cycleFilter() {
      const list = orderAccounts(get().accounts.filter((a) => a.archived_at === null));
      const cur = get().filterAccountId;
      if (!list.length) {
        if (cur !== null) await get().setFilter(null);
        return;
      }
      const i = cur === null ? -1 : list.findIndex((a) => a.id === cur);
      const next = i + 1 < list.length ? list[i + 1].id : null;
      await get().setFilter(next);
    },

    select(id) {
      set(id ? { selectedId: id, panel: { kind: "entry", id }, draft: null, savedAt: null } : { selectedId: null, panel: { kind: "none" }, draft: null });
    },

    moveSelection(delta) {
      const flat: EntryRow[] = [];
      for (const g of get().days) for (const e of g.entries) flat.push(e);
      if (!flat.length) return;
      const cur = get().selectedId;
      const i = cur === null ? -1 : flat.findIndex((e) => e.id === cur);
      if (i < 0) {
        get().select(flat[0].id);
        return;
      }
      const j = i + delta;
      if (j < 0 || j >= flat.length) return;
      get().select(flat[j].id);
    },

    requestEscape() {
      const { panel, draft } = get();
      if (panel.kind === "new" && draftHasContent(draft)) {
        useUiStore.getState().askConfirm({
          title: TK_TEXT.discardTitle,
          confirmLabel: TK_TEXT.discardConfirm,
          onConfirm: () => set({ panel: { kind: "none" }, draft: null }),
        });
        return;
      }
      if (panel.kind === "new") {
        set({ panel: { kind: "none" }, draft: null });
        return;
      }
      set({ panel: { kind: "none" }, selectedId: null, draft: null });
    },

    /* ───────── 記一筆 ───────── */

    openNew(seed) {
      const s = get();
      const accountId = defaultAccountId(s.accounts, s.lastAccountId);
      // 沒有未封存帳戶（又沒指定帳戶）⇒ 先開「新增帳戶」，不開一張帳戶空白的新票（記帳一定要落在某個帳戶上；手機同口徑）；
      // 建好就接著打開記一筆（then.new，createAccount 接手；原本的 seed 一起帶著，鍵盤在某一天按記一筆＝建完還是那一天）
      if (!accountId && !seed?.accountId) {
        set({ dialog: { kind: "newAccount", then: { new: seed ?? {} } } });
        return;
      }
      const currency = (accountId && s.accById[accountId]?.currency) || MAIN_CURRENCY;
      const dayKey = seed?.dayKey ?? today();
      const draft: TicketDraft = {
        kind: DEFAULT_KIND,
        amountText: "",
        currency,
        accountId,
        toAccountId: null,
        categoryId: null,
        dayKey,
        time: localTime(new Date().toISOString()),
        note: "",
        routeId: null,
        mainOverrideText: null,
        toAmountText: null,
        // 售票口④
        tags: [],
        repeat: noRepeat(dayKey),
        wishId: null,
        fromTemplateId: null,
        ...seed,
      };
      draftBaseCategoryId = null;
      set({ panel: { kind: "new" }, draft: withGuessedTo(draft), selectedId: null, savedAt: null });
    },

    setDraft(patch) {
      const s = get();
      if (!s.draft) return;
      const d: TicketDraft = { ...s.draft, ...patch };
      const acc = d.accountId ? s.accById[d.accountId] : undefined;
      if (d.kind === "transfer") {
        d.categoryId = null;
        if (acc) d.currency = acc.currency;
      } else {
        d.toAccountId = null;
        d.toAmountText = null;
        // 換帳戶 ⇒ 幣別跟著換（除非這次一起指定了幣別）
        if (patch.accountId !== undefined && patch.currency === undefined && acc) d.currency = acc.currency;
        // 換收支類型 ⇒ 不同類型的分類清掉
        const cat = d.categoryId ? s.catById[d.categoryId] : undefined;
        if (cat && cat.kind !== d.kind) d.categoryId = null;
      }
      if (patch.currency !== undefined && patch.currency !== s.draft.currency) d.mainOverrideText = patch.mainOverrideText ?? null;
      // 售票口④：改記帳日 ⇒ 定期的星期幾／幾號（沒點改過的）跟著走
      if (patch.dayKey !== undefined && patch.repeat === undefined) d.repeat = quickFollowDay(s.draft.repeat, s.draft.dayKey, d.dayKey);
      // 己-2 B2：切成轉帳、或轉帳換了轉出帳戶時，轉入還空著 ⇒ 照上次猜一個（patch 明說 toAccountId:null＝使用者清掉，不猜）
      const guess = d.kind === "transfer" && patch.toAccountId === undefined && (s.draft.kind !== "transfer" || patch.accountId !== undefined);
      set({ draft: guess ? withGuessedTo(d) : d });
    },

    async saveDraft({ again }) {
      const d = get().draft;
      if (!d) return false;
      try {
        // 先驗完再寫（任何一項不合法 ⇒ 整筆不寫）：帳、荷札名稱、定期規則（從下一班起；同一套 draftToRepeatInput）
        const input = draftToInput(d, entryCtx(), dayStart());
        const names = draftTagNames(d.tags);
        const rd = quickRepeatDraft(d, d.repeat, null);
        const repInput = rd ? draftToRepeatInput(rd, entryCtx()) : null;
        const res = await serial(async () => {
          const row = await ticketRepo.createEntry(input);
          let tagFail = false;
          if (names.length) {
            try {
              await writeTags(TK_TAG_ENTRY, row.id, names);
            } catch (e) {
              console.warn("[ticket] 帳的荷札沒掛上", e);
              tagFail = true;
            }
          }
          // 帳已寫入：之後每一步失敗都只記下來、不往外丟（往外丟＝回報「沒存」、草稿留著，再按一次就重複記帳）
          let repeatId: string | null = null;
          let repeatFail = false;
          if (repInput) {
            let rep: RepeatRow | null = null;
            try {
              rep = await ticketRepo.createRepeat(repInput);
              await ticketRepo.linkEntryToRepeat(row.id, rep.id);
              repeatId = rep.id;
            } catch (e) {
              console.warn("[ticket] 記一筆時的定期規則沒設上", e);
              repeatFail = true;
              // 規則建了卻沒連上 ⇒ 收回，不留一條使用者不知道、會一直記帳的規則
              if (rep) await ticketRepo.softDeleteRepeat(rep.id).catch((err) => console.warn("[ticket] 收回沒連上的規則失敗", err));
            }
            if (repeatId && names.length) {
              try {
                await writeTags(TK_TAG_REPEAT, repeatId, names);
              } catch (e) {
                console.warn("[ticket] 定期帳規則的荷札沒掛上", e);
                tagFail = true;
              }
            }
          }
          let wishFail = false;
          if (d.wishId) {
            try {
              await ticketRepo.setWishBought(d.wishId, row.id);
            } catch (e) {
              console.warn("[ticket] 願望沒移到已買（可能已經刪了）", e);
              wishFail = true;
            }
          }
          return { row, repeatId, tagFail, repeatFail, wishFail };
        });
        const row = res.row;
        set({ lastAccountId: row.kind === "adjust" ? get().lastAccountId : row.account_id, hasAny: true });
        // 己-2 B2：記下這次轉進哪（下一筆從同一個帳戶轉出就預填它）
        if (row.kind === "transfer" && row.to_account_id) {
          transferMemo = rememberTransfer(transferMemo, row.account_id, row.to_account_id);
          void settingsRepo.set(KEY_TRANSFER_TO, JSON.stringify(transferMemo)).catch(() => undefined);
        }
        if (again) {
          draftBaseCategoryId = d.categoryId;
          set({
            draft: {
              ...d,
              amountText: "",
              note: "",
              mainOverrideText: null,
              toAmountText: null,
              tags: [],
              repeat: noRepeat(d.dayKey),
              wishId: null,
              fromTemplateId: null,
            },
          });
        } else {
          const m = monthOf(row.occurred_on);
          if (get().loadedMonths.indexOf(m) < 0) set({ month: m, loadedMonths: [m], period: periodOf(m, get().span) }); // 換月一律連 period 一起換（同 setMonth）
          set({ draft: null, selectedId: row.id, panel: { kind: "entry", id: row.id }, savedAt: null });
        }
        // 有定期：起算是記帳日隔天，記帳日在過去就當場補記（同 saveRepeatDraft）；runMaterialize 自己會 refresh
        const filled = res.repeatId ? await runMaterialize() : null;
        await serial(() => get().refresh());
        if (res.repeatFail) toast(TK_TEXT.repeatFail);
        else if (res.tagFail) toast(TK_TEXT.tagsFail);
        else if (res.wishFail) toast(TK_TEXT.wishFail);
        else {
          let text = savedText(row);
          if (res.repeatId) text += TK_TEXT.savedRepeat(quickRepeatLabel(d.repeat)) + (filled ? TK_TEXT.repeatSavedFilled(filled) : "");
          if (d.wishId) text += TK_TEXT.savedWish;
          const repeatId = res.repeatId;
          toast(text, TK_TEXT.undo, () => {
            void (async () => {
              try {
                // 復原＝刪這筆（願望讀的時候就回到想買）＋刪剛建的規則（補記的那幾筆一起刪）
                await serial(async () => {
                  await ticketRepo.softDeleteEntry(row.id);
                  if (repeatId) {
                    // 先刪規則再刪補記的帳：規則已刪 ⇒ 那幾天不會被記進 skipped_days（touchSkipped 只碰還在的規則）
                    await ticketRepo.softDeleteRepeat(repeatId);
                    if (filled) {
                      for (const e of await ticketRepo.listEntries(addDays(row.occurred_on, 1), addDays(today(), 1), null)) {
                        if (e.repeat_id === repeatId && isRepeatMade(e)) await ticketRepo.softDeleteEntry(e.id);
                      }
                    }
                  }
                });
                await serial(() => get().refresh());
              } catch (e) {
                failToast(e);
              }
            })();
          });
        }
        return true;
      } catch (e) {
        failToast(e);
        return false;
      }
    },

    openEntry(id) {
      set({ selectedId: id, panel: { kind: "entry", id }, draft: null, savedAt: null });
    },

    openAccount(id) {
      set({ panel: { kind: "account", id }, draft: null });
    },

    closePanel() {
      set({ panel: { kind: "none" }, draft: null });
    },

    async updateEntry(id, patch) {
      await write(
        () => ticketRepo.updateEntry(id, patch),
        () => set({ savedAt: Date.now() }),
      );
    },

    async deleteEntry(id) {
      await write(
        async () => {
          await ticketRepo.softDeleteEntry(id);
          if (get().selectedId === id || (get().panel.kind === "entry" && (get().panel as { id: string }).id === id)) {
            set({ selectedId: null, panel: { kind: "none" } });
          }
        },
        () =>
          toast(TK_TEXT.deleted, TK_TEXT.undo, () => {
            void write(() => ticketRepo.restoreEntry(id));
          }),
      );
    },

    /* ───────── 帳戶 ───────── */

    async createAccount(input) {
      try {
        const cur = get().curByCode[input.currency];
        if (!cur) throw new RangeError(`沒有這個幣別：${input.currency}`);
        const openingMinor =
          input.openingText.trim() === "" ? null : parseAmount(input.openingText, cur, { allowNegative: true, allowZero: true });
        const row = await serial(() =>
          ticketRepo.createAccount({ name: input.name, group: input.group, currency: input.currency, openingMinor, occurredOn: today() }),
        );
        await serial(() => get().refresh());
        // 建完接著做（2-16）：只認「當下」的 dialog——中途被蓋掉或取消，意圖就跟著沒了
        const d = get().dialog;
        const then = d?.kind === "newAccount" ? d.then : undefined;
        if (then && "new" in then) get().openNew({ ...then.new, accountId: row.id, currency: row.currency });
        else if (then) then.pick(row.id);
        return row;
      } catch (e) {
        failToast(e);
        return null;
      }
    },

    async updateAccount(id, patch) {
      await write(() => ticketRepo.updateAccount(id, patch));
    },

    archiveAccount(id) {
      const acc = get().accById[id];
      if (!acc) return;
      useUiStore.getState().askConfirm({
        title: TK_TEXT.archiveTitle(acc.name),
        body: TK_TEXT.archiveBody,
        confirmLabel: TK_TEXT.archiveConfirm,
        onConfirm: () => {
          void write(() => ticketRepo.setAccountArchived(id, true));
        },
      });
    },

    async unarchiveAccount(id) {
      await write(() => ticketRepo.setAccountArchived(id, false));
    },

    async moveAccount(id, delta) {
      await write(() => ticketRepo.moveAccount(id, delta));
    },

    async adjustBalance(accountId, targetText) {
      try {
        const acc = get().accById[accountId];
        if (!acc) throw new RangeError("這個帳戶已經刪除了");
        const cur = get().curByCode[acc.currency];
        const target = parseAmount(targetText, { code: acc.currency, decimals: cur?.decimals ?? 2 }, { allowNegative: true, allowZero: true });
        const row = await serial(() => ticketRepo.adjustBalance(accountId, target, today(), TK_TEXT.adjustNote));
        await serial(() => get().refresh());
        toast(row ? TK_TEXT.adjusted(signedText(row.amount_minor, decimalsOf(row.currency))) : TK_TEXT.adjustSame);
        return true;
      } catch (e) {
        failToast(e);
        return false;
      }
    },

    /* ───────── 分類與幣別 ───────── */

    async createCategory(input) {
      // UI 丙-5 D1：回新列（原本回 boolean）——大票分類浮層「＋ 新增分類」建完要選上它；舊呼叫端用真值判斷照樣相容
      let row: CategoryRow | null = null;
      const ok = await write(
        () => ticketRepo.createCategory(input),
        (r) => {
          row = r;
        },
      );
      return ok ? row : null;
    },

    async renameCategory(id, name) {
      await write(() => ticketRepo.renameCategory(id, name));
    },

    async setCategoryArchived(id, archived) {
      await write(() => ticketRepo.setCategoryArchived(id, archived));
    },

    async moveCategory(id, delta) {
      await write(() => ticketRepo.moveCategory(id, delta));
    },

    async moveCategoryUnder(id, parentId, index) {
      return write(() => ticketRepo.moveCategoryUnder(id, parentId, index));
    },

    async createCurrency(input) {
      try {
        const rate = parseRate(input.rateText);
        await serial(() => ticketRepo.createCurrency({ code: input.code, name: input.name, decimals: input.decimals, rate }));
        await serial(() => get().refresh());
        return true;
      } catch (e) {
        failToast(e);
        return false;
      }
    },

    async updateCurrency(id, patch) {
      try {
        const rate = patch.rateText !== undefined ? parseRate(patch.rateText) : undefined;
        await serial(() => ticketRepo.updateCurrency(id, { name: patch.name, rate }));
        await serial(() => get().refresh());
      } catch (e) {
        failToast(e);
      }
    },

    /* ───────── 對話框 ───────── */

    openDialog(d) {
      set({ dialog: d });
    },

    closeDialog() {
      if (get().dialog?.kind === "repeat") {
        repeatBack = null;
        repeatTagGen++;
        set({ dialog: null, repeatDraft: null, repeatTags: null });
        return;
      }
      set({ dialog: null });
    },

    /* ───────── 捕捉目的地（§3.10） ───────── */

    async addQuickEntry(input) {
      await get().warm();
      const { row, q, ctx } = await serial(async () => {
        const s = get();
        const qctx: QuickCtx = { accById: s.accById, catById: s.catById, curByCode: s.curByCode, lastAccountId: s.lastAccountId };
        // 售票口④（D-票-74）：一行裡的 #名稱 抽成荷札、不進備註（色碼、純數字不算——旅客筆記的 parseTags）
        const split = splitQuickTags(input.body);
        const parsed = parseQuickEntry(split.body, qctx);
        const created = await ticketRepo.createEntry({
          kind: parsed.kind,
          amountMinor: parsed.amountMinor,
          currency: parsed.currency,
          accountId: parsed.accountId,
          toAccountId: null,
          categoryId: parsed.categoryId,
          occurredOn: input.dayKey,
          occurredAt: new Date().toISOString(),
          note: parsed.note,
          routeId: input.routeId,
        });
        if (split.names.length) {
          try {
            await writeTags(TK_TAG_ENTRY, created.id, split.names);
          } catch (e) {
            console.warn("[ticket] 捕捉框記的帳沒掛上荷札", e); // 帳已經記好；荷札可以在詳情補
          }
        }
        return { row: created, q: parsed, ctx: qctx };
      });
      set({ lastAccountId: row.account_id, hasAny: true });
      if (get().ready) await serial(() => get().refresh());
      else await syncTagIndex().catch(() => undefined); // 售票口④：沒開過售票口也讓荷札頁看得到剛掛的
      return {
        toast: quickToast(q, ctx),
        undo: async () => {
          await serial(() => ticketRepo.softDeleteEntry(row.id));
          if (get().ready) await serial(() => get().refresh());
        },
      };
    },

    quickDestLabel(route) {
      const s = get();
      let label: string = TK_TEXT.destBase;
      const accId = defaultAccountId(s.accounts, s.lastAccountId);
      if (accId && s.accById[accId]) label += ` · ${s.accById[accId].name}`;
      if (route) {
        const code = useNodeStore.getState().routes.find((r) => r.id === route.id)?.code ?? null;
        label += ` · ${code ? `●${code} ` : ""}${route.name}`;
      }
      return label;
    },

    /* ═══════════ 第②階段「看帳」（②契約 §3.4） ═══════════ */

    async setView(v) {
      const s = get();
      if (v !== "list" && (s.panel.kind === "entry" || s.panel.kind === "account")) {
        // 日曆／統計視圖收起右側板（§5.1）；新票草稿（panel new）不丟
        set({ panel: { kind: "none" }, selectedId: null });
      }
      if (v === "calendar") set({ calendar: computeCalendar(s.entries, s.month) }); // 每次進來重算：今天的標記跨午夜也跟得上
      set({ view: v });
      if (v === "stats") {
        try {
          await serial(loadStats);
        } catch (e) {
          set({ error: errText(e) });
        }
      }
      if (v === "accounts") {
        // 售票口④ 第二輪（D-票-79）：每次進來重查（本月跨月、餘額在別頁被改過都跟得上）
        try {
          await serial(loadAccountCards);
        } catch (e) {
          set({ error: errText(e) });
        }
      }
    },

    async setSpan(sp) {
      if (sp === get().span) return;
      set({ span: sp, period: periodOf(get().month, sp), drill: null });
      savePref(KEY_STATS_SPAN, sp); // 己-2 B1
      try {
        await serial(loadStats);
      } catch (e) {
        set({ error: errText(e) });
      }
    },

    setFacet(f) {
      const facet = facetAllowed(f, get().filterAccountId);
      set({ facet, drill: null, statsRoot: null });
      savePref(KEY_STATS_FACET, facet); // 己-2 B1（篩帳戶時被迫回分類的那一下不經這裡，不會把「依帳戶」蓋掉）
      if (get().stats) set({ stats: computeStats() });
      // 售票口④：依荷札要 index；沒載過先載，載好由下面的 tagStore 訂閱重算
      if (facet === "tag") void ensureTagIndex().catch(() => undefined);
    },

    setFacetKind(k) {
      set({ facetKind: k, drill: null, statsRoot: null }); // 根是那個 kind 的分類，換收支就回全部分類
      savePref(KEY_STATS_KIND, k); // 己-2 B1
      if (get().stats) set({ stats: computeStats() });
    },

    setDrill(key) {
      set({ drill: key });
    },

    setStatsRoot(id) {
      const s = get();
      const c = id === null ? null : s.catById[id];
      // 不在了、未分類（底下沒東西）、別 kind ⇒ 回全部分類
      const root = c && !isUncat(c.id) && c.kind === s.facetKind ? c.id : null;
      set({ statsRoot: root, drill: null });
      if (s.stats) set({ stats: computeStats() });
    },

    async jumpToDay(dayKey) {
      const s0 = get();
      if (s0.searchOpen) get().closeSearch();
      set({ view: "list", dayNotice: null });
      const m = monthOf(dayKey);
      if (get().loadedMonths.indexOf(m) < 0) await get().setMonth(m);
      const g = get().days.find((x) => x.dayKey === dayKey);
      if (g && g.entries.length) {
        get().select(g.entries[0].id);
        set({ pendingDay: dayKey });
        return;
      }
      set({
        selectedId: null,
        panel: get().panel.kind === "new" ? get().panel : { kind: "none" },
        pendingDay: nearestDayWithEntries(get().days, dayKey),
        dayNotice: TK_TEXT.noDay(shortDay(dayKey)),
      });
    },

    consumePendingDay() {
      if (get().pendingDay !== null) set({ pendingDay: null });
    },

    clearDayNotice() {
      if (get().dayNotice !== null) set({ dayNotice: null });
    },

    openSearch() {
      if (get().view !== "list") void get().setView("list");
      if (!get().searchOpen) set({ searchOpen: true });
    },

    closeSearch() {
      // 清除搜尋 ⇒ 排序回日期・新到舊，本機鍵也一起回預設（「每台記住」只管搜尋開著的那段；
      // 不然重開 App 後第一次搜尋、從統計下鑽都會莫名變成金額排序）。D-票-64
      sortChangedWhileLoading = true;
      void settingsRepo.set(sortKey(lastShell), DEFAULT_ENTRY_SORT).catch(() => undefined);
      set({ searchOpen: false, filter: EMPTY_FILTER, results: null, resultDays: [], resultSort: DEFAULT_ENTRY_SORT });
    },

    setResultSort(sort) {
      sortChangedWhileLoading = true;
      if (sort !== get().resultSort) {
        set({ resultSort: sort });
        const r = get().results;
        if (r) setResults(r, sort);
      }
      void settingsRepo.set(sortKey(lastShell), sort).catch(() => undefined);
    },

    async searchMonthSorted(sort) {
      get().setResultSort(sort);
      const s = get();
      if (isFilterActive(s.filter)) return; // 已經在搜尋：只是換排序（setResultSort 已重排）
      const r = monthRange(s.month);
      await get().patchFilter({ from: r.from, toExcl: r.toExcl });
    },

    async setFilterText(text) {
      set({ filter: { ...get().filter, text }, searchOpen: true });
      try {
        await serial(runQuery);
      } catch (e) {
        failToast(e);
      }
    },

    async patchFilter(p) {
      set({ filter: { ...get().filter, ...p }, searchOpen: true });
      try {
        await serial(runQuery);
      } catch (e) {
        failToast(e);
      }
    },

    async drillToList(p) {
      // 「未細分」「（…已不在）」沒有對應的篩選條件（categoryIds 傳主分類 id 會展開成含全部子分類）⇒ 不下鑽；UI 應把這幾列畫成不可點
      if (p.categoryIds?.some(isUnfilterableKey) || isUnfilterableKey(p.accountId) || isUnfilterableKey(p.routeId) || p.tagKeys?.some(isUnfilterableKey)) return;
      const s = get();
      const r = periodRange(s.period);
      if (s.view !== "list") await get().setView("list");
      set({
        searchOpen: true,
        filter: { ...EMPTY_FILTER, from: r.from, toExcl: r.toExcl, accountId: s.filterAccountId, ...p },
      });
      try {
        await serial(runQuery);
      } catch (e) {
        failToast(e);
      }
    },

    async jumpToEntry(id) {
      // UI 丙-5 I1：從沒開過售票口就直接跳帳（全域搜尋 $）時，頁面的 init 還在 warm——它跑完會把 month 設回本月、
      // 蓋掉下面跳過去的月份。先等 init（冪等；已初始化就是同一個 promise）。殼看 <html data-shell>（同 onTicketPage）
      try {
        const mobile = typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile";
        await get().init(mobile ? "mobile" : "desktop");
      } catch {
        return; // 初始化失敗：頁面自己會顯示錯誤
      }
      get().closeSearch();
      if (get().view !== "list") await get().setView("list");
      const e = await ticketRepo.getEntry(id);
      if (!e) return;
      const f = get().filterAccountId;
      if (f !== null && e.account_id !== f && e.to_account_id !== f) set({ filterAccountId: null, facet: facetAllowed(get().facet, null) });
      const m = monthOf(e.occurred_on);
      if (get().loadedMonths.indexOf(m) < 0 || f !== get().filterAccountId) await get().setMonth(m);
      get().openEntry(id);
      set({ pendingDay: e.occurred_on });
    },

    async loadRouteSpend(routeId) {
      // 跨月了（沒有任何寫入也會發生）：快取的「本月」是上個月的 ⇒ 整批作廢，UI 看到 key 消失會再叫
      const curMonth = monthOf(today());
      if (routeSpendMonth !== curMonth) {
        routeSpendMonth = curMonth;
        routeSpendGen++;
        if (Object.keys(get().routeSpend).length) set({ routeSpend: {} });
      }
      if (get().routeSpend[routeId] || routeSpendInflight.has(routeId)) return;
      routeSpendInflight.add(routeId);
      try {
        // 查的途中有寫入（refresh 清過、世代變了）⇒ 結果丟掉、由這裡自己重查（最多 3 次）。
        // 不能只丟：RouteSpendField 只在 key「消失」時重叫，key 從沒出現過就會一直卡在「…」
        for (let attempt = 0; attempt < 3; attempt++) {
          const gen = routeSpendGen;
          const r = monthRange(monthOf(today()));
          const v = await ticketRepo.routeSpend(routeId, r.from, r.toExcl);
          if (gen !== routeSpendGen) continue;
          set({ routeSpend: { ...get().routeSpend, [routeId]: { month: v.inRange, total: v.allTime } } });
          break;
        }
      } catch {
        // 讀不到就維持「…」；下次 mount 再試
      } finally {
        routeSpendInflight.delete(routeId);
      }
    },

    async searchEntries(text, limit) {
      await get().warm();
      const rows = await ticketRepo.queryEntries(filterToQuery(EMPTY_FILTER, get().categories));
      const tokens = keywordTokens(text);
      if (!tokens.length && text.trim() !== "") return []; // 只打 emoji／符號：catKey 後沒有 token，不當成「全部」
      return (tokens.length ? rows.filter((e) => matchesKeyword(e, tokens, viewCtx())) : rows).slice(0, limit);
    },

    /* ═══════════ 第③階段「管帳」（③契約 §3.8） ═══════════ */

    /* ───────── 預算 ───────── */

    async setBudget(scope, month, amountText) {
      try {
        const main = mainCur();
        const amount = parseBudgetAmount(amountText, main);
        await serial(() => ticketRepo.setBudget(scope, month, amount));
        await serial(() => get().refresh());
        const amt = moneyText(amount, main.decimals);
        toast(month === null ? TK_TEXT.budgetSet(scopeLabel(scope), amt) : TK_TEXT.budgetSetMonth(scopeLabel(scope), monthNum(month), amt));
        return true;
      } catch (e) {
        failToast(e);
        return false;
      }
    },

    async removeBudget(scope, month) {
      const text = month === null ? TK_TEXT.budgetRemoved : TK_TEXT.budgetMonthCleared(monthNum(month));
      await write(
        () => ticketRepo.removeBudget(scope, month),
        (ids) => {
          // 復原帶這一刀的 ids：預設列連同各月覆寫一起回來（失物招領 §5-1）
          if (!ids.length) return toast(text);
          toast(text, TK_TEXT.undo, () => {
            void write(() => ticketRepo.restoreBudget(ids));
          });
        },
      );
    },

    /* ───────── 定期帳 ───────── */

    openRepeatEditor(id, seed) {
      const s = get();
      let draft: RepeatDraft;
      if (id !== null) {
        const row = s.repeats.find((r) => r.id === id);
        if (!row) return;
        draft = { ...draftFromRepeat(row, entryCtx()), ...seed };
      } else {
        const t = today();
        const accountId = defaultAccountId(s.accounts, s.lastAccountId);
        draft = {
          kind: DEFAULT_KIND,
          amountText: "",
          currency: (accountId && s.accById[accountId]?.currency) || MAIN_CURRENCY,
          accountId,
          toAccountId: null,
          categoryId: null,
          note: "",
          routeId: null,
          freq: "monthly",
          byweekday: [],
          bymonthday: [parseInt(t.slice(8, 10), 10)],
          start: t,
          interval: 1,
          until: null,
          count: null,
          hhmm: "09:00",
          fromEntryId: null,
          ...seed,
        };
      }
      const cur = s.dialog;
      repeatBack = cur && cur.kind === "repeats" ? cur : null;
      // 荷札：改既有規則＝它現在掛的；從帳來的＝那筆帳的；全新＝空（G1）。直接問 repository（index 可能沒載或還沒重載）
      const gen = ++repeatTagGen;
      const src: { type: TicketTagType; id: string } | null =
        id !== null ? { type: TK_TAG_REPEAT, id } : draft.fromEntryId ? { type: TK_TAG_ENTRY, id: draft.fromEntryId } : null;
      set({ dialog: { kind: "repeat", id, seed }, repeatDraft: draft, repeatTags: src ? null : { names: [], orig: [] } });
      if (src) {
        tagNamesFor(src.type, src.id).then(
          (names) => {
            if (gen === repeatTagGen) set({ repeatTags: { names, orig: names } });
          },
          (e: unknown) => console.warn("[ticket] 讀定期帳的荷札失敗", e), // 讀不到＝不畫荷札列、存檔不動它
        );
      }
    },

    closeRepeatEditor() {
      const back = repeatBack;
      repeatBack = null;
      repeatTagGen++;
      set({ dialog: back, repeatDraft: null, repeatTags: null });
    },

    setRepeatTags(names) {
      const t = get().repeatTags;
      if (t) set({ repeatTags: { names, orig: t.orig } });
    },

    setRepeatDraft(patch) {
      const s = get();
      if (!s.repeatDraft) return;
      const d: RepeatDraft = { ...s.repeatDraft, ...patch };
      const acc = d.accountId ? s.accById[d.accountId] : undefined;
      if (d.kind === "transfer") {
        d.categoryId = null;
        if (acc) d.currency = acc.currency;
      } else {
        d.toAccountId = null;
        if (patch.accountId !== undefined && patch.currency === undefined && acc) d.currency = acc.currency;
        const cat = d.categoryId ? s.catById[d.categoryId] : undefined;
        if (cat && cat.kind !== d.kind) d.categoryId = null;
      }
      set({ repeatDraft: d });
    },

    async saveRepeatDraft() {
      const s = get();
      const d = s.repeatDraft;
      const dlg = s.dialog;
      if (!d || !dlg || dlg.kind !== "repeat") return false;
      try {
        const input = draftToRepeatInput(d, entryCtx());
        // 荷札（G1）：先驗名稱（不合法 ⇒ 整條不寫，同記一筆）。改既有規則只在改過時寫；新的有掛才寫。
        // 還沒讀到（null）＝不動——從帳來的新規則改在存的時候讀那筆帳的（同 setEntryRepeatQuick）
        const t = s.repeatTags;
        const names = t ? draftTagNames(t.names) : null;
        const tagsChanged = t !== null && names !== null && (dlg.id === null ? names.length > 0 : !sameNames(names, t.orig));
        let tagFail = false;
        const row = await serial(async () => {
          let rep: RepeatRow;
          if (dlg.id !== null) rep = await ticketRepo.updateRepeat(dlg.id, input, today());
          else {
            rep = await ticketRepo.createRepeat(input);
            if (d.fromEntryId) await ticketRepo.linkEntryToRepeat(d.fromEntryId, rep.id);
          }
          // 規則已寫入：荷札失敗只記下來（往外丟＝回報「沒存」、再按一次會多建一條規則）
          try {
            if (tagsChanged && names) await writeTags(TK_TAG_REPEAT, rep.id, names);
            else if (t === null && dlg.id === null && d.fromEntryId) {
              const from = await tagNamesFor(TK_TAG_ENTRY, d.fromEntryId);
              if (from.length) await writeTags(TK_TAG_REPEAT, rep.id, from);
            }
          } catch (e) {
            console.warn("[ticket] 定期帳規則的荷札沒掛上", e);
            tagFail = true;
          }
          return rep;
        });
        // 起算日在過去 ⇒ 當場補記（§5.3「會補記從那天起的每一班」；§6 #10「存完立刻」）；荷札已經寫好，補記的帶新的
        const n = await runMaterialize();
        await serial(() => get().refresh());
        get().closeRepeatEditor();
        const rule = parseFixedRule(row.rule) ?? input.rule;
        if (tagFail) toast(TK_TEXT.repeatTagsFail);
        else toast(TK_TEXT.repeatSaved(repeatDesc(rule, row.kind, row.account_id, row.to_account_id, row.category_id, row.note)) + (n ? TK_TEXT.repeatSavedFilled(n) : ""));
        return true;
      } catch (e) {
        failToast(e);
        return false;
      }
    },

    async pauseRepeat(id) {
      await write(
        () => ticketRepo.setRepeatPaused(id, true, today()),
        () => toast(TK_TEXT.repeatPaused),
      );
    },

    async resumeRepeat(id) {
      const ok = await write(() => ticketRepo.setRepeatPaused(id, false, today()));
      if (!ok) return;
      await runMaterialize(); // 早期匯入、從沒開始過的規則 NEXT_DATE 已過 ⇒ 照常補記到今天（✎-8）
      const next = get().repeats.find((x) => x.id === id)?.next_on ?? null;
      toast(next !== null ? TK_TEXT.repeatResumedNext(shortDay(next)) : TK_TEXT.repeatResumed);
    },

    async skipNextRepeat(id) {
      await write(
        () => ticketRepo.skipNextRepeat(id),
        (day) => {
          const next = get().repeats.find((x) => x.id === id)?.next_on ?? null;
          toast(TK_TEXT.repeatSkipped(shortDay(day), next !== null ? shortDay(next) : null), TK_TEXT.undo, () => void get().unskipRepeat(id, day));
        },
      );
    },

    async unskipRepeat(id, day) {
      const ok = await write(() => ticketRepo.unskipRepeat(id, day));
      if (ok && day <= today()) await runMaterialize(); // 跳過後過了夜才復原：那班已經到了，當場補記（同 resumeRepeat）
    },

    async deleteRepeat(id) {
      await write(
        () => ticketRepo.softDeleteRepeat(id),
        () =>
          toast(TK_TEXT.repeatDeleted, TK_TEXT.undo, () => {
            void write(() => ticketRepo.restoreRepeat(id));
          }),
      );
    },

    makeRepeatFromEntry(id) {
      const s = get();
      const e =
        s.entries.find((x) => x.id === id) ?? s.statsEntries.find((x) => x.id === id) ?? (s.results ? s.results.find((x) => x.id === id) : undefined);
      if (!e || e.kind === "adjust") return;
      const rule = ruleFromEntry(e);
      const seed: Partial<RepeatDraft> = {
        kind: e.kind,
        amountText: amountInputText(e.amount_minor, decimalsOf(e.currency)),
        currency: e.currency,
        accountId: e.account_id,
        toAccountId: e.to_account_id,
        categoryId: e.category_id,
        note: e.note,
        routeId: e.route_id,
        freq: "monthly",
        byweekday: [],
        bymonthday: rule.bymonthday ? rule.bymonthday.slice() : [],
        start: rule.start,
        interval: 1,
        until: null,
        count: null,
        hhmm: localTime(e.occurred_at),
        fromEntryId: e.id,
      };
      get().openRepeatEditor(null, seed);
    },

    async materialize(reason) {
      const n = await runMaterialize();
      console.debug(`[ticket] 定期帳實體化（${reason}）：${n === null ? "失敗" : `記了 ${n} 筆`}`);
      if (n === null) return; // 失敗只 console.warn、不 toast（使用者沒按任何東西，§3.9）
      if (reason === "manual" || (n >= 1 && onTicketPage())) toast(TK_TEXT.materialized(n));
    },

    /* ═══════════ 售票口④（Stage 0 資料席） ═══════════ */

    /* ───────── 記一筆的「定期」 ───────── */

    setDraftRepeat(freq) {
      const d = get().draft;
      if (!d) return;
      const next = quickRepeat(freq, d.dayKey, d.repeat.until);
      set({ draft: { ...d, repeat: next } });
    },

    async setEntryRepeatQuick(entryId, quick) {
      try {
        if (quick.freq === "none") return false;
        const e = await freshEntry(entryId);
        if (!e) throw new RangeError("這一筆已經刪除了");
        if (e.repeat_id !== null) return false; // 已連規則：管理在「管理 ›」（完整編輯器）
        const src = quickSourceOfEntry(e, decimalsOf(e.currency), localTime(e.occurred_at));
        if (!src) throw new RangeError("精算不能設成定期");
        const rd = quickRepeatDraft(src, quick, e.id);
        if (!rd) return false;
        const input = draftToRepeatInput(rd, entryCtx());
        const rep = await serial(async () => {
          const created = await ticketRepo.createRepeat(input);
          try {
            await ticketRepo.linkEntryToRepeat(e.id, created.id);
          } catch (err) {
            // 沒連上就收回規則（同 saveDraft）：不留一條沒連到這筆、卻會一直記帳的規則
            await ticketRepo.softDeleteRepeat(created.id).catch((x) => console.warn("[ticket] 收回沒連上的規則失敗", x));
            throw err;
          }
          // 規則帶這筆的荷札（它記出來的每一筆就會帶）
          try {
            const names = await tagNamesFor(TK_TAG_ENTRY, e.id);
            if (names.length) await writeTags(TK_TAG_REPEAT, created.id, names);
          } catch (err) {
            console.warn("[ticket] 定期帳規則的荷札沒掛上", err);
          }
          return created;
        });
        const n = await runMaterialize();
        await serial(() => get().refresh());
        const rule = parseFixedRule(rep.rule) ?? input.rule;
        toast(TK_TEXT.repeatSaved(repeatDesc(rule, rep.kind, rep.account_id, rep.to_account_id, rep.category_id, rep.note)) + (n ? TK_TEXT.repeatSavedFilled(n) : ""));
        return true;
      } catch (err) {
        failToast(err);
        return false;
      }
    },

    async jumpToRepeatDay(dayKey) {
      let first: EntryRow | undefined;
      try {
        first = (await get().repeatEntriesOn(dayKey))[0]; // 順序同帳簿（listEntries）＝今日頁浮層列的順序
      } catch (e) {
        console.warn("[ticket] 讀那天的定期帳失敗", e);
      }
      if (first) {
        await get().jumpToEntry(first.id);
        if (get().selectedId === first.id) return;
      }
      await get().jumpToDay(dayKey);
    },

    async repeatEntriesOn(dayKey) {
      // 今日頁的 dayKey＝todayKey(日界線)＝記帳日；帳的 occurred_on 也是記帳日（draftToInput 的 dayKey、實體化的班次日；
      // 日界線前的凌晨由 atOf 記在前一個帳日）——同一個口徑，直接比 occurred_on，不換算
      await get().warm();
      const rows = await ticketRepo.listEntries(dayKey, addDays(dayKey, 1), null);
      return rows.filter(isRepeatMade);
    },

    /* ───────── 備註記憶 ───────── */

    async loadNoteRecall() {
      if (noteUses !== null) return;
      const gen = noteGen;
      try {
        const uses = await ticketRepo.listNoteUses();
        if (gen !== noteGen) return; // 讀的途中又作廢了：讓下一次讀
        noteUses = uses;
        set({ noteRecall: noteRecallItems(uses) });
      } catch (e) {
        console.warn("[ticket] 讀備註記憶失敗", e); // 讀不到＝沒有候選，欄位照常能打字
      }
    },

    lastCategoryForNote(kind, text) {
      if (noteUses === null) return null;
      const s = get();
      // 任何一層上層封存的分類在完整分類樹裡看不到 ⇒ 也不帶（同「常用」的 hiddenUnderArchived；D-票-78）
      const usable = (id: string): boolean => {
        const c = s.catById[id];
        return !!c && c.kind === kind && !categoryArchivedUp(c, s.catById);
      };
      return lastCategoryOf(noteUses, kind, text, usable);
    },

    /* ───────── 常用票種 ───────── */

    async applyTemplate(id) {
      const t = get().templates.find((x) => x.id === id);
      if (!t) return;
      const seed = templateDraftSeed(t, entryCtx());
      // 路線已刪 ⇒ 不掛（seed 不知道路線在不在）
      if (seed.routeId !== null && !useNodeStore.getState().routes.some((r) => r.id === seed.routeId && r.deleted_at === null)) seed.routeId = null;
      let tags: string[] = [];
      try {
        tags = await tagNamesFor(TK_TAG_TEMPLATE, id);
      } catch (e) {
        console.warn("[ticket] 讀常用票種的荷札失敗", e);
      }
      // 點書籤＝整張換成書籤那筆：從願望「買了」帶來的關聯一起放掉（不然存了會把願望標成已買、金額卻是書籤的；C 11-02 定）
      const patch: Partial<TicketDraft> = { ...seed, tags, mainOverrideText: null, toAmountText: null, wishId: null };
      if (get().draft && get().panel.kind === "new") get().setDraft(patch);
      else get().openNew(patch);
    },

    async saveTemplateFromEntry(entryId, name) {
      try {
        const e = await freshEntry(entryId);
        if (!e) throw new RangeError("這一筆已經刪除了");
        const input = templateFromEntry(e, name);
        const row = await serial(async () => {
          const created = await ticketRepo.createTemplate(input);
          try {
            const names = await tagNamesFor(TK_TAG_ENTRY, e.id);
            if (names.length) await writeTags(TK_TAG_TEMPLATE, created.id, names);
          } catch (err) {
            console.warn("[ticket] 常用票種的荷札沒掛上", err);
          }
          return created;
        });
        await serial(() => get().refresh());
        if (get().dialog?.kind === "saveTemplate") set({ dialog: null });
        toast(TK_TEXT.templateSaved(row.name));
        return row;
      } catch (err) {
        failToast(err);
        return null;
      }
    },

    async renameTemplate(id, name) {
      await write(() => ticketRepo.updateTemplate(id, { name }));
    },

    async deleteTemplate(id) {
      await write(
        () => ticketRepo.softDeleteTemplate(id),
        () =>
          toast(TK_TEXT.templateDeleted, TK_TEXT.undo, () => {
            void write(() => ticketRepo.restoreTemplate(id));
          }),
      );
    },

    async moveTemplateTo(id, index) {
      await write(() => ticketRepo.moveTemplateTo(id, index));
    },

    /* ───────── 願望清單 ───────── */

    async createWish(input) {
      try {
        const names = draftTagNames(input.tags ?? []);
        const amountMinor = mainAmountOrNull(input.amountText);
        const row = await serial(async () => {
          const created = await ticketRepo.createWish({
            name: input.name,
            amountMinor,
            note: input.note ?? "",
            categoryId: input.categoryId ?? null,
            kindId: input.kindId ?? WR_KIND_BUY_ID,
          });
          if (names.length) {
            try {
              await writeTags(TK_TAG_WISH, created.id, names);
            } catch (e) {
              console.warn("[ticket] 願望的荷札沒掛上", e);
            }
          }
          return created;
        });
        await serial(() => get().refresh());
        return row;
      } catch (e) {
        failToast(e);
        return null;
      }
    },

    async updateWish(id, patch) {
      try {
        const amountMinor = patch.amountText !== undefined ? mainAmountOrNull(patch.amountText) : undefined;
        await serial(() => ticketRepo.updateWish(id, { name: patch.name, amountMinor, note: patch.note, categoryId: patch.categoryId, kindId: patch.kindId }));
        await serial(() => get().refresh());
      } catch (e) {
        failToast(e);
      }
    },

    async deleteWish(id) {
      await write(
        () => ticketRepo.softDeleteWish(id),
        () =>
          toast(TK_TEXT.wishDeleted, TK_TEXT.undo, () => {
            void write(() => ticketRepo.restoreWish(id));
          }),
      );
    },

    async moveWishTo(id, index) {
      await write(() => ticketRepo.moveWishTo(id, index));
    },

    async buyWish(id) {
      const w = get().wish.want.find((x) => x.id === id) ?? get().wishes.find((x) => x.id === id);
      if (!w) return;
      let tags: string[] = [];
      try {
        tags = await tagNamesFor(TK_TAG_WISH, id);
      } catch (e) {
        console.warn("[ticket] 讀願望的荷札失敗", e);
      }
      get().openNew({ ...wishDraftSeed(w, entryCtx(), mainCur()), tags });
    },

    async setWishTarget(id, target) {
      await write(() => ticketRepo.setWishTarget(id, target));
    },

    /* ───────── 候車室種類（番線） ───────── */

    async createWishKind(input) {
      try {
        const row = await serial(() => ticketRepo.createWishKind(input));
        await serial(() => get().refresh());
        return row;
      } catch (e) {
        failToast(e);
        return null;
      }
    },

    async updateWishKind(id, patch) {
      try {
        await serial(() => ticketRepo.updateWishKind(id, patch));
        await serial(() => get().refresh());
      } catch (e) {
        failToast(e);
      }
    },

    async deleteWishKind(id) {
      await write(
        () => ticketRepo.softDeleteWishKind(id),
        () =>
          toast(TK_TEXT.kindDeleted, TK_TEXT.undo, () => {
            void write(() => ticketRepo.restoreWishKind(id));
          }),
      );
    },

    async moveWishKindTo(id, index) {
      await write(() => ticketRepo.moveWishKindTo(id, index));
    },

    /* ───────── 帳戶與分類拖曳 ───────── */

    async moveAccountTo(id, index) {
      await write(() => ticketRepo.moveAccountTo(id, index));
    },

    async moveCategoryTo(id, index) {
      await write(() => ticketRepo.moveCategoryTo(id, index));
    },
  };
});

/* 己-2 B5（D-主-418）：視圖一變就記（頁首五格、手機左右滑、跳到某天回清單……每條路都會改到 view，所以在這裡收，不散在各動作裡）；
 * 冷啟動讀回來套之前不寫（prefsApplied），免得初值「清單」把上次的蓋掉 */
useTicketStore.subscribe((s, prev) => {
  if (!prefsApplied || s.view === prev.view) return;
  savePref(KEY_TICKET_VIEW, s.view);
});
/* 第②階段：週起始日、日界線、路線（名稱／顏色／刪除）變了 ⇒ 月曆與統計就地重算（純函式，不重讀） */
useUiStore.subscribe((s, prev) => {
  if (s.weekStart === prev.weekStart && s.dayStartHour === prev.dayStartHour) return;
  const t = useTicketStore.getState();
  if (t.calendar !== null) {
    const own = t.entries.filter((e) => monthOf(e.occurred_on) === t.month);
    useTicketStore.setState({ calendar: calendarCells(own, t.month, s.weekStart, todayKey(s.dayStartHour)) });
  }
});
useNodeStore.subscribe((s, prev) => {
  if (s.routes === prev.routes) return;
  const t = useTicketStore.getState();
  if (!t.stats) return;
  const r = periodRange(t.period);
  const ctx: ViewCtx = { accById: t.accById, catById: t.catById, curByCode: t.curByCode, ...routeCtx(s.routes), ...tagCtx() };
  useTicketStore.setState({
    stats: { ...t.stats, breakdown: breakdown(t.statsEntries, r, facetAllowed(t.facet, t.filterAccountId), t.facetKind, ctx) },
  });
});
/* 售票口④：荷札 index 換了（荷札頁改名／刪除、同步拉到 taggings、本機掛了荷札）⇒ 依荷札統計就地重算、篩荷札或打了字的搜尋重查 */
useTagStore.subscribe((s, prev) => {
  if (s.index === prev.index) return;
  const t = useTicketStore.getState();
  if (t.stats && t.facet === "tag") {
    const r = periodRange(t.period);
    const ctx: ViewCtx = { accById: t.accById, catById: t.catById, curByCode: t.curByCode, ...routeCtx(useNodeStore.getState().routes), ...tagCtx() };
    useTicketStore.setState({ stats: { ...t.stats, breakdown: breakdown(t.statsEntries, r, "tag", t.facetKind, ctx) } });
  }
  if (t.results !== null && ((t.filter.tagKeys ?? []).length > 0 || keywordTokens(t.filter.text).length > 0)) void t.patchFilter({});
});
