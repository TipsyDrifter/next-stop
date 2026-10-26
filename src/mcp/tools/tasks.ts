/**
 * 外部助理（MCP）——任務模組的工具（契約 §4「任務」列；module 'tasks'）。
 *
 * 只呼叫 `ctx.deps.nodeRepo`，參數照 UI 怎麼叫就怎麼叫（出處 `src/store/nodeStore.ts`）：
 * dateKey＝ctx.today、dayStartHour＝ctx.dayStartHour。store／UI 裡 repository 之外的規則（cascade 要先問、
 * 推遲挑不到過去、運休中的班不能直接蓋済…）在這裡重現，註解標出處。
 * 寫入一律「先整批驗參數形狀（錯＝整次拒絕）→ 逐筆執行（各自成敗）」；全部失敗才回 McpUserError。
 */
import type { NodeKind, NodeRow, Priority } from "../../domain";
import { KIND_LABEL, WORK_LOG_EVENT_LABEL, allowedChildKinds, describeConflict, describeRule, parseRule } from "../../domain";
import { effectiveTime, assertClockWritable } from "../../domain/scheduledTime";
import type { CurrentOccurrence, NodePatch } from "../../data/nodeRepository";
import { REPEAT_ONLY_MSG } from "../../data/nodeRepository";
import { batch, bool, checkKeys, date, idList, int, nullableClock, nullableDate, nullableStr, oneOf, range, str } from "../args";
import { McpUserError, type McpCtx, type McpTool } from "../types";

type Args = Record<string, unknown>;

/** 清單類回傳的上限 */
const LIST_LIMIT = 100;
/** 任務工具認得的節點（幹線／路線看 find-routes；車站不是任務） */
const TASK_KINDS: readonly NodeKind[] = ["branch", "train", "car", "ticket"];
/** 有執行日的身分（支線沒有執行日） */
const DATED_KINDS: readonly NodeKind[] = ["train", "car", "ticket"];
const PRIORITIES: readonly Priority[] = ["low", "mid", "high"];
const STATUSES = ["todo", "doing", "done", "paused", "open"] as const;

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const ADD = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const ID_SCHEMA = { type: "string", description: "車票 id" } as const;
const DATE_SCHEMA = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const CLOCK_SCHEMA = { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" } as const;

// ───────────── 共用小工具（schedule.ts 也用）─────────────

/** 丟掉 null／undefined／false 的欄位（給模型讀的 JSON 越短越好） */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== false) out[k] = v;
  return out as Partial<T>;
}

/** 存活的任務節點；不存在、已刪、不是任務（含別的模組的 id）一律「找不到」 */
export async function aliveTask(ctx: McpCtx, id: string, kinds: readonly NodeKind[] = TASK_KINDS): Promise<NodeRow> {
  const n = await ctx.deps.nodeRepo.getNode(id);
  if (!n || n.deleted_at !== null || !TASK_KINDS.includes(n.kind)) throw new McpUserError(`找不到車票 ${id}`);
  // 支線找得到、只是沒有執行日（說清楚，助理才不會以為 id 錯了）
  if (!kinds.includes(n.kind)) throw new McpUserError(`「${n.name}」是${KIND_LABEL[n.kind]}，沒有執行日與班次`);
  return n;
}

/** 給工具套上欄位檢查（schedule.ts 也用） */
export function strictArgs(t: McpTool): McpTool {
  return {
    ...t,
    async run(args, ctx) {
      checkKeys(args, t.inputSchema);
      return t.run(args, ctx);
    },
  };
}

/** 一張票的精簡樣子；定期券帶規則與目前班次的結局 */
export function brief(n: NodeRow, cur?: Record<string, CurrentOccurrence>, routeNames?: Record<string, string>) {
  const rule = parseRule(n.repeat_rule);
  const run = cur?.[n.id];
  return compact({
    id: n.id,
    kind: n.kind,
    name: n.name,
    status: n.status,
    scheduledOn: n.scheduled_on,
    time: effectiveTime(n, n.scheduled_on),
    dueOn: n.due_on,
    priority: n.priority,
    repeat: rule ? describeRule(rule) : null,
    run: run ? { date: run.due_on, status: run.status } : null,
    route: n.route_id ? (routeNames?.[n.route_id] ?? n.route_id) : null,
    routeId: n.route_id,
    parentId: n.parent_id,
  });
}

async function routeNameMap(ctx: McpCtx): Promise<Record<string, string>> {
  const { routes } = await ctx.deps.nodeRepo.listSidebar();
  return Object.fromEntries(routes.map((r) => [r.id, r.name]));
}

/** 子孫（不含自己）；只有掛在路線大綱裡的節點會有子項 */
async function descendantsOf(ctx: McpCtx, n: NodeRow): Promise<NodeRow[]> {
  const routeId = n.kind === "route" ? n.id : n.route_id;
  if (!routeId) return [];
  const rows = await ctx.deps.nodeRepo.listRouteTree(routeId);
  const out: NodeRow[] = [];
  const stack = [n.id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const r of rows) if (r.parent_id === cur) (out.push(r), stack.push(r.id));
  }
  return out;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ItemResult {
  ok: boolean;
  id?: string;
  error?: string;
  [k: string]: unknown;
}

