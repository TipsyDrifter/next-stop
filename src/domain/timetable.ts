/**
 * 時刻表線・純函式層（車次①a 契約 §4；甲席 Stage 0 介面先行）。
 *
 * 鐵則：**零 import**、只用可剝除語法（不用 enum／namespace／參數屬性）——
 * `scripts/tests/timetable-logic.test.ts` 以 node 直接載入本檔跑單元測試。
 * 時間一律**毫秒數**；ISO 只在 repository 邊界轉換（`msOf`／`isoOf`）。
 * lib 目標 ES2020：不用 ES2022＋ 的陣列／字串／物件新方法（契約 §1-12 列的四個）。
 *
 * 內容：
 *   §4.1 型別與常數（含起手分類 `STARTER_CATEGORIES`，id 為 uuid v5 字面值）
 *   §4.2 小工具（格式化、顏色槽、分類整理、寫入摘要）
 *   §4.3 寫入計畫 `plan*`（每支都不改輸入、回新的 `WritePlan`；`now` 一律由呼叫端給）
 *   §4.4 `planReconcile`（兩台同步後的整理；決定性、冪等）
 *   §4.5 顯示用（軸的分段、合計、列高）
 *
 * 車次①b（①b①c 契約 §3.1、§4；只加不改）：門檻 `thresholdOf`／記號 `runMarker`、`planSetEstimate`、
 * `planSplitMulti`、`planMerge`、①c 預留的 `planDepartPending`／`planArriveBefore`、`latestGap`／`defaultCuts`／`addCut`。
 *
 * 車次②（② 契約 §3.1、§4.2；只加不改）：連結 `BlockLink`／`NO_LINK`、`SpanPatch.link`、`SpanInsert.link`／`keepLink`、
 * `planSetLink`；`planDepart`／`planFill`／`planEdit` 收連結；切開沿用連結；`thresholdOf` 第四參數（任務的預計時間）。
 * 連結相關的讀取與合計在 `timetableLink.ts`。
 */

export const MIN = 60_000;

/* ───────────────────────── §4.1 型別與常數 ───────────────────────── */

export interface TimeCategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  glyph: string | null;
  color_idx: number;
  position: number;
  default_min: number | null;
  archived_at: string | null;
  account_id: string | null;
  device_id: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
}

export interface TimeBlockRow {
  id: string;
  category_id: string;
  started_at: string;
  ended_at: string | null;
  estimate_min: number | null;
  node_id: string | null;
  route_id: string | null;
  /** 0|1（SQLite 回整數） */
  long_run_ack: number;
  account_id: string | null;
  device_id: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
}

/** ③ 效能（沙盒回報 F1②）：統計／週視圖／目標只要的 8 欄（`listBlocksSlim` 回這個；`toStatsSpan` 吃它，`TimeBlockRow` 也相容） */
export type TimeBlockSlim = Pick<
  TimeBlockRow,
  "id" | "category_id" | "started_at" | "ended_at" | "estimate_min" | "node_id" | "route_id" | "long_run_ack"
>;

/** ③：時數目標（`time_goals` 一列；欄位語義見 ③ 契約 0-5） */
export interface TimeGoalRow {
  id: string;
  name: string;
  /** JSON：`{"categories":["<id>",…]}` */
  scope: string;
  /** 'day' | 'week' | 'month'（週期重複）| 'since' | 'until' | 'range' */
  period: string;
  target_min: number;
  /** 'atLeast' | 'atMost' */
  direction: string;
  /** 'YYYY-MM-DD'（日界線日）；since／until／range 的起點（含），週期重複＝NULL */
  start_on: string | null;
  /** 'YYYY-MM-DD'（日界線日）；until／range 的終點（含當天整天），其餘 NULL */
  end_on: string | null;
  position: number;
  archived_at: string | null;
  account_id: string | null;
  device_id: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
}

/** 純函式用的時間塊 */
export interface Span {
  id: string;
  categoryId: string;
  start: number;
  end: number | null;
  ack: boolean;
}

/** 整理用：多一個寫入鍵（`reconcileWriteKey` 組；＝`<started_at 那一格的寫入時刻>|<updated_at>`，D-時-26） */
export interface KeyedSpan extends Span {
  writeKey: string;
}

/** ②：一塊的連結（② 契約 0-2）：兩欄至多一欄非 null；兩欄都 null＝沒連 */
export interface BlockLink {
  nodeId: string | null;
  routeId: string | null;
}
/** 沒連（共用物件，**不准改它**） */
export const NO_LINK: BlockLink = { nodeId: null, routeId: null };

const sameLink = (a: BlockLink, b: BlockLink): boolean => a.nodeId === b.nodeId && a.routeId === b.routeId;

export interface SpanPatch {
  id: string;
  start?: number;
  end?: number | null;
  categoryId?: string;
  ack?: boolean;
  /** ①b：這一班的預估（分）；null＝清掉；undefined＝不動 */
  estimateMin?: number | null;
  /** ②：改連結；undefined＝不動。applyPlan 寫的時候兩欄成對（② 契約 0-2） */
  link?: BlockLink;
}

export interface SpanInsert {
  /** null＝repository 給隨機 uuid；非 null＝確定性 id 的種子（整理切出來的片段：`${原 id}|${片段開始 ISO}`） */
  key: string | null;
  /** 從哪一塊切出來的（inherit 時抄它的 estimate_min／node_id／route_id） */
  fromId: string | null;
  inherit: boolean;
  categoryId: string;
  start: number;
  end: number | null;
  ack: boolean;
  /** ①b：明寫預估；給了就**蓋過** inherit 抄來的 estimate_min（undefined＝照 inherit 規則） */
  estimateMin?: number | null;
  /** ①c 預留：確定性 id（佇列発車，①b①c 契約 0-6）；給了就優先於 key／uuid */
  fixedId?: string;
  /**
   * ②：明寫連結；給了就蓋過抄來的。insert 的連結規則（sqlite 與 memory 同，② 契約 §3.1）：
   * `link !== undefined ? link : ((inherit || keepLink) && fromId ? fromId 那一列的 (node_id, route_id) : NO_LINK)`
   */
  link?: BlockLink;
  /** ②：照 fromId 那一列抄連結（不管 inherit）；切開用（② 契約 0-3） */
  keepLink?: boolean;
}

/**
 * ②：insert 這一列最後寫進去的連結（② 契約 §3.1；sqlite 與 memory 的 applyPlan 共用，不各寫一份）：
 * 明寫 `link` 優先；否則 `inherit` 或 `keepLink`、而且 `src`（fromId 那一列）在 ⇒ 照抄它的兩欄；其餘 NO_LINK。
 * 回傳的物件不會是 `src` 本身（抄成新物件）；沒連時回共用的 NO_LINK（呼叫端不准改它）。
 */
export function insertLinkOf(
  i: Pick<SpanInsert, "link" | "inherit" | "keepLink">,
  src: { node_id: string | null; route_id: string | null } | undefined,
): BlockLink {
  if (i.link !== undefined) return i.link;
  if ((i.inherit || i.keepLink) && src) return { nodeId: src.node_id, routeId: src.route_id };
  return NO_LINK;
}

export interface WritePlan {
  patches: SpanPatch[];
  inserts: SpanInsert[];
  deletes: string[];
}

