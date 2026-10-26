/**
 * 外部助理（MCP）——排行程（契約 §4「排行程」列；開關算任務 module 'tasks'）。
 *
 * propose-schedule 只算不寫：每張票原本→提案的日期時刻、那天已經有幾班、同日同時刻撞到誰；方案存在本模組的記憶體裡
 * （App 重開就沒了），30 分鐘有效，記下每張票提案當下的 updated_at。
 * apply-schedule 照 planId 寫：過期、或任何一張票提案後被改過（updated_at 或排程相關欄位變了）就整個拒絕；否則每張走
 * reschedule-tasks 同一條路（`applyReschedule`：單發票＝reschedule＋update 時刻，定期券＝setRunTime 這一班）。
 * 過期一律看 ctx.now（測試可注入）。
 */
import { uuid } from "../../lib/db";
import { effectiveTime } from "../../domain/scheduledTime";
import type { NodeRow } from "../../domain";
import { batch, str } from "../args";
import { McpUserError, type McpTool } from "../types";
import { aliveTask, applyReschedule, checkReschedule, compact, parseRescheduleItem, runEach, strictArgs, type RescheduleItem } from "./tasks";

const PLAN_TTL_MS = 30 * 60_000;
/** 提案的日期最多跨幾天（listCalendar 一趟撈的範圍） */
const PLAN_SPAN_DAYS = 92;
const DATED_KINDS = ["train", "car", "ticket"] as const;

interface PlanItem extends RescheduleItem {
  date: string;
  name: string;
  /** 提案當下的指紋（updated_at＋排程相關欄位）：套用前比對，變了＝有人改過 */
  stamp: string;
}
interface Plan {
  expiresAt: number;
  items: PlanItem[];
}

const plans = new Map<string, Plan>();

/**
 * 「被改過沒」的指紋：updated_at 是 ISO 毫秒，同一毫秒內的兩次寫入比不出來（memory 版尤其常見），
 * 所以連同 apply 會讀、會蓋到的欄位一起比——多比只會多拒絕一次（要重提），不會寫錯。
 */
const stampOf = (n: NodeRow) =>
  JSON.stringify([n.updated_at, n.deleted_at, n.name, n.status, n.scheduled_on, n.scheduled_time, n.time_overrides, n.repeat_rule]);

function sweep(now: number): void {
  for (const [id, p] of plans) if (p.expiresAt < now) plans.delete(id);
}

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86_400_000);

