/**
 * 外部助理（MCP）——方針的工具（方針擴充 辛 D-主-381；契約 `docs/research/2026-11-04-主線-方針擴充-契約.md`；module 'tasks'）。
 *
 * 助理只講「期間＋日期」或「車站 id」，期間鍵（`M2026-11` 這些）在這裡換算，不出現在參數與回傳。
 * 只呼叫 `ctx.deps.weekAimRepo`，寫入照寫方針框的路（`planSaveWeek` → `saveWeek`，同 weekAimStore.saveWeek；讀完現況馬上寫、中間沒有空檔，所以不帶 base）：
 * 五句上限、60 字、字的正規化都不另算；repository 與純函式的 RangeError 轉成 `McpUserError` 原文給助理。
 * 掛的路線或支線被刪了照 App：標籤消失、句子留著（§3 #16）。
 */
import type { NodeRow } from "../../domain";
import {
  AIM_ATTACH_KINDS,
  AIM_TEXT_MAX,
  MAX_AIMS,
  aimsOfKey,
  checkAimText,
  doneCount,
  keyRowBounds,
  monthKeyOf,
  nextStationsOfRoutes,
  periodOfKey,
  periodRangeOf,
  periodTitle,
  planSaveWeek,
  stationIdOfKey,
  stationKeyOf,
  weekOnOf,
  yearKeyOf,
  type AimDraft,
  type AimPeriod,
  type WeekAimRow,
} from "../../domain/weekAims";
import { uuid } from "../../lib/db";
import { bool, date, nullableStr, oneOf, str } from "../args";
import { McpUserError, type McpCtx, type McpTool } from "../types";
import { compact, strictArgs } from "./tasks";

type Args = Record<string, unknown>;

const PERIODS: readonly AimPeriod[] = ["week", "month", "year", "station"];
const CHANGED = ["week_aims"] as const;

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

/** repository 與純函式的「輸入不合法」一律 RangeError：轉成助理看得到的錯 */
async function userErrors<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof RangeError) throw new McpUserError(e.message);
    throw e;
  }
}

/** 一期活著的句子（同 weekAimStore：週走區間，兩台週首設定不同也撈得到；其他等於鍵） */
async function aimsIn(ctx: McpCtx, key: string): Promise<WeekAimRow[]> {
  const { from, to } = keyRowBounds(key);
  return aimsOfKey(await ctx.deps.weekAimRepo.listRange(from, to), key);
}

/** 一列的期間鍵：週的 week_on 是寫的當下的週首，換算成現在的週首才跟畫面同一週 */
function keyOfRow(row: WeekAimRow, ctx: McpCtx): string {
  return periodOfKey(row.week_on) === "week" ? weekOnOf(row.week_on, ctx.weekStart) : row.week_on;
}

function dayKeyOf(period: Exclude<AimPeriod, "station">, day: string, ctx: McpCtx): string {
  if (period === "month") return monthKeyOf(day);
  if (period === "year") return yearKeyOf(day);
  return weekOnOf(day, ctx.weekStart);
}

async function aliveStation(ctx: McpCtx, id: string): Promise<NodeRow> {
  const n = await ctx.deps.nodeRepo.getNode(id);
  if (!n || n.deleted_at !== null || n.kind !== "station") throw new McpUserError(`找不到車站 ${id}`);
  return n;
}

/** 這一次呼叫的節點快取（同一條路線掛好幾句不重查） */
function nodeLookup(ctx: McpCtx): (id: string) => Promise<NodeRow | null> {
  const seen = new Map<string, Promise<NodeRow | null>>();
  return (id) => {
    let p = seen.get(id);
    if (!p) {
      p = ctx.deps.nodeRepo.getNode(id).then((n) => (n && n.deleted_at === null ? n : null));
      seen.set(id, p);
    }
    return p;
  };
}

type Lookup = ReturnType<typeof nodeLookup>;

