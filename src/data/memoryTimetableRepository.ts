/**
 * 時刻表線的記憶體實作（車次①a 契約 §3.6；甲席 Stage 0）——`?mock=1` 純瀏覽器預覽用，乙丙席開發靠它。
 *
 * - 資料存 `Map`，進出一律複製（同 `memoryRepository.ts` 的慣例）。
 * - 寫入走**同一套純函式**（`plan*` → 套到 Map），所以 mock 與真機語義一致。`reconcile` 的寫入鍵與真機同語義
 *   （D-時-26）：mock 沒有 sync_cells，改在 `startStamp` 記每列 `started_at` 最後一次**真的被改寫**的時刻（ISO），
 *   代替真機 `started_at` 那一格的 hlc；改結束／改分類不動它。
 * - 分類：與真機同，`ensureStarterCategories()` 被呼叫時才種（`?mock=1&wiped=1` 也種——它是「空庫的 App 第一次打開」）。
 * - 示範時間塊（`seedDemo` 時，第一次讀取時 lazy 種）：照原型 `shared.js` 換算成今天的日界線日（`todayKey(3)`）。
 * - 評審端點（本檔自己讀 `location.search`，不經 `DEV_FLAGS`）：`&tt=long`＝運行中那班改成「洗漱，今天 06:30 発」；
 *   `&tt=idle`＝沒有運行中；`&tt=est`（①b）＝運行中那班「創作」帶預估 30 分、開始於 50 分前（一打開就誤點 +20m）。
 */
import { nowUtcIso, uuid } from "../lib/db";
import { addDays, dayWindow, todayKey } from "../lib/date";
import {
  MIN,
  STARTER_CATEGORIES,
  canUndoArrive,
  groupedCategories,
  inReconcileWindow,
  isoOf,
  msOf,
  planArrive,
  planArriveBefore,
  planCover,
  planDepart,
  planDepartPending,
  planEdit,
  planFill,
  planMerge,
  planReconcile,
  planResolveLongRun,
  planRestart,
  planSetEstimate,
  planSplit,
  planSplitMulti,
  reconcileWindowStart,
  reconcileWriteKey,
  segmentsOfDay,
  summarizeCover,
  toDayBlockSegments,
  toSpan,
  type CoverSummary,
  type DayBlockSegment,
  type KeyedSpan,
  type LongRunChoice,
  type Span,
  type TimeBlockRow,
  type TimeCategoryRow,
  type WritePlan,
} from "../domain/timetable";
import type { CategoryPatch, CreateCategoryInput, DepartOptions, MergePreview, TimetableRepository } from "./timetableRepository";
import { pieceId } from "./sqliteTimetableRepository";

const clone = <T extends object>(o: T): T => ({ ...o });
const isAlive = (r: { deleted_at: string | null }): boolean => r.deleted_at === null;

/** 評審端點：`&tt=long|idle|est` */
function ttMode(): "long" | "idle" | "est" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("tt");
    return v === "long" || v === "idle" || v === "est" ? v : null;
  } catch {
    return null;
  }
}

/** 起手分類的 key → id（示範資料用） */
const STARTER_ID: Record<string, string> = {};
for (const c of STARTER_CATEGORIES) STARTER_ID[c.key] = c.id;

/** 示範時間塊：距日界線（03:00）的分鐘數；end null＝運行中 */
const DEMO_TODAY: { key: string; start: number; end: number | null }[] = [
  { key: "sleep", start: 0, end: 280 }, // 03:00–07:40
  { key: "move", start: 310, end: 340 }, // 08:10–08:40
  { key: "class", start: 340, end: 450 }, // 08:40–10:30
  { key: "rest", start: 450, end: 470 }, // 10:30–10:50
  { key: "class", start: 470, end: 550 }, // 10:50–12:10
  { key: "meal", start: 550, end: 600 }, // 12:10–13:00
  { key: "study", start: 630, end: 680 }, // 13:30–14:20
  { key: "rest", start: 680, end: 695 }, // 14:20–14:35
  { key: "create", start: 695, end: null }, // 14:35–運行中
];
const DEMO_YESTERDAY: { key: string; start: number; end: number }[] = [
  { key: "sleep", start: 0, end: 270 }, // 03:00–07:30
  { key: "class", start: 360, end: 540 }, // 09:00–12:00
  { key: "meal", start: 540, end: 600 }, // 12:00–13:00
];

