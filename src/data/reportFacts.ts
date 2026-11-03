/**
 * reportFacts——把運行報告要的事實一次讀齊（② 運行報告；契約 §7）。只讀、0 migration。
 *
 * 讀完交給純函式 `buildOperationReport`（domain/report.ts）。各模組的讀法：
 *   済＝sealRepo（domain/seals.ts，D-主-181）；誤點＝nodeRepo.listToday（今日頁同一份）；締切＝listCalendar＋reportQueries；
 *   時刻表＝listBlocksSlim＋reportTimeFacts（門檻由呼叫端給，跟統計頁同一支）；售票口＝listEntries＋budgetLines；
 *   旅客筆記＝reportQueries.noteTimes＋listDiaryMarks；一年前＝listDiary（沒有再看那天的第一則筆記）。
 * 線沒通車（`open.*` false）就不讀、那一段給 null。
 *
 * 今日小結另有輕量版 `loadBriefFacts`（只讀今天：済、已記錄、花了）。
 */
import type { NodeRow } from "../domain";
import { nodeRepo } from "./index";
import { sealRepo } from "./sealRepo";
import { noteRepo } from "./noteRepo";
import { timetableRepo } from "./timetableRepository";
import { ticketRepo } from "./ticketRepository";
import { reportQueries } from "./reportQueries";
import { addDays, dayWindow } from "../lib/date";
import { toStatsSpan, type StatsSpan } from "../domain/timetableStats";
import type { TimeCategoryRow } from "../domain/timetable";
import { UNCAT_NAME, effectiveParentId, monthOf, monthRange, type CategoryRow, type EntryRow } from "../domain/ticket";
import { budgetLines } from "../domain/ticketPlan";
import { factsFrom, oneLine, yearAgoDay, type ReportDue, type ReportFacts, type ReportMoneyFacts, type ReportRouteRef } from "../domain/report";
import { reportTimeFacts } from "../domain/reportTime";

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
  now: number;
  open: ReportOpen;
  /** 側欄的路線（nodeStore.routes） */
  routes: readonly NodeRow[];
  /** 時刻表門檻（同統計頁 `blockThresholdOf`）；拿到分類表之後才組得出來 */
  timeThreshold: (cats: readonly TimeCategoryRow[]) => (s: StatsSpan) => number | null;
  /** 記事欄的來源（③ 的 stamps）；沒有＝null */
  dayNotes: ((from: string, to: string) => Promise<Record<string, string[]>>) | null;
}

const isoStart = (day: string, h: number) => dayWindow(day, h).start;
const isoEnd = (day: string, h: number) => dayWindow(day, h).end;

function routeRefs(routes: readonly NodeRow[]): Record<string, ReportRouteRef> {
  const out: Record<string, ReportRouteRef> = {};
  for (const r of routes) if (r.deleted_at === null) out[r.id] = { id: r.id, name: r.name, code: r.code, color: r.color };
  return out;
}

/**
 * 今日頁誤點區「還沒交代」的票（＝誤點區標題那個數，`domain/dayCount.ts` 的 `lateCount` 同一條規則），
 * 每張歸到原本排的那天（定期券＝那一班；只有締切的＝締切日）。今天補済、留在原位的那張不算。
 */
async function lateDays(today: string, h: number): Promise<{ day: string }[]> {
  const rows = await nodeRepo.listToday(today, h);
  const out: { day: string }[] = [];
  for (const r of rows) {
    if (r.bucket === "today" || r.occurrence !== null || r.status === "done") continue;
    const day = r.bucket === "late" ? r.scheduled_on : r.due_on;
    if (day && day <= today) out.push({ day });
  }
  return out;
}

async function dueSoon(today: string, h: number): Promise<ReportDue[]> {
  const to = addDays(today, 6);
  const cal = await nodeRepo.listCalendar(today, to, { todayDateKey: today, dayStartHour: h });
  const out: ReportDue[] = [];
  for (const d of cal.dues) {
    const n = cal.nodes[d.node_id];
    if (!n || d.date < today || d.date > to) continue;
    out.push({ day: d.date, nodeId: n.id, name: n.name, routeId: n.route_id, temp: n.parent_id === null });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.name.localeCompare(b.name)));
}

