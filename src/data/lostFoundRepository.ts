/**
 * LostFoundRepository——失物招領的資料存取（第五本第二梯 ⑦；契約 `docs/research/2026-11-04-主線-失物招領-契約.md` §2、§3、§3.5）。
 *
 * 三件事：
 *   1. 最近刪除：`list`（各表窗內的 tombstone，交 `groupDeleted`）、`restore`（各種類走既有 repo 的復原，這裡不另寫 UPDATE）。
 *   2. 從雲端快照撿回：`readSnapshot`＋`diffSnapshot`＋`rescue`。撿回是**現在的一筆編輯**：整列 op、HLC 比快照之後的都新，
 *      對面可能根本沒有這一列，所以送同步欄整列（部分欄 op 會因必填欄缺值被略過）。
 *   3. 內容不同：`revertToSnapshot`／`undoRevert`，只寫比對欄的一筆新編輯，走一般 op（§3.5）。
 *
 * 規則都在 `domain/lostFound.ts`（`planNodeRestore`、`planRescue`、`snapshotDiff`），本檔只讀現況、把計畫落成 SQL。
 *
 * 已知限制（對抗審查問題 6，引擎語義，沒修；沙盒看實況後才定）：復原 op 帶 `deleted_at: null`，引擎的「編輯勝刪除」復活分支要求 op **沒有** `deleted_at`。
 * A 刪後撿回、離線期間 B 也刪同一列（B 的 HLC 較新）：B 收到 A 的撿回輸在 deleted_at 那格、仍是已刪；A 收到 B 的刪除被編輯勝刪除擋下、仍活著，兩台各留各的。
 * `restoreDeleted`、`nodes.restore`、`restoreAsLoose`、`rescue` 都走這條；toast 復原本來就有，這裡把窗口從 6 秒拉長到整個離線期間。
 *
 * 依賴由建構子帶進來（單例在 `lostFoundRepo.ts`，同 `depotRepo.ts`）：本檔不 import `./index`，node 測試載得起來。
 */
import { getDb, nowUtcIso } from "../lib/db";
import { todayKey } from "../lib/date";
import {
  CURRENT_COLUMNS,
  LOST_TABLES,
  RESCUE_TABLES,
  groupDeleted,
  lostWindowFloor,
  namesFromTables,
  planNodeRestore,
  planRescue,
  rescueOccurrenceIds,
  snapshotDiff,
  type ChangedItem,
  type CloudSnapshot,
  type LostItem,
  type LostNow,
  type LostParentInfo,
  type LostRow,
  type LostTables,
  type PlaceNode,
  type RescueWrite,
  type SnapshotDiff,
  type SnapshotItem,
} from "../domain/lostFound";
import type { CoverSummary } from "../domain/timetable";
import { bodyWithTag } from "../domain/tags";
import { shiftDayOf, withSkipped } from "../domain/ticketPlan";
import type { RepeatRow } from "../domain/ticket";
import type { NodePatch, NodeRepository } from "./nodeRepository";
import type { NoteRepository } from "./noteRepository";
import { noteBodyUpdate } from "./sqliteNoteRepository";
import { newWriteBatch, occurrenceId, runWriteBatch, type SyncTable } from "./syncRepository";
import type { TagRepository } from "./tagRepository";
import type { TicketRepository } from "./ticketRepository";
import type { TimetableRepository } from "./timetableRepository";
import type { WeekAimRepository } from "./weekAimRepository";

export interface LostRestoreResult {
  /** 車票的上層不在：放到臨時車票了（toast 講） */
  placedAsLoose?: boolean;
  /** 有值＝**還沒寫**：要先問「連同上層一起撿回嗎」，同意就帶 `withParent: true` 再叫一次 */
  needsParent?: LostParentInfo;
  /** 時間塊撿回切或蓋了幾塊 */
  cover?: CoverSummary;
  /** 快照撿回時它現在活著：目標沒寫（清單過期了），toast 講「已經在了」 */
  alreadyHere?: boolean;
  /** `alreadyHere` 的節點順手補回底下幾個不在的子節點 */
  filled?: number;
  /** 撿回定期帳：刪除期間的班次不補，toast 講一句 */
  noBackfill?: boolean;
}

