/**
 * 週方針的純函式（戊；契約 `docs/research/2026-11-02-主線-週方針-契約.md`）。
 *
 * 一週一份、三到五句「這週大致要完成的事」，每句可掛一條路線或一條支線。資料表 `week_aims`（migration `week_aims`）。
 * 本檔零副作用、零 store：週的算術、排序、寫方針框的存檔差異、排成車票的落點與預設日、收合與回顧的判斷、回顧與「已排」的字。
 * node 測試直接載入（值 import 一律帶 `.ts`）。
 */
import type { SyncFields } from "./sync";
import type { NodeKind } from "./node";
import { allowedChildKinds } from "./node.ts";
import { addDays } from "../lib/date.ts";
import { uuidv5 } from "../lib/uuidv5.ts";

export interface WeekAimRow extends SyncFields {
  id: string;
  /** 那週第一天 YYYY-MM-DD（寫的當下的「每週從星期幾開始」） */
  week_on: string;
  text: string;
  /** 掛的路線或支線（AIM_ATTACH_KINDS）；null＝不掛 */
  node_id: string | null;
  position: number;
  /** 済的時刻（UTC ISO）；null＝還沒済 */
  done_at: string | null;
  /** 從哪一句帶過來（來源方針的 id，D-主-252）；null＝這週新寫的 */
  carried_from: string | null;
}

/** 一週最多幾句（D-主-253） */
export const MAX_AIMS = 5;
/** 一句最長幾個字（超過擋下；告示一行放得下的長度） */
export const AIM_TEXT_MAX = 60;
/** 方針可以掛的節點種類（D-主-255 起只開路線；丁放寬「支線底下直接放票」後加支線，D-主-281） */
export const AIM_ATTACH_KINDS: readonly NodeKind[] = ["route", "branch"];
/** 帶過去那列的決定性 id 的命名空間（D-主-252；固定值，改了兩台就對不上） */
export const WEEK_AIM_ID_NAMESPACE = "5b8f2c47-3d1e-5a90-8c6b-2e7f41a9d0c3";
/** 本地設定鍵（不進同步白名單＝各台自己記；D-主-259、260） */
export const KEY_WEEK_AIMS_FOLD = "week_aims_fold";
export const KEY_WEEK_AIMS_REVIEW_SEEN = "week_aims_review_seen";

const NUM_ZH = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 句號：一、二、…（超過十句照阿拉伯數字） */
export function aimNumeral(i: number): string {
  return i < NUM_ZH.length ? `${NUM_ZH[i]}、` : `${i + 1}.`;
}

/* ───────────── 週的算術 ───────────── */

function dowOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** 包含 dateKey 的那週第一天；weekStart＝0 週日／1 週一（uiStore.weekStart） */
export function weekOnOf(dateKey: string, weekStart: 0 | 1): string {
  return addDays(dateKey, -((dowOf(dateKey) - weekStart + 7) % 7));
}

/** 那週最後一天 */
export function weekEndOf(weekOn: string): string {
  return addDays(weekOn, 6);
}

/** "10/26 – 11/1"（頁首與面板的日期） */
export function weekRangeText(weekOn: string): string {
  const md = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
  return `${md(weekOn)} – ${md(weekEndOf(weekOn))}`;
}

/** 某週跟今天那週的關係（字）：這週／上週／下週／「10/26 那週」 */
export function weekRelText(weekOn: string, today: string, weekStart: 0 | 1): string {
  const cur = weekOnOf(today, weekStart);
  if (weekOn === cur) return "這週";
  if (weekOn === addDays(cur, -7)) return "上週";
  if (weekOn === addDays(cur, 7)) return "下週";
  const md = `${Number(weekOn.slice(5, 7))}/${Number(weekOn.slice(8, 10))}`;
  return weekOn.slice(0, 4) === today.slice(0, 4) ? `${md} 那週` : `${weekOn.slice(0, 4)}/${md} 那週`;
}

/** 今天是不是這週最後一天（週一起算＝週日）——帶子頁首多「回顧這週」 */
export function isLastDayOfWeek(today: string, weekStart: 0 | 1): boolean {
  return weekEndOf(weekOnOf(today, weekStart)) === today;
}

/* ───────────── 排序與篩選 ───────────── */

