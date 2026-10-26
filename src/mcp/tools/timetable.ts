/**
 * 外部助理（MCP）工具：時刻表（契約 §4；module 'timetable'）。
 * 讀：find-time-blocks／find-time-categories／get-time-stats；寫：start／stop／add／update／delete-time-blocks。
 * 寫入一律走 `timetableRepo` 的既有方法，參數照 `timetableStore`／`BlockPanel` 的呼叫抄（出處標在各段）。
 *
 * 時刻輸入：本地時間 'YYYY-MM-DDTHH:MM'（日曆日；24 時以後的營業日寫法也收），或帶時區的 ISO（…Z／+08:00）；輸出一律本地日曆日 'YYYY-MM-DDTHH:MM'。
 * 長度門檻（待確認）用的全域上限＝`ctx.longRunMaxMin`（bridge 每次從 settings 讀，與統計頁同一個值）。
 */
import { MCP_BATCH_LIMIT, McpUserError, type JsonSchema, type McpCtx, type McpTool } from "../types";
import { batch, bool, idList, int, range, str } from "../args";
import {
  MIN,
  blockThresholdOf,
  isLongRun,
  isoOf,
  msOf,
  toSpan,
  totalsByGroup,
  type BlockLink,
  type CoverSummary,
  type TimeBlockRow,
  type TimeCategoryRow,
} from "../../domain/timetable";
import { ROUTE_NONE, classifySpans, toStatsSpan, windowTotals, type StatsSpan } from "../../domain/timetableStats";
import { LINKABLE_KINDS } from "../../domain/timetableLink";
import { LONG_BLOCK_MS } from "../../domain/timetableClockInput";
import { dayWindow } from "../../lib/date";
import type { NodeRow } from "../../domain/node";

type Args = Record<string, unknown>;

const CHANGED = ["time_blocks"] as const;
const LIST_LIMIT = 100;
const BLOCKS_MAX_DAYS = 31;
const STATS_MAX_DAYS = 92;

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const ADD = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const CHANGE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

/* ───────── 時刻 ───────── */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));

/** ms → 本地 'YYYY-MM-DDTHH:MM' */
function localText(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 讀一個時刻欄位（本地 'YYYY-MM-DDTHH:MM' 或帶時區的 ISO）；回 ms */
function instant(a: Args, key: string, opts: { required: true; where?: string }): number;
function instant(a: Args, key: string, opts?: { required?: false; where?: string }): number | undefined;
function instant(a: Args, key: string, opts: { required?: boolean; where?: string } = {}): number | undefined {
  const v = opts.required ? str(a, key, { required: true, where: opts.where }) : str(a, key, { where: opts.where });
  if (v === undefined) return undefined;
  const at = opts.where ? `${opts.where}.${key}` : key;
  const bad = (): McpUserError => new McpUserError(`${at} 要是本地時間 YYYY-MM-DDTHH:MM（例 2026-10-25T14:30），收到「${v}」`);
  const m = LOCAL_RE.exec(v);
  if (m) {
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    // 營業日寫法（其他模組的時刻表記）也收：24 時以後＝隔天凌晨（2026-10-24T25:30＝10-25 01:30），日曆時刻裡不會撞
    const late = h >= 24 && h < 48 ? 1 : 0;
    const hh = h - late * 24;
    const day = new Date(y, mo - 1, d);
    // 2026-02-30 之類會被 Date 進位 ⇒ 讀回來不一樣就是不合法
    if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d || hh > 23 || mi > 59) throw bad();
    return new Date(y, mo - 1, d + late, hh, mi).getTime();
  }
  if (ISO_RE.test(v)) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw bad();
    return t;
  }
  throw bad();
}

const minutesOf = (ms: number): number => Math.max(0, Math.round(ms / MIN));

/** 助理照 find 的輸出（取整到分）回填沒要改的時刻 ⇒ 當作沒動（＝BlockPanel 沒碰那一欄，存回的是原本的毫秒） */
const sameMinute = (v: number | undefined, cur: number): number | undefined => (v !== undefined && v === Math.floor(cur / MIN) * MIN ? cur : v);