/** 改回的收據：`undoRevert` 照它寫回 */
export interface RevertReceipt {
  table: "notes" | "nodes";
  id: string;
  /** 改回前的值（比對欄） */
  before: Record<string, string | null>;
  /** 改回後的值 */
  after: Record<string, string | null>;
}

export interface LostFoundRepository {
  /** 窗內的刪除，一刀一列、新到舊。窗口是顯示範圍，不刪東西 */
  list(now: LostNow): Promise<LostItem[]>;
  /** 時間塊撿回會切或蓋到幾塊（先講再撿）；不是時間塊回 null。快照撿回帶 snapshot */
  previewCover(item: Pick<LostItem, "table" | "id">, snapshot?: CloudSnapshot): Promise<CoverSummary | null>;
  /** 撿回一刀（§2.3、§2.4）。上層也刪了的非車票：回 `needsParent`、不寫；`withParent` 連上層那一刀一起 */
  restore(item: Pick<LostItem, "table" | "id" | "ids">, opts?: { withParent?: boolean }): Promise<LostRestoreResult>;
  /** 讀一份雲端快照（不碰資料庫）。快照比 App 新 ⇒ reject「請先更新」 */
  readSnapshot(key: string): Promise<CloudSnapshot>;
  /** 算這份快照與現況的差異 */
  diffSnapshot(snapshot: CloudSnapshot): Promise<SnapshotDiff>;
  /** 從快照撿回一筆（§3.3） */
  rescue(snapshot: CloudSnapshot, item: Pick<SnapshotItem, "table" | "id">, opts?: { withParent?: boolean }): Promise<LostRestoreResult>;
  /** 把現在還活著的筆記、日記、車票的比對欄改回快照那時（§3.5）；已刪 ⇒ RangeError */
  revertToSnapshot(item: Pick<ChangedItem, "table" | "id" | "fields">): Promise<RevertReceipt>;
  /** toast「復原」：寫回改回前的值 */
  undoRevert(receipt: RevertReceipt): Promise<void>;
}

/** 建構子帶進來的既有 repo：撿回走它們，語義（skipped_days、planCover…）才只有一份 */
export interface LostFoundDeps {
  nodes: Pick<NodeRepository, "restore" | "restoreAsLoose" | "update">;
  notes: Pick<NoteRepository, "restore">;
  tags: Pick<TagRepository, "restoreDeleted" | "writeBodyAndSyncTags">;
  timetable: Pick<TimetableRepository, "restore" | "restoreGoal" | "restoreRoutine" | "previewCover">;
  ticket: Pick<TicketRepository, "restoreEntry" | "pickUpRepeat" | "repeatPickUpCols" | "restoreWish" | "restoreTemplate" | "restoreBudget">;
  aims: Pick<WeekAimRepository, "restoreAim">;
  readSnapshot(key: string): Promise<CloudSnapshot>;
}

/**
 * 一次 execute 綁的參數上限。`composeBatch` 把整批重編成全域號，SQLite 的上限（32766）算在整批上；
 * 一個大路線撿回來（列數×欄數×同步語句）會超過，所以超過就切批。外鍵父先子後的順序不變，中途失敗＝已寫的列是完整的，再撿一次就補齊。
 */
const BATCH_PARAM_LIMIT = 20_000;

/** 整列寫入：INSERT … ON CONFLICT(id) DO UPDATE；欄＝值 ∩ 現行表欄（舊快照缺的欄吃表預設、已有的列保留現值） */
function upsertStatement(w: RescueWrite, tableCols: ReadonlySet<string>): { sql: string; args: unknown[] } {
  const names = Object.keys(w.row).filter((c) => c !== "id" && tableCols.has(c));
  const ph = names.map((_, i) => `$${i + 2}`).join(", ");
  const sets = names.map((c) => `${c} = excluded.${c}`).join(", ");
  return {
    sql: `INSERT INTO ${w.table} (id, ${names.join(", ")}) VALUES ($1, ${ph}) ON CONFLICT(id) DO UPDATE SET ${sets}`,
    args: [w.id, ...names.map((c) => (w.row[c] === undefined ? null : w.row[c]))],
  };
}

