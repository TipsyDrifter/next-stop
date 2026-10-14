/**
 * 售票口線的記憶體實作（車次①契約 §3.7；甲席 Stage 0 全文）——`?mock=1` 純瀏覽器預覽用，乙丙席開發靠它。
 *
 * - 資料存 `Map`，進出一律複製（同 `memoryTimetableRepository.ts`）。所有寫入走**同一套 domain 函式**
 *   （`buildEntryRow`／`applyEntryPatch`／`adjustRow`／`materializeImport`），`balances` 用 `balancesOf`——mock 與真機語義一致。
 * - `ensureStarterRows` 照真機（`?mock=1&wiped=1` 也種：它是空庫第一次開）。
 * - 示範資料（`seedDemo`，第一次讀取時 lazy 種；固定種子的 PRNG，截圖穩定）：帳戶＝樣本格式 §三的 7 個名稱與群組；
 *   分類＝樣本格式 §四的現用樹（名稱照搬含 emoji）；幣別 TWD＋USD（31.549671）＋CNY（4.35）；帳＝今天往前 62 天、
 *   每天 0–4 筆（支出為主、每週一筆收入、每月兩筆轉帳、一筆退款、一筆 USD、一筆精算），金額亂數。
 * - 評審端點（本檔自己讀 `location.search`，不經 `DEV_FLAGS`——那是集中檔）：
 *     `&tk=empty`     帳戶與分類樹照種、一筆帳都沒有（「這本帳還是空的」）
 *     `&tk=noaccount` 只有起手三列（捕捉框報「還沒有帳戶」）
 *     `&tk=badschema` `readImport` 回 `{ missing: ["ASSETS"], dump: null }`
 *     `&tk=import2`   同一頁第二次起的 `readImport` 回「其中 2 筆 UTIME＋1、備註改字」的版本（驗「已修改 2」）
 * - 匯入：`pickImportFile` 回 `"mock.mmbak"`；`readImport` 回 fixture dump（`mockImportDump`；與示範資料同一棵樹）。
 */
import { nowUtcIso, uuid } from "../lib/db";
import { addDays, todayKey } from "../lib/date";
import {
  CURRENCY_NAMES,
  IMPORT_CHUNK,
  STARTER_CATEGORIES,
  STARTER_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  adjustRow,
  applyEntryPatch,
  balancesOf,
  buildEntryRow,
  currencyCode,
  materializeImport,
  minorFromDecimal,
  orderAccounts,
  parseRate,
  planAdjust,
  ticketId,
  type AccountRow,
  type CategoryKind,
  type CategoryRow,
  type CurrencyRow,
  type EntryCtx,
  type EntryPatch,
  type EntryRow,
  type ImportChoice,
  type ImportLocal,
  type ImportOutcome,
  type ImportPlan,
  type MmbakDump,
  type MmbakReadResult,
  type MmTx,
  type NewEntryInput,
} from "../domain/ticket";
import type {
  AccountPatch,
  CurrencyPatch,
  NewAccountInput,
  NewCategoryInput,
  NewCurrencyInput,
  TicketRepository,
} from "./ticketRepository";

const clone = <T extends object>(o: T): T => ({ ...o });
const isAlive = (r: { deleted_at: string | null }): boolean => r.deleted_at === null;
const isUncat = (id: string): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** 「新近」排序：created_at → occurred_on → occurred_at → id（匯入列 created_at 全同，靠後三者破平手；與 sqlite 版同義） */
const recency = (a: EntryRow, b: EntryRow): number =>
  cmp(a.created_at, b.created_at) || cmp(a.occurred_on, b.occurred_on) || cmp(a.occurred_at, b.occurred_at) || cmp(a.id, b.id);

type TkMode = "empty" | "noaccount" | "badschema" | "import2" | null;

/** 評審端點：`&tk=empty|noaccount|badschema|import2` */
function tkMode(): TkMode {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("tk");
    return v === "empty" || v === "noaccount" || v === "badschema" || v === "import2" ? v : null;
  } catch {
    return null;
  }
}

/** 固定種子的 PRNG（mulberry32） */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ───────── 示範資料的形狀（樣本格式 §三、§四；名稱照搬，金額一律合成） ───────── */

/** 帳戶：名稱、群組（兩個「悠遊卡」分屬 bank／debit） */
const DEMO_ACCOUNTS: { key: string; name: string; group: string }[] = [
  { key: "cash", name: "現金", group: "cash" },
  { key: "bank", name: "帳戶", group: "bank" },
  { key: "student", name: "學生證", group: "bank" },
  { key: "lend", name: "出借貸款", group: "investment" },
  { key: "easy", name: "悠遊卡", group: "bank" },
  { key: "easyDebit", name: "悠遊卡", group: "debit" },
  { key: "card", name: "信用卡", group: "card" },
];