function lengthText(ms: number): string {
  const mins = Math.floor(ms / MIN);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h === 0 ? `${m} 分` : m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

/* ───────── 分類、連結、門檻 ───────── */

async function categoryMap(ctx: McpCtx): Promise<Map<string, TimeCategoryRow>> {
  return new Map((await ctx.deps.timetableRepo.listCategories()).map((c) => [c.id, c] as const));
}

const catName = (cats: Map<string, TimeCategoryRow>, id: string): string => cats.get(id)?.name ?? "（已刪除的分類）";

/** 補記／発車／改分類能選的：未封存的子分類（＝UI 的分類格 `leafCategories`；`lastCategoryFor` 的 usable 同一條） */
function usableCategory(cats: Map<string, TimeCategoryRow>, id: string, at: string): TimeCategoryRow {
  const c = cats.get(id);
  if (!c) throw new McpUserError(`${at} 找不到這個分類「${id}」（先用 find-time-categories 查 id）`);
  if (c.parent_id === null) throw new McpUserError(`${at}「${c.name}」是分組，請選它底下的分類`);
  if (c.archived_at !== null) throw new McpUserError(`${at}「${c.name}」已封存，請選別的分類`);
  return c;
}

/** 連到車票（＝`departFromTask` 的檢查）：要開放任務才認得車票的 id */
async function linkableNode(ctx: McpCtx, id: string, at: string): Promise<NodeRow> {
  if (ctx.access.tasks === "off") throw new McpUserError(`${at}：要連到車票，需要在 設定 › 外部助理 開放「任務」`);
  const n = await ctx.deps.nodeRepo.getNode(id).catch(() => null);
  if (!n || n.deleted_at !== null || !LINKABLE_KINDS.includes(n.kind)) throw new McpUserError(`${at} 找不到這張車票「${id}」`);
  return n;
}

/** 節點快取（一次呼叫內；連結名稱與任務預計時間共用） */
function nodeCache(ctx: McpCtx): (id: string) => Promise<NodeRow | null> {
  const memo = new Map<string, Promise<NodeRow | null>>();
  return (id) => {
    let p = memo.get(id);
    if (!p) {
      p = ctx.deps.nodeRepo.getNode(id).catch(() => null);
      memo.set(id, p);
    }
    return p;
  };
}

/** 運行中那班的任務預計時間（＝store 的 liveTaskEstimate／taskEstimateOf：已刪除、沒填、≤0 ⇒ null） */
async function taskEstimate(r: { ended: boolean; nodeId: string | null }, node: (id: string) => Promise<NodeRow | null>): Promise<number | null> {
  if (r.ended || r.nodeId === null) return null;
  const n = await node(r.nodeId);
  if (!n || n.deleted_at !== null) return null;
  return n.estimate_min !== null && n.estimate_min > 0 ? n.estimate_min : null;
}

/** 待確認（＝store 的 `blockIsLongRun`：門檻 預估 → 任務預計 → 分類預設 → 全域；已結束的不看分類與任務） */
async function isPending(
  r: TimeBlockRow,
  cats: Map<string, TimeCategoryRow>,
  node: (id: string) => Promise<NodeRow | null>,
  now: number,
  longRunMaxMin: number,
): Promise<boolean> {
  const ended = r.ended_at !== null;
  const est = await taskEstimate({ ended, nodeId: r.node_id }, node);
  const th = blockThresholdOf(ended, r.estimate_min, cats.get(r.category_id) ?? null, longRunMaxMin, est);
  return isLongRun(toSpan(r), th?.min ?? null, now);
}

/* ───────── 回傳的樣子 ───────── */

interface BlockView {
  id: string;
  categoryId: string;
  category: string;
  group?: string;
  start: string;
  /** null＝運行中 */
  end: string | null;
  minutes: number;
  running?: true;
  /** 長度超過門檻、還沒確認（App 上標「待確認」） */
  pending?: true;
  estimateMin?: number;
  task?: { id: string; name?: string; deleted?: true };
  route?: { id: string; name?: string; deleted?: true };
}

async function viewOf(
  ctx: McpCtx,
  r: TimeBlockRow,
  cats: Map<string, TimeCategoryRow>,
  node: (id: string) => Promise<NodeRow | null>,
): Promise<BlockView> {
  const now = ctx.now.getTime();
  const start = msOf(r.started_at);
  const end = r.ended_at === null ? null : msOf(r.ended_at);
  const cat = cats.get(r.category_id);
  const parent = cat?.parent_id ? cats.get(cat.parent_id) : undefined;
  const v: BlockView = {
    id: r.id,
    categoryId: r.category_id,
    category: catName(cats, r.category_id),
    start: localText(start),
    end: end === null ? null : localText(end),
    minutes: minutesOf((end ?? now) - start),
  };
  if (parent) v.group = parent.name;
  if (end === null) v.running = true;
  if (await isPending(r, cats, node, now, ctx.longRunMaxMin)) v.pending = true;
  if (r.estimate_min !== null) v.estimateMin = r.estimate_min;
  // 連到的車票／路線屬於任務功能：任務關著只給 id
  const linkOf = async (id: string): Promise<{ id: string; name?: string; deleted?: true }> => {
    if (ctx.access.tasks === "off") return { id };
    const n = await node(id);
    return n && n.deleted_at === null ? { id, name: n.name } : { id, deleted: true };
  };
  if (r.node_id !== null) v.task = await linkOf(r.node_id);
  else if (r.route_id !== null) v.route = await linkOf(r.route_id);
  return v;
}

function coverText(s: CoverSummary): string {
  const parts: string[] = [];
  if (s.removed) parts.push(`蓋掉 ${s.removed} 塊`);
  if (s.shortened) parts.push(`縮短 ${s.shortened} 塊`);
  if (s.splitCount) parts.push(`切開 ${s.splitCount} 塊`);
  return parts.length ? `；動到既有的：${parts.join("、")}` : "";
}

const addCover = (a: CoverSummary, b: CoverSummary): CoverSummary => ({
  removed: a.removed + b.removed,
  shortened: a.shortened + b.shortened,
  splitCount: a.splitCount + b.splitCount,
});
const NO_COVER: CoverSummary = { removed: 0, shortened: 0, splitCount: 0 };

/** repository 的 RangeError（寫給人看的）轉成助理能讀的錯；批次寫到一半時說清楚前面幾筆已寫入 */
async function guard<T>(fn: () => Promise<T>, where?: { index: number; key: string }): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    if (!where) throw new McpUserError(e.message);
    const done = where.index ? `（前 ${where.index} 筆已寫入）` : "";
    throw new McpUserError(`${where.key}[${where.index}] 沒寫成：${e.message}${done}`);
  }
}