export interface CoverSummary {
  removed: number;
  shortened: number;
  splitCount: number;
}

export type LongRunChoice = "gap" | "cat" | "keep";

export interface StarterCategory {
  key: string;
  id: string;
  parentId: string | null;
  name: string;
  glyph: string | null;
  colorIdx: number;
  position: number;
  defaultMin: number | null;
}

/** uuid v5(DNS, "timetable.nextstop.shitetsu.app")；起手分類與整理片段的 id 都從它算（契約 §3.3） */
export const TIMETABLE_ID_NAMESPACE = "b419dddf-aeed-5780-b7bf-a8b2c9ed0ad9";

const G_DUTY = "da1b233b-ba91-5269-b263-65101d1bdf43";
const G_LIFE = "f6a85065-28d7-5beb-8d12-65ee9d87b2c4";
const G_LEISURE = "fc3692f1-857d-51b4-8c99-b0018333bc60";

/** 契約 §3.3 表格逐列（順序：三個組，再依組的子分類）；id＝uuid v5(TIMETABLE_ID_NAMESPACE, "timetable:<key>") 的字面值 */
export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  { key: "duty", id: G_DUTY, parentId: null, name: "本務", glyph: null, colorIdx: 1, position: 0, defaultMin: null },
  { key: "life", id: G_LIFE, parentId: null, name: "生活", glyph: null, colorIdx: 1, position: 1, defaultMin: null },
  { key: "leisure", id: G_LEISURE, parentId: null, name: "休閒", glyph: null, colorIdx: 1, position: 2, defaultMin: null },
  { key: "class", id: "593bcf09-ee64-5819-9af5-e069c89b3841", parentId: G_DUTY, name: "上課", glyph: "課", colorIdx: 1, position: 0, defaultMin: 180 },
  { key: "create", id: "66a4fdf6-bc28-5cd4-8455-3faffd56f118", parentId: G_DUTY, name: "創作", glyph: "創", colorIdx: 5, position: 1, defaultMin: 240 },
  { key: "study", id: "95280e69-3759-5d75-ac4f-b86547b913aa", parentId: G_DUTY, name: "學習", glyph: "讀", colorIdx: 6, position: 2, defaultMin: 180 },
  { key: "hobby", id: "172c6c54-a53d-5988-bdbc-02d474b33088", parentId: G_DUTY, name: "興趣", glyph: "趣", colorIdx: 1, position: 3, defaultMin: 180 },
  { key: "work", id: "9ab43381-2ee9-50fd-95dc-43239ad5cfbf", parentId: G_DUTY, name: "工作", glyph: "務", colorIdx: 5, position: 4, defaultMin: 240 },
  { key: "sleep", id: "0f593f92-af5b-5d81-82ba-9363a9941dab", parentId: G_LIFE, name: "睡覺", glyph: "眠", colorIdx: 8, position: 0, defaultMin: 600 },
  { key: "meal", id: "163b6f28-5e42-5666-8f05-bd369e37e725", parentId: G_LIFE, name: "吃飯", glyph: "食", colorIdx: 4, position: 1, defaultMin: 120 },
  { key: "wash", id: "1f3bbc35-3ea7-56ed-9653-f62060742a28", parentId: G_LIFE, name: "洗漱", glyph: "浴", colorIdx: 3, position: 2, defaultMin: 60 },
  { key: "chore", id: "cb9607ec-fb52-5deb-bc9e-7e5c7cbd6980", parentId: G_LIFE, name: "家務", glyph: "家", colorIdx: 4, position: 3, defaultMin: 90 },
  { key: "move", id: "88f77916-cb67-5128-82a2-7b95a49332e6", parentId: G_LIFE, name: "路上", glyph: "移", colorIdx: 8, position: 4, defaultMin: 150 },
  { key: "sport", id: "556a9c6a-de21-5b7d-9a3e-cc6312e7eef8", parentId: G_LIFE, name: "運動", glyph: "動", colorIdx: 3, position: 5, defaultMin: 120 },
  { key: "shop", id: "7d05ebf7-a358-536f-b5e3-9d842d19658d", parentId: G_LIFE, name: "購物", glyph: "購", colorIdx: 4, position: 6, defaultMin: 90 },
  { key: "play", id: "98001bf4-348e-508e-99ea-6df76c781347", parentId: G_LEISURE, name: "娛樂", glyph: "娛", colorIdx: 2, position: 0, defaultMin: 240 },
  { key: "social", id: "ad20a08d-c66a-5999-89fc-4324701550ee", parentId: G_LEISURE, name: "社交", glyph: "交", colorIdx: 7, position: 1, defaultMin: 300 },
  { key: "travel", id: "6e22561a-d964-58eb-8747-e6aa9d684d64", parentId: G_LEISURE, name: "旅遊", glyph: "旅", colorIdx: 2, position: 2, defaultMin: 480 },
  { key: "rest", id: "88f7523b-61d2-5664-b039-8c32a86162c3", parentId: G_LEISURE, name: "休息", glyph: "休", colorIdx: 7, position: 3, defaultMin: 90 },
];

/** 軸的一項 */
export type AxisItem =
  | {
      kind: "block";
      span: Span;
      from: number;
      to: number;
      running: boolean;
      contFromPrev: boolean;
      contToNext: boolean;
      zero: boolean;
    }
  | { kind: "gap"; from: number; to: number };

/** 給旅客筆記線的唯讀查詢（契約 §6.3-1） */
export interface DayBlockSegment {
  blockId: string;
  categoryId: string;
  categoryName: string;
  glyph: string | null;
  colorIdx: number;
  nodeId: string | null;
  routeId: string | null;
  /** ISO，已夾在日界線日之內；運行中＝到現在 */
  from: string;
  to: string;
  running: boolean;
  contFromPrev: boolean;
  contToNext: boolean;
}

/* ───────────────────────── §4.2 小工具 ───────────────────────── */

const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));

