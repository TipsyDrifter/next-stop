/**
 * ticketStore——售票口線的畫面狀態與流程（車次①契約 §3.8、§3.9；甲席 Stage 0 全文）。
 *
 * **UI 只讀 store、只叫 store 的動作，不直接碰 repository**（契約 §2.5-2；§8 有 grep 牙齒）。兩殼共用一份
 * （篩選帳戶、月份、選取、表單草稿），兩殼永不同時渲染。
 *
 * - serial 佇列（同 timetableStore）：所有寫入、`refresh`、匯入寫入、捕捉框的 `addQuickEntry` 都經 `serial()`。
 *   `refresh` 本身不排隊（呼叫端包 `serial(() => get().refresh())`），排進佇列的函式裡不得再呼叫 `serial`（會互等）。
 * - 時間：日＝`todayKey(useUiStore.getState().dayStartHour)`；時刻＝`new Date().toISOString()`；改時刻用 domain 的 `atOf`。
 * - 錯誤：寫入失敗 toast（`RangeError` 吐它的 message，其餘 `TK_TEXT.saveFail`），回 `false`／不改狀態；
 *   `error` 只給 `init`／`refresh` 載入失敗。
 * - toast 與固定文案集中在 `TK_TEXT`（契約 §5.7、0-33）；顯示端不手抄。
 */
import { create } from "zustand";
import { ticketRepo } from "../data/ticketRepository";
import { useUiStore } from "./uiStore";
import { useNodeStore } from "./nodeStore";
import { todayKey } from "../lib/date";
import type { LineReloadContext, CaptureSaveInput, CaptureSaveResult, CaptureRouteRef } from "../lines/types";
import {
  IMPORT_CHUNK,
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  UNCAT_NAME,
  accountTotals,
  addMonths,
  bareName,
  defaultAccountId,
  defaultChoices,
  draftToInput,
  groupByDay,
  localTime,
  missingText,
  moneyText,
  monthOf,
  monthRange,
  monthSum,
  orderAccounts,
  parseAmount,
  parseQuickEntry,
  parseRate,
  planImport,
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
  type MmbakDump,
  type ImportLocal,
  type ImportPlan,
  type ImportChoice,
  type ImportOutcome,
  type BalanceCheck,
  type QuickCtx,
} from "../domain/ticket";

export type TicketShell = "desktop" | "mobile";
/** 詳情板（桌機右側）／全螢幕面板（手機）現在畫什麼；兩殼共用 */
export type TicketPanel = { kind: "none" } | { kind: "new" } | { kind: "entry"; id: string } | { kind: "account"; id: string };
export type TicketDialog = { kind: "newAccount" } | { kind: "categories" } | { kind: "currencies" } | { kind: "import" };

