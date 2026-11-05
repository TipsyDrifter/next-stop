/**
 * 售票口線的記憶體實作（車次①契約 §3.7；甲席 Stage 0 全文）——`?mock=1` 純瀏覽器預覽用，乙丙席開發靠它。
 *
 * - 資料存 `Map`，進出一律複製（同 `memoryTimetableRepository.ts`）。所有寫入走**同一套 domain 函式**
 *   （`buildEntryRow`／`applyEntryPatch`／`adjustRow`），`balances` 用 `balancesOf`——mock 與真機語義一致。
 * - `ensureStarterRows` 照真機（`?mock=1&wiped=1` 也種：它是空庫第一次開）。
 * - 示範資料（`seedDemo`，第一次讀取時 lazy 種；固定種子的 PRNG，截圖穩定）：帳戶＝樣本格式 §三的 7 個名稱與群組；
 *   分類＝樣本格式 §四的現用樹（名稱照搬含 emoji）；幣別 TWD＋USD（31.549671）＋CNY（4.35）；帳＝今天往前 62 天、
 *   每天 0–4 筆（支出為主、每週一筆收入、每月兩筆轉帳、一筆退款、一筆 USD、一筆精算），金額亂數。
 * - 評審端點（本檔自己讀 `location.search`，不經 `DEV_FLAGS`——那是集中檔）：
 *     `&tk=empty`     帳戶與分類樹照種、一筆帳都沒有（「這本帳還是空的」）
 *     `&tk=noaccount` 只有起手三列（捕捉框報「還沒有帳戶」）
 *     `&tk=routes`    （②契約 §3.3）mock 路線 id 對齊主線 mock 路線——本檔**預設就對齊**，這個值只是明寫出來（同預設）
 * - 第②階段（②契約 §3.3）：示範支出約三成掛路線（另一顆固定種子的 PRNG 挑，不動 ①示範帳的亂數序列）＋一筆掛「已刪除的路線」；
 *   掛的是三個固定假 id，第一次讀帳時去問主線的 mock `nodeRepo.listSidebar()`、依側欄順序換成真的路線 id
 *   （主線 mock 路線 id 是 uuid() 隨機產生，`memoryRepository.ts` 不改；對不上＝顯示「（路線已刪除）」，不算錯）。
 *   `queryEntries`／`routeSpend` 用 `ticketView.ts` 的純函式算（`matchesQuery`／`routeSpendOf`），與 SQL 同義、測試互證。
 * - 第③階段（③契約 §3.7、0-15）：預算與定期規則各一個 Map；所有寫入走 `ticketPlan.ts` 同一套純函式
 *   （`budgetRow`／`buildRepeatRow`／`applyRepeatPatch`／`planMaterialize`／`withSkipped`／`resumeNextOn` 的產物），與真機語義一致。
 *     `&tk=plan`    示範資料外加 3 個預算（總預算＋🍜 食物＋午餐；總預算本月有覆寫、而且本月已用 > 覆寫 ⇒ 超支條與月曆「超」格）
 *                   ＋ 5 條規則（每日、每週一三五、每月 1 日、一條早期匯入的已暫停、一條指到已刪帳戶的 ⚠）；過去的班在種子裡先記到昨天，
 *                   今天那一班留給啟動時（或 `__nsTicket.materializeNow()`）的實體化
 * - 售票口④（Stage 0 資料席）：願望與常用票種各一個 Map；寫入走 `ticketAids.ts` 同一套純函式，「搬到第 k 個」走 `planMoveTo`
 *   （整組寫，與 SQLite 同義）。示範資料（`seedDemo`、不是 `tk=empty／noaccount`）多 4 個願望（其中 1 個已買、連到一筆示範帳）
 *   與 3 個常用票種，乙丙席開 `?mock=1` 就看得到願望分頁與記一筆最上面那排小卡。
 * - 售票口④ 第二輪：分類不限層數——createCategory 不再擋第三層、`moveCategoryUnder`／`setCategoryArchived` 走 domain 的
 *   `planMoveUnder`／`categorySubtreeIds`（與 SQLite 同義）；示範資料在「🍜 食物 › 午餐」底下多「便當」「學餐」兩個第三層（`seedDeep`）。
 */