const DEMO_INCOME: string[] = ["💵 生活費", "💴 補貼", "💳 薪水", "🧧 紅利", "零花錢", "學費", "退款", "被請客", "其他"];

const DEMO_EXPENSE: { name: string; children: string[] }[] = [
  { name: "🍜 食物", children: ["早餐", "午餐", "晚餐", "宵夜", "點心", "飲料", "水果", "麵包"] },
  { name: "🚖 交通", children: ["公車", "捷運", "火車", "高鐵", "客運", "計程車", "自行車", "租車"] },
  { name: "🪑 生活", children: ["房租", "費用", "雜貨", "食材", "盥洗用品", "電子用品", "線上服務", "洗衣", "傢俱"] },
  { name: "📙 教育", children: ["學費", "課本", "書籍？", "線上課程", "學習用品", "生產力工具", "活動"] },
  { name: "🖼 文化", children: ["書籍", "電影", "音樂", "展覽", "應用程式", "藝品"] },
  { name: "🎣 休閒", children: ["獨旅", "寵物", "電子遊戲"] },
  { name: "👬🏻 社交", children: ["聚餐", "旅行", "遊車盒", "社團", "🎁 禮物"] },
  { name: "🧘🏼 健康", children: ["健康", "運動", "醫院", "藥物"] },
  { name: "🧥 服飾", children: ["服裝", "鞋", "飾品", "美容"] },
  { name: "其他", children: [] },
];

const DEMO_NOTES = ["", "", "", "便當", "全家", "學餐", "7-11", "和同學", "", "早上那班"];

/* ───────── 匯入 fixture（與示範資料同一棵樹；~120 筆；UTIME 固定） ───────── */

const MM_GROUPS = ["現金", "帳戶", "信用卡", "扣帳卡", "定期存款", "電子貨幣", "投資", "信用額度", "貸款", "保險", "其他"];
const MM_ACC: { uid: string; name: string; group: string }[] = [
  { uid: "mm-a1", name: "現金", group: "現金" },
  { uid: "mm-a2", name: "帳戶", group: "帳戶" },
  { uid: "mm-a3", name: "學生證", group: "帳戶" },
  { uid: "mm-a4", name: "出借貸款", group: "投資" },
  { uid: "mm-a5", name: "悠遊卡", group: "帳戶" },
  { uid: "mm-a6", name: "悠遊卡", group: "扣帳卡" },
  { uid: "mm-a7", name: "信用卡", group: "信用卡" },
];
const MM_UTIME = 1759276800000; // 固定（2025-10-01T00:00:00Z）

