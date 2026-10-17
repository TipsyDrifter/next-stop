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
} from "../domain/ticket";
import type { EntryQuery } from "../domain/ticketView";
import { MOCK_MODE, WIPED_MODE } from "./index";
import { SqliteTicketRepository } from "./sqliteTicketRepository";
import { MemoryTicketRepository } from "./memoryTicketRepository";

export type { NewEntryInput, EntryPatch } from "../domain/ticket";
/** 型別定義在 domain（`filterToQuery` 產生它；domain 不能反過來 import data 層） */
export type { EntryQuery } from "../domain/ticketView";

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
  softDeleteEntry(id: string): Promise<void>;
  /** undo：deleted_at 改回 NULL */
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
  /** 同 kind、同父、未封存的鄰居互換 position（未分類不參與） */
  moveCategory(id: string, delta: 1 | -1): Promise<void>;
  createCurrency(input: NewCurrencyInput): Promise<CurrencyRow>;
  updateCurrency(id: string, patch: CurrencyPatch): Promise<void>;

  /* ── 匯入（①b） ── */
  /** plugin-dialog open()；桌機帶 `.mmbak` 篩選、手機不帶（MIME 不明，probe §2）；取消＝null */
  pickImportFile(shell: "desktop" | "mobile"): Promise<string | null>;
  /** invoke("ticket_import_read", { path })（§3.6） */
  readImport(path: string): Promise<MmbakReadResult>;
  /** 四張表**含墓碑**的全部列（planImport 的 local） */
  loadImportLocal(): Promise<ImportLocal>;
  /** materializeImport（§4.7）→ 第 1 批（幣別＋帳戶＋分類）＋帳每 IMPORT_CHUNK 筆一批（0-21）；每批後 onProgress(已寫帳筆數, 帳總筆數) */
  applyImport(
    plan: ImportPlan,
    choices: Readonly<Record<string, ImportChoice>>,
    onProgress: (done: number, total: number) => void,
  ): Promise<ImportOutcome>;
}

export const ticketRepo: TicketRepository = MOCK_MODE
  ? new MemoryTicketRepository({ seedDemo: !WIPED_MODE })
  : new SqliteTicketRepository();
