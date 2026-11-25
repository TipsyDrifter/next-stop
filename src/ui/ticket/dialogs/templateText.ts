/**
 * 常用票種「會帶入什麼」的一行字（售票口④ D-票-68；桌機席）。帳目詳情「存成常用…」浮層、管帳「常用票種…」對話框、
 * 記一筆最上面那排小卡的 title 共用，字只寫一次。原型 5-desktop-存成常用：
 *   「支出 129 · 現金 · 食物 › 午餐 · 備註「麥當勞 公館店」」；有路線、荷札才接在後面（「路線 社團 · #3C」）。
 * `short`＝只要類型金額與帳戶（對話框每列後面的淡字，太長會擠掉名字）。
 */
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryLabel,
  mainCurrencyOf,
  maskedMoneyText,
  moneyText,
  type AccountRow,
  type CategoryRow,
  type CurrencyRow,
  type EntryRow,
  type TemplateRow,
} from "../../../domain/ticket";
import type { NodeRow } from "../../../domain/node";
import { acctLabel } from "../TicketLedger";

export interface WhatCtx {
  accounts: readonly AccountRow[];
  accById: Readonly<Record<string, AccountRow>>;
  catById: Readonly<Record<string, CategoryRow>>;
  curByCode: Readonly<Record<string, CurrencyRow>>;
  routes: readonly NodeRow[];
}

interface WhatSrc {
  kind: "expense" | "income" | "transfer";
  amountMinor: number | null;
  currency: string | null;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  item: string;
  note: string;
  feeMinor: number | null;
  routeId: string | null;
}

const KIND_WORD: Record<WhatSrc["kind"], string> = { expense: "支出", income: "收入", transfer: "轉帳" };
const isUncat = (id: string | null): boolean => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

function whatText(src: WhatSrc, ctx: WhatCtx, tags: readonly string[], short: boolean, masked = false): string {
  const parts: string[] = [];
  const mainCode = mainCurrencyOf(Object.values(ctx.curByCode));
  const acc = src.accountId ? ctx.accById[src.accountId] : undefined;
  const cur = src.currency ?? acc?.currency ?? mainCode;
  const dec = ctx.curByCode[cur]?.decimals ?? 2;
  const amtStr =
    src.amountMinor === null
      ? null
      : masked
        ? maskedMoneyText(cur, { withSymbol: false })
        : moneyText(Math.abs(src.amountMinor), dec);
  parts.push(
    amtStr !== null
      ? `${KIND_WORD[src.kind]} ${amtStr}${cur !== mainCode ? ` ${cur}` : ""}`
      : KIND_WORD[src.kind],
  );
  if (src.feeMinor !== null && src.feeMinor > 0) {
    const feeCurCode = acc?.currency ?? cur;
    const feeDec = ctx.curByCode[feeCurCode]?.decimals ?? dec;
    const feeAmt = masked ? maskedMoneyText(feeCurCode, { withSymbol: false }) : moneyText(src.feeMinor, feeDec);
    parts.push(`手續費 ${feeAmt}${feeCurCode !== mainCode ? ` ${feeCurCode}` : ""}`);
  }
  if (acc && acc.deleted_at === null) {
    const to = src.kind === "transfer" && src.toAccountId ? ctx.accById[src.toAccountId] : undefined;
    parts.push(to ? `${acctLabel(acc, ctx.accounts)} → ${acctLabel(to, ctx.accounts)}` : acctLabel(acc, ctx.accounts));
  }
  if (short) {
    if (src.item.trim()) parts.push(src.item.trim());
    return parts.join(" · ");
  }
  const cat = src.categoryId && !isUncat(src.categoryId) ? ctx.catById[src.categoryId] : undefined;
  if (cat && src.kind !== "transfer") parts.push(categoryLabel(cat, ctx.catById));
  if (src.item.trim()) parts.push(`品項「${src.item.trim()}」`);
  if (src.note.trim()) parts.push(`隨筆「${src.note.trim()}」`);
  const route = src.routeId ? ctx.routes.find((r) => r.id === src.routeId && r.deleted_at === null) : undefined;
  if (route) parts.push(`路線 ${route.name}`);
  if (tags.length) parts.push(tags.map((t) => `#${t}`).join(" "));
  return parts.join(" · ");
}

/** 一筆帳存成常用會帶入什麼（精算不能存，呼叫端先擋） */
export function entryWhat(e: EntryRow, ctx: WhatCtx, tags: readonly string[], masked = false): string {
  const kind = e.kind === "adjust" ? "expense" : e.kind;
  return whatText(
    {
      kind,
      amountMinor: e.amount_minor,
      currency: e.currency,
      accountId: e.account_id,
      toAccountId: e.to_account_id,
      categoryId: e.category_id,
      item: e.item ?? "",
      note: e.note,
      feeMinor: e.fee_minor ?? null,
      routeId: e.route_id,
    },
    ctx,
    tags,
    false,
    masked,
  );
}

/** 一個常用票種點了會帶入什麼；short＝只要類型金額、手續費、帳戶與品項 */
export function templateWhat(t: TemplateRow, ctx: WhatCtx, tags: readonly string[], short = false, masked = false): string {
  return whatText(
    {
      kind: t.kind,
      amountMinor: t.amount_minor,
      currency: t.currency,
      accountId: t.account_id,
      toAccountId: t.to_account_id,
      categoryId: t.category_id,
      item: t.item ?? "",
      note: t.note,
      feeMinor: t.fee_minor ?? null,
      routeId: t.route_id,
    },
    ctx,
    tags,
    short,
    masked,
  );
}

/** 「存成常用…」名稱欄的預設：優先取品項／來源（次取隨筆備註）的第一段字；都沒有用分類名；都沒有用類型 */
export function defaultTemplateName(e: EntryRow, catById: Readonly<Record<string, CategoryRow>>): string {
  const src = (e.item ?? "").trim() || e.note.trim();
  const first = src.split(/\s+/)[0] ?? "";
  if (first) return first.slice(0, 16);
  const cat = e.category_id && !isUncat(e.category_id) ? catById[e.category_id] : undefined;
  if (cat) return cat.name;
  return e.kind === "income" ? "收入" : e.kind === "transfer" ? "轉帳" : "支出";
}