/** 12 小時以上要確認（D-主-64；＝BlockPanel 的 longBlockAsk 門檻） */
function needLongConfirm(start: number, end: number, confirmed: boolean | undefined, at: string): void {
  if (end - start <= LONG_BLOCK_MS || confirmed) return;
  throw new McpUserError(
    `${at} 這一塊有 ${lengthText(end - start)}（${localText(start)} → ${localText(end)}），超過 12 小時。請跟使用者確認起訖沒打錯，確定就在這一筆加 confirmLong:true`,
  );
}

/* ───────── schema 片段 ───────── */

const TIME_DESC = "本地時間 YYYY-MM-DDTHH:MM（日曆日，例 2026-10-25T14:30；凌晨也可寫成前一天的 25:30）";
const timeProp = (what: string): JsonSchema => ({ type: "string", description: `${what}，${TIME_DESC}` });
const rangeProps: Record<string, JsonSchema> = {
  from: { type: "string", description: "起日 YYYY-MM-DD（營業日：從這天的日界線開始）" },
  to: { type: "string", description: "迄日 YYYY-MM-DD（含這天；省略＝同 from）" },
};

function readRange(a: Args, maxDays: number, h: number): { from: string; to: string; start: number; end: number } {
  const { from, to } = range({ from: a.from, to: a.to ?? a.from }, "from", "to", maxDays);
  return { from, to, start: msOf(dayWindow(from, h).start), end: msOf(dayWindow(to, h).end) };
}

/* ───────── 讀 ───────── */

const findTimeBlocks: McpTool = {
  name: "find-time-blocks",
  title: "查時間塊",
  description:
    "列出區間內的時間塊（時刻表的紀錄）：分類、起訖（本地日曆時刻 YYYY-MM-DDTHH:MM；end null＝運行中）、時長分鐘、連到的車票（task）。區間以營業日算、最多 31 天，最多回 100 塊。pending＝長度超過門檻、還沒確認。",
  inputSchema: { type: "object", properties: rangeProps, required: ["from"], additionalProperties: false },
  module: "timetable",
  access: "read",
  annotations: READ,
  async run(a, ctx) {
    const w = readRange(a, BLOCKS_MAX_DAYS, ctx.dayStartHour);
    const rows = await ctx.deps.timetableRepo.listBlocks(isoOf(w.start), isoOf(w.end));
    const cats = await categoryMap(ctx);
    const node = nodeCache(ctx);
    const shown = rows.slice(0, LIST_LIMIT);
    const blocks = await Promise.all(shown.map((r) => viewOf(ctx, r, cats, node)));
    const span = w.from === w.to ? w.from : `${w.from}～${w.to}`;
    const more = rows.length > LIST_LIMIT ? `，只列前 ${LIST_LIMIT} 塊（請縮小區間）` : "";
    return { summary: `${span} 共 ${rows.length} 塊${more}`, data: { from: w.from, to: w.to, total: rows.length, truncated: rows.length > LIST_LIMIT, blocks } };
  },
};

