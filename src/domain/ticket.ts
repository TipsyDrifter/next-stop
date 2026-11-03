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
/** 早期從財務管家匯入的列（import_source 欄的值）；匯入已拿掉，只留給既有的定期規則判斷用 */
export const IMPORT_SOURCE_MM = "moneymanager";
export const IMPORT_CHUNK = 200; // 0-21；寫入每批的筆數（定期帳實體化在用，名字沿用）
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

/** 0-19：帳戶群組（排序依此） */
export const ACCOUNT_GROUPS: readonly { key: AccountGroup; label: string; liability: boolean }[] = [
  { key: "cash", label: "現金", liability: false },
  { key: "bank", label: "帳戶", liability: false },
  { key: "card", label: "信用卡", liability: true },
  { key: "debit", label: "簽帳卡", liability: false },
  { key: "deposit", label: "定存", liability: false },
  { key: "emoney", label: "電子支付", liability: false },
  { key: "investment", label: "投資", liability: false },
  { key: "lent", label: "借出／應收", liability: false },
  { key: "credit", label: "信用額度", liability: true },
  { key: "loan", label: "貸款", liability: true },
  { key: "insurance", label: "保險", liability: false },
  { key: "other", label: "其他", liability: false },
];

/** 新幣別的預設顯示名；查不到＝代碼本身（0-14） */
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

/**
 * 售票口④ 的兩張表（0016；與 SQLite 列逐字相同）。純函式在 `ticketAids.ts`，列型別放這裡跟其他表一起（理由同上）。
 * 願望「買了沒」不存狀態：entry_id 指到的帳還在＝已買（`wishBought`）；bought_at 只給顯示。
 */
