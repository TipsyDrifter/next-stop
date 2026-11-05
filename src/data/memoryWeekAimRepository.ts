/**
 * 週方針的記憶體實作（`?mock=1`；戊）。行為對齊 SQLite 版（`scripts/tests/week-aims-repo.test.ts` 兩邊跑同一套）。
 *
 * 「已排」與蓋章數從注入的 nodeRepo 讀（路線樹＝`listRouteTree`，含掛路線標籤的臨時票）；時刻表與售票口在 mock 不跨模組讀，
 * 回 null（畫「—」）。示範種子：這週三句（一句已済），掛示範路線；`?mock=1&aims=lastweek` 另種上週兩句（拍「上週回顧」用）；
 * `?mock=1&aims=queue` 再加上個月、去年各幾句（拍回顧排隊 D-主-373 用）；
 * 本月、今年各幾句，示範路線第一個還沒到站的車站兩句（方針擴充 辛）。
 */
import type { NodeRow } from "../domain";
import type { NodeRepository } from "./nodeRepository";
import type { AimNodeRef, ReviewResult, WeekAimRepository } from "./weekAimRepository";
import { DEFAULT_DAY_START_HOUR, addDays, todayKey } from "../lib/date";
import {
  adjacentKey,
  assertAimLimit,
  aimsOfKey,
  dayRangeWindow,
  monthKeyOf,
  stationKeyOf,
  toDayRange,
  weekOnOf,
  yearKeyOf,
  type AimSavePlan,
  type DayRange,
  type PlanCount,
  type ReviewStat,
  type WeekAimRow,
} from "../domain/weekAims";
import { dedupeSeals, sealsInWindow, type SealOccSrc } from "../domain/seals";

const PLAN_KINDS = new Set(["ticket", "train", "car"]);
const isRepeat = (n: NodeRow): boolean => !!n.repeat_rule && n.repeat_rule !== "";

/** 示範種子的旗標：`?aims=lastweek`／`?aims=queue` */
function aimsFlag(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("aims");
  } catch {
    return null;
  }
}

export class MemoryWeekAimRepository implements WeekAimRepository {
  private readonly rows = new Map<string, WeekAimRow>();
  private readonly nodeRepo: Pick<NodeRepository, "listRouteTree" | "getNode" | "listSidebar" | "listOccurrences">;
  private seeded: Promise<void> | null;
  /** 寫入戳記：一直往前走（同毫秒兩筆也分得出先後） */
  private clock = 0;

  constructor(opts: { nodeRepo: Pick<NodeRepository, "listRouteTree" | "getNode" | "listSidebar" | "listOccurrences">; seedDemo?: boolean }) {
    this.nodeRepo = opts.nodeRepo;
    this.seeded = opts.seedDemo ? null : Promise.resolve();
  }

  private now(): string {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return new Date(this.clock).toISOString();
  }

  private ensureSeed(): Promise<void> {
    if (!this.seeded) this.seeded = this.seed().catch((e: unknown) => console.warn("週方針示範種子失敗", e));
    return this.seeded;
  }

  private async seed(): Promise<void> {
    const { routes, stations } = await this.nodeRepo.listSidebar();
    const r = (i: number) => routes[i]?.id ?? null;
    const today = todayKey(DEFAULT_DAY_START_HOUR);
    const week = weekOnOf(today, 1);
    const put = (weekOn: string, text: string, nodeId: string | null, position: number, done: boolean): void => {
      const at = this.now();
      const id = crypto.randomUUID();
      this.rows.set(id, {
        id,
        week_on: weekOn,
        text,
        node_id: nodeId,
        position,
        done_at: done ? at : null,
        carried_from: null,
        account_id: null,
        device_id: null,
        created_at: at,
        updated_at: at,
        synced_at: null,
        deleted_at: null,
      });
    };
    const flag = aimsFlag();
    if (flag === "lastweek" || flag === "queue") {
      const prev = addDays(week, -7);
      put(prev, "把上週的報告收尾", r(0), 0, true);
      put(prev, "跑三次", r(1), 1, false);
    }
    if (flag === "queue") {
      const lastMonth = adjacentKey(monthKeyOf(today), -1);
      put(lastMonth, "N4 單字背完", r(0), 0, true);
      put(lastMonth, "登入流程寫完", r(1), 1, false);
      put(lastMonth, "每週運動三次", null, 2, false);
      put(adjacentKey(yearKeyOf(today), -1), "開始學日文", r(0), 0, false);
    }
    put(week, "N5 文法第 5～6 課", r(0), 0, true);
    put(week, "v0.2 的登入頁", r(1), 1, false);
    put(week, "整理房間", null, 2, false);
    const month = monthKeyOf(today);
    put(month, "N5 文法全部過一輪", r(0), 0, false);
    put(month, "把登入與同步做到能給朋友試用", r(1), 1, false);
    put(month, "每週運動三次", null, 2, false);
    const year = yearKeyOf(today);
    put(year, "考過 N5", r(0), 0, false);
    put(year, "v1.0 上架", r(1), 1, false);
    // 車站：掛示範路線的第一個還沒到站的車站；句子不掛路線（已經在車站底下，D-主-372）
    for (const route of routes) {
      const next = stations.find((s) => s.parent_id === route.id && s.arrived_on === null);
      if (!next) continue;
      const key = stationKeyOf(next.id);
      put(key, "到站前把模擬考做完兩回", null, 0, false);
      put(key, "報名費繳掉", null, 1, true);
      break;
    }
  }

