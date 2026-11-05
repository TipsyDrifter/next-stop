/**
 * 週方針的純函式（戊；契約 `docs/research/2026-11-02-主線-週方針-契約.md`）。
 *
 * 一週一份、三到五句「這週大致要完成的事」，每句可掛一條路線或一條支線。資料表 `week_aims`（migration `week_aims`）。
 * 本檔零副作用、零 store：週的算術、排序、寫方針框的存檔差異、排成車票的落點與預設日、收合與回顧的判斷、回顧與「已排」的字。
 * node 測試直接載入（值 import 一律帶 `.ts`）。
 *
 * ⚠ 方針擴充（辛 D-主-371；契約 `docs/research/2026-11-04-主線-方針擴充-契約.md`）：`week_on` 現在裝的是「期間鍵」，欄名是歷史遺留，表名、欄名都不改。
 * 一張表裝四種期間：週＝那週第一天 `2026-11-02`（不變）、月＝`M2026-11`、年＝`Y2026`、車站＝`S<節點 id>`。編解碼只在本檔。
 * 為什麼安全：`M`、`S`、`Y` 都排在任何日期字串之後，舊版的週區間查詢撈不到；同步引擎只拿 week_on 排序與判必填、不解讀內容，
 * 舊版那台照樣收、照樣存（`scripts/tests/week-aims-repo.test.ts` 的〈舊版相容〉守住這件事）。
 */
import type { SyncFields } from "./sync";
import type { NodeKind } from "./node";
import { allowedChildKinds } from "./node.ts";
import { addDays, dayWindow } from "../lib/date.ts";
import { uuidv5 } from "../lib/uuidv5.ts";

export interface WeekAimRow extends SyncFields {
  id: string;
  /** 期間鍵（欄名是歷史遺留，D-主-371）：週＝那週第一天 YYYY-MM-DD（寫的當下的「每週從星期幾開始」）；月 M2026-11；年 Y2026；車站 S<節點 id> */
  week_on: string;
  text: string;
  /** 掛的路線或支線（AIM_ATTACH_KINDS）；null＝不掛 */
  node_id: string | null;
  position: number;
  /** 済的時刻（UTC ISO）；null＝還沒済 */
  done_at: string | null;
  /** 從哪一句帶過來（來源方針的 id，D-主-252）；null＝這一期新寫的 */
  carried_from: string | null;
}

/** 一期最多幾句（D-主-253、372：週、月、年、站各算各的） */
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

/* ───────────── 期間鍵（D-主-371；唯一編解碼處） ───────────── */

export type AimPeriod = "week" | "month" | "year" | "station";
/** 會自動排隊回顧的期間（車站的回顧掛在到站那一刻，不排隊，D-主-374） */
export type ReviewPeriod = Exclude<AimPeriod, "station">;

/** 各期間的收合本地鍵（週沿用舊鍵；§2） */
export const KEY_AIMS_FOLD: Record<AimPeriod, string> = {
  week: KEY_WEEK_AIMS_FOLD,
  month: "aims_fold_month",
  year: "aims_fold_year",
  station: "aims_fold_station",
};
/** 各期間「看過回顧到哪一期」的本地鍵（D-主-373） */
export const KEY_AIMS_REVIEW_SEEN: Record<ReviewPeriod, string> = {
  week: KEY_WEEK_AIMS_REVIEW_SEEN,
  month: "aims_review_seen_month",
  year: "aims_review_seen_year",
};

/** 第一個字 M／Y／S，其餘＝週 */
export function periodOfKey(key: string): AimPeriod {
  switch (key[0]) {
    case "M":
      return "month";
    case "Y":
      return "year";
    case "S":
      return "station";
    default:
      return "week";
  }
}

/** 2026-11-04 → M2026-11 */
export function monthKeyOf(dateKey: string): string {
  return `M${dateKey.slice(0, 7)}`;
}

/** 2026-11-04 → Y2026 */
export function yearKeyOf(dateKey: string): string {
  return `Y${dateKey.slice(0, 4)}`;
}

export function stationKeyOf(stationId: string): string {
  return `S${stationId}`;
}

/** S<id> → id；不是車站的鍵＝null */
export function stationIdOfKey(key: string): string | null {
  return periodOfKey(key) === "station" ? key.slice(1) : null;
}

