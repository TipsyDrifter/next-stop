/**
 * 售票口線・純函式層（車次①契約 §4；甲席 Stage 0 介面先行＝全文實作）。
 *
 * 鐵則：**零 import**、只用可剝除語法（不用 enum／namespace／參數屬性）——
 * `scripts/tests/ticket-logic.test.ts` 以 node 直接載入本檔跑單元測試。
 * 金額一律**最小單位整數**；字串 → 整數走十進位解析、換算走 BigInt 有理數（不經浮點，契約 0-31）。
 * 日期 key 一律 `YYYY-MM-DD` 字串、本地日期運算不經 `Date.parse`；時刻是 UTC ISO（toISOString 24 字元）。
 * lib 目標 ES2020：不用 ES2022＋ 的陣列／字串／物件新方法（契約 §2 施工通則列的四個）。
 *
 * 內容：
 *   §4.1 型別與常數（起手三列的 id 為 uuid v5 字面值，契約 §3.3）
 *   §4.2 id 與金額解析（自帶同步 SHA-1＋uuid v5，契約 0-20）
 *   §4.3 一筆帳的推導與驗證
 *   §4.4 顯示與彙總
 *   §4.5 分類與帳戶
 *   §4.6 捕捉框一行語法 `parseQuickEntry`（0-7、0-29）
 *   §4.7 匯入計畫（①b；0-19、0-22～0-24）
 */

/* ───────────────────────── §4.1 型別與常數 ───────────────────────── */

export const TICKET_ID_NAMESPACE = "cdc61c88-3667-5997-905f-249dff80a6b7";
export const MAIN_CURRENCY = "TWD";
export const MAIN_SYMBOL = "NT$";
export const CURRENCY_TWD_ID = "0fd3bc2e-78d6-5e66-8e08-42d0006b659c";
export const UNCAT_INCOME_ID = "aa25f94b-7093-5bd4-afe2-e3266219e74d";
export const UNCAT_EXPENSE_ID = "a6006f3b-a58a-502f-8164-98305b88fd1c";
export const UNCAT_NAME = "未分類";
export const UNCAT_POSITION = 9999;
export const IMPORT_SOURCE_MM = "moneymanager";
export const IMPORT_CHUNK = 200; // 0-21
export const TICKET_MM_DIFF_DEFAULT: "A" | "B" = "A"; // 0-23；未證實
export const SOLVE_MAX = 22; // 0-23 窮舉上限
export const MAX_MINOR = 9_000_000_000_000_000; // 0-31（< Number.MAX_SAFE_INTEGER）

export type EntryKind = "income" | "expense" | "transfer" | "adjust";
export type CategoryKind = "income" | "expense";
export type AccountGroup =
  | "cash"
  | "bank"
  | "card"
  | "debit"
  | "deposit"
  | "emoney"
  | "investment"
  | "lent"
  | "credit"
  | "loan"
  | "insurance"
  | "other";
export type Prefix = "" | "＋" | "⇄" | "±";

/** 0-19：財務管家的 11 群組依其順序＋lent；mmName＝財務管家的群組名（匯入對應用） */
export const ACCOUNT_GROUPS: readonly { key: AccountGroup; label: string; liability: boolean; mmName: string | null }[] = [
  { key: "cash", label: "現金", liability: false, mmName: "現金" },
  { key: "bank", label: "帳戶", liability: false, mmName: "帳戶" },
  { key: "card", label: "信用卡", liability: true, mmName: "信用卡" },
  { key: "debit", label: "簽帳卡", liability: false, mmName: "扣帳卡" },
  { key: "deposit", label: "定存", liability: false, mmName: "定期存款" },
  { key: "emoney", label: "電子支付", liability: false, mmName: "電子貨幣" },
  { key: "investment", label: "投資", liability: false, mmName: "投資" },
  { key: "lent", label: "借出／應收", liability: false, mmName: null },
  { key: "credit", label: "信用額度", liability: true, mmName: "信用額度" },
  { key: "loan", label: "貸款", liability: true, mmName: "貸款" },
  { key: "insurance", label: "保險", liability: false, mmName: "保險" },
  { key: "other", label: "其他", liability: false, mmName: "其他" },
];

/** 新幣別／匯入幣別的預設顯示名；查不到＝代碼本身（0-14） */
export const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  TWD: "新台幣",
  USD: "美元",
  CNY: "人民幣",
  JPY: "日圓",
  EUR: "歐元",
  HKD: "港幣",
  KRW: "韓元",
  GBP: "英鎊",
};

/* ── 列型別（＝ SQLite 列；沒有同步預備的 account_id，0-13） ── */
export interface TkSyncCols {
  device_id: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
}
export interface CurrencyRow extends TkSyncCols {
  id: string;
  code: string;
  name: string;
  decimals: number;
  rate_to_main: string;
  is_main: number;
  position: number;
}
/** group_key 是 string 不是 AccountGroup：別台新版 App 可能寫來不認得的值，顯示端一律當 other */
export interface AccountRow extends TkSyncCols {
  id: string;
  name: string;
  group_key: string;
  currency: string;
  position: number;
  archived_at: string | null;
}
export interface CategoryRow extends TkSyncCols {
  id: string;
  kind: CategoryKind;
  name: string;
  parent_id: string | null;
  position: number;
  archived_at: string | null;
}
export interface EntryRow extends TkSyncCols {
  id: string;
  kind: EntryKind;
  occurred_on: string;
  occurred_at: string;
  account_id: string;
  to_account_id: string | null;
  category_id: string | null;
  amount_minor: number;
  currency: string;
  main_minor: number;
  account_minor: number;
  to_amount_minor: number | null;
  note: string;
  route_id: string | null;
  /** 第③階段（③契約 0-3）：哪條定期規則記的（或被「設成定期」連上的）；不設外鍵、不進 entryDiffCols */
  repeat_id: string | null;
  import_id: string | null;
  import_source: string | null;
  import_utime: number | null;
}

/**
 * 第③階段的兩張表（③契約 §3.3；與 SQLite 列逐字相同）。定義在本檔而不是 ticketPlan.ts：
 * ImportLocal 要用、本檔又「零 import」（③契約 0-10 不准反向 import）——ticketPlan.ts 原樣 re-export。
 */
export interface BudgetRow extends TkSyncCols {
  id: string;
  kind: "total" | "category";
  category_id: string | null;
  month: string | null; // NULL＝預設；"YYYY-MM"＝該月覆寫
  amount_minor: number; // 主幣別
  position: number;
  import_id: string | null;
  import_source: string | null;
  import_utime: number | null;
}
export interface RepeatRow extends TkSyncCols {
  id: string;
  kind: "income" | "expense" | "transfer";
  account_id: string;
  to_account_id: string | null;
  category_id: string | null;
  amount_minor: number; // 原幣
  currency: string;
  note: string;
  route_id: string | null;
  rule: string; // FixedRepeatRule 的 JSON
  hhmm: string;
  next_on: string | null; // 游標（可回退、不是真相）
  paused_at: string | null;
  skipped_days: string; // JSON 陣列
  position: number;
  import_id: string | null;
  import_source: string | null;
  import_utime: number | null;
}

/** 起手三列（不含時間戳；§3.3） */
export const STARTER_CURRENCY: Readonly<
  Pick<CurrencyRow, "id" | "code" | "name" | "decimals" | "rate_to_main" | "is_main" | "position">
> = {
  id: CURRENCY_TWD_ID,
  code: "TWD",
  name: "新台幣",
  decimals: 2,
  rate_to_main: "1",
  is_main: 1,
  position: 0,
};
export const STARTER_CATEGORIES: readonly Readonly<Pick<CategoryRow, "id" | "kind" | "name" | "parent_id" | "position">>[] = [
  { id: UNCAT_INCOME_ID, kind: "income", name: UNCAT_NAME, parent_id: null, position: UNCAT_POSITION },
  { id: UNCAT_EXPENSE_ID, kind: "expense", name: UNCAT_NAME, parent_id: null, position: UNCAT_POSITION },
];

/* ── 寫入輸入 ── */
export interface AmountOverride {
  mainMinor?: number;
  accountMinor?: number;
  toAmountMinor?: number;
}
export interface NewEntryInput {
  kind: "income" | "expense" | "transfer"; // adjust 只經 adjustRow（期初、調整餘額、匯入）
  amountMinor: number;
  currency: string;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  occurredOn: string;
  occurredAt: string;
  note: string;
  routeId: string | null;
  override?: AmountOverride;
}
export type EntryPatch = Partial<Omit<NewEntryInput, "override">> & { override?: AmountOverride };
export interface EntryCtx {
  accById: Readonly<Record<string, AccountRow>>;
  catById: Readonly<Record<string, CategoryRow>>;
  curByCode: Readonly<Record<string, CurrencyRow>>;
}
/** 新票表單的草稿（兩殼共用；store 持有） */
export interface EntryDraft {
  kind: "expense" | "income" | "transfer";
  amountText: string; // 照主人打的字；expense 可帶 - 號（退款）
  currency: string; // 收支可換；transfer 恆＝轉出帳戶幣別
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  dayKey: string; // YYYY-MM-DD（本地）
  time: string; // HH:MM（本地）
  note: string;
  routeId: string | null;
  mainOverrideText: string | null; // 手改「≈ NT$」那一欄；null＝自動
  toAmountText: string | null; // 不同幣別轉帳的「轉入金額」；null＝自動
}

/* ── 顯示 ── */
export interface DayGroup {
  dayKey: string;
  label: string;
  expense: number; // 主幣別
  income: number; // 主幣別
  entries: EntryRow[];
}
export interface RowAmount {
  prefix: Prefix;
  minor: number;
  currency: string;
  convMain: number | null;
}