  async listRange(from: string, to: string): Promise<WeekAimRow[]> {
    await this.ensureSeed();
    return [...this.rows.values()]
      .filter((r) => r.week_on >= from && r.week_on <= to)
      .sort((a, b) => a.week_on.localeCompare(b.week_on) || a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }

  async listKeys(keys: readonly string[]): Promise<WeekAimRow[]> {
    await this.ensureSeed();
    const want = new Set(keys);
    return [...this.rows.values()]
      .filter((r) => want.has(r.week_on))
      .sort((a, b) => a.week_on.localeCompare(b.week_on) || a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }

  async getAim(id: string, opts?: { withDeleted?: boolean }): Promise<WeekAimRow | null> {
    await this.ensureSeed();
    const r = this.rows.get(id);
    if (!r) return null;
    return r.deleted_at !== null && !opts?.withDeleted ? null : { ...r };
  }

  async searchAims(query: string): Promise<WeekAimRow[]> {
    await this.ensureSeed();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return [...this.rows.values()]
      .filter((r) => r.deleted_at === null && r.text.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || (a.id < b.id ? -1 : 1))
      .map((r) => ({ ...r }));
  }

  private alive(id: string): WeekAimRow {
    const r = this.rows.get(id);
    if (!r || r.deleted_at !== null) throw new RangeError("找不到這句方針");
    return r;
  }

  async saveWeek(key: string, plan: AimSavePlan): Promise<void> {
    await this.ensureSeed();
    const aliveIds = new Set(aimsOfKey([...this.rows.values()], key).map((r) => r.id));
    assertAimLimit(key, aliveIds, plan);
    const now = this.now();
    for (const c of plan.creates) {
      const id = c.id ?? crypto.randomUUID();
      const prev = this.rows.get(id);
      this.rows.set(id, {
        id,
        week_on: key,
        text: c.text,
        node_id: c.nodeId,
        position: c.position,
        done_at: null,
        carried_from: c.carriedFrom,
        account_id: null,
        device_id: null,
        created_at: prev?.created_at ?? now,
        updated_at: now,
        synced_at: null,
        deleted_at: null,
      });
    }
    for (const u of plan.updates) {
      const r = this.rows.get(u.id);
      if (!r || r.deleted_at !== null) continue;
      if (u.text !== undefined) r.text = u.text;
      if (u.nodeId !== undefined) r.node_id = u.nodeId;
      if (u.position !== undefined) r.position = u.position;
      r.updated_at = now;
    }
    for (const id of plan.deletes) {
      const r = this.rows.get(id);
      if (!r || r.deleted_at !== null || !aliveIds.has(id)) continue;
      r.deleted_at = now;
      r.updated_at = now;
    }
  }

  async setDone(id: string, at: string | null): Promise<void> {
    await this.ensureSeed();
    const r = this.alive(id);
    if ((r.done_at === null) === (at === null)) return;
    r.done_at = at;
    r.updated_at = this.now();
  }

  async deleteAim(id: string): Promise<void> {
    await this.ensureSeed();
    const r = this.alive(id);
    r.deleted_at = this.now();
    r.updated_at = r.deleted_at;
  }

  async restoreAim(id: string): Promise<void> {
    await this.ensureSeed();
    const r = this.rows.get(id);
    if (!r || r.deleted_at === null) throw new RangeError("找不到這句方針");
    r.deleted_at = null;
    r.updated_at = this.now();
  }

  /** 節點底下（不含自己）的活節點：路線＝路線樹（含路線標籤的臨時票）；其他＝它所在路線樹裡的子孫 */
  private async under(n: AimNodeRef): Promise<NodeRow[]> {
    if (n.kind === "route") return this.nodeRepo.listRouteTree(n.id);
    const self = await this.nodeRepo.getNode(n.id);
    if (!self?.route_id) return [];
    const tree = await this.nodeRepo.listRouteTree(self.route_id);
    const kids = new Map<string, NodeRow[]>();
    for (const x of tree) if (x.parent_id) kids.set(x.parent_id, [...(kids.get(x.parent_id) ?? []), x]);
    const out: NodeRow[] = [];
    const walk = (id: string): void => {
      for (const k of kids.get(id) ?? []) {
        out.push(k);
        walk(k.id);
      }
    };
    walk(n.id);
    return out;
  }

  async plannedCounts(nodes: readonly AimNodeRef[], from: string, to: string): Promise<Record<string, PlanCount>> {
    const out: Record<string, PlanCount> = {};
    for (const n of nodes) {
      if (out[n.id]) continue;
      const rows = (await this.under(n)).filter(
        (x) => PLAN_KINDS.has(x.kind) && !isRepeat(x) && x.scheduled_on !== null && x.scheduled_on >= from && x.scheduled_on <= to,
      );
      out[n.id] = { planned: rows.length, done: rows.filter((x) => x.status === "done").length };
    }
    return out;
  }

  async reviewStats(nodes: readonly AimNodeRef[], range: DayRange | string, dayStartHour: number): Promise<ReviewResult> {
    const { start: winStart, end: winEnd } = dayRangeWindow(toDayRange(range), dayStartHour);
    const stats: Record<string, ReviewStat> = {};
    for (const n of nodes) {
      if (stats[n.id]) continue;
      // 蓋章＝這一期的済章裡、落在這個節點底下的（domain/seals.ts，同 SQLite 版；D-主-283）。
      // 班次不帶班次日區間：補済的班次 completed_at 可能不在 due_on 那週（同日記足跡的 mock）
      const under = (await this.under(n)).filter((x) => PLAN_KINDS.has(x.kind));
      const occ: SealOccSrc[] = [];
      for (const x of under) occ.push(...(await this.nodeRepo.listOccurrences(x.id)));
      const stamps = dedupeSeals(sealsInWindow({ start: winStart, end: winEnd }, under, occ)).length;
      stats[n.id] = { stamps, minutes: null, spendMinor: null };
    }
    return { stats, money: null };
  }
}
