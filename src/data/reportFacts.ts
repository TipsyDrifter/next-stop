/**
 * reportFacts——把運行報告要的事實一次讀齊（② 運行報告 ＋ v1.33 3A 完全體）。只讀、0 migration。
 *
 * 讀完交給純函式 `buildOperationReport`（domain/report.ts）。各模組的讀法：
 *   済＝sealRepo（domain/seals.ts，D-主-181，帶名稱／班次日／荷札）；
 *   誤點＝nodeRepo.listToday（今日頁同一份）；締切＝listCalendar＋reportQueries；
 *   時刻表＝listBlocks（退回 listBlocksSlim）＋nodeMetaByIds＋reportTimeFacts（門檻同統計頁 `blockThresholdOf`）；
 *   售票口＝listEntries＋budgetLines（帶備註／路線／荷札）；
 *   旅客筆記＝reportQueries.noteTimes／noteFactsIn＋listDiaryMarks＋diarySummariesIn；
 *   一年前＝listDiary（沒有再看那天的第一則筆記）。
 * 線沒通車（`open.*` false）就不讀、那一段給 null。
 *
 * 今日小結另有輕量版 `loadBriefFacts`（只讀今天：済、已記錄、花了）。
 */
import type { NodeRow } from "../domain";
import { nodeRepo } from "./index";
import { idealRepo } from "../data/idealRepository";
import { sealRepo } from "./sealRepo";
import { noteRepo } from "./noteRepo";
import { timetableRepo } from "./timetableRepository";
import { ticketRepo } from "./ticketRepository";
import { tagRepo } from "./tagRepo";
import { reportQueries } from "./reportQueries";
import { addDays, dayWindow } from "../lib/date";
import { toStatsSpan, type StatsSpan } from "../domain/timetableStats";
import type { TimeBlockRow, TimeBlockSlim, TimeCategoryRow } from "../domain/timetable";
import { EMPTY_TAG_MAPS, blockTags, tagMapsOf } from "../domain/timetableTags";
import { buildIndex, type TagIndex } from "../domain/tags";
import { TK_TAG_ENTRY, TK_TAG_REPEAT, entityTagMap } from "../domain/ticketTags";
import { UNCAT_NAME, effectiveParentId, monthOf, monthRange, type CategoryRow, type EntryRow } from "../domain/ticket";
import { budgetLines } from "../domain/ticketPlan";
import {
  buildSingleDaySpread,
  oneLine,
  reportFetchWindow,
  resolveReportRange,
  yearAgoDay,
  type ReportDaySpreadData,
  type ReportDiarySummaryFact,
  type ReportDue,
  type ReportDueDayItemFact,
  type ReportExpenseFact,
  type ReportFacts,
  type ReportFilter,
  type ReportLateFact,
  type ReportMoneyFacts,
  type ReportNotesFacts,
  type ReportPeriodSpec,
  type ReportRouteRef,
} from "../domain/report";
import { reportTimeFacts, type ReportTimeBlockMeta } from "../domain/reportTime";

export interface ReportOpen {
  timetable: boolean;
  ticket: boolean;
  notes: boolean;
}

export interface LoadReportOpts {
  today: string;
  dayStartHour: number;
  weekStart: 0 | 1;
  days: 7 | 30;
  /** v1.33 3A-2：彈性期間規格（省略時由 `days` 推導 7d／30d） */
  period?: ReportPeriodSpec;
  /** v1.33 3A-2：跨模組篩選條件 */
  filter?: ReportFilter;
  now: number;
  open: ReportOpen;
  /** 側欄的路線（nodeStore.routes，含已收進車庫的路線） */
  routes: readonly NodeRow[];
  /** 時刻表門檻（同統計頁 `blockThresholdOf`）；拿到分類表之後才組得出來 */
  timeThreshold: (cats: readonly TimeCategoryRow[]) => (s: StatsSpan) => number | null;
  /** 記事欄的來源（③ 的 stamps）；沒有＝null */
  dayNotes: ((from: string, to: string) => Promise<Record<string, string[]> | null>) | null;
}

const isoStart = (day: string, h: number) => dayWindow(day, h).start;
const isoEnd = (day: string, h: number) => dayWindow(day, h).end;

