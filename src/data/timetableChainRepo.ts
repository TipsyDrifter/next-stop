/**
 * timetableChainRepo——時刻表行為鏈（`time_chains`）資料存取層（SQLite ＋ Memory 雙實作）。
 *
 * 對齊 `0028_attachments_and_chains.sql` 與 `src-tauri/src/sync/tables/timetable.rs` 的 `TIME_CHAINS_COLS`：
 * `id, name, steps, position, archived_at, created_at, updated_at, deleted_at`。
 *
 * SQLite 實作所有寫入一律走 `WriteBatch` 並送同步 ops；Memory 實作在非 wiped 模式下內建 2 條示範行為鏈供 `?mock=1` 體驗。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { MOCK_MODE, WIPED_MODE } from "./index";
import { newWriteBatch, runWriteBatch, type SyncTable, type WriteBatch } from "./syncRepository";
import {
  parseChainSteps,
  serializeChainSteps,
  validateChainInput,
  type TimeChainRow,
  type TimeChainStep,
} from "../domain/timetableChain";

const ALIVE = "deleted_at IS NULL";
const TABLE: SyncTable = "time_chains";

interface RawTimeChainRow {
  id: string;
  name: string;
  steps: string;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateTimeChainInput {
  name: string;
  steps: readonly TimeChainStep[];
}

export interface UpdateTimeChainPatch {
  name?: string;
  steps?: readonly TimeChainStep[];
  archivedAt?: string | null;
}

export interface TimetableChainRepository {
  /** 未刪除（含封存），依 position → created_at → id 排序 */
  listChains(): Promise<TimeChainRow[]>;
  getChain(id: string, opts?: { withDeleted?: boolean }): Promise<TimeChainRow | null>;
  createChain(input: CreateTimeChainInput): Promise<TimeChainRow>;
  updateChain(id: string, patch: UpdateTimeChainPatch): Promise<TimeChainRow>;
  archiveChain(id: string): Promise<void>;
  /** 還原已封存或已軟刪除的行為鏈 */
  restoreChain(id: string): Promise<void>;
  deleteChain(id: string): Promise<void>;
  reorderChains(orderedIds: readonly string[]): Promise<void>;
}

function addOp(b: WriteBatch, rowId: string, op: "upsert" | "delete", cols: Record<string, unknown>): void {
  b.ops.push({ tbl: TABLE, row_id: rowId, op, cols });
}