export function msOf(iso: string): number {
  return Date.parse(iso);
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function toSpan(r: TimeBlockRow): Span {
  return {
    id: r.id,
    categoryId: r.category_id,
    start: msOf(r.started_at),
    end: r.ended_at === null ? null : msOf(r.ended_at),
    ack: r.long_run_ack === 1,
  };
}

/** 負時長當 0（Plan 技術底線 4） */
export function durOf(s: Span, now: number): number {
  return Math.max(0, (s.end ?? now) - s.start);
}

/** 運行中（end===null）之中 start 最大者；同 start 取 id 字典序較大者 */
export function currentRunning(spans: readonly Span[]): Span | null {
  let best: Span | null = null;
  for (const s of spans) {
    if (s.end !== null) continue;
    if (!best || s.start > best.start || (s.start === best.start && s.id > best.id)) best = s;
  }
  return best;
}

/** 越界夾回 1–8（契約 0-9：DDL 不加 CHECK，顯示端夾） */
export function colorSlot(idx: number): number {
  const n = Math.round(Number.isFinite(idx) ? idx : 1);
  return ((((n - 1) % 8) + 8) % 8) + 1;
}

function byPositionThenCreated(a: TimeCategoryRow, b: TimeCategoryRow): number {
  return a.position - b.position || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const isLive = (c: TimeCategoryRow): boolean => c.deleted_at === null && c.archived_at === null;

/** 未封存、未刪除的子分類（依 parent 的 position，再依自己的 position） */
export function leafCategories(cats: readonly TimeCategoryRow[]): TimeCategoryRow[] {
  const out: TimeCategoryRow[] = [];
  for (const g of groupedCategories(cats)) out.push(...g.children);
  return out;
}

/** `[{ group, children }]` 依 position；頂層沒有子分類的組也列；已封存／已刪除的不列 */
export function groupedCategories(
  cats: readonly TimeCategoryRow[],
): { group: TimeCategoryRow; children: TimeCategoryRow[] }[] {
  const groups = cats.filter((c) => c.parent_id === null && isLive(c)).sort(byPositionThenCreated);
  return groups.map((group) => ({
    group,
    children: cats.filter((c) => c.parent_id === group.id && isLive(c)).sort(byPositionThenCreated),
  }));
}

/** 分鐘；null＝不問 */
export function longRunThreshold(
  cat: { default_min: number | null } | null,
  globalMaxMin: number,
): number | null {
  const own = cat?.default_min ?? null;
  if (own !== null && own > 0) return own;
  return globalMaxMin > 0 ? globalMaxMin : null;
}

/** 分鐘取整；`45m`／`2h`／`1h20m`（＝原型 fmtDur）；0＝`0m` */
export function fmtDur(ms: number): string {
  const min = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return m + "m";
  if (m === 0) return h + "h";
  return h + "h" + pad2(m) + "m";
}

/** `0:42:10`（＝原型 fmtHMS） */
export function fmtHMS(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(sec / 3600) + ":" + pad2(Math.floor((sec % 3600) / 60)) + ":" + pad2(sec % 60);
}

/** 本地 `HH:MM`（24 小時制、補零） */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function localDateKey(d: Date): string {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/**
 * 該日界線日所在週的第一天（`YYYY-MM-DD`；本地日期運算，不經 Date.parse）。
 * ③：`weekStart`＝全 App 的「每週從星期幾開始」（`uiStore.weekStart`，JS getDay() 的值：0＝週日、1＝週一）；預設 1＝週一＝①②行為。
 */
export function weekStartKey(dateKey: string, weekStart: 0 | 1 = 1): string {
  const parts = dateKey.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const date = new Date(y, m - 1, d);
  const back = weekStart === 0 ? date.getDay() : (date.getDay() + 6) % 7; // 週起點＝0 … 6
  return localDateKey(new Date(y, m - 1, d - back));
}

/**
 * removed＝deletes 數；shortened＝patches 中改了 start 或 end 的列數（不含動作的主角 `exceptId`）；
 * splitCount＝`inherit` 的 inserts 數
 */
export function summarizeCover(plan: WritePlan, exceptId: string | null = null): CoverSummary {
  let shortened = 0;
  for (const p of plan.patches) {
    if (p.id === exceptId) continue;
    if (p.start !== undefined || p.end !== undefined) shortened++;
  }
  return {
    removed: plan.deletes.length,
    shortened,
    splitCount: plan.inserts.filter((i) => i.inherit).length,
  };
}

/* ───────────────────────── §4.3 寫入計畫 ───────────────────────── */

const emptyPlan = (): WritePlan => ({ patches: [], inserts: [], deletes: [] });

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

const isZero = (s: Span): boolean => s.end !== null && s.end <= s.start;

function findSpan(spans: readonly Span[], id: string): Span {
  const s = spans.find((x) => x.id === id);
  if (!s) throw new RangeError("找不到這一塊");
  return s;
}

/** 同一個 id 的多筆 patch 合成一筆（後者覆蓋前者的同名欄）；inserts／deletes 依序串接 */
export function mergePlans(...plans: WritePlan[]): WritePlan {
  const order: string[] = [];
  const byId = new Map<string, SpanPatch>();
  const inserts: SpanInsert[] = [];
  const deletes: string[] = [];
  for (const p of plans) {
    for (const patch of p.patches) {
      const prev = byId.get(patch.id);
      if (prev) {
        byId.set(patch.id, { ...prev, ...patch });
      } else {
        order.push(patch.id);
        byId.set(patch.id, { ...patch });
      }
    }
    inserts.push(...p.inserts);
    for (const d of p.deletes) if (!deletes.includes(d)) deletes.push(d);
  }
  return { patches: order.map((id) => byId.get(id)!), inserts, deletes };
}

/**
 * 共通語義「後者蓋前者」：`iv` 蓋到的既有塊照規則切短、切開或收掉。
 * 跳過 `exceptId`、跳過零長度的塊。運行中（end=null）＝到 +∞。
 */
export function planCover(
  spans: readonly Span[],
  iv: { start: number; end: number | null },
  exceptId: string | null,
): WritePlan {
  const plan = emptyPlan();
  const ivEnd = iv.end ?? Infinity;
  for (const s of spans) {
    if (s.id === exceptId) continue;
    if (isZero(s)) continue;
    const sEnd = s.end ?? Infinity;
    if (sEnd <= iv.start || s.start >= ivEnd) continue;
    const left = s.start < iv.start;
    const right = sEnd > ivEnd;
    if (!left && !right) {
      plan.deletes.push(s.id);
    } else if (left && !right) {
      plan.patches.push({ id: s.id, end: iv.start });
    } else if (!left && right) {
      plan.patches.push({ id: s.id, start: ivEnd });
    } else {
      plan.patches.push({ id: s.id, end: iv.start });
      plan.inserts.push({
        key: null,
        fromId: s.id,
        inherit: true,
        categoryId: s.categoryId,
        start: ivEnd,
        end: s.end,
        ack: s.ack,
      });
    }
  }
  return plan;
}

/**
 * 發車／換車：`[at, 運行中)` 蓋掉既有紀錄；上一班自動到站＝被 planCover 切短（契約 0-11）。
 * ①b：新一班 insert 多帶 `estimateMin`（不給＝null）。新一班一定是 inserts 的**最後一筆**（planDepartPending 倚賴）。
 */
export function planDepart(
  spans: readonly Span[],
  input: { categoryId: string; at: number; now: number; estimateMin?: number | null; link?: BlockLink | null },
): WritePlan {
  const at = Math.min(input.at, input.now);
  const plan = planCover(spans, { start: at, end: null }, null);
  plan.inserts.push({
    key: null,
    fromId: null,
    inherit: false,
    categoryId: input.categoryId,
    start: at,
    end: null,
    ack: false,
    estimateMin: input.estimateMin ?? null,
    link: input.link ?? NO_LINK, // ②：新一班的連結（不給＝沒連）
  });
  return plan;
}

/** 到站：每個運行中的塊 `end = clamp(at ?? now, 自己的 start, now)` */
export function planArrive(spans: readonly Span[], input: { at?: number | null; now: number }): WritePlan {
  const plan = emptyPlan();
  const want = input.at ?? input.now;
  for (const s of spans) {
    if (s.end !== null) continue;
    plan.patches.push({ id: s.id, end: clamp(want, s.start, input.now) });
  }
  return plan;
}

/** 沒有任何運行中的塊，且沒有 `start >= 該塊 end` 的塊 */
export function canUndoArrive(spans: readonly Span[], id: string): boolean {
  const s = spans.find((x) => x.id === id);
  if (!s || s.end === null) return false;
  for (const o of spans) {
    if (o.id === id) continue;
    if (o.end === null) return false;
    if (o.start >= s.end) return false;
  }
  return true;
}

/** 改運行中那班的出發時間（往前挪會蓋掉前面的紀錄） */
export function planRestart(spans: readonly Span[], input: { id: string; at: number; now: number }): WritePlan {
  const s = findSpan(spans, input.id);
  if (s.end !== null) throw new RangeError("只能改運行中那一班的出發時間");
  const at = Math.min(input.at, input.now - MIN);
  const plan = planCover(spans, { start: at, end: null }, s.id);
  plan.patches.push({ id: s.id, start: at });
  return plan;
}

function assertRange(start: number, end: number, now: number): void {
  if (!(start < end)) throw new RangeError("起訖不對");
  if (end > now) throw new RangeError("不能補記未來的時間");
}

/** 補記一塊（必須 start < end ≤ now） */
export function planFill(
  spans: readonly Span[],
  input: { categoryId: string; start: number; end: number; now: number; link?: BlockLink | null },
): WritePlan {
  assertRange(input.start, input.end, input.now);
  const plan = planCover(spans, { start: input.start, end: input.end }, null);
  plan.inserts.push({
    key: null,
    fromId: null,
    inherit: false,
    categoryId: input.categoryId,
    start: input.start,
    end: input.end,
    ack: false,
    link: input.link ?? NO_LINK, // ②
  });
  return plan;
}

/**
 * 改一塊已結束的塊的分類與起訖；運行中的塊丟 RangeError。
 * patch **只帶真的變了的欄**（逐欄 LWW：沒改的欄不能重新戳成最新，否則會蓋掉另一台對同一塊別的欄的改動）；
 * 什麼都沒變就不出 patch（蓋到的仍照 planCover 處理）。
 *
 * ②：`link` undefined＝不動連結；給了而且跟 `curLink`（原塊的連結，Span 不帶，由 repository 從列上給）不同 ⇒ patch 帶 `link`。
 * `curLink` 沒給＝當作「不同」（寧可多寫一次相同的值，applyPlan 會再比一次現值；② 契約 §4.2-3）。
 */
export function planEdit(
  spans: readonly Span[],
  input: {
    id: string;
    categoryId: string;
    start: number;
    end: number;
    now: number;
    link?: BlockLink | null;
    curLink?: BlockLink;
  },
): WritePlan {
  const s = findSpan(spans, input.id);
  if (s.end === null) throw new RangeError("運行中的這一班，用運行列換車或到着");
  assertRange(input.start, input.end, input.now);
  const plan = planCover(spans, { start: input.start, end: input.end }, s.id);
  const patch: SpanPatch = { id: s.id };
  let changed = false;
  if (input.start !== s.start) {
    patch.start = input.start;
    changed = true;
  }
  if (input.end !== s.end) {
    patch.end = input.end;
    changed = true;
  }
  if (input.categoryId !== s.categoryId) {
    patch.categoryId = input.categoryId;
    patch.ack = false;
    changed = true;
  }
  if (input.link !== undefined) {
    const want = input.link ?? NO_LINK;
    if (input.curLink === undefined || !sameLink(want, input.curLink)) {
      patch.link = { nodeId: want.nodeId, routeId: want.routeId };
      changed = true;
    }
  }
  if (changed) plan.patches.push(patch);
  return plan;
}

/**
 * ②：改一塊的連結（運行中、已結束都可以）。`link` null＝取消連結（當 NO_LINK）；跟 `curLink` 一樣 ⇒ 空 plan。
 * `curLink`＝這一塊目前的連結（Span 不帶，由 repository 從列上給；必填）。
 */
export function planSetLink(
  spans: readonly Span[],
  input: { id: string; link: BlockLink | null; curLink: BlockLink },
): WritePlan {
  const s = findSpan(spans, input.id);
  const want = input.link ?? NO_LINK;
  if (sameLink(want, input.curLink)) return emptyPlan();
  return { patches: [{ id: s.id, link: { nodeId: want.nodeId, routeId: want.routeId } }], inserts: [], deletes: [] };
}

/** 單點切開；at 不在 (開始, 結束或現在) 之內回 null。運行中的塊切開後**後段**仍運行中。②：新段沿用原塊的連結（keepLink） */
export function planSplit(
  spans: readonly Span[],
  input: { id: string; at: number; categoryId2: string; now: number },
): WritePlan | null {
  const s = findSpan(spans, input.id);
  const e = s.end ?? input.now;
  if (input.at <= s.start || input.at >= e) return null;
  const plan = emptyPlan();
  plan.patches.push({ id: s.id, end: input.at });
  plan.inserts.push({
    key: null,
    fromId: s.id,
    inherit: input.categoryId2 === s.categoryId,
    categoryId: input.categoryId2,
    start: input.at,
    end: s.end,
    ack: false,
    keepLink: true, // ②：不論分類換不換，新段沿用原塊的連結（② 契約 0-3）
  });
  return plan;
}

export function isLongRun(s: Span, thresholdMin: number | null, now: number): boolean {
  return !s.ack && thresholdMin !== null && durOf(s, now) > thresholdMin * MIN;
}

/* ── ①b：門檻與記號（①b①c 契約 §4.2） ── */

export type ThresholdSource = "estimate" | "task" | "category" | "global";
export interface Threshold {
  min: number;
  source: ThresholdSource;
}

/**
 * 〈開工決定〉二-4 的門檻順序：這一班的預估 → 分類預設長度 → 全域保險上限；都沒有（全域 0）回 null。
 * `longRunThreshold`（不看預估的 ①a 舊版）保留不動。
 * ②（② 契約 0-7）：第四參數＝這一塊連到的任務的預計時間（選填；不傳＝跟以前一樣），排在預估之後、分類之前。
 */
export function thresholdOf(
  estimateMin: number | null,
  cat: { default_min: number | null } | null,
  globalMaxMin: number,
  taskEstimateMin: number | null = null,
): Threshold | null {
  if (estimateMin !== null && estimateMin > 0) return { min: estimateMin, source: "estimate" };
  if (taskEstimateMin !== null && taskEstimateMin > 0) return { min: taskEstimateMin, source: "task" };
  const own = cat?.default_min ?? null;
  if (own !== null && own > 0) return { min: own, source: "category" };
  return globalMaxMin > 0 ? { min: globalMaxMin, source: "global" } : null;
}

export type RunMarker =
  | { kind: "none" }
  /** 門檻來自預估或任務的預計時間（②）：「誤點 +X」 */
  | { kind: "late"; overMs: number; pending: boolean }
  /** 門檻來自分類或全域：「長時間運行」 */
  | { kind: "long"; pending: boolean };

/**
 * F3：只在**真的還超過門檻**時畫記號；pending＝!ack（＝待確認）。
 * 「待確認」＝`kind !== "none" && pending`，與 `isLongRun(s, th.min, now)` 等價。
 */
export function runMarker(s: Span, th: Threshold | null, now: number): RunMarker {
  if (th === null) return { kind: "none" };
  const dur = durOf(s, now);
  if (dur <= th.min * MIN) return { kind: "none" };
  if (th.source === "estimate" || th.source === "task") return { kind: "late", overMs: dur - th.min * MIN, pending: !s.ack };
  return { kind: "long", pending: !s.ack };
}

/** 「其實到幾點」的預設建議值：開始＋門檻，夾在 [開始+1 分, 上限−1 分]（＝原型） */
export function longRunDefaultEnd(s: Span, thresholdMin: number, now: number): number {
  const cap = s.end ?? now;
  return clamp(s.start + thresholdMin * MIN, s.start + MIN, cap - MIN);
}

/** 「其實到幾點」三選一 */
export function planResolveLongRun(
  spans: readonly Span[],
  input: { id: string; end: number; choice: LongRunChoice; categoryId2?: string | null; now: number },
): WritePlan {
  const s = findSpan(spans, input.id);
  const cap = s.end ?? input.now;
  const end = clamp(input.end, s.start + MIN, cap - MIN);
  const ackPlan: WritePlan = { patches: [{ id: s.id, ack: true }], inserts: [], deletes: [] };
  if (input.choice === "gap") {
    return { patches: [{ id: s.id, end, ack: true }], inserts: [], deletes: [] };
  }
  if (input.choice === "cat") {
    if (!input.categoryId2) throw new RangeError("選一個分類");
    const split = planSplit(spans, { id: s.id, at: end, categoryId2: input.categoryId2, now: input.now });
    // ②：「其實在做別的」的那段時間不帶連結（② 契約 0-3）
    if (split) split.inserts = split.inserts.map((ins) => ({ ...ins, link: NO_LINK }));
    return mergePlans(split ?? emptyPlan(), ackPlan);
  }
  return ackPlan;
}

/* ── ①b：預估、多切點、合併（①b①c 契約 §4.3、§4.4） ── */

/** 改運行中那一班的預估：null＝清掉；整數 1–1440 分 */
export function planSetEstimate(spans: readonly Span[], input: { id: string; estimateMin: number | null }): WritePlan {
  const s = findSpan(spans, input.id);
  if (s.end !== null) throw new RangeError("只能改運行中那一班的預估");
  const v = input.estimateMin;
  if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 1440)) throw new RangeError("預估不對");
  return { patches: [{ id: s.id, estimateMin: v }], inserts: [], deletes: [] };
}

/**
 * 多切點：`cuts` 嚴格遞增、都在 `(開始, 結束或現在)` 之內；`categoryIds` 每段一個（＝cuts.length + 1）；每段 ≥ 1 分。
 * 第一段留原 id（分類換了才帶 categoryId＋ack:false）；其餘各段 insert（同原分類 ⇒ inherit）。運行中的塊切開後**最後一段**仍運行中，
 * 而且**沿用原本那班的 ack**（「長時間運行・別問了」切完不會又被問）；已結束的塊切出來的新段一律 ack:false。
 *
 * 預估（契約 0-14）：已結束的塊 ⇒ 新段一律 `estimateMin: null`（預估留在原 id）；運行中的塊 ⇒ 預估搬到最後一段、
 * 其餘新段 null、第一段 patch 多帶 `estimateMin: null`（原值為 null 時不帶）。
 * `estimateMin`＝這一塊目前的預估（Span 不帶預估欄，由 repository 從列上給；不給＝當作 null）。
 */
export function planSplitMulti(
  spans: readonly Span[],
  input: { id: string; cuts: readonly number[]; categoryIds: readonly string[]; now: number; estimateMin?: number | null },
): WritePlan {
  const s = findSpan(spans, input.id);
  const e = s.end ?? input.now;
  const cuts = input.cuts;
  if (!cuts.length) throw new RangeError("切點要在這一塊的開頭與尾端之間");
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (!Number.isFinite(c) || c <= s.start || c >= e || (i > 0 && c <= cuts[i - 1])) {
      throw new RangeError("切點要在這一塊的開頭與尾端之間");
    }
  }
  if (input.categoryIds.length !== cuts.length + 1) throw new RangeError("每一段都要有分類");
  const bounds = [s.start, ...cuts, e];
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (bounds[i + 1] - bounds[i] < MIN) throw new RangeError("每段至少 1 分");
  }
  const running = s.end === null;
  const est = input.estimateMin ?? null;
  const plan = emptyPlan();
  const first: SpanPatch = { id: s.id, end: cuts[0] };
  if (input.categoryIds[0] !== s.categoryId) {
    first.categoryId = input.categoryIds[0];
    first.ack = false;
  }
  if (running && est !== null) first.estimateMin = null;
  plan.patches.push(first);
  for (let k = 1; k <= cuts.length; k++) {
    const last = k === cuts.length;
    plan.inserts.push({
      key: null,
      fromId: s.id,
      inherit: input.categoryIds[k] === s.categoryId,
      categoryId: input.categoryIds[k],
      start: cuts[k - 1],
      end: last ? s.end : cuts[k],
      // 運行中的塊：仍在跑的最後一段沿用原本那班的 ack（主人已選「別問了」的，切完不再被問）；其餘新段 false
      ack: running && last ? s.ack : false,
      estimateMin: running && last ? est : null,
      keepLink: true, // ②：每一段都沿用原塊的連結（② 契約 0-3）
    });
  }
  return plan;
}