/* ── 匯入（Rust `ticket_import_read` 的回傳，欄名與 mmbak.rs 的 serde 逐字相同） ── */
export interface MmbakReadResult {
  missing: string[];
  dump: MmbakDump | null;
}
export interface MmbakDump {
  file_name: string;
  currencies: MmCurrency[];
  groups: MmGroup[];
  accounts: MmAccount[];
  categories: MmCategory[];
  transactions: MmTx[];
  /** 第③階段（③契約 §3.6、0-17）：三張表缺欄 ⇒ 對應陣列 null、plan_missing 列「表.欄」。舊版 Rust 不送這四欄（執行期 undefined，讀的人一律 ?? 退回） */
  budgets: MmBudget[] | null;
  budget_amounts: MmBudgetAmount[] | null;
  repeats: MmRepeat[] | null;
  plan_missing: string[];
}
export interface MmCurrency {
  uid: string;
  iso: string;
  is_main: boolean;
  rate: string;
  decimals: number;
}
export interface MmGroup {
  uid: string;
  type_code: number | null;
  name: string;
}
export interface MmAccount {
  uid: string;
  name: string;
  group_uid: string | null;
  currency_uid: string | null;
  is_del: boolean;
}
export interface MmCategory {
  uid: string;
  type_code: number;
  name: string;
  parent_uid: string | null;
  status: number;
  is_del: boolean;
}
export interface MmTx {
  uid: string;
  do_type: string;
  asset_uid: string | null;
  to_asset_uid: string | null;
  tx_uid_trans: string | null;
  ctg_uid: string | null;
  /** **帳戶幣別**的金額（不是原幣）；外幣列 `zmoney / in_zmoney ＝ 備份匯率`，台幣列兩者相等 */
  zmoney: string;
  currency_uid: string | null;
  wdate: string;
  zdate: string;
  content: string;
  utime: number;
  is_del: boolean;
  /** 交易幣別（`currency_uid`）**原幣**的金額；備份沒有 `IN_ZMONEY` 欄或這列為 NULL ⇒ null */
  in_zmoney: string | null;
}
/** Rust MmbakDump 的三個新陣列（第③階段，③契約 §4.1；欄名與 mmbak.rs 逐字相同） */
export interface MmBudget {
  uid: string;
  target_uid: string | null;
  do_type: number;
  period_type: number;
  is_total: boolean;
  is_del: boolean;
  transfer_type: number;
  modify_date: number;
}
export interface MmBudgetAmount {
  uid: string;
  budget_uid: string;
  is_del: boolean;
  amount: string;
  budget_period: number;
  modify_date: number;
}
export interface MmRepeat {
  uid: string;
  is_del: boolean;
  usetime: number;
  end_date: number;
  next_date: number;
  do_type: number;
  repeat_type: number;
  asset_uid: string | null;
  to_asset_uid: string | null;
  ctg_uid: string | null;
  currency_uid: string | null;
  amount_sub: string;
  memo: string;
  payee: string;
}
/** 六張表含墓碑的全部列（planImport 的 local；budgets／repeats 是第③階段加的，planImport 本身不讀） */
export interface ImportLocal {
  currencies: CurrencyRow[];
  accounts: AccountRow[];
  categories: CategoryRow[];
  entries: EntryRow[];
  budgets: BudgetRow[];
  repeats: RepeatRow[];
}
export type ImportChoice = "theirs" | "ours";
export interface ImportChange {
  id: string;
  local: EntryRow;
  incoming: EntryRow;
  cols: string[];
}
export interface BalanceCheck {
  mmUid: string;
  name: string;
  accountId: string;
  currency: string;
  inputMinor: number | null;
  computedMinor: number;
  ok: boolean | null;
}
export interface ImportPlan {
  summary: { accounts: number; categories: number; transactions: number; from: string | null; to: string | null };
  unsupported: string | null;
  currencies: CurrencyRow[]; // 要新建的完整列
  accounts: AccountRow[];
  categories: CategoryRow[]; // 父先子後
  accountIdOf: Record<string, string>; // 財務管家帳戶 uid → 本機帳戶 id
  categoryIdOf: Record<string, string>; // 財務管家分類 uid → 本機分類 id（第③階段：預算與定期規則的分類對應，③契約 0-12）
  entries: {
    inserts: EntryRow[];
    changed: ImportChange[];
    unchanged: number;
    tombstoned: number;
    invalid: { uid: string; reason: string }[];
  };
  extraLocal: number; // Next Stop 有、備份沒有 K
  adjust: { total: number; plus: number; minus: number; rule: "A" | "B" | "solved" | "default" };
  checks: BalanceCheck[];
}
export interface ImportOutcome {
  inserted: number;
  updated: number;
  skipped: number;
  budgets: number; // 第③階段（③契約 §3.4）：寫入的預算列數（新增＋更新）
  repeats: number; // 第③階段：寫入的規則數（新增＋更新）
}

/** 換算只需要的幣別欄（匯入時用備份匯率組的假列也能餵） */
type CurLike = Pick<CurrencyRow, "code" | "decimals" | "rate_to_main" | "is_main">;

/* ───────────────────────── §4.2 id 與金額解析 ───────────────────────── */

/** 同步 SHA-1（FIPS 180-4）；只給 uuid v5 用 */
function sha1(msg: Uint8Array): Uint8Array {
  const ml = msg.length;
  const total = ((ml + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(ml / 0x20000000)); // 位元長度高 32 位（ml*8 / 2^32）
  dv.setUint32(total - 4, (ml * 8) >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0);
  odv.setUint32(4, h1);
  odv.setUint32(8, h2);
  odv.setUint32(12, h3);
  odv.setUint32(16, h4);
  return out;
}

/** uuid v5（RFC 4122 §4.3）：同步、零 import（name 以全域 TextEncoder 編成 UTF-8） */
export function uuidV5(ns: string, name: string): string {
  const hex = ns.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new RangeError(`uuidV5：命名空間不是 uuid：${ns}`);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const b = sha1(input).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

export function ticketId(name: string): string {
  return uuidV5(TICKET_ID_NAMESPACE, name);
}

const FULLWIDTH_MAP: Readonly<Record<string, string>> = {
  "＋": "+",
  "－": "-",
  "．": ".",
  "，": ",",
  "＠": "@",
  "　": " ",
  "−": "-",
};

/** 全形 `０-９＋－．，＠` 與全形空白轉半形；`−`（U+2212）轉 `-` */
export function normalizeInput(s: string): string {
  return s.replace(/[０-９＋－．，＠　−]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xff10 + 48);
    return FULLWIDTH_MAP[ch] ?? ch;
  });
}

const MAX_MINOR_BIG = BigInt(MAX_MINOR);
const TEN = BigInt(10);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

function pow10(n: number): bigint {
  let r = ONE;
  for (let i = 0; i < n; i++) r *= TEN;
  return r;
}

/** BigInt → number（帶上限檢查；−0 一律回 0） */
function bigToMinor(v: bigint): number {
  const abs = v < ZERO ? -v : v;
  if (abs > MAX_MINOR_BIG) throw new RangeError("金額太大了");
  if (abs === ZERO) return 0;
  return v < ZERO ? -Number(abs) : Number(abs);
}

/** 十進位字串 → 最小單位整數（全程字串／BigInt，不經浮點） */
export function minorFromDecimal(text: string, decimals: number, mode: "strict" | "round", code?: string): number {
  const s = normalizeInput(text).trim().replace(/,/g, "");
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError("金額請填數字，例如 80 或 12.5");
  const neg = m[1] === "-";
  const intPart = m[2];
  let frac = m[3] ?? "";
  let bump = false;
  if (frac.length > decimals) {
    if (mode === "strict") {
      const label = code ?? "這個幣別";
      throw new RangeError(decimals === 0 ? `${label} 不能有小數點` : `${label} 最多 ${decimals} 位小數`);
    }
    bump = frac.charCodeAt(decimals) >= 53; // 下一位 ≥ '5' ⇒ 絕對值進位（遠離零）
    frac = frac.slice(0, decimals);
  }
  while (frac.length < decimals) frac += "0";
  let abs = BigInt(intPart + frac);
  if (bump) abs += ONE;
  return bigToMinor(neg ? -abs : abs);
}

export function parseAmount(
  text: string,
  cur: { code: string; decimals: number },
  opts: { allowNegative: boolean; allowZero?: boolean },
): number {
  if (normalizeInput(text).trim() === "") throw new RangeError("先填金額");
  const v = minorFromDecimal(text, cur.decimals, "strict", cur.code);
  if (v === 0 && !opts.allowZero) throw new RangeError("金額不能是 0");
  if (v < 0 && !opts.allowNegative) throw new RangeError("收入和轉帳金額要大於 0");
  return v;
}

const RATE_ERR = "匯率要大於 0";

/** 匯率字串正規化（`"4.350"→"4.35"`、`"031"→"31"`、`"1.0"→"1"`）；不合 ⇒ RangeError */
export function parseRate(text: string): string {
  const s = normalizeInput(text).trim();
  const m = /^(\d+)(?:\.(\d{1,10}))?$/.exec(s);
  if (!m) throw new RangeError(RATE_ERR);
  const intPart = m[1].replace(/^0+(?=\d)/, "");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (/^0+$/.test(intPart) && frac === "") throw new RangeError(RATE_ERR);
  return frac ? `${intPart}.${frac}` : intPart;
}

/**
 * 匯入用的容錯匯率：備份的 RATE 是 REAL，Rust 端 CAST 出來常超過 10 位小數（`"0.210526315789474"`），
 * 也防一手科學記號——先絕對值半進位到 10 位小數再交給 `parseRate`；進位後是 0 或看不懂 ⇒ RangeError
 */
export function importRate(text: string): string {
  const s = normalizeInput(text).trim();
  const m = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/.exec(s);
  if (!m) throw new RangeError(RATE_ERR);
  let digits = m[1] + (m[2] ?? "");
  let point = m[1].length + (m[3] ? Number(m[3]) : 0); // 小數點在 digits 的第幾位之後
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  while (digits.length < point) digits += "0";
  const intPart = digits.slice(0, point) || "0";
  const frac = digits.slice(point);
  if (frac.length <= 10) return parseRate(frac ? `${intPart}.${frac}` : intPart);
  let v = BigInt(intPart + frac.slice(0, 10));
  if (frac.charCodeAt(10) >= 53) v += ONE;
  const str = v.toString().padStart(11, "0");
  return parseRate(`${str.slice(0, -10)}.${str.slice(-10)}`);
}

/** 匯率字串 → 有理數 [分子, 分母]（不做 > 0 檢查以外的正規化） */
function rateFrac(rate: string): [bigint, bigint] {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m) throw new RangeError(RATE_ERR);
  const frac = m[2] ?? "";
  const num = BigInt(m[1] + frac);
  if (num === ZERO) throw new RangeError(RATE_ERR);
  return [num, pow10(frac.length)];
}

/** n／d 四捨五入（絕對值半進位＝遠離零）；d > 0 */
function roundDiv(n: bigint, d: bigint): bigint {
  const neg = n < ZERO;
  const a = neg ? -n : n;
  let q = a / d;
  const r = a % d;
  if (r * TWO >= d) q += ONE;
  return neg ? -q : q;
}

/** amount × from.rate ÷ to.rate × 10^(to.decimals − from.decimals)；BigInt 有理數、絕對值半進位 */
export function convertMinor(
  amount: number,
  from: { decimals: number; rate_to_main: string },
  to: { decimals: number; rate_to_main: string },
): number {
  if (from.decimals === to.decimals && from.rate_to_main === to.rate_to_main) return amount;
  const [fn, fd] = rateFrac(from.rate_to_main);
  const [tn, td] = rateFrac(to.rate_to_main);
  let num = BigInt(amount) * fn * td;
  let den = fd * tn;
  const shift = to.decimals - from.decimals;
  if (shift >= 0) num *= pow10(shift);
  else den *= pow10(-shift);
  return bigToMinor(roundDiv(num, den));
}

/** trim、轉大寫；`^[A-Z]{3}$` 否則 RangeError */
export function currencyCode(text: string): string {
  const s = text.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw new RangeError("幣別代碼是 3 個英文字母（如 TWD）");
  return s;
}

/* ───────────────────────── §4.3 一筆帳的推導與驗證 ───────────────────────── */

const FALLBACK_MAIN: CurLike = { code: MAIN_CURRENCY, decimals: 2, rate_to_main: "1", is_main: 1 };

/** 主幣別（is_main＝1 的那個；沒有就找 TWD；再沒有用預設） */
function mainOf(curByCode: Readonly<Record<string, CurLike>>): CurLike {
  for (const k of Object.keys(curByCode)) if (curByCode[k].is_main === 1) return curByCode[k];
  return curByCode[MAIN_CURRENCY] ?? FALLBACK_MAIN;
}

function curOrThrow(curByCode: Readonly<Record<string, CurLike>>, code: string): CurLike {
  const c = curByCode[code];
  if (!c) throw new RangeError(`沒有這個幣別：${code}`);
  return c;
}