/** 含頭含尾的日子（YYYY-MM-DD） */
export interface DayRange {
  from: string;
  to: string;
}

/** 車站沒有界線時的兩端 */
export const DAY_MIN = "0000-01-01";
export const DAY_MAX = "9999-12-31";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 週／月／年的範圍；車站要看上一站，丟 RangeError，改用 stationWindow */
export function periodRangeOf(key: string): DayRange {
  switch (periodOfKey(key)) {
    case "month": {
      const y = Number(key.slice(1, 5));
      const m = Number(key.slice(6, 8));
      return { from: `${key.slice(1)}-01`, to: `${key.slice(1)}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
    }
    case "year":
      return { from: `${key.slice(1)}-01-01`, to: `${key.slice(1)}-12-31` };
    case "station":
      throw new RangeError("車站的期間要用 stationWindow 算");
    default:
      return { from: key, to: addDays(key, 6) };
  }
}

/** 車站期間要的欄（sidebar 的 stations 直接吃得進來） */
export interface StationWindowFields {
  id: string;
  arrived_on: string | null;
  expected_on: string | null;
}

/**
 * 車站期間（§2、D-主-383）：上一站到站日（沒有＝不限）～這站到站日（還沒到＝不限）。預定日不當界線：過了預定日還沒到站，這一站的事就還在進行。
 * `siblingsInOrder`＝同一條路線的車站、照兄弟順序（含自己）。「上一站」跳過還沒到的站，找最近一個到過的：
 * 跳站時（A 到了、B 沒到、看 C）從 A 算起，不會變成不限。站到得比順序亂（上一站比這站晚到）＝from 大於 to 的空範圍，數字都是 0。
 */
export function stationWindow(st: StationWindowFields, siblingsInOrder: readonly StationWindowFields[]): DayRange {
  const idx = siblingsInOrder.findIndex((s) => s.id === st.id);
  let from = DAY_MIN;
  for (let i = idx - 1; i >= 0; i--) {
    const at = siblingsInOrder[i].arrived_on;
    if (at !== null) {
      from = at;
      break;
    }
  }
  return { from, to: st.arrived_on ?? DAY_MAX };
}

/**
 * 沒有「今天」可比的地方（失物招領、匯出）怎麼寫一個期間：11/2 那週／2026 年 11 月／2026 年／站名。
 * 看不懂的鍵原樣回：資料是兩台同步來的，字壞了也要看得到。
 */
export function periodLabel(key: string, stationName?: string | null): string {
  switch (periodOfKey(key)) {
    case "month":
      return `${key.slice(1, 5)} 年 ${Number(key.slice(6, 8))} 月`;
    case "year":
      return `${key.slice(1)} 年`;
    case "station":
      return stationName ? `車站 ${stationName}` : "車站";
    default:
      return /^\d{4}-\d{2}-\d{2}$/.test(key) ? `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))} 那週` : key;
  }
}

/** 上下一期：週 ±7 天、月 ±1、年 ±1；車站沒有固定的下一期，丟 RangeError */
export function adjacentKey(key: string, delta: -1 | 1): string {
  switch (periodOfKey(key)) {
    case "month": {
      const t = Number(key.slice(1, 5)) * 12 + Number(key.slice(6, 8)) - 1 + delta;
      return `M${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
    }
    case "year":
      return `Y${Number(key.slice(1)) + delta}`;
    case "station":
      throw new RangeError("車站沒有固定的上下一期");
    default:
      return addDays(key, delta * 7);
  }
}

/** 一期的列在 week_on 這一欄的界線（listRange 的兩個參數）：週＝區間（D-主-251），其他＝等於鍵 */
export function keyRowBounds(key: string): DayRange {
  return periodOfKey(key) === "week" ? { from: key, to: addDays(key, 6) } : { from: key, to: key };
}

/** DayRange 的日界線視窗（UTC ISO，[start, end)）；不限的一端用排得過所有時刻戳的字串——時刻戳是照字串比的，不能算出 +010000 這種年份 */
export function dayRangeWindow(range: DayRange, dayStartHour: number): { start: string; end: string } {
  return {
    start: range.from === DAY_MIN ? "0000-01-01T00:00:00.000Z" : dayWindow(range.from, dayStartHour).start,
    end: range.to === DAY_MAX ? "9999-12-31T23:59:59.999Z" : dayWindow(range.to, dayStartHour).end,
  };
}