const findTimeCategories: McpTool = {
  name: "find-time-categories",
  title: "查時刻表分類",
  description: "列出時刻表的分類樹：分組底下的分類（記時間、補記都要選分類，不能選分組）。defaultMin＝分類預設長度（分）。",
  inputSchema: {
    type: "object",
    properties: { includeArchived: { type: "boolean", description: "也列已封存的分類（預設 false）" } },
    additionalProperties: false,
  },
  module: "timetable",
  access: "read",
  annotations: READ,
  async run(a, ctx) {
    const withArchived = bool(a, "includeArchived") ?? false;
    const all = await ctx.deps.timetableRepo.listCategories(); // 已排好：頂層組 position，再各組子分類
    const groups = all
      .filter((c) => c.parent_id === null)
      .map((g) => ({
        id: g.id,
        name: g.name,
        categories: all
          .filter((c) => c.parent_id === g.id && (withArchived || c.archived_at === null))
          .map((c) => ({
            id: c.id,
            name: c.name,
            ...(c.default_min !== null ? { defaultMin: c.default_min } : {}),
            ...(c.archived_at !== null ? { archived: true } : {}),
          })),
      }));
    const n = groups.reduce((s, g) => s + g.categories.length, 0);
    return { summary: `${groups.length} 個分組、${n} 個分類`, data: { groups } };
  },
};

const getTimeStats: McpTool = {
  name: "get-time-stats",
  title: "時間統計",
  description:
    "區間內各分類合計分鐘（跟 App 統計頁同一把尺：不到 1 分鐘的碎塊不算、待確認的長塊另計、重疊歸較晚開始的）。區間以營業日算、最多 92 天。",
  inputSchema: { type: "object", properties: rangeProps, required: ["from"], additionalProperties: false },
  module: "timetable",
  access: "read",
  annotations: READ,
  async run(a, ctx) {
    const now = ctx.now.getTime();
    const w = readRange(a, STATS_MAX_DAYS, ctx.dayStartHour);
    // ＝timetableStatsStore：listBlocksSlim(起點 → max(現在, 窗尾)) → toStatsSpan → classifySpans → windowTotals
    const rows = await ctx.deps.timetableRepo.listBlocksSlim(isoOf(w.start), isoOf(Math.max(now, w.end)));
    const spans = rows.map(toStatsSpan);
    const cats = await categoryMap(ctx);
    const node = nodeCache(ctx);
    const taskEst = new Map<string, number | null>();
    for (const s of spans) if (s.end === null) taskEst.set(s.id, await taskEstimate({ ended: false, nodeId: s.nodeId }, node));
    // ＝timetableStatsStore 的 thresholdFn
    const th = (s: StatsSpan): number | null =>
      blockThresholdOf(s.end !== null, s.estimateMin, cats.get(s.categoryId) ?? null, ctx.longRunMaxMin, taskEst.get(s.id) ?? null)?.min ?? null;
    const cls = classifySpans(spans, now, th);
    const t = windowTotals(spans, cls, { start: w.start, end: w.end }, now, () => ROUTE_NONE);
    const catList = Array.from(cats.values());
    const byGroup = totalsByGroup(t.byCategory, catList);
    const categories = Object.entries(t.byCategory)
      .sort((x, y) => y[1] - x[1])
      .map(([id, ms]) => {
        const c = cats.get(id);
        const parent = c?.parent_id ? cats.get(c.parent_id) : undefined;
        return { id, name: catName(cats, id), ...(parent ? { group: parent.name } : {}), minutes: minutesOf(ms) };
      });
    const groups = Object.entries(byGroup)
      .sort((x, y) => y[1] - x[1])
      .map(([id, ms]) => ({ id, name: catName(cats, id), minutes: minutesOf(ms) }));
    const span = w.from === w.to ? w.from : `${w.from}～${w.to}`;
    const pend = t.pendingIds.length ? `，另有 ${t.pendingIds.length} 塊待確認 ${minutesOf(t.pendingMs)} 分不計` : "";
    return {
      summary: `${span} 已記錄 ${minutesOf(t.recordedMs)} 分${pend}`,
      data: {
        from: w.from,
        to: w.to,
        recordedMinutes: minutesOf(t.recordedMs),
        unrecordedMinutes: minutesOf(t.unrecordedMs),
        pending: { count: t.pendingIds.length, minutes: minutesOf(t.pendingMs) },
        groups,
        categories,
      },
    };
  },
};

/* ───────── 寫：発車、到着 ───────── */

