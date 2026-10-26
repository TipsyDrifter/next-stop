/**
 * `get-overview`：助理開場第一支（Rust 的 instructions 也這樣引導）。只放「可讀」的功能，關著的功能連一個字都不給。
 * 每段都是既有讀取方法的摘要，不另算規則：今天的車票走 `listToday`（與今日頁同一份）、運行中走 `listRunning`、
 * 今天的帳走 `listEntries`（與售票口日帳同一支）。
 */
import type { TodayRow } from "../../data/nodeRepository";
import { dayCount, dayCountText, type DayCountItem } from "../../domain/dayCount";
import { addDays } from "../../lib/date";
import type { McpCtx, McpModule, McpTool } from "../types";

function canRead(ctx: McpCtx, m: McpModule): boolean {
  return ctx.access[m] !== "off";
}

/** 與今日頁頁首同一把尺（`ui/today/useTodayController.ts` 的 isDoneRow／isSettledRow；那支檔帶 store，這裡不 import） */
function dayItem(row: TodayRow): DayCountItem {
  return {
    done: row.occurrence ? row.occurrence.status === "done" : row.status === "done",
    settled: row.occurrence !== null || row.status === "done",
  };
}

export const getOverview: McpTool = {
  name: "get-overview",
  title: "今天的總覽",
  description:
    "私鐵手帳今天的總覽：車票（task）數、誤點（過期未完成）、正在計時的時間塊、今天的收支、收件匣筆數。只會包含使用者開放的功能。日期是營業日（照日界線），YYYY-MM-DD。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  module: "overview",
  access: "read",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  async run(_args, ctx) {
    const out: Record<string, unknown> = { today: ctx.today, dayStartHour: ctx.dayStartHour };
    const parts: string[] = [];
    const closed: string[] = [];

    if (canRead(ctx, "tasks")) {
      const rows = await ctx.deps.nodeRepo.listToday(ctx.today, ctx.dayStartHour);
      const late = rows.filter((r) => r.bucket === "late" || r.bucket === "due");
      const count = dayCount(rows.filter((r) => r.bucket === "today").map(dayItem));
      out.tasks = {
        ...count,
        late: late.length,
        lateTop: late.slice(0, 10).map((r) => ({ id: r.id, name: r.name, scheduledOn: r.scheduled_on, dueOn: r.due_on })),
      };
      parts.push(`今天${dayCountText(count) || "沒有車票"}；誤點 ${late.length} 張`);
    } else closed.push("任務");

    if (canRead(ctx, "timetable")) {
      const running = await ctx.deps.timetableRepo.listRunning();
      const cats = await ctx.deps.timetableRepo.listCategories();
      const name = new Map(cats.map((c) => [c.id, c.name]));
      out.running = running.map((b) => ({ id: b.id, category: name.get(b.category_id) ?? b.category_id, startedAt: b.started_at }));
      parts.push(running.length ? `運行中 ${running.length} 塊` : "沒有運行中的時間塊");
    } else closed.push("時刻表");

    if (canRead(ctx, "ledger")) {
      const entries = await ctx.deps.ticketRepo.listEntries(ctx.today, addDays(ctx.today, 1), null);
      out.ledgerToday = { count: entries.length };
      parts.push(`今天記了 ${entries.length} 筆帳`);
    } else closed.push("帳目");

    if (canRead(ctx, "notes")) {
      const inbox = await ctx.deps.noteRepo.listInbox();
      out.inbox = { count: inbox.length };
      parts.push(`收件匣 ${inbox.length} 則`);
    } else closed.push("筆記");

    if (canRead(ctx, "diary")) {
      const diary = await ctx.deps.noteRepo.listDiary(ctx.today);
      out.diaryToday = { count: diary.length };
      parts.push(diary.length ? `今天寫了 ${diary.length} 則日記` : "今天還沒寫日記");
    } else closed.push("日記");

    if (closed.length) out.notOpen = closed;
    return {
      summary: `${ctx.today}：${parts.join("；") || "沒有開放任何功能"}${closed.length ? `（沒有開放：${closed.join("、")}）` : ""}`,
      data: out,
    };
  },
};

export const OVERVIEW_TOOLS: McpTool[] = [getOverview];