/** 一句的精簡樣子 */
async function briefAim(row: WeekAimRow, nodeOf: Lookup) {
  const node = row.node_id ? await nodeOf(row.node_id) : null;
  const route = node?.route_id && node.kind !== "route" ? await nodeOf(node.route_id) : null;
  return compact({
    id: row.id,
    text: row.text,
    done: row.done_at !== null,
    doneAt: row.done_at,
    attachedTo: node ? compact({ id: node.id, kind: node.kind, name: node.name, route: route?.name }) : null,
  });
}

/** 一期的樣子：週、月、年帶範圍；車站帶站名與所屬路線 */
async function briefPeriod(key: string, ctx: McpCtx, nodeOf: Lookup) {
  const period = periodOfKey(key);
  const aims = await aimsIn(ctx, key);
  const { done, total } = doneCount(aims);
  const stationId = stationIdOfKey(key);
  const head: Record<string, unknown> = { period, title: periodTitle(key, ctx.today, ctx.weekStart).title };
  if (stationId) {
    const st = await nodeOf(stationId);
    const route = st?.parent_id ? await nodeOf(st.parent_id) : null;
    head.station = st ? compact({ id: st.id, name: st.name, route: route?.name, routeId: route?.id, expectedOn: st.expected_on, arrivedOn: st.arrived_on }) : { id: stationId };
  } else {
    Object.assign(head, periodRangeOf(key));
  }
  return { ...head, done, total, aims: await Promise.all(aims.map((a) => briefAim(a, nodeOf))) };
}

/** 各條還在跑的路線的下一站（`listSidebar` 的車站已照兄弟順序） */
async function nextStationKeys(ctx: McpCtx): Promise<string[]> {
  const { routes, stations } = await ctx.deps.nodeRepo.listSidebar();
  return nextStationsOfRoutes(routes.filter((r) => r.arrived_on === null), stations).map(({ station }) => stationKeyOf(station.id));
}

// ───────────── 讀 ─────────────

const listAims: McpTool = {
  name: "list-aims",
  title: "看方針",
  description:
    "看方針（aim）：使用者替一段時間定的幾句大方向，不是車票。期間有週、月、年與車站（里程碑）。回句子、済不済、掛的路線或支線、期間範圍。什麼都不給＝這週、這個月、今年，加上各路線下一站有寫的。period＋date＝date 落在的那一期；只給 date＝那天的週、月、年。period:station＝各路線的下一站（沒寫的也列，附車站 id）；routeId＝改列那條路線的每一站；stationId＝只看那一站。",
  inputSchema: {
    type: "object",
    properties: {
      period: { type: "string", enum: PERIODS, description: "哪一種期間：week 週／month 月／year 年／station 車站" },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "落在哪一期的任一天 YYYY-MM-DD，預設今天（車站不用）" },
      stationId: { type: "string", description: "只看這個車站" },
      routeId: { type: "string", description: "period:station 時改列這條路線的每一站（路線 id 由 find-routes 取得）" },
    },
    additionalProperties: false,
  },
  module: "tasks",
  access: "read",
  annotations: READ,
  async run(args, ctx) {
    const period = oneOf(args, "period", PERIODS);
    const day = date(args, "date");
    const stationId = str(args, "stationId") || undefined;
    const routeId = str(args, "routeId") || undefined;
    if (day && (stationId || routeId || period === "station")) throw new McpUserError("車站的方針不看日期：date 不能跟 stationId、routeId、period:station 一起給");
    if ((stationId || routeId) && period && period !== "station") throw new McpUserError("stationId、routeId 只能配 period:station");
    if (stationId && routeId) throw new McpUserError("stationId 和 routeId 只給一個");

    const nodeOf = nodeLookup(ctx);
    let keys: string[];
    let hideEmpty: readonly string[] = [];
    if (stationId) {
      keys = [stationKeyOf((await aliveStation(ctx, stationId)).id)];
    } else if (routeId) {
      const route = await ctx.deps.nodeRepo.getNode(routeId);
      if (!route || route.deleted_at !== null || route.kind !== "route") throw new McpUserError(`找不到路線 ${routeId}`);
      const { stations } = await ctx.deps.nodeRepo.listSidebar();
      keys = stations.filter((s) => s.parent_id === route.id).map((s) => stationKeyOf(s.id));
    } else if (period === "station") {
      keys = await nextStationKeys(ctx);
    } else if (period) {
      keys = [dayKeyOf(period, day ?? ctx.today, ctx)];
    } else {
      const on = day ?? ctx.today;
      keys = (["week", "month", "year"] as const).map((p) => dayKeyOf(p, on, ctx));
      if (!day) {
        // 預設那一份不列沒寫的車站：路線一多全是空殼
        hideEmpty = await nextStationKeys(ctx);
        keys = [...keys, ...hideEmpty];
      }
    }
    const all = await Promise.all(keys.map((k) => briefPeriod(k, ctx, nodeOf)));
    const data = all.filter((p, i) => p.total > 0 || !hideEmpty.includes(keys[i]));
    const total = data.reduce((n, p) => n + p.total, 0);
    const done = data.reduce((n, p) => n + p.done, 0);
    return { summary: `${data.length} 個期間、${total} 句方針（済 ${done}）`, data };
  },
};