/** 五句上限的錯誤字（寫方針框與 repository 同一句） */
export function aimLimitMessage(key: string): string {
  const unit = { week: "一週", month: "一個月", year: "一年", station: "一站" }[periodOfKey(key)];
  return `${unit}最多 ${MAX_AIMS} 句`;
}

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

/** 一期的方針：週＝aimsOfWeek（區間）；其他＝week_on 等於鍵。都濾已刪、照順序 */
export function aimsOfKey(rows: readonly WeekAimRow[], key: string): WeekAimRow[] {
  if (periodOfKey(key) === "week") return aimsOfWeek(rows, key);
  return rows.filter((r) => r.deleted_at === null && r.week_on === key).sort(compareAims);
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

/** 帶過去那列的 id（D-主-252、372）：兩台各自把同一句帶到同一期＝同一列。`targetKey`＝目標期間鍵；週的結果跟擴充前一樣 */
export function carryAimId(sourceId: string, targetKey: string): Promise<string> {
  return uuidv5(WEEK_AIM_ID_NAMESPACE, `carry:${sourceId}|${targetKey}`);
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
  /** 框開著時別處動了這一期（給了 base 又真的撞到才有）：`dropped`＝別處刪掉、這次沒存回去的字；`theirs`＝別處新寫、這次留著的列（不算五句上限） */
  conflict?: { dropped: string[]; theirs: { id: string; text: string }[] };
}

/**
 * 寫方針框按「存檔」：草稿（照畫面順序、空字的列略過）對現況（這一期的列）算出要寫什麼。
 * 只送變了的欄；位置照草稿順序重編 0..n-1（現況已經是這個號就不寫）；草稿裡沒有的既有列＝刪。
 * 超過 MAX_AIMS 句（不算原本就超過的既有列）擋下：RangeError；`key`＝期間鍵，決定錯誤字（省略＝週）。
 *
 * `base`＝框打開當下的列（省略＝舊行為，外部助理讀完現況馬上寫，中間沒有空檔）。框可能開很久，期間同步會進來，所以三方比對：
 *   - base 有、現況沒有＝別處刪了 ⇒ 丟掉這列（不走 creates，否則復活又清掉済），字進 `conflict.dropped` 讓畫面說一聲；刪掉的不復活。
 *   - 現況有、base 沒有、草稿沒有＝別處新寫的 ⇒ 不刪，接在草稿後面，進 `conflict.theirs`；五句上限只看自己這邊，不因此擋存檔。
 *   - 兩邊都有的列：這邊沒動的欄不寫（別處改的字不被舊字蓋回去），這邊也改了才以這邊為準。
 *   - 帶過來的列（決定性 id、不在 base）：現況沒有＝照舊 create。那一列若被別處刪過，這個 create 會把它復活（D-主-252「刪掉再帶＝復活」）：
 *     帶過來是使用者在這個框裡按的明確動作，分不出兩邊先後，不該讓按了的句子消失；留下來頂多再刪一次，消失了他不會知道。
 */
export function planSaveWeek(
  current: readonly WeekAimRow[],
  drafts: readonly AimDraft[],
  key = "",
  base?: readonly Pick<AimDraft, "id" | "text" | "nodeId">[],
): AimSavePlan {
  const byId = new Map(current.map((r) => [r.id, r]));
  const baseById = new Map((base ?? []).filter((b) => b.id !== null).map((b) => [b.id as string, b]));
  const written = drafts.map((d) => ({ ...d, text: normalizeAimText(d.text) })).filter((d) => d.text !== "");
  const goneElsewhere = (d: AimDraft) => d.id !== null && !byId.has(d.id) && baseById.has(d.id);
  const kept = written.filter((d) => !goneElsewhere(d));
  const newCount = kept.filter((d) => d.id === null || !byId.has(d.id)).length;
  // 兩台合起來已經超過五句的那一期：不加新句就照樣存得了（使用者自己刪），加了新句才擋
  if (newCount > 0 && kept.length > MAX_AIMS) throw new RangeError(aimLimitMessage(key));
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
    const was = baseById.get(cur.id);
    const u: AimSavePlan["updates"][number] = { id: cur.id };
    if (cur.text !== d.text && (!was || normalizeAimText(was.text) !== d.text)) u.text = d.text;
    if (cur.node_id !== d.nodeId && (!was || was.nodeId !== d.nodeId)) u.nodeId = d.nodeId;
    if (cur.position !== i) u.position = i;
    if (Object.keys(u).length > 1) plan.updates.push(u);
  });
  const theirs = base ? current.filter((r) => !seen.has(r.id) && !baseById.has(r.id)).sort(compareAims) : [];
  theirs.forEach((r, j) => {
    seen.add(r.id);
    if (r.position !== kept.length + j) plan.updates.push({ id: r.id, position: kept.length + j });
  });
  for (const r of current) if (!seen.has(r.id)) plan.deletes.push(r.id);
  const dropped = written.filter(goneElsewhere).map((d) => d.text);
  if (dropped.length || theirs.length) plan.conflict = { dropped, theirs: theirs.map((r) => ({ id: r.id, text: r.text })) };
  return plan;
}