export class MemoryTimetableRepository implements TimetableRepository {
  private readonly cats = new Map<string, TimeCategoryRow>();
  private readonly blocks = new Map<string, TimeBlockRow>();
  /** id → started_at 最後被寫的時刻（ISO）；＝真機 sync_cells 裡 `started_at` 那一格的 hlc 的替身（整理寫入鍵用，D-時-26） */
  private readonly startStamp = new Map<string, string>();
  private readonly seedDemo: boolean;
  private demoSeeded = false;

  constructor(opts: { seedDemo: boolean }) {
    this.seedDemo = opts.seedDemo;
  }

  /* ───────── 內部 ───────── */

  private ensureDemo(): void {
    if (this.demoSeeded || !this.seedDemo) return;
    this.demoSeeded = true;
    const now = Date.now();
    const stamp = nowUtcIso();
    const today = todayKey(3);
    const base = msOf(dayWindow(today, 3).start);
    const ybase = msOf(dayWindow(addDays(today, -1), 3).start);
    const put = (key: string, start: number, end: number | null): TimeBlockRow => {
      const row: TimeBlockRow = {
        id: uuid(),
        category_id: STARTER_ID[key],
        started_at: isoOf(start),
        ended_at: end === null ? null : isoOf(end),
        estimate_min: null,
        node_id: null,
        route_id: null,
        long_run_ack: 0,
        account_id: null,
        device_id: null,
        created_at: stamp,
        updated_at: stamp,
        synced_at: null,
        deleted_at: null,
      };
      this.blocks.set(row.id, row);
      this.startStamp.set(row.id, stamp);
      return row;
    };
    for (const b of DEMO_YESTERDAY) put(b.key, ybase + b.start * MIN, ybase + b.end * MIN);
    for (const b of DEMO_TODAY) {
      const start = base + b.start * MIN;
      if (start >= now) break; // 現在早於這塊的開始 ⇒ 不種這塊之後的
      const end = b.end === null ? null : base + b.end * MIN;
      if (end !== null && end > now) {
        put(b.key, start, null); // 跨到未來的那塊改成運行中，之後的不種
        break;
      }
      put(b.key, start, end);
    }
    const mode = ttMode();
    if (mode === "idle") {
      for (const r of this.blocks.values()) if (r.ended_at === null) this.blocks.delete(r.id);
    } else if (mode === "long") {
      // 原型 demoOverdue：06:30 之後的今天全部收掉，洗漱從 06:30 跑到現在
      const at = base + 210 * MIN;
      for (const r of Array.from(this.blocks.values())) {
        const s = msOf(r.started_at);
        if (s < base) continue; // 昨天的不動
        if (s >= at) this.blocks.delete(r.id);
        else if (r.ended_at === null || msOf(r.ended_at) > at) r.ended_at = isoOf(at);
      }
      put("wash", at, null);
    } else if (mode === "est") {
      // ①b：運行中那班帶預估 30 分、開始於 50 分前 ⇒ 一打開就是「誤點 +20m」＋其實到幾點（①b①c 契約 §3.4）
      const at = now - 50 * MIN;
      for (const r of Array.from(this.blocks.values())) {
        const s = msOf(r.started_at);
        if (s >= at) this.blocks.delete(r.id);
        else if (r.ended_at === null || msOf(r.ended_at) > at) r.ended_at = isoOf(at);
      }
      put("create", at, null).estimate_min = 30;
    }
  }

  private aliveSpans(): Span[] {
    this.ensureDemo();
    const out: Span[] = [];
    for (const r of this.blocks.values()) if (isAlive(r)) out.push(toSpan(r));
    return out;
  }

  private rowOrThrow(id: string): TimeBlockRow {
    const r = this.blocks.get(id);
    if (!r || !isAlive(r)) throw new RangeError("找不到這一塊");
    return r;
  }