// ───────────── 寫 ─────────────

/** 新增時的期間：`period`＋`date`，或車站 `stationId`（`period` 可省） */
async function keyFromArgs(args: Args, ctx: McpCtx): Promise<string> {
  const stationId = str(args, "stationId") || undefined;
  const day = date(args, "date");
  const period = oneOf(args, "period", PERIODS) ?? (stationId ? "station" : undefined);
  if (!period) throw new McpUserError("新增方針要給 period（week／month／year），或 stationId（車站）");
  if (period === "station") {
    if (!stationId) throw new McpUserError("period:station 要給 stationId（list-aims 帶 period:station 取得）");
    if (day) throw new McpUserError("車站的方針不看日期，不用給 date");
    return stationKeyOf((await aliveStation(ctx, stationId)).id);
  }
  if (stationId) throw new McpUserError("stationId 只能配 period:station");
  return dayKeyOf(period, day ?? ctx.today, ctx);
}

/** 掛的地方：路線或支線（D-主-281）；其他一律回錯，寫方針框也只挑得到這兩種 */
async function attachedNode(ctx: McpCtx, id: string): Promise<string> {
  const n = await ctx.deps.nodeRepo.getNode(id);
  if (!n || n.deleted_at !== null || !AIM_ATTACH_KINDS.includes(n.kind)) throw new McpUserError(`找不到路線或支線 ${id}（方針只能掛路線或支線）`);
  return n.id;
}

const draftOf = (r: WeekAimRow): AimDraft => ({ id: r.id, text: r.text, nodeId: r.node_id, carriedFrom: r.carried_from });