export class SqliteLostFoundRepository implements LostFoundRepository {
  private readonly deps: LostFoundDeps;

  constructor(deps: LostFoundDeps) {
    this.deps = deps;
  }

  async list(now: LostNow): Promise<LostItem[]> {
    const db = await getDb();
    const floor = new Date(lostWindowFloor(now)).toISOString();
    const [tables, nodes, timeCategories, tkCategories, tkCurrencies] = await Promise.all([
      Promise.all(LOST_TABLES.map((t) => db.select<LostRow[]>(`SELECT * FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at >= $1`, [floor]))),
      db.select<LostRow[]>(`SELECT id, name, kind, parent_id FROM nodes`),
      db.select<LostRow[]>(`SELECT id, name FROM time_categories`),
      db.select<LostRow[]>(`SELECT id, name FROM tk_categories`),
      db.select<LostRow[]>(`SELECT id, code, decimals, is_main FROM tk_currencies`),
    ]);
    const rows: LostTables = {};
    LOST_TABLES.forEach((t, i) => (rows[t] = tables[i]));
    const names = namesFromTables({ nodes, time_categories: timeCategories, tk_categories: tkCategories, tk_currencies: tkCurrencies });
    return groupDeleted(rows, now, names);
  }

  async previewCover(item: Pick<LostItem, "table" | "id">, snapshot?: CloudSnapshot): Promise<CoverSummary | null> {
    if (item.table !== "time_blocks") return null;
    const db = await getDb();
    const local = (await db.select<LostRow[]>(`SELECT id, started_at, ended_at, deleted_at FROM time_blocks WHERE id = $1`, [item.id]))[0];
    if (local && local.deleted_at === null) return null; // 活著的不會寫，沒有東西可蓋（問題 2）
    // 本機有 tombstone 就撿回它（問題 1），沒有才用快照那一列
    const row = local ?? snapshot?.tables.time_blocks?.find((b) => b.id === item.id);
    if (!row) return null;
    // 跟 restore 同一個區間：刪掉時還在運行的塊結束於刪除那一刻；快照那時還在運行的結束於快照那一刻
    const end = (row.ended_at as string | null) ?? (local ? (local.deleted_at as string | null) : (snapshot?.exported_at ?? null));
    return this.deps.timetable.previewCover(row.started_at as string, end, item.id);
  }

  async restore(item: Pick<LostItem, "table" | "id" | "ids">, opts?: { withParent?: boolean }): Promise<LostRestoreResult> {
    const { nodes, notes, tags, timetable, ticket, aims } = this.deps;
    switch (item.table) {
      case "nodes": {
        const db = await getDb();
        const all = await db.select<PlaceNode[]>(`SELECT id, kind, name, parent_id, line_id, route_id, deleted_at FROM nodes`);
        const plan = planNodeRestore(item, all, opts);
        if (plan.needsParent) return { needsParent: plan.needsParent };
        if (plan.loose) {
          await nodes.restoreAsLoose(item.id, plan.loose.routeId);
          return { placedAsLoose: true };
        }
        await nodes.restore(plan.ids);
        return {};
      }
      case "notes":
        await notes.restore([item.id]);
        return {};
      case "tags":
        await tags.restoreDeleted(item.ids);
        return {};
      case "time_blocks":
        return { cover: await timetable.restore(item.id) };
      case "time_goals":
        await timetable.restoreGoal(item.id);
        return {};
      case "time_routines":
        await timetable.restoreRoutine(item.id);
        return {};
      case "tk_entries":
        await ticket.restoreEntry(item.id);
        return {};
      case "tk_repeats":
        await ticket.pickUpRepeat(item.id, todayKey(0));
        return { noBackfill: true };
      case "tk_wishes":
        await ticket.restoreWish(item.id);
        return {};
      case "tk_templates":
        await ticket.restoreTemplate(item.id);
        return {};
      case "tk_budgets":
        await ticket.restoreBudget(item.ids);
        return {};
      case "week_aims":
        await aims.restoreAim(item.id);
        return {};
      default:
        throw new RangeError("不認得這種東西");
    }
  }

