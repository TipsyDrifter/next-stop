/**
 * 售票口④・記一筆的幫手：願望清單（D-票-69）、常用票種（手動書籤，D-票-68）、備註記憶（D-票-70、71）的純函式。
 *
 * - 願望：「買了沒」不存狀態——entry_id 指到的帳還在＝已買；那筆帳被刪＝回到想買（讀的時候判斷，`wishView`）。
 *   預估金額是主幣別；按「買了」＝開記一筆、預填（金額、備註＝名稱、分類、荷札）（`wishDraftSeed`）。
 * - 常用票種：從一筆帳存成（`templateFromEntry`）；點了把整張填進草稿（`templateDraftSeed`），已不在的帳戶／分類就不填那一欄。
 * - 備註記憶：來源＝自己所有還在的帳的備註（`noteRecallItems` → recall.ts 的 RecallItem）；選了以前的備註、分類還空著就帶
 *   「上次那筆的分類」（`lastCategoryForNote`，同 kind）。
 *
 * 鐵則同 ①②③：只用可剝除語法；金額最小單位整數；日 key 字串運算；隨機 id 只在 repository 產生。
 * `import` 只自 `./ticket`、`./ticketPlan`、`./recall`——`scripts/tests/ticket-4-logic.test.ts` 以 node 直接載入。
 */
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryArchivedUp,
  type CategoryRow,
  type EntryCtx,
  type EntryKind,
  type EntryRow,
  type TemplateRow,
  type WishRow,
} from "./ticket";
import { amountInputText } from "./ticketPlan";
import { recallKey, tallyRecall, type RecallItem } from "./recall";

export type { TemplateRow, WishRow } from "./ticket";

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

/** 文案（兩殼同一份；store 的 TK_TEXT 引用） */
export const AIDS_TEXT = {
  wishNameEmpty: "願望要有名稱",
  wishAmountBad: "預估金額要是 0 以上",
  wishGone: "這個願望已經刪除了",
  templateNameEmpty: "常用票種要有名稱",
  templateGone: "這個常用票種已經刪除了",
  templateAdjust: "精算不能存成常用票種",
  templateKindBad: "常用票種只能是收入、支出或轉帳",
  /** 頁首那行（D-票-69）：「想買 3 件・合計約 18,300」（沒有估價的不算進合計） */
  wishHead: (n: number, total: string) => `想買 ${n} 件・合計約 ${total}`,
  /** 已買摺起來那列：「已買 2 件 · 花了 9,450」 */
  boughtHead: (n: number, spent: string) => `已買 ${n} 件 · 花了 ${spent}`,
} as const;

/* ───────────────────────── 排序（position → created_at → id；SQLite 同序） ───────────────────────── */

export function byPosition<T extends { position: number; created_at: string; id: string }>(a: T, b: T): number {
  return a.position - b.position || cmpStr(a.created_at, b.created_at) || cmpStr(a.id, b.id);
}

/* ───────────────────────── 願望 ───────────────────────── */

export interface NewWishInput {
  name: string;
  amountMinor: number | null;
  note: string;
  categoryId: string | null;
}
export type WishPatch = Partial<NewWishInput>;

/** 已買＝entry_id 指到的帳還在（entryById 只放存活的帳） */
export function wishBought(w: Pick<WishRow, "entry_id">, entryById: Readonly<Record<string, EntryRow>>): boolean {
  return w.entry_id !== null && entryById[w.entry_id] !== undefined && entryById[w.entry_id].deleted_at === null;
}

export interface BoughtWish {
  wish: WishRow;
  entry: EntryRow;
}
export interface WishView {
  /** 想買（position 順序；拖曳／搬動的就是這一組） */
  want: WishRow[];
  /** 已買（那筆的日期新到舊） */
  bought: BoughtWish[];
  /** 想買合計（主幣別；沒估價的不算） */
  wantTotal: number;
  /** 想買裡沒估價的件數（「合計約」旁要不要補一句由 UI 決定） */
  unpriced: number;
  /** 已買實際花了多少（那幾筆的 main_minor 合計） */
  spent: number;
}

export const EMPTY_WISH_VIEW: WishView = { want: [], bought: [], wantTotal: 0, unpriced: 0, spent: 0 };