import { nowUtcIso, uuid } from "../lib/db";
import { addDays, todayKey } from "../lib/date";
import {
  CURRENCY_NAMES,
  STARTER_CATEGORIES,
  STARTER_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  adjustRow,
  applyEntryPatch,
  balancesOf,
  buildEntryRow,
  categoryArchivedUp,
  categorySubtreeIds,
  currencyCode,
  effectiveParentId,
  minorFromDecimal,
  orderAccounts,
  parseRate,
  planAdjust,
  planMoveTo,
  planMoveUnder,
  ticketId,
  type AccountRow,
  type CategoryKind,
  type CategoryRow,
  type CurrencyRow,
  type EntryCtx,
  type EntryPatch,
  type EntryRow,
  type NewEntryInput,
  type UsageSince,
} from "../domain/ticket";
import { matchesQuery, newestFirst, routeSpendOf, type EntryQuery } from "../domain/ticketView";
import {
  applyRepeatPatch,
  assertBudgetScope,
  budgetId,
  budgetRow,
  buildRepeatRow,
  planMaterialize,
  planSkipNext,
  planUnskip,
  repeatOrder,
  pickUpRepeatCols,
  resumeNextOn,
  scopeKey,
  scopeOf,
  shiftDayOf,
  withSkipped,
  type BudgetRow,
  type BudgetScope,
  type NewRepeatInput,
  type RepeatPatch,
  type RepeatRow,
} from "../domain/ticketPlan";
import { fixedRule } from "../domain/repeat";
import {
  AIDS_TEXT,
  applyTemplatePatch,
  applyWishPatch,
  buildTemplateRow,
  buildWishRow,
  byPosition,
  wishBought,
  type NewTemplateInput,
  type NewWishInput,
  type NoteUse,
  type TemplatePatch,
  type TemplateRow,
  type WishPatch,
  type WishRow,
} from "../domain/ticketAids";
import type {
  AccountPatch,
  CurrencyPatch,
  MaterializedRow,
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

type TkMode = "empty" | "noaccount" | "routes" | "plan" | null;

/** 評審端點：`&tk=empty|noaccount|routes|plan` */
function tkMode(): TkMode {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("tk");
    return v === "empty" || v === "noaccount" || v === "routes" || v === "plan"
      ? v
      : null;
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

/** 第②階段：示範支出掛的三條路線（固定假 id；alignRoutes 依主線 mock 側欄順序換成真 id：J 日文、E1 全端開發、L2 體能） */
export const MOCK_ROUTE_IDS = ["mock-route-1", "mock-route-2", "mock-route-3"] as const;
/** 一筆掛在「已刪除的路線」上的帳（占比出「（路線已刪除）」一列） */
export const MOCK_ROUTE_GONE = "mock-route-gone";

/** 示範用的「早期從財務管家匯入、已暫停」規則（`&tk=plan`）的 import_utime；固定（2025-10-01T00:00:00Z） */
const MM_UTIME = 1759276800000;

/* ───────── 實作 ───────── */

export class MemoryTicketRepository implements TicketRepository {
  private readonly cur = new Map<string, CurrencyRow>();
  private readonly acc = new Map<string, AccountRow>();
  private readonly cat = new Map<string, CategoryRow>();
  private readonly ent = new Map<string, EntryRow>();
  private readonly bud = new Map<string, BudgetRow>(); // 第③階段
  private readonly rep = new Map<string, RepeatRow>(); // 第③階段
  private readonly wis = new Map<string, WishRow>(); // 售票口④
  private readonly tpl = new Map<string, TemplateRow>(); // 售票口④
  private readonly seedDemo: boolean;
  private demoSeeded = false;

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
    const rr = prng(20261016); // 第②階段掛路線用（另一條序列：不動上面 rnd 的抽法，①的示範帳逐筆不變）
    const pickRoute = (): string | null => (rr() < 0.3 ? MOCK_ROUTE_IDS[Math.floor(rr() * MOCK_ROUTE_IDS.length)] : null);
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
          routeId: pickRoute(),
        });
      }
      if (back === 12) {
        const [y, m, d] = dayKey.split("-").map((s) => parseInt(s, 10));
        add({
          kind: "expense", amountMinor: 18000, currency: "TWD", accountId: accId.cash, toAccountId: null, categoryId: leafIds[30],
          occurredOn: dayKey, occurredAt: new Date(y, m - 1, d, 13, 5).toISOString(), note: "舊路線的帳", routeId: MOCK_ROUTE_GONE,
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

    this.seedDeep(leafIds[1], nowIso);
    this.seedAids(accId, leafIds, nowIso);
    if (mode === "plan") this.seedPlan(today, accId, incomeIds, leafIds, nowIso);
  }

  /**
   * 售票口④ 第二輪（D-票-78）示範第三層：「🍜 食物 › 午餐」底下加「便當」「學餐」，備註是這兩個字的午餐帳搬過去
   * （不動 rnd 序列；其餘午餐留在午餐本身＝統計「未細分」）。只在有示範帳時種。
   */
  private seedDeep(lunchId: string | undefined, nowIso: string): void {
    if (!lunchId) return;
    const stamp = { device_id: null, created_at: nowIso, updated_at: nowIso, synced_at: null, deleted_at: null };
    const ids: Record<string, string> = {};
    ["便當", "學餐"].forEach((name, i) => {
      const id = uuid();
      ids[name] = id;
      this.cat.set(id, { id, kind: "expense", name, parent_id: lunchId, position: i, archived_at: null, ...stamp });
    });
    for (const e of this.ent.values()) if (e.category_id === lunchId && ids[e.note]) e.category_id = ids[e.note];
  }

  /**
   * 售票口④ 示範：4 個願望（3 個想買、1 個已買＝連到最近一筆 5 天前以前的支出）＋3 個常用票種（午餐、捷運、儲值）。
   * 分類用示範樹的子分類（leafIds：1 午餐、9 捷運、21 電子用品）；只在有示範帳時種（tk=empty 不種）。
   */
  private seedAids(accId: Record<string, string>, leafIds: string[], nowIso: string): void {
    const at = (i: number): string => new Date(Date.parse(nowIso) + i).toISOString();
    const wish = (i: number, name: string, amount: number | null, categoryId: string | null, note = ""): WishRow =>
      buildWishRow({ name, amountMinor: amount, note, categoryId }, { id: uuid(), position: i, nowIso: at(i) });
    const bought = Array.from(this.ent.values())
      .filter((e) => e.kind === "expense" && e.amount_minor > 0 && e.occurred_on <= addDays(todayKey(3), -5))
      .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : a.occurred_on > b.occurred_on ? -1 : 0))[0];
    const rows = [
      wish(0, "降噪耳機", 780000, leafIds[21] ?? null, "等特價"),
      wish(1, "登山背包", 350000, null),
      wish(2, "手沖壺", null, null),
    ];
    if (bought) rows.push({ ...wish(3, bought.note || "行動電源", bought.amount_minor, bought.category_id), entry_id: bought.id, bought_at: bought.created_at });
    for (const w of rows) this.wis.set(w.id, w);
    const tpl = (i: number, input: NewTemplateInput): TemplateRow => buildTemplateRow(input, { id: uuid(), position: i, nowIso: at(10 + i) });
    const base = { currency: "TWD", toAccountId: null, routeId: null };
    for (const t of [
      tpl(0, { ...base, name: "午餐", kind: "expense", amountMinor: 12000, accountId: accId.student, categoryId: leafIds[1] ?? null, note: "學餐" }),
      tpl(1, { ...base, name: "捷運", kind: "expense", amountMinor: 3000, accountId: accId.easy, categoryId: leafIds[9] ?? null, note: "" }),
      tpl(2, { ...base, name: "儲值", kind: "transfer", amountMinor: 50000, accountId: accId.bank, toAccountId: accId.easy, categoryId: null, note: "儲值" }),
    ]) {
      this.tpl.set(t.id, t);
    }
  }

  /**
   * `&tk=plan`（③契約 0-15）：3 個預算＋5 條規則。總預算本月覆寫＝本月已用的八成（湊整到百）⇒ 一定超支、月曆有「超」格。
   * 規則過去的班在這裡先用 planMaterialize 記到昨天（帶 repeat_id、清單有「定期」小標），今天那一班留給實體化。
   */
  private seedPlan(today: string, accId: Record<string, string>, incomeIds: string[], leafIds: string[], nowIso: string): void {
    void incomeIds;
    const stamp = { device_id: null, created_at: nowIso, updated_at: nowIso, synced_at: null, deleted_at: null };
    const month = today.slice(0, 7);
    let used = 0;
    for (const e of this.ent.values()) if (e.deleted_at === null && e.kind === "expense" && e.occurred_on.slice(0, 7) === month) used += e.main_minor;
    const food = Array.from(this.cat.values()).find((c) => c.name === "🍜 食物" && c.parent_id === null);
    const lunch = leafIds[1];
    const round100 = (n: number) => Math.max(10000, Math.round(n / 10000) * 10000);
    const put = (b: BudgetRow) => this.bud.set(b.id, b);
    put(budgetRow({ kind: "total" }, null, round100(used * 1.5), 0, nowIso));
    put(budgetRow({ kind: "total" }, month, round100(used * 0.8), 1, nowIso));
    if (food) put(budgetRow({ kind: "category", categoryId: food.id }, null, 600000, 2, nowIso));
    put(budgetRow({ kind: "category", categoryId: lunch }, null, 150000, 3, nowIso));

    // 一個已刪的帳戶（⚠ 那條規則指著它）
    const goneAcc = uuid();
    this.acc.set(goneAcc, { id: goneAcc, name: "舊悠遊卡", group_key: "debit", currency: "TWD", position: 9, archived_at: null, ...stamp, deleted_at: nowIso });

    const ctx = this.ctx();
    const mk = (id: string, position: number, input: NewRepeatInput, patch: Partial<RepeatRow> = {}): RepeatRow => {
      // 指到已刪帳戶的那條過不了 buildRepeatRow 的驗證 ⇒ 用一個活帳戶建，再換成已刪的
      const row = buildRepeatRow(input, ctx, { id, position, nowIso });
      return { ...row, ...patch };
    };
    const base = { toAccountId: null, currency: "TWD", routeId: null, hhmm: "09:00" };
    const rules: RepeatRow[] = [
      mk(uuid(), 0, { ...base, kind: "expense", accountId: accId.cash, categoryId: leafIds[0], amountMinor: 6000, note: "早餐店", rule: fixedRule("daily", addDays(today, -3)), hhmm: "07:30" }),
      mk(uuid(), 1, { ...base, kind: "expense", accountId: accId.easy, categoryId: leafIds[9], amountMinor: 2500, note: "通勤", rule: fixedRule("weekly", addDays(today, -21), { byweekday: [1, 3, 5] }), hhmm: "08:10" }),
      mk(uuid(), 2, { ...base, kind: "expense", accountId: accId.bank, categoryId: leafIds[16], amountMinor: 800000, note: "房租", rule: fixedRule("monthly", addDays(today, -70), { bymonthday: [1] }), hhmm: "10:00" }),
      mk(ticketId("moneymanager:repeat:mock-paused"), 3, {
        ...base, kind: "expense", accountId: accId.bank, categoryId: leafIds[22], amountMinor: 1000, currency: "USD", note: "線上服務",
        rule: fixedRule("monthly", addDays(today, 5), { bymonthday: [parseInt(addDays(today, 5).slice(8, 10), 10)] }), hhmm: "21:15",
      }, { paused_at: nowIso, import_id: "mock-paused", import_source: "moneymanager", import_utime: MM_UTIME }),
      mk(uuid(), 4, {
        ...base, kind: "expense", accountId: accId.cash, categoryId: leafIds[8], amountMinor: 4500, note: "悠遊卡自動加值",
        rule: fixedRule("weekly", addDays(today, -6), { byweekday: [0, 1, 2, 3, 4, 5, 6] }),
      }, { account_id: goneAcc }),
    ];
    for (const r of rules) this.rep.set(r.id, r);
    // 過去的班記到昨天（⚠ 那條在昨天就被擋：帳戶已不在 ⇒ 游標不動，今天照樣被擋）
    const plan = planMaterialize(rules, new Set(this.ent.keys()), addDays(today, -1), ctx, nowIso, 3); // 3＝上面 todayKey(3) 的 mock 日界線
    for (const row of plan.inserts) this.ent.set(row.id, row);
    for (const c of plan.cursors) {
      const r = this.rep.get(c.id);
      if (r) r.next_on = c.next_on;
    }
  }

  /**
   * 第②階段：把示範帳的三個固定路線 id 換成主線 mock 路線的真 id（只做一次；第一次讀帳時）。
   * 主線的 `nodeRepo` 用動態 import 取（本檔被 node 測試直接載入，靜態 import `./index` 會在 node 碰到 import.meta.env）。
   */
  private routesAligned: Promise<void> | null = null;
  private alignRoutes(): Promise<void> {
    this.ensureDemo();
    if (!this.routesAligned) {
      this.routesAligned = (async () => {
        if (typeof window === "undefined" || !this.seedDemo) return;
        try {
          const { nodeRepo } = await import("./index");
          const sb = await nodeRepo.listSidebar();
          const map: Record<string, string> = {};
          MOCK_ROUTE_IDS.forEach((id, i) => {
            const r = sb.routes[i];
            if (r) map[id] = r.id;
          });
          for (const e of this.ent.values()) if (e.route_id && map[e.route_id]) e.route_id = map[e.route_id];
        } catch {
          // 對不上就顯示「（路線已刪除）」，不算錯（②契約 §3.3）
        }
      })();
    }
    return this.routesAligned;
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

  /** 同組鄰居互換（先依現順序把 position 攤成 0..n-1，再換）；整組每列都寫（含 updated_at），與 SQLite 的 planSwap 同義（#101） */
  private swapIn<T extends { id: string; position: number; updated_at: string }>(list: T[], id: string, delta: 1 | -1, nowIso: string): void {
    const i = list.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    list.forEach((x, k) => {
      x.position = k;
      x.updated_at = nowIso;
    });
    list[i].position = j;
    list[j].position = i;
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
    await this.alignRoutes();
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

  async queryEntries(q: EntryQuery): Promise<EntryRow[]> {
    await this.alignRoutes();
    return Array.from(this.ent.values())
      .filter((e) => matchesQuery(e, q))
      .sort(newestFirst)
      .map(clone);
  }

  async routeSpend(routeId: string, from: string, toExcl: string): Promise<{ inRange: number; allTime: number }> {
    await this.alignRoutes();
    return routeSpendOf(Array.from(this.ent.values()), routeId, { from, toExcl });
  }

  async getEntry(id: string): Promise<EntryRow | null> {
    await this.alignRoutes();
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

  async usageSince(sinceDay: string): Promise<UsageSince> {
    this.ensureDemo();
    const cats: Record<string, { n: number; last: string }> = {};
    const accs: Record<string, number> = {};
    for (const e of this.ent.values()) {
      if (!isAlive(e) || e.occurred_on < sinceDay) continue;
      if (e.kind !== "adjust") {
        accs[e.account_id] = (accs[e.account_id] ?? 0) + 1;
        if (e.kind === "transfer" && e.to_account_id) accs[e.to_account_id] = (accs[e.to_account_id] ?? 0) + 1;
      }
      if ((e.kind === "income" || e.kind === "expense") && e.category_id && !isUncat(e.category_id)) {
        const c = this.cat.get(e.category_id);
        if (!c || !isAlive(c) || c.archived_at !== null) continue;
        const last = `${e.occurred_on} ${e.occurred_at}`;
        const u = cats[e.category_id];
        if (!u) cats[e.category_id] = { n: 1, last };
        else {
          u.n += 1;
          if (last > u.last) u.last = last;
        }
      }
    }
    return {
      categories: Object.keys(cats).map((id) => ({ id, n: cats[id].n, last: cats[id].last })),
      accounts: Object.keys(accs).map((id) => ({ id, n: accs[id] })),
    };
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
    this.touchSkipped(row, true, now); // 第③階段（③契約 0-7-2）：同一批記進規則的 skipped_days
  }

  async restoreEntry(id: string): Promise<void> {
    this.ensureDemo();
    const row = this.ent.get(id);
    if (!row || isAlive(row)) return;
    const now = nowUtcIso();
    row.deleted_at = null;
    row.updated_at = now;
    this.touchSkipped(row, false, now);
  }

  /** 那筆 repeat_id 非空且規則還在 ⇒ skipped_days 加／減那一班（**班次日**，shiftDayOf；對不上就不碰；值沒變就不動；評審 R13／R14）。減的時候規則是 tombstone 也要減（同 SQLite 版） */
  private touchSkipped(row: EntryRow, add: boolean, now: string): void {
    if (!row.repeat_id) return;
    const r = this.rep.get(row.repeat_id);
    if (!r || !isAlive(r)) return;
    const day = shiftDayOf(r, row, todayKey(0));
    if (day === null) return;
    const next = withSkipped(r.skipped_days, day, add);
    if (next === r.skipped_days) return;
    r.skipped_days = next;
    r.updated_at = now;
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
    this.swapIn(this.accountSibs(id), id, delta, nowUtcIso());
  }

  async moveAccountTo(id: string, index: number): Promise<void> {
    this.ensureDemo();
    this.applyMoves(this.acc, planMoveTo(this.accountSibs(id), id, index));
  }

  /** 同群組、未封存的帳戶（顯示順序） */
  private accountSibs(id: string): AccountRow[] {
    const a = this.accountOrThrow(id);
    return orderAccounts(Array.from(this.acc.values()).filter((x) => isAlive(x) && x.archived_at === null && x.group_key === a.group_key));
  }

  /** 整組寫（planMoveTo 的結果；每列都寫 position＋updated_at，與 SQLite 的 writePositions 同義） */
  private applyMoves<T extends { position: number; updated_at: string }>(map: Map<string, T>, moves: readonly { id: string; position: number }[]): void {
    if (!moves.length) return;
    const now = nowUtcIso();
    for (const m of moves) {
      const r = map.get(m.id);
      if (!r) continue;
      r.position = m.position;
      r.updated_at = now;
    }
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
      if (p.kind !== input.kind) throw new RangeError("這個分類不屬於目前的收支類型");
    }
    // 不限層數（售票口④ 第二輪 D-票-78）；排在那一層（實際的樹，含父已不在而升上來的）最後
    const all = Array.from(this.cat.values()).filter((c) => isAlive(c) && c.kind === input.kind);
    const byId: Record<string, CategoryRow> = {};
    for (const c of all) byId[c.id] = c;
    const pRow = input.parentId === null ? null : byId[input.parentId];
    if (pRow && categoryArchivedUp(pRow, byId)) throw new RangeError("封存的分類底下不能建子分類");
    let position = -1;
    for (const c of all) if (!isUncat(c.id) && effectiveParentId(c, byId) === input.parentId) position = Math.max(position, c.position);
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
    // 底下整棵（不限層數，D-票-78）：實際的樹（effectiveParentId），不含自己
    const all = Array.from(this.cat.values()).filter((x) => isAlive(x) && x.kind === c.kind);
    const kids = categorySubtreeIds(id, all)
      .slice(1)
      .map((k) => this.cat.get(k))
      .filter((k): k is CategoryRow => !!k);
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
    this.swapIn(this.categorySibs(id), id, delta, nowUtcIso());
  }

  async moveCategoryTo(id: string, index: number): Promise<void> {
    this.ensureDemo();
    if (isUncat(id)) return;
    this.applyMoves(this.cat, planMoveTo(this.categorySibs(id), id, index));
  }

  async moveCategoryUnder(id: string, newParentId: string | null, index?: number): Promise<void> {
    this.ensureDemo();
    const c = isUncat(id) ? null : this.categoryOrThrow(id);
    const all = c ? Array.from(this.cat.values()).filter(isAlive) : []; // 各 kind 都給：目標別 kind 要報對原因
    // 推導與檢查全在 domain（sqlite 同一支）；未分類 ⇒ planMoveUnder 丟「「未分類」不能移動」
    const plan = planMoveUnder(all, id, newParentId, index);
    if (plan.parent !== undefined && c) {
      c.parent_id = plan.parent;
      c.updated_at = nowUtcIso();
    }
    // 斷環：同步合出的環上、畫面已當頂層的那個寫回 parent＝null（planMoveUnder 註解）
    for (const bid of plan.breaks) {
      const x = this.cat.get(bid);
      if (x) {
        x.parent_id = null;
        x.updated_at = nowUtcIso();
      }
    }
    this.applyMoves(this.cat, plan.moves);
  }

  /** 同 kind、同層（effectiveParentId）、未封存的分類（顯示順序） */
  private categorySibs(id: string): CategoryRow[] {
    const c = this.categoryOrThrow(id);
    // 找兄弟看「實際掛在哪一層」（D-票-62）：父列已不在的子分類跟主分類同一層，與 categoryForest 的顯示一致
    const all = Array.from(this.cat.values()).filter((x) => isAlive(x) && !isUncat(x.id) && x.kind === c.kind);
    const byId: Record<string, CategoryRow> = {};
    for (const x of all) byId[x.id] = x;
    const level = effectiveParentId(c, byId);
    return all
      .filter((x) => x.archived_at === null && effectiveParentId(x, byId) === level)
      .sort((a, b) => a.position - b.position || cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
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

  /* ───────── 第③階段：預算（③契約 §3.4） ───────── */

  async listBudgets(): Promise<BudgetRow[]> {
    this.ensureDemo();
    return Array.from(this.bud.values())
      .filter(isAlive)
      .sort((a, b) => a.position - b.position || cmp(a.month ?? "", b.month ?? "") || cmp(a.id, b.id))
      .map(clone);
  }

  async setBudget(scope: BudgetScope, month: string | null, amountMinor: number): Promise<BudgetRow> {
    this.ensureDemo();
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new RangeError("預算要是大於 0 的金額");
    assertBudgetScope(scope, this.ctx().catById);
    const id = budgetId(scope, month);
    const now = nowUtcIso();
    const prev = this.bud.get(id);
    if (prev) {
      // ON CONFLICT(id) DO UPDATE SET amount_minor, deleted_at = NULL, updated_at
      prev.amount_minor = amountMinor;
      prev.deleted_at = null;
      prev.updated_at = now;
      return clone(prev);
    }
    let position = -1;
    for (const b of this.bud.values()) if (isAlive(b)) position = Math.max(position, b.position);
    const row = budgetRow(scope, month, amountMinor, position + 1, now);
    this.bud.set(id, row);
    return clone(row);
  }

  async removeBudget(scope: BudgetScope, month: string | null): Promise<string[]> {
    this.ensureDemo();
    const now = nowUtcIso();
    const key = scopeKey(scope);
    const ids: string[] = [];
    for (const b of this.bud.values()) {
      if (!isAlive(b) || scopeKey(scopeOf(b)) !== key) continue;
      // 移除預設 ⇒ 連同該對象所有月的覆寫（同一批）；移除覆寫 ⇒ 只那一列
      if (month === null || b.month === month) {
        b.deleted_at = now;
        b.updated_at = now;
        ids.push(b.id);
      }
    }
    return ids;
  }

  async restoreBudget(ids: readonly string[]): Promise<void> {
    this.ensureDemo();
    const now = nowUtcIso();
    for (const id of ids) {
      const b = this.bud.get(id);
      if (!b || isAlive(b)) continue;
      b.deleted_at = null;
      b.updated_at = now;
    }
  }

  /* ───────── 第③階段：定期帳（③契約 §3.4、0-6～0-8） ───────── */

  async listRepeats(): Promise<RepeatRow[]> {
    this.ensureDemo();
    return Array.from(this.rep.values()).filter(isAlive).sort(repeatOrder).map(clone);
  }

  private repeatOrThrow(id: string): RepeatRow {
    const r = this.rep.get(id);
    if (!r || !isAlive(r)) throw new RangeError("這筆定期帳已經刪除了");
    return r;
  }

  async createRepeat(input: NewRepeatInput): Promise<RepeatRow> {
    this.ensureDemo();
    let position = -1;
    for (const r of this.rep.values()) if (isAlive(r)) position = Math.max(position, r.position);
    const row = buildRepeatRow(input, this.ctx(), { id: uuid(), position: position + 1, nowIso: nowUtcIso() });
    this.rep.set(row.id, row);
    return clone(row);
  }

  async updateRepeat(id: string, patch: RepeatPatch, today: string): Promise<RepeatRow> {
    this.ensureDemo();
    const r = this.repeatOrThrow(id);
    const res = applyRepeatPatch(r, patch, this.ctx(), today, nowUtcIso());
    if (Object.keys(res.cols).length === 0) return clone(r);
    this.rep.set(id, res.row);
    return clone(res.row);
  }

  /** 開始：手建的明天起、早期匯入且從沒開始過的規則接著 next_on（resumeNextOn，✎-8） */
  private resumeOne(r: RepeatRow, today: string, now: string): void {
    r.next_on = resumeNextOn(r, Array.from(this.ent.values()), today);
    r.paused_at = null;
    r.updated_at = now;
  }

  async setRepeatPaused(id: string, paused: boolean, today: string): Promise<void> {
    this.ensureDemo();
    const r = this.repeatOrThrow(id);
    if ((r.paused_at !== null) === paused) return;
    const now = nowUtcIso();
    if (paused) {
      r.paused_at = now;
      r.updated_at = now;
    } else this.resumeOne(r, today, now);
  }

  async skipNextRepeat(id: string): Promise<string> {
    this.ensureDemo();
    const r = this.repeatOrThrow(id);
    const plan = planSkipNext(r, nowUtcIso());
    Object.assign(r, plan.cols);
    return plan.day;
  }

  async unskipRepeat(id: string, day: string): Promise<void> {
    this.ensureDemo();
    const r = this.repeatOrThrow(id);
    const cols = planUnskip(r, day, nowUtcIso());
    if (cols) Object.assign(r, cols);
  }

  async softDeleteRepeat(id: string): Promise<void> {
    this.ensureDemo();
    const r = this.rep.get(id);
    if (!r || !isAlive(r)) return;
    const now = nowUtcIso();
    r.deleted_at = now;
    r.updated_at = now;
  }

  async restoreRepeat(id: string): Promise<void> {
    this.ensureDemo();
    const r = this.rep.get(id);
    if (!r || isAlive(r)) return;
    r.deleted_at = null;
    r.updated_at = nowUtcIso();
  }

  async repeatPickUpCols(r: RepeatRow, today: string): Promise<{ next_on: string | null; skipped_days: string }> {
    this.ensureDemo();
    const entries = Array.from(this.ent.values());
    const alive = new Set(entries.filter(isAlive).map((e) => e.id));
    return pickUpRepeatCols(r, entries, alive, today);
  }

  async pickUpRepeat(id: string, today: string): Promise<void> {
    this.ensureDemo();
    const r = this.rep.get(id);
    if (!r || isAlive(r)) return;
    Object.assign(r, await this.repeatPickUpCols(r, today), { deleted_at: null, updated_at: nowUtcIso() });
  }

  async linkEntryToRepeat(entryId: string, repeatId: string): Promise<void> {
    this.ensureDemo();
    const e = this.ent.get(entryId);
    if (!e || !isAlive(e)) throw new RangeError("這一筆已經刪除了");
    this.repeatOrThrow(repeatId);
    if (e.repeat_id === repeatId) return;
    e.repeat_id = repeatId;
    e.updated_at = nowUtcIso();
  }

  async materializeRepeats(
    today: string,
    dayStartHour: number,
  ): Promise<{ inserted: number; reconciled: number; blocked: { id: string; reason: string }[]; rows: MaterializedRow[] }> {
    // 「今天」已由呼叫端用日界線算好（0-6-6）；dayStartHour 給 planMaterialize 算帳的時刻（手建套日界線、匯入字面時刻，✎-7 改）
    await this.alignRoutes();
    const now = nowUtcIso();
    const repeats = Array.from(this.rep.values()).filter(isAlive);
    // existingIds：本機已有的 id **含墓碑**（0-6-3）
    const plan = planMaterialize(repeats, new Set(this.ent.keys()), today, this.ctx(), now, dayStartHour);
    let reconciled = 0;
    for (const id of plan.reconcileIds) {
      const e = this.ent.get(id);
      if (!e || !isAlive(e)) continue;
      e.deleted_at = now;
      e.updated_at = now;
      reconciled++;
    }
    let inserted = 0;
    const rows: MaterializedRow[] = [];
    for (const row of plan.inserts) {
      if (this.ent.has(row.id)) continue; // ON CONFLICT(id) DO NOTHING、且不對已存在的 id 發 op
      this.ent.set(row.id, clone(row));
      inserted++;
      rows.push({ id: row.id, repeat_id: row.repeat_id as string });
    }
    for (const c of plan.cursors) {
      const r = this.rep.get(c.id);
      if (!r || !isAlive(r) || r.next_on === c.next_on) continue;
      r.next_on = c.next_on;
      r.updated_at = now;
    }
    return { inserted, reconciled, blocked: plan.blocked, rows };
  }

  /* ═════════ 售票口④（契約 §5、§6、§8） ═════════ */

  async listNoteUses(): Promise<NoteUse[]> {
    this.ensureDemo();
    const rows: EntryRow[] = [];
    for (const e of this.ent.values()) {
      if (!isAlive(e) || e.kind === "adjust" || e.note.trim() === "") continue; // 精算的備註是系統寫的，不列（同 SQLite）
      rows.push(e);
    }
    // 照時間排（同 SQLite 的 ORDER BY occurred_on, occurred_at, id）
    rows.sort((a, b) => cmp(a.occurred_on, b.occurred_on) || cmp(a.occurred_at, b.occurred_at) || cmp(a.id, b.id));
    return rows.map((e) => ({ note: e.note, occurred_on: e.occurred_on, kind: e.kind, category_id: e.category_id }));
  }

  async getEntries(ids: readonly string[]): Promise<EntryRow[]> {
    this.ensureDemo();
    const out: EntryRow[] = [];
    for (const id of new Set(ids)) {
      const e = this.ent.get(id);
      if (e && isAlive(e)) out.push(clone(e));
    }
    return out;
  }

  /* ── 願望 ── */

  async listWishes(): Promise<WishRow[]> {
    this.ensureDemo();
    return Array.from(this.wis.values()).filter(isAlive).sort(byPosition).map(clone);
  }

  private wishOrThrow(id: string): WishRow {
    const w = this.wis.get(id);
    if (!w || !isAlive(w)) throw new RangeError(AIDS_TEXT.wishGone);
    return w;
  }

  async createWish(input: NewWishInput): Promise<WishRow> {
    this.ensureDemo();
    if (input.categoryId !== null) this.categoryOrThrow(input.categoryId);
    let min = 1;
    for (const w of this.wis.values()) if (isAlive(w)) min = Math.min(min, w.position);
    const row = buildWishRow(input, { id: uuid(), position: min - 1, nowIso: nowUtcIso() });
    this.wis.set(row.id, row);
    return clone(row);
  }

  async updateWish(id: string, patch: WishPatch): Promise<WishRow> {
    this.ensureDemo();
    const w = this.wishOrThrow(id);
    if (patch.categoryId !== undefined && patch.categoryId !== null && patch.categoryId !== w.category_id) this.categoryOrThrow(patch.categoryId);
    const res = applyWishPatch(w, patch, nowUtcIso());
    if (!Object.keys(res.cols).length) return clone(w);
    this.wis.set(id, res.row);
    return clone(res.row);
  }

  async setWishBought(id: string, entryId: string | null): Promise<void> {
    this.ensureDemo();
    const w = this.wishOrThrow(id);
    if (w.entry_id === entryId) return;
    const now = nowUtcIso();
    w.entry_id = entryId;
    w.bought_at = entryId === null ? null : now;
    w.updated_at = now;
  }

  async softDeleteWish(id: string): Promise<void> {
    this.ensureDemo();
    softDelete(this.wis.get(id));
  }

  async restoreWish(id: string): Promise<void> {
    this.ensureDemo();
    restore(this.wis.get(id));
  }

  async moveWishTo(id: string, index: number): Promise<void> {
    this.ensureDemo();
    this.wishOrThrow(id);
    const alive: Record<string, EntryRow> = {};
    for (const e of this.ent.values()) if (isAlive(e)) alive[e.id] = e;
    const want = Array.from(this.wis.values())
      .filter((w) => isAlive(w) && !wishBought(w, alive))
      .sort(byPosition);
    this.applyMoves(this.wis, planMoveTo(want, id, index));
  }

  /* ── 常用票種 ── */

  async listTemplates(): Promise<TemplateRow[]> {
    this.ensureDemo();
    return Array.from(this.tpl.values()).filter(isAlive).sort(byPosition).map(clone);
  }

  private templateOrThrow(id: string): TemplateRow {
    const t = this.tpl.get(id);
    if (!t || !isAlive(t)) throw new RangeError(AIDS_TEXT.templateGone);
    return t;
  }

  /** 外鍵指的帳戶／分類要在（與 SQLite 的 checkTemplateRefs 同義） */
  private checkTemplateRefs(p: TemplatePatch): void {
    if (p.accountId) this.accountOrThrow(p.accountId);
    if (p.toAccountId) this.accountOrThrow(p.toAccountId);
    if (p.categoryId) this.categoryOrThrow(p.categoryId);
  }

  async createTemplate(input: NewTemplateInput): Promise<TemplateRow> {
    this.ensureDemo();
    this.checkTemplateRefs(input);
    let max = -1;
    for (const t of this.tpl.values()) if (isAlive(t)) max = Math.max(max, t.position);
    const row = buildTemplateRow(input, { id: uuid(), position: max + 1, nowIso: nowUtcIso() });
    this.tpl.set(row.id, row);
    return clone(row);
  }

  async updateTemplate(id: string, patch: TemplatePatch): Promise<TemplateRow> {
    this.ensureDemo();
    const t = this.templateOrThrow(id);
    this.checkTemplateRefs(patch);
    const res = applyTemplatePatch(t, patch, nowUtcIso());
    if (!Object.keys(res.cols).length) return clone(t);
    this.tpl.set(id, res.row);
    return clone(res.row);
  }

  async softDeleteTemplate(id: string): Promise<void> {
    this.ensureDemo();
    softDelete(this.tpl.get(id));
  }

  async restoreTemplate(id: string): Promise<void> {
    this.ensureDemo();
    restore(this.tpl.get(id));
  }

  async moveTemplateTo(id: string, index: number): Promise<void> {
    this.ensureDemo();
    this.templateOrThrow(id);
    const all = Array.from(this.tpl.values()).filter(isAlive).sort(byPosition);
    this.applyMoves(this.tpl, planMoveTo(all, id, index));
  }
}

/** 軟刪（已刪或不存在＝不動） */
function softDelete(r: { deleted_at: string | null; updated_at: string } | undefined): void {
  if (!r || !isAlive(r)) return;
  const now = nowUtcIso();
  r.deleted_at = now;
  r.updated_at = now;
}

/** 復原（沒刪或不存在＝不動） */
function restore(r: { deleted_at: string | null; updated_at: string } | undefined): void {
  if (!r || isAlive(r)) return;
  r.deleted_at = null;
  r.updated_at = nowUtcIso();
}
