/**
 * 售票口「記住上次」的純函式（己-2 B1／B2／B5，D-主-416～418）。存在本機設定（settingsRepo）、不進同步白名單；
 * 讀寫與「什麼時候套」在 store/ticketStore.ts，這裡只管字串 ↔ 值與轉入帳戶怎麼猜。
 *
 * - B5 視圖、B1 統計的期間（月／年）、切面、收支：讀回來不認得的值一律當沒寫過（回預設）。
 *   切面讀回來還要過 `facetAllowed`（側欄篩了帳戶時「依帳戶」不成立）——那一步在 store，因為要看當下的篩選。
 * - B2 轉帳的轉入帳戶：記「從哪個帳戶轉出 → 上次轉進哪個帳戶」，外加一格「不分轉出、最近一次轉進哪」當備案。
 *   猜的時候：照轉出帳戶查 → 查不到用最近一次 → 都要是還在、沒封存、而且不是轉出帳戶本身，否則不猜（留空讓人挑）。
 */
import type { AccountRow } from "./ticket";
import type { Facet, StatsSpan, TicketView } from "./ticketView";

const VIEWS: readonly TicketView[] = ["list", "calendar", "stats", "accounts", "wish"];
const SPANS: readonly StatsSpan[] = ["month", "year"];
const FACETS: readonly Facet[] = ["category", "account", "route", "tag"];

export const parseTicketView = (raw: string | null): TicketView => (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as TicketView) : "list";
export const parseStatsSpan = (raw: string | null): StatsSpan => (SPANS as readonly string[]).includes(raw ?? "") ? (raw as StatsSpan) : "month";
export const parseFacet = (raw: string | null): Facet => (FACETS as readonly string[]).includes(raw ?? "") ? (raw as Facet) : "category";
export const parseFacetKind = (raw: string | null): "expense" | "income" => (raw === "income" ? "income" : "expense");

/** 轉入帳戶的記憶：轉出帳戶 id → 上次轉入的帳戶 id；`LAST` 那一格＝不分轉出、最近一次 */
export type TransferMemo = Readonly<Record<string, string>>;
const LAST = "*";

export function parseTransferMemo(raw: string | null): TransferMemo {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "string" && x) out[k] = x;
    return out;
  } catch {
    return {};
  }
}

/** 存一筆轉帳之後：記下這次的轉入（同一個轉出帳戶蓋掉舊的，最近一次也換成它） */
export function rememberTransfer(memo: TransferMemo, from: string, to: string): TransferMemo {
  if (!from || !to || from === to) return memo;
  return { ...memo, [from]: to, [LAST]: to };
}

/** 新的轉帳該預填哪個轉入帳戶；猜不到＝null（留空讓人挑） */
export function guessTransferTo(memo: TransferMemo, from: string | null, accById: Readonly<Record<string, AccountRow>>): string | null {
  const ok = (id: string | undefined): id is string => !!id && id !== from && !!accById[id] && accById[id].archived_at === null;
  const own = from ? memo[from] : undefined;
  if (ok(own)) return own;
  const last = memo[LAST];
  return ok(last) ? last : null;
}