/** 匯入 fixture；variant＝"import2" ⇒ 其中 2 筆 UTIME＋1、備註改字 */
export function mockImportDump(variant: "base" | "import2"): MmbakDump {
  const rnd = prng(20261011);
  const groups = MM_GROUPS.map((name, i) => ({ uid: `mm-g${i + 1}`, type_code: i + 1, name }));
  const groupUid = (name: string) => groups.find((g) => g.name === name)?.uid ?? null;
  const currencies = [
    { uid: "mm-c1", iso: "TWD", is_main: true, rate: "1", decimals: 2 },
    { uid: "mm-c2", iso: "USD", is_main: false, rate: "31.549671", decimals: 2 },
    { uid: "mm-c3", iso: "CNY", is_main: false, rate: "4.35", decimals: 2 },
  ];
  const accounts = MM_ACC.map((a) => ({ uid: a.uid, name: a.name, group_uid: groupUid(a.group), currency_uid: "mm-c1", is_del: false }));
  const categories: MmbakDump["categories"] = [];
  DEMO_INCOME.forEach((name, i) => categories.push({ uid: `mm-ci${i}`, type_code: 0, name, parent_uid: null, status: 0, is_del: false }));
  const expenseLeaves: string[] = [];
  DEMO_EXPENSE.forEach((p, i) => {
    categories.push({ uid: `mm-ce${i}`, type_code: 1, name: p.name, parent_uid: null, status: 0, is_del: false });
    p.children.forEach((c, j) => {
      const uid = `mm-ce${i}-${j}`;
      categories.push({ uid, type_code: 1, name: c, parent_uid: `mm-ce${i}`, status: 2, is_del: false });
      expenseLeaves.push(uid);
    });
  });
  // 一個被指到的已刪分類、一個沒被指到的已刪分類
  categories.push({ uid: "mm-cdel1", type_code: 1, name: "🎮 舊遊戲", parent_uid: null, status: 0, is_del: true });
  categories.push({ uid: "mm-cdel2", type_code: 1, name: "舊分類", parent_uid: null, status: 0, is_del: true });

  const txs: MmTx[] = [];
  let n = 0;
  const day = (i: number): string => addDays("2026-07-01", i);
  const zdate = (d: string, h: number): string => {
    const [y, m, dd] = d.split("-").map((s) => parseInt(s, 10));
    return String(new Date(y, m - 1, dd, h, Math.floor(rnd() * 60)).getTime());
  };
  const push = (t: Partial<MmTx> & { do_type: string; wdate: string; zmoney: string; asset_uid: string | null }) => {
    n++;
    txs.push({
      uid: t.uid ?? `mm-t${n}`,
      do_type: t.do_type,
      asset_uid: t.asset_uid,
      to_asset_uid: t.to_asset_uid ?? null,
      tx_uid_trans: t.tx_uid_trans ?? null,
      ctg_uid: t.ctg_uid ?? null,
      zmoney: t.zmoney,
      currency_uid: t.currency_uid ?? "mm-c1",
      wdate: t.wdate,
      zdate: t.zdate ?? zdate(t.wdate, 12),
      content: t.content ?? "",
      utime: t.utime ?? MM_UTIME,
      is_del: t.is_del ?? false,
    });
  };
  const spendAcc = ["mm-a1", "mm-a1", "mm-a2", "mm-a3", "mm-a3", "mm-a5"];
  for (let i = 0; i < 100; i++) {
    const d = day(Math.floor(i * 0.9));
    if (i % 12 === 0) {
      push({ do_type: "0", wdate: d, zmoney: String(2000 + Math.floor(rnd() * 60) * 50), asset_uid: "mm-a2", ctg_uid: `mm-ci${i % 3}` });
    } else {
      const leaf = expenseLeaves[Math.floor(rnd() * expenseLeaves.length)];
      push({
        do_type: "1",
        wdate: d,
        zdate: zdate(d, 8 + Math.floor(rnd() * 14)),
        zmoney: String(30 + Math.floor(rnd() * 470)) + (rnd() < 0.15 ? ".5" : ".0"),
        asset_uid: spendAcc[Math.floor(rnd() * spendAcc.length)],
        ctg_uid: leaf,
        content: DEMO_NOTES[Math.floor(rnd() * DEMO_NOTES.length)],
      });
    }
  }
  // 3 對轉帳＋1 條缺腿
  const transfer = (key: string, d: string, from: string, to: string, amt: string) => {
    push({ do_type: "3", wdate: d, zmoney: amt, asset_uid: from, to_asset_uid: to, tx_uid_trans: key, content: "儲值" });
    push({ do_type: "4", wdate: d, zmoney: amt, asset_uid: to, to_asset_uid: from, tx_uid_trans: key });
  };
  transfer("mm-tr1", day(5), "mm-a2", "mm-a3", "500");
  transfer("mm-tr2", day(35), "mm-a2", "mm-a1", "1000");
  transfer("mm-tr3", day(70), "mm-a1", "mm-a5", "300");
  push({ do_type: "3", wdate: day(80), zmoney: "200", asset_uid: "mm-a2", to_asset_uid: "mm-a3", tx_uid_trans: "mm-tr-lonely" });
  // 4 筆差別
  push({ do_type: "7", wdate: day(10), zmoney: "120", asset_uid: "mm-a1" });
  push({ do_type: "8", wdate: day(40), zmoney: "37", asset_uid: "mm-a1" });
  push({ do_type: "7", wdate: day(20), zmoney: "15000", asset_uid: "mm-a2" });
  push({ do_type: "8", wdate: day(60), zmoney: "2000", asset_uid: "mm-a4" });
  // 孤兒、被指到的已刪分類、USD、CNY、一筆已刪
  push({ do_type: "1", wdate: day(12), zmoney: "99", asset_uid: "mm-a1", ctg_uid: "mm-cmissing", content: "分類被硬刪的那筆" });
  push({ do_type: "1", wdate: day(14), zmoney: "450", asset_uid: "mm-a2", ctg_uid: "mm-cdel1", content: "舊遊戲" });
  push({ do_type: "1", wdate: day(16), zmoney: "10", asset_uid: "mm-a2", ctg_uid: expenseLeaves[40], currency_uid: "mm-c2", content: "App Store" });
  push({ do_type: "1", wdate: day(18), zmoney: "35", asset_uid: "mm-a1", ctg_uid: expenseLeaves[1], currency_uid: "mm-c3", content: "上海午餐" });
  push({ do_type: "1", wdate: day(19), zmoney: "60", asset_uid: "mm-a1", ctg_uid: expenseLeaves[0], is_del: true });

  if (variant === "import2") {
    for (const uid of ["mm-t2", "mm-t3"]) {
      const t = txs.find((x) => x.uid === uid);
      if (t) {
        t.utime += 1;
        t.content = (t.content ? t.content + " " : "") + "（財務管家改過）";
      }
    }
  }
  return { file_name: "mock.mmbak", currencies, groups, accounts, categories, transactions: txs };
}

/* ───────── 實作 ───────── */

