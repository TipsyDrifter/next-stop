/**
 * DepotRepository——車庫與駅スタンプ的資料存取（第五本第一梯 ③；契約 `docs/research/2026-11-02-主線-車庫與回顧-契約.md`）。
 *
 * 兩件事：
 *   1. 駅スタンプ表 `stamps`（migration stamps）的讀寫：`listStamps`、`applyStampPlan`（一個交易、照慣例送同步 op）。
 *   2. 唯讀的事實與彙總：`stampFacts`（給 domain/stamps.ts 的 detectStamps）、`loadDepot`（車庫頁：開業日、各路線済章數、
 *      全部済的日子、筆記摘要）。跨四個模組的表，只讀不寫。
 *
 * 済的口徑＝`nodes.completed_at`（列車／車廂／車票、status='done'）＋`occurrences.completed_at`（status='done'），都不含已刪的——
 * 同日記足跡與運行報告——② 抽出的共用口徑 `src/domain/seals.ts`（D-主-221 已接上）。
 *
 * 實作：本檔＝SQLite；`memoryDepotRepository.ts`＝`?mock=1`。單例在 `depotRepo.ts`。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso } from "../lib/db";
import { dayKeyOf } from "../lib/date";
import type { NoteKind } from "../domain/notes";
import type { WishDigestLike } from "../domain/depotView";
import type { BlockFact, StampFacts, StampPlan, StampRow } from "../domain/stamps";
import { newWriteBatch, runWriteBatch, type SyncTable, type WriteBatch } from "./syncRepository";
import { SEAL_NODE_SQL, SEAL_OCC_SQL, dedupeSeals, sealOfRow, type SealRow } from "../domain/seals";

/** 筆記與日記的摘要（年鑑的代表句、那年今日） */
export interface NoteDigest {
  id: string;
  kind: NoteKind;
  /** 歸屬日：日記＝entry_date；筆記＝noted_at 依日界線 */
  day: string;
  noted_at: string;
  title: string | null;
  /** 內文前 200 字 */
  text: string;
}

export interface DepotData {
  /** 路線 id → 開業日（路線 created_at 與子樹最早一枚 issued 事件取早的那天） */
  openedOn: Record<string, string>;
  /** 路線 id → 子樹的済章數（含掛標籤的臨時票、定期券班次） */
  routeSeals: Record<string, number>;
  /** 全部済的日子（舊→新；年鑑按月數、頁首總數） */
  sealDays: string[];
  notes: NoteDigest[];
  /** 實現過的願望（年鑑的「實現 N 件」與那年今日；舊→新） */
  wishes: WishDigestLike[];
}

/**
 * 實現過的願望：未刪、bought_at 有值，且「實現了」讀時判斷成立——buy 看 entry_id 指到的帳還在，其他種類看 target_node_id
 * 指到的節點還在（被刪＝回到等候，不算；D-主-516）。
 */
export const REALIZED_WISH_SQL = `SELECT w.id, w.name, COALESCE(k.name, '') AS kind, w.bought_at FROM tk_wishes w
  LEFT JOIN wr_kinds k ON k.id = w.kind_id AND k.deleted_at IS NULL
  WHERE w.deleted_at IS NULL AND w.bought_at IS NOT NULL
    AND (EXISTS (SELECT 1 FROM tk_entries e WHERE e.id = w.entry_id AND e.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM nodes n WHERE w.target_kind = 'node' AND n.id = w.target_id AND n.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM notes t WHERE w.target_kind = 'note' AND t.id = w.target_id AND t.deleted_at IS NULL)
      OR EXISTS (SELECT 1 FROM time_blocks tb WHERE w.target_kind = 'block' AND tb.id = w.target_id AND tb.deleted_at IS NULL))
  ORDER BY w.bought_at`;

export interface DepotRepository {
  listStamps(): Promise<StampRow[]>;
  /** 插入／復活／收回一次寫完（一個交易、一次同步） */
  applyStampPlan(plan: StampPlan): Promise<void>;
  stampFacts(today: string, dayStartHour: number): Promise<StampFacts>;
  loadDepot(dayStartHour: number): Promise<DepotData>;
}

const ST = "stamps" satisfies SyncTable;
const MIN = 60_000;
/** 時刻表「跑太久」全域上限的預設（同 timetableStore 的 LONG_RUN_MAX_DEFAULT；設定鍵同步） */
const LONG_RUN_MAX_DEFAULT = 840;

/* ───────── 兩種實作共用的純函式 ───────── */