function routeRefs(routes: readonly NodeRow[]): Record<string, ReportRouteRef> {
  const out: Record<string, ReportRouteRef> = {};
  for (const r of routes) {
    if (r.deleted_at === null) {
      out[r.id] = {
        id: r.id,
        name: r.name,
        code: r.code,
        color: r.color,
        lineId: r.line_id ?? r.parent_id,
        arrivedOn: r.arrived_on,
      };
    }
  }
  return out;
}

function mergeUniqueKeys(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  if (!b?.length) return a ? [...a] : undefined;
  if (!a?.length) return [...b];
  const out = [...a];
  for (const k of b) if (!out.includes(k)) out.push(k);
  return out;
}

async function loadTagIndexSafe(): Promise<TagIndex | null> {
  const repo = tagRepo as Partial<typeof tagRepo>;
  if (typeof repo.loadIndexSource !== "function") return null;
  try {
    const src = await repo.loadIndexSource();
    return buildIndex(src);
  } catch {
    return null;
  }
}

/**
 * 今日頁誤點區「還沒交代」的票（＝誤點區標題那個數，`domain/dayCount.ts` 的 `lateCount` 同一條規則），
 * 每張歸到原本排的那天（定期券＝那一班；只有締切的＝締切日）。今天補済、留在原位的那張不算。
 */
async function lateDays(today: string, h: number, nodeTags: Readonly<Record<string, string[]>>): Promise<ReportLateFact[]> {
  const rows = await nodeRepo.listToday(today, h);
  const out: ReportLateFact[] = [];
  for (const r of rows) {
    if (r.bucket === "today" || r.occurrence !== null || r.status === "done" || r.status === "paused") continue;
    const day = r.bucket === "late" ? r.scheduled_on : r.due_on;
    if (day && day <= today) {
      out.push({
        day,
        nodeId: r.id,
        routeId: r.route_id,
        tagKeys: nodeTags[r.id],
      });
    }
  }
  return out;
}

async function dueSoon(today: string, h: number, nodeTags: Readonly<Record<string, string[]>>): Promise<ReportDue[]> {
  const to = addDays(today, 6);
  const cal = await nodeRepo.listCalendar(today, to, { todayDateKey: today, dayStartHour: h });
  const out: ReportDue[] = [];
  for (const d of cal.dues) {
    const n = cal.nodes[d.node_id];
    if (!n || n.status === "done" || n.status === "paused" || d.date < today || d.date > to) continue;
    out.push({
      day: d.date,
      nodeId: n.id,
      name: n.name,
      routeId: n.route_id,
      temp: n.parent_id === null,
      tagKeys: nodeTags[n.id],
    });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.name.localeCompare(b.name)));
}

async function dueItemsInWindow(
  from: string,
  to: string,
  nodeTags: Readonly<Record<string, string[]>>,
): Promise<ReportDueDayItemFact[] | undefined> {
  const q = reportQueries as Partial<typeof reportQueries>;
  if (typeof q.dueFactsIn !== "function") return undefined;
  const rows = await q.dueFactsIn(from, to);
  return rows.map((r) => ({
    id: r.id,
    day: r.day,
    routeId: r.routeId,
    tagKeys: nodeTags[r.id],
  }));
}