  /** 套用 WritePlan；回 inserts 依序對應的 id */
  private async applyPlan(plan: WritePlan, nowIso: string): Promise<string[]> {
    for (const p of plan.patches) {
      const r = this.blocks.get(p.id);
      if (!r) continue;
      if (p.start !== undefined) {
        const s = isoOf(p.start);
        // 同真機 applyPlan 的「值相同的欄不寫、不戳」：沒真的改開始就不算重新發車
        if (r.started_at !== s) this.startStamp.set(r.id, nowIso);
        r.started_at = s;
      }
      if (p.end !== undefined) r.ended_at = p.end === null ? null : isoOf(p.end);
      if (p.categoryId !== undefined) r.category_id = p.categoryId;
      if (p.ack !== undefined) r.long_run_ack = p.ack ? 1 : 0;
      if (p.estimateMin !== undefined) r.estimate_min = p.estimateMin;
      r.updated_at = nowIso;
    }
    const ids: string[] = [];
    for (const i of plan.inserts) {
      const id = i.fixedId ?? (i.key ? await pieceId(i.key) : uuid());
      const from = i.inherit && i.fromId ? this.blocks.get(i.fromId) : undefined;
      const prev = this.blocks.get(id);
      const row: TimeBlockRow = {
        id,
        category_id: i.categoryId,
        started_at: isoOf(i.start),
        ended_at: i.end === null ? null : isoOf(i.end),
        // ①b：insert 明寫的預估蓋過 inherit 抄來的（undefined＝照 inherit 規則；同 sqlite 實作）
        estimate_min: i.estimateMin !== undefined ? i.estimateMin : (from?.estimate_min ?? null),
        node_id: from?.node_id ?? null,
        route_id: from?.route_id ?? null,
        long_run_ack: i.ack ? 1 : 0,
        account_id: null,
        device_id: null,
        created_at: prev?.created_at ?? nowIso,
        updated_at: nowIso,
        synced_at: null,
        deleted_at: null,
      };
      this.blocks.set(id, row);
      this.startStamp.set(id, nowIso); // 同真機：insert 送完整列 op ⇒ started_at 那一格也戳
      ids.push(id);
    }
    for (const d of plan.deletes) {
      const r = this.blocks.get(d);
      if (!r) continue;
      r.deleted_at = nowIso;
      r.updated_at = nowIso;
    }
    return ids;
  }

  private sameLayer(parentId: string | null): TimeCategoryRow[] {
    return Array.from(this.cats.values()).filter((c) => isAlive(c) && c.parent_id === parentId);
  }

  /* ───────── 分類 ───────── */

  async listCategories(): Promise<TimeCategoryRow[]> {
    const all = Array.from(this.cats.values()).filter(isAlive);
    const grouped = groupedCategories(all.map((c) => ({ ...c, archived_at: null }))); // 排序用；封存的也要列
    const ordered: TimeCategoryRow[] = [];
    const seen = new Set<string>();
    for (const g of grouped) {
      const real = this.cats.get(g.group.id)!;
      ordered.push(clone(real));
      seen.add(real.id);
      for (const c of g.children) {
        ordered.push(clone(this.cats.get(c.id)!));
        seen.add(c.id);
      }
    }
    for (const c of all) if (!seen.has(c.id)) ordered.push(clone(c)); // 孤兒（父已刪）排最後
    return ordered;
  }

  async countCategoriesIncludingDeleted(): Promise<number> {
    return this.cats.size;
  }

  async ensureStarterCategories(): Promise<boolean> {
    if (this.cats.size > 0) return false;
    const now = nowUtcIso();
    for (const s of STARTER_CATEGORIES) {
      this.cats.set(s.id, {
        id: s.id,
        parent_id: s.parentId,
        name: s.name,
        glyph: s.glyph,
        color_idx: s.colorIdx,
        position: s.position,
        default_min: s.defaultMin,
        archived_at: null,
        account_id: null,
        device_id: null,
        created_at: now,
        updated_at: now,
        synced_at: null,
        deleted_at: null,
      });
    }
    return true;
  }

