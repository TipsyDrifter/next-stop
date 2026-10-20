/**
 * repeatText——定期帳列的字，兩殼共用（修正-UI：桌機 RepeatManager 與手機 MobileRepeatSheet 原本各寫一套，
 * 被擋原因、同名帳戶、備註去重三處對不上）。只管「印什麼字」，排版各殼自己決定。
 */
import { MAIN_CURRENCY, UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, bareName, moneyText, quickAmountText, type AccountRow, type CategoryRow, type CurrencyRow } from "../../../domain/ticket";
import { parseFixedRule, type RepeatRow } from "../../../domain/ticketPlan";

const alive = <T extends { deleted_at: string | null }>(x: T | undefined): x is T => !!x && x.deleted_at === null;

/**
 * 列首 ⚠ 的短原因（null＝沒事）。先看資料本身（規則看不懂、帳戶／轉入帳戶／分類已刪）——不用等下一次實體化跑過才出現；
 * 資料看起來沒事才用上次實體化被擋的原因（store.repeatBlocked）。
 */
export function repeatWarn(
  r: RepeatRow,
  ctx: { accById: Readonly<Record<string, AccountRow>>; catById: Readonly<Record<string, CategoryRow>> },
  blocked: Readonly<Record<string, string>>,
): string | null {
  if (!parseFixedRule(r.rule)) return "重複規則有誤";
  if (!alive(ctx.accById[r.account_id])) return r.kind === "transfer" ? "轉出帳戶已刪除" : "帳戶已刪除";
  if (r.kind === "transfer" && (!r.to_account_id || !alive(ctx.accById[r.to_account_id]))) return "轉入帳戶已刪除";
  if (r.kind !== "transfer" && r.category_id && r.category_id !== UNCAT_EXPENSE_ID && r.category_id !== UNCAT_INCOME_ID && !alive(ctx.catById[r.category_id])) {
    return "分類已刪除";
  }
  return blocked[r.id] ?? null;
}

/** 金額段：「−12,000」「＋5,000」「⇄1,000」；外幣另回代碼 */
export function repeatAmount(r: RepeatRow, curByCode: Readonly<Record<string, CurrencyRow>>): { text: string; code: string | null } {
  const cur = curByCode[r.currency];
  const dec = cur ? cur.decimals : 2;
  const text = r.kind === "transfer" ? moneyText(r.amount_minor, dec, { prefix: "⇄" }) : quickAmountText(r.kind, r.amount_minor, dec);
  const foreign = r.currency !== MAIN_CURRENCY && !(cur && cur.is_main === 1);
  return { text, code: foreign ? r.currency : null };
}

/** 未分類的收支規則（沒分類、或掛在「未分類」籃子） */
export function repeatUncat(r: RepeatRow): boolean {
  if (r.kind === "transfer") return false;
  return r.category_id === null || r.category_id === UNCAT_INCOME_ID || r.category_id === UNCAT_EXPENSE_ID;
}

/**
 * 列上要不要另印備註：空的不印；和分類同名（去 emoji 後；例：分類「💰 生活費」備註「生活費」）不印——不然會讀成「生活費 生活費」。
 * 未分類的列各殼自己決定（手機拿備註當名字）。
 */
export function repeatNoteShown(r: RepeatRow, catById: Readonly<Record<string, CategoryRow>>): string | null {
  const note = r.note.trim();
  if (!note) return null;
  const c = r.category_id ? catById[r.category_id] : undefined;
  if (c && bareName(c.name) === note) return null;
  return note;
}