/** 逐筆執行；全部失敗才整次回錯（模型看得到每一筆的原因） */
export async function runEach<T>(items: T[], fn: (item: T, i: number) => Promise<ItemResult>): Promise<ItemResult[]> {
  const out: ItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      out.push(await fn(items[i], i));
    } catch (e) {
      const id = (items[i] as { id?: unknown })?.id;
      out.push({ ok: false, ...(typeof id === "string" ? { id } : {}), error: errMsg(e) });
    }
  }
  if (out.every((r) => !r.ok)) {
    throw new McpUserError(out.map((r, i) => `第 ${i + 1} 筆：${r.error}`).join("；"));
  }
  return out;
}

function tally(results: ItemResult[]): { ok: number; failed: number; tail: string } {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return { ok, failed, tail: failed ? `，${failed} 筆失敗（見 results）` : "" };
}

/** 時刻寫入前的驗證（與 repository 同一句 TIME_FORMAT_MSG），轉成助理看得懂的錯 */
function assertClock(time: string | null | undefined, ctx: McpCtx, where: string): void {
  try {
    assertClockWritable(time, ctx.dayStartHour);
  } catch (e) {
    throw new McpUserError(`${where}：${errMsg(e)}（日界線 ${ctx.dayStartHour}:00）`);
  }
}

/** 退役的定期券（跟著上層一起完成，status='done'）：不再排班，要復活走 complete-tasks done:false（同側板取消完成） */
const RETIRED_MSG = (name: string) => `「${name}」這張定期券已經跟著上層一起完成、不再排班；要讓它繼續排班先用 complete-tasks（done:false）`;

// ───────────── 改期的唯一一條路（reschedule-tasks 與 apply-schedule 共用）─────────────

export interface RescheduleItem {
  id: string;
  /** null＝清掉執行日 */
  date: string | null;
  /** undefined＝時刻不動；null＝清掉 */
  time?: string | null;
}

/**
 * 驗一筆改期能不能做（不寫）。規則出處：
 * - 推遲挑不到過去（DeferPopover 的 min＝今天，主線車次① ☎4）；補記（D-主-67）只給 UI 日期欄，工具不帶 backfill。
 *   日期跟現值一樣＝不動日期（pickDay.ts 第 3 條：誤點票挑回它自己那天不算補記），只改時刻照樣可以。
 * - 已済的單發票不能推遲（pickDay.ts 第 1 條 SETTLED_DEFER_MSG；推遲小卡也擋）。
 * - 定期券的班次由規則排定（repository 的 REPEAT_RESCHEDULE_MSG）；只能改「目前這一班」的時刻（setRunTime）。
 */
export function checkReschedule(ctx: McpCtx, n: NodeRow, it: RescheduleItem): void {
  const moves = it.date !== n.scheduled_on;
  if (moves && it.date !== null && it.date < ctx.today) {
    throw new McpUserError(`不能排到今天（${ctx.today}）以前——改期只能往後排；過去的事請在 App 的日期欄補記`);
  }
  if (it.time !== undefined) assertClock(it.time, ctx, "time");
  const rule = parseRule(n.repeat_rule);
  if (!rule && moves && n.status === "done") {
    throw new McpUserError(`「${n.name}」已済——先用 complete-tasks（done:false）取消済章才能改期`);
  }
  if (rule) {
    if (n.status === "done") throw new McpUserError(RETIRED_MSG(n.name));
    if (moves || it.date === null || it.time === undefined) {
      throw new McpUserError(
        `「${n.name}」是定期券，班次由規則排定、不能改日期；只能帶目前班次日（${n.scheduled_on ?? "無"}）改這一班的時刻，跳過這一班用 skip-tasks`,
      );
    }
  }
}