  async createCategory(input: CreateCategoryInput): Promise<TimeCategoryRow> {
    const name = input.name.trim();
    if (!name) throw new RangeError("分類名稱不能是空的");
    if (input.parentId !== null) {
      const parent = this.cats.get(input.parentId);
      if (!parent || !isAlive(parent) || parent.parent_id !== null) throw new RangeError("找不到這個分組");
    }
    const now = nowUtcIso();
    const siblings = this.sameLayer(input.parentId);
    const position = siblings.reduce((m, c) => Math.max(m, c.position), -1) + 1;
    const row: TimeCategoryRow = {
      id: uuid(),
      parent_id: input.parentId,
      name,
      glyph: input.parentId === null ? null : (Array.from(name)[0] ?? null),
      color_idx: input.colorIdx,
      position,
      default_min: input.defaultMin,
      archived_at: null,
      account_id: null,
      device_id: null,
      created_at: now,
      updated_at: now,
      synced_at: null,
      deleted_at: null,
    };
    this.cats.set(row.id, row);
    return clone(row);
  }

  async updateCategory(id: string, patch: CategoryPatch): Promise<void> {
    const c = this.cats.get(id);
    if (!c || !isAlive(c)) throw new RangeError("找不到這個分類");
    // 先全部驗證、再一起改（同 sqlite 一個 batch 的原子性）。規則＝①b①c 契約 §3.3-3
    const name = patch.name !== undefined ? patch.name.trim() : undefined;
    if (name !== undefined && !name) throw new RangeError("分類名稱不能是空的");
    let target: TimeCategoryRow | null = null;
    if (patch.parentId !== undefined) {
      if (c.parent_id === null) throw new RangeError("分組不能搬");
      const t = this.cats.get(patch.parentId);
      if (!t || !isAlive(t) || t.parent_id !== null) throw new RangeError("找不到這個分組");
      target = t;
    }
    if (patch.archived !== undefined && c.parent_id === null) throw new RangeError("分組不能封存");
    const glyph = patch.glyph !== undefined ? patch.glyph.trim() : undefined;
    if (glyph !== undefined) {
      if (c.parent_id === null) throw new RangeError("分組沒有圓牌字");
      if (Array.from(glyph).length !== 1) throw new RangeError("圓牌字只能一個字");
    }
    const now = nowUtcIso();
    if (name !== undefined) {
      // 圓牌字只在「還是自動的」（＝舊名第一字或 null）時跟著換；主人換過的不動（取代 ①a 的無條件覆寫）
      if (c.parent_id !== null && (c.glyph === null || c.glyph === Array.from(c.name)[0])) c.glyph = Array.from(name)[0] ?? null;
      c.name = name;
    }
    if (patch.colorIdx !== undefined) c.color_idx = patch.colorIdx;
    if (patch.defaultMin !== undefined) c.default_min = patch.defaultMin;
    if (target && target.id !== c.parent_id) {
      c.position = this.sameLayer(target.id).reduce((m, x) => Math.max(m, x.position), -1) + 1;
      c.parent_id = target.id;
    }
    if (patch.archived !== undefined) {
      if (patch.archived && c.archived_at === null) c.archived_at = now;
      else if (!patch.archived) c.archived_at = null;
    }
    if (glyph !== undefined) c.glyph = glyph;
    c.updated_at = now;
  }

  async reorderCategories(parentId: string | null, orderedIds: readonly string[]): Promise<void> {
    const now = nowUtcIso();
    orderedIds.forEach((id, i) => {
      const c = this.cats.get(id);
      if (!c || !isAlive(c) || c.parent_id !== parentId) return;
      if (c.position !== i) {
        c.position = i;
        c.updated_at = now;
      }
    });
  }

  /* ───────── 時間塊：讀 ───────── */

  async listRunning(): Promise<TimeBlockRow[]> {
    this.ensureDemo();
    return Array.from(this.blocks.values())
      .filter((r) => isAlive(r) && r.ended_at === null)
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
      .map(clone);
  }