  readSnapshot(key: string): Promise<CloudSnapshot> {
    return this.deps.readSnapshot(key);
  }

  /**
   * 撿回與比對要用的現況（撿回是偶爾的手動動作，整表讀一次沒關係）：活著的列窄欄就夠；
   * tombstone 整列，撿回時要照它的內容復活、整列送 op（問題 1、8）。
   */
  private async readCurrent(): Promise<LostTables> {
    const db = await getDb();
    const rows = await Promise.all(
      RESCUE_TABLES.map(async (t) => {
        const [live, dead] = await Promise.all([
          db.select<LostRow[]>(`SELECT ${CURRENT_COLUMNS[t] ?? "id, deleted_at"} FROM ${t} WHERE deleted_at IS NULL`),
          db.select<LostRow[]>(`SELECT * FROM ${t} WHERE deleted_at IS NOT NULL`),
        ]);
        return [...live, ...dead];
      }),
    );
    const out: LostTables = {};
    RESCUE_TABLES.forEach((t, i) => (out[t] = rows[i]));
    return out;
  }

  async diffSnapshot(snapshot: CloudSnapshot): Promise<SnapshotDiff> {
    return snapshotDiff(snapshot, await this.readCurrent());
  }

  async rescue(snapshot: CloudSnapshot, item: Pick<SnapshotItem, "table" | "id">, opts?: { withParent?: boolean }): Promise<LostRestoreResult> {
    const db = await getDb();
    const now = nowUtcIso();
    const plan = planRescue(snapshot, item, await this.readCurrent(), now, await rescueOccurrenceIds(snapshot, occurrenceId), opts);
    if (plan.needsParent) return { needsParent: plan.needsParent };
    if (plan.alreadyHere && !plan.writes.length) return { alreadyHere: true };

    // 定期帳：不管內容來自本機 tombstone 或快照，都照暫停恢復的前例重設 next_on、把帳活著的班從 skipped_days 拿掉（問題 3、4）
    let noBackfill = false;
    for (const w of plan.writes) {
      if (w.table !== "tk_repeats") continue;
      const cols = await this.deps.ticket.repeatPickUpCols(w.row as unknown as RepeatRow, todayKey(0));
      Object.assign(w.row, cols);
      Object.assign(w.op, cols);
      noBackfill = true;
    }

    const tables = Array.from(new Set(plan.writes.map((w) => w.table)));
    const colRows = await Promise.all(tables.map((t) => db.select<{ name: string }[]>(`SELECT name FROM pragma_table_info('${t}')`)));
    const colsOf = new Map(tables.map((t, i) => [t, new Set(colRows[i].map((c) => c.name))] as const));

    let b = newWriteBatch();
    let params = 0;
    /** 同步語句的參數：outbox 5＋cells 3＋每欄 1 */
    const stage = async (stmt: { sql: string; args: unknown[] }, op: { tbl: SyncTable; row_id: string; op: "upsert" | "delete"; cols: Record<string, unknown> }) => {
      const cost = stmt.args.length + 8 + Object.keys(op.cols).length;
      if (params + cost > BATCH_PARAM_LIMIT && b.stmts.length) {
        await runWriteBatch(db, b.stmts, b.ops);
        b = newWriteBatch();
        params = 0;
      }
      b.stmts.push(stmt);
      b.ops.push(op);
      params += cost;
    };

    for (const w of plan.writes) {
      await stage(upsertStatement(w, colsOf.get(w.table) ?? new Set()), { tbl: w.table as SyncTable, row_id: w.id, op: w.opType, cols: w.op });
    }

    // 荷札撿回：活著的筆記內文補回 #名稱（§2.4）
    const bodies = new Map<string, { before: string; after: string }>();
    for (const t of plan.tagBodies) {
      let cur = bodies.get(t.noteId);
      if (!cur) {
        const rows = await db.select<{ body: string }[]>(`SELECT body FROM notes WHERE id = $1 AND deleted_at IS NULL`, [t.noteId]);
        if (!rows[0]) continue;
        cur = { before: rows[0].body, after: rows[0].body };
        bodies.set(t.noteId, cur);
      }
      cur.after = bodyWithTag(cur.after, t.key, t.name);
    }
    for (const [id, x] of bodies) {
      if (x.after === x.before) continue;
      const { stmt, op } = noteBodyUpdate(id, x.after, now);
      await stage(stmt, op);
    }

    // 帳：同 restoreEntry，規則活著才把那一班從 skipped_days 拿掉；規則是 tombstone 不碰（會在併發刪時復活規則，沙盒 F-2），撿回規則時才拿掉
    const skipped = new Map<string, RepeatRow>();
    for (const e of plan.entries) {
      const rid = e.repeat_id as string;
      let r = skipped.get(rid);
      if (!r) {
        r = (await db.select<RepeatRow[]>(`SELECT * FROM tk_repeats WHERE id = $1 AND deleted_at IS NULL`, [rid]))[0];
        if (!r) continue;
        skipped.set(rid, r);
      }
      const day = shiftDayOf(r, { id: e.id, occurred_on: e.occurred_on as string }, todayKey(0));
      if (day === null) continue;
      const next = withSkipped(r.skipped_days, day, false);
      if (next === r.skipped_days) continue;
      r.skipped_days = next;
      await stage(
        { sql: `UPDATE tk_repeats SET skipped_days = $1, updated_at = $2 WHERE id = $3`, args: [next, now, rid] },
        { tbl: "tk_repeats", row_id: rid, op: "upsert", cols: { skipped_days: next, updated_at: now } },
      );
    }

    await runWriteBatch(db, b.stmts, b.ops);

    // 時間塊：上面寫成 tombstone，這裡走 restore 跑 planCover（跟最近刪除同一支）。這一步失敗＝列在最近刪除裡，再撿一次就好
    if (plan.restoreBlockId) return { cover: await this.deps.timetable.restore(plan.restoreBlockId) };
    if (plan.alreadyHere) return { alreadyHere: true, filled: plan.writes.filter((w) => w.table === "nodes").length };
    return { ...(plan.placedAsLoose ? { placedAsLoose: true } : {}), ...(noBackfill ? { noBackfill: true } : {}) };
  }