export class MemoryTicketRepository implements TicketRepository {
  private readonly cur = new Map<string, CurrencyRow>();
  private readonly acc = new Map<string, AccountRow>();
  private readonly cat = new Map<string, CategoryRow>();
  private readonly ent = new Map<string, EntryRow>();
  private readonly seedDemo: boolean;
  private demoSeeded = false;
  private readCount = 0;

  constructor(opts: { seedDemo: boolean }) {
    this.seedDemo = opts.seedDemo;
  }

  /* ───────── 內部 ───────── */

  /** 起手三列：依 id 查（含墓碑），缺幾列補幾列 */
  private seedStarter(nowIso: string): number {
    let n = 0;
    const stamp = { device_id: null, created_at: nowIso, updated_at: nowIso, synced_at: null, deleted_at: null };
    if (!this.cur.has(STARTER_CURRENCY.id)) {
      this.cur.set(STARTER_CURRENCY.id, { ...STARTER_CURRENCY, ...stamp });
      n++;
    }
    for (const c of STARTER_CATEGORIES) {
      if (this.cat.has(c.id)) continue;
      this.cat.set(c.id, { ...c, archived_at: null, ...stamp });
      n++;
    }
    return n;
  }

  private ensureDemo(): void {
    if (this.demoSeeded) return;
    this.demoSeeded = true;
    const mode = tkMode();
    if (!this.seedDemo || mode === "noaccount") return;
    const nowIso = nowUtcIso();
    this.seedStarter(nowIso);
    const stamp = { device_id: null, created_at: nowIso, updated_at: nowIso, synced_at: null, deleted_at: null };

    // 幣別
    this.cur.set(ticketId("currency:USD"), {
      id: ticketId("currency:USD"), code: "USD", name: "美元", decimals: 2, rate_to_main: "31.549671", is_main: 0, position: 1, ...stamp,
    });
    this.cur.set(ticketId("currency:CNY"), {
      id: ticketId("currency:CNY"), code: "CNY", name: "人民幣", decimals: 2, rate_to_main: "4.35", is_main: 0, position: 2, ...stamp,
    });

    // 帳戶
    const accId: Record<string, string> = {};
    const posByGroup: Record<string, number> = {};
    for (const a of DEMO_ACCOUNTS) {
      const id = uuid();
      accId[a.key] = id;
      const position = (posByGroup[a.group] = (posByGroup[a.group] ?? -1) + 1);
      this.acc.set(id, { id, name: a.name, group_key: a.group, currency: "TWD", position, archived_at: null, ...stamp });
    }

    // 分類
    const incomeIds: string[] = [];
    DEMO_INCOME.forEach((name, i) => {
      const id = uuid();
      incomeIds.push(id);
      this.cat.set(id, { id, kind: "income", name, parent_id: null, position: i, archived_at: null, ...stamp });
    });
    const leafIds: string[] = [];
    DEMO_EXPENSE.forEach((p, i) => {
      const pid = uuid();
      this.cat.set(pid, { id: pid, kind: "expense", name: p.name, parent_id: null, position: i, archived_at: null, ...stamp });
      p.children.forEach((c, j) => {
        const id = uuid();
        leafIds.push(id);
        this.cat.set(id, { id, kind: "expense", name: c, parent_id: pid, position: j, archived_at: null, ...stamp });
      });
    });

    if (mode === "empty") return;

    // 帳：今天往前 62 天
    const rnd = prng(20261012);
    const today = todayKey(3);
    const ctx = this.ctx();
    const add = (input: NewEntryInput) => {
      const row = buildEntryRow(input, ctx, { id: uuid(), nowIso: input.occurredAt });
      this.ent.set(row.id, row);
    };
    const at = (dayKey: string, h: number): string => {
      const [y, m, d] = dayKey.split("-").map((s) => parseInt(s, 10));
      return new Date(y, m - 1, d, h, Math.floor(rnd() * 60)).toISOString();
    };
    const spend = [accId.cash, accId.cash, accId.cash, accId.bank, accId.student, accId.student, accId.easy];
    for (let back = 62; back >= 0; back--) {
      const dayKey = addDays(today, -back);
      const count = Math.floor(rnd() * 5);
      for (let k = 0; k < count; k++) {
        add({
          kind: "expense",
          amountMinor: minorFromDecimal(String(30 + Math.floor(rnd() * 470)), 2, "strict"),
          currency: "TWD",
          accountId: spend[Math.floor(rnd() * spend.length)],
          toAccountId: null,
          categoryId: leafIds[Math.floor(rnd() * leafIds.length)],
          occurredOn: dayKey,
          occurredAt: at(dayKey, 8 + Math.floor(rnd() * 14)),
          note: DEMO_NOTES[Math.floor(rnd() * DEMO_NOTES.length)],
          routeId: null,
        });
      }
      if (back % 7 === 3) {
        add({
          kind: "income", amountMinor: minorFromDecimal(String(5000 + Math.floor(rnd() * 60) * 50), 2, "strict"), currency: "TWD", accountId: accId.bank,
          toAccountId: null, categoryId: incomeIds[back % 2], occurredOn: dayKey, occurredAt: at(dayKey, 9), note: "", routeId: null,
        });
      }
      if (back % 15 === 4) {
        add({
          kind: "transfer", amountMinor: 1200000, currency: "TWD", accountId: accId.bank, toAccountId: [accId.cash, accId.student, accId.cash, accId.easy][Math.floor(back / 15) % 4],
          categoryId: null, occurredOn: dayKey, occurredAt: at(dayKey, 10), note: "儲值", routeId: null,
        });
      }
      if (back === 5) {
        add({
          kind: "expense", amountMinor: -35000, currency: "TWD", accountId: accId.cash, toAccountId: null, categoryId: leafIds[25],
          occurredOn: dayKey, occurredAt: at(dayKey, 15), note: "退貨退款", routeId: null,
        });
      }
      if (back === 9) {
        add({
          kind: "expense", amountMinor: 1000, currency: "USD", accountId: accId.bank, toAccountId: null, categoryId: leafIds[40],
          occurredOn: dayKey, occurredAt: at(dayKey, 21), note: "App Store", routeId: null,
        });
      }
      if (back === 20) {
        const row = adjustRow({
          account: this.acc.get(accId.cash) as AccountRow, amountMinor: -3700, occurredOn: dayKey, nowIso: at(dayKey, 22),
          note: "餘額調整", id: uuid(), curByCode: ctx.curByCode,
        });
        this.ent.set(row.id, row);
      }
    }
  }

