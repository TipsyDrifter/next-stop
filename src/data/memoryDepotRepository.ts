/**
 * MemoryDepotRepository——DepotRepository 的記憶體實作（`?mock=1`；車庫與回顧 ③）。
 *
 * 語義對齊 SQLite 版：事實從核心的記憶體庫（`MemoryNodeRepository.depotDump`）、筆記、時刻表的公開方法拼出來；
 * 售票口的第一筆帳在假資料裡不算（記帳滿一年在 mock 不會出現——mock 的帳都是「今天」附近的種子）。
 * 章存在實例上，重新整理即重置（同其他記憶體實作）。
 */
import { dayKeyOf } from "../lib/date";
import type { NodeRow, Occurrence, WorkLog } from "../domain";
import type { BlockFact, StampFacts, StampPlan, StampRow } from "../domain/stamps";
import { dedupeSeals, sealsInWindow } from "../domain/seals";
import type { NoteRepository } from "./noteRepository";
import type { TimetableRepository } from "./timetableRepository";
import { blockCounts, openedOnOf, parseLongRunMax, type DepotData, type DepotRepository, type NoteDigest } from "./depotRepository";

interface DumpSource {
  depotDump(): { nodes: NodeRow[]; occurrences: Occurrence[]; logs: WorkLog[] };
}

const FAR_PAST = "1970-01-01T00:00:00.000Z";
const FAR_FUTURE = "2999-12-31T00:00:00.000Z";

export class MemoryDepotRepository implements DepotRepository {
  private readonly stamps = new Map<string, StampRow>();

  constructor(
    private readonly nodes: DumpSource,
    private readonly notes: () => NoteRepository,
    private readonly timetable: () => TimetableRepository,
  ) {}

  async listStamps(): Promise<StampRow[]> {
    return [...this.stamps.values()].map((s) => ({ ...s }));
  }

  async applyStampPlan(plan: StampPlan): Promise<void> {
    const now = new Date().toISOString();
    for (const s of plan.insert) {
      if (this.stamps.has(s.id)) continue;
      this.stamps.set(s.id, { ...s, created_at: now, updated_at: now, deleted_at: null });
    }
    for (const s of plan.revive) {
      const row = this.stamps.get(s.id);
      if (row) this.stamps.set(s.id, { ...row, deleted_at: null, stamped_on: s.stamped_on, label: s.label, updated_at: now });
    }
    for (const r of plan.retract) {
      const row = this.stamps.get(r.id);
      if (row) this.stamps.set(r.id, { ...row, deleted_at: now, updated_at: now });
    }
  }

  private openings(nodes: NodeRow[], logs: WorkLog[], dayStartHour: number): Record<string, string> {
    const routeOf = new Map(nodes.map((n) => [n.id, n.route_id] as const));
    const first = new Map<string, string>();
    for (const l of logs) {
      if (l.event !== "issued") continue;
      const rid = routeOf.get(l.node_id);
      if (!rid) continue;
      const cur = first.get(rid);
      if (!cur || l.logged_at < cur) first.set(rid, l.logged_at);
    }
    const out: Record<string, string> = {};
    for (const r of nodes) if (r.kind === "route") out[r.id] = openedOnOf(r.created_at, first.get(r.id) ?? null, dayStartHour);
    return out;
  }

  /** 全部的済，舊→新（② 的共用口徑 `domain/seals.ts`，同 SQLite 版） */
  private seals(nodes: NodeRow[], occ: Occurrence[]): { route_id: string | null; name: string; at: string }[] {
    const all = sealsInWindow({ start: "0000-01-01T00:00:00.000Z", end: "9999-12-31T00:00:00.000Z" }, nodes, occ);
    return dedupeSeals(all).map((s) => ({ route_id: s.routeId, name: s.name, at: s.at }));
  }

  private async diaries(): Promise<{ id: string; created_at: string; title: string | null; body: string; entry_date: string | null; noted_at: string }[]> {
    const repo = this.notes();
    const days = await repo.listDiaryDays("1970-01-01", "2999-12-31");
    const lists = await Promise.all(days.map((d) => repo.listDiary(d)));
    return lists.flat();
  }

  async stampFacts(today: string, dayStartHour: number): Promise<StampFacts> {
    const { nodes, occurrences, logs } = this.nodes.depotDump();
    const tasks = nodes
      .filter((n) => n.kind === "train" || n.kind === "car" || n.kind === "ticket")
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const opened = this.openings(nodes, logs, dayStartHour);
    const pick = (k: string) =>
      nodes.filter((n) => n.kind === k).map((n) => ({ id: n.id, name: n.name, arrived_on: n.arrived_on, alive: n.deleted_at === null }));
    const diaries = (await this.diaries()).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const tt = this.timetable();
    const [blocks, cats] = await Promise.all([tt.listBlocks(FAR_PAST, FAR_FUTURE), tt.listCategories()]);
    const globalMax = parseLongRunMax(null);
    const blockFacts: BlockFact[] = blocks
      .filter((b): b is typeof b & { ended_at: string } => b.ended_at !== null && b.deleted_at === null)
      .filter((b) => blockCounts(b, globalMax))
      .sort((a, b) => (a.ended_at < b.ended_at ? -1 : 1))
      .map((b) => ({
        category_id: b.category_id,
        ms: Date.parse(b.ended_at) - Date.parse(b.started_at),
        end_day: dayKeyOf(b.ended_at, dayStartHour),
        end_at: b.ended_at,
      }));
    return {
      today,
      firstTask: tasks[0] ? { day: dayKeyOf(tasks[0].created_at, dayStartHour), name: tasks[0].name } : null,
      stations: pick("station"),
      routes: pick("route").map((r) => ({ ...r, opened_on: opened[r.id] ?? today })),
      lines: pick("line"),
      seals: this.seals(nodes, occurrences).map((s) => ({ day: dayKeyOf(s.at, dayStartHour), name: s.name })),
      diaryDays: diaries.map((d) => dayKeyOf(d.created_at, dayStartHour)),
      ledgerFirstDay: null,
      blocks: blockFacts,
      categoryNames: Object.fromEntries(cats.map((c) => [c.id, c.name])),
    };
  }

  async loadDepot(dayStartHour: number): Promise<DepotData> {
    const { nodes, occurrences, logs } = this.nodes.depotDump();
    const seals = this.seals(nodes, occurrences);
    const routeSeals: Record<string, number> = {};
    for (const s of seals) if (s.route_id) routeSeals[s.route_id] = (routeSeals[s.route_id] ?? 0) + 1;
    const repo = this.notes();
    const [notes, diaries] = await Promise.all([repo.listNotes({ limit: 100000 }), this.diaries()]);
    const digests: NoteDigest[] = [
      ...notes.map((n) => ({
        id: n.id,
        kind: "note" as const,
        day: dayKeyOf(n.noted_at, dayStartHour),
        noted_at: n.noted_at,
        title: n.title,
        text: n.body.slice(0, 200),
      })),
      ...diaries.map((d) => ({
        id: d.id,
        kind: "diary" as const,
        day: d.entry_date ?? dayKeyOf(d.noted_at, dayStartHour),
        noted_at: d.noted_at,
        title: d.title,
        text: d.body.slice(0, 200),
      })),
    ];
    return {
      openedOn: this.openings(nodes, logs, dayStartHour),
      routeSeals,
      sealDays: seals.map((s) => dayKeyOf(s.at, dayStartHour)),
      notes: digests,
    };
  }
}
