/**
 * 週方針的 SQLite 實作（戊；契約 §2、§3）。
 *
 * 寫法照 `sqliteTimetableRepository.ts` 的 time_routines：一支寫入＝一個 WriteBatch（資料語句與 op 同批）、只送變了的欄、軟刪除。
 * 新列（含帶過來、復活的決定性 id 那列）送完整列：收到方沒有這列時必填欄要齊。
 * 「已排」與回顧只讀 nodes／occurrences／time_blocks／tk_entries（D-主-257、258），不寫別人的表。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { escapeLike } from "../lib/sql";
import { newWriteBatch, runWriteBatch, type SyncTable, type WriteBatch } from "./syncRepository";
import type { AimNodeRef, ReviewResult, WeekAimRepository } from "./weekAimRepository";
import {
  assertAimLimit,
  dayRangeWindow,
  keyRowBounds,
  toDayRange,
  type AimSavePlan,
  type DayRange,
  type PlanCount,
  type ReviewStat,
  type WeekAimRow,
} from "../domain/weekAims";
import { SEAL_NODE_SQL, SEAL_OCC_SQL, dedupeSeals, sealOfRow, type SealRow } from "../domain/seals";

const ALIVE = "deleted_at IS NULL";
const TBL: SyncTable = "week_aims";
/** 「已排」的種類（D-主-257）；回顧的蓋章數改走 domain/seals.ts（D-主-283） */
const PLAN_KINDS = "('ticket','train','car')";
const NOT_REPEAT = "(repeat_rule IS NULL OR repeat_rule = '')";

function addOp(b: WriteBatch, rowId: string, op: "upsert" | "delete", cols: Record<string, unknown>): void {
  b.ops.push({ tbl: TBL, row_id: rowId, op, cols });
}

/** 節點底下（含自己）：路線＝route_id 快取（含路線標籤的臨時票）；其他＝遞迴子樹。回 SQL 片段（`p`＝節點 id 的參數位，預設 $1） */
function underSql(kind: AimNodeRef["kind"], p = "$1"): string {
  if (kind === "route") return `SELECT id FROM nodes WHERE route_id = ${p} OR id = ${p}`;
  return `WITH RECURSIVE sub(id) AS (SELECT ${p} UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) SELECT id FROM sub`;
}