async function timeFacts(
  o: LoadReportOpts,
  from: string,
  to: string,
  tagIdx: TagIndex | null,
  nodeTags: Readonly<Record<string, string[]>>,
) {
  const { today, dayStartHour: h, now } = o;
  const startIso = isoStart(from, h);
  const endIso = new Date(Math.max(now, Date.parse(isoEnd(to, h)))).toISOString();
  const ttRepo = timetableRepo as Partial<typeof timetableRepo>;
  const [rows, cats] = await Promise.all([
    typeof ttRepo.listBlocks === "function"
      ? ttRepo.listBlocks(startIso, endIso)
      : timetableRepo.listBlocksSlim(startIso, endIso),
    timetableRepo.listCategories(),
  ]);

  const byId = new Map(cats.map((c) => [c.id, c] as const));
  const nodeIds: string[] = [];
  for (const r of rows) if (r.node_id) nodeIds.push(r.node_id);

  const q = reportQueries as Partial<typeof reportQueries>;
  const nodeMeta = typeof q.nodeMetaByIds === "function" && nodeIds.length > 0 ? await q.nodeMetaByIds(nodeIds) : {};
  const tagMaps = tagIdx ? tagMapsOf(tagIdx.ents) : EMPTY_TAG_MAPS;

  const blockMeta: Record<string, ReportTimeBlockMeta> = {};
  const spans: StatsSpan[] = rows.map((r: TimeBlockSlim | TimeBlockRow) => {
    const base = toStatsSpan(r);
    const cat = byId.get(r.category_id);
    const linkedNode = r.node_id ? nodeMeta[r.node_id] : undefined;
    const effRouteId = r.node_id !== null ? linkedNode?.routeId ?? r.route_id : r.route_id;
    const bTags = blockTags({ id: r.id, categoryId: r.category_id }, cats, tagMaps);
    const mergedTags = mergeUniqueKeys(bTags, r.node_id ? nodeTags[r.node_id] : undefined) ?? [];
    const note = "note" in r && typeof r.note === "string" ? r.note : "";

    blockMeta[r.id] = {
      categoryName: cat?.name ?? "已刪除的分類",
      taskName: linkedNode?.name ?? null,
      note,
      routeId: effRouteId,
    };

    return {
      ...base,
      routeId: effRouteId,
      tagKeys: mergedTags,
    };
  });

  return reportTimeFacts({
    spans,
    threshold: o.timeThreshold(cats),
    // 子分類歸主分類（同時刻表統計「占比」的第一層）
    catTop: (id) => {
      const c = byId.get(id);
      if (!c) return null;
      const p = c.parent_id ? byId.get(c.parent_id) : undefined;
      return p ? { id: p.id, name: p.name } : { id: c.id, name: c.name };
    },
    from,
    to,
    today,
    dayStartHour: h,
    now,
    blockMeta,
  });
}

/** 主分類名（子分類歸到它的主分類；未分類／分類不在＝「未分類」） */
function topCategoryName(e: EntryRow, catById: Readonly<Record<string, CategoryRow>>): string {
  const c = e.category_id ? catById[e.category_id] : undefined;
  if (!c || c.deleted_at !== null) return UNCAT_NAME;
  const pid = effectiveParentId(c, catById);
  return (pid ? catById[pid]?.name : null) ?? c.name;
}

async function moneyFacts(
  today: string,
  from: string,
  to: string,
  tagIdx: TagIndex | null,
): Promise<ReportMoneyFacts> {
  const month = monthOf(today);
  const mr = monthRange(month);
  const lo = from < mr.from ? from : mr.from;
  const hi = to > today ? to : today;
  const [entries, cats, curs, budgets] = await Promise.all([
    ticketRepo.listEntries(lo, addDays(hi, 1), null),
    ticketRepo.listCategories(),
    ticketRepo.listCurrencies(),
    ticketRepo.listBudgets(),
  ]);
  const catById: Record<string, CategoryRow> = {};
  for (const c of cats) catById[c.id] = c;
  const entryTags = entityTagMap(tagIdx, TK_TAG_ENTRY);
  const repeatTags = entityTagMap(tagIdx, TK_TAG_REPEAT);

  const expenses = entries
    .filter((e) => e.deleted_at === null && e.kind === "expense" && e.occurred_on >= from && e.occurred_on <= hi)
    .map((e) => ({
      id: e.id,
      day: e.occurred_on,
      at: e.occurred_at,
      minor: e.main_minor + (e.fee_main_minor ?? 0),
      category: topCategoryName(e, catById),
      item: e.item ?? "",
      note: e.note,
      routeId: e.route_id,
      tagKeys: mergeUniqueKeys(entryTags[e.id], e.repeat_id ? repeatTags[e.repeat_id] : undefined),
    }));
  const total = budgetLines(budgets, entries, month, cats, today, { catById }).find((l) => l.key === "total") ?? null;
  return {
    expenses,
    decimals: curs.find((c) => c.is_main === 1)?.decimals ?? 0,
    budget: total ? { month, budget: total.budget, used: total.used, remaining: total.remaining } : null,
  };
}