/** 執行一筆改期：單發票走 reschedule（繰越、今日序照 repository）＋update 時刻；定期券只改這一班的時刻 */
export async function applyReschedule(ctx: McpCtx, n: NodeRow, it: RescheduleItem): Promise<ItemResult> {
  checkReschedule(ctx, n, it);
  const repo = ctx.deps.nodeRepo;
  const from = { date: n.scheduled_on, time: effectiveTime(n, n.scheduled_on) };
  if (parseRule(n.repeat_rule)) {
    // 同 nodeStore.setRunTime：給這一班設時刻（null＝本班無時刻）
    await repo.setRunTime(n.id, it.date!, it.time ?? null, ctx.dayStartHour);
  } else {
    // 同 nodeStore.reschedule（推遲／T／日期 chip 的唯一入口；不帶 backfill）
    if (it.date !== n.scheduled_on) await repo.reschedule(n.id, it.date, ctx.today);
    // 同 nodeStore.updateNode 的 scheduled_time：帶 dateKey／dayStartHour
    if (it.time !== undefined && it.time !== n.scheduled_time) {
      await repo.update(n.id, { scheduled_time: it.time }, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
    }
  }
  const after = (await repo.getNode(n.id)) ?? n;
  return {
    ok: true,
    id: n.id,
    name: n.name,
    from: compact(from),
    to: compact({ date: after.scheduled_on, time: effectiveTime(after, after.scheduled_on) }),
    ...compact({ carriedFrom: after.carried_from !== n.carried_from ? after.carried_from : null }),
  };
}

/** 一筆改期的參數；idKey＝reschedule-tasks 用 id、propose-schedule 用 taskId */
export function parseRescheduleItem(a: Args, where: string, idKey = "id"): RescheduleItem {
  const id = str(a, idKey, { required: true, where });
  if (a.date === undefined) throw new McpUserError(`缺少 ${where}.date（要清掉執行日請給 null）`);
  const d = nullableDate(a, "date", where);
  const time = nullableClock(a, "time", where);
  return { id, date: d ?? null, ...(time !== undefined ? { time } : {}) };
}

// ───────────── 讀 ─────────────

const findRoutes: McpTool = {
  name: "find-routes",
  title: "列出路線",
  description: "列出幹線與底下的路線（路線＝project），附進度（任務済數／總數、車站到站數）。要看某條路線的車票用 find-tasks 帶 routeId。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  module: "tasks",
  access: "read",
  annotations: READ,
  async run(_args, ctx) {
    const repo = ctx.deps.nodeRepo;
    const { lines, routes } = await repo.listSidebar();
    const shown = routes.slice(0, LIST_LIMIT);
    const progress = await Promise.all(shown.map((r) => repo.routeProgress(r.id)));
    const byLine = new Map<string | null, unknown[]>();
    shown.forEach((r, i) => {
      const p = progress[i];
      const entry = compact({
        id: r.id,
        name: r.name,
        code: r.code,
        status: r.status !== "todo" ? r.status : null,
        tasks: `${p.nodes_done}/${p.nodes_total}`,
        stations: p.stations_total ? `${p.stations_arrived}/${p.stations_total}` : null,
      });
      const key = r.parent_id;
      byLine.set(key, [...(byLine.get(key) ?? []), entry]);
    });
    const data = lines.map((l) => ({ id: l.id, name: l.name, routes: byLine.get(l.id) ?? [] }));
    const cut = routes.length > shown.length ? `（只列前 ${LIST_LIMIT} 條）` : "";
    return { summary: `${lines.length} 條幹線、${routes.length} 條路線${cut}`, data };
  },
};

const findTasks: McpTool = {
  name: "find-tasks",
  title: "找車票",
  description:
    "依關鍵字（票名）、路線、狀態找車票（車票＝task，也含列車／車廂／支線）。至少給 query、routeId、inbox 其中一個；inbox:true＝收件匣（沒排日期、沒掛路線的票）。status：todo／doing／done（済）／paused／open（未済）。定期券的 run＝目前這一班的結局。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "票名關鍵字" },
      routeId: { type: "string", description: "路線 id（find-routes 取得）" },
      inbox: { type: "boolean", description: "只看收件匣" },
      status: { type: "string", enum: STATUSES, description: "狀態過濾" },
      limit: { type: "integer", minimum: 1, maximum: LIST_LIMIT, description: `最多幾筆，預設 50、上限 ${LIST_LIMIT}` },
    },
    additionalProperties: false,
  },
  module: "tasks",
  access: "read",
  annotations: READ,
  async run(args, ctx) {
    const repo = ctx.deps.nodeRepo;
    const query = str(args, "query") || undefined;
    const routeId = str(args, "routeId") || undefined;
    const inbox = bool(args, "inbox") === true;
    const status = oneOf(args, "status", STATUSES);
    const limit = int(args, "limit", { min: 1, max: LIST_LIMIT }) ?? 50;
    if (!query && !routeId && !inbox) throw new McpUserError("至少給 query、routeId 或 inbox:true 其中一個");

    // 幾個條件各撈一份再取交集（順序＝第一份的：路線大綱序／收件匣新→舊／搜尋最近改過的先）
    const sets: NodeRow[][] = [];
    if (routeId) {
      const route = await repo.getNode(routeId);
      if (!route || route.deleted_at !== null || route.kind !== "route") throw new McpUserError(`找不到路線 ${routeId}`);
      sets.push(await repo.listRouteTree(routeId)); // 含掛這條路線標籤的臨時車票
    }
    if (inbox) sets.push(await repo.listInboxTickets());
    if (query) sets.push(await repo.search(query, 500));
    const rest = sets.slice(1).map((x) => new Set(x.map((r) => r.id)));
    let hits = sets[0].filter((r) => TASK_KINDS.includes(r.kind) && rest.every((ids) => ids.has(r.id)));
    if (status === "open") hits = hits.filter((r) => r.status !== "done");
    else if (status) hits = hits.filter((r) => r.status === status);

    const [cur, names] = await Promise.all([repo.listCurrentOccurrences(ctx.today, ctx.dayStartHour), routeNameMap(ctx)]);
    const shown = hits.slice(0, limit);
    const cut = hits.length > shown.length ? `，只列前 ${shown.length} 筆（共 ${hits.length}）` : "";
    return { summary: `找到 ${hits.length} 張${cut}`, data: shown.map((r) => brief(r, cur, names)) };
  },
};