  private ctx(): EntryCtx {
    const accById: Record<string, AccountRow> = {};
    const catById: Record<string, CategoryRow> = {};
    const curByCode: Record<string, CurrencyRow> = {};
    for (const a of this.acc.values()) if (isAlive(a)) accById[a.id] = a;
    for (const c of this.cat.values()) if (isAlive(c)) catById[c.id] = c;
    for (const c of this.cur.values()) if (isAlive(c)) curByCode[c.code] = c;
    return { accById, catById, curByCode };
  }

  private accountOrThrow(id: string): AccountRow {
    const a = this.acc.get(id);
    if (!a || !isAlive(a)) throw new RangeError("這個帳戶已經不在了");
    return a;
  }

  private categoryOrThrow(id: string): CategoryRow {
    const c = this.cat.get(id);
    if (!c || !isAlive(c)) throw new RangeError("這個分類已經不在了");
    return c;
  }

  private balanceMap(): Record<string, number> {
    const all = balancesOf(Array.from(this.ent.values()));
    const out: Record<string, number> = {};
    for (const a of this.acc.values()) if (isAlive(a)) out[a.id] = all[a.id] ?? 0;
    return out;
  }

  /** 同組鄰居互換（先依現順序把 position 攤成 0..n-1，再換） */
  private swapIn<T extends { id: string; position: number; updated_at: string }>(list: T[], id: string, delta: 1 | -1, nowIso: string): void {
    const i = list.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    list.forEach((x, k) => {
      if (x.position !== k) {
        x.position = k;
        x.updated_at = nowIso;
      }
    });
    list[i].position = j;
    list[j].position = i;
    list[i].updated_at = nowIso;
    list[j].updated_at = nowIso;
  }

  /* ───────── 起手 ───────── */

  async ensureStarterRows(): Promise<number> {
    this.ensureDemo();
    return this.seedStarter(nowUtcIso());
  }

  /* ───────── 讀 ───────── */

  async listCurrencies(): Promise<CurrencyRow[]> {
    this.ensureDemo();
    return Array.from(this.cur.values())
      .filter(isAlive)
      .sort((a, b) => a.position - b.position || cmp(a.code, b.code))
      .map(clone);
  }

  async listAccounts(): Promise<AccountRow[]> {
    this.ensureDemo();
    return orderAccounts(Array.from(this.acc.values()).filter(isAlive)).map(clone);
  }

  async listCategories(): Promise<CategoryRow[]> {
    this.ensureDemo();
    return Array.from(this.cat.values())
      .filter(isAlive)
      .sort(
        (a, b) =>
          cmp(a.kind, b.kind) ||
          (a.parent_id === null ? 0 : 1) - (b.parent_id === null ? 0 : 1) ||
          a.position - b.position ||
          cmp(a.created_at, b.created_at),
      )
      .map(clone);
  }

  async balances(): Promise<Record<string, number>> {
    this.ensureDemo();
    return this.balanceMap();
  }