/** 已結束的塊算不算數：跑太久沒確認的（待確認）不算——門檻＝這一班的預估 → 全域上限（規格書 §4 時刻表①b） */
export function blockCounts(
  b: { started_at: string; ended_at: string; estimate_min: number | null; long_run_ack: number | boolean | null },
  globalMaxMin: number,
): boolean {
  const ms = Date.parse(b.ended_at) - Date.parse(b.started_at);
  if (!(ms > 0)) return false;
  if (b.long_run_ack) return true;
  const thr = b.estimate_min !== null && b.estimate_min > 0 ? b.estimate_min : globalMaxMin > 0 ? globalMaxMin : null;
  return thr === null || ms <= thr * MIN;
}

export function parseLongRunMax(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return LONG_RUN_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : LONG_RUN_MAX_DEFAULT;
}

/** 開業日：路線 created_at 與子樹最早 issued 事件取早的那個（依日界線） */
export function openedOnOf(createdAt: string, firstIssued: string | null, dayStartHour: number): string {
  const at = firstIssued !== null && firstIssued < createdAt ? firstIssued : createdAt;
  return dayKeyOf(at, dayStartHour);
}

/* ───────── SQLite ───────── */

interface SealSqlRow {
  route_id: string | null;
  name: string;
  at: string;
}

/** 全部的済（② 的共用口徑 `domain/seals.ts`：兩句 SELECT＋同一節點同一時刻只算一枚），舊→新 */
const ALL_TIME = ["0000-01-01T00:00:00.000Z", "9999-12-31T00:00:00.000Z"];
async function allSeals(db: Database): Promise<SealSqlRow[]> {
  const [a, b] = await Promise.all([db.select<SealRow[]>(SEAL_NODE_SQL, ALL_TIME), db.select<SealRow[]>(SEAL_OCC_SQL, ALL_TIME)]);
  return dedupeSeals([...a, ...b].map(sealOfRow)).map((s) => ({ route_id: s.routeId, name: s.name, at: s.at }));
}

function addOp(b: WriteBatch, rowId: string, op: "upsert" | "delete", cols: Record<string, unknown>): void {
  b.ops.push({ tbl: ST, row_id: rowId, op, cols });
}

export class SqliteDepotRepository implements DepotRepository {
  async listStamps(): Promise<StampRow[]> {
    const db = await getDb();
    return db.select<StampRow[]>(`SELECT id, kind, subject_id, value, label, stamped_on, created_at, updated_at, deleted_at FROM stamps`);
  }