export interface ImportState {
  phase: "idle" | "reading" | "unknown" | "preview" | "writing" | "done" | "error";
  missing: string[]; // unknown 時
  dump: MmbakDump | null;
  local: ImportLocal | null;
  balanceText: Record<string, string>; // 財務管家帳戶 uid → 主人抄的餘額
  plan: ImportPlan | null; // 每次 balanceText 變動就重算（純函式，即時）
  choices: Record<string, ImportChoice>; // entry id → "theirs" | "ours"（預設 theirs）
  progress: { done: number; total: number } | null;
  outcome: ImportOutcome | null;
  after: BalanceCheck[] | null; // done 時：匯入後 Next Stop 實際餘額 vs 主人抄的（結果卡對照表）
  message: string | null; // error 時
}

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
  draft: EntryDraft | null; // panel.kind === "new" 時
  savedAt: number | null; // 舊票即時存成功的時間（「已存」淡字）
  lastAccountId: string | null;
  recent: { income: string[]; expense: string[] }; // 最近用過 8 個
  dialog: TicketDialog | null;
  imp: ImportState;

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
  openNew(seed?: Partial<EntryDraft>): void; // 預設：expense、帳戶＝defaultAccountId、今天（日界線）、現在、帳戶幣別
  setDraft(patch: Partial<EntryDraft>): void; // 換帳戶 ⇒ 幣別跟著換（收支）；kind 換成 transfer ⇒ categoryId 清空
  saveDraft(opts: { again: boolean }): Promise<boolean>; // draftToInput → createEntry → toast；again ⇒ 留 kind／帳戶／分類／日期，清金額與備註
  /* 舊票：即時存（UI 用 panel/fields.tsx:76 useDebouncedCommit 去抖後呼叫） */
  openEntry(id: string): void;
  openAccount(id: string): void;
  closePanel(): void;
  updateEntry(id: string, patch: EntryPatch): Promise<void>; // 成功 ⇒ savedAt = Date.now()、refresh
  deleteEntry(id: string): Promise<void>; // 軟刪＋toast「已刪除這一筆」帶「復原」（restoreEntry）

  /* 帳戶 */
  createAccount(input: { name: string; group: AccountGroup; currency: string; openingText: string }): Promise<boolean>;
  updateAccount(id: string, patch: { name?: string; group?: AccountGroup; currency?: string }): Promise<void>;
  archiveAccount(id: string): void; // askConfirm（§5.7 封存確認）→ setAccountArchived(id, true)
  unarchiveAccount(id: string): Promise<void>;
  moveAccount(id: string, delta: 1 | -1): Promise<void>;
  adjustBalance(accountId: string, targetText: string): Promise<boolean>; // 備註「餘額調整」；toast「已精算 ±N」／「餘額沒有變」

  /* 分類與幣別 */
  createCategory(input: { kind: CategoryKind; name: string; parentId: string | null }): Promise<boolean>;
  renameCategory(id: string, name: string): Promise<void>;
  setCategoryArchived(id: string, archived: boolean): Promise<void>;
  moveCategory(id: string, delta: 1 | -1): Promise<void>;
  createCurrency(input: { code: string; name: string; decimals: number; rateText: string }): Promise<boolean>;
  updateCurrency(id: string, patch: { name?: string; rateText?: string }): Promise<void>;

  /* 對話框 */
  openDialog(d: TicketDialog): void;
  closeDialog(): void; // 關 import ⇒ imp 回 idle

  /* 匯入（①b） */
  startImport(shell: TicketShell): Promise<void>; // dialog＝import → pickImportFile → 取消就關 → importFromPath
  importFromPath(path: string): Promise<void>; // reading → readImport → missing ⇒ unknown；否則 loadImportLocal → planImport → defaultChoices → preview
  setImportBalance(mmAccountUid: string, text: string): void; // 重算 plan；choices 對還在 changed 裡的 id 保留
  setImportChoice(entryId: string, c: ImportChoice): void;
  runImport(): Promise<void>; // writing → applyImport（progress）→ refresh → after＝實際餘額對照 → done；失敗 ⇒ error（plan 留著可重試）

  /* 捕捉目的地（§3.10） */
  addQuickEntry(input: CaptureSaveInput): Promise<CaptureSaveResult>;
  quickDestLabel(route: CaptureRouteRef | null): string; // 同步；warm 前＝「售票口」
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
  openingNote: "期初餘額",
  archiveTitle: (name: string) => `要封存「${name}」嗎？`, // §5.7 拆成標題＋內文
  archiveBody: "封存後仍計入合計，清單可篩到。",
  archiveConfirm: "封存",
  discardTitle: "放棄這一筆？",
  discardConfirm: "放棄",
  saveFail: "存檔失敗——請再試一次", // RangeError 改吐 message
  importReading: "正在讀備份…", // §5.2
  importWriting: (done: number, total: number) => `正在寫入 ${done}/${total}`, // §5.2；分母見 0-24
  importResult: (n: number, m: number, k: number) => `已匯入 ${n} 筆 · 更新 ${m} 筆 · 略過 ${k} 筆`, // §5.7
  importUnknown: (missing: readonly string[]) => `這個備份版本我不認得（缺 ${missingText(missing)}）`, // §5.7；missingText 在 §4.7
  destBase: "售票口",
} as const;

/* ───────── §3.8.3 常數與模組層狀態 ───────── */

export const RECENT_LIMIT = 8;
export { IMPORT_CHUNK };
export const DEFAULT_KIND = "expense" as const;
export const IMPORT_IDLE: ImportState = {
  phase: "idle",
  missing: [],
  dump: null,
  local: null,
  balanceText: {},
  plan: null,
  choices: {},
  progress: null,
  outcome: null,
  after: null,
  message: null,
};

/** serial 佇列：寫入、refresh、匯入寫入不交錯 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

let warmPromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;
let lastShell: TicketShell = "desktop";
/** 匯入流程的代號：關掉對話框或重開一次後，舊流程的非同步結果不再寫回 imp */
let importToken = 0;

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

function draftHasContent(d: EntryDraft | null): boolean {
  if (!d) return false;
  return (
    d.amountText.trim() !== "" ||
    d.note.trim() !== "" ||
    d.categoryId !== draftBaseCategoryId ||
    d.mainOverrideText !== null ||
    d.toAmountText !== null
  );
}