export interface MergePreview {
  /** 合併後留下的那一列（併進鄰居＝鄰居的 id；鄰居是未記錄＝自己的 id） */
  keepId: string;
  categoryId: string;
  start: number;
  /** null＝運行中（併進的是運行中那班） */
  end: number | null;
  /** 鄰居是未記錄時＝蓋掉的空白長度（毫秒）；鄰居是塊＝0 */
  gapMs: number;
}

export interface MergeOutcome {
  plan: WritePlan;
  preview: MergePreview;
}

/**
 * 合併（〈開工決定〉二-2；①b①c 契約 §4.4）。`s` 必須已結束（零長度的也可以，它就是被吞掉）。
 * 鄰居只看非零長度、不是 s 的塊：prev＝`end <= s.start` 之中 end 最大（同值取 start 大、再 id 大）；
 * next＝`start >= s.end` 之中 start 最小（含運行中；同值取 id 小）。
 *   - 鄰居與 s 之間的空白 < 1 分（畫面上沒有「未記錄」那一列）⇒ **併進鄰居**：鄰居延長蓋過 s（s 刪除），分類／ack 留鄰居的。
 *   - 否則鄰居是「未記錄」⇒ s 自己延長到空白的另一端。空白的另一端＝鄰居那一端與 `bound`（畫面上那一側的界線）
 *     取較近者；next 側再夾 now。界線上已經沒有 ≥ 1 分的空白 ⇒ null。
 */