const saveAim: McpTool = {
  name: "save-aim",
  title: "寫方針",
  description: `新增或修改一句方針。新增：給 text＋period（week／month／year；date＝落在那一期的任一天，預設今天）；車站的方針改給 stationId（list-aims 帶 period:station 取得）。修改：給 id（list-aims 取得）＋要改的 text 或 attachTo。attachTo＝掛的路線或支線 id（find-routes、find-tasks 取得），null＝取下。一期最多 ${MAX_AIMS} 句、一句最多 ${AIM_TEXT_MAX} 字。方針不是車票；要排事情用 add-tasks。`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "要改的那一句；不給＝新增" },
      text: { type: "string", description: `句子，最多 ${AIM_TEXT_MAX} 字；新增時必填` },
      period: { type: "string", enum: PERIODS, description: "新增到哪一種期間：week 週／month 月／year 年／station 車站" },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "落在哪一期的任一天 YYYY-MM-DD，預設今天（車站不用）" },
      stationId: { type: "string", description: "新增到這個車站" },
      attachTo: { type: ["string", "null"], description: "掛的路線或支線 id；null＝取下；不給＝不動" },
    },
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const repo = ctx.deps.weekAimRepo;
    const id = str(args, "id") || undefined;
    const rawText = str(args, "text");
    const rawAttach = nullableStr(args, "attachTo");
    const attachTo = rawAttach === undefined || rawAttach === null ? rawAttach : await attachedNode(ctx, rawAttach);
    // 草稿裡空字的列會被當成刪除（planSaveWeek），一定要先擋
    const text = rawText === undefined ? undefined : await userErrors(() => checkAimText(rawText));
    const nodeOf = nodeLookup(ctx);

    if (id) {
      if (args.period !== undefined || args.date !== undefined || args.stationId !== undefined) {
        throw new McpUserError("修改只要給 id；方針不能換到別的期間");
      }
      if (text === undefined && attachTo === undefined) throw new McpUserError("修改至少給 text 或 attachTo 其中一個");
      const row = await repo.getAim(id);
      if (!row) throw new McpUserError(`找不到方針 ${id}`);
      const key = keyOfRow(row, ctx);
      const before = await aimsIn(ctx, key);
      const drafts = before.map((r) =>
        r.id === id ? { ...draftOf(r), text: text ?? r.text, nodeId: attachTo === undefined ? r.node_id : attachTo } : draftOf(r),
      );
      const plan = await userErrors(() => planSaveWeek(before, drafts, key));
      if (!plan.updates.some((u) => u.id === id)) {
        return { summary: `「${row.text}」沒有變動`, data: await briefAim(row, nodeOf) };
      }
      await userErrors(() => repo.saveWeek(key, plan));
      const after = (await repo.getAim(id)) ?? row;
      return {
        summary: `改了一句方針：「${after.text}」`,
        data: await briefAim(after, nodeOf),
        changed: CHANGED,
        toast: "外部助理修改了一句方針",
      };
    }

    if (text === undefined) throw new McpUserError("新增方針要給 text");
    const key = await keyFromArgs(args, ctx);
    const current = await aimsIn(ctx, key);
    const newId = uuid();
    const plan = await userErrors(() =>
      planSaveWeek(current, [...current.map(draftOf), { id: newId, text, nodeId: attachTo ?? null, carriedFrom: null }], key),
    );
    await userErrors(() => repo.saveWeek(key, plan));
    const row = await repo.getAim(newId);
    const { title } = periodTitle(key, ctx.today, ctx.weekStart);
    return {
      summary: `${title}多了一句：「${text}」（${current.length + 1}/${MAX_AIMS}）`,
      data: { period: periodOfKey(key), title, ...(row ? await briefAim(row, nodeOf) : { id: newId, text }) },
      changed: CHANGED,
      toast: "外部助理寫了一句方針",
    };
  },
};

const setAimDone: McpTool = {
  name: "set-aim-done",
  title: "蓋方針的済",
  description: "替一句方針蓋済，或取消（done:false）。方針的済跟車票分開：蓋了不會動到底下的車票。id 由 list-aims 取得。",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "方針 id" },
      done: { type: "boolean", description: "true 蓋済（預設）；false 取消" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const repo = ctx.deps.weekAimRepo;
    const id = str(args, "id", { required: true });
    const want = bool(args, "done") !== false;
    const row = await repo.getAim(id);
    if (!row) throw new McpUserError(`找不到方針 ${id}`);
    const nodeOf = nodeLookup(ctx);
    if ((row.done_at !== null) === want) {
      return { summary: `「${row.text}」${want ? "本來就済了" : "本來就還沒済"}`, data: await briefAim(row, nodeOf) };
    }
    await userErrors(() => repo.setDone(id, want ? ctx.now.toISOString() : null));
    const after = (await repo.getAim(id)) ?? row;
    return {
      summary: `「${after.text}」${want ? "蓋了済" : "取消了済"}`,
      data: await briefAim(after, nodeOf),
      changed: CHANGED,
      toast: `外部助理${want ? "替一句方針蓋了済" : "取消了一句方針的済"}`,
    };
  },
};

export const AIM_TOOLS: McpTool[] = [listAims, saveAim, setAimDone].map(strictArgs);