/** 原幣 → 主幣別與帳戶幣別（Plan v3 §二折算規則；transfer 的轉入額另算） */
function convAmounts(
  amount: number,
  curCode: string,
  accCode: string,
  curByCode: Readonly<Record<string, CurLike>>,
  override?: AmountOverride,
): { main: number; account: number } {
  const cur = curOrThrow(curByCode, curCode);
  const acc = curOrThrow(curByCode, accCode);
  const main = mainOf(curByCode);
  const mainMinor = override?.mainMinor ?? (cur.is_main === 1 ? amount : convertMinor(amount, cur, main));
  const accountMinor =
    cur.code === acc.code ? amount : acc.is_main === 1 ? mainMinor : (override?.accountMinor ?? convertMinor(amount, cur, acc));
  return { main: mainMinor, account: accountMinor };
}

export function deriveAmounts(a: {
  kind: EntryKind;
  amountMinor: number;
  currency: string;
  account: AccountRow;
  toAccount: AccountRow | null;
  curByCode: Readonly<Record<string, CurLike>>;
  override?: AmountOverride;
}): { main_minor: number; account_minor: number; to_amount_minor: number | null } {
  if (a.kind === "transfer" && a.currency !== a.account.currency) throw new RangeError("轉帳幣別會跟著轉出帳戶");
  const { main, account } = convAmounts(a.amountMinor, a.currency, a.account.currency, a.curByCode, a.override);
  let toAmount: number | null = null;
  if (a.kind === "transfer") {
    if (!a.toAccount) throw new RangeError("選一個轉入帳戶");
    if (a.toAccount.currency === a.account.currency) toAmount = a.amountMinor;
    else {
      const acc = curOrThrow(a.curByCode, a.account.currency);
      const toAcc = curOrThrow(a.curByCode, a.toAccount.currency);
      toAmount = a.override?.toAmountMinor ?? convertMinor(a.amountMinor, acc, toAcc);
    }
  }
  return { main_minor: main, account_minor: account, to_amount_minor: toAmount };
}

function uncatIdOf(kind: CategoryKind): string {
  return kind === "income" ? UNCAT_INCOME_ID : UNCAT_EXPENSE_ID;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 合併後的一筆（驗證與推導的共同輸入；kind 可為 adjust＝改舊的精算票） */
interface Merged {
  kind: EntryKind;
  amountMinor: number;
  currency: string;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  occurredOn: string;
  occurredAt: string;
  note: string;
  routeId: string | null;
}

/** 驗證（契約 §4.3 錯誤表）；回正規化後的帳戶、轉入帳戶、分類 id */
function validate(m: Merged, ctx: EntryCtx): { account: AccountRow; toAccount: AccountRow | null; categoryId: string | null } {
  if (!Number.isInteger(m.amountMinor)) throw new RangeError("金額請填數字，例如 80 或 12.5");
  if (m.amountMinor === 0) throw new RangeError("金額不能是 0");
  if (Math.abs(m.amountMinor) > MAX_MINOR) throw new RangeError("金額太大了");
  if (m.amountMinor < 0 && (m.kind === "income" || m.kind === "transfer")) throw new RangeError("收入和轉帳金額要大於 0");
  if (!m.accountId) throw new RangeError("選一個帳戶");
  const account = ctx.accById[m.accountId];
  if (!account || account.deleted_at !== null) throw new RangeError("這個帳戶已經刪除了");
  curOrThrow(ctx.curByCode, m.currency);
  if (!DAY_RE.test(m.occurredOn)) throw new RangeError("日期格式有誤");
  let toAccount: AccountRow | null = null;
  let categoryId: string | null = null;
  if (m.kind === "transfer") {
    if (!m.toAccountId) throw new RangeError("選一個轉入帳戶");
    toAccount = ctx.accById[m.toAccountId] ?? null;
    if (!toAccount || toAccount.deleted_at !== null) throw new RangeError("這個帳戶已經刪除了");
    if (toAccount.id === account.id) throw new RangeError("轉出和轉入不能是同一個帳戶");
    if (m.currency !== account.currency) throw new RangeError("轉帳幣別會跟著轉出帳戶");
  } else if (m.kind === "income" || m.kind === "expense") {
    categoryId = m.categoryId ?? uncatIdOf(m.kind);
    const cat = ctx.catById[categoryId];
    if (cat && cat.kind !== m.kind) throw new RangeError("這個分類不屬於目前的收支類型");
    // 未分類是起手列，ctx 裡沒有也照用（sqlite 端 ensureStarterRows 保證在）；其餘分類必須在
    if (!cat && categoryId !== uncatIdOf(m.kind)) throw new RangeError("這個分類已經刪除了");
    if (cat && cat.deleted_at !== null) throw new RangeError("這個分類已經刪除了");
  }
  return { account, toAccount, categoryId };
}

export function buildEntryRow(input: NewEntryInput, ctx: EntryCtx, meta: { id: string; nowIso: string }): EntryRow {
  const m: Merged = {
    kind: input.kind,
    amountMinor: input.amountMinor,
    currency: input.currency,
    accountId: input.accountId,
    toAccountId: input.kind === "transfer" ? input.toAccountId : null,
    categoryId: input.kind === "transfer" ? null : input.categoryId,
    occurredOn: input.occurredOn,
    occurredAt: input.occurredAt,
    note: input.note,
    routeId: input.routeId,
  };
  const v = validate(m, ctx);
  const amt = deriveAmounts({
    kind: m.kind,
    amountMinor: m.amountMinor,
    currency: m.currency,
    account: v.account,
    toAccount: v.toAccount,
    curByCode: ctx.curByCode,
    override: input.override,
  });
  return {
    id: meta.id,
    kind: m.kind,
    occurred_on: m.occurredOn,
    occurred_at: m.occurredAt,
    account_id: v.account.id,
    to_account_id: v.toAccount ? v.toAccount.id : null,
    category_id: v.categoryId,
    amount_minor: m.amountMinor,
    currency: m.currency,
    main_minor: amt.main_minor,
    account_minor: amt.account_minor,
    to_amount_minor: amt.to_amount_minor,
    note: m.note,
    route_id: m.routeId,
    repeat_id: null,
    import_id: null,
    import_source: null,
    import_utime: null,
    device_id: null,
    created_at: meta.nowIso,
    updated_at: meta.nowIso,
    synced_at: null,
    deleted_at: null,
  };
}

/** 資料欄（diff 用；不含時間戳與同步欄） */
const ENTRY_DATA_COLS = [
  "kind",
  "occurred_on",
  "occurred_at",
  "account_id",
  "to_account_id",
  "category_id",
  "amount_minor",
  "currency",
  "main_minor",
  "account_minor",
  "to_amount_minor",
  "note",
  "route_id",
] as const;

/** 合併 → 驗證 → 改到金額／幣別／帳戶／轉入帳戶／kind／override 才以當下匯率重算三個折算欄（0-30） */
export function applyEntryPatch(
  row: EntryRow,
  patch: EntryPatch,
  ctx: EntryCtx,
  nowIso: string,
): { row: EntryRow; cols: Record<string, unknown> } {
  if (row.deleted_at !== null) throw new RangeError("這一筆已經刪除了");
  if (row.kind === "adjust" && patch.kind !== undefined) {
    throw new RangeError("「精算」紀錄不能改收支類型");
  }
  const kind: EntryKind = patch.kind ?? row.kind;
  const accountId = patch.accountId ?? row.account_id;
  let currency = patch.currency ?? row.currency;
  let toAccountId = patch.toAccountId !== undefined ? patch.toAccountId : row.to_account_id;
  let categoryId = patch.categoryId !== undefined ? patch.categoryId : row.category_id;
  if (kind === "transfer") {
    categoryId = null;
    // 轉帳的幣別跟著轉出帳戶：這次換了帳戶或類型、又沒明講幣別才自動跟（只改備註等不准偷換幣別）
    if (patch.currency === undefined && (patch.accountId !== undefined || patch.kind !== undefined)) {
      const acc = ctx.accById[accountId];
      if (acc) currency = acc.currency;
    }
  } else {
    toAccountId = null;
    if (kind === "income" || kind === "expense") {
      // 分類缺 ⇒ 未分類；換了收支類型、又沒帶新分類：原分類若是別的類型 ⇒ 換成這個類型的未分類
      const cat = categoryId ? ctx.catById[categoryId] : null;
      const otherUncat = categoryId === uncatIdOf(kind === "income" ? "expense" : "income");
      if (categoryId === null || (patch.categoryId === undefined && (otherUncat || (cat && cat.kind !== kind)))) {
        categoryId = uncatIdOf(kind);
      }
    }
  }
  const m: Merged = {
    kind,
    amountMinor: patch.amountMinor ?? row.amount_minor,
    currency,
    accountId,
    toAccountId,
    categoryId,
    occurredOn: patch.occurredOn ?? row.occurred_on,
    occurredAt: patch.occurredAt ?? row.occurred_at,
    note: patch.note ?? row.note,
    routeId: patch.routeId !== undefined ? patch.routeId : row.route_id,
  };
  const v = validate(m, ctx);
  const recompute =
    patch.amountMinor !== undefined ||
    patch.currency !== undefined ||
    patch.accountId !== undefined ||
    patch.toAccountId !== undefined ||
    patch.kind !== undefined ||
    patch.override !== undefined ||
    m.currency !== row.currency; // 幣別真的換了就一定重算，不准只改 currency 欄
  let mainMinor = row.main_minor;
  let accountMinor = row.account_minor;
  let toAmountMinor = row.to_amount_minor;
  if (recompute) {
    const amt = deriveAmounts({
      kind: m.kind,
      amountMinor: m.amountMinor,
      currency: m.currency,
      account: v.account,
      toAccount: v.toAccount,
      curByCode: ctx.curByCode,
      override: patch.override,
    });
    mainMinor = amt.main_minor;
    accountMinor = amt.account_minor;
    toAmountMinor = amt.to_amount_minor;
  }
  const next: EntryRow = {
    ...row,
    kind: m.kind,
    occurred_on: m.occurredOn,
    occurred_at: m.occurredAt,
    account_id: v.account.id,
    to_account_id: v.toAccount ? v.toAccount.id : null,
    category_id: v.categoryId,
    amount_minor: m.amountMinor,
    currency: m.currency,
    main_minor: mainMinor,
    account_minor: accountMinor,
    to_amount_minor: toAmountMinor,
    note: m.note,
    route_id: m.routeId,
  };
  const cols: Record<string, unknown> = {};
  for (const c of ENTRY_DATA_COLS) if (next[c] !== row[c]) cols[c] = next[c];
  if (Object.keys(cols).length === 0) return { row, cols: {} };
  cols.updated_at = nowIso;
  next.updated_at = nowIso;
  return { row: next, cols };
}

export function draftToInput(d: EntryDraft, ctx: EntryCtx, dayStartHour: number): NewEntryInput {
  if (!d.accountId) throw new RangeError("選一個帳戶");
  const account = ctx.accById[d.accountId];
  if (!account || account.deleted_at !== null) throw new RangeError("這個帳戶已經刪除了");
  const currency = d.kind === "transfer" ? account.currency : d.currency;
  const cur = curOrThrow(ctx.curByCode, currency);
  const amountMinor = parseAmount(d.amountText, cur, { allowNegative: d.kind === "expense" });
  const occurredAt = atOf(d.dayKey, d.time, dayStartHour);
  const override: AmountOverride = {};
  if (d.mainOverrideText !== null && d.mainOverrideText.trim() !== "") {
    override.mainMinor = parseAmount(d.mainOverrideText, mainOf(ctx.curByCode), { allowNegative: d.kind === "expense" });
  }
  if (d.kind === "transfer" && d.toAmountText !== null && d.toAmountText.trim() !== "" && d.toAccountId) {
    const toAcc = ctx.accById[d.toAccountId];
    if (toAcc) override.toAmountMinor = parseAmount(d.toAmountText, curOrThrow(ctx.curByCode, toAcc.currency), { allowNegative: false });
  }
  const input: NewEntryInput = {
    kind: d.kind,
    amountMinor,
    currency,
    accountId: d.accountId,
    toAccountId: d.kind === "transfer" ? d.toAccountId : null,
    categoryId: d.kind === "transfer" ? null : d.categoryId,
    occurredOn: d.dayKey,
    occurredAt,
    note: d.note,
    routeId: d.routeId,
  };
  if (override.mainMinor !== undefined || override.toAmountMinor !== undefined) input.override = override;
  return input;
}

/** 一筆精算（期初、調整餘額）：currency＝帳戶幣別、account_minor＝amountMinor、無分類 */
export function adjustRow(a: {
  account: AccountRow;
  amountMinor: number;
  occurredOn: string;
  nowIso: string;
  note: string;
  id: string;
  curByCode: Readonly<Record<string, CurLike>>;
}): EntryRow {
  if (!Number.isInteger(a.amountMinor)) throw new RangeError("金額請填數字，例如 80 或 12.5");
  if (Math.abs(a.amountMinor) > MAX_MINOR) throw new RangeError("金額太大了");
  const acc = curOrThrow(a.curByCode, a.account.currency);
  const main = mainOf(a.curByCode);
  return {
    id: a.id,
    kind: "adjust",
    occurred_on: a.occurredOn,
    occurred_at: a.nowIso,
    account_id: a.account.id,
    to_account_id: null,
    category_id: null,
    amount_minor: a.amountMinor,
    currency: a.account.currency,
    main_minor: acc.is_main === 1 ? a.amountMinor : convertMinor(a.amountMinor, acc, main),
    account_minor: a.amountMinor,
    to_amount_minor: null,
    note: a.note,
    route_id: null,
    repeat_id: null,
    import_id: null,
    import_source: null,
    import_utime: null,
    device_id: null,
    created_at: a.nowIso,
    updated_at: a.nowIso,
    synced_at: null,
    deleted_at: null,
  };
}

/** 差＝0 ⇒ null；否則 target − current */
export function planAdjust(currentMinor: number, targetMinor: number): number | null {
  const d = targetMinor - currentMinor;
  return d === 0 ? null : d;
}

/* ───────────────────────── §4.4 顯示與彙總 ───────────────────────── */

const MINUS = "−";

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 有分才顯示小數、顯示就補滿；whole ⇒ 絕對值半進位到整數主單位；負號 `−`（U+2212） */
export function moneyText(minor: number, decimals: number, opts?: { prefix?: Prefix; whole?: boolean }): string {
  const neg = minor < 0;
  const digits = String(Math.abs(minor)).padStart(decimals + 1, "0");
  let int = decimals > 0 ? digits.slice(0, digits.length - decimals) : digits;
  const frac = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  let body: string;
  if (opts?.whole) {
    if (frac !== "" && frac.charCodeAt(0) >= 53) int = (BigInt(int) + ONE).toString();
    body = groupThousands(int);
  } else {
    body = /^0*$/.test(frac) ? groupThousands(int) : `${groupThousands(int)}.${frac}`;
  }
  const zero = /^[0,.]*$/.test(body);
  return `${opts?.prefix ?? ""}${neg && !zero ? MINUS : ""}${body}`;
}

/** 正 `＋`、負 `−`（toast 用） */
export function signedText(minor: number, decimals: number): string {
  return minor > 0 ? `＋${moneyText(minor, decimals)}` : moneyText(minor, decimals);
}

/** toast 的金額＝對餘額的效果：expense `−|x|`（退款＝`＋`）、其他照號 */
export function quickAmountText(kind: EntryKind, minor: number, decimals: number): string {
  return signedText(kind === "expense" ? -minor : minor, decimals);
}

export function rowAmount(e: EntryRow, filterAccountId: string | null, accById: Readonly<Record<string, AccountRow>>): RowAmount {
  const conv = (currency: string, mainMinor: number): number | null => (currency !== MAIN_CURRENCY ? mainMinor : null);
  switch (e.kind) {
    case "income":
      return { prefix: "＋", minor: e.amount_minor, currency: e.currency, convMain: conv(e.currency, e.main_minor) };
    case "expense":
      return { prefix: "", minor: e.amount_minor, currency: e.currency, convMain: conv(e.currency, e.main_minor) };
    case "adjust":
      return { prefix: "±", minor: e.amount_minor, currency: e.currency, convMain: conv(e.currency, e.main_minor) };
    case "transfer": {
      if (filterAccountId !== null && filterAccountId === e.account_id) {
        return { prefix: "⇄", minor: -e.amount_minor, currency: e.currency, convMain: conv(e.currency, -e.main_minor) };
      }
      if (filterAccountId !== null && filterAccountId === e.to_account_id) {
        const cur = (e.to_account_id && accById[e.to_account_id]?.currency) || e.currency;
        return { prefix: "⇄", minor: e.to_amount_minor ?? e.amount_minor, currency: cur, convMain: conv(cur, e.main_minor) };
      }
      return { prefix: "⇄", minor: e.amount_minor, currency: e.currency, convMain: conv(e.currency, e.main_minor) };
    }
  }
}

/** 只算未刪的；Plan v3 §二公式（＝§3.5-3 SQL） */
export function balancesOf(entries: readonly EntryRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (e.deleted_at !== null) continue;
    const d = e.kind === "expense" || e.kind === "transfer" ? -e.account_minor : e.account_minor;
    out[e.account_id] = (out[e.account_id] ?? 0) + d;
    if (e.kind === "transfer" && e.to_account_id) out[e.to_account_id] = (out[e.to_account_id] ?? 0) + (e.to_amount_minor ?? 0);
  }
  return out;
}