export function planMerge(
  spans: readonly Span[],
  input: { id: string; dir: "prev" | "next"; bound: number; now: number },
): MergeOutcome | null {
  const s = findSpan(spans, input.id);
  if (s.end === null) throw new RangeError("運行中的這一班，用運行列換車或到着");
  const sEnd = s.end;
  const others = spans.filter((x) => x.id !== s.id && !isZero(x));
  const swallow: WritePlan = { patches: [], inserts: [], deletes: [s.id] }; // planCover 跳過零長度 ⇒ s 明寫刪除

  if (input.dir === "prev") {
    let P: Span | null = null;
    for (const x of others) {
      if (x.end === null || x.end > s.start) continue;
      if (!P || x.end > P.end! || (x.end === P.end && (x.start > P.start || (x.start === P.start && x.id > P.id)))) P = x;
    }
    if (P && s.start - P.end! < MIN) {
      const plan = mergePlans(planCover(spans, { start: P.end!, end: sEnd }, P.id), { patches: [{ id: P.id, end: sEnd }], inserts: [], deletes: [] }, swallow);
      return { plan, preview: { keepId: P.id, categoryId: P.categoryId, start: P.start, end: sEnd, gapMs: 0 } };
    }
    const gapStart = P ? Math.max(P.end!, input.bound) : input.bound;
    if (s.start - gapStart < MIN) return null;
    return {
      plan: { patches: [{ id: s.id, start: gapStart }], inserts: [], deletes: [] },
      preview: { keepId: s.id, categoryId: s.categoryId, start: gapStart, end: sEnd, gapMs: s.start - gapStart },
    };
  }

  let N: Span | null = null;
  for (const x of others) {
    if (x.start < sEnd) continue;
    if (!N || x.start < N.start || (x.start === N.start && x.id < N.id)) N = x;
  }
  if (N && N.start - sEnd < MIN) {
    const plan = mergePlans(planCover(spans, { start: s.start, end: N.start }, N.id), { patches: [{ id: N.id, start: s.start }], inserts: [], deletes: [] }, swallow);
    return { plan, preview: { keepId: N.id, categoryId: N.categoryId, start: s.start, end: N.end, gapMs: 0 } };
  }
  const gapEnd = Math.min(N ? N.start : Infinity, input.bound, input.now);
  if (gapEnd - sEnd < MIN) return null;
  return {
    plan: { patches: [{ id: s.id, end: gapEnd }], inserts: [], deletes: [] },
    preview: { keepId: s.id, categoryId: s.categoryId, start: s.start, end: gapEnd, gapMs: gapEnd - sEnd },
  };
}