  async listBlocks(fromIso: string, toIso: string): Promise<TimeBlockRow[]> {
    this.ensureDemo();
    return Array.from(this.blocks.values())
      .filter((r) => isAlive(r) && r.started_at < toIso && (r.ended_at === null || r.ended_at > fromIso))
      .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))
      .map(clone);
  }

  async listDaySegments(dateKey: string, dayStartHour: number): Promise<DayBlockSegment[]> {
    const w = dayWindow(dateKey, dayStartHour);
    const rows = await this.listBlocks(w.start, w.end);
    const items = segmentsOfDay(rows.map(toSpan), { start: msOf(w.start), end: msOf(w.end) }, Date.now());
    const catById: Record<string, TimeCategoryRow> = {};
    for (const c of await this.listCategories()) catById[c.id] = c;
    const rowsById: Record<string, TimeBlockRow> = {};
    for (const r of rows) rowsById[r.id] = r;
    return toDayBlockSegments(items, catById, rowsById);
  }

  /* ───────── 時間塊：寫 ───────── */

  async depart(categoryId: string, atIso: string, opts?: DepartOptions): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    const now = Date.now();
    const plan = planDepart(this.aliveSpans(), { categoryId, at: msOf(atIso), now, estimateMin: opts?.estimateMin ?? null });
    const ids = await this.applyPlan(plan, isoOf(now));
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    return { block: clone(this.blocks.get(newId)!), summary: summarizeCover(plan) };
  }

  async arrive(atIso?: string): Promise<TimeBlockRow[]> {
    const now = Date.now();
    const plan = planArrive(this.aliveSpans(), { at: atIso ? msOf(atIso) : null, now });
    await this.applyPlan(plan, isoOf(now));
    return plan.patches.map((p) => clone(this.blocks.get(p.id)!));
  }

  async undoArrive(id: string): Promise<boolean> {
    if (!canUndoArrive(this.aliveSpans(), id)) return false;
    const r = this.rowOrThrow(id);
    r.ended_at = null;
    r.updated_at = nowUtcIso();
    return true;
  }

  async restart(id: string, atIso: string): Promise<CoverSummary> {
    const now = Date.now();
    const plan = planRestart(this.aliveSpans(), { id, at: msOf(atIso), now });
    await this.applyPlan(plan, isoOf(now));
    return summarizeCover(plan, id);
  }

  async fill(categoryId: string, startIso: string, endIso: string): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    const now = Date.now();
    const plan = planFill(this.aliveSpans(), { categoryId, start: msOf(startIso), end: msOf(endIso), now });
    const ids = await this.applyPlan(plan, isoOf(now));
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    return { block: clone(this.blocks.get(newId)!), summary: summarizeCover(plan) };
  }

  async editBlock(id: string, input: { categoryId: string; startIso: string; endIso: string }): Promise<CoverSummary> {
    const now = Date.now();
    const plan = planEdit(this.aliveSpans(), {
      id,
      categoryId: input.categoryId,
      start: msOf(input.startIso),
      end: msOf(input.endIso),
      now,
    });
    await this.applyPlan(plan, isoOf(now));
    return summarizeCover(plan, id);
  }

  async split(id: string, atIso: string, categoryId2: string): Promise<TimeBlockRow | null> {
    const now = Date.now();
    const plan = planSplit(this.aliveSpans(), { id, at: msOf(atIso), categoryId2, now });
    if (!plan) return null;
    const ids = await this.applyPlan(plan, isoOf(now));
    return clone(this.blocks.get(ids[0])!);
  }

  async resolveLongRun(id: string, endIso: string, choice: LongRunChoice, categoryId2?: string): Promise<void> {
    const now = Date.now();
    const plan = planResolveLongRun(this.aliveSpans(), { id, end: msOf(endIso), choice, categoryId2: categoryId2 ?? null, now });
    await this.applyPlan(plan, isoOf(now));
  }

  async softDelete(id: string): Promise<void> {
    const r = this.rowOrThrow(id);
    const now = nowUtcIso();
    r.deleted_at = now;
    r.updated_at = now;
  }

  async restore(id: string): Promise<CoverSummary> {
    const r = this.blocks.get(id);
    if (!r || r.deleted_at === null) throw new RangeError("找不到這一塊");
    const now = Date.now();
    const me = toSpan(r);
    // 刪掉時還在運行中的塊：復原成「結束於刪除那一刻」（同 sqlite 實作；否則蓋到 +∞、刪掉之後発車的都被收掉）
    const endedAtRestore = r.ended_at === null ? r.deleted_at : null;
    const plan = planCover(this.aliveSpans(), { start: me.start, end: me.end ?? msOf(r.deleted_at) }, id);
    await this.applyPlan(plan, isoOf(now));
    if (endedAtRestore !== null) r.ended_at = endedAtRestore;
    r.deleted_at = null;
    r.updated_at = isoOf(now);
    return summarizeCover(plan, id);
  }

  async previewCover(startIso: string, endIso: string | null, exceptId: string | null): Promise<CoverSummary> {
    const plan = planCover(this.aliveSpans(), { start: msOf(startIso), end: endIso === null ? null : msOf(endIso) }, exceptId);
    return summarizeCover(plan, exceptId);
  }

  /* ───────── ①b（①b①c 契約 §3.2、§3.4） ───────── */

  async setEstimate(id: string, estimateMin: number | null): Promise<void> {
    const plan = planSetEstimate(this.aliveSpans(), { id, estimateMin });
    await this.applyPlan(plan, nowUtcIso());
  }

  async splitMulti(id: string, cutsIso: readonly string[], categoryIds: readonly string[]): Promise<TimeBlockRow[]> {
    const now = Date.now();
    const r = this.rowOrThrow(id);
    const plan = planSplitMulti(this.aliveSpans(), { id, cuts: cutsIso.map(msOf), categoryIds, now, estimateMin: r.estimate_min });
    const ids = await this.applyPlan(plan, isoOf(now));
    return [id, ...ids].map((x) => clone(this.blocks.get(x)!));
  }

  async previewMerge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null> {
    const out = planMerge(this.aliveSpans(), { id, dir, bound: msOf(boundIso), now: Date.now() });
    return out ? { ...out.preview } : null;
  }

  async merge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null> {
    const now = Date.now();
    const out = planMerge(this.aliveSpans(), { id, dir, bound: msOf(boundIso), now });
    if (!out) return null;
    await this.applyPlan(out.plan, isoOf(now));
    return { ...out.preview };
  }

  async listRecentCategoryIds(sinceIso: string, limit: number): Promise<string[]> {
    this.ensureDemo();
    const last = new Map<string, string>();
    for (const r of this.blocks.values()) {
      if (!isAlive(r) || r.started_at < sinceIso) continue;
      const m = last.get(r.category_id);
      if (m === undefined || r.started_at > m) last.set(r.category_id, r.started_at);
    }
    return Array.from(last.entries())
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .slice(0, limit)
      .map((e) => e[0]);
  }

  /* ───────── ①c 預留 ───────── */

  async blockExists(id: string): Promise<boolean> {
    this.ensureDemo();
    return this.blocks.has(id);
  }

  async departPending(categoryId: string, atIso: string, opts: { fixedId: string; untilNext: boolean }): Promise<TimeBlockRow | null> {
    const now = Date.now();
    const plan = planDepartPending(this.aliveSpans(), { categoryId, at: msOf(atIso), now, fixedId: opts.fixedId, untilNext: opts.untilNext });
    if (!plan) return null;
    await this.applyPlan(plan, isoOf(now));
    const row = this.blocks.get(opts.fixedId);
    return row ? clone(row) : null;
  }

  async arrivePending(atIso: string): Promise<TimeBlockRow[]> {
    const now = Date.now();
    const plan = planArriveBefore(this.aliveSpans(), { at: msOf(atIso), now });
    await this.applyPlan(plan, isoOf(now));
    return plan.patches.map((p) => clone(this.blocks.get(p.id)!));
  }

  /* ───────── 同步後整理 ───────── */

  async reconcile(): Promise<number> {
    this.ensureDemo();
    // 與真機同語義：只掃最近 RECONCILE_WINDOW_DAYS 天＋所有運行中（契約 §9-6 退路）
    const floor = reconcileWindowStart(Date.now());
    const keyed: KeyedSpan[] = [];
    for (const r of this.blocks.values()) {
      if (!isAlive(r)) continue;
      const span = toSpan(r);
      if (!inReconcileWindow(span, floor)) continue;
      keyed.push({ ...span, writeKey: reconcileWriteKey(this.startStamp.get(r.id), r.updated_at) });
    }
    const plan = planReconcile(keyed);
    const n = plan.patches.length + plan.inserts.length + plan.deletes.length;
    if (n) await this.applyPlan(plan, nowUtcIso());
    return n;
  }
}
