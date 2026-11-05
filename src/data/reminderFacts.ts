/**
 * reminderFacts——把提醒要的事實一次讀齊（⑨ 契約 §4）。只讀、0 migration；讀完交給純函式 `buildReminderPlan`。
 *
 * 各模組的讀法：締切與時刻＝`listCalendar`（已排除車庫與已完成，定期券有逐班時刻）；誤點＝`listToday`（今日頁同一份、同一條「還沒交代」）；
 * 車站預定到站日＝`listSidebar`；多時段與作息＝`listPlans`＋`dayRoutineOf`；回顧＝`weekAimRepo.listRange`；定期帳＝`listRepeats`＋`projectFixed`。
 * 設定關掉的種類不讀。某一段讀失敗只丟那一段（記一行、給空），不拖累別段：寧可少響一種，不要全部不響。
 * `dayStartHour` 一律明傳：`listToday`、`listCalendar` 的參數預設是 3，App 預設是 6。
 */
import { nodeRepo } from "./index";
import { timetableRepo } from "./timetableRepository";
import { ticketRepo } from "./ticketRepository";
import { weekAimRepo } from "./weekAimRepository";
import { addDays, todayKey } from "../lib/date";
import type { NodeRow } from "../domain";
import {
  REMINDER_HORIZON_DAYS,
  type AimWeekFact,
  type DueFact,
  type LateFact,
  type ReminderFacts,
  type ReminderSettings,
  type RepeatFact,
  type RoutineFact,
  type TimedFact,
} from "../domain/reminders";
import { projectFixed } from "../domain/repeat";
import { moneyText } from "../domain/ticket";
import { parseFixedRule, parseSkipped } from "../domain/ticketPlan";
import { dayRoutineOf, segName } from "../domain/timetableRoutine";
import { weekEndOf, weekOnOf } from "../domain/weekAims";

export interface LoadReminderOpts {
  now: number;
  dayStartHour: number;
  weekStart: 0 | 1;
  settings: ReminderSettings;
  /** 時刻表、售票口通車了嗎（沒通車就不讀那一段） */
  open: { timetable: boolean; ticket: boolean };
}