/** 存檔撞到別處的改動時 toast 的字（一句寫句子、多句寫句數）；沒撞到＝null。「別處」＝另一台或外部助理 */
export function aimConflictNotice(plan: AimSavePlan): string | null {
  if (!plan.conflict) return null;
  const said = (list: readonly string[]) => (list.length === 1 ? `「${list[0]}」` : `${list.length} 句`);
  const { dropped, theirs } = plan.conflict;
  const parts: string[] = [];
  if (dropped.length) parts.push(`${said(dropped)}在別處刪掉了，沒有存回去`);
  if (theirs.length) parts.push(`${said(theirs.map((r) => r.text))}是別處新寫的，也留著`);
  return parts.join("；");
}

/** repository 的第二道五句上限（兩個實作同一把尺）：`alive`＝這一期活著的列；別處新寫、這次留著的不算（`conflict.theirs`） */
export function assertAimLimit(key: string, alive: ReadonlySet<string>, plan: AimSavePlan): void {
  const gone = new Set([...plan.deletes, ...(plan.conflict?.theirs ?? []).map((r) => r.id)]);
  const added = plan.creates.filter((c) => c.id === null || !alive.has(c.id)).length;
  const after = [...alive].filter((id) => !gone.has(id)).length + added;
  if (added > 0 && after > MAX_AIMS) throw new RangeError(aimLimitMessage(key));
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

/** 第二參數收期間鍵或範圍的地方共用：鍵＝週、月、年（車站的鍵丟 RangeError） */
export function toDayRange(range: DayRange | string): DayRange {
  return typeof range === "string" ? periodRangeOf(range) : range;
}

/** 執行日預設：這一期還沒過的第一天＝max(今天, 期首)；看的是過去那一期＝今天；車站（期首常常不限）＝今天（§2） */
export function planDefaultDay(today: string, keyOrRange: string | DayRange): string {
  if (typeof keyOrRange === "string" && periodOfKey(keyOrRange) === "station") return today;
  const { from, to } = toDayRange(keyOrRange);
  if (today > to) return today;
  return today > from ? today : from;
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

/**
 * 各期間的收合預設（§2；回 false＝展開）：週＝週首到週二；月＝1～7 日；年＝1 月；車站＝一律展開。
 * 翻到別期照週的類推：過去那一期收合、未來那一期展開。
 */
export function defaultFoldedOf(period: AimPeriod, today: string, key: string): boolean {
  switch (period) {
    case "month":
      return today > `${key.slice(1)}-07`;
    case "year":
      return today > `${key.slice(1)}-01-31`;
    case "station":
      return false;
    default:
      return defaultFolded(today, key);
  }
}

/** 本地鍵 `week_aims_fold` 的值 → 這週收不收（記的是別週＝回預設） */
export function foldedOf(raw: string | null, today: string, weekOn: string): boolean {
  if (raw) {
    const [wk, v] = raw.split(":");
    if (wk === weekOn && (v === "0" || v === "1")) return v === "1";
  }
  return defaultFolded(today, weekOn);
}

/** foldedOf 的通用版：吃各期間自己的本地鍵的值（`<期間鍵>:<0|1>`）；記的是別期＝回預設 */
export function foldedOfKey(raw: string | null, today: string, key: string): boolean {
  const sep = raw ? raw.lastIndexOf(":") : -1;
  if (raw && sep > 0 && raw.slice(0, sep) === key) {
    const v = raw.slice(sep + 1);
    if (v === "0" || v === "1") return v === "1";
  }
  return defaultFoldedOf(periodOfKey(key), today, key);
}

export function foldValue(key: string, folded: boolean): string {
  return `${key}:${folded ? "1" : "0"}`;
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

/**
 * 新的一期第一次打開要排隊出的回顧（D-主-373）：照週→月→年，上一期有方針、而且那一期的回顧還沒看過。
 * `seen`＝各期間看過回顧到哪一期（週首／M…／Y…；同期間的鍵照字串比就是照時間比）。一次出一張、關掉才輪下一張由畫面管。
 */
export function pendingReviewKeys(
  today: string,
  weekStart: 0 | 1,
  hasAims: (key: string) => boolean,
  seen: Record<ReviewPeriod, string | null>,
): string[] {
  const out: string[] = [];
  const week = adjacentKey(weekOnOf(today, weekStart), -1);
  if (pendingReviewWeek(today, weekStart, hasAims(week), seen.week) !== null) out.push(week);
  const want = (prev: string, s: string | null): void => {
    if (hasAims(prev) && (s === null || s < prev)) out.push(prev);
  };
  want(adjacentKey(monthKeyOf(today), -1), seen.month);
  want(adjacentKey(yearKeyOf(today), -1), seen.year);
  return out;
}

/* ───────────── 期間的字 ───────────── */

const MONTH_LATIN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface PeriodTitle {
  /** 本週方針／本月方針／今年方針；翻到別期＝「上週的方針」「10月的方針」「2025 年的方針」 */
  title: string;
  latin: string;
  /** 頁首的日期："10/26 – 11/1"；車站＝空字（要站名與 stationWindow，呼叫端自己組） */
  range: string;
  /** 跟今天的關係（字）：這週／這個月／今年／這一站；接得上「還沒寫…的方針」「…回顧」 */
  rel: string;
}

/** 告示、寫方針框、回顧的標題（四種期間共用） */
export function periodTitle(key: string, today: string, weekStart: 0 | 1): PeriodTitle {
  switch (periodOfKey(key)) {
    case "month": {
      const cur = monthKeyOf(today);
      const m = Number(key.slice(6, 8));
      const y = key.slice(1, 5);
      const named = y === today.slice(0, 4) ? `${m}月` : `${y}年${m}月`;
      const { to } = periodRangeOf(key);
      return {
        title: key === cur ? "本月方針" : `${named}的方針`,
        latin: MONTH_LATIN[m - 1] ?? "",
        range: `${m}/1 – ${m}/${Number(to.slice(8, 10))}`,
        rel: key === cur ? "這個月" : key === adjacentKey(cur, -1) ? "上個月" : key === adjacentKey(cur, 1) ? "下個月" : named,
      };
    }
    case "year": {
      const cur = yearKeyOf(today);
      const y = key.slice(1);
      return {
        title: key === cur ? "今年方針" : `${y} 年的方針`,
        latin: y,
        range: "1/1 – 12/31",
        rel: key === cur ? "今年" : key === adjacentKey(cur, -1) ? "去年" : key === adjacentKey(cur, 1) ? "明年" : `${y} 年`,
      };
    }
    case "station":
      return { title: "這一站的方針", latin: "Station aims", range: "", rel: "這一站" };
    default: {
      const rel = weekRelText(key, today, weekStart);
      return {
        title: rel === "這週" ? "本週方針" : `${rel}的方針`,
        latin: rel === "這週" ? "This week" : "Weekly aims",
        range: weekRangeText(key),
        rel,
      };
    }
  }
}

/* ───────────── 畫面要的期間算術與字（方針擴充 辛 §7；告示、一行、面板、寫方針框、回顧共用） ───────────── */

/** 今天所在的那一期 */
export function currentKeyOf(period: ReviewPeriod, today: string, weekStart: 0 | 1): string {
  if (period === "month") return monthKeyOf(today);
  if (period === "year") return yearKeyOf(today);
  return weekOnOf(today, weekStart);
}

/** 今天是不是這一期最後一天（頁首多「回顧…」）；車站沒有固定的最後一天 */
export function isLastDayOfPeriod(key: string, today: string): boolean {
  return periodOfKey(key) !== "station" && periodRangeOf(key).to === today;
}

/** 這一期是不是已經過了（同期間的鍵照字串比就是照時間比）；車站不算 */
export function isPastPeriod(key: string, today: string, weekStart: 0 | 1): boolean {
  const period = periodOfKey(key);
  return period !== "station" && key < currentKeyOf(period, today, weekStart);
}

/**
 * 寫下層時列的上一層（D-主-375）：週 → 本月、月 → 那年；年與車站沒有上一層。
 * 跨月的週：今天落在這週 ⇒ 今天那個月；否則看週首那個月。
 */
export function upperKeyOf(key: string, today: string): string | null {
  switch (periodOfKey(key)) {
    case "week":
      return monthKeyOf(today >= key && today <= weekEndOf(key) ? today : key);
    case "month":
      return `Y${key.slice(1, 5)}`;
    default:
      return null;
  }
}

/** 寫方針框 ‹ › 中間的字：週＝日期區間；月、年要看得出哪一年 */
export function periodNavText(key: string): string {
  switch (periodOfKey(key)) {
    case "month":
      return `${key.slice(1, 5)}年${Number(key.slice(6, 8))}月`;
    case "year":
      return `${key.slice(1)}年`;
    case "station":
      return "";
    default:
      return weekRangeText(key);
  }
}

/** 換期的字：‹ › 的無障礙名稱、toast 用的單位 */
export function periodStepText(key: string): { prev: string; next: string; unit: string } {
  switch (periodOfKey(key)) {
    case "month":
      return { prev: "上個月", next: "下個月", unit: "月" };
    case "year":
      return { prev: "上一年", next: "下一年", unit: "年" };
    default:
      return { prev: "上一週", next: "下一週", unit: "週" };
  }
}

/** 寫方針框與回顧的眉標 */
export function periodOverline(key: string): { zh: string; latin: string } {
  switch (periodOfKey(key)) {
    case "month":
      return { zh: "月方針", latin: "Monthly aims" };
    case "year":
      return { zh: "年方針", latin: "Yearly aims" };
    case "station":
      return { zh: "車站方針", latin: "Station aims" };
    default:
      return { zh: "週方針", latin: "Weekly aims" };
  }
}

/** 回顧的標題：本週回顧／上週回顧／本月回顧／上個月回顧／今年回顧／去年回顧／這一站回顧 */
export function reviewTitle(key: string, today: string, weekStart: 0 | 1): string {
  const { rel } = periodTitle(key, today, weekStart);
  return `${rel === "這週" ? "本週" : rel === "這個月" ? "本月" : rel}回顧`;
}

/** 回顧頭的拉丁小字 */
export function reviewLatin(key: string): string {
  return { week: "Weekly review", month: "Monthly review", year: "Yearly review", station: "Station review" }[periodOfKey(key)];
}

/** 手機一行換成的字（D-主-373）：回顧上週／回顧上個月／回顧去年 */
export function reviewCueText(key: string, today: string, weekStart: 0 | 1): string {
  return `回顧${periodTitle(key, today, weekStart).rel}`;
}

/** 面板分頁與上層一行的短字：本週／本月／今年；別期＝上週、10月、2025 年 */
export function periodShortLabel(key: string, today: string, weekStart: 0 | 1): string {
  const { rel } = periodTitle(key, today, weekStart);
  return rel === "這週" ? "本週" : rel === "這個月" ? "本月" : rel;
}

export interface AimSegment {
  key: string;
  label: string;
}

/** 方案一那一行的段落（§7）：本週／本月／今年扣掉正在看的那一期 */
export function ribbonSegments(currentKey: string, today: string, weekStart: 0 | 1): AimSegment[] {
  const out: AimSegment[] = [];
  for (const period of ["week", "month", "year"] as const) {
    const key = currentKeyOf(period, today, weekStart);
    if (key !== currentKey) out.push({ key, label: periodShortLabel(key, today, weekStart) });
  }
  return out;
}

/** 手機面板的期間分頁：本週｜本月｜今年；正在看別期（行程表翻到下週、年鑑翻到去年）＝那一格換成那一期。車站沒有分頁 */
export function periodTabs(key: string, today: string, weekStart: 0 | 1): AimSegment[] {
  const shown = periodOfKey(key);
  if (shown === "station") return [];
  return (["week", "month", "year"] as const).map((period) => {
    const k = period === shown ? key : currentKeyOf(period, today, weekStart);
    return { key: k, label: periodShortLabel(k, today, weekStart) };
  });
}

/** 一行裡的句子：句・句・句（不放數字，D-主-376） */
export function aimsBrief(aims: readonly WeekAimRow[]): string {
  return aims.map((a) => a.text).join("・");
}

/** 車站要的欄（側欄那份列就吃得進來） */
export interface StationLabelFields {
  name: string;
  arrived_on: string | null;
  expected_on: string | null;
}

/** 車站告示頭的字：站名・到站日或預定日（periodTitle 的 range 留空，由這裡組） */
export function stationHeadText(st: StationLabelFields | null | undefined): string {
  if (!st) return "";
  const at = st.arrived_on ?? st.expected_on;
  return at ? `${st.name}・${Number(at.slice(5, 7))}/${Number(at.slice(8, 10))}` : st.name;
}

/** 下一個還沒到站的車站（§2「帶到下一站」）；這站之後沒有＝null。`siblingsInOrder`＝同一條路線的車站、照兄弟順序（含自己） */
export function nextStationOf<T extends { id: string; arrived_on: string | null }>(st: { id: string }, siblingsInOrder: readonly T[]): T | null {
  const idx = siblingsInOrder.findIndex((s) => s.id === st.id);
  if (idx < 0) return null;
  for (let i = idx + 1; i < siblingsInOrder.length; i++) if (siblingsInOrder[i].arrived_on === null) return siblingsInOrder[i];
  return null;
}

/** 每條路線的下一站（手機面板「下一站」分頁）：路線照傳進來的順序；全到站或沒車站的路線略過。`stations` 要已照兄弟順序排好 */
export function nextStationsOfRoutes<R extends { id: string }, S extends { parent_id: string | null; arrived_on: string | null }>(
  routes: readonly R[],
  stations: readonly S[],
): { route: R; station: S }[] {
  const out: { route: R; station: S }[] = [];
  for (const route of routes) {
    const station = stations.find((s) => s.parent_id === route.id && s.arrived_on === null);
    if (station) out.push({ route, station });
  }
  return out;
}

/** 月視圖一格要標的車站（D-主-380） */
export interface StationDayMark<S, R> {
  station: S;
  route: R;
}

/**
 * 日子 → 那天預定到站的車站（D-主-380）：有預定日、還沒到站、路線還在跑（收進車庫的不再預告，D-主-206 #10）。
 * 同一天照傳進來的順序；`routes` 傳全部路線也行，有 `arrived_on` 的略過。
 */
export function stationDayMarks<
  S extends { parent_id: string | null; arrived_on: string | null; expected_on: string | null },
  R extends { id: string; arrived_on: string | null },
>(stations: readonly S[], routes: readonly R[]): Map<string, StationDayMark<S, R>[]> {
  const live = new Map(routes.filter((r) => r.arrived_on === null).map((r) => [r.id, r] as const));
  const out = new Map<string, StationDayMark<S, R>[]>();
  for (const station of stations) {
    if (station.arrived_on !== null || station.expected_on === null || station.parent_id === null) continue;
    const route = live.get(station.parent_id);
    if (!route) continue;
    const list = out.get(station.expected_on);
    if (list) list.push({ station, route });
    else out.set(station.expected_on, [{ station, route }]);
  }
  return out;
}

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** 2026-12-06 → 12/6（日） */
function mdwText(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  return `${m}/${d}（${WEEK_ZH[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

/** 兩天差幾天（to − from） */
function daysBetween(from: string, to: string): number {
  const at = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/**
 * 車站小卡站名底下那一行（§7 StationCard）：「路線名・預定 12/6（日）・還有 32 天」；
 * 今天＝「就是今天」、過了＝「晚了 N 天」、沒定＝「還沒定預定日」；到站＝「路線名・11/4（三）到站」。
 */
export function stationCardSub(st: StationLabelFields, routeName: string | null | undefined, today: string): string {
  const parts: string[] = routeName ? [routeName] : [];
  if (st.arrived_on) parts.push(`${mdwText(st.arrived_on)}到站`);
  else if (!st.expected_on) parts.push("還沒定預定日");
  else {
    parts.push(`預定 ${mdwText(st.expected_on)}`);
    const n = daysBetween(today, st.expected_on);
    parts.push(n > 0 ? `還有 ${n} 天` : n === 0 ? "就是今天" : `晚了 ${-n} 天`);
  }
  return parts.join("・");
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