export interface WishRow extends TkSyncCols {
  id: string;
  name: string;
  amount_minor: number | null; // 主幣別；NULL＝沒估
  note: string;
  category_id: string | null;
  position: number;
  entry_id: string | null;
  bought_at: string | null;
}
/** 常用票種（手動書籤）：除了 name 與 kind，每一欄都可以空著（空＝填表時不動那一欄） */
export interface TemplateRow extends TkSyncCols {
  id: string;
  name: string;
  kind: "income" | "expense" | "transfer";
  amount_minor: number | null; // 原幣
  currency: string | null; // NULL＝跟著帳戶
  account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  note: string;
  route_id: string | null;
  position: number;
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
  kind: "income" | "expense" | "transfer"; // adjust 只經 adjustRow（期初、調整餘額）
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

/** 換算只需要的幣別欄 */
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

/* ── 分類樹（售票口④ 第二輪 D-票-78：不限層數；0 migration——tk_categories.parent_id 本來就自我參照、沒有 CHECK） ──
 * 判準一律走「實際的上層」（`effectiveParentId`）：父列不在了（已刪、別 kind、這張表沒有）或父是「未分類」⇒ 頂層；
 * 同步可能造出環（兩台離線各把對方搬到自己底下：A→B→A），環上 id 最小的那個當頂層、其餘照掛——兩台算出來一樣。
 * 封存一個分類＝它底下整棵都算封存（`categoryArchivedUp`）：不列在選單、不進「常用」；統計與預算照算（封存照算，0-7）。 */

/** 樹的一個節點：depth 0＝頂層；children 照 position、created_at */
export interface CategoryNode {
  cat: CategoryRow;
  depth: number;
  children: CategoryNode[];
}

/** 不看環的一步：parent_id 指到還在、同 kind、不是未分類的列 ⇒ 它；否則 null */
function rawParentId(c: CategoryRow, byId: Readonly<Record<string, CategoryRow>>): string | null {
  if (!c.parent_id || isUncat(c.parent_id)) return null;
  const p = byId[c.parent_id];
  return p && p.deleted_at === null && p.kind === c.kind ? p.id : null;
}

/**
 * 分類實際掛在哪一層（跟 `categoryForest` 的顯示一致；磨光⑥ 契約 §2-2；D-票-62）：
 * 父列不在了（已刪、別 kind、這張表沒有）或父是「未分類」⇒ 頂層（null）；其餘＝它的 parent_id（父封存也算在，底下跟著被藏）。
 * 在環上（同步造出的 A→B→A）且是環上 id 最小的那個 ⇒ null（環斷在這裡）。
 * repository 用它找「兄弟」，孤兒才會和頂層一起排。`byId` 要含父可能的列（同 kind、未刪即可，封存的也要）。
 */
export function effectiveParentId(c: CategoryRow, byId: Readonly<Record<string, CategoryRow>>): string | null {
  const p = rawParentId(c, byId);
  if (p === null) return null;
  // 往上走：回到自己 ⇒ 自己在環上、經過的就是整個環；先碰到走過的（自己不在那個環上）或走到頂 ⇒ 照掛
  let minId = c.id;
  const seen = new Set<string>([c.id]);
  for (let cur: string | null = p; cur !== null; ) {
    if (cur === c.id) return minId === c.id ? null : p;
    if (seen.has(cur)) return p;
    seen.add(cur);
    if (cur < minId) minId = cur;
    const row: CategoryRow | undefined = byId[cur];
    cur = row ? rawParentId(row, byId) : null;
  }
  return p;
}

/** 每個未刪分類（各 kind）→ 實際的上層 id（`effectiveParentId`）；一次算完給樹、路徑、子孫共用 */
export function categoryParentMap(cats: readonly CategoryRow[]): Record<string, string | null> {
  const byId: Record<string, CategoryRow> = {};
  for (const c of cats) if (c.deleted_at === null) byId[c.id] = c;
  const out: Record<string, string | null> = {};
  for (const id in byId) out[id] = effectiveParentId(byId[id], byId);
  return out;
}

/**
 * 任意深度的分類樹（D-票-78）：頂層與每一層都照 position、created_at；未分類固定在頂層最後、底下不掛東西。
 * `includeArchived: false` ⇒ 封存的分類連同它底下整棵不列（封存父分類＝底下整棵都算封存，推廣自兩層時的「子分類同時封存」）。
 */
export function categoryForest(cats: readonly CategoryRow[], kind: CategoryKind, opts: { includeArchived: boolean }): CategoryNode[] {
  const parentOf = categoryParentMap(cats);
  const kids: Record<string, CategoryRow[]> = {};
  const roots: CategoryRow[] = [];
  for (const c of cats) {
    if (c.deleted_at !== null || c.kind !== kind) continue;
    const p = parentOf[c.id];
    if (p === null) roots.push(c);
    else (kids[p] = kids[p] ?? []).push(c);
  }
  roots.sort((a, b) => (isUncat(a.id) ? 1 : 0) - (isUncat(b.id) ? 1 : 0) || byPosThenCreated(a, b));
  const shown = (c: CategoryRow): boolean => opts.includeArchived || c.archived_at === null;
  const build = (c: CategoryRow, depth: number): CategoryNode => ({
    cat: c,
    depth,
    children: isUncat(c.id) ? [] : (kids[c.id] ?? []).filter(shown).sort(byPosThenCreated).map((k) => build(k, depth + 1)),
  });
  return roots.filter(shown).map((c) => build(c, 0));
}

/** 樹攤成前序（＝顯示順序），每個節點帶 depth */
export function flattenForest(nodes: readonly CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = [];
  const walk = (list: readonly CategoryNode[]): void => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 從頂層到自己的那一串（含自己）；走實際的上層（`effectiveParentId`） */
export function categoryPath(cat: CategoryRow, byId: Readonly<Record<string, CategoryRow>>): CategoryRow[] {
  const out: CategoryRow[] = [cat];
  for (let p = effectiveParentId(cat, byId), guard = 0; p !== null && guard < 64; guard++) {
    const row: CategoryRow | undefined = byId[p];
    if (!row) break;
    out.unshift(row);
    p = effectiveParentId(row, byId);
  }
  return out;
}

/** 自己或任何一層上層封存了 ⇒ true（選單、「常用」、帶分類都當它不能用；統計與預算照算） */
export function categoryArchivedUp(cat: CategoryRow, byId: Readonly<Record<string, CategoryRow>>): boolean {
  return categoryPath(cat, byId).some((c) => c.archived_at !== null);
}

/**
 * 自己＋底下所有子孫的 id（未刪，含封存）：前序、每層照 position。統計、預算、篩選「選一個分類＝含子孫」都走這裡。
 * id 不在 cats 裡 ⇒ 只回 [id]。
 */
export function categorySubtreeIds(id: string, cats: readonly CategoryRow[]): string[] {
  const parentOf = categoryParentMap(cats);
  const kids: Record<string, CategoryRow[]> = {};
  for (const c of cats) {
    if (c.deleted_at !== null) continue;
    const p = parentOf[c.id];
    if (p !== null) (kids[p] = kids[p] ?? []).push(c);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (x: string): void => {
    if (seen.has(x)) return;
    seen.add(x);
    out.push(x);
    for (const k of (kids[x] ?? []).slice().sort(byPosThenCreated)) walk(k.id);
  };
  walk(id);
  return out;
}

/**
 * 「移到…」能不能把 id 放到 newParentId 底下（null＝頂層）：能 ⇒ null，不能 ⇒ 人話原因（repository 丟 RangeError 用同一句；
 * UI 拿來把不能選的目標畫成灰的）。規則：未分類不能動、也不能當上層；封存的不能動；目標要在、同 kind；
 * 不能是自己或自己的子孫（防環）；目標或它的上層封存了也不行（放進去就看不到了）。`byId` 含未刪的列（封存的也要）。
 */
export function moveUnderError(id: string, newParentId: string | null, byId: Readonly<Record<string, CategoryRow>>): string | null {
  if (isUncat(id)) return "「未分類」不能移動";
  const c = byId[id];
  if (!c || c.deleted_at !== null) return "這個分類已經不在了";
  if (c.archived_at !== null) return "封存的分類不能移動";
  if (newParentId === null) return null;
  if (isUncat(newParentId)) return "「未分類」底下不能放分類";
  const p = byId[newParentId];
  if (!p || p.deleted_at !== null) return "要移去的分類已經不在了";
  if (p.kind !== c.kind) return "這個分類不屬於目前的收支類型";
  // 子孫用 categorySubtreeIds 判（靠 seen、不靠 categoryPath 的 64 層護欄：再深的鏈也抓得到，不會寫出真環）
  if (categorySubtreeIds(id, Object.values(byId)).includes(newParentId)) return "不能移到自己或自己底下的分類";
  if (categoryPath(p, byId).some((x) => x.archived_at !== null)) return "封存的分類底下不能放分類";
  return null;
}

/**
 * 「移到…」的寫入計畫（D-票-78；repository 兩份共用）：`cats`＝未刪的分類（含封存；別 kind 的會被略過）。
 * - 換上層：parent＝newParentId；**兩邊兄弟組都整組重寫 position**（#101：兩台各排同一組時 hlc 大的那台每一列都贏）——
 *   原本那組少了它、從 0 重編；新的那組插在第 index 個（省略＝最後）、從 0 重編。底下的子孫跟著它走（它們的 parent_id 不用動）。
 * - 上層沒變：等於「搬到第 index 個」（省略＝不動）。父列已不在、本來就算頂層又移到頂層 ⇒ parent＝null（順手把 parent_id 擦乾淨）。
 * - 斷環寫回資料（`breaks`）：同 kind 裡同步合出的環（A→B→A），環上 id 最小的那個（畫面上已經當頂層的）一起寫 parent＝null。
 *   寫進去的就是畫面上原本的樣子：搬環上別的那個時，頂層那個不會翻到它底下；兩台各修也是同一個值；舊版 App 也看得到它們。
 * 不能移 ⇒ RangeError（`moveUnderError` 那句）。parent：要寫進它 parent_id 的值；undefined＝不用寫。
 */
export function planMoveUnder(
  cats: readonly CategoryRow[],
  id: string,
  newParentId: string | null,
  index?: number,
): { parent: string | null | undefined; moves: { id: string; position: number }[]; breaks: string[] } {
  const byId: Record<string, CategoryRow> = {};
  for (const c of cats) if (c.deleted_at === null) byId[c.id] = c;
  const err = moveUnderError(id, newParentId, byId);
  if (err) throw new RangeError(err);
  const c = byId[id];
  const level = (p: string | null): CategoryRow[] =>
    Object.keys(byId)
      .map((k) => byId[k])
      .filter((x) => !isUncat(x.id) && x.kind === c.kind && x.archived_at === null && effectiveParentId(x, byId) === p)
      .sort(byPosThenCreated);
  // parent_id 指到還在的上層、實際卻算頂層 ⇒ 只有「環上 id 最小的那個」這一種（effectiveParentId）
  const breaks = Object.keys(byId).filter((k) => {
    const x = byId[k];
    return k !== id && x.kind === c.kind && rawParentId(x, byId) !== null && effectiveParentId(x, byId) === null;
  });
  const cur = effectiveParentId(c, byId);
  if (cur === newParentId) {
    const moves = index === undefined ? [] : planMoveTo(level(cur), id, index);
    return { parent: c.parent_id === newParentId ? undefined : newParentId, moves, breaks };
  }
  const from = level(cur).filter((x) => x.id !== id);
  const to = level(newParentId).filter((x) => x.id !== id);
  const at = index === undefined ? to.length : Math.max(0, Math.min(to.length, Math.floor(index)));
  to.splice(at, 0, c);
  const moves: { id: string; position: number }[] = [];
  from.forEach((x, i) => moves.push({ id: x.id, position: i }));
  to.forEach((x, i) => moves.push({ id: x.id, position: i }));
  return { parent: newParentId, moves, breaks };
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

/**
 * 完整路徑「🍜 食物 › 外食 › 拉麵」／頂層「🍜 食物」／「未分類」；null ⇒「（分類已刪除）」。
 * `short`（帳簿列、篩選 chip）：只寫最後兩段「外食 › 拉麵」——兩層時與完整路徑相同；完整路徑放滑過（D-票-78）。
 */
export function categoryLabel(cat: CategoryRow | null, catById: Readonly<Record<string, CategoryRow>>, opts?: { short?: boolean }): string {
  if (!cat) return "（分類已刪除）";
  const names = categoryPath(cat, catById).map((c) => c.name);
  return (opts?.short ? names.slice(-2) : names).join(" › ");
}

/**
 * 0-29：完全相符 → 前綴 → 包含（比的是**末段名字**，不比路徑）；排除封存（含封存分類底下整棵）、未分類、別 kind。
 * 同一級裡：深的在前（兩層時的「子先主後」推廣：越細越可能是想記的那個），同深度照樹順序；
 * **同名的**（catKey 相同，例：頂層「午餐」與「食物 › 外食 › 午餐」）排在一起、路徑短的在前（D-票-78）。
 */
export function matchCategories(query: string, cats: readonly CategoryRow[], kind: CategoryKind): CategoryRow[] {
  const q = catKey(query);
  if (!q) return [];
  const flat = flattenForest(categoryForest(cats, kind, { includeArchived: false })).filter((n) => !isUncat(n.cat.id));
  const idx: Record<string, number> = {};
  flat.forEach((n, i) => (idx[n.cat.id] = i));
  const deepFirst = flat.slice().sort((a, b) => b.depth - a.depth || idx[a.cat.id] - idx[b.cat.id]);
  const tests: ((k: string) => boolean)[] = [(k) => k === q, (k) => k.startsWith(q), (k) => k.indexOf(q) >= 0];
  const out: CategoryRow[] = [];
  const seen = new Set<string>();
  for (const t of tests) {
    // 這一級命中的，照「名字第一次出現」分組；組內路徑短的在前
    const groups: Record<string, CategoryNode[]> = {};
    const keys: string[] = [];
    for (const n of deepFirst) {
      if (seen.has(n.cat.id)) continue;
      const k = catKey(n.cat.name);
      if (!k || !t(k)) continue;
      seen.add(n.cat.id);
      if (!groups[k]) {
        groups[k] = [];
        keys.push(k);
      }
      groups[k].push(n);
    }
    for (const k of keys) for (const n of groups[k].sort((a, b) => a.depth - b.depth || idx[a.cat.id] - idx[b.cat.id])) out.push(n.cat);
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

/**
 * 「搬到第 index 個」（售票口④；拖曳用，契約 §5）：list＝已照顯示順序排好的整組；把 id 拿出來插到 index（夾在 0..n-1），
 * 回「整組」每列的 { id, position: 0..n-1 }——跟 repository 的 planSwap 同一個整組寫骨架（#101：兩台各排同一組時
 * hlc 大的那台在每一列都贏，完整採用其中一台）。id 不在 list、或位置沒變 ⇒ 空陣列（不寫）。
 */
export function planMoveTo<T extends { id: string }>(list: readonly T[], id: string, index: number): { id: string; position: number }[] {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0 || !Number.isInteger(index)) return [];
  const j = Math.max(0, Math.min(list.length - 1, index));
  if (i === j) return [];
  const ids = list.map((x) => x.id);
  ids.splice(i, 1);
  ids.splice(j, 0, id);
  return ids.map((x, k) => ({ id: x, position: k }));
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