/** 一次最多查幾天 */
const RANGE_MAX_DAYS = 62;
/** 區間的班次最多列幾筆 */
const ENTRY_LIMIT = 300;

const findTasksByDate: McpTool = {
  name: "find-tasks-by-date",
  title: "看行程",
  description:
    `看某段日期（最多 ${RANGE_MAX_DAYS} 天）每天排了哪些車票，含定期券每一班；status：open／done（済）／skipped（運休）／late（誤點＝日子過了還沒済）。區間含今天時另列今天的誤點與到期締切。dues＝締切落在區間的未済票。`,
  inputSchema: {
    type: "object",
    properties: {
      from: { ...DATE_SCHEMA, description: "起日 YYYY-MM-DD" },
      to: { ...DATE_SCHEMA, description: "迄日 YYYY-MM-DD（含）" },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "read",
  annotations: READ,
  async run(args, ctx) {
    const repo = ctx.deps.nodeRepo;
    const { from, to } = range(args, "from", "to", RANGE_MAX_DAYS);
    const h = ctx.dayStartHour;
    // 同 nodeStore.loadCalendar／loadToday：先把定期券的班次推到位（lazy 同步，冪等）
    await repo.syncRepeats(ctx.today, h);
    const cal = await repo.listCalendar(from, to, { todayDateKey: ctx.today, dayStartHour: h });
    const names = await routeNameMap(ctx);
    const days: { date: string; tasks: unknown[] }[] = [];
    const entries = cal.entries.slice(0, ENTRY_LIMIT);
    for (const e of entries) {
      const n = cal.nodes[e.node_id];
      if (!n) continue;
      let day = days[days.length - 1];
      if (!day || day.date !== e.date) days.push((day = { date: e.date, tasks: [] }));
      day.tasks.push(
        compact({
          id: n.id,
          name: n.name,
          kind: n.kind !== "ticket" ? n.kind : null,
          time: e.time,
          status: e.is_done ? "done" : e.occurrence_status === "skipped" ? "skipped" : e.is_late ? "late" : "open",
          repeat: e.kind === "repeat",
          route: n.route_id ? (names[n.route_id] ?? null) : null,
        }),
      );
    }
    const dues = cal.dues.slice(0, LIST_LIMIT).map((d) => ({ date: d.date, id: d.node_id, name: cal.nodes[d.node_id]?.name ?? "" }));

    let late: unknown[] | undefined;
    if (from <= ctx.today && ctx.today <= to) {
      const today = await repo.listToday(ctx.today, h);
      late = today
        .filter((r) => r.bucket === "late" || r.bucket === "due")
        .slice(0, LIST_LIMIT)
        .map((r) =>
          r.bucket === "late"
            ? { id: r.id, name: r.name, scheduledOn: r.occurrence?.due_on ?? r.scheduled_on }
            : { id: r.id, name: r.name, dueOn: r.due_on },
        );
    }
    const cut = cal.entries.length > entries.length ? `（只列前 ${ENTRY_LIMIT} 筆，請縮小區間）` : "";
    const dueCut = cal.dues.length > dues.length ? `（只列前 ${LIST_LIMIT} 張）` : "";
    const lateText = late ? `；今天誤點／到期 ${late.length} 張` : "";
    return {
      summary: `${from}～${to} 共 ${cal.entries.length} 班${cut}、締切 ${cal.dues.length} 張${dueCut}${lateText}`,
      data: compact({ days, dues: dues.length ? dues : null, late }),
    };
  },
};

const WORKLOG_LIMIT = 30;

const getTask: McpTool = {
  name: "get-task",
  title: "車票詳情",
  description: "一張車票（或列車／車廂／支線）的詳情：欄位、說明、定期券規則與目前班次、直屬子項、最近的作業記錄（手記與発券／入鋏／済事件）。",
  inputSchema: { type: "object", properties: { id: ID_SCHEMA }, required: ["id"], additionalProperties: false },
  module: "tasks",
  access: "read",
  annotations: READ,
  async run(args, ctx) {
    const repo = ctx.deps.nodeRepo;
    const n = await aliveTask(ctx, str(args, "id", { required: true }));
    const [cur, names, desc, logs] = await Promise.all([
      repo.listCurrentOccurrences(ctx.today, ctx.dayStartHour),
      routeNameMap(ctx),
      descendantsOf(ctx, n),
      repo.listWorkLogs(n.id),
    ]);
    const parent = n.parent_id ? await repo.getNode(n.parent_id) : null;
    const children = desc.filter((c) => c.parent_id === n.id);
    const data = {
      ...brief(n, cur, names),
      ...compact({
        parent: parent && parent.deleted_at === null ? { id: parent.id, kind: parent.kind, name: parent.name } : null,
        description: n.description,
        estimateMin: n.estimate_min,
        carriedFrom: n.carried_from,
        completedAt: n.completed_at,
      }),
      children: children.slice(0, LIST_LIMIT).map((c) => brief(c, cur, names)),
      openDescendants: desc.filter((c) => c.status !== "done").length,
      workLogs: logs.slice(0, WORKLOG_LIMIT).map((l) =>
        compact({
          at: l.logged_at,
          event: l.event ? WORK_LOG_EVENT_LABEL[l.event] : null,
          body: l.event === "conflict" ? describeConflict(l.body) : l.body || null,
        }),
      ),
    };
    return { summary: `「${n.name}」：${children.length} 個直屬子項、${logs.length} 筆作業記錄`, data };
  },
};

// ───────────── 寫 ─────────────

const CHANGED_NODES = ["nodes", "work_logs"] as const;
const CHANGED_RUNS = ["nodes", "work_logs", "occurrences"] as const;

interface AddItem {
  name: string;
  kind: NodeKind;
  parentId: string | null;
  routeId: string | null;
  scheduledOn: string | null;
  description: string | null;
  /** 建好之後再補的欄位（create 不收這些） */
  patch: NodePatch;
}

const addTasks: McpTool = {
  name: "add-tasks",
  title: "建立車票",
  description:
    "建立車票（最多 50 張）。不給 parentId＝臨時車票，可用 routeId 掛路線標籤；要放進路線大綱用 parentId（路線底下放 train 列車，列車／車廂底下放 ticket 或 car）。scheduledOn＝執行日（不能早於今天）、dueOn＝締切、scheduledTime＝預定時刻 HH:MM（營業日表記：過了午夜、還沒到日界線的凌晨寫成 24 以上，例 25:00＝凌晨 1 點）。",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "票名" },
            kind: { type: "string", enum: TASK_KINDS, description: "預設 ticket（車票）" },
            parentId: { type: "string", description: "掛在哪個節點底下" },
            routeId: { type: "string", description: "臨時車票的路線標籤" },
            scheduledOn: { ...DATE_SCHEMA, description: "執行日" },
            scheduledTime: { ...CLOCK_SCHEMA, description: "預定時刻 HH:MM" },
            dueOn: { ...DATE_SCHEMA, description: "締切" },
            description: { type: "string", description: "說明（Markdown）" },
            priority: { type: "string", enum: PRIORITIES, description: "優先度，預設 mid" },
            estimateMin: { type: "integer", minimum: 1, maximum: 1440, description: "預估分鐘" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: ADD,
  async run(args, ctx) {
    const items: AddItem[] = batch(args, "tasks").map((a, i) => {
      const where = `tasks[${i}]`;
      const kind = oneOf(a, "kind", TASK_KINDS, where) ?? "ticket";
      const parentId = str(a, "parentId", { where }) || null;
      const routeId = str(a, "routeId", { where }) || null;
      if (parentId && routeId) throw new McpUserError(`${where}：parentId 與 routeId 只能給一個（routeId 是臨時車票的路線標籤）`);
      if (routeId && kind !== "ticket") throw new McpUserError(`${where}：routeId 只給臨時車票；列車要放進路線請用 parentId`);
      if (!parentId && kind !== "ticket") throw new McpUserError(`${where}：${KIND_LABEL[kind]}要給 parentId（只有車票能不掛在任何節點底下）`);
      const scheduledOn = date(a, "scheduledOn", { where }) ?? null;
      // 同 scheduleActions.createOn：建票挑不到過去（D-主-67 的補記只走 UI 日期欄）
      if (scheduledOn && scheduledOn < ctx.today) throw new McpUserError(`${where}.scheduledOn 不能早於今天（${ctx.today}）`);
      if (scheduledOn && kind === "branch") throw new McpUserError(`${where}：支線沒有執行日`);
      const time = nullableClock(a, "scheduledTime", where);
      if (time && kind === "branch") throw new McpUserError(`${where}：支線沒有預定時刻`);
      assertClock(time, ctx, `${where}.scheduledTime`);
      const patch: NodePatch = compact({
        due_on: date(a, "dueOn", { where }),
        priority: oneOf(a, "priority", PRIORITIES, where),
        estimate_min: int(a, "estimateMin", { min: 1, max: 1440, where }),
        scheduled_time: time,
      });
      const description = str(a, "description", { where }) || null;
      return { name: str(a, "name", { required: true, where }), kind, parentId, routeId, scheduledOn, description, patch };
    });
    const repo = ctx.deps.nodeRepo;
    const results = await runEach(items, async (it) => {
      if (it.parentId) {
        const parent = await aliveNode(ctx, it.parentId, "父節點");
        if (!allowedChildKinds(parent.kind).includes(it.kind)) {
          throw new McpUserError(`${KIND_LABEL[it.kind]}不能掛在${KIND_LABEL[parent.kind]}底下`);
        }
      }
      if (it.routeId) {
        const r = await repo.getNode(it.routeId);
        if (!r || r.deleted_at !== null || r.kind !== "route") throw new McpUserError(`找不到路線 ${it.routeId}`);
      }
      // 同 nodeStore.createNode → repository.create（発券事件、position、line_id／route_id 都在 repository）
      const row = await repo.create({
        kind: it.kind,
        name: it.name,
        parentId: it.parentId,
        routeTagId: it.routeId,
        scheduledOn: it.scheduledOn,
        description: it.description,
      });
      if (Object.keys(it.patch).length) {
        // 同 nodeStore.updateNode 的 rest 分支：帶 dateKey／dayStartHour（時刻驗範圍要它）
        await repo.update(row.id, it.patch, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
      }
      const after = (await repo.getNode(row.id)) ?? row;
      return { ok: true, ...brief(after) };
    });
    const t = tally(results);
    return {
      summary: `建立了 ${t.ok} 張${t.tail}`,
      data: results,
      changed: t.ok ? CHANGED_NODES : undefined,
      toast: t.ok ? `外部助理建立了 ${t.ok} 張車票` : undefined,
    };
  },
};

/** 存活的任意節點（父節點檢查用：路線、幹線也算） */
async function aliveNode(ctx: McpCtx, id: string, label: string): Promise<NodeRow> {
  const n = await ctx.deps.nodeRepo.getNode(id);
  if (!n || n.deleted_at !== null) throw new McpUserError(`找不到${label} ${id}`);
  return n;
}

const updateTasks: McpTool = {
  name: "update-tasks",
  title: "修改車票",
  description:
    "修改車票欄位（最多 50 張）：name、description、priority、estimateMin、dueOn（締切）、scheduledTime（預定時刻 HH:MM）；給 null＝清除。改執行日用 reschedule-tasks、完成用 complete-tasks。定期券的 scheduledTime＝每一班的時刻。",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: ID_SCHEMA,
            name: { type: "string" },
            description: { type: ["string", "null"] },
            priority: { type: "string", enum: PRIORITIES },
            estimateMin: { type: ["integer", "null"], minimum: 1, maximum: 1440 },
            dueOn: { type: ["string", "null"], pattern: DATE_SCHEMA.pattern },
            scheduledTime: CLOCK_SCHEMA,
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const items = batch(args, "tasks").map((a, i) => {
      const where = `tasks[${i}]`;
      const id = str(a, "id", { required: true, where });
      const name = str(a, "name", { where });
      if (name === "") throw new McpUserError(`${where}.name 不能是空字串`);
      const time = nullableClock(a, "scheduledTime", where);
      assertClock(time, ctx, `${where}.scheduledTime`);
      const patch: NodePatch = {};
      if (name !== undefined) patch.name = name;
      const description = nullableStr(a, "description", where);
      if (description !== undefined) patch.description = description || null;
      const priority = oneOf(a, "priority", PRIORITIES, where);
      if (priority) patch.priority = priority;
      if (a.estimateMin === null) patch.estimate_min = null;
      else {
        const est = int(a, "estimateMin", { min: 1, max: 1440, where });
        if (est !== undefined) patch.estimate_min = est;
      }
      const dueOn = nullableDate(a, "dueOn", where);
      if (dueOn !== undefined) patch.due_on = dueOn;
      if (time !== undefined) patch.scheduled_time = time;
      if (!Object.keys(patch).length) throw new McpUserError(`${where} 除了 id 沒有要改的欄位`);
      return { id, patch };
    });
    const repo = ctx.deps.nodeRepo;
    const results = await runEach(items, async (it) => {
      const n = await aliveTask(ctx, it.id);
      if (n.kind === "branch" && it.patch.scheduled_time) throw new McpUserError(`「${n.name}」是支線，沒有預定時刻`);
      // 同 nodeStore.updateNode 的 rest 分支（mood 鏡射／時刻範圍要 dateKey 與 dayStartHour）
      await repo.update(n.id, it.patch, { dateKey: ctx.today, dayStartHour: ctx.dayStartHour });
      const after = (await repo.getNode(n.id)) ?? n;
      return { ok: true, ...brief(after) };
    });
    const t = tally(results);
    return {
      summary: `改了 ${t.ok} 張${t.tail}`,
      data: results,
      changed: t.ok ? CHANGED_NODES : undefined,
      toast: t.ok ? `外部助理修改了 ${t.ok} 張車票` : undefined,
    };
  },
};

const completeTasks: McpTool = {
  name: "complete-tasks",
  title: "蓋済／取消済",
  description:
    "完成（蓋済）或取消完成（最多 50 張）：done:true＝済、false＝取消。定期券済的是目前這一班，下一班自動排出。底下還有未済子項時要帶 cascade:true 才會連同子項一起済。運休中的那一班不能直接済。",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: ID_SCHEMA,
            done: { type: "boolean", description: "true＝済、false＝取消済" },
            cascade: { type: "boolean", description: "連同未済子項一起済" },
          },
          required: ["id", "done"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const items = batch(args, "tasks").map((a, i) => {
      const where = `tasks[${i}]`;
      const done = bool(a, "done", where);
      if (done === undefined) throw new McpUserError(`缺少 ${where}.done`);
      return { id: str(a, "id", { required: true, where }), done, cascade: bool(a, "cascade", where) === true };
    });
    const repo = ctx.deps.nodeRepo;
    const opts = { dateKey: ctx.today, dayStartHour: ctx.dayStartHour };
    let touched = 0;
    const results = await runEach(items, async (it) => {
      const n = await aliveTask(ctx, it.id);
      const rule = parseRule(n.repeat_rule);
      const live = rule !== null && n.status !== "done"; // 未退役的定期券：済蓋在目前班次上（D-④-2）
      // 每筆重查：同一批前面的票可能已經推動了班次
      const run = live ? (await repo.listCurrentOccurrences(ctx.today, ctx.dayStartHour))[n.id] : undefined;
      if (it.done) {
        if (live && run?.status === "done") return { ok: true, id: n.id, name: n.name, note: "這一班已済了" };
        // 同 useTodayController.completeRow：運休中的班次點下去是取消運休，不會蓋到引擎推走的下一班
        if (live && run?.status === "skipped") {
          throw new McpUserError(`「${n.name}」這一班運休中——先用 skip-tasks（skip:false）取消運休再済`);
        }
        if (!live && n.status === "done") return { ok: true, id: n.id, name: n.name, note: "已經済了" };
        // 同 TaskFields.changeStatus／useTodayController：有未済子項要先問「一起完成？」，答應才帶 cascade
        const open = (await descendantsOf(ctx, n)).filter((c) => c.status !== "done").length;
        if (open > 0 && !it.cascade) {
          throw new McpUserError(`「${n.name}」底下還有 ${open} 個未済子項——要一起済請帶 cascade:true`);
        }
        const ids = await repo.setCompleted(n.id, true, { ...opts, cascade: open > 0 ? true : undefined });
        touched++;
        return { ok: true, id: n.id, name: n.name, done: true, ...compact({ alsoDone: ids.length > 1 ? ids.length - 1 : null }) };
      }
      if (live) {
        if (run?.status !== "done") {
          const why = run?.status === "skipped" ? "這一班是運休、不是済——取消運休用 skip-tasks" : "這一班還沒済";
          return { ok: true, id: n.id, name: n.name, note: why };
        }
      } else if (n.status !== "done") {
        return { ok: true, id: n.id, name: n.name, note: "本來就沒済" };
      }
      // 同側板 TaskFields：取消完成＝setCompleted(false)（退役的定期券＝恢復排班）
      await repo.setCompleted(n.id, false, opts);
      touched++;
      return { ok: true, id: n.id, name: n.name, done: false, ...compact({ note: rule && !live ? "定期券恢復排班" : null }) };
    });
    const t = tally(results);
    return {
      summary: `處理了 ${t.ok} 張（實際變動 ${touched} 張）${t.tail}`,
      data: results,
      changed: touched ? CHANGED_RUNS : undefined,
      toast: touched ? `外部助理更新了 ${touched} 張車票的済章` : undefined,
    };
  },
};

const rescheduleTasks: McpTool = {
  name: "reschedule-tasks",
  title: "改期（繰越）",
  description:
    "改車票的執行日（最多 50 張），等於 App 的推遲／繰越：date＝新執行日（不能早於今天；跟現值相同＝不動日期）、null＝清掉執行日；time＝順便改預定時刻 HH:MM（null 清除）。已済的票要先取消済。定期券不能改日期，只能帶目前班次日改這一班的時刻。一次排好幾張建議先 propose-schedule。",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: ID_SCHEMA,
            date: { type: ["string", "null"], pattern: DATE_SCHEMA.pattern, description: "新執行日；null＝清掉" },
            time: { ...CLOCK_SCHEMA, description: "預定時刻；省略＝不動" },
          },
          required: ["id", "date"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const items = batch(args, "tasks").map((a, i) => parseRescheduleItem(a, `tasks[${i}]`));
    const results = await runEach(items, async (it) => applyReschedule(ctx, await aliveTask(ctx, it.id, DATED_KINDS), it));
    const t = tally(results);
    return {
      summary: `改期 ${t.ok} 張${t.tail}`,
      data: results,
      changed: t.ok ? CHANGED_NODES : undefined,
      toast: t.ok ? `外部助理改期了 ${t.ok} 張車票` : undefined,
    };
  },
};