export class SqliteWeekAimRepository implements WeekAimRepository {
  private async row(db: Database, id: string): Promise<WeekAimRow | null> {
    const rows = await db.select<WeekAimRow[]>(`SELECT * FROM week_aims WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async alive(db: Database, id: string): Promise<WeekAimRow> {
    const r = await this.row(db, id);
    if (!r || r.deleted_at !== null) throw new RangeError("找不到這句方針");
    return r;
  }

  async listRange(from: string, to: string): Promise<WeekAimRow[]> {
    const db = await getDb();
    return db.select<WeekAimRow[]>(
      `SELECT * FROM week_aims WHERE week_on >= $1 AND week_on <= $2 ORDER BY week_on, position, created_at, id`,
      [from, to],
    );
  }

  async listKeys(keys: readonly string[]): Promise<WeekAimRow[]> {
    if (!keys.length) return [];
    const db = await getDb();
    const marks = keys.map((_, i) => `$${i + 1}`).join(",");
    return db.select<WeekAimRow[]>(`SELECT * FROM week_aims WHERE week_on IN (${marks}) ORDER BY week_on, position, created_at, id`, [...keys]);
  }

  async getAim(id: string, opts?: { withDeleted?: boolean }): Promise<WeekAimRow | null> {
    const db = await getDb();
    const r = await this.row(db, id);
    if (!r) return null;
    return r.deleted_at !== null && !opts?.withDeleted ? null : r;
  }

  async searchAims(query: string): Promise<WeekAimRow[]> {
    const q = query.trim();
    if (!q) return [];
    const db = await getDb();
    // LIKE 字面比對同 nodes 的 searchFull（接縫 #67）
    return db.select<WeekAimRow[]>(`SELECT * FROM week_aims WHERE ${ALIVE} AND text LIKE $1 ESCAPE '\\' ORDER BY updated_at DESC, id`, [`%${escapeLike(q)}%`]);
  }

  async saveWeek(key: string, plan: AimSavePlan): Promise<void> {
    if (!plan.creates.length && !plan.updates.length && !plan.deletes.length) return;
    const db = await getDb();
    const bounds = keyRowBounds(key);
    const cur = await db.select<{ id: string }[]>(`SELECT id FROM week_aims WHERE ${ALIVE} AND week_on >= $1 AND week_on <= $2`, [
      bounds.from,
      bounds.to,
    ]);
    const aliveIds = new Set(cur.map((r) => r.id));
    assertAimLimit(key, aliveIds, plan);

    const now = nowUtcIso();
    const b = newWriteBatch();
    for (const c of plan.creates) {
      const id = c.id ?? uuid();
      const prev = await this.row(db, id);
      const createdAt = prev?.created_at ?? now;
      b.stmts.push({
        sql: `INSERT INTO week_aims (id, week_on, text, node_id, position, done_at, carried_from, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL)
         ON CONFLICT(id) DO UPDATE SET
           week_on = excluded.week_on, text = excluded.text, node_id = excluded.node_id, position = excluded.position,
           done_at = NULL, carried_from = excluded.carried_from, updated_at = excluded.updated_at, deleted_at = NULL`,
        args: [id, key, c.text, c.nodeId, c.position, c.carriedFrom, createdAt, now],
      });
      addOp(b, id, "upsert", {
        week_on: key,
        text: c.text,
        node_id: c.nodeId,
        position: c.position,
        done_at: null,
        carried_from: c.carriedFrom,
        created_at: createdAt,
        updated_at: now,
        deleted_at: null,
      });
    }
    for (const u of plan.updates) {
      const sets: string[] = [];
      const args: unknown[] = [];
      const cols: Record<string, unknown> = {};
      const put = (col: string, val: unknown): void => {
        args.push(val);
        sets.push(`${col} = $${args.length}`);
        cols[col] = val;
      };
      if (u.text !== undefined) put("text", u.text);
      if (u.nodeId !== undefined) put("node_id", u.nodeId);
      if (u.position !== undefined) put("position", u.position);
      if (!sets.length) continue;
      put("updated_at", now);
      args.push(u.id);
      b.stmts.push({ sql: `UPDATE week_aims SET ${sets.join(", ")} WHERE id = $${args.length} AND ${ALIVE}`, args });
      addOp(b, u.id, "upsert", cols);
    }
    for (const id of plan.deletes) {
      if (!aliveIds.has(id)) continue;
      b.stmts.push({ sql: `UPDATE week_aims SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
      addOp(b, id, "delete", { deleted_at: now, updated_at: now });
    }
    if (!b.stmts.length) return;
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async setDone(id: string, at: string | null): Promise<void> {
    const db = await getDb();
    const cur = await this.alive(db, id);
    if ((cur.done_at === null) === (at === null)) return; // 狀態沒變：不重戳、不送 op
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE week_aims SET done_at = $1, updated_at = $2 WHERE id = $3`, args: [at, now, id] });
    addOp(b, id, "upsert", { done_at: at, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async deleteAim(id: string): Promise<void> {
    const db = await getDb();
    await this.alive(db, id);
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE week_aims SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, id, "delete", { deleted_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async restoreAim(id: string): Promise<void> {
    const db = await getDb();
    const cur = await this.row(db, id);
    if (!cur || cur.deleted_at === null) throw new RangeError("找不到這句方針");
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE week_aims SET deleted_at = NULL, updated_at = $1 WHERE id = $2`, args: [now, id] });
    addOp(b, id, "upsert", { deleted_at: null, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async plannedCounts(nodes: readonly AimNodeRef[], from: string, to: string): Promise<Record<string, PlanCount>> {
    const db = await getDb();
    const out: Record<string, PlanCount> = {};
    for (const n of nodes) {
      if (out[n.id]) continue;
      const rows = await db.select<{ planned: number; done: number }[]>(
        `SELECT COUNT(*) AS planned, COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
           FROM nodes
          WHERE id IN (${underSql(n.kind)}) AND id <> $1 AND ${ALIVE}
            AND kind IN ${PLAN_KINDS} AND ${NOT_REPEAT}
            AND scheduled_on >= $2 AND scheduled_on <= $3`,
        [n.id, from, to],
      );
      out[n.id] = { planned: Number(rows[0]?.planned ?? 0), done: Number(rows[0]?.done ?? 0) };
    }
    return out;
  }

  async reviewStats(nodes: readonly AimNodeRef[], range: DayRange | string, dayStartHour: number): Promise<ReviewResult> {
    const db = await getDb();
    const { from, to } = toDayRange(range);
    const { start: winStart, end: winEnd } = dayRangeWindow({ from, to }, dayStartHour);
    const startMs = Date.parse(winStart);
    const endMs = Math.min(Date.parse(winEnd), Date.now());
    const stats: Record<string, ReviewStat> = {};
    for (const n of nodes) {
      if (stats[n.id]) continue;
      const under = underSql(n.kind);
      // 蓋章＝這一期的済章裡、落在這個節點底下的（全 App 一份口徑 domain/seals.ts：日記足跡、運行報告、車庫同一套；D-主-283）
      const inUnder = ` AND n.id IN (${underSql(n.kind, "$3")})`;
      const [sa, sb] = await Promise.all([
        db.select<SealRow[]>(SEAL_NODE_SQL + inUnder, [winStart, winEnd, n.id]),
        db.select<SealRow[]>(SEAL_OCC_SQL + inUnder, [winStart, winEnd, n.id]),
      ]);
      const seals = dedupeSeals([...sa, ...sb].map(sealOfRow)).length;
      const blocks = await db.select<{ started_at: string; ended_at: string | null }[]>(
        `SELECT started_at, ended_at FROM time_blocks
          WHERE deleted_at IS NULL AND started_at < $3 AND (ended_at IS NULL OR ended_at > $2)
            AND (node_id IN (${under})${n.kind === "route" ? " OR route_id = $1" : ""})`,
        [n.id, winStart, winEnd],
      );
      let ms = 0;
      for (const bl of blocks) {
        const s = Math.max(Date.parse(bl.started_at), startMs);
        const e = Math.min(bl.ended_at ? Date.parse(bl.ended_at) : Date.now(), endMs);
        if (e > s) ms += e - s;
      }
      let spend: number | null = null;
      if (n.kind === "route") {
        const sum = await db.select<{ s: number | null }[]>(
          `SELECT SUM(main_minor) AS s FROM tk_entries
            WHERE deleted_at IS NULL AND kind = 'expense' AND route_id = $1 AND occurred_on >= $2 AND occurred_on <= $3`,
          [n.id, from, to],
        );
        spend = Number(sum[0]?.s ?? 0);
      }
      stats[n.id] = {
        stamps: seals,
        minutes: Math.round(ms / 60_000),
        spendMinor: spend,
      };
    }
    const cur = await db.select<{ code: string; decimals: number }[]>(
      `SELECT code, decimals FROM tk_currencies WHERE is_main = 1 AND deleted_at IS NULL LIMIT 1`,
    );
    return { stats, money: cur[0] ? { code: cur[0].code, decimals: Number(cur[0].decimals) } : null };
  }
}