/** 願望分成想買／已買，順便算合計（讀的時候判斷，不另存狀態） */
export function wishView(wishes: readonly WishRow[], entryById: Readonly<Record<string, EntryRow>>): WishView {
  const want: WishRow[] = [];
  const bought: BoughtWish[] = [];
  let wantTotal = 0;
  let unpriced = 0;
  let spent = 0;
  for (const w of wishes) {
    if (w.deleted_at !== null) continue;
    if (wishBought(w, entryById)) {
      const entry = entryById[w.entry_id as string];
      bought.push({ wish: w, entry });
      spent += entry.main_minor;
      continue;
    }
    want.push(w);
    if (w.amount_minor === null) unpriced++;
    else wantTotal += w.amount_minor;
  }
  want.sort(byPosition);
  bought.sort((a, b) => cmpStr(b.entry.occurred_on, a.entry.occurred_on) || cmpStr(b.entry.occurred_at, a.entry.occurred_at) || cmpStr(a.wish.id, b.wish.id));
  return { want, bought, wantTotal, unpriced, spent };
}

/** 新增／修改的驗證與整理（名稱 trim 後不能空、金額 null 或 ≥ 0 的整數）；不合法 throw RangeError */
export function checkWishInput<T extends WishPatch>(input: T): T {
  const out = { ...input };
  if (out.name !== undefined) {
    out.name = out.name.trim();
    if (!out.name) throw new RangeError(AIDS_TEXT.wishNameEmpty);
  }
  if (out.amountMinor !== undefined && out.amountMinor !== null && (!Number.isInteger(out.amountMinor) || out.amountMinor < 0)) {
    throw new RangeError(AIDS_TEXT.wishAmountBad);
  }
  if (out.note !== undefined) out.note = out.note.trim();
  return out;
}

/** 新列（id／position／時間由 repository 給） */
export function buildWishRow(input: NewWishInput, meta: { id: string; position: number; nowIso: string }): WishRow {
  const v = checkWishInput(input);
  return {
    id: meta.id,
    name: v.name,
    amount_minor: v.amountMinor,
    note: v.note,
    category_id: v.categoryId,
    position: meta.position,
    entry_id: null,
    bought_at: null,
    device_id: null,
    created_at: meta.nowIso,
    updated_at: meta.nowIso,
    synced_at: null,
    deleted_at: null,
  };
}

/** 改列：只回真的變了的欄＋updated_at（沒變＝cols 空、不寫；逐欄 LWW 不重戳沒改的欄） */
export function applyWishPatch(w: WishRow, patch: WishPatch, nowIso: string): { row: WishRow; cols: Record<string, unknown> } {
  const v = checkWishInput(patch);
  const cols: Record<string, unknown> = {};
  if (v.name !== undefined && v.name !== w.name) cols.name = v.name;
  if (v.amountMinor !== undefined && v.amountMinor !== w.amount_minor) cols.amount_minor = v.amountMinor;
  if (v.note !== undefined && v.note !== w.note) cols.note = v.note;
  if (v.categoryId !== undefined && v.categoryId !== w.category_id) cols.category_id = v.categoryId;
  if (!Object.keys(cols).length) return { row: w, cols };
  cols.updated_at = nowIso;
  return { row: { ...w, ...(cols as Partial<WishRow>) }, cols };
}

/** 按「買了」的預填（D-票-69）：支出、金額＝預估（主幣別）、備註＝名稱、分類＝願望的分類（還在、是支出、自己與上層都沒封存才帶） */
export function wishDraftSeed(
  w: WishRow,
  ctx: Pick<EntryCtx, "catById">,
  main: { code: string; decimals: number },
): { kind: "expense"; amountText: string; currency: string; note: string; categoryId: string | null; wishId: string } {
  const cat = w.category_id ? ctx.catById[w.category_id] : undefined;
  return {
    kind: "expense",
    amountText: w.amount_minor === null ? "" : amountInputText(w.amount_minor, main.decimals),
    currency: main.code,
    note: w.name,
    categoryId: cat && cat.deleted_at === null && !categoryArchivedUp(cat, ctx.catById) && cat.kind === "expense" ? cat.id : null,
    wishId: w.id,
  };
}

/* ───────────────────────── 常用票種 ───────────────────────── */