export function compareAims(a: WeekAimRow, b: WeekAimRow): number {
  return a.position - b.position || a.created_at.localeCompare(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 這週的方針（D-主-251：week_on 落在 [週首, 週首+6]、沒刪），照順序 */
export function aimsOfWeek(rows: readonly WeekAimRow[], weekOn: string): WeekAimRow[] {
  const end = weekEndOf(weekOn);
  return rows.filter((r) => r.deleted_at === null && r.week_on >= weekOn && r.week_on <= end).sort(compareAims);
}

/** 頁首「済 d/n」 */
export function doneCount(aims: readonly WeekAimRow[]): { done: number; total: number } {
  return { done: aims.filter((a) => a.done_at !== null).length, total: aims.length };
}

/* ───────────── 文字 ───────────── */

/** 一句的正規化：換行變空白、頭尾去空白、連續空白收成一格 */
export function normalizeAimText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** 寫入前驗：空字擋、超長擋（RangeError，store 接住 toast） */
export function checkAimText(raw: string): string {
  const t = normalizeAimText(raw);
  if (!t) throw new RangeError("方針不能是空的");
  if (Array.from(t).length > AIM_TEXT_MAX) throw new RangeError(`一句最多 ${AIM_TEXT_MAX} 個字`);
  return t;
}

/** 帶過去那列的 id（D-主-252）：兩台各自把同一句帶到同一週＝同一列 */
export function carryAimId(sourceId: string, targetWeekOn: string): Promise<string> {
  return uuidv5(WEEK_AIM_ID_NAMESPACE, `carry:${sourceId}|${targetWeekOn}`);
}

/* ───────────── 寫方針框（D-主-261） ───────────── */

/** 草稿的一列：有 id＝既有列；沒有＝新的（carriedFrom 有值＝帶過來的，存檔時用決定性 id） */
export interface AimDraft {
  id: string | null;
  text: string;
  nodeId: string | null;
  carriedFrom: string | null;
}

export interface AimSaveCreate {
  /** null＝隨機 id；帶過來的由呼叫端先算好決定性 id 填進來 */
  id: string | null;
  text: string;
  nodeId: string | null;
  position: number;
  carriedFrom: string | null;
}

export interface AimSavePlan {
  creates: AimSaveCreate[];
  updates: { id: string; text?: string; nodeId?: string | null; position?: number }[];
  deletes: string[];
}

/**
 * 寫方針框按「存檔」：草稿（照畫面順序、空字的列略過）對現況（這週的列）算出要寫什麼。
 * 只送變了的欄；位置照草稿順序重編 0..n-1（現況已經是這個號就不寫）；草稿裡沒有的既有列＝刪。
 * 超過 MAX_AIMS 句（不算原本就超過的既有列）擋下：RangeError。
 */
export function planSaveWeek(current: readonly WeekAimRow[], drafts: readonly AimDraft[]): AimSavePlan {
  const kept = drafts.map((d) => ({ ...d, text: normalizeAimText(d.text) })).filter((d) => d.text !== "");
  const curIds = new Set(current.map((r) => r.id));
  const newCount = kept.filter((d) => d.id === null || !curIds.has(d.id)).length;
  // 兩台合起來已經超過五句的週：不加新句就照樣存得了（使用者自己刪），加了新句才擋
  if (newCount > 0 && kept.length > MAX_AIMS) throw new RangeError(`一週最多 ${MAX_AIMS} 句`);
  const byId = new Map(current.map((r) => [r.id, r]));
  const plan: AimSavePlan = { creates: [], updates: [], deletes: [] };
  const seen = new Set<string>();
  kept.forEach((d, i) => {
    checkAimText(d.text);
    const cur = d.id !== null ? byId.get(d.id) : undefined;
    if (!cur) {
      plan.creates.push({ id: d.id, text: d.text, nodeId: d.nodeId, position: i, carriedFrom: d.carriedFrom });
      return;
    }
    seen.add(cur.id);
    const u: AimSavePlan["updates"][number] = { id: cur.id };
    if (cur.text !== d.text) u.text = d.text;
    if (cur.node_id !== d.nodeId) u.nodeId = d.nodeId;
    if (cur.position !== i) u.position = i;
    if (Object.keys(u).length > 1) plan.updates.push(u);
  });
  for (const r of current) if (!seen.has(r.id)) plan.deletes.push(r.id);
  return plan;
}

/** 某週沒済的（帶到下一週的候選），照順序 */
export function carryCandidates(aims: readonly WeekAimRow[]): WeekAimRow[] {
  return aims.filter((a) => a.done_at === null && a.deleted_at === null).sort(compareAims);
}

/* ───────────── 排成車票（D-主-256） ───────────── */

export interface TicketPlacement {
  /** 建在哪個節點底下；null＝根層臨時車票 */
  parentId: string | null;
  /** 根層臨時車票的路線標籤；放節點底下時 null */
  routeTagId: string | null;
}

/**
 * 落點：節點底下能直接放車票（支線、列車、車廂；丁放寬後）⇒ 放底下；路線（還是不能直接放票）⇒ 根層臨時車票＋這條路線的標籤；
 * 其他放不了票的 ⇒ 根層臨時車票＋它所屬路線的標籤；沒掛 ⇒ 根層臨時車票。
 */
export function ticketPlacement(node: { id: string; kind: NodeKind; route_id: string | null } | null): TicketPlacement {
  if (!node) return { parentId: null, routeTagId: null };
  if (allowedChildKinds(node.kind).includes("ticket")) return { parentId: node.id, routeTagId: null };
  if (node.kind === "route") return { parentId: null, routeTagId: node.id };
  return { parentId: null, routeTagId: node.route_id };
}

/** 執行日預設：這週還沒過的第一天＝max(今天, 週首)；看的是過去的週＝今天 */
export function planDefaultDay(today: string, weekOn: string): string {
  if (today > weekEndOf(weekOn)) return today;
  return today > weekOn ? today : weekOn;
}

/* ───────────── 「已排 N 張・済 M」（D-主-257） ───────────── */

export interface PlanCount {
  planned: number;
  done: number;
}

/** 那句底下一行淡字；null＝不畫 */
export function planHint(aimDone: boolean, c: PlanCount | undefined): string | null {
  if (!c || c.planned === 0) return null;
  if (!aimDone && c.done >= c.planned) return "排的票都済了";
  return `已排 ${c.planned} 張・済 ${c.done}`;
}

/* ───────────── 收合與回顧（D-主-259、260） ───────────── */

/** 沒記收合時的預設：今天在週首到週二之間＝展開（回 false＝不收） */
export function defaultFolded(today: string, weekOn: string): boolean {
  const idx = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${weekOn}T00:00:00Z`)) / 86_400_000);
  const tuesdayIdx = (2 - dowOf(weekOn) + 7) % 7;
  return idx > tuesdayIdx;
}

/** 本地鍵 `week_aims_fold` 的值 → 這週收不收（記的是別週＝回預設） */
export function foldedOf(raw: string | null, today: string, weekOn: string): boolean {
  if (raw) {
    const [wk, v] = raw.split(":");
    if (wk === weekOn && (v === "0" || v === "1")) return v === "1";
  }
  return defaultFolded(today, weekOn);
}

export function foldValue(weekOn: string, folded: boolean): string {
  return `${weekOn}:${folded ? "1" : "0"}`;
}

/**
 * 新的一週第一次打開要不要自動出上週回顧：上週有方針、而且上週的回顧還沒看過。
 * `seen`＝本地鍵 `week_aims_review_seen`（看過的那週週首）。回要回顧的那週週首或 null。
 */
export function pendingReviewWeek(today: string, weekStart: 0 | 1, prevWeekHasAims: boolean, seen: string | null): string | null {
  const prev = addDays(weekOnOf(today, weekStart), -7);
  if (!prevWeekHasAims) return null;
  if (seen !== null && seen >= prev) return null;
  return prev;
}

/* ───────────── 回顧（D-主-258） ───────────── */

export interface ReviewStat {
  /** 蓋章：這週的済章（domain/seals.ts 的口徑，同運行報告；D-主-283）裡落在那條路線／支線底下的枚數 */
  stamps: number;
  /** 時刻表：連到路線的時間塊跟這週重疊的分鐘數；null＝讀不到（mock） */
  minutes: number | null;
  /** 售票口：支出合計（主幣別最小單位）；null＝讀不到或這種節點掛不了帳 */
  spendMinor: number | null;
}

/** 回顧表的時間字：3h40m／45m／0 ⇒ null（畫「—」） */
export function reviewMinutesText(min: number | null): string | null {
  if (min === null || min <= 0) return null;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m}m`;
  return m ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
}