/* ── ①c 預留（甲寫、丙用；①b①c 契約 §4.5） ── */

/**
 * 佇列発車。`untilNext=false` ⇒ 等同 planDepart（新一班帶 fixedId）；
 * `true`（契約 0-5 乙案「蓋到下一班為止」）⇒ 落庫當下若有非零長度的塊開始於 at 之後：新塊只寫成 `[at, 下一班的開始)`
 * （已結束、不運行）；下一班開始距 at 不足 1 分 ⇒ null（被後來的紀錄整段蓋住、不寫）。沒有更晚的塊就照 planDepart。
 */
export function planDepartPending(
  spans: readonly Span[],
  input: { categoryId: string; at: number; now: number; fixedId: string; untilNext: boolean },
): WritePlan | null {
  const at = Math.min(input.at, input.now);
  if (input.untilNext) {
    let nx = Infinity;
    for (const x of spans) {
      if (isZero(x)) continue;
      if (x.start > at && x.start < nx) nx = x.start;
    }
    if (nx !== Infinity) {
      if (nx - at < MIN) return null;
      const plan = planCover(spans, { start: at, end: nx }, null);
      plan.inserts.push({
        key: null,
        fromId: null,
        inherit: false,
        categoryId: input.categoryId,
        start: at,
        end: nx,
        ack: false,
        estimateMin: null,
        fixedId: input.fixedId,
      });
      return plan;
    }
  }
  const plan = planDepart(spans, { categoryId: input.categoryId, at, now: input.now });
  plan.inserts[plan.inserts.length - 1].fixedId = input.fixedId;
  return plan;
}

/** 佇列到着：只結束 `start < at` 的運行中塊（end＝at 夾在 [自己的開始, now]）；其餘運行中不動 */
export function planArriveBefore(spans: readonly Span[], input: { at: number; now: number }): WritePlan {
  const plan = emptyPlan();
  for (const s of spans) {
    if (s.end !== null || !(s.start < input.at)) continue;
    plan.patches.push({ id: s.id, end: clamp(input.at, s.start, input.now) });
  }
  return plan;
}

/* ───────────────────────── §4.4 整理 ───────────────────────── */

interface Iv {
  start: number;
  end: number; // Infinity＝運行中
}

/** 把 `[a.start, a.end)` 減掉聯集 `U`（U 內部彼此不相交、依 start 排好） */
function subtract(a: Iv, U: readonly Iv[]): Iv[] {
  const out: Iv[] = [];
  let cur = a.start;
  for (const u of U) {
    if (u.end <= cur) continue;
    if (u.start >= a.end) break;
    if (u.start > cur) out.push({ start: cur, end: Math.min(u.start, a.end) });
    cur = Math.max(cur, u.end);
    if (cur >= a.end) break;
  }
  if (cur < a.end) out.push({ start: cur, end: a.end });
  return out;
}

/** 併入一段，維持不相交且有序 */
function unionAdd(U: Iv[], iv: Iv): Iv[] {
  const out: Iv[] = [];
  let cur = { ...iv };
  let placed = false;
  for (const u of U) {
    if (u.end < cur.start) {
      out.push(u);
    } else if (u.start > cur.end) {
      if (!placed) {
        out.push(cur);
        placed = true;
      }
      out.push(u);
    } else {
      cur = { start: Math.min(cur.start, u.start), end: Math.max(cur.end, u.end) };
    }
  }
  if (!placed) out.push(cur);
  return out;
}

/**
 * 整理只掃最近幾天（契約 §9-6 的預定退路）：沙盒以 10,012 筆在 debug 真 SQLite 實測全表整理 1.6 秒，
 * 超過 200ms 門檻（沙盒回報 F2）。兩台同步造成的衝突只會出現在最近寫的塊上，62 天＝兩個月的離線餘裕。
 * 兩個 repository 共用這個常數與 `inReconcileWindow`，不各寫字面值。
 */
export const RECONCILE_WINDOW_DAYS = 62;

/** 整理窗口的下緣（毫秒）：`now − RECONCILE_WINDOW_DAYS 天` */
export function reconcileWindowStart(now: number): number {
  return now - RECONCILE_WINDOW_DAYS * 24 * 60 * MIN;
}

/**
 * 這一塊要不要進整理：運行中、或開始／結束落在窗口下緣之後（含）。
 * 跨越下緣的塊（開始在窗外、結束在窗內）靠「結束在窗內」被納入；
 * 開始在窗內、結束被改到窗外（end < start 的髒資料）靠「開始在窗內」被納入，才夾得到零。
 * SQL 版（`sqliteTimetableRepository.reconcile`）與本式同語義：ISO 24 字元字串比較＝時刻比較。
 */
export function inReconcileWindow(s: Span, floor: number): boolean {
  return s.end === null || s.end >= floor || s.start >= floor;
}

/**
 * 整理的寫入鍵（契約 0-8 的 2026-10-11 改訂、D-時-26）：`<started_at 那一格的寫入時刻>|<updated_at>`。
 *
 * 為什麼只看 `started_at` 那一格、不取整列最後寫入：一班從 14:00 一直開著、17:30 換車才寫下結束，整列取 MAX
 * 會讓它變成「最晚」，把另一台離線期間認真記的幾段整段吃掉（沙盒 F3）。看「誰比較晚發車／補記／改開始」才符合
 * 計時語義；改分類、改結束都不再讓整列變晚。
 *
 * `startedAtStamp`：sqlite＝`sync_cells` 裡 `col='started_at'` 那一格的 hlc（`<13 位 ms><4 位 hex>-<device 前 8 碼>`，
 * 字典序即時序）；mock＝記憶體裡記的 started_at 最後被寫的 ISO。沒有（null／undefined／空字串）⇒ 放一個空白 `" "`：
 * 0x20 小於 hlc／ISO 會出現的任何字元，所以沒有格子的列永遠排最早——不能放空字串，`"" + "|"` 以 `|`（0x7C）開頭，
 * 字典序反而大於任何真戳記。
 */