export interface NewTemplateInput {
  name: string;
  kind: "income" | "expense" | "transfer";
  amountMinor: number | null;
  currency: string | null;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  note: string;
  routeId: string | null;
}
export type TemplatePatch = Partial<NewTemplateInput>;

const TEMPLATE_KINDS = ["income", "expense", "transfer"];

/** 驗證與整理：名稱 trim 後不能空、kind 只能收支轉帳；轉帳不帶分類、收支不帶轉入帳戶 */
export function checkTemplateInput<T extends TemplatePatch>(input: T): T {
  const out = { ...input };
  if (out.name !== undefined) {
    out.name = out.name.trim();
    if (!out.name) throw new RangeError(AIDS_TEXT.templateNameEmpty);
  }
  if (out.kind !== undefined && TEMPLATE_KINDS.indexOf(out.kind) < 0) throw new RangeError(AIDS_TEXT.templateKindBad);
  if (out.amountMinor !== undefined && out.amountMinor !== null && !Number.isInteger(out.amountMinor)) throw new RangeError("金額看不懂");
  return out;
}

/** 從一筆帳存成常用（D-票-68「存成常用…」）：整張照抄（類型、金額、幣別、帳戶、分類、備註、路線）；精算不能存 */
export function templateFromEntry(e: EntryRow, name: string): NewTemplateInput {
  if (e.kind === "adjust") throw new RangeError(AIDS_TEXT.templateAdjust);
  return checkTemplateInput({
    name,
    kind: e.kind,
    amountMinor: e.amount_minor,
    currency: e.currency,
    accountId: e.account_id,
    toAccountId: e.kind === "transfer" ? e.to_account_id : null,
    categoryId: e.kind === "transfer" ? null : e.category_id,
    note: e.note,
    routeId: e.route_id,
  });
}

export function buildTemplateRow(input: NewTemplateInput, meta: { id: string; position: number; nowIso: string }): TemplateRow {
  const v = checkTemplateInput(input);
  return {
    id: meta.id,
    name: v.name,
    kind: v.kind,
    amount_minor: v.amountMinor,
    currency: v.currency,
    account_id: v.accountId,
    to_account_id: v.kind === "transfer" ? v.toAccountId : null,
    category_id: v.kind === "transfer" ? null : v.categoryId,
    note: v.note,
    route_id: v.routeId,
    position: meta.position,
    device_id: null,
    created_at: meta.nowIso,
    updated_at: meta.nowIso,
    synced_at: null,
    deleted_at: null,
  };
}

const TEMPLATE_PATCH_COLS: readonly [keyof NewTemplateInput, keyof TemplateRow][] = [
  ["name", "name"],
  ["kind", "kind"],
  ["amountMinor", "amount_minor"],
  ["currency", "currency"],
  ["accountId", "account_id"],
  ["toAccountId", "to_account_id"],
  ["categoryId", "category_id"],
  ["note", "note"],
  ["routeId", "route_id"],
];

/** 改列：只回真的變了的欄＋updated_at（沒變＝cols 空、不寫） */
export function applyTemplatePatch(t: TemplateRow, patch: TemplatePatch, nowIso: string): { row: TemplateRow; cols: Record<string, unknown> } {
  const v = checkTemplateInput(patch);
  const cols: Record<string, unknown> = {};
  for (const [k, col] of TEMPLATE_PATCH_COLS) {
    const val = v[k];
    if (val !== undefined && val !== t[col]) cols[col] = val;
  }
  if (!Object.keys(cols).length) return { row: t, cols };
  cols.updated_at = nowIso;
  return { row: { ...t, ...(cols as Partial<TemplateRow>) }, cols };
}

/** 填進草稿的欄（store 的 TicketDraft 的子集；沒給的鍵＝不動那一欄） */
export interface TemplateSeed {
  kind: "income" | "expense" | "transfer";
  amountText: string;
  currency?: string;
  accountId?: string;
  toAccountId?: string | null;
  categoryId: string | null;
  note: string;
  routeId: string | null;
  fromTemplateId: string;
}

