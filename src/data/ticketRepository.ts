/**
 * 售票口線的資料層介面（車次①契約 §3.4；甲席 Stage 0 介面先行）。
 *
 * 兩個實作：`SqliteTicketRepository`（真機；前端直連 SQL＋讀備份一支 Rust command）與
 * `MemoryTicketRepository`（`?mock=1`）。兩者對本檔**只用 `import type`**，執行期不循環；
 * `./index` 不 import 本線任何檔（地基契約 10-3：不經 barrel）。
 *
 * **只有 store（與 memory／sqlite 實作）能 import 本檔**；UI 只讀 store、只叫 store 的動作（契約 §2.5-2、§8 牙齒）。
 * 錯誤慣例：輸入不合法一律 `throw new RangeError("<人話>")`（全文契約 §4.3），store 接住後 toast `e.message`。
 * 寫入慣例：驗證與欄值推導**都呼叫 domain**（`buildEntryRow`／`applyEntryPatch`／…）；每支公開寫入＝一個 WriteBatch（匯入分批，0-21）。
 */
import type {
  AccountGroup,
  AccountRow,
  CategoryKind,
  CategoryRow,
  CurrencyRow,
  EntryRow,
  EntryPatch,
  NewEntryInput,
  MmbakReadResult,
  ImportLocal,
  ImportPlan,
  ImportChoice,
  ImportOutcome,
  UsageSince,
} from "../domain/ticket";
import type { EntryQuery } from "../domain/ticketView";
import type { BudgetRow, BudgetScope, NewRepeatInput, PlanImportPart, RepeatPatch, RepeatRow } from "../domain/ticketPlan";
import { MOCK_MODE, WIPED_MODE } from "./index";
import { SqliteTicketRepository } from "./sqliteTicketRepository";
import { MemoryTicketRepository } from "./memoryTicketRepository";

export type { NewEntryInput, EntryPatch } from "../domain/ticket";
/** 型別定義在 domain（`filterToQuery` 產生它；domain 不能反過來 import data 層） */
export type { EntryQuery } from "../domain/ticketView";
/** 第③階段（③契約 §3.4）：規則的輸入定義在 domain（draftToRepeatInput 產生它），這裡 re-export */
export type { NewRepeatInput, RepeatPatch, BudgetScope } from "../domain/ticketPlan";

export interface NewAccountInput {
  name: string; // trim 後非空，否則 RangeError（§4.3）
  group: AccountGroup;
  currency: string; // 已存在的幣別 code
  openingMinor: number | null; // 期初餘額；非 null 且非 0 ⇒ 同一批多一筆 adjust（備註「期初餘額」）
  occurredOn: string; // 期初那筆的日（store 給 todayKey）
}
export interface AccountPatch {
  name?: string;
  group?: AccountGroup;
  currency?: string; // 有帳 ⇒ RangeError
}
export interface NewCategoryInput {
  kind: CategoryKind;
  name: string;
  parentId: string | null; // parent 必須是同 kind 的主分類
}
export interface NewCurrencyInput {
  code: string;
  name: string;
  decimals: number;
  rate: string; // parseRate 過的字串
}
export interface CurrencyPatch {
  name?: string;
  rate?: string; // 主幣別改 rate ⇒ RangeError
}

export interface TicketRepository {
  /* ── 起手 ── */
  /** 依 id 查起手三列（含墓碑），缺幾列補幾列＋各一筆完整 upsert op（父先：幣別、再分類）；回這次種了幾列（冪等；0-17） */
  ensureStarterRows(): Promise<number>;

  /* ── 讀（一律未刪除；含封存） ── */
  /** position、code */
  listCurrencies(): Promise<CurrencyRow[]>;
  /** orderAccounts（§4.5）的順序 */
  listAccounts(): Promise<AccountRow[]>;
  /** kind、(parent_id IS NOT NULL)、position、created_at */
  listCategories(): Promise<CategoryRow[]>;
  /** 每個未刪帳戶（含封存）的餘額，帳戶幣別最小單位；SQL 聚合（§3.5-3）。沒有帳的帳戶＝0 */
  balances(): Promise<Record<string, number>>;
  /** occurred_on ∈ [fromDay, toDayExcl)；accountId 非 null ⇒ account_id 或 to_account_id 等於它；新到舊（§3.5-4） */
  listEntries(fromDay: string, toDayExcl: string, accountId: string | null): Promise<EntryRow[]>;
  getEntry(id: string): Promise<EntryRow | null>;
  /** 有沒有任何一筆未刪的帳（空帳本文案用） */
  hasAnyEntry(): Promise<boolean>;
  /** 最近建立的一筆非 adjust 未刪帳的 account_id；沒有＝null（0-29） */
  lastUsedAccountId(): Promise<string | null>;
  /** 該 kind 最近用過的分類 id（依該分類最近一筆的 created_at 遞減；排除未分類與已封存／已刪的分類） */
  recentCategoryIds(kind: CategoryKind, limit: number): Promise<string[]>;
  /**
   * 只讀・用量（磨光⑥ §2-3；記一筆的「常用」）：未刪、`occurred_on ≥ sinceDay` 的帳，各分類與各帳戶用了幾次。
   * 分類＝收支帳（kind income／expense）依 category_id 分組，排除未分類與已封存／已刪的分類，`last`＝最近一筆的 `occurred_on + " " + occurred_at`；
   * 帳戶＝非 adjust 的帳依 account_id 分組，轉帳另把 to_account_id 也算一次（兩邊都是它用過的帳戶）。沒用過的不出現。
   */
  usageSince(sinceDay: string): Promise<UsageSince>;