/** 運行中那班（＝store 的 running：listRunning 的第一筆＝開始最晚的） */
async function runningBlock(ctx: McpCtx): Promise<TimeBlockRow | null> {
  return (await ctx.deps.timetableRepo.listRunning())[0] ?? null;
}

function longRunAsk(r: TimeBlockRow, cats: Map<string, TimeCategoryRow>, now: number, next: string): McpUserError {
  const start = msOf(r.started_at);
  return new McpUserError(
    `運行中的「${catName(cats, r.category_id)}」從 ${localText(start)} 已經跑了 ${lengthText(now - start)}，超過提醒門檻、還沒確認。` +
      `請問使用者實際幾點結束：用 stop-time-block 帶 at 先讓它到着${next}；如果長度沒錯，傳 confirmLong:true`,
  );
}

const startTimeBlock: McpTool = {
  name: "start-time-block",
  title: "発車（開始計時）",
  description:
    "発車＝開始記一段時間。運行中的那班會在發車時刻到着（換車）。給 taskId（車票）可省略 categoryId，沿用這張票上次的分類。at 省略＝現在，可以補成稍早的時刻（之後的紀錄會被蓋掉）。",
  inputSchema: {
    type: "object",
    properties: {
      categoryId: { type: "string", description: "分類 id（find-time-categories；要選子分類）" },
      taskId: { type: "string", description: "連到的車票 id（選填）" },
      at: timeProp("発車時刻（省略＝現在；不能晚於現在）"),
      estimateMin: { type: "integer", minimum: 1, maximum: 1440, description: "這一班預計幾分（選填）" },
      confirmLong: { type: "boolean", description: "運行中那班跑太久、使用者確認長度沒錯時才給 true" },
    },
    additionalProperties: false,
  },
  module: "timetable",
  access: "write",
  annotations: ADD,
  async run(a, ctx) {
    const now = ctx.now.getTime();
    const repo = ctx.deps.timetableRepo;
    const at = instant(a, "at");
    if (at !== undefined && at > now + MIN) throw new McpUserError("at 不能晚於現在（排未來的行程請用任務的工具）");
    const atMs = Math.min(at ?? now, now); // ＝store depart：min(at, now)
    const estimateMin = int(a, "estimateMin", { min: 1, max: 1440 });
    const confirmLong = bool(a, "confirmLong");
    const cats = await categoryMap(ctx);
    const taskId = str(a, "taskId");
    const task = taskId ? await linkableNode(ctx, taskId, "taskId") : null;
    const node = nodeCache(ctx);
    const running = await runningBlock(ctx);
    const already = async (what: string) => ({
      summary: `「${what}」已經在跑了（${localText(msOf(running!.started_at))} 発），沒有變動；要改出發時刻用 update-time-blocks`,
      data: { block: await viewOf(ctx, running!, cats, node) },
    });
    let categoryId = str(a, "categoryId");
    if (!categoryId && task) {
      // ＝departFromTask：先看這張票是不是已經在跑，再 lastCategoryFor(節點, 節點的路線)；沒有就要使用者選
      if (running && running.node_id === task.id) return already(task.name);
      const hit = await repo.lastCategoryFor(task.id, task.route_id);
      if (!hit) throw new McpUserError(`「${task.name}」還沒記過時間，請指定 categoryId`);
      categoryId = hit.categoryId;
    } else if (categoryId && running && running.category_id === categoryId) {
      // 指定分類：沒給車票＝tapCategory（同分類就算在跑）；給了車票＝DepartPanel（同分類而且同一張票才算）
      if (!task) return already(catName(cats, categoryId));
      if (running.node_id === task.id) return already(task.name);
    }
    if (!categoryId) throw new McpUserError("缺少 categoryId（或給 taskId 沿用車票上次的分類）");
    usableCategory(cats, categoryId, "categoryId");
    // ＝tapCategory／departWithLink：運行中那班跑太久 ⇒ 先問「實際到幾點」；選「長度沒錯」＝resolveLongRun keep 再発車
    if (running && (await isPending(running, cats, node, now, ctx.longRunMaxMin))) {
      if (!confirmLong) throw longRunAsk(running, cats, now, "，再発車");
      await guard(() => repo.resolveLongRun(running.id, isoOf(now), "keep"));
    }
    const link: BlockLink | null = task ? { nodeId: task.id, routeId: null } : null;
    const { block, summary } = await guard(() => repo.depart(categoryId, isoOf(atMs), { estimateMin: estimateMin ?? null, link }));
    const prev = running ? await repo.getBlock(running.id) : null;
    const name = catName(cats, block.category_id);
    const prevText = prev && prev.ended_at !== null ? `；「${catName(cats, prev.category_id)}」到着` : "";
    return {
      summary: `発車・${name}　${localText(msOf(block.started_at))}${prevText}${coverText(summary)}`,
      data: {
        block: await viewOf(ctx, block, cats, node),
        ...(prev && prev.ended_at !== null ? { previous: await viewOf(ctx, prev, cats, node) } : {}),
        covered: summary,
      },
      changed: CHANGED,
      toast: `外部助理発車了「${name}」`,
    };
  },
};