/**
 * 點了常用票種（D-票-68「整張填好，只差存檔」）：類型、金額（沒存金額＝清空讓人打）、帳戶、分類、備註、路線。
 * 帳戶已刪或封存 ⇒ 不給（草稿留原本的帳戶）；分類已刪、封存（含上層封存）或 kind 不合 ⇒ null；幣別跟著樣板（沒有就跟帳戶）。
 * 金額字的小數位數照「這張書籤金額的幣別」算（日圓 5000 不會變成「50」）；金額跟著帳戶幣別的（轉帳、沒存幣別的收支）
 * 帳戶不能用時不帶金額——草稿留的是原本的帳戶，不一定同幣別，帶過去數字對、幣別錯；查不出幣別也不帶。
 * 路線是否還在由呼叫端決定（本檔不知道路線）；荷札另外帶（store 從 ticket:template 讀）。
 */
export function templateDraftSeed(t: TemplateRow, ctx: EntryCtx): TemplateSeed {
  const acc = t.account_id ? ctx.accById[t.account_id] : undefined;
  const accOk = !!acc && acc.deleted_at === null && acc.archived_at === null;
  const to = t.to_account_id ? ctx.accById[t.to_account_id] : undefined;
  const cat = t.category_id ? ctx.catById[t.category_id] : undefined;
  const catOk = !!cat && cat.deleted_at === null && !categoryArchivedUp(cat, ctx.catById) && cat.kind === t.kind; // 上層封存＝整棵算封存（D-票-78）
  const amountCode = t.currency ?? (acc ? acc.currency : undefined); // 金額存的是哪個幣別的最小單位
  const amountCur = amountCode ? ctx.curByCode[amountCode] : undefined;
  const currency = t.kind === "transfer" ? (accOk ? (acc as { currency: string }).currency : undefined) : t.currency ?? (accOk ? (acc as { currency: string }).currency : undefined);
  const cur = currency ? ctx.curByCode[currency] : undefined;
  const ownCurrency = t.kind !== "transfer" && t.currency !== null; // 收支存了自己的幣別：跟帳戶無關
  const carryAmount = t.amount_minor !== null && !!amountCur && (accOk || ownCurrency);
  const seed: TemplateSeed = {
    kind: t.kind,
    amountText: carryAmount ? amountInputText(t.amount_minor as number, (amountCur as { decimals: number }).decimals) : "",
    categoryId: t.kind === "transfer" ? null : catOk ? (cat as CategoryRow).id : null,
    note: t.note,
    routeId: t.route_id,
    fromTemplateId: t.id,
  };
  if (accOk) seed.accountId = (acc as { id: string }).id;
  if (currency && cur) seed.currency = currency;
  if (t.kind === "transfer") seed.toAccountId = to && to.deleted_at === null && to.archived_at === null ? to.id : null;
  return seed;
}

/* ───────────────────────── 備註記憶 ───────────────────────── */

/** `TicketRepository.listNoteUses` 的一列：還在的帳、備註非空 */
export interface NoteUse {
  note: string;
  occurred_on: string;
  kind: EntryKind;
  category_id: string | null;
}

/** 備註歷史 → 候選（次數＋最近一次＝occurred_on；鍵相同的併成一個，字取最近那次的寫法） */
export function noteRecallItems(uses: readonly NoteUse[]): RecallItem[] {
  return tallyRecall(uses.map((u) => ({ text: u.note, at: u.occurred_on })));
}

/**
 * 選了以前的備註、分類還空著時要帶的分類（D-票-70）：同 kind、備註鍵相同（全形半形大小寫視為一樣）的帳裡，
 * 最近一筆有真分類（不是未分類）而且 `usable(id)`（還在、沒封存）的那個分類；沒有＝null。
 * 「最近」＝occurred_on 大的；同一天照 uses 的順序後面的算新（repository 照 occurred_on、occurred_at、id 排好給）。
 */
export function lastCategoryForNote(uses: readonly NoteUse[], kind: EntryKind, text: string, usable: (categoryId: string) => boolean): string | null {
  const key = recallKey(text);
  if (!key) return null;
  let best: NoteUse | null = null;
  for (const u of uses) {
    if (u.kind !== kind || u.category_id === null || isUncat(u.category_id)) continue;
    if (recallKey(u.note) !== key || !usable(u.category_id)) continue;
    if (best === null || u.occurred_on >= best.occurred_on) best = u;
  }
  return best ? best.category_id : null;
}