function toDomainRow(raw: RawTimeChainRow): TimeChainRow {
  return {
    id: raw.id,
    name: raw.name,
    steps: parseChainSteps(raw.steps),
    position: raw.position,
    archivedAt: raw.archived_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function sortOrder(a: Pick<RawTimeChainRow, "position" | "created_at" | "id">, b: Pick<RawTimeChainRow, "position" | "created_at" | "id">): number {
  return (
    a.position - b.position ||
    (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function mergeReorderIds(rows: readonly Pick<RawTimeChainRow, "id" | "position" | "created_at">[], orderedIds: readonly string[]): string[] {
  const live = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of orderedIds) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  const rest = rows.filter((r) => !seen.has(r.id)).slice().sort(sortOrder);
  for (const r of rest) out.push(r.id);
  return out;
}

class SqliteTimetableChainRepo implements TimetableChainRepository {
  private async getRaw(db: Database, id: string): Promise<RawTimeChainRow | null> {
    const rows = await db.select<RawTimeChainRow[]>(
      `SELECT id, name, steps, position, archived_at, created_at, updated_at, deleted_at FROM time_chains WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  private async aliveOrThrow(db: Database, id: string): Promise<RawTimeChainRow> {
    const row = await this.getRaw(db, id);
    if (!row || row.deleted_at !== null) throw new RangeError("找不到這條行為鏈");
    return row;
  }

  async listChains(): Promise<TimeChainRow[]> {
    const db = await getDb();
    const rows = await db.select<RawTimeChainRow[]>(
      `SELECT id, name, steps, position, archived_at, created_at, updated_at, deleted_at
       FROM time_chains WHERE ${ALIVE}
       ORDER BY position ASC, created_at ASC, id ASC`,
    );
    return rows.map(toDomainRow);
  }

  async getChain(id: string, opts?: { withDeleted?: boolean }): Promise<TimeChainRow | null> {
    const db = await getDb();
    const row = await this.getRaw(db, id);
    if (!row) return null;
    if (row.deleted_at !== null && !opts?.withDeleted) return null;
    return toDomainRow(row);
  }

  async createChain(input: CreateTimeChainInput): Promise<TimeChainRow> {
    const err = validateChainInput(input.name, input.steps);
    if (err) throw new RangeError(err);
    const name = input.name.trim();
    const stepsJson = serializeChainSteps(input.steps);
    const db = await getDb();
    const max = await db.select<{ m: number | null }[]>(`SELECT MAX(position) AS m FROM time_chains WHERE ${ALIVE}`);
    const position = (max[0]?.m ?? -1) + 1;
    const now = nowUtcIso();
    const id = uuid();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `INSERT INTO time_chains (id, name, steps, position, archived_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, NULL, $5, $5)`,
      args: [id, name, stepsJson, position, now],
    });
    addOp(b, id, "upsert", {
      name,
      steps: stepsJson,
      position,
      archived_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    await runWriteBatch(db, b.stmts, b.ops);
    const created = await this.getRaw(db, id);
    if (!created) throw new Error("建立行為鏈失敗");
    return toDomainRow(created);
  }

  async updateChain(id: string, patch: UpdateTimeChainPatch): Promise<TimeChainRow> {
    const db = await getDb();
    const cur = await this.aliveOrThrow(db, id);
    const nextName = patch.name !== undefined ? patch.name.trim() : cur.name;
    const nextSteps = patch.steps !== undefined ? patch.steps : parseChainSteps(cur.steps);
    const err = validateChainInput(nextName, nextSteps);
    if (err) throw new RangeError(err);

    const nextStepsJson = patch.steps !== undefined ? serializeChainSteps(patch.steps) : cur.steps;
    const sets: string[] = [];
    const args: unknown[] = [];
    const cols: Record<string, unknown> = {};
    const put = (col: string, val: unknown, old: unknown): void => {
      if (val === undefined || val === old) return;
      args.push(val);
      sets.push(`${col} = $${args.length}`);
      cols[col] = val;
    };
    put("name", nextName, cur.name);
    put("steps", nextStepsJson, cur.steps);
    if (patch.archivedAt !== undefined) put("archived_at", patch.archivedAt, cur.archived_at);

    if (!sets.length) return toDomainRow(cur);

    const now = nowUtcIso();
    args.push(now);
    sets.push(`updated_at = $${args.length}`);
    cols.updated_at = now;
    args.push(id);

    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_chains SET ${sets.join(", ")} WHERE id = $${args.length}`, args });
    addOp(b, id, "upsert", cols);
    await runWriteBatch(db, b.stmts, b.ops);

    const updated = await this.getRaw(db, id);
    if (!updated) throw new Error("更新行為鏈失敗");
    return toDomainRow(updated);
  }

  async archiveChain(id: string): Promise<void> {
    const db = await getDb();
    const cur = await this.aliveOrThrow(db, id);
    if (cur.archived_at !== null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_chains SET archived_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, id, "upsert", { archived_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async restoreChain(id: string): Promise<void> {
    const db = await getDb();
    const cur = await this.getRaw(db, id);
    if (!cur) throw new RangeError("找不到這條行為鏈");
    if (cur.deleted_at === null && cur.archived_at === null) return;
    const now = nowUtcIso();
    const sets: string[] = [];
    const cols: Record<string, unknown> = {};
    if (cur.deleted_at !== null) {
      sets.push("deleted_at = NULL");
      cols.deleted_at = null;
    }
    if (cur.archived_at !== null) {
      sets.push("archived_at = NULL");
      cols.archived_at = null;
    }
    sets.push("updated_at = $1");
    cols.updated_at = now;
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_chains SET ${sets.join(", ")} WHERE id = $2`, args: [now, id] });
    addOp(b, id, "upsert", cols);
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async deleteChain(id: string): Promise<void> {
    const db = await getDb();
    await this.aliveOrThrow(db, id);
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE time_chains SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, id, "delete", { deleted_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async reorderChains(orderedIds: readonly string[]): Promise<void> {
    const db = await getDb();
    const rows = await db.select<Pick<RawTimeChainRow, "id" | "position" | "created_at">[]>(
      `SELECT id, position, created_at FROM time_chains WHERE archived_at IS NULL AND ${ALIVE}`,
    );
    const order = mergeReorderIds(rows, orderedIds);
    if (order.length === 0) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    order.forEach((id, idx) => {
      b.stmts.push({ sql: `UPDATE time_chains SET position = $1, updated_at = $2 WHERE id = $3`, args: [idx, now, id] });
      addOp(b, id, "upsert", { position: idx, updated_at: now });
    });
    await runWriteBatch(db, b.stmts, b.ops);
  }
}

/** Memory 示範資料（對應 STARTER_CATEGORIES 真實 UUID） */
const MOCK_DEMO_CHAINS: readonly Omit<RawTimeChainRow, "created_at" | "updated_at">[] = [
  {
    id: "demo-chain-morning",
    name: "晨間啟動",
    steps: serializeChainSteps([
      { categoryId: "556a9c6a-de21-5b7d-9a3e-cc6312e7eef8", label: "喚醒伸展", estimateMin: 10 },
      { categoryId: "95280e69-3759-5d75-ac4f-b86547b913aa", label: "晨間閱讀", estimateMin: 20 },
      { categoryId: "9ab43381-2ee9-50fd-95dc-43239ad5cfbf", label: "整理今日計畫", estimateMin: 10 },
    ]),
    position: 0,
    archived_at: null,
    deleted_at: null,
  },
  {
    id: "demo-chain-deepwork",
    name: "深度專注連班",
    steps: serializeChainSteps([
      { categoryId: "95280e69-3759-5d75-ac4f-b86547b913aa", label: "前置暖身", estimateMin: 10 },
      { categoryId: "66a4fdf6-bc28-5cd4-8455-3faffd56f118", label: "深度專注", estimateMin: 45, note: "手機轉勿擾" },
      { categoryId: "cb9607ec-fb52-5deb-bc9e-7e5c7cbd6980", label: "整理收尾", estimateMin: 10 },
    ]),
    position: 1,
    archived_at: null,
    deleted_at: null,
  },
];

class MemoryTimetableChainRepo implements TimetableChainRepository {
  private readonly rows = new Map<string, RawTimeChainRow>();

  constructor(seedDemo: boolean) {
    if (seedDemo) {
      const base = nowUtcIso();
      for (const item of MOCK_DEMO_CHAINS) {
        this.rows.set(item.id, { ...item, created_at: base, updated_at: base });
      }
    }
  }

  async listChains(): Promise<TimeChainRow[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.deleted_at === null)
      .sort(sortOrder)
      .map(toDomainRow);
  }

  async getChain(id: string, opts?: { withDeleted?: boolean }): Promise<TimeChainRow | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    if (r.deleted_at !== null && !opts?.withDeleted) return null;
    return toDomainRow(r);
  }

  async createChain(input: CreateTimeChainInput): Promise<TimeChainRow> {
    const err = validateChainInput(input.name, input.steps);
    if (err) throw new RangeError(err);
    const alive = Array.from(this.rows.values()).filter((r) => r.deleted_at === null);
    const maxPos = alive.reduce((m, r) => Math.max(m, r.position), -1);
    const now = nowUtcIso();
    const row: RawTimeChainRow = {
      id: uuid(),
      name: input.name.trim(),
      steps: serializeChainSteps(input.steps),
      position: maxPos + 1,
      archived_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.rows.set(row.id, row);
    return toDomainRow(row);
  }

  async updateChain(id: string, patch: UpdateTimeChainPatch): Promise<TimeChainRow> {
    const cur = this.rows.get(id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這條行為鏈");
    const nextName = patch.name !== undefined ? patch.name.trim() : cur.name;
    const nextSteps = patch.steps !== undefined ? patch.steps : parseChainSteps(cur.steps);
    const err = validateChainInput(nextName, nextSteps);
    if (err) throw new RangeError(err);
    const next: RawTimeChainRow = {
      ...cur,
      name: nextName,
      steps: patch.steps !== undefined ? serializeChainSteps(patch.steps) : cur.steps,
      archived_at: patch.archivedAt !== undefined ? patch.archivedAt : cur.archived_at,
      updated_at: nowUtcIso(),
    };
    this.rows.set(id, next);
    return toDomainRow(next);
  }

  async archiveChain(id: string): Promise<void> {
    const cur = this.rows.get(id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這條行為鏈");
    if (cur.archived_at !== null) return;
    const now = nowUtcIso();
    this.rows.set(id, { ...cur, archived_at: now, updated_at: now });
  }

  async restoreChain(id: string): Promise<void> {
    const cur = this.rows.get(id);
    if (!cur) throw new RangeError("找不到這條行為鏈");
    if (cur.deleted_at === null && cur.archived_at === null) return;
    this.rows.set(id, { ...cur, deleted_at: null, archived_at: null, updated_at: nowUtcIso() });
  }

  async deleteChain(id: string): Promise<void> {
    const cur = this.rows.get(id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這條行為鏈");
    const now = nowUtcIso();
    this.rows.set(id, { ...cur, deleted_at: now, updated_at: now });
  }

  async reorderChains(orderedIds: readonly string[]): Promise<void> {
    const alive = Array.from(this.rows.values()).filter((r) => r.deleted_at === null && r.archived_at === null);
    const order = mergeReorderIds(alive, orderedIds);
    const now = nowUtcIso();
    order.forEach((id, idx) => {
      const cur = this.rows.get(id);
      if (cur) this.rows.set(id, { ...cur, position: idx, updated_at: now });
    });
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const timetableChainRepo: TimetableChainRepository =
  !MOCK_MODE && isTauriRuntime() ? new SqliteTimetableChainRepo() : new MemoryTimetableChainRepo(!WIPED_MODE);