export function reconcileWriteKey(startedAtStamp: string | null | undefined, updatedAt: string): string {
  return (startedAtStamp || " ") + "|" + updatedAt;
}

/**
 * 兩台同步後的整理（決定性、冪等）。輸入＝未刪除的塊（含寫入鍵；repository 只餵 `inReconcileWindow` 內的）。
 *   1. 夾零：end < start ⇒ end = start、ack = false（契約 0-7）
 *   2. 排序：writeKey 遞減、同值 id 遞減（＝誰比較晚發車：started_at 那一格寫得較晚，`reconcileWriteKey`／D-時-26）
 *   3. 多筆運行中：第一筆存活；其餘 end = max(自己的 start, 存活者的 start)
 *   4. 重疊：依序處理，`pieces = s − U`；全在 ⇒ 不動；空 ⇒ delete；否則第一片回原 id、其餘 insert（確定性 key）
 *   5. 合併同 id 的 patch、去掉與輸入相同的欄
 */
export function planReconcile(spans: readonly KeyedSpan[]): WritePlan {
  const sorted = spans
    .map((s) => ({ ...s }))
    .sort((a, b) => (a.writeKey < b.writeKey ? 1 : a.writeKey > b.writeKey ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const input = new Map<string, KeyedSpan>();
  for (const s of spans) input.set(s.id, s);

  const patches = new Map<string, SpanPatch>();
  const patchOrder: string[] = [];
  const touch = (id: string, fields: Partial<SpanPatch>): void => {
    const prev = patches.get(id);
    if (prev) {
      Object.assign(prev, fields);
    } else {
      patchOrder.push(id);
      patches.set(id, { id, ...fields });
    }
  };

  // 1. 夾零（用排序後的順序走訪，輸出才與輸入順序無關）
  for (const s of sorted) {
    if (s.end !== null && s.end < s.start) {
      s.end = s.start;
      s.ack = false;
      touch(s.id, { end: s.end, ack: false });
    }
  }

  // 3. 多筆運行中
  let survivor: KeyedSpan | null = null;
  for (const s of sorted) {
    if (s.end !== null) continue;
    if (!survivor) {
      survivor = s;
      continue;
    }
    s.end = Math.max(s.start, survivor.start);
    touch(s.id, { end: s.end });
  }

  // 4. 重疊
  const inserts: SpanInsert[] = [];
  const deletes: string[] = [];
  let U: Iv[] = [];
  for (const s of sorted) {
    if (isZero(s)) continue;
    const me: Iv = { start: s.start, end: s.end ?? Infinity };
    const pieces = subtract(me, U);
    if (pieces.length === 1 && pieces[0].start === me.start && pieces[0].end === me.end) {
      U = unionAdd(U, me);
      continue;
    }
    if (pieces.length === 0) {
      deletes.push(s.id);
      continue;
    }
    const first = pieces[0];
    const firstEnd = first.end === Infinity ? null : first.end;
    if (first.start !== s.start || firstEnd !== s.end) {
      touch(s.id, { start: first.start, end: firstEnd });
    }
    for (let i = 1; i < pieces.length; i++) {
      const p = pieces[i];
      inserts.push({
        key: `${s.id}|${isoOf(p.start)}`,
        fromId: s.id,
        inherit: true,
        categoryId: s.categoryId,
        start: p.start,
        end: p.end === Infinity ? null : p.end,
        ack: s.ack,
      });
    }
    for (const p of pieces) U = unionAdd(U, p);
  }

  // 5. 去掉與輸入相同的欄
  const out: SpanPatch[] = [];
  for (const id of patchOrder) {
    if (deletes.includes(id)) continue;
    const p = patches.get(id)!;
    const orig = input.get(id)!;
    const clean: SpanPatch = { id };
    let any = false;
    if (p.start !== undefined && p.start !== orig.start) {
      clean.start = p.start;
      any = true;
    }
    if (p.end !== undefined && p.end !== orig.end) {
      clean.end = p.end;
      any = true;
    }
    if (p.categoryId !== undefined && p.categoryId !== orig.categoryId) {
      clean.categoryId = p.categoryId;
      any = true;
    }
    if (p.ack !== undefined && p.ack !== orig.ack) {
      clean.ack = p.ack;
      any = true;
    }
    if (any) out.push(clean);
  }
  return { patches: out, inserts, deletes };
}

/* ───────────────────────── §4.5 顯示用 ───────────────────────── */

/**
 * 取與 `[w.start, min(w.end, now))` 相交的塊（加上落在窗內的零長度塊）；相鄰覆蓋之間 ≥ 1 分鐘的空白產生 gap。
 * 髒資料重疊時游標取 max，不產生負長度 gap。
 */
export function segmentsOfDay(spans: readonly Span[], w: { start: number; end: number }, now: number): AxisItem[] {
  const effEnd = Math.min(w.end, now);
  const blocks: Extract<AxisItem, { kind: "block" }>[] = [];
  for (const s of spans) {
    if (isZero(s)) {
      if (s.start >= w.start && s.start < w.end && s.start <= now) {
        blocks.push({ kind: "block", span: s, from: s.start, to: s.start, running: false, contFromPrev: false, contToNext: false, zero: true });
      }
      continue;
    }
    const sEnd = s.end ?? now;
    if (s.start >= effEnd || sEnd <= w.start) continue;
    blocks.push({
      kind: "block",
      span: s,
      from: Math.max(s.start, w.start),
      to: Math.min(sEnd, w.end, now),
      running: s.end === null,
      contFromPrev: s.start < w.start,
      contToNext: sEnd > w.end,
      zero: false,
    });
  }
  blocks.sort((a, b) => a.from - b.from || (a.span.id < b.span.id ? -1 : a.span.id > b.span.id ? 1 : 0));

  const items: AxisItem[] = [];
  let cursor = w.start;
  for (const b of blocks) {
    // 零長度塊也要先補它前面的空白、並把游標推到它的時刻：否則空白要等下一個非零塊才補，
    // 會排在零長度塊之後、還把零長度塊所在的時刻蓋進去（沙盒回報 D1）。零長度塊 from＝to，兩條分支結果相同，合寫。
    if (b.from - cursor >= MIN) items.push({ kind: "gap", from: cursor, to: b.from });
    cursor = Math.max(cursor, b.to);
    items.push(b);
  }
  if (effEnd - cursor >= MIN) items.push({ kind: "gap", from: cursor, to: effEnd });
  return items;
}

/**
 * ③：把塊切進窗 `[w.start, min(w.end, now))`，重疊不重複計——每一小段時間只記給開始較晚的那一塊（同開始取 id 較大）。
 * 回每塊一筆 `{ id, categoryId, ms }`（只出 ms > 0 的；同一塊被重疊切成幾段也併成一筆；順序＝依開始時間）。
 * `totalsByCategory` 與統計（`timetableStats.ts`）共用這一條規則，只寫這一次。
 * 掃描線：切點由小到大，活動中的塊依（開始, id）排好，擁有者＝最後一個；乾淨資料（不重疊）下是 O(n log n)。
 */
export function sliceSpans(
  spans: readonly Span[],
  w: { start: number; end: number },
  now: number,
): { id: string; categoryId: string; ms: number }[] {
  const effEnd = Math.min(w.end, now);
  interface Clip {
    id: string;
    categoryId: string;
    start: number;
    end: number;
  }
  const clipped: Clip[] = [];
  for (const s of spans) {
    const from = Math.max(s.start, w.start);
    const to = Math.min(s.end ?? now, effEnd);
    if (to <= from) continue;
    clipped.push({ id: s.id, categoryId: s.categoryId, start: from, end: to });
  }
  if (!clipped.length) return [];
  clipped.sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const boundSet = new Set<number>();
  for (const c of clipped) {
    boundSet.add(c.start);
    boundSet.add(c.end);
  }
  const ts = Array.from(boundSet).sort((x, y) => x - y);
  const msById = new Map<string, number>();
  const order: Clip[] = [];
  let active: Clip[] = [];
  let p = 0;
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i];
    const b = ts[i + 1];
    while (p < clipped.length && clipped[p].start <= a) active.push(clipped[p++]);
    if (active.length && active.some((c) => c.end <= a)) active = active.filter((c) => c.end > a);
    if (!active.length) continue;
    const owner = active[active.length - 1];
    const prev = msById.get(owner.id);
    if (prev === undefined) order.push(owner);
    msById.set(owner.id, (prev ?? 0) + (b - a));
  }
  return order.map((c) => ({ id: c.id, categoryId: c.categoryId, ms: msById.get(c.id)! }));
}