const proposeSchedule: McpTool = {
  name: "propose-schedule",
  title: "提案排行程",
  description:
    "一次排好幾張車票前先用這支：只算不寫，回每張票原本→提案的日期時刻、那天已經有幾班、同日同時刻撞到誰，以及 planId。跟使用者確認後用 apply-schedule 套用（30 分鐘內有效）。date 不能早於今天；定期券只能帶目前班次日改這一班的時刻。",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "車票 id" },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "排到哪天 YYYY-MM-DD" },
            time: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$", description: "幾點 HH:MM；省略＝不動、null＝清掉" },
          },
          required: ["taskId", "date"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "read",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async run(args, ctx) {
    const raw = batch(args, "items").map((a, i) => {
      const it = parseRescheduleItem(a, `items[${i}]`, "taskId");
      if (it.date === null) throw new McpUserError(`items[${i}].date 要是日期（清掉執行日請用 reschedule-tasks）`);
      return it as RescheduleItem & { date: string };
    });
    const seen = new Set<string>();
    for (const it of raw) {
      if (seen.has(it.id)) throw new McpUserError(`同一張票（${it.id}）出現兩次`);
      seen.add(it.id);
    }
    const repo = ctx.deps.nodeRepo;
    // 同 nodeStore.loadCalendar：先把定期券的班次推到位（之後記下的 updated_at 才是穩定的）
    await repo.syncRepeats(ctx.today, ctx.dayStartHour);

    // 全部驗過才算：方案是全有或全無（apply 也是）
    const nodes: NodeRow[] = [];
    const problems: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      try {
        const n = await aliveTask(ctx, raw[i].id, DATED_KINDS);
        checkReschedule(ctx, n, raw[i]);
        nodes.push(n);
      } catch (e) {
        problems.push(`第 ${i + 1} 筆：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (problems.length) throw new McpUserError(problems.join("；"));

    const dates = raw.map((it) => it.date).sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    if (daysBetween(from, to) + 1 > PLAN_SPAN_DAYS) throw new McpUserError(`提案的日期最多跨 ${PLAN_SPAN_DAYS} 天`);
    const cal = await repo.listCalendar(from, to, { todayDateKey: ctx.today, dayStartHour: ctx.dayStartHour });
    // 「那天已經有的」＝不在這次方案裡、還沒交代掉的班（済／運休的不算佔位）
    const existing = cal.entries.filter((e) => !seen.has(e.node_id) && !e.is_done && e.occurrence_status !== "skipped");

    const items = raw.map((it, i) => {
      const n = nodes[i];
      const time = it.time === undefined ? effectiveTime(n, it.date) : it.time;
      const clashes = time
        ? [
            ...existing.filter((e) => e.date === it.date && e.time === time).map((e) => ({ id: e.node_id, name: cal.nodes[e.node_id]?.name ?? "" })),
            ...raw
              .map((o, j) => ({ o, j }))
              .filter(({ o, j }) => j !== i && o.date === it.date && (o.time === undefined ? effectiveTime(nodes[j], o.date) : o.time) === time)
              .map(({ j }) => ({ id: nodes[j].id, name: nodes[j].name, inPlan: true })),
          ]
        : [];
      return {
        plan: { ...it, name: n.name, stamp: stampOf(n) } as PlanItem,
        view: compact({
          taskId: n.id,
          name: n.name,
          from: compact({ date: n.scheduled_on, time: effectiveTime(n, n.scheduled_on) }),
          to: compact({ date: it.date, time }),
          clashes: clashes.length ? clashes : null,
        }),
      };
    });

    const days = [...new Set(dates)].map((d) => ({
      date: d,
      existing: existing.filter((e) => e.date === d).length,
      proposed: raw.filter((it) => it.date === d).length,
    }));

    const now = ctx.now.getTime();
    sweep(now);
    const planId = uuid();
    const expiresAt = now + PLAN_TTL_MS;
    plans.set(planId, { expiresAt, items: items.map((x) => x.plan) });
    const clashCount = items.filter((x) => x.view.clashes).length;
    return {
      summary: `提案 ${items.length} 張${clashCount ? `，${clashCount} 張撞時刻` : ""}；確認後用 apply-schedule 套用（planId ${planId}，30 分鐘內有效）`,
      data: { planId, expiresAt: new Date(expiresAt).toISOString(), items: items.map((x) => x.view), days },
    };
  },
};

const applySchedule: McpTool = {
  name: "apply-schedule",
  title: "套用排行程",
  description:
    "套用 propose-schedule 的方案（planId）。方案 30 分鐘內有效；提案後只要有一張票被改過就整個拒絕，請重新提案。寫入等同逐張 reschedule-tasks（繰越）。",
  inputSchema: {
    type: "object",
    properties: { planId: { type: "string", description: "propose-schedule 回的 planId" } },
    required: ["planId"],
    additionalProperties: false,
  },
  module: "tasks",
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async run(args, ctx) {
    const planId = str(args, "planId", { required: true });
    const now = ctx.now.getTime();
    const plan = plans.get(planId);
    if (!plan) throw new McpUserError("找不到這個方案（可能已經套用過、過期，或 App 重開過）——請重新 propose-schedule");
    if (plan.expiresAt < now) {
      plans.delete(planId);
      throw new McpUserError("方案已過期（30 分鐘）——請重新 propose-schedule");
    }
    const repo = ctx.deps.nodeRepo;
    await repo.syncRepeats(ctx.today, ctx.dayStartHour); // 同 propose：班次先推到位再比對
    const current: (NodeRow | null)[] = [];
    const stale: string[] = [];
    for (const it of plan.items) {
      const n = await repo.getNode(it.id);
      if (!n || n.deleted_at !== null || stampOf(n) !== it.stamp) stale.push(`「${it.name}」`);
      current.push(n);
    }
    if (stale.length) {
      plans.delete(planId);
      throw new McpUserError(`提案之後 ${stale.join("、")} 被改過或刪掉了——整個方案沒有套用，請重新 propose-schedule`);
    }
    plans.delete(planId); // 一個方案只套一次
    const results = await runEach(plan.items, (it, i) => applyReschedule(ctx, current[i]!, it));
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    return {
      summary: `排好了 ${ok} 張${failed ? `，${failed} 張失敗（見 results）` : ""}`,
      data: results,
      changed: ok ? ["nodes", "work_logs"] : undefined,
      toast: ok ? `外部助理排好了 ${ok} 張車票` : undefined,
    };
  },
};

export const SCHEDULE_TOOLS: McpTool[] = [proposeSchedule, applySchedule].map(strictArgs);