const stopTimeBlock: McpTool = {
  name: "stop-time-block",
  title: "到着（結束計時）",
  description: "到着＝結束運行中的那班。at 省略＝現在；給 at 就結束在那個時刻（不能早於発車、不能晚於現在）。",
  inputSchema: {
    type: "object",
    properties: {
      at: timeProp("到着時刻（省略＝現在）"),
      confirmLong: { type: "boolean", description: "那班跑太久、使用者確認就是到現在時才給 true" },
    },
    additionalProperties: false,
  },
  module: "timetable",
  access: "write",
  annotations: CHANGE,
  async run(a, ctx) {
    const now = ctx.now.getTime();
    const repo = ctx.deps.timetableRepo;
    const at = instant(a, "at");
    const confirmLong = bool(a, "confirmLong");
    const running = await runningBlock(ctx);
    if (!running) return { summary: "現在沒有運行中的班次，沒有變動" };
    const start = msOf(running.started_at);
    if (at !== undefined && at > now + MIN) throw new McpUserError("at 不能晚於現在");
    if (at !== undefined && at < start) throw new McpUserError(`at 不能早於這班的発車時刻 ${localText(start)}`);
    const cats = await categoryMap(ctx);
    const node = nodeCache(ctx);
    if (await isPending(running, cats, node, now, ctx.longRunMaxMin)) {
      // ＝longRun 面板：給了實際到着＝「gap」（結束在那一刻＋記成已確認）；長度沒錯＝「keep」再到着
      if (at !== undefined) await guard(() => repo.resolveLongRun(running.id, isoOf(Math.min(at, now)), "gap"));
      else if (confirmLong) await guard(() => repo.resolveLongRun(running.id, isoOf(now), "keep"));
      else throw longRunAsk(running, cats, now, "");
    }
    if ((await repo.listRunning()).length) {
      await guard(() => repo.arrive(at === undefined ? undefined : isoOf(Math.min(at, now)))); // ＝store arrive
    }
    const done = await repo.getBlock(running.id);
    if (!done) throw new Error("到着之後讀不到那一塊");
    const view = await viewOf(ctx, done, cats, node);
    const name = catName(cats, done.category_id);
    return {
      summary: `到着・${name}　${view.start} → ${view.end}（${view.minutes} 分）`,
      data: { block: view },
      changed: CHANGED,
      toast: `外部助理讓「${name}」到着`,
    };
  },
};

/* ───────── 寫：補記、改、刪 ───────── */