/** 毫秒；先夾進窗；重疊不重複計——每一小段時間只記給開始較晚的那一塊（同開始取 id 較大）。切片規則在 `sliceSpans` */
export function totalsByCategory(
  spans: readonly Span[],
  w: { start: number; end: number },
  now: number,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const sl of sliceSpans(spans, w, now)) totals[sl.categoryId] = (totals[sl.categoryId] ?? 0) + sl.ms;
  return totals;
}

/** 子分類合計加到它的頂層組（找不到父的，記在自己名下） */
export function totalsByGroup(
  totals: Record<string, number>,
  cats: readonly TimeCategoryRow[],
): Record<string, number> {
  const parentOf = new Map<string, string | null>();
  for (const c of cats) parentOf.set(c.id, c.parent_id);
  const out: Record<string, number> = {};
  for (const id of Object.keys(totals)) {
    const parent = parentOf.get(id);
    const key = parent === null || parent === undefined ? id : parent;
    out[key] = (out[key] ?? 0) + totals[id];
  }
  return out;
}

export function gapTotal(items: readonly AxisItem[]): number {
  let t = 0;
  for (const i of items) if (i.kind === "gap") t += i.to - i.from;
  return t;
}

export function recordedTotal(items: readonly AxisItem[]): number {
  let t = 0;
  for (const i of items) if (i.kind === "block") t += i.to - i.from;
  return t;
}

/* ── ①b：顯示用增補（①b①c 契約 §4.6） ── */

/** F 鍵：最後一段未記錄（items 依時間排好，＝segmentsOfDay 的輸出）；沒有回 null */
export function latestGap(items: readonly AxisItem[]): { from: number; to: number } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "gap") return { from: it.from, to: it.to };
  }
  return null;
}

const roundToMin = (ms: number): number => Math.round(ms / MIN) * MIN;

/**
 * 切開面板的預設切點：n 刀等分、取整到分、夾在 `[start+1 分, end−1 分]`、去重（嚴格遞增）。
 * 「對半」＝n=1（中點）。整塊不到 2 分 ⇒ []。
 */
export function defaultCuts(start: number, end: number, n: number): number[] {
  const lo = start + MIN;
  const hi = end - MIN;
  if (n < 1 || hi < lo) return [];
  const out: number[] = [];
  for (let k = 1; k <= n; k++) {
    const c = clamp(roundToMin(start + ((end - start) * k) / (n + 1)), lo, hi);
    if (!out.length || c > out[out.length - 1]) out.push(c);
  }
  return out;
}

/**
 * 「＋ 加切點」：在**最長的一段**中點加一刀（取整到分、夾在那一段的 `[頭+1 分, 尾−1 分]`）；
 * 最長段 < 2 分 ⇒ 原樣回（新陣列）。cuts 須已嚴格遞增、在 (start, end) 之內。
 */
export function addCut(cuts: readonly number[], start: number, end: number): number[] {
  const bounds = [start, ...cuts, end];
  let best = -1;
  let bestLen = -1;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const len = bounds[i + 1] - bounds[i];
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  if (best < 0 || bestLen < 2 * MIN) return cuts.slice();
  const a = bounds[best];
  const b = bounds[best + 1];
  const c = clamp(roundToMin((a + b) / 2), a + MIN, b - MIN);
  const out = cuts.slice();
  out.splice(best, 0, c);
  return out;
}

/** 列高＝時長的壓縮映射（＝原型 v-a.js） */
export function axisRowHeight(ms: number): number {
  const min = ms / MIN;
  return Math.round(Math.min(132, Math.max(46, 30 + min * 0.62)));
}

/** 只取 block 項，轉 ISO，帶分類資訊（契約 §6.3-1） */
export function toDayBlockSegments(
  items: readonly AxisItem[],
  catById: Readonly<Record<string, TimeCategoryRow | undefined>>,
  rowsById: Readonly<Record<string, TimeBlockRow | undefined>>,
): DayBlockSegment[] {
  const out: DayBlockSegment[] = [];
  for (const i of items) {
    if (i.kind !== "block") continue;
    const cat = catById[i.span.categoryId];
    const row = rowsById[i.span.id];
    out.push({
      blockId: i.span.id,
      categoryId: i.span.categoryId,
      categoryName: cat?.name ?? "？",
      glyph: cat?.glyph ?? null,
      colorIdx: cat ? colorSlot(cat.color_idx) : 1,
      nodeId: row?.node_id ?? null,
      routeId: row?.route_id ?? null,
      from: isoOf(i.from),
      to: isoOf(i.to),
      running: i.running,
      contFromPrev: i.contFromPrev,
      contToNext: i.contToNext,
    });
  }
  return out;
}

/* ───────── ③ 甲席修正：面板開的那一塊不一定在畫面的清單裡（評審 #1） ───────── */

/** 帶 blockId 的 sheet（longRun／restart／edit／split／estimate／link）→ 那一塊的 id；其餘（含 null）→ null */
export function sheetBlockIdOf(sheet: { kind: string } | null): string | null {
  if (sheet === null) return null;
  const id = (sheet as { blockId?: unknown }).blockId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** 在「運行中、各段時間塊」裡依 id 找一塊（先找到的先贏；找不到 null） */
export function findBlockIn(id: string, running: TimeBlockRow | null, lists: readonly (readonly TimeBlockRow[])[]): TimeBlockRow | null {
  if (running !== null && running.id === id) return running;
  for (const rows of lists) {
    for (const b of rows) if (b.id === id) return b;
  }
  return null;
}