async function notesFacts(
  from: string,
  to: string,
  h: number,
  noteTags: Readonly<Record<string, string[]>>,
): Promise<ReportNotesFacts> {
  const q = reportQueries as Partial<typeof reportQueries>;
  const startIso = isoStart(from, h);
  const endIso = isoEnd(to, h);

  const [noteRows, marks, rawSummaries] = await Promise.all([
    typeof q.noteFactsIn === "function"
      ? q.noteFactsIn(startIso, endIso)
      : reportQueries.noteTimes(startIso, endIso).then((times) => times.map((at, idx) => ({ id: `n-${idx}`, at, routeId: null }))),
    noteRepo.listDiaryMarks(from, to),
    typeof q.diarySummariesIn === "function"
      ? q.diarySummariesIn(from, to)
      : Promise.resolve({} as Record<string, { id: string; text: string }>),
  ]);

  const diarySummaries: Record<string, ReportDiarySummaryFact> = {};
  for (const day of Object.keys(rawSummaries)) {
    const s = rawSummaries[day];
    if (!s) continue;
    diarySummaries[day] = {
      id: s.id,
      text: s.text,
      tagKeys: noteTags[s.id],
    };
  }

  return {
    notedAt: noteRows.map((r) => r.at),
    diaryDays: Object.keys(marks).filter((d) => marks[d] > 0),
    noteItems: noteRows.map((r) => ({
      id: r.id,
      at: r.at,
      routeId: r.routeId,
      tagKeys: noteTags[r.id],
    })),
    diarySummaries,
  };
}

async function yearAgoFacts(today: string, h: number): Promise<ReportFacts["yearAgo"]> {
  const day = yearAgoDay(today);
  if (!day) return null;
  for (const d of await noteRepo.listDiary(day)) {
    const text = oneLine(d.title, d.body);
    if (text) return { day, text };
  }
  const n = await reportQueries.firstNoteIn(isoStart(day, h), isoEnd(day, h));
  const text = n ? oneLine(n.title, n.body) : "";
  return text ? { day, text } : null;
}

export async function loadReportFacts(o: LoadReportOpts): Promise<ReportFacts> {
  const { today, dayStartHour: h } = o;
  const spec: ReportPeriodSpec = o.period ?? { mode: o.days === 30 ? "30d" : "7d" };
  const range = resolveReportRange(today, spec);
  const win = reportFetchWindow(today, o.weekStart, range);
  const tagIdx = await loadTagIndexSafe();
  const nodeTags = entityTagMap(tagIdx, "node");
  const noteTags = entityTagMap(tagIdx, "note");

  const [seals, late, soon, dueByDay, dueItems, time, money, notes, yearAgo, dayNotes] = await Promise.all([
    sealRepo.listSeals(win.from, win.to, h),
    lateDays(today, h, nodeTags),
    dueSoon(today, h, nodeTags),
    reportQueries.dueCountByDay(win.from, win.to),
    dueItemsInWindow(win.from, win.to, nodeTags),
    o.open.timetable ? timeFacts(o, win.from, win.to, tagIdx, nodeTags) : Promise.resolve(null),
    o.open.ticket ? moneyFacts(today, win.from, win.to, tagIdx) : Promise.resolve(null),
    o.open.notes ? notesFacts(win.from, win.to, h, noteTags) : Promise.resolve(null),
    o.open.notes ? yearAgoFacts(today, h) : Promise.resolve(null),
    o.dayNotes ? o.dayNotes(win.from, win.to) : Promise.resolve(null),
  ]);

  return {
    today,
    dayStartHour: h,
    weekStart: o.weekStart,
    days: o.days,
    period: o.period,
    filter: o.filter,
    loadedFrom: win.from,
    seals: seals.map((s) => ({
      id: s.id,
      at: s.at,
      nodeId: s.nodeId,
      name: s.name,
      kind: s.kind,
      dueOn: s.dueOn,
      mood: s.mood,
      routeId: s.routeId,
      tagKeys: nodeTags[s.nodeId],
    })),
    late,
    dueSoon: soon,
    dueByDay,
    dueItems,
    routes: routeRefs(o.routes),
    time,
    money,
    notes,
    yearAgo,
    dayNotes,
  };
}

/* ───────── 今日小結（只讀今天） ───────── */

export interface BriefFacts {
  seals: number;
  recordedMs: number | null;
  spent: number | null;
  decimals: number;
}

export async function loadBriefFacts(
  o: Omit<LoadReportOpts, "days" | "weekStart" | "routes" | "dayNotes" | "period" | "filter">,
): Promise<BriefFacts> {
  const { today, dayStartHour: h } = o;
  const [seals, time, money] = await Promise.all([
    sealRepo.listSeals(today, today, h),
    o.open.timetable
      ? timeFacts({ ...o, days: 7, weekStart: 1, routes: [], dayNotes: null }, today, today, null, {})
      : Promise.resolve(null),
    o.open.ticket ? moneyFacts(today, today, today, null) : Promise.resolve(null),
  ]);
  return {
    seals: seals.length,
    recordedMs: time ? time.byDay[today] ?? 0 : null,
    spent: money ? money.expenses.reduce((a, e) => a + e.minor, 0) : null,
    decimals: money?.decimals ?? 0,
  };
}