export function isLiability(groupKey: string): boolean {
  return groupKey === "card" || groupKey === "credit" || groupKey === "loan";
}

/** 0-31：每帳戶餘額以目前匯率換主幣別；負債群組加到 liability、其餘加到 asset；含封存 */
export function accountTotals(
  accounts: readonly AccountRow[],
  balances: Readonly<Record<string, number>>,
  curByCode: Readonly<Record<string, CurLike>>,
): { asset: number; liability: number; net: number } {
  const main = mainOf(curByCode);
  let asset = 0;
  let liability = 0;
  for (const a of accounts) {
    if (a.deleted_at !== null) continue;
    const bal = balances[a.id] ?? 0;
    const cur = curByCode[a.currency];
    const v = cur && cur.is_main !== 1 ? convertMinor(bal, cur, main) : bal;
    if (isLiability(a.group_key)) liability += v;
    else asset += v;
  }
  return { asset, liability, net: asset + liability };
}

/**
 * 照輸入順序（新到舊）依 occurred_on 分組；expense／income＝當日 main_minor 合計（退款淨額；transfer、adjust 不入）。
 * `filterAccountId` 目前不影響合計（清單已先依篩選取過帳）；留著參數是介面定稿（契約 §4.4）。
 */
export function groupByDay(entries: readonly EntryRow[], filterAccountId: string | null): DayGroup[] {
  void filterAccountId;
  const out: DayGroup[] = [];
  const byDay: Record<string, DayGroup> = {};
  for (const e of entries) {
    let g = byDay[e.occurred_on];
    if (!g) {
      g = { dayKey: e.occurred_on, label: dayLabel(e.occurred_on), expense: 0, income: 0, entries: [] };
      byDay[e.occurred_on] = g;
      out.push(g);
    }
    g.entries.push(e);
    if (e.kind === "expense") g.expense += e.main_minor;
    else if (e.kind === "income") g.income += e.main_minor;
  }
  return out;
}

/** 只有支出 ⇒ "1,230"；有收入 ⇒ "1,230 ＋2,000"；只有收入 ⇒ "＋2,000"；都 0 ⇒ "" */
export function daySubtotalText(g: DayGroup, decimals: number): string {
  const parts: string[] = [];
  if (g.expense !== 0) parts.push(moneyText(g.expense, decimals));
  if (g.income !== 0) parts.push(moneyText(g.income, decimals, { prefix: "＋" }));
  return parts.join(" ");
}