async function timeFacts(o: LoadReportOpts, from: string) {
  const { today, dayStartHour: h, now } = o;
  const [rows, cats] = await Promise.all([
    timetableRepo.listBlocksSlim(isoStart(from, h), new Date(Math.max(now, Date.parse(isoEnd(today, h)))).toISOString()),
    timetableRepo.listCategories(),
  ]);
  const byId = new Map(cats.map((c) => [c.id, c] as const));
  return reportTimeFacts({
    spans: rows.map(toStatsSpan),
    threshold: o.timeThreshold(cats),
    // 子分類歸主分類（同時刻表統計「占比」的第一層）
    catTop: (id) => {
      const c = byId.get(id);
      if (!c) return null;
      const p = c.parent_id ? byId.get(c.parent_id) : undefined;
      return p ? { id: p.id, name: p.name } : { id: c.id, name: c.name };
    },
    from,
    today,
    dayStartHour: h,
    now,
  });
}

/** 主分類名（子分類歸到它的主分類；未分類／分類不在＝「未分類」） */
function topCategoryName(e: EntryRow, catById: Readonly<Record<string, CategoryRow>>): string {
  const c = e.category_id ? catById[e.category_id] : undefined;
  if (!c || c.deleted_at !== null) return UNCAT_NAME;
  const pid = effectiveParentId(c, catById);
  return (pid ? catById[pid]?.name : null) ?? c.name;
}

async function moneyFacts(today: string, from: string): Promise<ReportMoneyFacts> {
  const month = monthOf(today);
  const mr = monthRange(month);
  const lo = from < mr.from ? from : mr.from;
  const [entries, cats, curs, budgets] = await Promise.all([
    ticketRepo.listEntries(lo, addDays(today, 1), null),
    ticketRepo.listCategories(),
    ticketRepo.listCurrencies(),
    ticketRepo.listBudgets(),
  ]);
  const catById: Record<string, CategoryRow> = {};
  for (const c of cats) catById[c.id] = c;
  const expenses = entries
    .filter((e) => e.deleted_at === null && e.kind === "expense" && e.occurred_on >= from && e.occurred_on <= today)
    .map((e) => ({ day: e.occurred_on, at: e.occurred_at, minor: e.main_minor, category: topCategoryName(e, catById) }));
  const total = budgetLines(budgets, entries, month, cats, today, { catById }).find((l) => l.key === "total") ?? null;
  return {
    expenses,
    decimals: curs.find((c) => c.is_main === 1)?.decimals ?? 0,
    budget: total ? { month, budget: total.budget, used: total.used, remaining: total.remaining } : null,
  };
}

async function notesFacts(today: string, from: string, h: number) {
  const [notedAt, marks] = await Promise.all([
    reportQueries.noteTimes(isoStart(from, h), isoEnd(today, h)),
    noteRepo.listDiaryMarks(from, today),
  ]);
  return { notedAt, diaryDays: Object.keys(marks).filter((d) => marks[d] > 0) };
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
  const from = factsFrom(today);
  const [seals, late, soon, dueByDay, time, money, notes, yearAgo, dayNotes] = await Promise.all([
    sealRepo.listSeals(from, today, h),
    lateDays(today, h),
    dueSoon(today, h),
    reportQueries.dueCountByDay(from, today),
    o.open.timetable ? timeFacts(o, from) : Promise.resolve(null),
    o.open.ticket ? moneyFacts(today, from) : Promise.resolve(null),
    o.open.notes ? notesFacts(today, from, h) : Promise.resolve(null),
    o.open.notes ? yearAgoFacts(today, h) : Promise.resolve(null),
    o.dayNotes ? o.dayNotes(from, today) : Promise.resolve(null),
  ]);
  return {
    today,
    dayStartHour: h,
    weekStart: o.weekStart,
    days: o.days,
    seals: seals.map((s) => ({ at: s.at, nodeId: s.nodeId, routeId: s.routeId })),
    late,
    dueSoon: soon,
    dueByDay,
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

export async function loadBriefFacts(o: Omit<LoadReportOpts, "days" | "weekStart" | "routes" | "dayNotes">): Promise<BriefFacts> {
  const { today, dayStartHour: h } = o;
  const [seals, time, money] = await Promise.all([
    sealRepo.listSeals(today, today, h),
    o.open.timetable ? timeFacts({ ...o, days: 7, weekStart: 1, routes: [], dayNotes: null }, today) : Promise.resolve(null),
    o.open.ticket ? moneyFacts(today, today) : Promise.resolve(null),
  ]);
  return {
    seals: seals.length,
    recordedMs: time ? time.byDay[today] ?? 0 : null,
    spent: money ? money.expenses.reduce((a, e) => a + e.minor, 0) : null,
    decimals: money?.decimals ?? 0,
  };
}
