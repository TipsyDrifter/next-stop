/**
 * MemoryNodeRepository／MemorySettingsRepository——NodeRepository／SettingsRepository 的記憶體實作。
 *
 * 用途：純瀏覽器預覽（`?mock=1` 或 `VITE_MOCK=1`）時頂替 SQLite，不需 Tauri 橋接就能看到完整 UI。
 * 語義逐一對齊 sqliteNodeRepository.ts（排序、position 計算、line_id／route_id 快取、子樹操作、
 * 驗證訊息），讓 store／UI 在兩種後端下行為一致；重新整理頁面即重置（不持久化）。
 * 資料進出一律複製（跟 SQLite 每次 select 都是新物件一樣），UI 拿到的 row 改了也不會污染內部狀態。
 */
import { nowUtcIso, uuid } from "../lib/db";
import { addDays, dayWindow, todayKey } from "../lib/date";
import {
  KIND_LABEL,
  allowedChildKinds,
  afterRule,
  currentDue,
  fixedRule,
  parseRule,
  serializeRule,
  type Mood,
  type NodeKind,
  type NodeRow,
  type Occurrence,
  type OccurrenceStatus,
  type RepeatRule,
  type WorkLog,
  type WorkLogEvent,
} from "../domain";
import type {
  CalendarData,
  CreateNodeInput,
  CurrentOccurrence,
  NodePatch,
  NodeRepository,
  RouteProgress,
  ScheduleEntry,
  SidebarData,
  TodayRow,
} from "./nodeRepository";
import {
  buildCalendar,
  buildRouteProgress,
  buildSchedule,
  buildSerialMap,
  compareTodayRows,
  pickTodayOccurrence,
  reorderIds,
  resolveSkipDate,
  toCurrentOccurrence,
  todayBucketOf,
  REPEATABLE_KINDS,
  REPEAT_ONLY_MSG,
  REPEAT_RESCHEDULE_MSG,
} from "./nodeRepository";
import type { SettingsRepository } from "./settingsRepository";

// repeat_rule 不在這裡：寫規則的唯一入口是 setRepeatRule（patch 收到會改道，M3 ④）
const PATCHABLE = new Set<string>([
  "name", "description", "color", "code", "status", "scheduled_on", "due_on", "priority",
  "estimate_min", "progress", "time_spent_min", "mood", "expected_on", "arrived_on",
  "carried_from", "route_id",
]);

const isAlive = (n: { deleted_at: string | null }): boolean => n.deleted_at === null;

/** ORDER BY position ASC, created_at ASC */
function byPosition(a: NodeRow, b: NodeRow): number {
  return a.position - b.position || a.created_at.localeCompare(b.created_at);
}

const clone = <T extends object>(o: T): T => ({ ...o });

export class MemoryNodeRepository implements NodeRepository {
  private readonly nodes = new Map<string, NodeRow>();
  private readonly logs = new Map<string, WorkLog>();
  /** 班次記錄（M3 ④）；反悔＝soft delete，同一班次可再蓋（同 occurrences 表的部分唯一索引） */
  private readonly occ = new Map<string, Occurrence>();
  /** 種子載入期間用的假時鐘（每筆 +1s，讓 created_at 有序、看起來像上週建的）；null＝用真實時間 */
  private seedClock: number | null = null;

  // ───────────── 讀取 ─────────────

  async listSidebar(): Promise<SidebarData> {
    const rows = this.alive()
      .filter((n) => n.kind === "line" || n.kind === "route" || n.kind === "station")
      .sort(byPosition)
      .map(clone);
    return {
      lines: rows.filter((r) => r.kind === "line"),
      routes: rows.filter((r) => r.kind === "route"),
      stations: rows.filter((r) => r.kind === "station"),
    };
  }

  async listRouteTree(routeId: string): Promise<NodeRow[]> {
    return this.alive()
      .filter((n) => n.route_id === routeId && n.kind !== "station")
      .sort(byPosition)
      .map(clone);
  }

  async listSerials(): Promise<Record<string, string>> {
    // 與 SQLite 版逐條對齊：餵存活全集，發券 kind 的過濾在 buildSerialMap 裡（同一份 SERIAL_KINDS）
    return buildSerialMap(this.alive());
  }

  async getNode(id: string): Promise<NodeRow | null> {
    const n = this.nodes.get(id);
    return n ? clone(n) : null;
  }

  // ───────────── 寫入（async 殼，核心為同步；種子載入直接呼叫同步核心）─────────────

  async create(input: CreateNodeInput): Promise<NodeRow> {
    return clone(this.insert(input));
  }

  async update(id: string, patch: NodePatch, opts?: { dateKey?: string; dayStartHour?: number }): Promise<void> {
    const dayStartHour = opts?.dayStartHour ?? 3;
    this.patch(id, patch, opts?.dateKey ?? todayKey(dayStartHour), dayStartHour);
  }