/** 只取 occurred_on 在該月的；口徑同 groupByDay */
export function monthSum(entries: readonly EntryRow[], month: string): { income: number; expense: number } {
  let income = 0;
  let expense = 0;
  for (const e of entries) {
    if (e.deleted_at !== null || monthOf(e.occurred_on) !== month) continue;
    if (e.kind === "income") income += e.main_minor;
    else if (e.kind === "expense") expense += e.main_minor;
  }
  return { income, expense };
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function splitDay(dayKey: string): [number, number, number] {
  const [y, m, d] = dayKey.split("-").map((s) => parseInt(s, 10));
  return [y, m, d];
}

/** "10/8 週四"（M/D＋空白＋週X；本地日期運算） */
export function dayLabel(dayKey: string): string {
  const [y, m, d] = splitDay(dayKey);
  return `${m}/${d} 週${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
}

/** "2026 年 10 月" */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map((s) => parseInt(s, 10));
  return `${y} 年 ${m} 月`;
}

export function monthOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map((s) => parseInt(s, 10));
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = t - ny * 12 + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

export function monthRange(month: string): { from: string; toExcl: string } {
  return { from: `${month}-01`, toExcl: `${addMonths(month, 1)}-01` };
}

/** "No.MMDD-nn"：同日依 (occurred_at, created_at, id) 遞增排，取 1 起的序號 */
export function serialOf(e: EntryRow, sameDay: readonly EntryRow[]): string {
  const sorted = sameDay
    .filter((x) => x.occurred_on === e.occurred_on)
    .slice()
    .sort((a, b) => cmpStr(a.occurred_at, b.occurred_at) || cmpStr(a.created_at, b.created_at) || cmpStr(a.id, b.id));
  let idx = sorted.findIndex((x) => x.id === e.id);
  if (idx < 0) idx = sorted.length;
  const mmdd = e.occurred_on.slice(5, 7) + e.occurred_on.slice(8, 10);
  return `No.${mmdd}-${String(idx + 1).padStart(2, "0")}`;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/** 本地 HH:MM */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地 dayKey 的 hhmm；hh < dayStartHour ⇒ 算成隔一個日曆日（日界線前的凌晨屬於前一個帳日）；回 UTC ISO */
export function atOf(dayKey: string, hhmm: string, dayStartHour: number): string {
  const tm = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!DAY_RE.test(dayKey) || !tm) throw new RangeError("時刻看不懂");
  const h = parseInt(tm[1], 10);
  const mi = parseInt(tm[2], 10);
  if (h > 23 || mi > 59) throw new RangeError("時刻看不懂");
  const [y, m, d] = splitDay(dayKey);
  return new Date(y, m - 1, h < dayStartHour ? d + 1 : d, h, mi).toISOString();
}

/* ───────────────────────── §4.5 分類與帳戶 ───────────────────────── */

/** 去掉開頭的非字母數字（emoji、膚色修飾、變體選擇符、ZWJ、空白、符號） */
export function bareName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+/u, "");
}

/** 比對用的鍵 */
export function catKey(name: string): string {
  return bareName(normalizeInput(name)).toLowerCase();
}

const byPosThenCreated = (a: CategoryRow | AccountRow, b: CategoryRow | AccountRow): number =>
  a.position - b.position || cmpStr(a.created_at, b.created_at) || cmpStr(a.id, b.id);

const isUncat = (id: string): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

/** 兩層樹：主分類依 position、created_at；子分類同；未分類固定最後；封存的不列時連子分類一起不列 */
export function categoryTree(
  cats: readonly CategoryRow[],
  kind: CategoryKind,
  opts: { includeArchived: boolean },
): { parent: CategoryRow; children: CategoryRow[] }[] {
  const alive = cats.filter((c) => c.deleted_at === null && c.kind === kind && (opts.includeArchived || c.archived_at === null));
  const ids = new Set(alive.map((c) => c.id));
  // 父列不在（被刪、別 kind、或封存而不列）：父被封存 ⇒ 子也不列；父不在了 ⇒ 子升為主分類（不讓它消失）
  const allById: Record<string, CategoryRow> = {};
  for (const c of cats) allById[c.id] = c;
  const roots: CategoryRow[] = [];
  const kids: Record<string, CategoryRow[]> = {};
  for (const c of alive) {
    if (c.parent_id && ids.has(c.parent_id) && !isUncat(c.parent_id)) {
      (kids[c.parent_id] = kids[c.parent_id] ?? []).push(c);
    } else if (c.parent_id && !opts.includeArchived) {
      const p = allById[c.parent_id];
      if (p && p.deleted_at === null && p.kind === kind && p.archived_at !== null) continue; // 封存主分類的子分類
      roots.push(c);
    } else {
      roots.push(c);
    }
  }
  roots.sort((a, b) => {
    const ua = isUncat(a.id) ? 1 : 0;
    const ub = isUncat(b.id) ? 1 : 0;
    return ua - ub || byPosThenCreated(a, b);
  });
  return roots.map((p) => ({ parent: p, children: isUncat(p.id) ? [] : (kids[p.id] ?? []).slice().sort(byPosThenCreated) }));
}

/**
 * 分類實際掛在哪一層（跟 `categoryTree` 的顯示一致；磨光⑥ 契約 §2-2；D-票-62）：
 * 父列不在了（已刪、別 kind、這張表沒有）或父是「未分類」⇒ 主分類層（null）；其餘＝它的 parent_id（父封存也算在，子分類跟著被藏）。
 * repository 的 `moveCategory` 用它找「兄弟」，孤兒子分類才會和主分類一起排。`byId` 要含父可能的列（同 kind、未刪即可，封存的也要）。
 */
export function effectiveParentId(c: CategoryRow, byId: Readonly<Record<string, CategoryRow>>): string | null {
  if (!c.parent_id || isUncat(c.parent_id)) return null;
  const p = byId[c.parent_id];
  return p && p.deleted_at === null && p.kind === c.kind ? p.id : null;
}

/* ── 記一筆的「常用」（磨光⑥ 契約 §2-3；D-票-63）：只改顯示順序、不寫資料 ── */

/** 常用統計看最近幾天（含今天） */
export const USAGE_DAYS = 30;
/** 記一筆「常用」分類的個數（不夠用「最近用過」補到這個數） */
export const FREQUENT_CATEGORY_LIMIT = 8;
/** 記一筆「常用」帳戶的個數 */
export const FREQUENT_ACCOUNT_LIMIT = 3;

/** 一個分類在統計期間的用量：n＝筆數，last＝最近一筆的 `occurred_on + " " + occurred_at`（字串比大小＝比時間） */
export interface CategoryUsage {
  id: string;
  n: number;
  last: string;
}
/** 一個帳戶在統計期間的用量（轉帳的來源與目的各算一次） */
export interface AccountUsage {
  id: string;
  n: number;
}
/** `TicketRepository.usageSince` 的回傳 */
export interface UsageSince {
  categories: CategoryUsage[];
  accounts: AccountUsage[];
}

/**
 * 常用分類（單一 kind；呼叫端先把 usage 濾成那個 kind）：次數多的在前、同次數最近一次新的在前（再同 ⇒ id），取 `limit` 個；
 * 不滿就用 `recent`（最近用過，已排好）依序補、去重，湊到 `limit` 或補完為止。
 */
export function frequentCategoryIds(usage: readonly CategoryUsage[], recent: readonly string[], limit: number = FREQUENT_CATEGORY_LIMIT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const ranked = usage.filter((u) => u.n > 0).sort((a, b) => b.n - a.n || cmpStr(b.last, a.last) || cmpStr(a.id, b.id));
  for (const u of ranked) {
    if (out.length >= limit) break;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u.id);
  }
  for (const id of recent) {
    if (out.length >= limit) break;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 常用帳戶：用過至少 1 次的前 `limit` 名（次數多的在前；同次數照 orderAccounts 的順序）。
 * 只看未刪、未封存的帳戶；這些帳戶 ≤ `limit` 個時回空（全部本來就在手邊，不需要這一列）。
 */
export function frequentAccountIds(usage: readonly AccountUsage[], accounts: readonly AccountRow[], limit: number = FREQUENT_ACCOUNT_LIMIT): string[] {
  const live = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null));
  if (live.length <= limit) return [];
  const rank: Record<string, number> = {};
  live.forEach((a, i) => {
    rank[a.id] = i;
  });
  return usage
    .filter((u) => u.n >= 1 && rank[u.id] !== undefined)
    .sort((a, b) => b.n - a.n || rank[a.id] - rank[b.id])
    .slice(0, limit)
    .map((u) => u.id);
}

/** "🍜 食物 › 午餐"／"🍜 食物"／"未分類"；null ⇒ "（分類已不在）" */
export function categoryLabel(cat: CategoryRow | null, catById: Readonly<Record<string, CategoryRow>>): string {
  if (!cat) return "（分類已刪除）";
  const p = cat.parent_id ? catById[cat.parent_id] : undefined;
  return p ? `${p.name} › ${cat.name}` : cat.name;
}

/** 0-29：完全相符 → 前綴 → 包含；各級子先主後、同級照樹順序；排除封存、未分類、別 kind */
export function matchCategories(query: string, cats: readonly CategoryRow[], kind: CategoryKind): CategoryRow[] {
  const q = catKey(query);
  if (!q) return [];
  const tree = categoryTree(cats, kind, { includeArchived: false }).filter((t) => !isUncat(t.parent.id));
  const children: CategoryRow[] = [];
  const parents: CategoryRow[] = [];
  for (const t of tree) {
    parents.push(t.parent);
    for (const c of t.children) children.push(c);
  }
  const tests: ((k: string) => boolean)[] = [(k) => k === q, (k) => k.startsWith(q), (k) => k.indexOf(q) >= 0];
  const out: CategoryRow[] = [];
  const seen = new Set<string>();
  for (const t of tests) {
    for (const list of [children, parents]) {
      for (const c of list) {
        if (seen.has(c.id)) continue;
        const k = catKey(c.name);
        if (k && t(k)) {
          seen.add(c.id);
          out.push(c);
        }
      }
    }
  }
  return out;
}

function groupIndex(groupKey: string): number {
  const i = ACCOUNT_GROUPS.findIndex((g) => g.key === groupKey);
  return i >= 0 ? i : ACCOUNT_GROUPS.length - 1; // 不認得 ⇒ other（最後一個）
}

/** ACCOUNT_GROUPS 順序（不認得的 group_key 當 other）→ position → created_at */
export function orderAccounts(accounts: readonly AccountRow[]): AccountRow[] {
  return accounts.slice().sort((a, b) => groupIndex(a.group_key) - groupIndex(b.group_key) || byPosThenCreated(a, b));
}

/** 只含未封存、至少一個帳戶的群組 */
export function groupAccounts(accounts: readonly AccountRow[]): { group: (typeof ACCOUNT_GROUPS)[number]; accounts: AccountRow[] }[] {
  const live = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null));
  const out: { group: (typeof ACCOUNT_GROUPS)[number]; accounts: AccountRow[] }[] = [];
  for (const g of ACCOUNT_GROUPS) {
    const list = live.filter((a) => ACCOUNT_GROUPS[groupIndex(a.group_key)].key === g.key);
    if (list.length) out.push({ group: g, accounts: list });
  }
  return out;
}

/** 封存的帳戶（orderAccounts 順序） */
export function archivedAccounts(accounts: readonly AccountRow[]): AccountRow[] {
  return orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at !== null));
}

/** 0-29：未封存；完全相符（忽略大小寫）優先、再前綴；同級取 orderAccounts 的第一個 */
export function matchAccount(token: string, accounts: readonly AccountRow[]): AccountRow | null {
  const t = normalizeInput(token).trim().toLowerCase();
  if (!t) return null;
  const live = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null));
  const key = (a: AccountRow) => normalizeInput(a.name).trim().toLowerCase();
  return live.find((a) => key(a) === t) ?? live.find((a) => key(a).startsWith(t)) ?? null;
}

/** last 存在且未封存 ⇒ 它；否則 orderAccounts 第一個未封存；沒有 ⇒ null */
export function defaultAccountId(accounts: readonly AccountRow[], lastAccountId: string | null): string | null {
  if (lastAccountId) {
    const last = accounts.find((a) => a.id === lastAccountId);
    if (last && last.deleted_at === null && last.archived_at === null) return last.id;
  }
  const first = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null))[0];
  return first ? first.id : null;
}

/* ───────────────────────── §4.6 parseQuickEntry ───────────────────────── */

export interface QuickCtx extends EntryCtx {
  lastAccountId: string | null;
}
export interface QuickEntry {
  kind: "income" | "expense";
  amountMinor: number;
  currency: string;
  accountId: string;
  categoryId: string;
  categoryMatched: boolean;
  note: string;
}

const QUICK_AMOUNT_RE = /^\+?[\d,]+(\.\d+)?$/;

/** `<金額> [分類] [備註…] [@帳戶]`；不合 throw RangeError */
export function parseQuickEntry(body: string, ctx: QuickCtx): QuickEntry {
  const tokens = normalizeInput(body)
    .split(/\s+/)
    .filter((t) => t !== "");
  if (!tokens.length || !QUICK_AMOUNT_RE.test(tokens[0])) throw new RangeError("開頭先寫金額，例如「80 午餐」");
  const kind: "income" | "expense" = tokens[0].charAt(0) === "+" ? "income" : "expense";
  const rest = tokens.slice(1);
  const accounts = Object.keys(ctx.accById).map((k) => ctx.accById[k]);
  let account: AccountRow | null = null;
  let atIdx = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i].charAt(0) === "@" && rest[i].length > 1) {
      atIdx = i;
      break;
    }
  }
  if (atIdx >= 0) {
    const name = rest[atIdx].slice(1);
    account = matchAccount(name, accounts);
    if (!account) throw new RangeError(`找不到帳戶「${name}」`);
    rest.splice(atIdx, 1);
  } else {
    const id = defaultAccountId(accounts, ctx.lastAccountId);
    if (!id) throw new RangeError("還沒有帳戶——先到售票口新增一個");
    account = ctx.accById[id];
  }
  const cur = curOrThrow(ctx.curByCode, account.currency);
  const amountMinor = parseAmount(tokens[0].replace(/^\+/, ""), { code: account.currency, decimals: cur.decimals }, { allowNegative: false });
  const cats = Object.keys(ctx.catById).map((k) => ctx.catById[k]);
  const hit = rest.length ? matchCategories(rest[0], cats, kind)[0] : undefined;
  if (hit) {
    return { kind, amountMinor, currency: account.currency, accountId: account.id, categoryId: hit.id, categoryMatched: true, note: rest.slice(1).join(" ") };
  }
  return { kind, amountMinor, currency: account.currency, accountId: account.id, categoryId: uncatIdOf(kind), categoryMatched: false, note: rest.join(" ") };
}

/** TK_TEXT.saved 的組字（含「（分類待補）」）——字面與 store 的 `TK_TEXT.saved`／`pendingCat` 相同 */
export function quickToast(q: QuickEntry, ctx: QuickCtx): string {
  const cur = ctx.curByCode[q.currency];
  const decimals = cur ? cur.decimals : 2;
  const amount = quickAmountText(q.kind, q.amountMinor, decimals) + (cur && cur.is_main === 1 ? "" : ` ${q.currency}`);
  const cat = ctx.catById[q.categoryId];
  const label = q.categoryMatched && cat ? bareName(cat.name) : q.note ? Array.from(q.note).slice(0, 12).join("") : UNCAT_NAME;
  const acc = ctx.accById[q.accountId];
  return `已記 ${amount} ${label} · ${acc ? acc.name : ""}${q.categoryMatched ? "" : "（分類待補）"}`;
}

/* ───────────────────────── §4.7 匯入計畫 ───────────────────────── */

const isIncExp = (t: string): boolean => t === "0" || t === "1";

/** 0-24 的口徑 */
export function mmSummary(dump: MmbakDump): ImportPlan["summary"] {
  const live = dump.transactions.filter((t) => !t.is_del);
  const catUids = new Set(dump.categories.map((c) => c.uid));
  const used = new Set<string>();
  let from: string | null = null;
  let to: string | null = null;
  for (const t of live) {
    if (isIncExp(t.do_type) && t.ctg_uid && catUids.has(t.ctg_uid)) used.add(t.ctg_uid);
    if (DAY_RE.test(t.wdate)) {
      if (from === null || t.wdate < from) from = t.wdate;
      if (to === null || t.wdate > to) to = t.wdate;
    }
  }
  return { accounts: dump.accounts.filter((a) => !a.is_del).length, categories: used.size, transactions: live.length, from, to };
}

/** ACCOUNT_GROUPS 依 mmName 完全相符；查不到 ⇒ other */
export function mmGroupKey(groupName: string | null): AccountGroup {
  if (groupName === null) return "other";
  const g = ACCOUNT_GROUPS.find((x) => x.mmName !== null && x.mmName === groupName.trim());
  return g ? g.key : "other";
}

/** 表 ⇒「X 表」、表.欄 ⇒「X.y 欄」；以「、」連接、最多 3 項，多的加「等」 */
export function missingText(missing: readonly string[]): string {
  const items = missing.map((m) => (m.indexOf(".") >= 0 ? `${m} 欄` : `${m} 表`));
  return items.slice(0, 3).join("、") + (items.length > 3 ? "等" : "");
}

/** 窮舉正負號使 Σ sᵢ·aᵢ = needed；**恰好一組解**才回（meet-in-the-middle，2^11×2） */
export function solveAdjustSigns(amounts: readonly number[], needed: number, max = SOLVE_MAX): (1 | -1)[] | null {
  const n = amounts.length;
  if (n > max) return null;
  if (n === 0) return needed === 0 ? [] : null;
  const half = n >> 1;
  const left = amounts.slice(0, half);
  const right = amounts.slice(half);
  const sumOf = (arr: readonly number[], mask: number): number => {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += mask & (1 << i) ? -arr[i] : arr[i];
    return s;
  };
  const leftMap = new Map<number, { count: number; mask: number }>();
  for (let mask = 0; mask < 1 << left.length; mask++) {
    const s = sumOf(left, mask);
    const hit = leftMap.get(s);
    if (hit) hit.count++;
    else leftMap.set(s, { count: 1, mask });
  }
  let total = 0;
  let found: { l: number; r: number } | null = null;
  for (let mask = 0; mask < 1 << right.length; mask++) {
    const hit = leftMap.get(needed - sumOf(right, mask));
    if (!hit) continue;
    total += hit.count;
    if (total > 1) return null;
    found = { l: hit.mask, r: mask };
  }
  if (total !== 1 || !found) return null;
  const out: (1 | -1)[] = [];
  for (let i = 0; i < left.length; i++) out.push(found.l & (1 << i) ? -1 : 1);
  for (let i = 0; i < right.length; i++) out.push(found.r & (1 << i) ? -1 : 1);
  return out;
}

export function defaultChoices(plan: ImportPlan): Record<string, ImportChoice> {
  const out: Record<string, ImportChoice> = {};
  for (const c of plan.entries.changed) out[c.id] = "theirs";
  return out;
}

/** 比對的欄（不比 route_id、時間戳） */
const DIFF_COLS = [
  "kind",
  "occurred_on",
  "occurred_at",
  "account_id",
  "to_account_id",
  "category_id",
  "amount_minor",
  "currency",
  "main_minor",
  "account_minor",
  "to_amount_minor",
  "note",
] as const;

export function entryDiffCols(local: EntryRow, incoming: EntryRow): string[] {
  return DIFF_COLS.filter((c) => local[c] !== incoming[c]);
}

/**
 * inserts 原樣；changed 選 theirs ⇒ cols＋import_utime＋updated_at（不含 route_id，0-22）；
 * 選 ours ⇒ 計入 keptLocal，且對那筆送 entryKept（只寫 import_utime＝這次備份的 UTIME＋updated_at，表示這版已裁決，
 * 下次重跑同一版不再列為已修改；不改內容欄，也不算 updated）
 */
export function materializeImport(
  plan: ImportPlan,
  choices: Readonly<Record<string, ImportChoice>>,
  nowIso: string,
): {
  entryInserts: EntryRow[];
  entryUpdates: { id: string; cols: Record<string, unknown> }[];
  entryKept: { id: string; cols: Record<string, unknown> }[];
  keptLocal: number;
} {
  const entryUpdates: { id: string; cols: Record<string, unknown> }[] = [];
  const entryKept: { id: string; cols: Record<string, unknown> }[] = [];
  let keptLocal = 0;
  for (const ch of plan.entries.changed) {
    if ((choices[ch.id] ?? "theirs") === "ours") {
      keptLocal++;
      entryKept.push({ id: ch.id, cols: { import_utime: ch.incoming.import_utime, updated_at: nowIso } });
      continue;
    }
    const cols: Record<string, unknown> = {};
    for (const c of ch.cols) cols[c] = (ch.incoming as unknown as Record<string, unknown>)[c];
    delete cols.route_id;
    cols.import_utime = ch.incoming.import_utime;
    cols.updated_at = nowIso;
    entryUpdates.push({ id: ch.id, cols });
  }
  return { entryInserts: plan.entries.inserts.slice(), entryUpdates, entryKept, keptLocal };
}

/** zdate（毫秒字串）→ ISO；不是有限數字 ⇒ wdate 本地中午 */
function isoFromZdate(zdate: string, wdate: string): string {
  const ms = Number(zdate);
  if (zdate.trim() !== "" && Number.isFinite(ms)) {
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const [y, m, d] = splitDay(wdate);
  return new Date(y, m - 1, d, 12, 0).toISOString();
}

/** 一筆帳對各帳戶餘額的效果（balancesOf 口徑，未刪） */
function addEffect(acc: Record<string, number>, e: EntryRow): void {
  const d = e.kind === "expense" || e.kind === "transfer" ? -e.account_minor : e.account_minor;
  acc[e.account_id] = (acc[e.account_id] ?? 0) + d;
  if (e.kind === "transfer" && e.to_account_id) acc[e.to_account_id] = (acc[e.to_account_id] ?? 0) + (e.to_amount_minor ?? 0);
}

const entrySort = (a: EntryRow, b: EntryRow): number =>
  cmpStr(a.occurred_on, b.occurred_on) || cmpStr(a.occurred_at, b.occurred_at) || cmpStr(a.id, b.id);

/**
 * 從本機已匯入的帳推回「財務管家 uid → 本機 id」（補 §4.7-3／4 沒寫到的情境：第一次按名稱對上主人手建的帳戶／分類、
 * 之後主人改了名，重跑時不能再靠名稱）。依 import_id 找回備份裡的那筆交易：帳戶看 account_id／to_account_id，
 * 收支的分類看 category_id（未分類不算）。同一個 uid 指到多個本機 id（主人搬過帳）⇒ 多數決、平手取 id 小的。含墓碑。
 */
function priorMapping(dump: MmbakDump, entries: readonly EntryRow[]): { acc: Record<string, string>; cat: Record<string, string> } {
  const txByUid: Record<string, MmTx> = {};
  const legsByKey: Record<string, MmTx[]> = {};
  for (const t of dump.transactions) {
    txByUid[t.uid] = t;
    const key = (t.tx_uid_trans ?? "").trim();
    if (key && (t.do_type === "3" || t.do_type === "4")) (legsByKey[key] = legsByKey[key] ?? []).push(t);
  }
  const accVotes: Record<string, Record<string, number>> = {};
  const catVotes: Record<string, Record<string, number>> = {};
  const vote = (box: Record<string, Record<string, number>>, uid: string | null | undefined, id: string | null) => {
    if (!uid || !id) return;
    const b = (box[uid] = box[uid] ?? {});
    b[id] = (b[id] ?? 0) + 1;
  };
  for (const e of entries) {
    if (e.import_source !== IMPORT_SOURCE_MM || !e.import_id) continue;
    if (e.import_id.indexOf("transfer:") === 0) {
      const legs = legsByKey[e.import_id.slice("transfer:".length)] ?? [];
      const l3 = legs.find((t) => t.do_type === "3");
      const l4 = legs.find((t) => t.do_type === "4");
      if (!l3) continue;
      vote(accVotes, l3.asset_uid, e.account_id);
      vote(accVotes, l3.to_asset_uid || (l4 ? l4.asset_uid : null), e.to_account_id);
      continue;
    }
    const t = txByUid[e.import_id];
    if (!t) continue;
    vote(accVotes, t.asset_uid, e.account_id);
    if ((e.kind === "income" || e.kind === "expense") && e.category_id && !isUncat(e.category_id)) vote(catVotes, t.ctg_uid, e.category_id);
  }
  const pick = (box: Record<string, Record<string, number>>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const uid of Object.keys(box)) {
      let best: string | null = null;
      for (const id of Object.keys(box[uid])) {
        if (best === null || box[uid][id] > box[uid][best] || (box[uid][id] === box[uid][best] && id < best)) best = id;
      }
      if (best !== null) out[uid] = best;
    }
    return out;
  };
  return { acc: pick(accVotes), cat: pick(catVotes) };
}

export function planImport(
  dump: MmbakDump,
  local: ImportLocal,
  opts: { balanceText: Readonly<Record<string, string>>; nowIso: string },
): ImportPlan {
  const nowIso = opts.nowIso;
  const summary = mmSummary(dump);
  const stamp = { device_id: null, created_at: nowIso, updated_at: nowIso, synced_at: null, deleted_at: null };

  /* 1. 主幣別 */
  const mainMm = dump.currencies.find((c) => c.is_main);
  const mainIso = mainMm ? mainMm.iso.trim().toUpperCase() : MAIN_CURRENCY;
  const unsupported = mainIso !== MAIN_CURRENCY ? `這個備份的主幣別是 ${mainIso}，Next Stop 目前只支援新台幣` : null;

  /* 2. 幣別：本機（含墓碑）沒有才新建；換算一律用備份的 RATE */
  const localCurById: Record<string, CurrencyRow> = {};
  let curPos = -1;
  for (const c of local.currencies) {
    localCurById[c.id] = c;
    if (c.position > curPos) curPos = c.position;
  }
  const mmCur: Record<string, CurLike> = {};
  const convCur: Record<string, CurLike> = {};
  for (const c of local.currencies) if (c.deleted_at === null) convCur[c.code] = c;
  const newCurrencies: CurrencyRow[] = [];
  for (const c of dump.currencies) {
    const iso = c.iso.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iso)) continue;
    let rate: string;
    try {
      rate = c.is_main ? "1" : importRate(c.rate);
    } catch {
      continue; // 匯率看不懂 ⇒ 這個幣別對不上；用到它的帳戶與帳列進 invalid「幣別看不懂」（步驟 3、5、6）
    }
    const decimals = Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 8 ? c.decimals : 2;
    const cl: CurLike = { code: iso, decimals, rate_to_main: rate, is_main: c.is_main ? 1 : 0 };
    mmCur[c.uid] = cl;
    convCur[iso] = cl;
    const id = ticketId("currency:" + iso);
    if (!localCurById[id] && !newCurrencies.some((x) => x.id === id)) {
      newCurrencies.push({ id, code: iso, name: CURRENCY_NAMES[iso] ?? iso, decimals, rate_to_main: rate, is_main: c.is_main ? 1 : 0, position: ++curPos, ...stamp });
    }
  }
  if (!convCur[MAIN_CURRENCY]) convCur[MAIN_CURRENCY] = FALLBACK_MAIN;

  const liveTx = dump.transactions.filter((t) => !t.is_del);

  /* 3. 帳戶：保留＝未刪的＋被交易指到的已刪帳戶（建並封存） */
  const refAcc = new Set<string>();
  for (const t of liveTx) {
    if (t.asset_uid) refAcc.add(t.asset_uid);
    if (t.to_asset_uid) refAcc.add(t.to_asset_uid);
  }
  const groupName: Record<string, string> = {};
  for (const g of dump.groups) groupName[g.uid] = g.name;
  const keptAcc = dump.accounts.filter((a) => !a.is_del || refAcc.has(a.uid));
  const localAccById: Record<string, AccountRow> = {};
  const accPos: Record<string, number> = {};
  for (const a of local.accounts) {
    localAccById[a.id] = a;
    if (a.deleted_at === null) accPos[a.group_key] = Math.max(accPos[a.group_key] ?? -1, a.position);
  }
  const accountIdOf: Record<string, string> = {};
  const accCurOf: Record<string, string> = {}; // 本機帳戶 id → 幣別 code
  const claimed = new Set<string>();
  for (const a of keptAcc) {
    const id = ticketId("moneymanager:" + a.uid);
    if (localAccById[id]) {
      accountIdOf[a.uid] = id;
      accCurOf[id] = localAccById[id].currency;
      claimed.add(id);
    }
  }
  // 確定性 id 之後、名稱之前：本機已匯入的帳指到哪個帳戶就沿用（主人改過名也對得上）
  const prior = priorMapping(dump, local.entries);
  for (const a of keptAcc) {
    if (accountIdOf[a.uid]) continue;
    const id = prior.acc[a.uid];
    const l = id ? localAccById[id] : undefined;
    if (!l || l.deleted_at !== null || claimed.has(l.id)) continue;
    accountIdOf[a.uid] = l.id;
    accCurOf[l.id] = l.currency;
    claimed.add(l.id);
  }
  const badCurAcc = new Set<string>(); // 帳戶的幣別有值、匯率卻看不懂 ⇒ 不建（不退回主幣別），它的帳進 invalid「幣別看不懂」
  const newAccounts: AccountRow[] = [];
  for (const a of keptAcc) {
    if (accountIdOf[a.uid]) continue;
    if (a.currency_uid && !mmCur[a.currency_uid]) {
      badCurAcc.add(a.uid);
      continue;
    }
    const gk = mmGroupKey(a.group_uid ? (groupName[a.group_uid] ?? null) : null);
    const curCode = a.currency_uid ? mmCur[a.currency_uid].code : mainIso;
    const match = local.accounts.find(
      (l) => l.deleted_at === null && !claimed.has(l.id) && l.name === a.name && l.group_key === gk && l.currency === curCode,
    );
    if (match) {
      accountIdOf[a.uid] = match.id;
      accCurOf[match.id] = match.currency;
      claimed.add(match.id);
      continue;
    }
    const id = ticketId("moneymanager:" + a.uid);
    accPos[gk] = (accPos[gk] ?? -1) + 1;
    newAccounts.push({ id, name: a.name, group_key: gk, currency: curCode, position: accPos[gk], archived_at: a.is_del ? nowIso : null, ...stamp });
    accountIdOf[a.uid] = id;
    accCurOf[id] = curCode;
    claimed.add(id);
  }

  /* 4. 分類 */
  const kindOfType = (t: number): CategoryKind | null => (t === 0 ? "income" : t === 1 ? "expense" : null);
  const mmCatByUid: Record<string, MmCategory> = {};
  for (const c of dump.categories) mmCatByUid[c.uid] = c;
  const usedCat = new Set<string>();
  for (const t of liveTx) if (isIncExp(t.do_type) && t.ctg_uid) usedCat.add(t.ctg_uid);
  const keep = new Set<string>();
  for (const c of dump.categories) if (kindOfType(c.type_code) && (!c.is_del || usedCat.has(c.uid))) keep.add(c.uid);
  const parentOf = (c: MmCategory): MmCategory | null => {
    if (c.status !== 2 || !c.parent_uid) return null;
    const p = mmCatByUid[c.parent_uid];
    if (!p || p.status === 2 || kindOfType(p.type_code) !== kindOfType(c.type_code)) return null;
    return p;
  };
  for (const c of dump.categories) {
    if (!keep.has(c.uid)) continue;
    const p = parentOf(c);
    if (p) keep.add(p.uid);
  }
  const keptCats = dump.categories.filter((c) => keep.has(c.uid));
  const orderedCats = [...keptCats.filter((c) => !parentOf(c)), ...keptCats.filter((c) => !!parentOf(c))];
  const localCatById: Record<string, CategoryRow> = {};
  const catPos: Record<string, number> = {};
  for (const c of local.categories) {
    localCatById[c.id] = c;
    if (c.deleted_at === null && !isUncat(c.id)) {
      const k = `${c.kind}|${c.parent_id ?? ""}`;
      catPos[k] = Math.max(catPos[k] ?? -1, c.position);
    }
  }
  const categoryIdOf: Record<string, string> = {};
  const catKindOf: Record<string, CategoryKind> = {};
  const catClaimed = new Set<string>();
  for (const c of orderedCats) {
    const id = ticketId("moneymanager:" + c.uid);
    if (localCatById[id]) {
      categoryIdOf[c.uid] = id;
      catKindOf[id] = localCatById[id].kind;
      catClaimed.add(id);
    }
  }
  // 確定性 id 之後、名稱之前：本機已匯入的帳用的分類就沿用（同帳戶的理由）
  for (const c of orderedCats) {
    if (categoryIdOf[c.uid]) continue;
    const id = prior.cat[c.uid];
    const l = id ? localCatById[id] : undefined;
    if (!l || l.deleted_at !== null || isUncat(l.id) || catClaimed.has(l.id) || l.kind !== kindOfType(c.type_code)) continue;
    categoryIdOf[c.uid] = l.id;
    catKindOf[l.id] = l.kind;
    catClaimed.add(l.id);
  }
  const newCategories: CategoryRow[] = [];
  for (const c of orderedCats) {
    if (categoryIdOf[c.uid]) continue;
    const kind = kindOfType(c.type_code) as CategoryKind;
    const p = parentOf(c);
    const parentId = p ? (categoryIdOf[p.uid] ?? null) : null;
    const match = local.categories.find(
      (l) => l.deleted_at === null && !catClaimed.has(l.id) && !isUncat(l.id) && l.kind === kind && l.name === c.name && l.parent_id === parentId,
    );
    if (match) {
      categoryIdOf[c.uid] = match.id;
      catKindOf[match.id] = match.kind;
      catClaimed.add(match.id);
      continue;
    }
    const id = ticketId("moneymanager:" + c.uid);
    const k = `${kind}|${parentId ?? ""}`;
    catPos[k] = (catPos[k] ?? -1) + 1;
    newCategories.push({ id, kind, name: c.name, parent_id: parentId, position: catPos[k], archived_at: c.is_del ? nowIso : null, ...stamp });
    categoryIdOf[c.uid] = id;
    catKindOf[id] = kind;
    catClaimed.add(id);
  }

  /* 5.＋6. 交易 → 帳列 */
  const invalid: { uid: string; reason: string }[] = [];
  const incoming: EntryRow[] = [];
  const adjustMeta: Record<string, { mmAccUid: string; type: "7" | "8" }> = {};
  const curCodeOf = (t: MmTx, accId: string): string | null => {
    if (t.currency_uid) return mmCur[t.currency_uid] ? mmCur[t.currency_uid].code : null;
    return accCurOf[accId] ?? mainIso;
  };
  const baseRow = (id: string, t: MmTx): Omit<EntryRow, "kind" | "account_id" | "to_account_id" | "category_id" | "amount_minor" | "currency" | "main_minor" | "account_minor" | "to_amount_minor"> => ({
    id,
    occurred_on: t.wdate,
    occurred_at: isoFromZdate(t.zdate, t.wdate),
    note: t.content ?? "",
    route_id: null,
    repeat_id: null,
    import_id: t.uid,
    import_source: IMPORT_SOURCE_MM,
    import_utime: t.utime,
    ...stamp,
  });

  // 5. 轉帳配對
  const legs: Record<string, MmTx[]> = {};
  for (const t of liveTx) {
    if (t.do_type !== "3" && t.do_type !== "4") continue;
    const key = (t.tx_uid_trans ?? "").trim();
    if (!key) {
      invalid.push({ uid: t.uid, reason: "轉帳資料不完整（缺轉出或轉入紀錄）" });
      continue;
    }
    (legs[key] = legs[key] ?? []).push(t);
  }
  for (const key of Object.keys(legs).sort()) {
    const group = legs[key];
    const l3s = group.filter((t) => t.do_type === "3");
    const l4s = group.filter((t) => t.do_type === "4");
    const bad = (reason: string) => {
      for (const t of group) invalid.push({ uid: t.uid, reason });
    };
    if (l3s.length !== 1 || l4s.length !== 1) {
      bad("轉帳資料不完整（缺轉出或轉入紀錄）");
      continue;
    }
    const l3 = l3s[0];
    const l4 = l4s[0];
    const fromId = l3.asset_uid ? accountIdOf[l3.asset_uid] : undefined;
    const toUid = l3.to_asset_uid || l4.asset_uid;
    const toId = toUid ? accountIdOf[toUid] : undefined;
    if (!fromId || !toId) {
      bad((l3.asset_uid && badCurAcc.has(l3.asset_uid)) || (toUid && badCurAcc.has(toUid)) ? "不支援這個幣別" : "找不到轉帳的帳戶");
      continue;
    }
    if (fromId === toId) {
      bad("轉出和轉入不能是同一個帳戶");
      continue;
    }
    if (!DAY_RE.test(l3.wdate)) {
      bad("日期格式有誤");
      continue;
    }
    const cur3 = curCodeOf(l3, fromId);
    const cur4 = curCodeOf(l4, toId);
    if (!cur3 || !cur4) {
      bad("不支援這個幣別");
      continue;
    }
    try {
      // 外幣轉帳（腿的幣別 ≠ 帳戶幣別）沒有備份樣本可驗證 ZMONEY／IN_ZMONEY 的語意（單幣別資料裡轉帳全是 TWD），
      // 這段維持原本的算法；有樣本再對照一般交易的「ZMONEY＝帳戶幣別額」改。
      const amount = minorFromDecimal(l3.zmoney, convCur[cur3].decimals, "round");
      const fromCur = accCurOf[fromId];
      const toCur = accCurOf[toId];
      const conv = convAmounts(amount, cur3, fromCur, convCur);
      const toAmount =
        cur4 === toCur ? minorFromDecimal(l4.zmoney, convCur[cur4].decimals, "round") : convertMinor(amount, convCur[cur3], convCur[toCur]);
      const id = ticketId("moneymanager:transfer:" + key);
      // 腿 3 幣別 ≠ 轉出帳戶幣別（跨幣別轉帳）⇒ 存成轉出帳戶幣別、金額＝以備份匯率折好的帳戶額：
      // 守住 §4.3「轉帳的幣別跟著轉出帳戶」，之後只改備註才不會動到幣別與餘額（偏離 §4.7-5 字面，修正席 10-12）
      incoming.push({
        ...baseRow(id, l3),
        note: l3.content ? l3.content : (l4.content ?? ""),
        import_id: "transfer:" + key,
        import_utime: Math.max(l3.utime, l4.utime),
        kind: "transfer",
        account_id: fromId,
        to_account_id: toId,
        category_id: null,
        amount_minor: cur3 === fromCur ? amount : conv.account,
        currency: fromCur,
        main_minor: conv.main,
        account_minor: conv.account,
        to_amount_minor: toAmount,
      });
    } catch {
      bad("金額格式有誤");
    }
  }

  // 6. 其他交易
  for (const t of liveTx) {
    if (t.do_type === "3" || t.do_type === "4") continue;
    let kind: EntryKind;
    if (t.do_type === "0") kind = "income";
    else if (t.do_type === "1") kind = "expense";
    else if (t.do_type === "7" || t.do_type === "8") kind = "adjust";
    else {
      invalid.push({ uid: t.uid, reason: `不支援的類型：${t.do_type}` });
      continue;
    }
    const accId = t.asset_uid ? accountIdOf[t.asset_uid] : undefined;
    if (!accId) {
      invalid.push({ uid: t.uid, reason: t.asset_uid && badCurAcc.has(t.asset_uid) ? "不支援這個幣別" : "找不到這個帳戶" });
      continue;
    }
    if (!DAY_RE.test(t.wdate)) {
      invalid.push({ uid: t.uid, reason: "日期格式有誤" });
      continue;
    }
    const cur = curCodeOf(t, accId);
    if (!cur) {
      invalid.push({ uid: t.uid, reason: "不支援這個幣別" });
      continue;
    }
    // 財務管家的 ZMONEY 已經是**帳戶幣別**的金額（外幣列 ZMONEY / IN_ZMONEY ＝ 備份匯率），不能再換算第二次；
    // IN_ZMONEY 才是交易幣別（currencyUid）的原幣額。帳戶額直接用 ZMONEY，主幣別額由帳戶額折算。
    const accCode = accCurOf[accId];
    let amount: number;
    let entryCur = cur;
    let conv: { main: number; account: number };
    try {
      const accountMinor = minorFromDecimal(t.zmoney, convCur[accCode].decimals, "round");
      conv = convAmounts(accountMinor, accCode, accCode, convCur);
      amount = accountMinor;
      if (cur !== accCode) {
        // 外幣列：原幣額取 IN_ZMONEY；缺、空、看不懂、或原幣是 0 而帳戶額不是 0 ⇒ 保守退回記成帳戶幣別（餘額不受影響）
        let orig: number | null = null;
        if (t.in_zmoney != null && t.in_zmoney.trim() !== "") {
          try {
            orig = minorFromDecimal(t.in_zmoney, convCur[cur].decimals, "round");
          } catch {
            orig = null;
          }
        }
        if (orig !== null && !(orig === 0 && accountMinor !== 0)) {
          amount = orig;
        } else entryCur = accCode;
      }
    } catch {
      invalid.push({ uid: t.uid, reason: "金額格式有誤" });
      continue;
    }
    let categoryId: string | null = null;
    if (kind === "income" || kind === "expense") {
      const mapped = t.ctg_uid ? categoryIdOf[t.ctg_uid] : undefined;
      categoryId = mapped && catKindOf[mapped] === kind ? mapped : uncatIdOf(kind);
    }
    const id = ticketId("moneymanager:" + t.uid);
    if (kind === "adjust") adjustMeta[id] = { mmAccUid: t.asset_uid as string, type: t.do_type as "7" | "8" };
    incoming.push({
      ...baseRow(id, t),
      kind,
      account_id: accId,
      to_account_id: null,
      category_id: categoryId,
      amount_minor: amount,
      currency: entryCur,
      main_minor: conv.main,
      account_minor: conv.account,
      to_amount_minor: null,
    });
  }
  incoming.sort(entrySort);
  invalid.sort((a, b) => cmpStr(a.uid, b.uid) || cmpStr(a.reason, b.reason));

  /* 7. 差別的方向（0-23） */
  const liveMmAcc = dump.accounts.filter((a) => !a.is_del && accountIdOf[a.uid]);
  const base: Record<string, number> = {};
  for (const e of incoming) if (e.kind !== "adjust") addEffect(base, e);
  const adjByAcc: Record<string, EntryRow[]> = {};
  for (const e of incoming) if (e.kind === "adjust") (adjByAcc[e.account_id] = adjByAcc[e.account_id] ?? []).push(e);
  const inputOf: Record<string, number | null> = {};
  for (const a of liveMmAcc) {
    const text = (opts.balanceText[a.uid] ?? "").trim();
    let v: number | null = null;
    if (text !== "") {
      const accCur = convCur[accCurOf[accountIdOf[a.uid]]] ?? FALLBACK_MAIN;
      try {
        v = minorFromDecimal(text, accCur.decimals, "strict", accCur.code);
      } catch {
        v = null; // 格式錯 ⇒ 當沒填
      }
    }
    inputOf[a.uid] = v;
  }
  const signOf = (hyp: "A" | "B", type: "7" | "8"): 1 | -1 => ((hyp === "A") === (type === "7") ? 1 : -1);
  const filled = liveMmAcc.filter((a) => inputOf[a.uid] !== null);
  const sumUnder = (accId: string, hyp: "A" | "B"): number => {
    let s = base[accId] ?? 0;
    for (const e of adjByAcc[accId] ?? []) s += signOf(hyp, adjustMeta[e.id].type) * e.account_minor;
    return s;
  };
  const fits = (hyp: "A" | "B") => filled.every((a) => sumUnder(accountIdOf[a.uid], hyp) === inputOf[a.uid]);
  let rule: ImportPlan["adjust"]["rule"] = "default";
  const signs: Record<string, 1 | -1> = {};
  const applyHyp = (hyp: "A" | "B", accIds: readonly string[] | null) => {
    for (const e of incoming) {
      if (e.kind !== "adjust") continue;
      if (accIds && accIds.indexOf(e.account_id) < 0) continue;
      signs[e.id] = signOf(hyp, adjustMeta[e.id].type);
    }
  };
  if (filled.length > 0 && fits("A")) {
    rule = "A";
    applyHyp("A", null);
  } else if (filled.length > 0 && fits("B")) {
    rule = "B";
    applyHyp("B", null);
  } else {
    let solvedAll = filled.length > 0;
    const solved: Record<string, 1 | -1> = {};
    for (const a of filled) {
      if (!solvedAll) break;
      const accId = accountIdOf[a.uid];
      const rows = adjByAcc[accId] ?? [];
      const res = solveAdjustSigns(
        rows.map((e) => e.account_minor),
        (inputOf[a.uid] as number) - (base[accId] ?? 0),
      );
      if (!res) solvedAll = false;
      else rows.forEach((e, i) => (solved[e.id] = res[i]));
    }
    if (solvedAll) {
      rule = "solved";
      applyHyp("A", null); // 沒填的帳戶照 A
      for (const id of Object.keys(solved)) signs[id] = solved[id];
    } else {
      rule = "default";
      applyHyp(TICKET_MM_DIFF_DEFAULT, null);
    }
  }
  let plus = 0;
  let minus = 0;
  for (const e of incoming) {
    if (e.kind !== "adjust") continue;
    const s = signs[e.id] ?? 1;
    if (s < 0) {
      e.amount_minor = -e.amount_minor;
      e.account_minor = -e.account_minor;
      e.main_minor = -e.main_minor;
      minus++;
    } else plus++;
  }

  /* 8. 與本機比對（0-22） */
  const localEntryById: Record<string, EntryRow> = {};
  for (const e of local.entries) localEntryById[e.id] = e;
  const inserts: EntryRow[] = [];
  const changed: ImportChange[] = [];
  let unchanged = 0;
  let tombstoned = 0;
  const incomingIds = new Set<string>();
  for (const e of incoming) {
    incomingIds.add(e.id);
    const l = localEntryById[e.id];
    if (!l) {
      inserts.push(e);
      continue;
    }
    if (l.deleted_at !== null) {
      tombstoned++;
      continue;
    }
    const signFlip = e.kind === "adjust" && Math.sign(l.amount_minor) !== Math.sign(e.amount_minor);
    if ((e.import_utime ?? 0) > (l.import_utime ?? -1) || signFlip) {
      const cols = entryDiffCols(l, e);
      if (cols.length) changed.push({ id: e.id, local: l, incoming: e, cols });
      else unchanged++;
    } else unchanged++;
  }

  /* 9. K */
  let extraLocal = 0;
  for (const e of local.entries) if (e.deleted_at === null && !incomingIds.has(e.id)) extraLocal++;

  /* 10. checks */
  const after: Record<string, number> = {};
  for (const e of incoming) addEffect(after, e);
  const checks: BalanceCheck[] = liveMmAcc.map((a) => {
    const accountId = accountIdOf[a.uid];
    const inputMinor = inputOf[a.uid];
    const computedMinor = after[accountId] ?? 0;
    return {
      mmUid: a.uid,
      name: a.name,
      accountId,
      currency: accCurOf[accountId],
      inputMinor,
      computedMinor,
      ok: inputMinor === null ? null : inputMinor === computedMinor,
    };
  });

  return {
    summary,
    unsupported,
    currencies: newCurrencies,
    accounts: newAccounts,
    categories: newCategories,
    accountIdOf,
    categoryIdOf,
    entries: { inserts, changed, unchanged, tombstoned, invalid },
    extraLocal,
    adjust: { total: plus + minus, plus, minus, rule },
    checks,
  };
}