export const useTicketStore = create<TicketStore>((set, get) => {
  /** 帳戶／分類／幣別＋上一筆帳戶＋最近分類（warm 與 refresh 共用） */
  async function loadMeta(): Promise<void> {
    const [currencies, accounts, categories, lastAccountId, rin, rex] = await Promise.all([
      ticketRepo.listCurrencies(),
      ticketRepo.listAccounts(),
      ticketRepo.listCategories(),
      ticketRepo.lastUsedAccountId(),
      ticketRepo.recentCategoryIds("income", RECENT_LIMIT),
      ticketRepo.recentCategoryIds("expense", RECENT_LIMIT),
    ]);
    set({
      currencies,
      curByCode: byCode(currencies),
      accounts,
      accById: byId(accounts),
      categories,
      catById: byId(categories),
      lastAccountId,
      recent: { income: rin, expense: rex },
    });
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

  /** 匯入流程的 imp 寫回（代號不符＝流程已被關掉或重開，丟掉） */
  function setImp(token: number, patch: Partial<ImportState>): void {
    if (token !== importToken) return;
    set({ imp: { ...get().imp, ...patch } });
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
    dialog: null,
    imp: IMPORT_IDLE,

    /* ───────── 載入 ───────── */

    warm() {
      if (!warmPromise) {
        warmPromise = (async () => {
          await serial(() => ticketRepo.ensureStarterRows());
          await loadMeta();
        })().catch((e) => {
          warmPromise = null; // 失敗可重試
          throw e;
        });
      }
      return warmPromise;
    },

    init(shell) {
      lastShell = shell;
      if (!initPromise) {
        initPromise = (async () => {
          set({ loading: true, error: null });
          try {
            await get().warm();
            const m = monthOf(today());
            set({ month: m, loadedMonths: [m] });
            await serial(() => get().refresh());
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
        const s0 = get();
        const months = s0.loadedMonths.length ? s0.loadedMonths : [s0.month];
        const filter = s0.filterAccountId;
        const [, balances, hasAny, ...lists] = await Promise.all([
          loadMeta(),
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
      } catch (e) {
        set({ error: errText(e) });
      }
    },

    async reload(ctx) {
      const touched = ctx.wiped || ctx.changed.some((t) => t.startsWith("tk_"));
      if (!touched) return;
      if (ctx.wiped) {
        importToken++;
        set({ panel: { kind: "none" }, draft: null, selectedId: null, dialog: null, imp: IMPORT_IDLE, filterAccountId: null, ready: false });
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
      set({ month, loadedMonths: [month] });
      await serial(() => get().refresh());
    },

    async stepMonth(delta) {
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
      set({ filterAccountId: accountId });
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
      // 沒有未封存帳戶（又沒指定帳戶）⇒ 先開「新增帳戶」，不開一張帳戶空白的新票（記帳一定要落在某個帳戶上；手機同口徑）
      if (!accountId && !seed?.accountId) {
        set({ dialog: { kind: "newAccount" } });
        return;
      }
      const currency = (accountId && s.accById[accountId]?.currency) || MAIN_CURRENCY;
      const draft: EntryDraft = {
        kind: DEFAULT_KIND,
        amountText: "",
        currency,
        accountId,
        toAccountId: null,
        categoryId: null,
        dayKey: today(),
        time: localTime(new Date().toISOString()),
        note: "",
        routeId: null,
        mainOverrideText: null,
        toAmountText: null,
        ...seed,
      };
      draftBaseCategoryId = null;
      set({ panel: { kind: "new" }, draft, selectedId: null, savedAt: null });
    },

    setDraft(patch) {
      const s = get();
      if (!s.draft) return;
      const d: EntryDraft = { ...s.draft, ...patch };
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
      set({ draft: d });
    },

    async saveDraft({ again }) {
      const d = get().draft;
      if (!d) return false;
      try {
        const input = draftToInput(d, entryCtx(), dayStart());
        const row = await serial(() => ticketRepo.createEntry(input));
        set({ lastAccountId: row.kind === "adjust" ? get().lastAccountId : row.account_id, hasAny: true });
        if (again) {
          draftBaseCategoryId = d.categoryId;
          set({ draft: { ...d, amountText: "", note: "", mainOverrideText: null, toAmountText: null } });
        } else {
          const m = monthOf(row.occurred_on);
          if (get().loadedMonths.indexOf(m) < 0) set({ month: m, loadedMonths: [m] });
          set({ draft: null, selectedId: row.id, panel: { kind: "entry", id: row.id }, savedAt: null });
        }
        await serial(() => get().refresh());
        toast(savedText(row), TK_TEXT.undo, () => {
          void (async () => {
            try {
              await serial(() => ticketRepo.softDeleteEntry(row.id));
              await serial(() => get().refresh());
            } catch (e) {
              failToast(e);
            }
          })();
        });
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
        await serial(() =>
          ticketRepo.createAccount({ name: input.name, group: input.group, currency: input.currency, openingMinor, occurredOn: today() }),
        );
        await serial(() => get().refresh());
        return true;
      } catch (e) {
        failToast(e);
        return false;
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
        if (!acc) throw new RangeError("這個帳戶已經不在了");
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
      return write(() => ticketRepo.createCategory(input));
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
      if (get().dialog?.kind === "import") {
        importToken++;
        set({ dialog: null, imp: IMPORT_IDLE });
        return;
      }
      set({ dialog: null });
    },

    /* ───────── 匯入（①b） ───────── */

    async startImport(shell) {
      const token = ++importToken;
      set({ dialog: { kind: "import" }, imp: { ...IMPORT_IDLE, phase: "reading" } });
      let path: string | null;
      try {
        path = await ticketRepo.pickImportFile(shell);
      } catch (e) {
        setImp(token, { phase: "error", message: errText(e) });
        return;
      }
      if (token !== importToken) return;
      if (path === null) {
        get().closeDialog();
        return;
      }
      await get().importFromPath(path);
    },

    async importFromPath(path) {
      const token = ++importToken;
      set({ imp: { ...IMPORT_IDLE, phase: "reading" } });
      try {
        await get().warm(); // 起手三列要在（孤兒帳落到未分類）
        const res = await ticketRepo.readImport(path);
        if (res.missing.length || !res.dump) {
          setImp(token, { phase: "unknown", missing: res.missing.length ? res.missing : ["INOUTCOME"] });
          return;
        }
        const local = await ticketRepo.loadImportLocal();
        const plan = planImport(res.dump, local, { balanceText: {}, nowIso: new Date().toISOString() });
        setImp(token, { phase: "preview", dump: res.dump, local, plan, choices: defaultChoices(plan), balanceText: {} });
      } catch (e) {
        setImp(token, { phase: "error", message: errText(e) });
      }
    },

    setImportBalance(mmAccountUid, text) {
      const imp = get().imp;
      if (!imp.dump || !imp.local) return;
      const balanceText = { ...imp.balanceText, [mmAccountUid]: text };
      const plan = planImport(imp.dump, imp.local, { balanceText, nowIso: new Date().toISOString() });
      const choices: Record<string, ImportChoice> = {};
      for (const c of plan.entries.changed) choices[c.id] = imp.choices[c.id] ?? "theirs";
      set({ imp: { ...imp, balanceText, plan, choices } });
    },

    setImportChoice(entryId, c) {
      const imp = get().imp;
      set({ imp: { ...imp, choices: { ...imp.choices, [entryId]: c } } });
    },

    async runImport() {
      const imp0 = get().imp;
      const plan = imp0.plan;
      if (!plan || plan.unsupported !== null || (imp0.phase !== "preview" && imp0.phase !== "error")) return;
      const token = importToken;
      const choices = imp0.choices;
      setImp(token, { phase: "writing", progress: { done: 0, total: 0 }, message: null });
      try {
        const outcome = await serial(() =>
          ticketRepo.applyImport(plan, choices, (done, total) => setImp(token, { progress: { done, total } })),
        );
        await serial(() => get().refresh());
        const balances = get().balances;
        const after: BalanceCheck[] = plan.checks.map((c) => {
          const actual = balances[c.accountId] ?? 0;
          return { ...c, computedMinor: actual, ok: c.inputMinor === null ? null : c.inputMinor === actual };
        });
        setImp(token, { phase: "done", outcome, after, progress: null });
      } catch (e) {
        setImp(token, { phase: "error", message: errText(e), progress: null });
      }
    },

    /* ───────── 捕捉目的地（§3.10） ───────── */

    async addQuickEntry(input) {
      await get().warm();
      const { row, q, ctx } = await serial(async () => {
        const s = get();
        const qctx: QuickCtx = { accById: s.accById, catById: s.catById, curByCode: s.curByCode, lastAccountId: s.lastAccountId };
        const parsed = parseQuickEntry(input.body, qctx);
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
        return { row: created, q: parsed, ctx: qctx };
      });
      set({ lastAccountId: row.account_id, hasAny: true });
      if (get().ready) await serial(() => get().refresh());
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
  };
});