/* ───────── 一日運行專頁（手帳跨頁）：任意單日輕量按需載入 ───────── */

export interface LoadSingleDaySpreadOpts {
  day: string;
  today: string;
  dayStartHour: number;
  now: number;
  open: ReportOpen;
  routes: readonly NodeRow[];
  timeThreshold: (cats: readonly TimeCategoryRow[]) => (s: StatsSpan) => number | null;
  dayNotes: ((from: string, to: string) => Promise<Record<string, string[]> | null>) | null;
}

async function singleDayMoneyFacts(
  day: string,
  tagIdx: TagIndex | null,
): Promise<{ expenses: ReportExpenseFact[]; decimals: number }> {
  const [entries, cats, curs] = await Promise.all([
    ticketRepo.listEntries(day, addDays(day, 1), null),
    ticketRepo.listCategories(),
    ticketRepo.listCurrencies(),
  ]);
  const catById: Record<string, CategoryRow> = {};
  for (const c of cats) catById[c.id] = c;
  const entryTags = entityTagMap(tagIdx, TK_TAG_ENTRY);
  const repeatTags = entityTagMap(tagIdx, TK_TAG_REPEAT);

  const expenses: ReportExpenseFact[] = entries
    .filter((e) => e.deleted_at === null && e.kind === "expense" && e.occurred_on === day)
    .map((e) => ({
      id: e.id,
      day: e.occurred_on,
      at: e.occurred_at,
      minor: e.main_minor + (e.fee_main_minor ?? 0),
      category: topCategoryName(e, catById),
      item: e.item ?? "",
      note: e.note,
      routeId: e.route_id,
      tagKeys: mergeUniqueKeys(entryTags[e.id], e.repeat_id ? repeatTags[e.repeat_id] : undefined),
    }));

  return {
    expenses,
    decimals: curs.find((c) => c.is_main === 1)?.decimals ?? 0,
  };
}

export async function loadSingleDaySpread(o: LoadSingleDaySpreadOpts): Promise<ReportDaySpreadData> {
  const { day, today, dayStartHour: h, now } = o;
  const tagIdx = await loadTagIndexSafe();
  const nodeTags = entityTagMap(tagIdx, "node");
  const ir = idealRepo as Partial<typeof idealRepo>;

  const q = reportQueries as Partial<typeof reportQueries>;
  const dayWin = dayWindow(day, h);

  const [seals, workLogs, time, money, diaryRows, reflections, dayNotesMap] = await Promise.all([
    sealRepo.listSeals(day, day, h),
    typeof q.workLogsIn === "function" ? q.workLogsIn(dayWin.start, dayWin.end) : Promise.resolve([]),
    o.open.timetable
      ? timeFacts(
          {
            today: day < today ? day : today,
            dayStartHour: h,
            weekStart: 1,
            days: 7,
            now,
            open: o.open,
            routes: o.routes,
            timeThreshold: o.timeThreshold,
            dayNotes: null,
          },
          day,
          day,
          tagIdx,
          nodeTags,
        )
      : Promise.resolve(null),
    o.open.ticket ? singleDayMoneyFacts(day, tagIdx) : Promise.resolve(null),
    o.open.notes ? noteRepo.listDiary(day) : Promise.resolve(null),
    typeof ir.listReflections === "function" ? ir.listReflections().catch(() => []) : Promise.resolve([]),
    o.dayNotes ? o.dayNotes(day, day) : Promise.resolve(null),
  ]);

  return buildSingleDaySpread(
    {
      day,
      today,
      dayStartHour: h,
      routes: routeRefs(o.routes),
      seals: seals.map((s) => ({
        id: s.id,
        at: s.at,
        nodeId: s.nodeId,
        name: s.name,
        kind: s.kind,
        dueOn: s.dueOn,
        mood: s.mood,
        routeId: s.routeId,
        tagKeys: nodeTags[s.nodeId],
      })),
      workLogs,
      time,
      money,
      diaries: diaryRows
        ? diaryRows.map((d) => ({
            id: d.id,
            entryDate: d.entry_date ?? day,
            title: d.title,
            body: d.body,
            createdAt: d.noted_at || d.created_at,
            updatedAt: d.updated_at,
          }))
        : null,
      reflections,
      dayNotes: dayNotesMap?.[day] ?? [],
    },
    now,
  );
}