  async listEntries(fromDay: string, toDayExcl: string, accountId: string | null): Promise<EntryRow[]> {
    this.ensureDemo();
    return Array.from(this.ent.values())
      .filter(
        (e) =>
          isAlive(e) &&
          e.occurred_on >= fromDay &&
          e.occurred_on < toDayExcl &&
          (accountId === null || e.account_id === accountId || e.to_account_id === accountId),
      )
      .sort(
        (a, b) =>
          cmp(b.occurred_on, a.occurred_on) || cmp(b.occurred_at, a.occurred_at) || cmp(b.created_at, a.created_at) || cmp(b.id, a.id),
      )
      .map(clone);
  }

  async getEntry(id: string): Promise<EntryRow | null> {
    this.ensureDemo();
    const e = this.ent.get(id);
    return e && isAlive(e) ? clone(e) : null;
  }

  async hasAnyEntry(): Promise<boolean> {
    this.ensureDemo();
    for (const e of this.ent.values()) if (isAlive(e)) return true;
    return false;
  }

  async lastUsedAccountId(): Promise<string | null> {
    this.ensureDemo();
    let best: EntryRow | null = null;
    for (const e of this.ent.values()) {
      if (!isAlive(e) || e.kind === "adjust") continue;
      if (!best || recency(e, best) > 0) best = e;
    }
    return best ? best.account_id : null;
  }

  async recentCategoryIds(kind: CategoryKind, limit: number): Promise<string[]> {
    this.ensureDemo();
    const last: Record<string, EntryRow> = {};
    for (const e of this.ent.values()) {
      if (!isAlive(e) || e.kind !== kind || !e.category_id || isUncat(e.category_id)) continue;
      const c = this.cat.get(e.category_id);
      if (!c || !isAlive(c) || c.archived_at !== null) continue;
      if (!last[e.category_id] || recency(e, last[e.category_id]) > 0) last[e.category_id] = e;
    }
    return Object.keys(last)
      .sort((a, b) => recency(last[b], last[a]))
      .slice(0, limit);
  }

  /* ───────── 寫：帳 ───────── */

  async createEntry(input: NewEntryInput): Promise<EntryRow> {
    this.ensureDemo();
    const row = buildEntryRow(input, this.ctx(), { id: uuid(), nowIso: nowUtcIso() });
    this.ent.set(row.id, row);
    return clone(row);
  }

  async updateEntry(id: string, patch: EntryPatch): Promise<EntryRow> {
    this.ensureDemo();
    const row = this.ent.get(id);
    if (!row) throw new RangeError("這一筆已經刪除了");
    const res = applyEntryPatch(row, patch, this.ctx(), nowUtcIso());
    if (Object.keys(res.cols).length === 0) return clone(row);
    this.ent.set(id, res.row);
    return clone(res.row);
  }

  async softDeleteEntry(id: string): Promise<void> {
    this.ensureDemo();
    const row = this.ent.get(id);
    if (!row || !isAlive(row)) return;
    const now = nowUtcIso();
    row.deleted_at = now;
    row.updated_at = now;
  }

  async restoreEntry(id: string): Promise<void> {
    this.ensureDemo();
    const row = this.ent.get(id);
    if (!row || isAlive(row)) return;
    row.deleted_at = null;
    row.updated_at = nowUtcIso();
  }

  /* ───────── 寫：帳戶 ───────── */

  async createAccount(input: NewAccountInput): Promise<AccountRow> {
    this.ensureDemo();
    const name = input.name.trim();
    if (!name) throw new RangeError("帳戶名稱不能是空的");
    const ctx = this.ctx();
    if (!ctx.curByCode[input.currency]) throw new RangeError(`沒有這個幣別：${input.currency}`);
    const nowIso = nowUtcIso();
    let position = -1;
    for (const a of this.acc.values()) if (isAlive(a) && a.group_key === input.group) position = Math.max(position, a.position);
    const row: AccountRow = {
      id: uuid(), name, group_key: input.group, currency: input.currency, position: position + 1, archived_at: null,
      device_id: null, created_at: nowIso, updated_at: nowIso, synced_at: null, deleted_at: null,
    };
    let opening: EntryRow | null = null;
    if (input.openingMinor !== null && input.openingMinor !== 0) {
      opening = adjustRow({
        account: row, amountMinor: input.openingMinor, occurredOn: input.occurredOn, nowIso, note: "期初餘額", id: uuid(),
        curByCode: ctx.curByCode,
      });
    }
    this.acc.set(row.id, row);
    if (opening) this.ent.set(opening.id, opening);
    return clone(row);
  }