async function part<T>(name: string, fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[reminders] 讀${name}失敗：`, e instanceof Error ? e.message : String(e));
    return [];
  }
}

export async function loadReminderFacts(o: LoadReminderOpts): Promise<ReminderFacts> {
  const { dayStartHour: h, settings: s } = o;
  const today = todayKey(h, new Date(o.now));
  const to = addDays(today, REMINDER_HORIZON_DAYS);
  const wantDues = s.dueEve || s.dueDay;

  // 先把定期券的班次推到位（同 nodeStore.loadToday）：好幾天沒開 App 時 scheduled_on 還是舊的，不推會誤報「誤點 5 天」。
  // 開機時這裡可能比 loadToday 先跑；推算是冪等的，也不進同步
  await nodeRepo.syncRepeats(today, h).catch((e: unknown) => console.warn("[reminders] 推班次失敗：", e instanceof Error ? e.message : String(e)));

  const sidebar = await nodeRepo.listSidebar().catch(() => ({ lines: [], routes: [], stations: [] as NodeRow[] }));
  const routeName = new Map(sidebar.routes.map((r) => [r.id, r.name] as const));
  const nameOfRoute = (n: NodeRow): string | null => (n.route_id ? (routeName.get(n.route_id) ?? null) : null);

  const cal =
    wantDues || s.timed
      ? await nodeRepo.listCalendar(today, to, { todayDateKey: today, dayStartHour: h }).catch(() => null)
      : null;

  const dues: DueFact[] = [];
  if (wantDues) {
    if (cal) {
      for (const d of cal.dues) {
        const n = cal.nodes[d.node_id];
        if (n) dues.push({ nodeId: n.id, name: n.name, day: d.date, routeName: nameOfRoute(n) });
      }
    }
    // 車站預定到站日併進締切（同語義）。收進車庫的路線不提醒，還沒到站的才算
    for (const st of sidebar.stations) {
      const day = st.expected_on;
      if (!day || st.arrived_on || day < today || day > to) continue;
      const route = sidebar.routes.find((r) => r.id === st.parent_id);
      if (route?.arrived_on) continue;
      dues.push({ nodeId: st.id, name: st.name, day, routeName: route?.name ?? null });
    }
  }

  const timed: TimedFact[] = [];
  if (s.timed && cal) {
    for (const e of cal.entries) {
      if (!e.time || e.is_done || e.is_assumed || e.occurrence_status !== null) continue;
      const n = cal.nodes[e.node_id];
      if (n) timed.push({ nodeId: n.id, name: n.name, day: e.date, time: e.time, routeName: nameOfRoute(n), planId: null });
    }
  }

  const needPlans = o.open.timetable && (s.timed || s.routine);
  const plans = needPlans ? await part("時段", () => timetableRepo.listPlans(today, to)) : [];

  if (s.timed && o.open.timetable) {
    // 車票第二段起（第一段是上面的 scheduled_time）；票已済或刪了就不響
    const slots = plans.filter((p) => p.node_id !== null && p.deleted_at === null);
    const nodes = new Map<string, NodeRow | null>();
    for (const p of slots) {
      const id = p.node_id as string;
      if (nodes.has(id)) continue;
      nodes.set(id, cal?.nodes[id] ?? (await nodeRepo.getNode(id).catch(() => null)));
    }
    for (const p of slots) {
      const n = nodes.get(p.node_id as string);
      if (!n || n.deleted_at !== null || n.status === "done") continue;
      timed.push({ nodeId: n.id, name: n.name, day: p.day, time: p.start_hm, routeName: nameOfRoute(n), planId: p.id });
    }
  }

  const lates: LateFact[] = !s.late
    ? []
    : await part("誤點", async () => {
        const rows = await nodeRepo.listToday(today, h);
        const out: LateFact[] = [];
        for (const r of rows) {
          if (r.bucket === "today" || r.occurrence !== null || r.status === "done") continue;
          const anchor = r.bucket === "late" ? r.scheduled_on : r.due_on;
          if (anchor && anchor <= today) out.push({ nodeId: r.id, name: r.name, anchor });
        }
        return out;
      });

  const aimWeeks: AimWeekFact[] = !s.review
    ? []
    : await part("週方針", async () => {
        const rows = await weekAimRepo.listRange(weekOnOf(today, o.weekStart), to);
        const weeks = new Set(rows.filter((r) => r.deleted_at === null).map((r) => r.week_on));
        return [...weeks].map((weekOn) => ({ weekOn, lastDay: weekEndOf(weekOn) })).filter((w) => w.lastDay >= today);
      });

  const repeats: RepeatFact[] =
    !s.repeat || !o.open.ticket
      ? []
      : await part("定期帳", async () => {
          const [rules, cats, curs] = await Promise.all([ticketRepo.listRepeats(), ticketRepo.listCategories(), ticketRepo.listCurrencies()]);
          const catName = new Map(cats.map((c) => [c.id, c.name] as const));
          const decimals = new Map(curs.map((c) => [c.code, c.decimals] as const));
          const out: RepeatFact[] = [];
          for (const r of rules) {
            if (r.paused_at !== null) continue;
            const rule = parseFixedRule(r.rule);
            if (!rule) continue;
            const skipped = new Set(parseSkipped(r.skipped_days));
            const minor = r.kind === "expense" ? -Math.abs(r.amount_minor) : r.amount_minor;
            const amountText = moneyText(minor, decimals.get(r.currency) ?? 2);
            const label = r.note.trim() || (r.category_id ? catName.get(r.category_id) : null) || "定期帳";
            for (const day of projectFixed(rule, today, to)) {
              if (!skipped.has(day)) out.push({ repeatId: r.id, day, label, amountText });
            }
          }
          return out;
        });

  const routines: RoutineFact[] =
    !s.routine || !o.open.timetable
      ? []
      : await part("作息", async () => {
          const [list, cats] = await Promise.all([timetableRepo.listRoutines(), timetableRepo.listCategories()]);
          const catName = new Map(cats.map((c) => [c.id, c.name] as const));
          const out: RoutineFact[] = [];
          for (let i = 0; i <= REMINDER_HORIZON_DAYS; i++) {
            const day = addDays(today, i);
            const dr = await dayRoutineOf(day, plans.filter((p) => p.day === day), list, today);
            for (const seg of dr.segs) {
              const name = segName(seg, seg.cat ? (catName.get(seg.cat) ?? null) : null);
              if (name) out.push({ segId: seg.id, day, name, start: seg.s, end: seg.e });
            }
          }
          return out;
        });

  return { today, dayStartHour: h, dues, lates, timed, aimWeeks, repeats, routines };
}