const addTimeBlocks: McpTool = {
  name: "add-time-blocks",
  title: "補記時間塊",
  description:
    "補記已經結束的時間塊（一次最多 50 筆）。start < end ≤ 現在；蓋到既有的紀錄時以新補的為準（舊的會被縮短、切開或蓋掉，回報會說動了幾塊）。超過 12 小時的要先跟使用者確認、再加 confirmLong:true。",
  inputSchema: {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: MCP_BATCH_LIMIT,
        items: {
          type: "object",
          properties: {
            categoryId: { type: "string", description: "分類 id（要選子分類）" },
            start: timeProp("開始"),
            end: timeProp("結束"),
            taskId: { type: "string", description: "連到的車票 id（選填）" },
            confirmLong: { type: "boolean", description: "超過 12 小時、使用者確認過才給 true" },
          },
          required: ["categoryId", "start", "end"],
          additionalProperties: false,
        },
      },
    },
    required: ["blocks"],
    additionalProperties: false,
  },
  module: "timetable",
  access: "write",
  annotations: ADD,
  async run(a, ctx) {
    const now = ctx.now.getTime();
    const items = batch(a, "blocks");
    const cats = await categoryMap(ctx);
    // 先全部驗過再寫（參數錯不會寫一半）
    const plan: { categoryId: string; start: number; end: number; link: BlockLink | null; ack: boolean }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const where = `blocks[${i}]`;
      const categoryId = str(it, "categoryId", { required: true, where });
      usableCategory(cats, categoryId, `${where}.categoryId`);
      const start = instant(it, "start", { required: true, where });
      const end = instant(it, "end", { required: true, where });
      if (!(start < end)) throw new McpUserError(`${where} 的 end 要晚於 start`);
      if (end - start < MIN) throw new McpUserError(`${where} 至少要 1 分鐘`); // ＝BlockPanel：結束夾在 [開始+1 分, 現在]
      if (end > now) throw new McpUserError(`${where} 不能記未來的時間（end 晚於現在）；正在做的事用 start-time-block`);
      const confirmLong = bool(it, "confirmLong", where);
      needLongConfirm(start, end, confirmLong, where);
      const taskId = str(it, "taskId", { where });
      const task = taskId ? await linkableNode(ctx, taskId, `${where}.taskId`) : null;
      // ＝BlockPanel：走「確定記這麼長」存的長塊一併記成已確認（ackLong＝ask && longOk）
      plan.push({ categoryId, start, end, link: task ? { nodeId: task.id, routeId: null } : null, ack: end - start > LONG_BLOCK_MS && !!confirmLong });
    }
    const repo = ctx.deps.timetableRepo;
    const node = nodeCache(ctx);
    let cover = NO_COVER;
    const added: TimeBlockRow[] = [];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      // ＝store fill：fill(分類, 起, 訖, { link, ack: longOk === true })
      const r = await guard(() => repo.fill(p.categoryId, isoOf(p.start), isoOf(p.end), { link: p.link, ack: p.ack }), { index: i, key: "blocks" });
      cover = addCover(cover, r.summary);
      added.push(r.block);
    }
    const blocks = await Promise.all(added.map((r) => viewOf(ctx, r, cats, node)));
    return {
      summary: `補記了 ${added.length} 塊${coverText(cover)}`,
      data: { blocks, covered: cover },
      changed: CHANGED,
      toast: `外部助理補記了 ${added.length} 塊時間`,
    };
  },
};

const updateTimeBlocks: McpTool = {
  name: "update-time-blocks",
  title: "改時間塊",
  description:
    "改時間塊的分類或起訖（一次最多 50 筆；沒給的欄位不動）。運行中的那班只能改分類與 start（要結束用 stop-time-block）。蓋到別塊時以改的這塊為準。改完超過 12 小時的要先跟使用者確認、再加 confirmLong:true。",
  inputSchema: {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: MCP_BATCH_LIMIT,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "時間塊 id（find-time-blocks）" },
            categoryId: { type: "string", description: "新分類 id" },
            start: timeProp("新的開始"),
            end: timeProp("新的結束"),
            confirmLong: { type: "boolean", description: "改完超過 12 小時、使用者確認過才給 true" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["blocks"],
    additionalProperties: false,
  },
  module: "timetable",
  access: "write",
  annotations: CHANGE,
  async run(a, ctx) {
    const now = ctx.now.getTime();
    const repo = ctx.deps.timetableRepo;
    const items = batch(a, "blocks");
    const cats = await categoryMap(ctx);
    type Edit = { id: string; running: boolean; categoryId: string; start: number; end: number; ack?: true };
    const plan: Edit[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const where = `blocks[${i}]`;
      const id = str(it, "id", { required: true, where });
      const cur = await repo.getBlock(id);
      if (!cur) throw new McpUserError(`${where} 找不到這一塊「${id}」`);
      const categoryId = str(it, "categoryId", { where });
      const start = instant(it, "start", { where });
      const end = instant(it, "end", { where });
      if (categoryId === undefined && start === undefined && end === undefined) throw new McpUserError(`${where} 至少要給 categoryId、start、end 其中之一`);
      // 換分類才驗（原本的分類已封存，只改起訖照樣可以；＝BlockPanel 帶著原分類存）
      if (categoryId !== undefined && categoryId !== cur.category_id) usableCategory(cats, categoryId, `${where}.categoryId`);
      const confirmLong = bool(it, "confirmLong", where);
      const s0 = msOf(cur.started_at);
      const s = sameMinute(start, s0) ?? s0;
      if (cur.ended_at === null) {
        // ＝BlockPanel 運行中模式（editRunning）：沒有到着欄；出發不晚於現在−1 分（repository 會夾）、最多往前一天；長塊照問、不寫 ack
        if (end !== undefined) throw new McpUserError(`${where} 是運行中的那班，沒有結束時刻可改；要結束用 stop-time-block`);
        if (s > now) throw new McpUserError(`${where} 的 start 不能晚於現在`);
        if (s < s0 - 24 * 60 * MIN) throw new McpUserError(`${where} 運行中那班的 start 最多往前改 24 小時；更早的那段請用 add-time-blocks 補記`);
        if (s !== s0) needLongConfirm(s, now, confirmLong, where);
        plan.push({ id, running: true, categoryId: categoryId ?? cur.category_id, start: s, end: now });
        continue;
      }
      const e0 = msOf(cur.ended_at);
      const e = sameMinute(end, e0) ?? e0;
      if (!(s < e)) throw new McpUserError(`${where} 的結束要晚於開始（${localText(s)} → ${localText(e)}）`);
      if (e - s < MIN) throw new McpUserError(`${where} 至少要 1 分鐘`);
      // ＝BlockPanel 的 endHi：max(現在, 原本的到着)（別台剛按的到着可能晚一點）
      if (e > Math.max(now, e0)) throw new McpUserError(`${where} 不能記未來的時間（結束晚於現在）`);
      // ＝BlockPanel：改一塊只在起訖動過時問長度；按了「確定記這麼長」才給 ack
      const changed = s !== s0 || e !== e0;
      const ask = changed && e - s > LONG_BLOCK_MS;
      if (changed) needLongConfirm(s, e, confirmLong, where);
      plan.push({ id, running: false, categoryId: categoryId ?? cur.category_id, start: s, end: e, ...(ask && confirmLong ? { ack: true as const } : {}) });
    }
    let cover = NO_COVER;
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const at = { index: i, key: "blocks" };
      const r = p.running
        ? await guard(() => repo.editRunning(p.id, { categoryId: p.categoryId, startIso: isoOf(p.start) }), at)
        : await guard(() => repo.editBlock(p.id, { categoryId: p.categoryId, startIso: isoOf(p.start), endIso: isoOf(p.end), ack: p.ack }), at);
      cover = addCover(cover, r);
    }
    const node = nodeCache(ctx);
    const rows = await Promise.all(plan.map((p) => repo.getBlock(p.id)));
    const blocks = await Promise.all(rows.filter((r): r is TimeBlockRow => r !== null).map((r) => viewOf(ctx, r, cats, node)));
    return {
      summary: `改了 ${plan.length} 塊${coverText(cover)}`,
      data: { blocks, covered: cover },
      changed: CHANGED,
      toast: `外部助理改了 ${plan.length} 塊時間`,
    };
  },
};