  async updateAccount(id: string, patch: AccountPatch): Promise<void> {
    this.ensureDemo();
    const a = this.accountOrThrow(id);
    const next = clone(a);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new RangeError("帳戶名稱不能是空的");
      next.name = name;
    }
    if (patch.currency !== undefined && patch.currency !== a.currency) {
      if (!this.ctx().curByCode[patch.currency]) throw new RangeError(`沒有這個幣別：${patch.currency}`);
      for (const e of this.ent.values()) {
        if (isAlive(e) && (e.account_id === id || e.to_account_id === id)) throw new RangeError("這個帳戶已經有帳，幣別不能改");
      }
      next.currency = patch.currency;
    }
    if (patch.group !== undefined && patch.group !== a.group_key) {
      let position = -1;
      for (const x of this.acc.values()) if (isAlive(x) && x.group_key === patch.group) position = Math.max(position, x.position);
      next.group_key = patch.group;
      next.position = position + 1;
    }
    if (next.name === a.name && next.currency === a.currency && next.group_key === a.group_key) return;
    next.updated_at = nowUtcIso();
    this.acc.set(id, next);
  }

  async setAccountArchived(id: string, archived: boolean): Promise<void> {
    this.ensureDemo();
    const a = this.accountOrThrow(id);
    if ((a.archived_at !== null) === archived) return;
    const now = nowUtcIso();
    a.archived_at = archived ? now : null;
    a.updated_at = now;
  }

  async moveAccount(id: string, delta: 1 | -1): Promise<void> {
    this.ensureDemo();
    const a = this.accountOrThrow(id);
    const list = orderAccounts(Array.from(this.acc.values()).filter((x) => isAlive(x) && x.archived_at === null && x.group_key === a.group_key));
    this.swapIn(list, id, delta, nowUtcIso());
  }

  async adjustBalance(accountId: string, targetMinor: number, occurredOn: string, note: string): Promise<EntryRow | null> {
    this.ensureDemo();
    const a = this.accountOrThrow(accountId);
    const d = planAdjust(this.balanceMap()[accountId] ?? 0, targetMinor);
    if (d === null) return null;
    const row = adjustRow({ account: a, amountMinor: d, occurredOn, nowIso: nowUtcIso(), note, id: uuid(), curByCode: this.ctx().curByCode });
    this.ent.set(row.id, row);
    return clone(row);
  }

  /* ───────── 寫：分類 ───────── */

  async createCategory(input: NewCategoryInput): Promise<CategoryRow> {
    this.ensureDemo();
    const name = input.name.trim();
    if (!name) throw new RangeError("分類名稱不能是空的");
    if (input.parentId !== null) {
      if (isUncat(input.parentId)) throw new RangeError("「未分類」下面不能建子分類");
      const p = this.categoryOrThrow(input.parentId);
      if (p.kind !== input.kind) throw new RangeError("分類和收支類型對不上");
      if (p.parent_id !== null) throw new RangeError("分類只有兩層");
    }
    let position = -1;
    for (const c of this.cat.values()) {
      if (isAlive(c) && !isUncat(c.id) && c.kind === input.kind && c.parent_id === input.parentId) position = Math.max(position, c.position);
    }
    const nowIso = nowUtcIso();
    const row: CategoryRow = {
      id: uuid(), kind: input.kind, name, parent_id: input.parentId, position: position + 1, archived_at: null,
      device_id: null, created_at: nowIso, updated_at: nowIso, synced_at: null, deleted_at: null,
    };
    this.cat.set(row.id, row);
    return clone(row);
  }

  async renameCategory(id: string, name: string): Promise<void> {
    this.ensureDemo();
    if (isUncat(id)) throw new RangeError("「未分類」不能改名或封存");
    const c = this.categoryOrThrow(id);
    const n = name.trim();
    if (!n) throw new RangeError("分類名稱不能是空的");
    if (n === c.name) return;
    c.name = n;
    c.updated_at = nowUtcIso();
  }

  async setCategoryArchived(id: string, archived: boolean): Promise<void> {
    this.ensureDemo();
    if (isUncat(id)) throw new RangeError("「未分類」不能改名或封存");
    const c = this.categoryOrThrow(id);
    const now = nowUtcIso();
    const kids = Array.from(this.cat.values()).filter((x) => isAlive(x) && x.parent_id === id);
    if (archived) {
      if (c.archived_at !== null) return;
      c.archived_at = now;
      c.updated_at = now;
      for (const k of kids) {
        if (k.archived_at !== null) continue;
        k.archived_at = now;
        k.updated_at = now;
      }
    } else {
      if (c.archived_at === null) return;
      const was = c.archived_at;
      c.archived_at = null;
      c.updated_at = now;
      for (const k of kids) {
        if (k.archived_at !== was) continue;
        k.archived_at = null;
        k.updated_at = now;
      }
    }
  }

  async moveCategory(id: string, delta: 1 | -1): Promise<void> {
    this.ensureDemo();
    if (isUncat(id)) return;
    const c = this.categoryOrThrow(id);
    const list = Array.from(this.cat.values())
      .filter((x) => isAlive(x) && x.archived_at === null && !isUncat(x.id) && x.kind === c.kind && x.parent_id === c.parent_id)
      .sort((a, b) => a.position - b.position || cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
    this.swapIn(list, id, delta, nowUtcIso());
  }

  /* ───────── 寫：幣別 ───────── */

  async createCurrency(input: NewCurrencyInput): Promise<CurrencyRow> {
    this.ensureDemo();
    const code = currencyCode(input.code);
    const id = ticketId("currency:" + code);
    const prev = this.cur.get(id);
    if (prev && isAlive(prev)) throw new RangeError(`已經有 ${code} 了`);
    const rate = parseRate(input.rate);
    let position = -1;
    for (const c of this.cur.values()) if (isAlive(c)) position = Math.max(position, c.position);
    const nowIso = nowUtcIso();
    const row: CurrencyRow = {
      id, code, name: input.name.trim() || (CURRENCY_NAMES[code] ?? code),
      decimals: Number.isInteger(input.decimals) && input.decimals >= 0 ? input.decimals : 2,
      rate_to_main: rate, is_main: 0, position: position + 1,
      device_id: null, created_at: prev ? prev.created_at : nowIso, updated_at: nowIso, synced_at: null, deleted_at: null,
    };
    this.cur.set(id, row);
    return clone(row);
  }

  async updateCurrency(id: string, patch: CurrencyPatch): Promise<void> {
    this.ensureDemo();
    const c = this.cur.get(id);
    if (!c || !isAlive(c)) throw new RangeError(`沒有這個幣別：${id}`);
    let changed = false;
    if (patch.rate !== undefined) {
      if (c.is_main === 1) throw new RangeError("主幣別的匯率固定是 1");
      const rate = parseRate(patch.rate);
      if (rate !== c.rate_to_main) {
        c.rate_to_main = rate;
        changed = true;
      }
    }
    if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== c.name) {
      c.name = patch.name.trim();
      changed = true;
    }
    if (changed) c.updated_at = nowUtcIso();
  }

  /* ───────── 匯入 ───────── */

  async pickImportFile(_shell: "desktop" | "mobile"): Promise<string | null> {
    return "mock.mmbak";
  }

  async readImport(_path: string): Promise<MmbakReadResult> {
    this.readCount++;
    const mode = tkMode();
    if (mode === "badschema") return { missing: ["ASSETS"], dump: null };
    return { missing: [], dump: mockImportDump(mode === "import2" && this.readCount > 1 ? "import2" : "base") };
  }

  async loadImportLocal(): Promise<ImportLocal> {
    this.ensureDemo();
    return {
      currencies: Array.from(this.cur.values()).map(clone),
      accounts: Array.from(this.acc.values()).map(clone),
      categories: Array.from(this.cat.values()).map(clone),
      entries: Array.from(this.ent.values()).map(clone),
    };
  }

  async applyImport(
    plan: ImportPlan,
    choices: Readonly<Record<string, ImportChoice>>,
    onProgress: (done: number, total: number) => void,
  ): Promise<ImportOutcome> {
    this.ensureDemo();
    const nowIso = nowUtcIso();
    const m = materializeImport(plan, choices, nowIso);
    // 第 1 批：幣別＋帳戶＋分類（INSERT … ON CONFLICT(id) DO NOTHING）
    for (const c of plan.currencies) if (!this.cur.has(c.id)) this.cur.set(c.id, clone(c));
    for (const a of plan.accounts) if (!this.acc.has(a.id)) this.acc.set(a.id, clone(a));
    for (const c of plan.categories) if (!this.cat.has(c.id)) this.cat.set(c.id, clone(c));
    // kept＝「留 Next Stop 的」只蓋 import_utime／updated_at 的記號（不算 updated）
    type Op = { kind: "insert"; row: EntryRow } | { kind: "update"; id: string; cols: Record<string, unknown>; kept?: true };
    const ops: Op[] = [
      ...m.entryInserts.map((row): Op => ({ kind: "insert", row })),
      ...m.entryUpdates.map((u): Op => ({ kind: "update", id: u.id, cols: u.cols })),
      ...m.entryKept.map((u): Op => ({ kind: "update", id: u.id, cols: u.cols, kept: true })),
    ];
    const total = ops.length;
    let done = 0;
    let inserted = 0;
    let updated = 0;
    onProgress(0, total);
    for (let i = 0; i < ops.length; i += IMPORT_CHUNK) {
      for (const op of ops.slice(i, i + IMPORT_CHUNK)) {
        if (op.kind === "insert") {
          if (!this.ent.has(op.row.id)) {
            this.ent.set(op.row.id, clone(op.row));
            inserted++;
          }
        } else {
          const row = this.ent.get(op.id);
          if (row && isAlive(row)) {
            Object.assign(row, op.cols);
            if (!op.kept) updated++;
          }
        }
        done++;
      }
      onProgress(done, total);
      await new Promise((r) => setTimeout(r, 0)); // 讓進度列畫得出來（同真機分批的節奏）
    }
    const e = plan.entries;
    return { inserted, updated, skipped: e.unchanged + e.tombstoned + e.invalid.length + m.keptLocal };
  }
}