  /* ── 讀・第②階段「看帳」（②契約 §3.2；純讀、不經 serial） ── */
  /**
   * 結構條件的查詢（0-14）；關鍵字不在這裡（純函式 `matchesKeyword`）。全部條件為空＝全部未刪的帳。
   * 新到舊（同 listEntries 的 ORDER BY）。`categoryIds` 呼叫端已用 `categoryIdsIncluding` 展開成含子分類。
   */
  queryEntries(q: EntryQuery): Promise<EntryRow[]>;
  /** 一條路線的支出淨額（0-11 口徑：未刪、expense、route_id 直掛；退款抵回）：期間 [from, toExcl) 內與全部期間。沒有帳＝{ inRange: 0, allTime: 0 } */
  routeSpend(routeId: string, from: string, toExcl: string): Promise<{ inRange: number; allTime: number }>;
  // listEntryDays：0-3 定案選 (a)（主線日曆不填 calendarDayMarks，D-票-29）⇒ 契約 §3.2「選 (a) 就不加這個方法」，不加。

  /* ── 寫（每支＝一個 WriteBatch；匯入除外） ── */
  createEntry(input: NewEntryInput): Promise<EntryRow>;
  /** 回寫入後的列；沒有任何欄真的變 ⇒ 不寫、回原列 */
  updateEntry(id: string, patch: EntryPatch): Promise<EntryRow>;
  /** 第③階段（0-7-2）：那筆 repeat_id 非空且規則還在 ⇒ 同一批把 occurred_on 加進規則的 skipped_days（withSkipped）＋ upsert op */
  softDeleteEntry(id: string): Promise<void>;
  /** undo：deleted_at 改回 NULL（第③階段：同一批從 skipped_days 拿掉那一天） */
  restoreEntry(id: string): Promise<void>;
  createAccount(input: NewAccountInput): Promise<AccountRow>;
  updateAccount(id: string, patch: AccountPatch): Promise<void>;
  setAccountArchived(id: string, archived: boolean): Promise<void>;
  /** 同群組、未封存的鄰居互換 position；到邊界＝不動 */
  moveAccount(id: string, delta: 1 | -1): Promise<void>;
  /** 目標 − 目前 ≠ 0 ⇒ 一筆 adjust 並回它；＝0 ⇒ 不寫、回 null */
  adjustBalance(accountId: string, targetMinor: number, occurredOn: string, note: string): Promise<EntryRow | null>;
  createCategory(input: NewCategoryInput): Promise<CategoryRow>;
  renameCategory(id: string, name: string): Promise<void>;
  /** 封存主分類 ⇒ 子分類一起；取消封存主分類 ⇒ 與它同一刻被連帶封存的子分類一起回來；未分類 ⇒ RangeError */
  setCategoryArchived(id: string, archived: boolean): Promise<void>;
  /** 同 kind、同層、未封存的鄰居互換 position（未分類不參與）；父分類已不在的子分類當主分類那一層（`effectiveParentId`，D-票-62） */
  moveCategory(id: string, delta: 1 | -1): Promise<void>;
  createCurrency(input: NewCurrencyInput): Promise<CurrencyRow>;
  updateCurrency(id: string, patch: CurrencyPatch): Promise<void>;

  /* ── 讀・第③階段「管帳」（③契約 §3.4） ── */
  /** 未刪的預算（含預設與所有月的覆寫）；position、month */
  listBudgets(): Promise<BudgetRow[]>;
  /** 未刪的規則（含暫停）；(paused_at IS NOT NULL), COALESCE(next_on, 9999-99-99), created_at */
  listRepeats(): Promise<RepeatRow[]>;
  // overBudgetDays：0-2 定案選 (a)（主線日曆不標超支日，D-票-32）⇒ 契約 §3.4「答 (b) 才加」，不加。