  async setKind(id: string, kind: NodeKind): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error("節點不存在");
    if (node.kind === kind) return;
    const parent = node.parent_id ? (this.nodes.get(node.parent_id) ?? null) : null;
    if (!allowedChildKinds(parent ? parent.kind : null).includes(kind)) {
      throw new Error(`${KIND_LABEL[kind]} 不能掛在 ${parent ? KIND_LABEL[parent.kind] : "根層"} 底下`);
    }
    this.assertChildrenFit(id, kind, "轉為");
    this.nodes.set(id, { ...node, kind, updated_at: this.now() });
  }

  async move(id: string, newParentId: string | null, index: number, newKind?: NodeKind): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error("節點不存在");
    const kind = newKind ?? node.kind;
    const newParent = newParentId ? (this.nodes.get(newParentId) ?? null) : null;
    if (newParentId && !newParent) throw new Error("目標父節點不存在");
    if (!allowedChildKinds(newParent ? newParent.kind : null).includes(kind)) {
      throw new Error(`${KIND_LABEL[kind]} 不能掛在 ${newParent ? KIND_LABEL[newParent.kind] : "根層"} 底下`);
    }
    const sub = this.subtreeIds(id);
    if (newParentId && sub.includes(newParentId)) throw new Error("不能搬進自己的子樹");
    if (kind !== node.kind) this.assertChildrenFit(id, kind, "變成");

    const now = this.now();
    let lineId: string | null;
    let routeId: string | null;
    if (newParent) {
      lineId = newParent.kind === "line" ? newParent.id : newParent.line_id;
      routeId = newParent.kind === "route" ? newParent.id : newParent.route_id;
    } else {
      lineId = null;
      routeId = node.kind === "ticket" ? node.route_id : null; // 臨時車票保留路線標籤
    }
    if (lineId !== node.line_id) {
      for (const sid of sub) this.mutate(sid, (n) => ({ ...n, line_id: lineId, updated_at: now }));
    }
    if (node.kind !== "route" && routeId !== node.route_id) {
      for (const sid of sub) this.mutate(sid, (n) => ({ ...n, route_id: routeId, updated_at: now }));
    }

    // 兄弟區讓位（同 SQLite：根層以原 kind 分區；不動 updated_at）
    for (const sib of this.siblings(newParent, node.kind)) {
      if (sib.id !== id && sib.position >= index) {
        this.nodes.set(sib.id, { ...sib, position: sib.position + 1 });
      }
    }
    this.mutate(id, (n) => ({ ...n, parent_id: newParent?.id ?? null, position: index, kind, updated_at: now }));
  }

  async softDelete(id: string): Promise<string[]> {
    const ids = this.subtreeIds(id);
    const now = this.now();
    for (const sid of ids) this.mutate(sid, (n) => ({ ...n, deleted_at: now, updated_at: now }));
    return ids;
  }

  async restore(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const now = this.now();
    for (const sid of ids) this.mutate(sid, (n) => ({ ...n, deleted_at: null, updated_at: now }));
  }

  async setCompleted(
    id: string,
    done: boolean,
    opts?: { cascade?: boolean; dateKey?: string; dayStartHour?: number },
  ): Promise<string[]> {
    const h = opts?.dayStartHour ?? 3;
    return this.complete(id, done, opts?.cascade ?? false, opts?.dateKey ?? todayKey(h), h);
  }

  /** 語義與 SQLite 版逐條對齊（四條 OR＋分區＋排序＋lazy 指派今日序），見 nodeRepository.listToday */
  async listToday(dateKey: string, dayStartHour = 3): Promise<TodayRow[]> {
    const { start, end } = dayWindow(dateKey, dayStartHour);
    const hit = this.alive().filter((n) => {
      if (n.kind !== "train" && n.kind !== "car" && n.kind !== "ticket") return false;
      if (n.scheduled_on === dateKey) return true;
      if (n.scheduled_on !== null && n.scheduled_on < dateKey && n.status !== "done") return true;
      if (
        n.status !== "done" && n.due_on !== null && n.due_on <= dateKey &&
        (n.scheduled_on === null || n.scheduled_on > dateKey)
      ) return true;
      // 第四條只認「本來就在今天清單裡的票」（1／2／3 條的資格），否則列車 cascade 蓋章時
      // 那些從沒排進今天的子票會全部冒出來（蓋一章清單反而變長）
      if (
        n.status === "done" && n.completed_at !== null && n.completed_at >= start && n.completed_at < end &&
        ((n.scheduled_on !== null && n.scheduled_on <= dateKey) ||
          (n.scheduled_on === null && n.due_on !== null && n.due_on <= dateKey))
      ) return true;
      // 第五條＝定期券變體（r2 的定期券版）：蓋済／運休之後 scheduled_on 已被推到下一班，
      // 「今天交代過的那一班」只能靠 occurrence 的時刻戳留在清單裡（與 SQLite 版的第五條 OR 同源）
      return (
        n.repeat_rule !== null && n.status !== "done" &&
        this.occurrencesOf(n.id).some((o) => {
          const at = o.completed_at ?? o.updated_at;
          return at >= start && at < end;
        })
      );
    });

    const serials = buildSerialMap(this.alive());
    const rows: TodayRow[] = hit.map((n) => {
      const occ =
        n.status !== "done" && parseRule(n.repeat_rule)
          ? pickTodayOccurrence(this.occurrencesOf(n.id), n.scheduled_on, dateKey, dayStartHour)
          : null;
      return {
        ...clone(n),
        child_total: this.childrenOf(n.id).length,
        child_done: this.childrenOf(n.id).filter((c) => c.status === "done").length,
        serial: serials[n.id] ?? "",
        // 分區用「班次日」：蓋済留原位（今天）／漏班進誤點帶原定 M/D（D-④-4）
        bucket: todayBucketOf(n, dateKey, occ ? occ.due_on : n.scheduled_on),
        occurrence: occ ? toCurrentOccurrence(occ) : null,
      };
    });

    this.assignMissingTodayPositions(rows);
    return rows.sort(compareTodayRows);
  }

  async assignTodayPositions(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const now = this.now();
    ids.forEach((id, i) => this.mutate(id, (n) => ({ ...n, today_position: i, updated_at: now })));
  }

  async moveToday(id: string, index: number, dateKey: string, dayStartHour = 3): Promise<void> {
    const rows = await this.listToday(dateKey, dayStartHour);
    const ids = rows.filter((r) => r.bucket === "today").map((r) => r.id);
    if (!ids.includes(id)) throw new Error("這張票不在今天的清單裡");
    await this.assignTodayPositions(reorderIds(ids, id, index));
  }

  async setRouteTag(ticketId: string, routeId: string | null): Promise<void> {
    await this.update(ticketId, { route_id: routeId });
  }

  async reschedule(id: string, nextDate: string | null, todayDateKey: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error("節點不存在");
    // 定期券的班次由規則排定（M3-5e）——與 SQLite 版同一句話、同一道門
    if (parseRule(node.repeat_rule)) throw new Error(REPEAT_RESCHEDULE_MSG);
    const prev = node.scheduled_on;
    const leavesToday = nextDate === null || nextDate > todayDateKey;
    // 與 SQLite 版逐條對齊：從「今天或過去」挪到更晚的一天（含挪到今天）都算繰越
    const carried =
      nextDate !== null && prev !== null && prev < nextDate && prev <= todayDateKey ? prev : node.carried_from;
    const now = this.now();
    this.mutate(id, (n) => ({
      ...n,
      scheduled_on: nextDate,
      carried_from: carried,
      today_position: leavesToday ? null : n.today_position,
      updated_at: now,
    }));
  }

  async search(query: string, limit = 50): Promise<NodeRow[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.alive()
      .filter((n) => n.kind !== "line" && n.name.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map(clone);
  }

  async addWorkLog(nodeId: string, body: string): Promise<WorkLog> {
    return clone(this.log(nodeId, body));
  }

  async listWorkLogs(nodeId: string): Promise<WorkLog[]> {
    return [...this.logs.values()]
      .filter((l) => l.node_id === nodeId && isAlive(l))
      .sort((a, b) => b.logged_at.localeCompare(a.logged_at) || b.created_at.localeCompare(a.created_at))
      .map(clone);
  }

  // ───────────── 重複任務引擎（M3 ④；語義逐條對齊 sqliteNodeRepository）─────────────

  async setRepeatRule(id: string, rule: RepeatRule | null, dateKey: string, dayStartHour = 3): Promise<void> {
    this.applyRule(id, rule, dateKey, dayStartHour);
  }

  async syncRepeats(dateKey: string, dayStartHour = 3): Promise<string[]> {
    const changed: string[] = [];
    for (const n of this.alive()) {
      if (n.repeat_rule === null || n.status === "done") continue;
      if (this.syncNode(n.id, dateKey, dayStartHour)) changed.push(n.id);
    }
    return changed;
  }

  async skipOccurrence(
    id: string,
    skip: boolean,
    dateKey: string,
    dayStartHour = 3,
    dueOn?: string | null,
  ): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) throw new Error("節點不存在");
    const rule = parseRule(node.repeat_rule);
    if (!rule || node.status === "done") throw new Error(REPEAT_ONLY_MSG);
    const occs = this.occurrencesOf(id);
    if (skip) {
      // 守門＋班次日口徑都在 resolveSkipDate（與 SQLite 版同一份語義；含 ⑤ 的指定班次驗證）
      const due = resolveSkipDate(rule, occs, node.scheduled_on, dateKey, dayStartHour, dueOn);
      if (due) this.stampOccurrence(id, due, "skipped", null);
    } else {
      // 取消運休：指定班次＝撤那一班的運休；沒指定＝撤「這一列在講的那一班」
      const target =
        dueOn === undefined || dueOn === null
          ? pickTodayOccurrence(occs, node.scheduled_on, dateKey, dayStartHour)
          : (occs.find((o) => o.due_on === dueOn) ?? null);
      if (target && target.status === "skipped") this.dropOccurrence(target.id);
    }
    this.syncNode(id, dateKey, dayStartHour);
  }

  async listOccurrences(nodeId: string, from?: string, to?: string): Promise<Occurrence[]> {
    return this.occurrencesOf(nodeId)
      .filter((o) => (from ? o.due_on >= from : true) && (to ? o.due_on <= to : true))
      .sort((a, b) => b.due_on.localeCompare(a.due_on) || b.created_at.localeCompare(a.created_at))
      .map(clone);
  }

  async listCurrentOccurrences(dateKey: string, dayStartHour = 3): Promise<Record<string, CurrentOccurrence>> {
    const out: Record<string, CurrentOccurrence> = {};
    for (const n of this.alive()) {
      if (n.status === "done" || !parseRule(n.repeat_rule)) continue;
      const occ = pickTodayOccurrence(this.occurrencesOf(n.id), n.scheduled_on, dateKey, dayStartHour);
      if (occ) out[n.id] = toCurrentOccurrence(occ);
    }
    return out;
  }

  async listSchedule(
    from: string,
    to: string,
    opts?: { todayDateKey?: string; dayStartHour?: number; projectAfter?: boolean },
  ): Promise<ScheduleEntry[]> {
    const h = opts?.dayStartHour ?? 3;
    const today = opts?.todayDateKey ?? todayKey(h);
    const byNode: Record<string, Occurrence[]> = {};
    for (const o of this.occ.values()) {
      if (isAlive(o)) (byNode[o.node_id] ??= []).push(o);
    }
    return buildSchedule(this.alive(), byNode, from, to, today, h, { projectAfter: opts?.projectAfter });
  }

  async listCalendar(
    from: string,
    to: string,
    opts?: { todayDateKey?: string; dayStartHour?: number },
  ): Promise<CalendarData> {
    const h = opts?.dayStartHour ?? 3;
    const today = opts?.todayDateKey ?? todayKey(h);
    const byNode: Record<string, Occurrence[]> = {};
    for (const o of this.occ.values()) {
      if (isAlive(o)) (byNode[o.node_id] ??= []).push(o);
    }
    return buildCalendar(this.alive(), byNode, from, to, today, h);
  }

  async routeProgress(routeId: string): Promise<RouteProgress> {
    // 候選＝掛在路線下的車站＋名下的任務（與 SQLite 版的 WHERE 同一組條件，過濾都在 buildRouteProgress）
    return buildRouteProgress(
      routeId,
      this.alive().filter((n) => n.parent_id === routeId || n.route_id === routeId),
    );
  }

  /** 某節點的存活班次記錄 */
  private occurrencesOf(nodeId: string): Occurrence[] {
    return [...this.occ.values()].filter((o) => o.node_id === nodeId && isAlive(o));
  }

  /** 掛／清規則的同步核心（驗證訊息與 SQLite 版逐字對齊） */
  private applyRule(id: string, rule: RepeatRule | null, dateKey: string, dayStartHour: number): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error("節點不存在");
    if (rule) {
      if (!REPEATABLE_KINDS.includes(node.kind)) {
        throw new Error(`${KIND_LABEL[node.kind]}不能設重複——只有車票與無子項的列車／車廂可以`);
      }
      if (this.childrenOf(id).length) throw new Error("有子項的列車／車廂不能設重複（v1）");
      if (!parseRule(serializeRule(rule))) throw new Error("重複規則格式不正確");
    }
    const now = this.now();
    this.mutate(id, (n) => ({ ...n, repeat_rule: rule ? serializeRule(rule) : null, updated_at: now }));
    // 掛規則＝立刻算目前班次日；清規則＝scheduled_on 留現值（票變回乘車券，occurrences 留作歷史）
    if (rule) this.syncNode(id, dateKey, dayStartHour);
  }

  /**
   * 單一節點的班次同步；回傳有沒有變。
   * ⚠ 與 SQLite 版同一處偏離草案 §4：**不清 today_position**（理由見 sqliteNodeRepository.syncNode）。
   */
  private syncNode(id: string, dateKey: string, dayStartHour: number): boolean {
    const node = this.nodes.get(id);
    if (!node || !isAlive(node) || node.status === "done") return false;
    const rule = parseRule(node.repeat_rule);
    if (!rule) return false;
    const due = currentDue(rule, this.occurrencesOf(id), dateKey, dayStartHour);
    if (due === null || due === node.scheduled_on) return false;
    const now = this.now();
    this.mutate(id, (n) => ({ ...n, scheduled_on: due, updated_at: now }));
    return true;
  }

  /** 寫下一班的結局；回傳 true＝這次真的從「沒結局」變成「有結局」（決定要不要寫済事件） */
  private stampOccurrence(
    nodeId: string,
    dueOn: string,
    status: OccurrenceStatus,
    completedAt: string | null,
  ): boolean {
    const now = this.now();
    const hit = this.occurrencesOf(nodeId).find((o) => o.due_on === dueOn);
    if (hit) {
      if (hit.status === status) return false;
      this.occ.set(hit.id, { ...hit, status, completed_at: completedAt, updated_at: now });
      return status === "done";
    }
    const row: Occurrence = {
      id: uuid(),
      node_id: nodeId,
      due_on: dueOn,
      status,
      completed_at: completedAt,
      mood: null,
      account_id: null,
      device_id: null,
      created_at: now,
      updated_at: now,
      synced_at: null,
      deleted_at: null,
    };
    this.occ.set(row.id, row);
    return true;
  }

  /** 反悔＝soft delete（同一班次之後還能再蓋） */
  private dropOccurrence(occurrenceId: string): void {
    const o = this.occ.get(occurrenceId);
    if (!o) return;
    const now = this.now();
    this.occ.set(o.id, { ...o, deleted_at: now, updated_at: now });
  }

  /** 心情鏡射：nodes.mood 寫下去時順手蓋到「現在顯示的那一班」 */
  private mirrorMood(nodeId: string, mood: Mood | null, dateKey: string, dayStartHour: number): void {
    const node = this.nodes.get(nodeId);
    if (!node || node.status === "done" || !parseRule(node.repeat_rule)) return;
    const target = pickTodayOccurrence(this.occurrencesOf(nodeId), node.scheduled_on, dateKey, dayStartHour);
    if (!target) return;
    this.occ.set(target.id, { ...target, mood, updated_at: this.now() });
  }

  // ───────────── 同步核心 ─────────────

  private now(): string {
    if (this.seedClock !== null) {
      this.seedClock += 1000;
      return new Date(this.seedClock).toISOString();
    }
    return nowUtcIso();
  }

  private alive(): NodeRow[] {
    return [...this.nodes.values()].filter(isAlive);
  }

  private mutate(id: string, fn: (n: NodeRow) => NodeRow): void {
    const n = this.nodes.get(id);
    if (n) this.nodes.set(id, fn(n));
  }

  /** 直屬子項（存活） */
  private childrenOf(id: string): NodeRow[] {
    return this.alive().filter((n) => n.parent_id === id);
  }

  /** 首次進今日的列 lazy 指派 today_position＝全域 max+1（新聚合尾插，r7） */
  private assignMissingTodayPositions(rows: TodayRow[]): void {
    // 同毫秒建立的票（種子／連打 Enter）用 position 再分先後，否則落到 id 就是亂序
    const fresh = rows
      .filter((r) => r.bucket === "today" && r.today_position === null)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.position - b.position || a.id.localeCompare(b.id),
      );
    if (!fresh.length) return;
    let next = this.alive().reduce((m, n) => Math.max(m, n.today_position ?? -1), -1) + 1;
    const now = this.now();
    for (const row of fresh) {
      const at = next;
      this.mutate(row.id, (n) => ({ ...n, today_position: at, updated_at: now }));
      row.today_position = at;
      next += 1;
    }
  }

  /** 兄弟區（存活）：同父；根層以 kind 分區（幹線一區、臨時車票一區） */
  private siblings(parent: NodeRow | null, rootKind: NodeKind): NodeRow[] {
    return this.alive().filter((n) =>
      parent ? n.parent_id === parent.id : n.parent_id === null && n.kind === rootKind,
    );
  }

  /** 根節點必含（不論是否已刪）；往下只走存活的子節點——同 SQLite 的遞迴 CTE */
  private subtreeIds(rootId: string): string[] {
    const out: string[] = [];
    const stack = [rootId];
    while (stack.length) {
      const cur = stack.pop()!;
      out.push(cur);
      for (const n of this.nodes.values()) {
        if (n.parent_id === cur && isAlive(n)) stack.push(n.id);
      }
    }
    return out;
  }

  private assertChildrenFit(id: string, kind: NodeKind, verb: "轉為" | "變成"): void {
    const ok = allowedChildKinds(kind);
    const bad = this.alive().find((n) => n.parent_id === id && !ok.includes(n.kind));
    if (bad) throw new Error(`底下還有${KIND_LABEL[bad.kind]}，不能${verb}${KIND_LABEL[kind]}`);
  }

  private insert(input: CreateNodeInput): NodeRow {
    const name = input.name.trim();
    if (!name) throw new Error("名稱不能空白");

    const parent = input.parentId ? (this.nodes.get(input.parentId) ?? null) : null;
    if (input.parentId && !parent) throw new Error("父節點不存在");
    const allowed = allowedChildKinds(parent ? parent.kind : null);
    if (!allowed.includes(input.kind)) {
      throw new Error(`${input.kind} 不能掛在 ${parent?.kind ?? "根層"} 底下`);
    }

    let lineId: string | null = null;
    let routeId: string | null = null;
    if (parent) {
      lineId = parent.kind === "line" ? parent.id : parent.line_id;
      routeId = parent.kind === "route" ? parent.id : parent.route_id;
    } else if (input.kind === "ticket" && input.routeTagId) {
      const tag = this.nodes.get(input.routeTagId) ?? null;
      routeId = tag?.id ?? null;
      lineId = tag?.line_id ?? null;
    }

    const sibs = this.siblings(parent, input.kind);
    let position: number;
    if (input.afterId) {
      const after = this.nodes.get(input.afterId);
      if (!after) throw new Error("afterId 不存在");
      position = after.position + 1;
      for (const sib of sibs) {
        if (sib.position >= position) this.nodes.set(sib.id, { ...sib, position: sib.position + 1 });
      }
    } else {
      position = sibs.reduce((m, s) => Math.max(m, s.position), -1) + 1;
    }

    const now = this.now();
    const row: NodeRow = {
      id: uuid(),
      kind: input.kind,
      parent_id: parent?.id ?? null,
      line_id: lineId,
      route_id: routeId,
      name,
      description: input.description ?? null,
      position,
      color: input.color ?? null,
      code: input.code ?? null,
      status: "todo",
      scheduled_on: input.scheduledOn ?? null,
      due_on: null,
      priority: "mid",
      estimate_min: null,
      progress: null,
      time_spent_min: null,
      mood: null,
      repeat_rule: null,
      completed_at: null,
      expected_on: null,
      arrived_on: null,
      today_position: null,
      carried_from: null,
      account_id: null,
      device_id: null,
      created_at: now,
      updated_at: now,
      synced_at: null,
      deleted_at: null,
    };
    this.nodes.set(row.id, row);
    this.event(row.id, "issued", now); // 発券
    return row;
  }

  private patch(id: string, patch: NodePatch, dateKey: string = todayKey(), dayStartHour = 3): void {
    // repeat_rule 改道 setRepeatRule（與 SQLite 版同一道門：驗證＋寫完立刻同步班次只留一份）
    if ("repeat_rule" in patch) {
      const raw = patch.repeat_rule ?? null;
      const rule = parseRule(raw);
      if (raw !== null && raw.trim() !== "" && rule === null) throw new Error("重複規則格式不正確");
      this.applyRule(id, rule, dateKey, dayStartHour);
    }
    const picked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (PATCHABLE.has(k)) picked[k] = v === undefined ? null : v;
    }
    if (!Object.keys(picked).length) return;

    // route_id＝臨時車票的路線標籤：驗身分＋同步 line_id（與 SQLite 版同一套規則）
    if ("route_id" in picked) {
      const routeId = (picked.route_id ?? null) as string | null;
      const node = this.nodes.get(id);
      if (!node) throw new Error("節點不存在");
      if (node.kind !== "ticket" || node.parent_id !== null) throw new Error("只有臨時車票能掛路線標籤");
      let lineId: string | null = null;
      if (routeId) {
        const tag = this.nodes.get(routeId);
        if (!tag || tag.kind !== "route") throw new Error("路線標籤必須是一條路線");
        lineId = tag.line_id;
      }
      picked.line_id = lineId;
    }

    this.mutate(id, (n) => ({ ...n, ...(picked as Partial<NodeRow>), updated_at: this.now() }));

    // 入鋏：首次進 doing 才記一枚
    if (patch.status === "doing" && !this.hasEvent(id, "punched")) this.event(id, "punched", this.now());

    // 心情鏡射（D-④-2）：定期券的完成卡心情住在班次上，nodes.mood＝最近一班。
    // 日界線吃呼叫端帶進來的設定（不再寫死 3）——否則改成 0／5 的使用者在凌晨填心情會鏡到隔壁班或靜默不寫。
    if ("mood" in patch) this.mirrorMood(id, (patch.mood ?? null) as Mood | null, dateKey, dayStartHour);
  }

  private complete(
    id: string,
    done: boolean,
    cascade: boolean,
    dateKey: string = todayKey(),
    dayStartHour = 3,
  ): string[] {
    const now = this.now();
    const node = this.nodes.get(id) ?? null;
    const rule = node ? parseRule(node.repeat_rule) : null;

    // ── 定期券分支（D-④-2）：済蓋在「目前班次」上，nodes.status 一個字不動 ──
    if (node && rule && node.status !== "done") {
      const ids = [id];
      if (done) {
        const due = node.scheduled_on ?? currentDue(rule, this.occurrencesOf(id), dateKey, dayStartHour);
        if (due && this.stampOccurrence(id, due, "done", now)) this.event(id, "done", now);
      } else {
        const target = pickTodayOccurrence(this.occurrencesOf(id), node.scheduled_on, dateKey, dayStartHour);
        if (target) {
          this.dropOccurrence(target.id);
          if (target.status === "done") this.revokeLatestEvent(id, "done");
        }
      }
      this.syncNode(id, dateKey, dayStartHour);
      // 連帶完成：子樹裡的定期券照 D2 退役（status='done'），不寫 occurrence
      if (done && cascade) {
        for (const sid of this.subtreeIds(id)) {
          if (sid === id) continue;
          const before = this.nodes.get(sid);
          if (!before || before.status === "done") continue;
          this.mutate(sid, (n) => ({ ...n, status: "done", completed_at: now, updated_at: now }));
          this.event(sid, "done", now);
          ids.push(sid);
        }
      }
      return ids;
    }

    if (done) {
      const ids = cascade ? this.subtreeIds(id) : [id];
      for (const sid of ids) {
        const before = this.nodes.get(sid);
        if (!before || before.status === "done") continue;
        this.mutate(sid, (n) => ({ ...n, status: "done", completed_at: now, updated_at: now }));
        this.event(sid, "done", now); // 済
      }
      return ids;
    }
    this.mutate(id, (n) => ({ ...n, status: "todo", completed_at: null, updated_at: now }));
    this.revokeLatestEvent(id, "done"); // 反悔完成：只收回這一次的済
    // 退役的定期券取消完成＝退役解除，引擎重新排班
    if (rule) this.syncNode(id, dateKey, dayStartHour);
    return [id];
  }

  private log(nodeId: string, body: string, event: WorkLogEvent | null = null, at?: string): WorkLog {
    const now = at ?? this.now();
    const entry: WorkLog = {
      id: uuid(), node_id: nodeId, body: body.trim(), logged_at: now, event,
      account_id: null, device_id: null, created_at: now, updated_at: now, synced_at: null, deleted_at: null,
    };
    this.logs.set(entry.id, entry);
    return entry;
  }

  private event(nodeId: string, event: WorkLogEvent, at: string): void {
    this.log(nodeId, "", event, at);
  }

  private hasEvent(nodeId: string, event: WorkLogEvent): boolean {
    return [...this.logs.values()].some((l) => l.node_id === nodeId && l.event === event && isAlive(l));
  }

  /** 收回最新一枚該類事件（soft delete，同 SQLite 版） */
  private revokeLatestEvent(nodeId: string, event: WorkLogEvent): void {
    const target = [...this.logs.values()]
      .filter((l) => l.node_id === nodeId && l.event === event && isAlive(l))
      .sort((a, b) => b.logged_at.localeCompare(a.logged_at) || b.created_at.localeCompare(a.created_at))[0];
    if (!target) return;
    const now = this.now();
    this.logs.set(target.id, { ...target, deleted_at: now, updated_at: now });
  }

  // ───────────── 種子資料（預覽用）─────────────

  /**
   * 載入示範資料：幹線 學習／興趣／生活，路線 J 日文・E1 全端開發・L2 體能，
   * 含列車／車廂／車票／車站與臨時車票。呼叫多次會疊加，請只在建構後呼叫一次。
   *
   * M3 ③ 今日情境（`?mock=1` 一開就看得到）：今天有列車／車廂／車票／臨時券各至少一張、
   * 一張昨天排昨天完成的（不該出現）、一張昨天排今天補済的（誤點區、済上前）、
   * 一張兩天前未完成的（延着）、一張只有締切已過沒排執行日的（誤點區尾段）、一張無日期臨時券（收件匣）。
   * opts.many＝`?mock=1&many=1`：今天再塞到 25 張上下，給評審看「輕盈感在真資料量下還在不在」。
   *
   * M3 ⑤ 日曆情境（`?mock=1&page=calendar`）：本月分散的單發票五張（含一張已済、一張過期未済＝赭）、
   * 締切三樣本（有執行日／無執行日只在締切日浮出／執行＝締切同日）、月底一張、下個月一張；
   * 定期券沿既有四張——每日／每週三天漏班／完成後 3 天／每週今天運休，正好覆蓋 D-⑤-2／3 的每一種格。
   *
   * 評審截圖用的兩個端點狀態（整合席加；只影響 `?mock=1`，正式資料路徑碰不到）：
   *   opts.empty＝`?mock=1&today=empty`——把所有會落進今日視窗的欄位清掉（執行日／締切／完成時刻），
   *     其餘資料原封不動 → 拍 1.0c「今天還沒有班次」空狀態。
   *   opts.allDone＝`?mock=1&today=alldone`——把今天該出現的票全部蓋上済 → 拍 1.0d「今天的班次都到站了」。
   */
  seedDemo(opts: { many?: boolean; empty?: boolean; allDone?: boolean } = {}): void {
    const today = todayKey();
    const year = today.slice(0, 4);
    this.seedClock = Date.now() - 7 * 86_400_000; // 一週前起算，每筆 +1s
    const preset = (n: number) => `var(--route-preset-${n})`;
    const add = (kind: NodeKind, name: string, parentId: string | null, extra: Partial<CreateNodeInput> = {}) =>
      this.insert({ kind, name, parentId, ...extra });

    // 幹線
    const study = add("line", "學習", null);
    add("line", "興趣", null); // 暫時空著：看側欄空狀態
    const life = add("line", "生活", null);

    // ── J 日文 ──
    const jp = add("route", "日文", study.id, { code: "J", color: preset(2) });
    const n5Grammar = add("train", "N5 文法", jp.id, { scheduledOn: today });
    this.patch(n5Grammar.id, { due_on: `${year}-12-01`, estimate_min: 90, description: "週一三五晚上各一小時" });
    const teForm = add("car", "て形變化", n5Grammar.id);
    const rules = add("ticket", "整理變化規則表", teForm.id, { scheduledOn: addDays(today, -1) });
    this.complete(rules.id, true, false); // 昨天排、昨天完成＝今日視圖看不到（時間窗外）
    add("ticket", "做 20 題練習", teForm.id, { scheduledOn: addDays(today, -2) }); // 刻意誤點：看「延着」章
    // 昨天排、今天才補済＝留在誤點區，済進検印欄、延着退右下（r2／件一補済樣張）；済的時刻在收尾補
    const fixWrong = add("ticket", "訂正昨天的錯題", teForm.id, { scheduledOn: addDays(today, -1) });
    // 只有締切、沒排執行日，且締切已過＝浮進誤點區尾段（D-③-7，赭 chip、不蓋延着）
    const n4Signup = add("train", "N4 報名", jp.id);
    this.patch(n4Signup.id, { due_on: addDays(today, -1) });
    const particles = add("car", "助詞總複習", n5Grammar.id);
    const wagaCar = add("car", "は/が 辨析", particles.id);
    add("ticket", "讀文法書 §3 做筆記", wagaCar.id, { scheduledOn: today });
    add("ticket", "寫 10 句例句", wagaCar.id);
    const n5Vocab = add("train", "N5 單字", jp.id);
    this.patch(n5Vocab.id, { due_on: `${year}-11-15`, estimate_min: 120 });
    this.complete(n5Vocab.id, true, true);
    const n5Exam = add("station", "考過 N5", jp.id);
    this.patch(n5Exam.id, { expected_on: `${year}-12-06` });
    this.log(n5Grammar.id, "て形的規則表整理完了，不規則動詞另外背");
    this.log(n5Grammar.id, "今天只做了 10 題，明天補");
    /**
     * v1.1.2 示範：同步衝突的敗方值（`event='conflict'`，body＝JSON；契約 §3.4／§9.2）。
     * 真機是 Rust `apply_object` 直寫 work_logs，mock 這裡只是把同樣形狀的資料擺出來，
     * 讓 `?mock=1` 的評審看得到那一行長什麼樣（桌機側板的乘務記錄／手機路線圖的唯讀詳情各一）。
     * 兩種方向各放一筆：一般欄（票名）與「編輯勝刪除」（另一台刪、這台改過 ⇒ 保留）。
     */
    this.log(
      n5Grammar.id,
      JSON.stringify({
        col: "name", mine: "N5 文法（舊）", theirs: "N5 文法",
        their_device: "7b1e0c22-1111-4000-8000-000000000001",
        hlc: "17583000000000a2-7b1e0c22", mine_hlc: "17582999999000041-3f9c2b1e",
        tbl: "nodes", row_id: n5Grammar.id,
      }),
      "conflict",
    );
    this.log(
      rules.id,
      JSON.stringify({
        col: "deleted_at", mine: null, theirs: "2026-09-19T01:20:00.000Z",
        their_device: "7b1e0c22-1111-4000-8000-000000000001",
        hlc: "17583000100000b1-7b1e0c22", mine_hlc: "17583000000000a9-3f9c2b1e",
        tbl: "nodes", row_id: rules.id,
      }),
      "conflict",
    );

    // ── E1 全端開發 ──
    const dev = add("route", "全端開發", study.id, { code: "E1", color: preset(1) });
    const nextStop = add("branch", "Next Stop 開發", dev.id);
    const m2 = add("train", "M2 鋪軌", nextStop.id, { scheduledOn: today });
    this.patch(m2.id, { status: "doing", priority: "high", estimate_min: 480 });
    const schema = add("car", "schema v2", m2.id, { scheduledOn: today }); // 今日的「車廂」樣本（車廂格 3 格）
    add("ticket", "單表彈性樹 DDL", schema.id);
    add("ticket", "NodeRepository 介面", schema.id);
    add("ticket", "store 接線與冒煙測試", schema.id);
    const m1 = add("train", "M1 制服設計", nextStop.id);
    this.complete(m1.id, true, true);
    const launch = add("station", "v0.2 發車", dev.id);
    this.patch(launch.id, { expected_on: addDays(today, 21) });
    this.log(m2.id, "schema v2 落地，repository 介面補齊");

    // ── L2 體能 ──
    const fitness = add("route", "體能", life.id, { code: "L2", color: preset(3) });
    const running = add("train", "跑步習慣", fitness.id);
    const run3 = add("ticket", "本週跑 3 次", running.id, { scheduledOn: today });
    this.patch(run3.id, { carried_from: addDays(today, -3) }); // 繰越角印「自 M/D 繰越」樣本

    // 臨時車票（parent null）
    add("ticket", "回覆房東訊息", null, { scheduledOn: today }); // 無路線＝虛線「臨」票根
    add("ticket", "查一個單字的用法", null, { scheduledOn: today, routeTagId: jp.id }); // 掛路線標籤＝票根換 J 色
    add("ticket", "想一下生日要送什麼", null); // 無日期＝收件匣，今日看不到（Ctrl+P 找得到）
    const inbox = add("ticket", "晨間快掃信箱", null, { scheduledOn: today });

    // ── 定期券四張（M3 ④；日期一律相對「今天」算，換一天跑情境不會走鐘）──
    // 星期以 getDay() 為準；用「今天的前後幾天」反推星期，讓漏班／當班的情境在任何一天都成立
    const dow = (offset: number) => {
      const [y, m, d] = addDays(today, offset).split("-").map(Number);
      return new Date(y, m - 1, d).getDay();
    };
    // ①「每日」：今天的班次待會兒會蓋済（留原位樣本）
    const dailyVocab = add("ticket", "背 N5 單字", teForm.id);
    this.applyRule(dailyVocab.id, fixedRule("daily", addDays(today, -14)), today, 3);
    // ②「每週三天」且今天不是規則日 → 最新一班在兩天前、沒人蓋 → 誤點區帶延着「原定 M/D」（D-④-4）
    const jog = add("ticket", "跑步 3 公里", running.id);
    this.applyRule(
      jog.id,
      fixedRule("weekly", addDays(today, -21), { byweekday: [dow(-2), dow(1), dow(3)] }),
      today,
      3,
    );
    // ③「完成後 3 天」：起算日＝今天 → 今天到期（間隔模型的當班樣本）
    const water = add("ticket", "澆花", null, { routeTagId: fitness.id });
    this.applyRule(water.id, afterRule(3, today), today, 3);
    // ④「每週某天」＝今天：待會兒蓋運休（運休角印＋整張轉淡樣本）
    const weekly = add("ticket", "寫週報", null);
    this.applyRule(weekly.id, fixedRule("weekly", addDays(today, -14), { byweekday: [dow(0)] }), today, 3);
    // ⑤ legacy 自由文字規則（0003 migration 在真機會把它搬進 description；記憶體版沒有 migration，
    //    直接留著驗 parseRule 容錯＝「壞字串→視為沒有規則」，這張票就是一般乘車券、不會被引擎碰到）
    const legacy = add("ticket", "量體重記錄", running.id, { scheduledOn: today });
    this.mutate(legacy.id, (n) => ({ ...n, repeat_rule: "每天早上量一次，週日不用" }));

    // ── 日曆情境（M3 ⑤ WP1）：整月都要有東西看，不只今天±3 天 ──
    // 日子一律相對今天算、再夾進本月（月初／月底開 app 也保證看得到分散的票）。
    // ⚠ 夾邊界的副作用：今天是 1 號時「過期未済」會被夾到 1 號＝今天，那一格就不是赭的（mock 的邊角，不影響語義）。
    const monthEnd = addDays(`${today.slice(0, 7)}-01`, 31).slice(0, 7) + "-01"; // 下個月 1 日
    const lastOfMonth = addDays(monthEnd, -1);
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const inMonth = (key: string) => (key < firstOfMonth ? firstOfMonth : key > lastOfMonth ? lastOfMonth : key);

    // 本月分散的單發票五張：一張已済（過去）、一張過期未済（赭）、三張在未來
    const calDone = add("ticket", "把書架整理一遍", null, { scheduledOn: inMonth(addDays(today, -5)) });
    this.complete(calDone.id, true, false); // 假時鐘還開著＝完成時刻在一週前，不會混進今日視窗
    add("ticket", "寄回借的書", null, { scheduledOn: inMonth(addDays(today, -8)) }); // 過期未済＝赭
    add("ticket", "換季衣物收納", null, { scheduledOn: inMonth(addDays(today, 2)) });
    add("ticket", "寫明信片給朋友", null, { scheduledOn: inMonth(addDays(today, 6)), routeTagId: jp.id });
    add("ticket", "校正單字表", teForm.id, { scheduledOn: inMonth(addDays(today, 11)) });

    // 締切三樣本（決策 11＋D-⑤-5-2）：有執行日／無執行日（只在締切日浮出）／執行＝締切同日
    const dueA = add("ticket", "報稅資料整理", null, { scheduledOn: inMonth(addDays(today, 4)) });
    this.patch(dueA.id, { due_on: inMonth(addDays(today, 6)) });
    const dueB = add("train", "續約健身房", fitness.id); // 沒排執行日，只有締切
    this.patch(dueB.id, { due_on: inMonth(addDays(today, 8)) });
    const dueC = add("ticket", "繳信用卡帳單", null, { scheduledOn: inMonth(addDays(today, 17)) });
    this.patch(dueC.id, { due_on: inMonth(addDays(today, 17)) }); // 執行＝締切同日

    // 月底一張＋下個月一張（驗換月、驗 `.out` 格不畫內容）
    add("ticket", "月結對帳", null, { scheduledOn: lastOfMonth });
    add("ticket", "下個月的體檢預約", null, { scheduledOn: addDays(monthEnd, 9) });

    // 多資料量模式：今天再塞一批，看留白 token 在 25 張下有沒有被擠壓（輕盈感錨點）
    if (opts.many) {
      const chores = [
        "回信給編輯", "訂下週車票", "整理桌面檔案", "繳電費", "預約牙醫",
        "把讀書筆記謄一頁", "洗運動服", "查一下保險條款", "備份手機照片", "寫週報",
        "買貓砂", "整理相簿", "退掉沒在看的訂閱", "打電話給媽", "量體重記錄",
        "收衣服", "把冰箱清一輪", "排下週的行程",
      ];
      chores.forEach((n, i) => add("ticket", n, i % 3 === 0 ? null : running.id, { scheduledOn: today }));
    }

    this.seedClock = null;

    // 收尾：這兩張的「済」要蓋在真實的今天（落在日界線視窗內），才驗得到
    // r2「當日完成留原位」與誤點票補済——所以刻意放在假時鐘關掉之後才完成。
    this.complete(fixWrong.id, true, false); // 昨天排、今天補済＝誤點區留原位
    this.complete(inbox.id, true, false); // 今天排、今天完成＝留原位淡化

    // 定期券的兩個「今天已經交代過」樣本（結局的時刻戳要落在真實的今日視窗內，才驗得到第五條 OR）
    this.complete(dailyVocab.id, true, false, today); // 每日：今天已済、留原位；scheduled_on 推到明天
    {
      // 每週（今天）：本班運休——與 skipOccurrence 同一條路徑（stamp + 重跑同步）
      const w = this.nodes.get(weekly.id);
      if (w?.scheduled_on) {
        this.stampOccurrence(weekly.id, w.scheduled_on, "skipped", null);
        this.syncNode(weekly.id, today, 3);
      }
    }

    // ── 評審截圖用的端點狀態（見上方 opts 說明）──
    if (opts.empty) {
      // 今日視圖的五條 OR（執行日＝今天／執行日過期未完成／締切過期未完成／今天完成的／定期券今天的班次）
      // 全部斷掉——定期券連規則與班次記錄一起清，否則第五條 OR 還會把它們留在畫面上
      this.alive().forEach((n) => {
        this.mutate(n.id, (x) => ({
          ...x,
          scheduled_on: null, due_on: null, completed_at: null, today_position: null, repeat_rule: null,
        }));
      });
      for (const o of this.occ.values()) this.dropOccurrence(o.id);
    } else if (opts.allDone) {
      // 今日視窗的四條 OR 就是這三種：排今天／執行日過期／締切過期（完成的那條本來就是 done）
      this.alive()
        .filter(
          (n) =>
            n.status !== "done" &&
            n.kind !== "line" &&
            n.kind !== "route" &&
            n.kind !== "station" &&
            ((n.scheduled_on !== null && n.scheduled_on <= today) ||
              (n.scheduled_on === null && n.due_on !== null && n.due_on <= today)),
        )
        .map((n) => n.id)
        .forEach((id) => {
          if (this.nodes.get(id)?.status !== "done") this.complete(id, true, true);
        });
    }
  }
}

export class MemorySettingsRepository implements SettingsRepository {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}