const skipTasks: McpTool = {
  name: "skip-tasks",
  title: "運休（跳過這一班）",
  description:
    "定期券的這一班運休（＝這一班不跑，下一班照規則排）或取消運休（skip:false），最多 50 張。date＝指定哪一班（提前請假；只能是目前或未來的規則日），省略＝目前這一班。一般車票不能運休。",
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: ID_SCHEMA,
            skip: { type: "boolean", description: "預設 true；false＝取消運休" },
            date: { ...DATE_SCHEMA, description: "哪一班（班次日）" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const items = batch(args, "tasks").map((a, i) => {
      const where = `tasks[${i}]`;
      return { id: str(a, "id", { required: true, where }), skip: bool(a, "skip", where) ?? true, date: date(a, "date", { where }) ?? null };
    });
    const repo = ctx.deps.nodeRepo;
    const results = await runEach(items, async (it) => {
      const n = await aliveTask(ctx, it.id, DATED_KINDS);
      if (!parseRule(n.repeat_rule)) throw new McpUserError(`「${n.name}」：${REPEAT_ONLY_MSG}`);
      if (n.status === "done") throw new McpUserError(RETIRED_MSG(n.name));
      // 同 nodeStore.skipOccurrence（班次日守門在 repository 的 resolveSkipDate）
      await repo.skipOccurrence(n.id, it.skip, ctx.today, ctx.dayStartHour, it.date);
      const after = (await repo.getNode(n.id)) ?? n;
      return { ok: true, id: n.id, name: n.name, skipped: it.skip, ...compact({ date: it.date, nextRun: after.scheduled_on }) };
    });
    const t = tally(results);
    return {
      summary: `${t.ok} 張定期券${t.tail}`,
      data: results,
      changed: t.ok ? CHANGED_RUNS : undefined,
      toast: t.ok ? `外部助理調整了 ${t.ok} 張定期券的運休` : undefined,
    };
  },
};