  /** 改回與復原共用：只寫這幾欄。筆記內文＋掛載一個交易（問題 11），車票走 nodes.update（同側板改名） */
  private async writeCompared(table: "notes" | "nodes", id: string, vals: Record<string, string | null>): Promise<Record<string, string | null>> {
    const db = await getDb();
    const names = Object.keys(vals).filter((c) => c === "body" || c === "name" || c === "description");
    if (!names.length) return {};
    const cur = (await db.select<LostRow[]>(`SELECT ${names.join(", ")}, deleted_at FROM ${table} WHERE id = $1`, [id]))[0];
    if (!cur || cur.deleted_at !== null) throw new RangeError("這一筆已經刪除了");
    const before: Record<string, string | null> = {};
    for (const c of names) before[c] = (cur[c] as string | null) ?? null;
    if (table === "notes") {
      await this.deps.tags.writeBodyAndSyncTags(id, before.body ?? "", vals.body ?? "");
    } else {
      await this.deps.nodes.update(id, vals as NodePatch);
    }
    return before;
  }

  async revertToSnapshot(item: Pick<ChangedItem, "table" | "id" | "fields">): Promise<RevertReceipt> {
    const after: Record<string, string | null> = {};
    for (const f of item.fields) after[f.col] = f.snapshot;
    const before = await this.writeCompared(item.table, item.id, after);
    return { table: item.table, id: item.id, before, after };
  }

  async undoRevert(receipt: RevertReceipt): Promise<void> {
    await this.writeCompared(receipt.table, receipt.id, receipt.before);
  }
}