const deleteTimeBlocks: McpTool = {
  name: "delete-time-blocks",
  title: "刪除時間塊",
  description: "刪除時間塊（一次最多 50 筆；App 裡可復原）。運行中的那班不能刪，先 stop-time-block。",
  inputSchema: {
    type: "object",
    properties: { ids: { type: "array", minItems: 1, maxItems: MCP_BATCH_LIMIT, items: { type: "string" }, description: "時間塊 id" } },
    required: ["ids"],
    additionalProperties: false,
  },
  module: "timetable",
  access: "write",
  annotations: CHANGE,
  async run(a, ctx) {
    const repo = ctx.deps.timetableRepo;
    const given = idList(a, "ids");
    const ids = Array.from(new Set(given));
    const cats = await categoryMap(ctx);
    const node = nodeCache(ctx);
    const rows: TimeBlockRow[] = [];
    for (const id of ids) {
      const i = given.indexOf(id); // 錯誤訊息的位置照助理送來的陣列
      const r = await repo.getBlock(id);
      if (!r) throw new McpUserError(`ids[${i}] 找不到這一塊「${id}」`);
      // ＝BlockPanel 運行中模式：不給刪除
      if (r.ended_at === null) throw new McpUserError(`ids[${i}] 是運行中的那班，不能刪；先用 stop-time-block 讓它到着`);
      rows.push(r);
    }
    const views = await Promise.all(rows.map((r) => viewOf(ctx, r, cats, node)));
    for (let i = 0; i < ids.length; i++) await guard(() => repo.softDelete(ids[i]), { index: i, key: "ids" }); // ＝store deleteBlock
    return {
      summary: `刪除了 ${ids.length} 塊（App 裡可復原）`,
      data: { deleted: views.map((v) => ({ id: v.id, category: v.category, start: v.start, end: v.end })) },
      changed: CHANGED,
      toast: `外部助理刪除了 ${ids.length} 塊時間`,
      // 同 timetableStore 刪塊 toast 的「復原」：逐塊 restore（復原的那塊視為最新，蓋到的照補記規則）
      undo: async () => {
        for (const id of ids) await repo.restore(id);
        return CHANGED;
      },
    };
  },
};

export const TIMETABLE_TOOLS: McpTool[] = [
  findTimeBlocks,
  findTimeCategories,
  getTimeStats,
  startTimeBlock,
  stopTimeBlock,
  addTimeBlocks,
  updateTimeBlocks,
  deleteTimeBlocks,
];