  async applyStampPlan(plan: StampPlan): Promise<void> {
    if (!plan.insert.length && !plan.revive.length && !plan.retract.length) return;
    const db = await getDb();
    const now = nowUtcIso();
    const b = newWriteBatch();
    for (const s of plan.insert) {
      b.stmts.push({
        sql: `INSERT INTO stamps (id, kind, subject_id, value, label, stamped_on, created_at, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(id) DO NOTHING`,
        args: [s.id, s.kind, s.subject_id, s.value, s.label, s.stamped_on, now],
      });
      addOp(b, s.id, "upsert", {
        kind: s.kind,
        subject_id: s.subject_id,
        value: s.value,
        label: s.label,
        stamped_on: s.stamped_on,
        created_at: now,
        updated_at: now,
      });
    }
    for (const s of plan.revive) {
      b.stmts.push({
        sql: `UPDATE stamps SET deleted_at = NULL, stamped_on = $1, label = $2, updated_at = $3 WHERE id = $4`,
        args: [s.stamped_on, s.label, now, s.id],
      });
      addOp(b, s.id, "upsert", { deleted_at: null, stamped_on: s.stamped_on, label: s.label, updated_at: now });
    }
    for (const r of plan.retract) {
      b.stmts.push({ sql: `UPDATE stamps SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, r.id] });
      addOp(b, r.id, "delete", { deleted_at: now, updated_at: now });
    }
    await runWriteBatch(db, b.stmts, b.ops);
  }

  private async openings(db: Database, dayStartHour: number): Promise<Record<string, string>> {
    const [routes, issued] = await Promise.all([
      db.select<{ id: string; created_at: string }[]>(`SELECT id, created_at FROM nodes WHERE kind = 'route'`),
      db.select<{ rid: string; at: string }[]>(
        `SELECT n.route_id AS rid, MIN(w.logged_at) AS at FROM work_logs w JOIN nodes n ON n.id = w.node_id
         WHERE w.event = 'issued' AND n.route_id IS NOT NULL GROUP BY n.route_id`,
      ),
    ]);
    const first = new Map(issued.map((r) => [r.rid, r.at] as const));
    const out: Record<string, string> = {};
    for (const r of routes) out[r.id] = openedOnOf(r.created_at, first.get(r.id) ?? null, dayStartHour);
    return out;
  }

  async stampFacts(today: string, dayStartHour: number): Promise<StampFacts> {
    const db = await getDb();
    const [first, subjects, opened, seals, diaries, ledger, blocks, cats, maxRow] = await Promise.all([
      db.select<{ name: string; created_at: string }[]>(
        `SELECT name, created_at FROM nodes WHERE kind IN ('train','car','ticket') ORDER BY created_at ASC LIMIT 1`,
      ),
      db.select<{ id: string; kind: string; name: string; arrived_on: string | null; deleted_at: string | null }[]>(
        `SELECT id, kind, name, arrived_on, deleted_at FROM nodes WHERE kind IN ('line','route','station')`,
      ),
      this.openings(db, dayStartHour),
      allSeals(db),
      db.select<{ created_at: string }[]>(
        `SELECT created_at FROM notes WHERE kind = 'diary' AND deleted_at IS NULL ORDER BY created_at`,
      ),
      db.select<{ at: string | null }[]>(`SELECT MIN(created_at) AS at FROM tk_entries WHERE deleted_at IS NULL`),
      db.select<{ category_id: string; started_at: string; ended_at: string; estimate_min: number | null; long_run_ack: number | null }[]>(
        `SELECT category_id, started_at, ended_at, estimate_min, long_run_ack FROM time_blocks
         WHERE deleted_at IS NULL AND ended_at IS NOT NULL ORDER BY ended_at`,
      ),
      db.select<{ id: string; name: string }[]>(`SELECT id, name FROM time_categories`),
      db.select<{ value: string }[]>(`SELECT value FROM settings WHERE key = 'timetable_long_run_max_min'`),
    ]);
    const globalMax = parseLongRunMax(maxRow[0]?.value);
    const pick = (k: string) =>
      subjects
        .filter((s) => s.kind === k)
        .map((s) => ({ id: s.id, name: s.name, arrived_on: s.arrived_on, alive: s.deleted_at === null }));
    const blockFacts: BlockFact[] = [];
    for (const b of blocks) {
      if (!blockCounts(b, globalMax)) continue;
      blockFacts.push({
        category_id: b.category_id,
        ms: Date.parse(b.ended_at) - Date.parse(b.started_at),
        end_day: dayKeyOf(b.ended_at, dayStartHour),
        end_at: b.ended_at,
      });
    }
    return {
      today,
      firstTask: first[0] ? { day: dayKeyOf(first[0].created_at, dayStartHour), name: first[0].name } : null,
      stations: pick("station"),
      routes: pick("route").map((r) => ({ ...r, opened_on: opened[r.id] ?? today })),
      lines: pick("line"),
      seals: seals.map((s) => ({ day: dayKeyOf(s.at, dayStartHour), name: s.name })),
      diaryDays: diaries.map((d) => dayKeyOf(d.created_at, dayStartHour)),
      ledgerFirstDay: ledger[0]?.at ? dayKeyOf(ledger[0].at, dayStartHour) : null,
      blocks: blockFacts,
      categoryNames: Object.fromEntries(cats.map((c) => [c.id, c.name])),
    };
  }

  async loadDepot(dayStartHour: number): Promise<DepotData> {
    const db = await getDb();
    const [openedOn, seals, notes, wishes] = await Promise.all([
      this.openings(db, dayStartHour),
      allSeals(db),
      db.select<{ id: string; kind: NoteKind; title: string | null; body: string; entry_date: string | null; noted_at: string }[]>(
        `SELECT id, kind, title, substr(body, 1, 200) AS body, entry_date, noted_at FROM notes
         WHERE deleted_at IS NULL AND inbox = 0 AND kind IN ('note','diary')`,
      ),
      db.select<{ id: string; name: string; kind: string; bought_at: string }[]>(REALIZED_WISH_SQL),
    ]);
    const routeSeals: Record<string, number> = {};
    for (const s of seals) if (s.route_id) routeSeals[s.route_id] = (routeSeals[s.route_id] ?? 0) + 1;
    return {
      openedOn,
      routeSeals,
      sealDays: seals.map((s) => dayKeyOf(s.at, dayStartHour)),
      notes: notes.map((n) => ({
        id: n.id,
        kind: n.kind,
        day: n.kind === "diary" && n.entry_date ? n.entry_date : dayKeyOf(n.noted_at, dayStartHour),
        noted_at: n.noted_at,
        title: n.title,
        text: n.body,
      })),
      wishes: wishes.map((w) => ({ id: w.id, name: w.name, kind: w.kind, bought_at: w.bought_at, day: dayKeyOf(w.bought_at, dayStartHour) })),
    };
  }
}