const deleteTasks: McpTool = {
  name: "delete-tasks",
  title: "刪除車票",
  description: "刪除車票（最多 50 張；軟刪除，App 裡可復原）。底下的子項會一起刪，結果會說連帶刪了幾個。",
  inputSchema: {
    type: "object",
    properties: { ids: { type: "array", minItems: 1, maxItems: 50, items: ID_SCHEMA } },
    required: ["ids"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: DESTRUCTIVE,
  async run(args, ctx) {
    const ids = idList(args, "ids");
    const gone = new Set<string>();
    const results = await runEach(ids, async (id) => {
      if (gone.has(id)) return { ok: true, id, note: "已隨上層一起刪除" };
      const n = await aliveTask(ctx, id);
      // 同 nodeStore.deleteNode（soft delete 整個子樹）
      const removed = await ctx.deps.nodeRepo.softDelete(n.id);
      for (const x of removed) gone.add(x);
      return { ok: true, id: n.id, name: n.name, ...compact({ alsoDeleted: removed.length > 1 ? removed.length - 1 : null }) };
    });
    const t = tally(results);
    return {
      summary: `刪除了 ${t.ok} 張（含子項共 ${gone.size} 個節點）${t.tail}`,
      data: { results, deletedIds: [...gone] },
      changed: gone.size ? ["nodes"] : undefined,
      toast: gone.size ? `外部助理刪除了 ${t.ok} 張車票` : undefined,
      // 同 nodeStore.undoDelete：整串一起放回
      undo: gone.size ? async () => (await ctx.deps.nodeRepo.restore([...gone]), ["nodes"]) : undefined,
    };
  },
};

const addWorkLogs: McpTool = {
  name: "add-work-logs",
  title: "寫作業記錄",
  description: "在車票的作業記錄（乘務記錄）寫一則手記（最多 50 則）：taskId＋body。",
  inputSchema: {
    type: "object",
    properties: {
      logs: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: { taskId: ID_SCHEMA, body: { type: "string", description: "內容" } },
          required: ["taskId", "body"],
          additionalProperties: false,
        },
      },
    },
    required: ["logs"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: ADD,
  async run(args, ctx) {
    const items = batch(args, "logs").map((a, i) => {
      const where = `logs[${i}]`;
      return { id: str(a, "taskId", { required: true, where }), body: str(a, "body", { required: true, where }) };
    });
    const results = await runEach(items, async (it) => {
      const n = await aliveTask(ctx, it.id);
      // 同 nodeStore.addWorkLog（空字串不寫——上面 required 已擋）
      const log = await ctx.deps.nodeRepo.addWorkLog(n.id, it.body);
      return { ok: true, id: log.id, taskId: n.id, name: n.name };
    });
    const t = tally(results);
    return {
      summary: `寫了 ${t.ok} 則作業記錄${t.tail}`,
      data: results,
      changed: t.ok ? ["work_logs"] : undefined,
      toast: t.ok ? `外部助理寫了 ${t.ok} 則作業記錄` : undefined,
    };
  },
};

export const TASK_TOOLS: McpTool[] = [
  findRoutes,
  findTasks,
  findTasksByDate,
  getTask,
  addTasks,
  updateTasks,
  completeTasks,
  rescheduleTasks,
  skipTasks,
  deleteTasks,
  addWorkLogs,
].map(strictArgs);