  /* ── 寫・預算（每支一個 WriteBatch） ── */
  /** 依 (scope, month) 算 id ⇒ INSERT … ON CONFLICT(id) DO UPDATE SET amount_minor, deleted_at = NULL, updated_at；amount ≤ 0 ⇒ RangeError；未分類／非支出分類 ⇒ RangeError */
  setBudget(scope: BudgetScope, month: string | null, amountMinor: number): Promise<BudgetRow>;
  /** 軟刪那一列（預設或某月覆寫）；移除預設時連同該對象所有月的覆寫一起軟刪（同一批） */
  removeBudget(scope: BudgetScope, month: string | null): Promise<void>;

  /* ── 寫・定期帳（0-6～0-8） ── */
  /** 驗證（§4.3 錯誤表）→ 新列（next_on = firstFixedDate(rule, rule.start)）；回列 */
  createRepeat(input: NewRepeatInput): Promise<RepeatRow>;
  /** 模板或規則變了 ⇒ 寫；規則變了 ⇒ next_on = nextFixedDate(新規則, today)（0-8）；沒變 ⇒ 不寫、回原列 */
  updateRepeat(id: string, patch: RepeatPatch, today: string): Promise<RepeatRow>;
  /**
   * 暫停：paused_at = now；開始：paused_at = NULL＋next_on＝resumeNextOn——手建的（或開始過的）＝nextFixedDate(rule, today)（明天起）、
   * 從沒開始過的匯入規則 next_on 不動（＝最後一次匯入帶進來的 NEXT_DATE，✎-8）。「從沒開始過」＝neverStarted(repeat, entries)（含墓碑）
   */
  setRepeatPaused(id: string, paused: boolean, today: string): Promise<void>;
  /**
   * 「全部開始」的對象（0-1；收尾修正）：未刪、暫停中、從沒開始過的匯入規則（neverStarted，看帳含墓碑）的 id。
   * 橫幅「N 條還在暫停」、確認窗「開始 N 條？」都數這一份；resumeAllRepeats 開始的也是同一個判法
   */
  listUnstartedRepeatIds(): Promise<string[]>;
  /** 全部開始（0-1）：只開始 listUnstartedRepeatIds 那幾條（手動暫停的、開始過的不動），同一批照上面開始；回開始了幾條 */
  resumeAllRepeats(today: string): Promise<number>;
  softDeleteRepeat(id: string): Promise<void>;
  restoreRepeat(id: string): Promise<void>;
  /** 把一筆既有的帳連到規則（「設成定期」後）：tk_entries.repeat_id = id */
  linkEntryToRepeat(entryId: string, repeatId: string): Promise<void>;
  /**
   * 實體化（契約 0-6-3）：reconcile（0-7-3）→ 算班次（planMaterialize）→ 查本機已有的 id（**含墓碑**）→ 插入＋推游標。
   * 一次呼叫＝一個或多個 WriteBatch（帳每 IMPORT_CHUNK 筆一批）；**只對本機不存在的 id 發 op**。
   * 回報數字給 toast／除錯；blocked＝規則 id → 人話原因。整支在 store 的 serial() 裡跑。
   */
  materializeRepeats(
    today: string,
    dayStartHour: number,
  ): Promise<{ inserted: number; reconciled: number; blocked: { id: string; reason: string }[] }>;

  /* ── 匯入（①b） ── */
  /** plugin-dialog open()；桌機帶 `.mmbak` 篩選、手機不帶（MIME 不明，probe §2）；取消＝null */
  pickImportFile(shell: "desktop" | "mobile"): Promise<string | null>;
  /** invoke("ticket_import_read", { path })（§3.6） */
  readImport(path: string): Promise<MmbakReadResult>;
  /** 六張表**含墓碑**的全部列（planImport 的 local；第③階段多 budgets／repeats） */
  loadImportLocal(): Promise<ImportLocal>;
  /**
   * materializeImport（§4.7）→ 第 1 批（幣別＋帳戶＋分類，第③階段尾端接預算與規則：預算 insert＝DO UPDATE、規則 insert＝DO NOTHING、
   * updates 走 UPDATE）＋帳每 IMPORT_CHUNK 筆一批（0-21）；每批後 onProgress(已寫帳筆數, 帳總筆數)
   */
  applyImport(
    plan: ImportPlan,
    choices: Readonly<Record<string, ImportChoice>>,
    part: PlanImportPart,
    onProgress: (done: number, total: number) => void,
  ): Promise<ImportOutcome>;
}

export const ticketRepo: TicketRepository = MOCK_MODE
  ? new MemoryTicketRepository({ seedDemo: !WIPED_MODE })
  : new SqliteTicketRepository();
