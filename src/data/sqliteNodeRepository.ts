/**
 * SqliteNodeRepository——NodeRepository 的 SQLite 實作（tauri-plugin-sql）。
 * 子樹操作（搬移／soft delete／連帶完成）用 SQLite 遞迴 CTE。
 *
 * v1.1.1（同步地基・WP5）改法——為什麼：
 *   ① **每個公開 mutation 一個交易**。以前是逐句 `db.execute`，一次手勢動 3–4 張表卻沒有原子性
 *      （寫入路徑盤點 §3(c)(d)）；同步一旦上線，「資料寫了、oplog 沒寫」就是兩台永久分歧。
 *      作法：私有 helper 不再自己 execute，改把語句與 op 累加進 `WriteBatch`，
 *      公開方法收尾 `runWriteBatch(db, b.stmts, b.ops)` 一次落（契約 §2.6）。
 *   ② **哪些變更算「主人資料」**（D-1.1-3／契約 §2.2、§2.7）：進 outbox 的只有主人真的改的欄。
 *      不進 outbox 的三類——快取（`line_id`、非根票的 `route_id`）、推導（定期券的 `scheduled_on`）、
 *      呈現序（今日 lazy 補位），因為每台裝置都算得出同樣的結果，同步它們只會互相推送推導物。
 *   ③ **position 位移補戳 `updated_at`**（#1／#10）：以前位移別人的列不戳時刻，LWW 之下鄰居的位移
 *      會被當成「沒變」，兩台的兄弟順序從此不一致（盲探 U1）。
 *   ④ **今日 lazy 補位改純推導不落庫**（#20）：以前光是打開今日頁就會寫 `today_position`＋戳
 *      `updated_at`，那是憑空冒出的「變更」，會是 oplog 最吵的噪音源（盲探 U2）。
 *   ⑤ **`occurrences.id` 改確定性 uuid v5**（#24／#25）：兩台對同一班次算出同一個 id，
 *      合併時才有「同一列」可談；同班被 soft delete 過就以 `ON CONFLICT(id)` 復活同一列。
 *   ⑥ **兄弟順序改排序鍵 `sort_key`**（回饋乙，migration 0014；結 #108／#119）：搬一列只寫那一列的鍵（算在新鄰居之間），
 *      不再位移兄弟的 position（③ 的位移從此不發生）；「兄弟」＝畫面上的同一份清單（domain/nodeOrder.ts 的顯示群組）。
 *
 * 同步總開關關著時（`sync_meta.enabled` ≠ '1'）：同步語句是 `INSERT … WHERE EXISTS(...)`，一列都不寫，
 * 行為與 v1.1.0 逐點對等——唯一的形狀差別是外面多包了一層 `BEGIN IMMEDIATE … COMMIT`。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { dayWindow, parseDayStartHour, todayKey } from "../lib/date";
import { escapeLike } from "../lib/sql";
import type { FullSearchHit } from "../domain/fullSearch";
import type { TaskRow } from "../domain/taskFilter";
import { inDepotSql, type ArrivalWrite } from "../domain/depot";
import {
  SIBLING_ORDER_SQL,
  compareCreated,
  compareSiblings,
  groupFor,
  isOrderedGroup,
  sameGroup,
  type SiblingGroup,
  type SlotAnchor,
} from "../domain/nodeOrder";
import { STARTER_LINES } from "../domain/starterLines";
import { keysForSlot, planSortKeyBackfill, slotFromAnchor, type BackfillRow, type KeyWrite } from "../domain/nodeSortKey";
import {
  TIME_REPEAT_ONLY_MSG,
  assertClockWritable,
  hasRepeatRule,
  manualOrderIds,
  overrideId,
  parseTimeOverrides,
  type TimeOverrideRow,
} from "../domain/scheduledTime";
import {
  KIND_LABEL,
  allowedChildKinds,
  childKindSwaps,
  currentDue,
  daysBetween,
  keptMoves,
  parseRule,
  runMoveBlock,
  sameSchedule,
  serializeRule,
  withMoves,
  withRunMoved,
  type NodeKind,
  type NodeRow,
  type NodeStatus,
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
  MoveManyItem,
  NodePatch,
  NodeRepository,
  RescheduleOpts,
  RescheduleResult,
  RouteProgress,
  RouteProgressSeed,
  RouteMemberRow,
  TaskHolderRow,
  ScheduleBounds,
  ScheduleEntry,
  SidebarData,
  TodayRow,
} from "./nodeRepository";
import {
  attachTimeOverrides,
  backfillAtOf,
  buildCalendar,
  buildRouteProgress,
  buildSchedule,
  buildScheduleBounds,
  buildSerialMap,
  compareTodayRows,
  pickTodayOccurrence,
  reorderIds,
  resolveSkipDate,
  retiredScheduledOn,
  retiredWasDueToday,
  toCurrentOccurrence,
  todayBucketOf,
  endedCompletedAt,
  endedKidsToReopen,
  planRunReset,
  planRunRestore,
  runEnded,
  NESTED_REPEAT_MSG,
  REPEATABLE_KINDS,
  REPEAT_ONLY_MSG,
  REPEAT_RESCHEDULE_MSG,
  type RunKid,
  SERIAL_KINDS_SQL,
  type SerialSeed,
} from "./nodeRepository";
import {
  newWriteBatch,
  occurrenceId,
  runWriteBatch,
  type SyncTable,
  type WriteBatch,
} from "./syncRepository";

const ALIVE = "deleted_at IS NULL";

/**
 * 逐班時刻覆寫的同步表（D-主-120；migration 0012）。
 * 型別斷言是過渡：表名登記進 `syncTables.ts` 的 CORE_SYNC_TABLES 之後 SyncTable 就認得它，這個 `as` 可以拿掉。
 */
const NTO = "node_time_overrides" satisfies SyncTable;

/** 存量搬移（舊欄 JSON → 覆寫列）做過了沒；settings 的本地鍵（不在同步白名單，各台各記各的） */

/**
 * 守門用的「今天」（逐班覆寫的讀取面；影響併發復活的未來非班次日覆寫）：讀取面（listSidebar／listRouteTree／getNode／
 * search／searchFull／listInboxTickets）沒有呼叫端帶營業日，就讀設定表的日界線（＝uiStore.dayStartHour 的同一個值、同步白名單鍵）。
 * 收官磨光 A4（體檢 S2）：原本寫死 `todayKey(3)`，跟 App 預設 06:00 在 03–06 點這段差一天。
 */
async function guardToday(db: Database): Promise<string> {
  const rows = await db.select<{ value: string }[]>(`SELECT value FROM settings WHERE key = 'day_start_hour'`);
  return todayKey(parseDayStartHour(rows[0]?.value));
}

// repeat_rule 不在這裡：寫規則的唯一入口是 setRepeatRule（update 收到會改道，M3 ④）
const PATCHABLE = new Set<string>([
  "name", "description", "color", "code", "status", "scheduled_on", "due_on", "priority",
  "estimate_min", "progress", "time_spent_min", "mood", "expected_on", "arrived_on",
  "carried_from", "route_id", "scheduled_time", "today_position", "station_id",
]);


function placeholders(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(",");
}

/** 往批次裡加一筆 op（＝sync_outbox 一列＋每個 col 一筆 sync_cells 戳記） */
function addOp(
  b: WriteBatch,
  tbl: SyncTable,
  rowId: string,
  op: "upsert" | "delete",
  cols: Record<string, unknown>,
): void {
  b.ops.push({ tbl, row_id: rowId, op, cols });
}

async function subtreeIds(db: Database, rootId: string): Promise<string[]> {
  const rows = await db.select<{ id: string }[]>(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM nodes WHERE id = $1
       UNION ALL
       SELECT n.id FROM nodes n JOIN sub s ON n.parent_id = s.id WHERE n.deleted_at IS NULL
     ) SELECT id FROM sub`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

/** 讀顯示群組要用到的欄位 */
type GroupRow = { id: string; sort_key: string | null; position: number; created_at: string };

/** 顯示群組（domain/nodeOrder.ts）的 SQL 條件；與 `inGroup` 逐條同義 */
function groupWhere(g: SiblingGroup): { where: string; args: unknown[] } {
  switch (g.type) {
    case "routeTop":
      // 與 listRouteTree＋indexTree 放進 roots 的那兩種一致：路線直屬的非車站＋掛這條路線標籤的根層臨時車票
      return {
        where: `((parent_id = $1 AND kind != 'station') OR (parent_id IS NULL AND kind = 'ticket' AND route_id = $1))`,
        args: [g.routeId],
      };
    case "stations":
      return { where: `parent_id = $1 AND kind = 'station'`, args: [g.routeId] };
    case "root":
      return { where: `parent_id IS NULL AND kind = $1`, args: [g.kind] };
    case "inbox":
      return { where: `parent_id IS NULL AND kind = 'ticket' AND route_id IS NULL`, args: [] };
    case "children":
      return { where: `parent_id = $1`, args: [g.parentId] };
  }
}

/** 回填一批最多幾列（每列 UPDATE＋outbox＋cells 約 11 個參數；分批免得一句 SQL 綁太多參數。回填冪等，分批落也算出同一串鍵） */
const BACKFILL_CHUNK = 200;

/** 一次搬移算好的東西（驗證過、還沒寫） */
interface PlannedMove {
  node: NodeRow;
  newParent: NodeRow | null;
  kind: NodeKind;
  sub: string[];
  lineId: string | null;
  routeId: string | null;
  group: SiblingGroup;
}

export class SqliteNodeRepository implements NodeRepository {
  async listSidebar(): Promise<SidebarData> {
    const db = await getDb();
    const rows = await this.withOverrides(
      db,
      await db.select<NodeRow[]>(
        `SELECT * FROM nodes WHERE kind IN ('line','route','station') AND ${ALIVE}
       ORDER BY ${SIBLING_ORDER_SQL}`,
      ),
    );
    return {
      lines: rows.filter((r) => r.kind === "line"),
      routes: rows.filter((r) => r.kind === "route"),
      stations: rows.filter((r) => r.kind === "station"),
    };
  }

  /** 丁 D-主-241：路線一覽用的最小形狀（同 listRouteTree 的範圍，只是全部路線一次、只帶四欄；不需要逐班覆寫） */
  async listRouteMembers(): Promise<RouteMemberRow[]> {
    const db = await getDb();
    return db.select<RouteMemberRow[]>(
      `SELECT id, kind, status, route_id FROM nodes WHERE route_id IS NOT NULL AND kind != 'station' AND ${ALIVE}`,
    );
  }

  async listTasks(): Promise<TaskRow[]> {
    const db = await getDb();
    const rows = await db.select<(NodeRow & { has_kids: number })[]>(
      `SELECT n.*, EXISTS (SELECT 1 FROM nodes k WHERE k.parent_id = n.id AND k.deleted_at IS NULL) AS has_kids
         FROM nodes n WHERE kind IN ('ticket', 'train', 'car') AND ${ALIVE}
         ORDER BY ${SIBLING_ORDER_SQL}`,
    );
    return this.withOverrides(
      db,
      rows.map((r): TaskRow => ({ ...r, has_kids: !!r.has_kids })),
    );
  }

  async listTaskHolders(): Promise<TaskHolderRow[]> {
    const db = await getDb();
    return db.select<TaskHolderRow[]>(`SELECT id, name, parent_id FROM nodes WHERE kind IN ('branch', 'train', 'car') AND ${ALIVE}`);
  }

  async listRouteTree(routeId: string): Promise<NodeRow[]> {
    const db = await getDb();
    return this.withOverrides(
      db,
      await db.select<NodeRow[]>(
        `SELECT * FROM nodes WHERE route_id = $1 AND kind != 'station' AND ${ALIVE}
       ORDER BY ${SIBLING_ORDER_SQL}`,
        [routeId],
      ),
    );
  }

  async listSerials(): Promise<Record<string, string>> {
    const db = await getDb();
    // 排序／分日都交給 buildSerialMap（本地日界要用 JS 的時區，SQL 的 localtime 靠不住），
    // 這裡只負責把「存活的會發券節點」撈出來——跨父節點、跨路線、跨發券 kind 一次算完。
    // kind 條件與記憶體版同源（SERIAL_KINDS_SQL ← SERIAL_KINDS）；buildSerialMap 內還會再濾一次。
    const rows = await db.select<SerialSeed[]>(
      `SELECT id, kind, created_at, position FROM nodes WHERE ${ALIVE} AND kind IN (${SERIAL_KINDS_SQL})`,
    );
    return buildSerialMap(rows);
  }

  async getNode(id: string): Promise<NodeRow | null> {
    const db = await getDb();
    const rows = await db.select<NodeRow[]>(`SELECT * FROM nodes WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    return (await this.withOverrides(db, rows))[0];
  }

  async getTimeOverrideRef(id: string): Promise<{ nodeId: string; dueOn: string } | null> {
    const db = await getDb();
    // 含已軟刪的列（同步通知的對象常是被刪那一班）
    const rows = await db.select<{ node_id: string; due_on: string }[]>(
      `SELECT node_id, due_on FROM node_time_overrides WHERE id = $1`,
      [id],
    );
    return rows[0] ? { nodeId: rows[0].node_id, dueOn: rows[0].due_on } : null;
  }

  // ───────────── 逐班時刻覆寫的列（D-主-120）─────────────

  /** 存量搬移只跑一次（同一個 repository 實例內記住那個 Promise；失敗就放掉，下一次讀取再試） */
  private overrideBackfill: Promise<void> | null = null;

  /**
   * 讀覆寫列（存活的）。一張就照 node_id 查（getNode 呼叫最頻繁）；多張就整表撈——
   * 表很小（只有親手改過時刻的那幾班才有列），比組一長串 IN 划算。
   */
  private async overrideRows(db: Database, nodes: readonly { id: string }[]): Promise<TimeOverrideRow[]> {
    await this.ensureOverrideBackfill(db);
    await this.ensureSortKeyBackfill(db);
    if (!nodes.length) return [];
    if (nodes.length === 1) {
      return db.select<TimeOverrideRow[]>(
        `SELECT node_id, due_on, hhmm FROM node_time_overrides WHERE node_id = $1 AND ${ALIVE}`,
        [nodes[0].id],
      );
    }
    return db.select<TimeOverrideRow[]>(`SELECT node_id, due_on, hhmm FROM node_time_overrides WHERE ${ALIVE}`);
  }

  /** 讀取面保形：把覆寫列摺回 NodeRow.time_overrides（舊欄的值一律蓋掉，見 attachTimeOverrides） */
  private async withOverrides<T extends NodeRow>(db: Database, nodes: T[], today?: string): Promise<T[]> {
    const rows = await this.overrideRows(db, nodes);
    // 守門日只在有覆寫列時才用得到（attachTimeOverrides 對沒列的節點不看它）——沒列就不多查一趟設定
    return attachTimeOverrides(nodes, rows, rows.length ? (today ?? (await guardToday(db))) : "");
  }

  /**
   * 軟刪一張票的覆寫列（班次日 ≥ from；沒給＝全部）：語句與 op 進呼叫端的批次。
   * 只動這台看得到的存活列——另一台併發新設的列不在這裡，讀取守門（overrideKeepOf）負責收尾。
   */
  private async dropOverrides(db: Database, b: WriteBatch, nodeId: string, from?: string, settled: readonly string[] = []): Promise<void> {
    await this.ensureOverrideBackfill(db);
    const found = await db.select<{ id: string; due_on: string }[]>(
      from === undefined
        ? `SELECT id, due_on FROM node_time_overrides WHERE node_id = $1 AND ${ALIVE}`
        : `SELECT id, due_on FROM node_time_overrides WHERE node_id = $1 AND due_on >= $2 AND ${ALIVE}`,
      from === undefined ? [nodeId] : [nodeId, from],
    );
    // settled＝已經有結局的班次日：那班交代過了，時刻是歷史（D-主-296）
    const rows = found.filter((r) => !settled.includes(r.due_on));
    if (!rows.length) return;
    const now = nowUtcIso();
    b.stmts.push({
      sql: `UPDATE node_time_overrides SET deleted_at = $1, updated_at = $1 WHERE id IN (${placeholders(rows.length, 2)})`,
      args: [now, ...rows.map((r) => r.id)],
    });
    for (const r of rows) addOp(b, NTO, r.id, "delete", { deleted_at: now, updated_at: now });
  }

  private ensureOverrideBackfill(db: Database): Promise<void> {
    this.overrideBackfill ??= this.backfillOverrides(db).catch((e: unknown) => {
      // 搬不動不擋讀取（畫面只是暫時看不到舊覆寫）；放掉 Promise，下一次讀取再試
      this.overrideBackfill = null;
      console.warn("[nodes] 逐班時刻存量搬移失敗，下次再試", e);
    });
    return this.overrideBackfill;
  }

  /**
   * 存量搬移（D-主-120）：把舊欄 `nodes.time_overrides` 的 JSON 展開成覆寫列，經正常 op 路徑入列，一台只做一次。
   *
   * 為什麼不在 migration 做：id 是 uuid v5（SQLite 算不了），而且得經 runWriteBatch 才有 outbox 與格子戳記——
   * 對面那台要靠這些 op 才收得到。兩台各自搬：同一班算出同一個 id、同一個值，LWW 收斂到同一列，值相同不觸發競合通知。
   * 已經有列的班（對面先搬過、或這班後來在新版改過／清過）不碰：那一列比舊欄新，拿舊欄蓋回去會把後來的修改吃掉。
   * 只搬有規則的票——沒規則的票覆寫本來就沒人讀（B1），搬過去只是多一批要清的殘留。
   *
   * 不設持久旗標：旗標存 settings 會在「改用另一台的資料」「還原 0012 以前的快照」後留著 1、擋住重搬，
   * 舊欄的覆寫就看不到了。`have` 集合本來就讓這支冪等，每個啟動掃一遍的代價只是一個 SELECT（定期券量小），
   * 掃到零缺列就什麼都不寫。
   */
  private async backfillOverrides(db: Database): Promise<void> {
    const legacy = await db.select<Pick<NodeRow, "id" | "repeat_rule" | "time_overrides">[]>(
      `SELECT id, repeat_rule, time_overrides FROM nodes
       WHERE ${ALIVE} AND repeat_rule IS NOT NULL AND time_overrides IS NOT NULL AND time_overrides != ''`,
    );
    const have = new Set(
      (await db.select<{ id: string }[]>(`SELECT id FROM node_time_overrides`)).map((r) => r.id),
    );
    const now = nowUtcIso();
    const b = newWriteBatch();
    for (const n of legacy) {
      if (!hasRepeatRule(n.repeat_rule)) continue;
      for (const [dueOn, hhmm] of Object.entries(parseTimeOverrides(n.time_overrides))) {
        const oid = await overrideId(n.id, dueOn);
        if (have.has(oid)) continue;
        b.stmts.push({
          sql: `INSERT INTO node_time_overrides (id, node_id, due_on, hhmm, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT(id) DO NOTHING`,
          args: [oid, n.id, dueOn, hhmm, now],
        });
        addOp(b, NTO, oid, "upsert", {
          node_id: n.id,
          due_on: dueOn,
          hhmm,
          deleted_at: null,
          created_at: now,
          updated_at: now,
        });
      }
    }
    if (!b.stmts.length) return; // 零缺列＝這台已搬齊，不開寫入交易
    await runWriteBatch(db, b.stmts, b.ops);
  }

  // ───────────── 排序鍵（回饋乙，migration 0014）─────────────

  /** 排序鍵存量回填只跑一次（同 overrideBackfill：記住 Promise；失敗就放掉，下一次讀取再試） */
  private sortKeyBackfill: Promise<void> | null = null;

  private ensureSortKeyBackfill(db: Database): Promise<void> {
    this.sortKeyBackfill ??= this.backfillSortKeys(db).catch((e: unknown) => {
      // 補不動不擋讀取：沒鍵的列照 position→created_at→id 排在有鍵的後面，畫面順序跟舊版一樣
      this.sortKeyBackfill = null;
      console.warn("[nodes] 排序鍵回填失敗，下次再試", e);
    });
    return this.sortKeyBackfill;
  }

  /**
   * 排序鍵存量回填（契約 §6）：每個顯示群組裡 sort_key 為 NULL 的列，照目前的顯示序接在該群組最後一個合法鍵後面
   * （planSortKeyBackfill；收件匣不排序、不給鍵）。對象＝0014 之前的列、還沒更新的那台推來的新列。
   *
   * 同 backfillOverrides：不設持久旗標、每次啟動掃一遍（先用一句 LIMIT 1 問「有沒有缺鍵的」，沒有就什麼都不讀）；
   * 經 runWriteBatch 進 outbox——兩台各自補，輸入一樣就算出一樣的鍵，值相同對面套用時不算撞。
   * **不戳 `updated_at`**：補鍵不是主人的修改；戳了會讓這列沒同步過的格子（補戳從 updated_at 派生，engine `stamp_missing_cells`）
   * 全變成「現在」，合併時贏過另一台更早但真的改過內容的編輯（同 move 不戳快取列的 S-8 理由）。
   * `AND sort_key IS NULL` 守住「這段時間裡剛被搬過、已經有鍵」的列不被蓋掉。
   */
  private async backfillSortKeys(db: Database): Promise<void> {
    const need = await db.select<{ x: number }[]>(
      `SELECT 1 AS x FROM nodes WHERE ${ALIVE} AND sort_key IS NULL
       AND NOT (parent_id IS NULL AND kind = 'ticket' AND route_id IS NULL) LIMIT 1`,
    );
    if (!need.length) return;
    const rows = await db.select<BackfillRow[]>(
      `SELECT id, kind, parent_id, route_id, sort_key, position, created_at FROM nodes WHERE ${ALIVE}`,
    );
    const kinds = new Map(rows.map((r) => [r.id, r.kind]));
    const writes = planSortKeyBackfill(rows, (id) => kinds.get(id) ?? null);
    for (let i = 0; i < writes.length; i += BACKFILL_CHUNK) {
      const b = newWriteBatch();
      for (const w of writes.slice(i, i + BACKFILL_CHUNK)) {
        b.stmts.push({ sql: `UPDATE nodes SET sort_key = $1 WHERE id = $2 AND sort_key IS NULL`, args: [w.key, w.id] });
        addOp(b, "nodes", w.id, "upsert", { sort_key: w.key });
      }
      await runWriteBatch(db, b.stmts, b.ops);
    }
  }

  /** 顯示群組的目前順序（compareSiblings；收件匣照 created_at） */
  private async groupOrder(db: Database, g: SiblingGroup): Promise<GroupRow[]> {
    const { where, args } = groupWhere(g);
    const rows = await db.select<GroupRow[]>(
      `SELECT id, sort_key, position, created_at FROM nodes WHERE ${where} AND ${ALIVE}`,
      args,
    );
    return rows.sort(isOrderedGroup(g) ? compareSiblings : compareCreated);
  }

  /** 這一列現在屬於哪個顯示群組 */
  private async groupOfNode(node: NodeRow): Promise<SiblingGroup> {
    const parent = node.parent_id ? await this.getNode(node.parent_id) : null;
    return groupFor({ parentId: node.parent_id, parentKind: parent?.kind ?? null, kind: node.kind, routeId: node.route_id });
  }

  /** 擋路的鄰居重新給鍵（keysForSlot 回的其他列）：主人資料，戳 updated_at、逐列記 op（同以前的 position 位移 #1／#10） */
  private stageKeyWrites(b: WriteBatch, writes: readonly KeyWrite[], now: string): void {
    for (const w of writes) {
      b.stmts.push({ sql: `UPDATE nodes SET sort_key = $1, updated_at = $2 WHERE id = $3`, args: [w.key, now, w.id] });
      addOp(b, "nodes", w.id, "upsert", { sort_key: w.key, updated_at: now });
    }
  }

  async listSiblingIds(id: string): Promise<string[]> {
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node || node.deleted_at) return [];
    return (await this.groupOrder(db, await this.groupOfNode(node))).map((r) => r.id);
  }

  async countAllNodes(): Promise<number> {
    const db = await getDb();
    const rows = await db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM nodes`);
    return rows[0]?.n ?? 0;
  }

  async ensureStarterLines(): Promise<boolean> {
    if ((await this.countAllNodes()) > 0) return false;
    const db = await getDb();
    const now = nowUtcIso();
    const b = newWriteBatch();
    const keys = keysForSlot([], STARTER_LINES.map((l) => l.id), 0);
    STARTER_LINES.forEach((l, position) => {
      const sortKey = keys[position].key;
      b.stmts.push({
        sql: `INSERT INTO nodes (id, kind, name, position, sort_key, created_at, updated_at)
         VALUES ($1, 'line', $2, $3, $4, $5, $5) ON CONFLICT(id) DO NOTHING`,
        args: [l.id, l.name, position, sortKey, now],
      });
      addOp(b, "nodes", l.id, "upsert", {
        kind: "line",
        parent_id: null,
        name: l.name,
        description: null,
        position,
        sort_key: sortKey,
        color: null,
        code: null,
        scheduled_on: null,
        created_at: now,
        updated_at: now,
      });
    });
    await runWriteBatch(db, b.stmts, b.ops);
    return true;
  }

  async create(input: CreateNodeInput): Promise<NodeRow> {
    const db = await getDb();
    const name = input.name.trim();
    if (!name) throw new Error("名稱不能空白");
    // 建票列（回饋甲）：時刻驗格式＋範圍，同 update 那句（不拿預設日界線當範圍）
    assertClockWritable(input.scheduledTime ?? null, input.dayStartHour);
    const priority = input.priority ?? "mid";
    const estimateMin = input.estimateMin == null ? null : Math.max(0, Math.round(input.estimateMin));

    const parent = input.parentId ? await this.getNode(input.parentId) : null;
    if (input.parentId && !parent) throw new Error("父節點不存在");
    const allowed = allowedChildKinds(parent ? parent.kind : null);
    if (!allowed.includes(input.kind)) {
      throw new Error(`${input.kind} 不能掛在 ${parent?.kind ?? "根層"} 底下`);
    }

    // line_id／route_id 快取
    let lineId: string | null = null;
    let routeId: string | null = null;
    if (parent) {
      lineId = parent.kind === "line" ? parent.id : parent.line_id;
      routeId = parent.kind === "route" ? parent.id : parent.route_id;
    } else if (input.kind === "ticket" && input.routeTagId) {
      const tag = await this.getNode(input.routeTagId);
      routeId = tag?.id ?? null;
      lineId = tag?.line_id ?? null;
    }

    const id = uuid();
    const now = nowUtcIso();
    const b = newWriteBatch();
    const after = input.afterId ? await this.getNode(input.afterId) : null;
    if (input.afterId && !after) throw new Error("afterId 不存在");

    // 排序鍵（回饋乙）：顯示群組裡 afterId 的下一格；沒給 afterId（或它不在這份清單）＝尾端。
    // 平常只寫新的這一列；只有擋路的同鍵／沒鍵鄰居才一起重新給鍵（keysForSlot）——不再位移兄弟。收件匣不排序＝不給鍵
    const group = groupFor({ parentId: parent?.id ?? null, parentKind: parent?.kind ?? null, kind: input.kind, routeId });
    let sortKey: string | null = null;
    if (isOrderedGroup(group)) {
      const order = await this.groupOrder(db, group);
      const at = after ? order.findIndex((r) => r.id === after.id) : -1;
      const writes = keysForSlot(
        order.map((r) => ({ id: r.id, key: r.sort_key })),
        [id],
        at >= 0 ? at + 1 : order.length,
      );
      sortKey = writes.find((w) => w.id === id)?.key ?? null;
      this.stageKeyWrites(b, writes.filter((w) => w.id !== id), now);
    }
    // position 只在新建時給 MAX+1（舊的兄弟條件：同父；根層以 kind 分區），往後不再改——票號同毫秒建立時用它分先後
    const sibWhere = parent ? `parent_id = $1` : `parent_id IS NULL AND kind = $1`;
    const sibArg = parent ? parent.id : input.kind;
    const maxPos = await db.select<{ m: number | null }[]>(
      `SELECT MAX(position) AS m FROM nodes WHERE ${sibWhere} AND ${ALIVE}`,
      [sibArg],
    );
    const position = (maxPos[0]?.m ?? -1) + 1;

    b.stmts.push({
      sql: `INSERT INTO nodes
         (id, kind, parent_id, line_id, route_id, name, description, position, sort_key, color, code, scheduled_on,
          due_on, priority, scheduled_time, estimate_min, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      args: [
        id, input.kind, parent?.id ?? null, lineId, routeId, name,
        input.description ?? null, position, sortKey, input.color ?? null, input.code ?? null,
        input.scheduledOn ?? null, input.dueOn ?? null, priority, input.scheduledTime ?? null, estimateMin, now, now,
      ],
    });
    const cols: Record<string, unknown> = {
      kind: input.kind,
      parent_id: parent?.id ?? null,
      name,
      description: input.description ?? null,
      position,
      sort_key: sortKey,
      color: input.color ?? null,
      code: input.code ?? null,
      scheduled_on: input.scheduledOn ?? null,
      created_at: now,
      updated_at: now,
    };
    // 建票列一次設好的欄位：有值才進 op（沒給＝欄位預設，跟以前的 op 長相一樣）
    if (input.dueOn) cols.due_on = input.dueOn;
    if (input.priority) cols.priority = priority;
    if (input.scheduledTime) cols.scheduled_time = input.scheduledTime;
    if (estimateMin !== null) cols.estimate_min = estimateMin;
    // line_id 永遠是快取；route_id 只有「根層臨時車票的路線標籤」是主人資料，其餘是快取（契約 §2.2）
    if (!parent && input.kind === "ticket" && routeId) cols.route_id = routeId;
    addOp(b, "nodes", id, "upsert", cols);
    // 発券（D-③-5 乙）：建票即記一枚系統事件，時刻＝建立時刻
    this.writeEvent(b, id, "issued", now);
    await runWriteBatch(db, b.stmts, b.ops);

    const row = await this.getNode(id);
    if (!row) throw new Error("建立節點失敗");
    return row;
  }

  async update(id: string, patch: NodePatch, opts?: { dateKey?: string; dayStartHour?: number }): Promise<void> {
    // 主線②：時刻驗格式＋範圍，且不拿 `?? 3` 的預設當範圍（與記憶體版同一句）
    if ("scheduled_time" in patch) assertClockWritable(patch.scheduled_time ?? null, opts?.dayStartHour);
    const dayStartHour = opts?.dayStartHour ?? 3;
    const dateKey = opts?.dateKey ?? todayKey(dayStartHour);
    // repeat_rule 改道 setRepeatRule（比照 store 把 scheduled_on 改道 reschedule）：
    // 身分驗證與「寫完立刻同步班次」只留一份實作，誰都繞不過去。
    if ("repeat_rule" in patch) {
      const raw = patch.repeat_rule ?? null;
      const rule = parseRule(raw);
      if (raw !== null && raw.trim() !== "" && rule === null) throw new Error("重複規則格式不正確");
      await this.setRepeatRule(id, rule, dateKey, dayStartHour);
    }
    const picked = Object.entries(patch as Record<string, unknown>).filter(([k]) => PATCHABLE.has(k));
    if (!picked.length) return;
    const db = await getDb();

    // route_id＝臨時車票的路線標籤：驗身分、順手把 line_id 同步過去（setRouteTag 也走這條）
    const entries = [...picked];
    /** 路線標籤換了＝換了一份清單（顯示群組）：排序鍵改成新清單的尾端（收件匣不排序＝清成 NULL） */
    let retagTo: string | null | undefined;
    if (entries.some(([k]) => k === "route_id")) {
      const routeId = (patch.route_id ?? null) as string | null;
      const node = await this.getNode(id);
      if (!node) throw new Error("節點不存在");
      if (node.kind !== "ticket" || node.parent_id !== null) throw new Error("只有臨時車票能掛路線標籤");
      let lineId: string | null = null;
      if (routeId) {
        const tag = await this.getNode(routeId);
        if (!tag || tag.kind !== "route") throw new Error("路線標籤必須是一條路線");
        lineId = tag.line_id;
      }
      entries.push(["line_id", lineId]);
      if (node.route_id !== routeId) retagTo = routeId;
    }

    const now = nowUtcIso();
    const b = newWriteBatch();
    const extraOpCols: Record<string, unknown> = {};
    if (retagTo !== undefined) {
      let key: string | null = null;
      if (retagTo !== null) {
        const order = await this.groupOrder(db, { type: "routeTop", routeId: retagTo });
        const writes = keysForSlot(order.map((r) => ({ id: r.id, key: r.sort_key })), [id], order.length);
        key = writes.find((w) => w.id === id)?.key ?? null;
        this.stageKeyWrites(b, writes.filter((w) => w.id !== id), now);
      }
      entries.push(["sort_key", key]);
      extraOpCols.sort_key = key;
    }

    // B1 封口：寫 scheduled_time 時，沒有規則的票順手軟刪殘留的覆寫列（同一個交易；有殘留才寫）。
    // D-主-120 起殘留住在 node_time_overrides，不再是 nodes 的一欄——舊欄不寫，免得舊版的整欄 LWW 又被喚醒。
    // repeat_rule 若在同一個 patch，上面 setRepeatRule 已寫完，這裡讀到的是新規則
    if (picked.some(([k]) => k === "scheduled_time")) {
      const cur = await this.getNode(id);
      if (cur && !hasRepeatRule(cur.repeat_rule) && cur.time_overrides !== null) await this.dropOverrides(db, b, id);
    }

    const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
    const vals: unknown[] = entries.map(([, v]) => (v === undefined ? null : v));
    vals.push(now, id);
    b.stmts.push({
      sql: `UPDATE nodes SET ${sets.join(", ")}, updated_at = $${entries.length + 1} WHERE id = $${entries.length + 2}`,
      args: vals,
    });
    // op 只放 picked（主人真的改的欄）＋updated_at；順手算出來的 line_id 是快取，不進 oplog
    const cols: Record<string, unknown> = {};
    for (const [k, v] of picked) cols[k] = v === undefined ? null : v;
    Object.assign(cols, extraOpCols); // 換標籤時的排序鍵是主人資料（這列在新清單裡的位置）
    cols.updated_at = now;
    addOp(b, "nodes", id, "upsert", cols);

    // 入鋏：首次進 doing 才記一枚（同一節點只有一次起點）
    if (patch.status === "doing" && !(await this.hasEvent(db, id, "punched"))) {
      this.writeEvent(b, id, "punched", nowUtcIso());
    }

    // 心情鏡射（D-④-2）：定期券的完成卡心情住在班次上，nodes.mood＝最近一班。
    // 日界線吃呼叫端帶進來的設定（不再寫死 3）——否則改成 0／5 的使用者在凌晨填心情會鏡到隔壁班或靜默不寫。
    if ("mood" in patch) {
      await this.mirrorMoodToOccurrence(db, b, id, patch.mood ?? null, patch, dateKey, dayStartHour);
    }

    await runWriteBatch(db, b.stmts, b.ops);
  }

  async setKind(id: string, kind: NodeKind): Promise<void> {
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node) throw new Error("節點不存在");
    if (node.kind === kind) return;
    const parent = node.parent_id ? await this.getNode(node.parent_id) : null;
    if (!allowedChildKinds(parent ? parent.kind : null).includes(kind)) {
      throw new Error(`${KIND_LABEL[kind]} 不能掛在 ${parent ? KIND_LABEL[parent.kind] : "根層"} 底下`);
    }
    // 丁 D-主-246：直屬子項跟著換（車廂⇄列車）；換不了才擋。轉成支線順手清掉日期、時刻、重複（支線沒有這些欄）。一個交易寫完
    const kids = await db.select<{ id: string; kind: NodeKind }[]>(
      `SELECT id, kind FROM nodes WHERE parent_id = $1 AND ${ALIVE}`,
      [id],
    );
    const plan = childKindSwaps(kind, kids.map((k) => k.kind));
    if ("why" in plan) throw new Error(plan.why);
    const now = nowUtcIso();
    const b = newWriteBatch();
    if (kind === "branch") {
      b.stmts.push({
        sql: `UPDATE nodes SET kind = $1, scheduled_on = NULL, due_on = NULL, scheduled_time = NULL, repeat_rule = NULL, updated_at = $2 WHERE id = $3`,
        args: [kind, now, id],
      });
      addOp(b, "nodes", id, "upsert", { kind, scheduled_on: null, due_on: null, scheduled_time: null, repeat_rule: null, updated_at: now });
    } else {
      b.stmts.push({ sql: `UPDATE nodes SET kind = $1, updated_at = $2 WHERE id = $3`, args: [kind, now, id] });
      addOp(b, "nodes", id, "upsert", { kind, updated_at: now });
    }
    for (const k of kids) {
      const to = plan.swaps[k.kind];
      if (!to) continue;
      b.stmts.push({ sql: `UPDATE nodes SET kind = $1, updated_at = $2 WHERE id = $3`, args: [to, now, k.id] });
      addOp(b, "nodes", k.id, "upsert", { kind: to, updated_at: now });
    }
    await runWriteBatch(db, b.stmts, b.ops);
  }

  /**
   * 驗證一次搬移、算好快取與目的地群組（不寫）。`routeTag`：只對「落在根層的車票」有意義——
   * undefined＝保留原本的路線標籤（臨時車票保留標籤的規則；從列車搬出來的票＝它原本所在的路線），null＝收件匣，字串＝掛那條路線。
   */
  private async planMove(
    db: Database,
    id: string,
    newParentId: string | null,
    newKind?: NodeKind,
    routeTag?: string | null,
  ): Promise<PlannedMove> {
    const node = await this.getNode(id);
    if (!node) throw new Error("節點不存在");
    const kind = newKind ?? node.kind;
    const newParent = newParentId ? await this.getNode(newParentId) : null;
    if (newParentId && !newParent) throw new Error("目標父節點不存在");
    if (!allowedChildKinds(newParent ? newParent.kind : null).includes(kind)) {
      throw new Error(`${KIND_LABEL[kind]} 不能掛在 ${newParent ? KIND_LABEL[newParent.kind] : "根層"} 底下`);
    }
    const sub = await subtreeIds(db, id);
    if (newParentId && sub.includes(newParentId)) throw new Error("不能搬進自己的子樹");
    if (kind !== node.kind) {
      const kids = await db.select<{ kind: NodeKind }[]>(
        `SELECT DISTINCT kind FROM nodes WHERE parent_id = $1 AND ${ALIVE}`,
        [id],
      );
      const ok = allowedChildKinds(kind);
      const bad = kids.find((k) => !ok.includes(k.kind));
      if (bad) throw new Error(`底下還有${KIND_LABEL[bad.kind]}，不能變成${KIND_LABEL[kind]}`);
    }
    let lineId: string | null;
    let routeId: string | null;
    if (newParent) {
      lineId = newParent.kind === "line" ? newParent.id : newParent.line_id;
      routeId = newParent.kind === "route" ? newParent.id : newParent.route_id;
    } else {
      // 臨時車票保留路線標籤（routeTag 沒給時）；根層的非車票沒有路線
      routeId = kind === "ticket" ? (routeTag !== undefined ? routeTag : node.kind === "ticket" ? node.route_id : null) : null;
      // 磨光⑤ 沙盒 F1：根層車票的 line_id 跟著路線標籤的幹線（同 create、同對面那台整表重算）；
      // 原本寫死 null ⇒ 「搬進同路線列車再復原」這台變 null、對面重算成幹線，兩台暫時不一致
      const tag = routeId ? await this.getNode(routeId) : null;
      // 呼叫端明給的標籤才驗（保留原標籤時照舊不擋，同以前的 move）
      if (routeTag && (!tag || tag.kind !== "route" || tag.deleted_at)) throw new Error("路線標籤必須是一條路線");
      lineId = tag?.line_id ?? null;
    }
    const group = groupFor({ parentId: newParent?.id ?? null, parentKind: newParent?.kind ?? null, kind, routeId });
    return { node, newParent, kind, sub, lineId, routeId, group };
  }

  /** 把一次搬移的語句與 op 放進批次（key＝新排序鍵；收件匣＝null） */
  private stageMove(b: WriteBatch, p: PlannedMove, key: string | null, now: string): void {
    const { node, newParent, kind, sub, lineId, routeId } = p;
    const id = node.id;
    // 子樹的 line_id／route_id 是反正規化快取：SQL 照舊寫，但**不進 oplog**——
    // 對面那台 apply 完會自己整表重算（契約 §7.3），同步它只是把推導物推來推去。
    //
    // v1.1.3 工程評審 S-8：**這兩句也不碰 `updated_at`**。理由是合併：沒同步過的列，合併時的時間戳
    // 是從 `updated_at` 派生的（契約 §5.1 的列級近似）；搬一棵樹會把整棵子樹的 `updated_at` 推到「現在」，
    // 於是那些列在下一次合併裡會贏過另一台更早、但真正改到內容的編輯。快取重算不是內容修改，
    // 不該當成「這一列最後被改的時刻」。（這兩句本來就不進 oplog，所以對已同步過的列毫無影響。）
    if (lineId !== node.line_id) {
      b.stmts.push({
        sql: `UPDATE nodes SET line_id = $1 WHERE id IN (${placeholders(sub.length, 2)})`,
        args: [lineId, ...sub],
      });
    }
    // UI 丙-3（路線換幹線）：掛著這條路線標籤的根層臨時車票不在子樹裡，它們的 line_id 快取也要跟上。
    // 同上：快取、不進 oplog、不碰 updated_at——對面那台收到路線的 parent_id 後由 ROOT_TICKET 那句重算
    // （engine.rs recompute_caches_tx），兩台收斂到同一個值；這句只是讓本機不必等下一次拉取。
    if (node.kind === "route" && lineId !== node.line_id) {
      b.stmts.push({
        sql: `UPDATE nodes SET line_id = $1 WHERE parent_id IS NULL AND kind = 'ticket' AND route_id = $2`,
        args: [lineId, id],
      });
    }
    if (node.kind !== "route" && routeId !== node.route_id) {
      b.stmts.push({
        sql: `UPDATE nodes SET route_id = $1 WHERE id IN (${placeholders(sub.length, 2)})`,
        args: [routeId, ...sub],
      });
    }
    // 回饋乙：只寫被搬的這一列（排序鍵算在新鄰居之間）；不再位移兄弟、也不再改自己的 position
    b.stmts.push({
      sql: `UPDATE nodes SET parent_id = $1, sort_key = $2, kind = $3, updated_at = $4 WHERE id = $5`,
      args: [newParent?.id ?? null, key, kind, now, id],
    });
    addOp(b, "nodes", id, "upsert", {
      parent_id: newParent?.id ?? null,
      sort_key: key,
      kind,
      updated_at: now,
      // 搬到根層的車票：`route_id` 從快取變成**資料**（臨時車票的路線標籤），這一筆必須進 op。
      // 評審 S5：漏了它，單向下因為「副本重算出來的快取值恰好等於標籤值」而僥倖一致，
      // 雙向一開就分歧。非根層（newParent 有值）不帶——那時它又只是快取，副本自己重算。
      ...(!newParent && kind === "ticket" ? { route_id: routeId } : {}),
    });
  }

  async move(id: string, newParentId: string | null, index: number, newKind?: NodeKind): Promise<void> {
    const db = await getDb();
    const p = await this.planMove(db, id, newParentId, newKind);
    const now = nowUtcIso();
    const b = newWriteBatch();
    let key: string | null = null;
    if (isOrderedGroup(p.group)) {
      // index＝目的地顯示群組（拿掉自己之後）的第幾格；平常只回自己一列，擋路的同鍵／沒鍵鄰居才一起寫
      const order = await this.groupOrder(db, p.group);
      const writes = keysForSlot(order.map((r) => ({ id: r.id, key: r.sort_key })), [id], index);
      key = writes.find((w) => w.id === id)?.key ?? null;
      this.stageKeyWrites(b, writes.filter((w) => w.id !== id), now);
    }
    this.stageMove(b, p, key, now);
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async moveMany(items: readonly MoveManyItem[], anchor: SlotAnchor): Promise<void> {
    if (!items.length) return;
    const ids = items.map((x) => x.id);
    if (new Set(ids).size !== ids.length) throw new Error("同一個項目選了兩次");
    const db = await getDb();
    const plans: PlannedMove[] = [];
    for (const it of items) plans.push(await this.planMove(db, it.id, it.parentId, it.kind, it.routeTag));
    const group = plans[0].group;
    if (plans.some((p) => !sameGroup(p.group, group))) throw new Error("選到的項目放不進同一個地方");
    const now = nowUtcIso();
    const b = newWriteBatch();
    const keyOf = new Map<string, string>();
    if (isOrderedGroup(group)) {
      const order = await this.groupOrder(db, group);
      const moving = new Set(ids);
      const index = slotFromAnchor(order.filter((r) => !moving.has(r.id)).map((r) => r.id), anchor);
      const writes = keysForSlot(order.map((r) => ({ id: r.id, key: r.sort_key })), ids, index);
      for (const w of writes) if (moving.has(w.id)) keyOf.set(w.id, w.key);
      this.stageKeyWrites(b, writes.filter((w) => !moving.has(w.id)), now);
    }
    for (const p of plans) this.stageMove(b, p, keyOf.get(p.node.id) ?? null, now);
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async softDelete(id: string): Promise<string[]> {
    const db = await getDb();
    // 根已刪（連按刪除）：回 []、不重戳，不然一刀變兩刀——根換了 deleted_at、子孫留舊值，清單兩列、復原只放回根（對抗審查問題 12）
    const root = await db.select<{ deleted_at: string | null }[]>(`SELECT deleted_at FROM nodes WHERE id = $1`, [id]);
    if (!root[0] || root[0].deleted_at !== null) return [];
    const ids = await subtreeIds(db, id);
    if (!ids.length) return ids;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE nodes SET deleted_at = $1, updated_at = $1 WHERE id IN (${placeholders(ids.length, 2)})`,
      args: [now, ...ids],
    });
    // delete op 的 payload 一樣是 {col: value}——`deleted_at` 只是一個欄，套用規則與 upsert 同一條（契約 §7.3）
    for (const x of ids) addOp(b, "nodes", x, "delete", { deleted_at: now, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
    return ids;
  }

  async listSubtreeIds(id: string): Promise<string[]> {
    return subtreeIds(await getDb(), id);
  }

  async restore(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const db = await getDb();
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE nodes SET deleted_at = NULL, updated_at = $1 WHERE id IN (${placeholders(ids.length, 2)})`,
      args: [now, ...ids],
    });
    for (const x of ids) addOp(b, "nodes", x, "upsert", { deleted_at: null, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async restoreAsLoose(id: string, routeTagId: string | null): Promise<void> {
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node || node.deleted_at === null) return;
    if (node.kind !== "ticket") throw new Error("只有車票能放到臨時車票");
    const tag = routeTagId ? await this.getNode(routeTagId) : null;
    const live = tag && tag.kind === "route" && tag.deleted_at === null ? tag : null;
    const now = nowUtcIso();
    const b = newWriteBatch();
    // 換了一份清單：排序鍵給新清單的尾端（同改路線標籤；收件匣不排序＝NULL）。自己還是已刪，不在 order 裡
    let key: string | null = null;
    if (live) {
      const order = await this.groupOrder(db, { type: "routeTop", routeId: live.id });
      const writes = keysForSlot(order.map((r) => ({ id: r.id, key: r.sort_key })), [id], order.length);
      key = writes.find((w) => w.id === id)?.key ?? null;
      this.stageKeyWrites(b, writes.filter((w) => w.id !== id), now);
    }
    b.stmts.push({
      sql: `UPDATE nodes SET deleted_at = NULL, parent_id = NULL, route_id = $1, line_id = $2, sort_key = $3, updated_at = $4 WHERE id = $5`,
      args: [live?.id ?? null, live?.line_id ?? null, key, now, id],
    });
    addOp(b, "nodes", id, "upsert", { deleted_at: null, parent_id: null, route_id: live?.id ?? null, sort_key: key, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async setCompleted(
    id: string,
    done: boolean,
    opts?: { cascade?: boolean; dateKey?: string; dayStartHour?: number },
  ): Promise<string[]> {
    const db = await getDb();
    const now = nowUtcIso();
    const dayStartHour = opts?.dayStartHour ?? 3;
    const dateKey = opts?.dateKey ?? todayKey(dayStartHour);

    // ── 定期券分支（D-④-2）：済蓋在「目前班次」上，nodes.status 一個字不動 ──
    const node = await this.getNode(id);
    const rule = node ? parseRule(node.repeat_rule) : null;
    if (node && rule && node.status !== "done") {
      const ids = [id];
      const b = newWriteBatch();
      if (done) {
        const occs = await this.occurrencesOf(db, id);
        const due = node.scheduled_on ?? currentDue(rule, occs, dateKey, dayStartHour);
        if (due) {
          const wrote = await this.stampOccurrence(db, b, id, due, "done", now);
          if (wrote) {
            this.writeEvent(b, id, "done", now);
            const next = currentDue(rule, [...occs, { due_on: due, status: "done", completed_at: now, updated_at: now }], dateKey, dayStartHour);
            ids.push(...(await this.closeRunKids(db, b, id, due, next, !!opts?.cascade, now)));
          }
        }
      } else {
        const occs = await this.occurrencesOf(db, id);
        const target = pickTodayOccurrence(occs, node.scheduled_on, dateKey, dayStartHour);
        if (target) {
          this.dropOccurrence(b, target.id);
          if (target.status === "done") {
            await this.revokeLatestEvent(db, b, id, "done");
            await this.reopenRunKids(db, b, id, target, node.scheduled_on, now);
          }
        }
      }
      await runWriteBatch(db, b.stmts, b.ops);
      // syncNode 排在 COMMIT 之後（不能併進上面那個交易）：它要讀得到剛剛寫下的班次記錄才算得對下一班。
      // 本身是推導、不進 oplog，所以拆成兩個交易不會讓同步少掉任何一筆主人資料。
      await this.syncNode(db, id, dateKey, dayStartHour);
      return ids;
    }

    if (done) {
      const ids = opts?.cascade ? await subtreeIds(db, id) : [id];
      // 先問「這一輪誰真的從未完成變成完成」，済只給他們（重複蓋章不會長出第二枚）
      const changed = await db.select<{ id: string; repeat_rule: string | null }[]>(
        `SELECT id, repeat_rule FROM nodes WHERE id IN (${placeholders(ids.length, 1)}) AND status != 'done'`,
        ids,
      );
      const b = newWriteBatch();
      b.stmts.push({
        sql: `UPDATE nodes SET status = 'done', completed_at = $1, updated_at = $1
         WHERE id IN (${placeholders(ids.length, 2)}) AND status != 'done'`,
        args: [now, ...ids],
      });
      // op 只給 changed（真的變了的那些）——沒變的列本來就沒寫進 DB，記 op 等於推一筆假變更
      for (const r of changed) {
        addOp(b, "nodes", r.id, "upsert", { status: "done", completed_at: now, updated_at: now });
        this.writeEvent(b, r.id, "done", now);
      }
      await runWriteBatch(db, b.stmts, b.ops);
      await this.syncRetired(db, changed, dateKey, dayStartHour);
      return ids;
    }

    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE nodes SET status = 'todo', completed_at = NULL, updated_at = $1 WHERE id = $2`,
      args: [now, id],
    });
    addOp(b, "nodes", id, "upsert", { status: "todo", completed_at: null, updated_at: now });
    // 跑完到站的定期券（D-主-293）：只改狀態的話規則還是算不出下一班、馬上又到站——把最後一班的結局一起撤掉
    const occs = rule ? await this.occurrencesOf(db, id) : [];
    const lastRun = runEnded(rule, occs, dateKey, dayStartHour) ? ([...occs].sort((x, y) => y.due_on.localeCompare(x.due_on))[0] ?? null) : null;
    if (lastRun) this.dropOccurrence(b, lastRun.id);
    // 反悔完成：只收回「該次」済（最新一枚），舊的完成史留著；最後一班是運休就沒有済可收
    if (!lastRun || lastRun.status === "done") await this.revokeLatestEvent(db, b, id, "done");
    // 最後一班連帶蓋的子項一起回未完成（D-主-298）
    if (lastRun?.status === "done") {
      for (const kid of endedKidsToReopen(await this.runKids(db, id), lastRun.completed_at)) {
        b.stmts.push({ sql: `UPDATE nodes SET status = 'todo', completed_at = NULL, updated_at = $1 WHERE id = $2`, args: [now, kid] });
        addOp(b, "nodes", kid, "upsert", { status: "todo", completed_at: null, updated_at: now });
        await this.revokeLatestEvent(db, b, kid, "done");
      }
    }
    await runWriteBatch(db, b.stmts, b.ops);
    // 退役的定期券取消完成＝退役解除，引擎重新排班（a16：沒有「已生成班次」要收回）
    if (rule) await this.syncNode(db, id, dateKey, dayStartHour);
    return [id];
  }

  async listToday(dateKey: string, dayStartHour = 3): Promise<TodayRow[]> {
    const db = await getDb();
    const { start, end } = dayWindow(dateKey, dayStartHour);
    // 票號不在這支 SQL 裡算：M3-2 改「當日全域發券序」後，號碼取決於本地日界與全集排序，
    // 統一交給 listSerials／buildSerialMap（大綱與今日視圖共用同一把尺）。
    const serials = await this.listSerials();
    // 磨光⑦ 沙盒 F1：第一條（scheduled_on＝今天）不收退役的定期券——它的 scheduled_on 是各台自己推算、不同步、退役後就凍住的值，
    // 兩台可能停在不同天（先済再退役的那台推到明天、同步收到的那台停在今天），落在哪天那天就冒出一張済。
    // 退役的定期券只認第四條（今天完成）與第五條（今天交代過的班次）。
    const raw = await db.select<(NodeRow & { child_total: number; child_done: number })[]>(
      `SELECT r.*,
              (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = r.id AND c.${ALIVE}) AS child_total,
              (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = r.id AND c.${ALIVE} AND c.status = 'done') AS child_done
       FROM nodes r
       WHERE r.${ALIVE}
         AND r.kind IN ('train','car','ticket')
         AND NOT ${inDepotSql("r")}
         AND (
              (r.scheduled_on = $1 AND NOT (r.repeat_rule IS NOT NULL AND r.status = 'done'))
           OR (r.scheduled_on IS NOT NULL AND r.scheduled_on < $1 AND r.status != 'done')
           OR (r.status != 'done' AND r.due_on IS NOT NULL AND r.due_on <= $1
               AND (r.scheduled_on IS NULL OR r.scheduled_on > $1))
           OR (r.status = 'done' AND r.completed_at IS NOT NULL AND r.completed_at >= $2 AND r.completed_at < $3
               AND (
                    (r.scheduled_on IS NOT NULL AND r.scheduled_on <= $1)
                 OR (r.scheduled_on IS NULL AND r.due_on IS NOT NULL AND r.due_on <= $1)
                 OR (r.repeat_rule IS NOT NULL AND r.scheduled_on IS NULL)
               ))
           OR (r.repeat_rule IS NOT NULL AND EXISTS (
                 SELECT 1 FROM occurrences o
                 WHERE o.node_id = r.id AND o.${ALIVE}
                   AND COALESCE(o.completed_at, o.updated_at) >= $2
                   AND COALESCE(o.completed_at, o.updated_at) < $3))
         )`,
      [dateKey, start, end],
    );
    await this.withOverrides(db, raw, dateKey);
    // 第四條的第三個分支（D-主-122）：退役定期券一班都沒済過 ⇒ 執行日推導成 NULL（retiredScheduledOn）；
    // 沒有締切的話前兩個分支都接不住，今天才一起完成的它會從今日完成數裡掉出去。
    // 第五條 OR＝定期券變體（r2 的定期券版）：蓋済／運休之後 scheduled_on 已被引擎推到下一班，
    // 「今天交代過的那一班」只能靠 occurrence 的時刻戳留在清單裡。活著的定期券 status 恆非 done，
    // 所以第四條（原樣）碰不到它。磨光⑦（接縫 #102，D-主-68）：**退役的也走第五條**——今天先済、同一天又被上層
    // 「一起完成」退役的定期券，scheduled_on 已是明天、status 已是 done，第四條撈不到；不收它今日完成數會少一張
    // （行程表走班次紀錄算得到）。退役之後引擎不再排班、連帶完成也不寫 occurrence，所以只會多出「今天交代過」的那幾張。

    // 這一輪出現的定期券，把班次記錄撈回來配對（一次查完，不逐列往返）
    const repeatIds = raw.filter((n) => parseRule(n.repeat_rule)).map((n) => n.id); // #102：退役的也配對（分區用那筆的班次日）
    const occByNode = await this.occurrencesByNode(db, repeatIds);

    // 第四條第三支（退役、執行日 NULL）SQL 判不了「退役前是不是本來就在今天」，在這裡用規則補判（retiredWasDueToday）；
    // 同一列若另有締切到期或第五條（今天交代過某班）的資格，照舊收
    const touchedToday = (id: string) =>
      (occByNode[id] ?? []).some((o) => {
        const at = o.completed_at ?? o.updated_at;
        return at >= start && at < end;
      });
    const hits = raw.filter(
      (n) =>
        !(n.repeat_rule !== null && n.status === "done" && n.scheduled_on === null) ||
        (n.due_on !== null && n.due_on <= dateKey) ||
        touchedToday(n.id) ||
        retiredWasDueToday(n, occByNode[n.id] ?? [], dateKey, dayStartHour),
    );

    const rows: TodayRow[] = hits.map((n) => {
      const occ = repeatIds.includes(n.id)
        ? pickTodayOccurrence(occByNode[n.id] ?? [], n.scheduled_on, dateKey, dayStartHour)
        : null;
      return {
        ...n,
        serial: serials[n.id] ?? "",
        // 分區用「班次日」：蓋済留原位（今天）／漏班進誤點帶原定 M/D（D-④-4）
        bucket: todayBucketOf(n, dateKey, occ ? occ.due_on : n.scheduled_on),
        occurrence: occ ? toCurrentOccurrence(occ) : null,
        run_ended: n.status === "done" && runEnded(parseRule(n.repeat_rule), occByNode[n.id] ?? [], dateKey, dayStartHour),
      };
    });

    await this.assignMissingTodayPositions(db, rows);
    return rows.sort(compareTodayRows);
  }

  /**
   * 首次進今日的列補 today_position＝全域 max+1（新聚合尾插、跨日保留相對序，r7）。
   *
   * v1.1.1 起**純推導、不落庫**（契約 §2.7 #20）：今天的順序本來就是呈現層的事，
   * 而「打開今日頁 → 寫 today_position → 戳 updated_at」會讓光是開 App 就憑空長出一批變更
   * （盲探 U2）。max 仍讀 DB——要接在 `moveToday` 真的落庫過的那些序號之後。
   * 真正落庫的入口只剩 `assignTodayPositions`（主人手動拖曳）。
   */
  private async assignMissingTodayPositions(db: Database, rows: TodayRow[]): Promise<void> {
    // 同毫秒建立的票（種子／連打 Enter）用 position 再分先後，否則落到 id 就是亂序
    const fresh = rows
      .filter((r) => r.bucket === "today" && r.today_position === null)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.position - b.position || a.id.localeCompare(b.id),
      );
    if (!fresh.length) return;
    const max = await db.select<{ m: number | null }[]>(
      `SELECT MAX(today_position) AS m FROM nodes WHERE ${ALIVE}`,
    );
    let next = (max[0]?.m ?? -1) + 1;
    for (const row of fresh) {
      row.today_position = next;
      next += 1;
    }
  }

  async assignTodayPositions(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const db = await getDb();
    const now = nowUtcIso();
    const b = newWriteBatch();
    for (let i = 0; i < ids.length; i++) {
      b.stmts.push({
        sql: `UPDATE nodes SET today_position = $1, updated_at = $2 WHERE id = $3`,
        args: [i, now, ids[i]],
      });
      addOp(b, "nodes", ids[i], "upsert", { today_position: i, updated_at: now });
    }
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async moveToday(id: string, index: number, dateKey: string, dayStartHour = 3): Promise<void> {
    const rows = await this.listToday(dateKey, dayStartHour);
    // 主線②：座標系＝手排座標（只算沒時刻的 today 列）。store 不經此路（直接用 assignTodayPositions），這支只給測試
    const ids = manualOrderIds(rows);
    if (!ids.includes(id)) throw new Error("這張票不在今天的清單裡");
    await this.assignTodayPositions(reorderIds(ids, id, index));
  }

  async setRouteTag(ticketId: string, routeId: string | null): Promise<void> {
    await this.update(ticketId, { route_id: routeId });
  }

  async reschedule(id: string, nextDate: string | null, todayDateKey: string, opts?: RescheduleOpts): Promise<RescheduleResult> {
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node) throw new Error("節點不存在");
    // 定期券的班次由規則排定（M3-5e「只改這次的日期」v1 不做）——擋在 repository 層，不只靠 UI 不給入口
    if (parseRule(node.repeat_rule)) throw new Error(REPEAT_RESCHEDULE_MSG);
    const prev = node.scheduled_on;
    const leavesToday = nextDate === null || nextDate > todayDateKey;
    // 繰越＝「手動把今天／過去的票挪到更晚的一天」（M3-1：過期票不自動順延；只有手動改期會長章）。
    // 含「誤點票按 T 排上今天」——那也是從過去挪過來的，來歷要留（否則延着當場蒸發，與 mock
    // 示範的『自 9/2 繰越』同一種情形卻沒有章）。
    const carried =
      nextDate !== null && prev !== null && prev < nextDate && prev <= todayDateKey ? prev : node.carried_from;
    const todayPosition = leavesToday ? null : node.today_position;
    const now = nowUtcIso();
    // 磨光⑦（D-主-67）：日期欄親手選了今天以前 ⇒ 補記＝同一個交易裡直接済在那一天
    let doneAt: string | null = null;
    if (opts?.backfill && nextDate !== null && nextDate < todayDateKey) {
      const open = await db.select<{ c: number }[]>(
        `SELECT COUNT(*) AS c FROM nodes WHERE parent_id = $1 AND ${ALIVE} AND status != 'done'`,
        [id],
      );
      doneAt = backfillAtOf(node, nextDate, todayDateKey, opts.dayStartHour ?? 3, open[0]?.c ?? 0);
    }
    const b = newWriteBatch();
    if (doneAt) {
      b.stmts.push({
        sql: `UPDATE nodes SET scheduled_on = $1, carried_from = $2, today_position = $3, status = 'done', completed_at = $4, updated_at = $5 WHERE id = $6`,
        args: [nextDate, node.carried_from, todayPosition, doneAt, now, id],
      });
      // 補記不算繰越（往過去挪；評審 #3：誤點票 10/18 補記到 10/20 不該長「自 10/18 繰越」）
      addOp(b, "nodes", id, "upsert", {
        scheduled_on: nextDate,
        carried_from: node.carried_from,
        today_position: todayPosition,
        status: "done",
        completed_at: doneAt,
        updated_at: now,
      });
      this.writeLog(b, id, "", "done", doneAt, now); // 済的時刻＝那一天；列的寫入時刻照實是現在
    } else {
      b.stmts.push({
        sql: `UPDATE nodes SET scheduled_on = $1, carried_from = $2, today_position = $3, updated_at = $4 WHERE id = $5`,
        args: [nextDate, carried, todayPosition, now, id],
      });
      // 沒有 repeat_rule 的節點，scheduled_on 是貨真價實的主人資料（推遲＝主人的決定）
      addOp(b, "nodes", id, "upsert", {
        scheduled_on: nextDate,
        carried_from: carried,
        today_position: todayPosition,
        updated_at: now,
      });
    }
    await runWriteBatch(db, b.stmts, b.ops);
    return { backfilled: doneAt !== null };
  }

  async search(query: string, limit = 50): Promise<NodeRow[]> {
    const q = query.trim();
    if (!q) return [];
    const db = await getDb();
    return this.withOverrides(
      db,
      await db.select<NodeRow[]>(
        `SELECT * FROM nodes WHERE ${ALIVE} AND kind != 'line' AND name LIKE $1 ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT $2`,
        // 接縫 #67：q 是字面字串——`%`、`_`、`\` 先跳脫，否則打 `%` 會列出全部
        [`%${escapeLike(q)}%`, limit],
      ),
    );
  }

  async searchFull(query: string): Promise<FullSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const db = await getDb();
    // 一個節點一列：名稱 → 概要 → 乘務記錄（只算手記、取最新一則命中的）；LIKE 字面比對同 search（接縫 #67）
    const logHit = `(SELECT w.body FROM work_logs w
        WHERE w.node_id = n.id AND w.deleted_at IS NULL AND w.event IS NULL AND w.body LIKE $1 ESCAPE '\\'
        ORDER BY w.logged_at DESC LIMIT 1)`;
    const rows = await db.select<(NodeRow & { fs_field: number; fs_log: string | null })[]>(
      `SELECT * FROM (
         SELECT n.*,
           CASE WHEN n.name LIKE $1 ESCAPE '\\' THEN 0 WHEN n.description LIKE $1 ESCAPE '\\' THEN 1 ELSE 2 END AS fs_field,
           ${logHit} AS fs_log
         FROM nodes n WHERE n.deleted_at IS NULL AND n.kind != 'line'
       ) WHERE fs_field < 2 OR fs_log IS NOT NULL`,
      [`%${escapeLike(q)}%`],
    );
    await this.withOverrides(db, rows);
    return rows.map(({ fs_field, fs_log, ...node }): FullSearchHit =>
      fs_field === 0
        ? { node, field: "name", text: null }
        : fs_field === 1
          ? { node, field: "description", text: node.description }
          : { node, field: "log", text: fs_log },
    );
  }

  async listInboxTickets(): Promise<NodeRow[]> {
    const db = await getDb();
    return this.withOverrides(
      db,
      await db.select<NodeRow[]>(
        `SELECT * FROM nodes WHERE ${ALIVE} AND kind = 'ticket' AND parent_id IS NULL
         AND scheduled_on IS NULL AND route_id IS NULL AND status != 'done'
       ORDER BY created_at DESC`,
      ),
    );
  }

  async addWorkLog(nodeId: string, body: string): Promise<WorkLog> {
    const db = await getDb();
    const now = nowUtcIso();
    const text = body.trim();
    const b = newWriteBatch();
    const log = this.writeLog(b, nodeId, text, null, now);
    await runWriteBatch(db, b.stmts, b.ops);
    return log;
  }

  /** 手記＋系統事件一起回（依時刻新→舊）；事件列 body 空、event 有值 */
  async listWorkLogs(nodeId: string): Promise<WorkLog[]> {
    const db = await getDb();
    return db.select<WorkLog[]>(
      `SELECT * FROM work_logs WHERE node_id = $1 AND ${ALIVE} ORDER BY logged_at DESC, created_at DESC`,
      [nodeId],
    );
  }

  // ───────────── 重複任務引擎（M3 ④）─────────────

  async setRepeatRule(id: string, rule: RepeatRule | null, dateKey: string, dayStartHour = 3): Promise<void> {
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node) throw new Error("節點不存在");
    if (rule) {
      if (!REPEATABLE_KINDS.includes(node.kind)) {
        throw new Error(`${KIND_LABEL[node.kind]}不能設重複——只有車票、列車與車廂可以`);
      }
      if (await this.touchesAnotherRepeat(db, node)) throw new Error(NESTED_REPEAT_MSG);
      if (!parseRule(serializeRule(rule))) throw new Error("重複規則格式不正確");
    }
    const old = parseRule(node.repeat_rule);
    const occs = old ? await this.occurrencesOf(db, id) : [];
    const same = old !== null && rule !== null && sameSchedule(old, rule);
    // moves 只由 moveOccurrence 寫，呼叫端帶什麼都不算：排程沒變全留，換排程只留歷史（D-主-296）
    const kept = !old ? {} : same ? (old.moves ?? {}) : keptMoves(old, occs, dateKey);
    const finalRule: RepeatRule | null = rule ? withMoves(rule, kept) : null;
    const serialized = finalRule ? serializeRule(finalRule) : null;
    const now = nowUtcIso();
    const b = newWriteBatch();
    // 主線②（§0-1 第 13 條）：清規則＝覆寫全清（票變回乘車券）；換排程＝清還沒有結局、班次日 ≥ 今天的覆寫；
    // 只改結束條件一格都不清（D-主-296；過去與已交代的班是歷史，D-主-32）。scheduled_time 都留著。
    // D-主-120：清＝軟刪覆寫列（與規則同一個交易，每一列各一筆 delete op）。
    // 對面那台在舊規則下併發新設的未來覆寫這裡刪不到（它不在這台）——落在新規則非班次日的由讀取守門忽略（overrideKeepOf）。
    if (!rule) await this.dropOverrides(db, b, id);
    else if (!same) await this.dropOverrides(db, b, id, dateKey, occs.map((o) => o.due_on));
    b.stmts.push({
      sql: `UPDATE nodes SET repeat_rule = $1, updated_at = $2 WHERE id = $3`,
      args: [serialized, now, id],
    });
    const cols: Record<string, unknown> = { repeat_rule: serialized, updated_at: now };
    // 清規則＝票變回乘車券（D-④-5）：scheduled_on 從「引擎推導值」轉為主人資料，這一刻起要同步。
    // 值沒變，但對面那台從此不會再自己算它——所以得把現值帶過去一次（契約 §2.7 #23）。
    if (!rule) cols.scheduled_on = node.scheduled_on;
    // 跑完到站的改規則放寬（10 次改 20 次）＝回到運行（D-主-293）；跟著上層退役的不算
    if (node.status === "done" && finalRule && runEnded(old, occs, dateKey, dayStartHour) && !runEnded(finalRule, occs, dateKey, dayStartHour)) {
      b.stmts.push({ sql: `UPDATE nodes SET status = 'todo', completed_at = NULL WHERE id = $1`, args: [id] });
      cols.status = "todo";
      cols.completed_at = null;
      // 最後一班的子項留在已完成，回到運行就要接著下一班（同蓋完一班；D-主-298）。最後一班是運休的不動子項
      const last = [...occs].sort((x, y) => y.due_on.localeCompare(x.due_on))[0];
      if (last?.status === "done") await this.closeRunKids(db, b, id, last.due_on, currentDue(finalRule, occs, dateKey, dayStartHour), false, now);
    }
    addOp(b, "nodes", id, "upsert", cols);
    await runWriteBatch(db, b.stmts, b.ops);
    // 掛規則＝立刻算出目前班次日；清規則＝scheduled_on 留在現值（票變回乘車券，D-④-5）
    if (rule) await this.syncNode(db, id, dateKey, dayStartHour);
  }

  /** 這張票的上層或子孫有沒有別的定期券（一班的語義只有一層，D-主-298） */
  private async touchesAnotherRepeat(db: Database, node: NodeRow): Promise<boolean> {
    const below = (await subtreeIds(db, node.id)).filter((x) => x !== node.id);
    if (below.length) {
      const rows = await db.select<{ repeat_rule: string | null }[]>(
        `SELECT repeat_rule FROM nodes WHERE id IN (${placeholders(below.length, 1)}) AND ${ALIVE}`,
        below,
      );
      if (rows.some((r) => parseRule(r.repeat_rule))) return true;
    }
    let up = node.parent_id;
    while (up) {
      const p = await this.getNode(up);
      if (!p) break;
      if (parseRule(p.repeat_rule)) return true;
      up = p.parent_id;
    }
    return false;
  }

  /** 子孫裡重置會碰到的欄位（不含自己） */
  private async runKids(db: Database, id: string): Promise<RunKid[]> {
    const sub = (await subtreeIds(db, id)).filter((x) => x !== id);
    if (!sub.length) return [];
    return db.select<RunKid[]>(
      `SELECT id, status, completed_at, mood, scheduled_on, due_on, repeat_rule FROM nodes
       WHERE id IN (${placeholders(sub.length, 1)}) AND ${ALIVE}`,
      sub,
    );
  }

  /**
   * 蓋完一班時的子項（D-主-298）。連帶完成：底下沒做完的一起済。還有下一班（`next` 非 null）：全部重置接著下一班；
   * 最後一班：留在已完成，跟著到站。回傳這次一起蓋掉的 id。
   */
  private async closeRunKids(
    db: Database,
    b: WriteBatch,
    id: string,
    due: string,
    next: string | null,
    cascade: boolean,
    now: string,
  ): Promise<string[]> {
    const kids = await this.runKids(db, id);
    if (!kids.length) return [];
    const cascaded: string[] = [];
    const after = kids.map((k) => {
      if (!cascade || k.status === "done" || parseRule(k.repeat_rule)) return k;
      this.writeEvent(b, k.id, "done", now);
      cascaded.push(k.id);
      return { ...k, status: "done" as const, completed_at: now };
    });
    if (next === null) {
      for (const kid of cascaded) {
        b.stmts.push({ sql: `UPDATE nodes SET status = 'done', completed_at = $1, updated_at = $1 WHERE id = $2`, args: [now, kid] });
        addOp(b, "nodes", kid, "upsert", { status: "done", completed_at: now, updated_at: now });
      }
      return cascaded;
    }
    for (const p of planRunReset(after, daysBetween(due, next))) {
      await this.stampOccurrence(db, b, p.id, due, "done", p.completedAt ?? now);
      if (p.mood) {
        const oid = await occurrenceId(p.id, due);
        b.stmts.push({ sql: `UPDATE occurrences SET mood = $1 WHERE id = $2`, args: [p.mood, oid] });
        addOp(b, "occurrences", oid, "upsert", { mood: p.mood, updated_at: now });
      }
      b.stmts.push({
        sql: `UPDATE nodes SET status = 'todo', completed_at = NULL, mood = NULL, scheduled_on = $1, due_on = $2, updated_at = $3 WHERE id = $4`,
        args: [p.scheduledOn, p.dueOn, now, p.id],
      });
      addOp(b, "nodes", p.id, "upsert", {
        status: "todo",
        completed_at: null,
        mood: null,
        scheduled_on: p.scheduledOn,
        due_on: p.dueOn,
        updated_at: now,
      });
    }
    return cascaded;
  }

  /** 取消這一班的済：子項還原成蓋章之前的樣子（D-主-298）。`scheduledOn`＝上層現在指著的下一班，用來算平移了幾天 */
  private async reopenRunKids(
    db: Database,
    b: WriteBatch,
    id: string,
    target: Occurrence,
    scheduledOn: string | null,
    now: string,
  ): Promise<void> {
    const kids = await this.runKids(db, id);
    if (!kids.length) return;
    const kidOccs = await db.select<Occurrence[]>(
      `SELECT * FROM occurrences WHERE due_on = $1 AND status = 'done' AND ${ALIVE} AND node_id IN (${placeholders(kids.length, 2)})`,
      [target.due_on, ...kids.map((k) => k.id)],
    );
    const shift = scheduledOn !== null ? daysBetween(target.due_on, scheduledOn) : 0;
    for (const p of planRunRestore(kids, kidOccs, target.completed_at, shift)) {
      this.dropOccurrence(b, p.occId);
      if (p.cascaded) await this.revokeLatestEvent(db, b, p.id, "done");
      b.stmts.push({
        sql: `UPDATE nodes SET status = $1, completed_at = $2, mood = $3, scheduled_on = $4, due_on = $5, updated_at = $6 WHERE id = $7`,
        args: [p.status, p.completedAt, p.mood, p.scheduledOn, p.dueOn, now, p.id],
      });
      addOp(b, "nodes", p.id, "upsert", {
        status: p.status,
        completed_at: p.completedAt,
        mood: p.mood,
        scheduled_on: p.scheduledOn,
        due_on: p.dueOn,
        updated_at: now,
      });
    }
  }

  async moveOccurrence(id: string, from: string, to: string, dateKey: string, dayStartHour = 3): Promise<void> {
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node || node.deleted_at !== null) throw new Error("節點不存在");
    const rule = parseRule(node.repeat_rule);
    if (!rule || node.status === "done") throw new Error(REPEAT_ONLY_MSG);
    const block = runMoveBlock(rule, await this.occurrencesOf(db, id), from, to, dateKey, dayStartHour);
    if (block) throw new Error(block);
    if (from === to) return;
    const serialized = serializeRule(withRunMoved(rule, from, to));
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE nodes SET repeat_rule = $1, updated_at = $2 WHERE id = $3`, args: [serialized, now, id] });
    addOp(b, "nodes", id, "upsert", { repeat_rule: serialized, updated_at: now });
    // 這一班的時刻覆寫跟著走（逐列 LWW，舊列軟刪、新列 upsert）
    await this.ensureOverrideBackfill(db);
    const oldId = await overrideId(id, from);
    const hit = (await db.select<{ hhmm: string | null }[]>(`SELECT hhmm FROM node_time_overrides WHERE id = $1 AND ${ALIVE}`, [oldId]))[0];
    if (hit) {
      const newId = await overrideId(id, to);
      const existed = (await db.select<{ id: string }[]>(`SELECT id FROM node_time_overrides WHERE id = $1`, [newId])).length > 0;
      b.stmts.push({ sql: `UPDATE node_time_overrides SET deleted_at = $1, updated_at = $1 WHERE id = $2`, args: [now, oldId] });
      addOp(b, NTO, oldId, "delete", { deleted_at: now, updated_at: now });
      b.stmts.push({
        sql: `INSERT INTO node_time_overrides (id, node_id, due_on, hhmm, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT(id) DO UPDATE SET hhmm = excluded.hhmm, deleted_at = NULL, updated_at = excluded.updated_at`,
        args: [newId, id, to, hit.hhmm, now],
      });
      // created_at 只在這台新建時帶：本機復活不改它，op 帶新值的話對面整列採新值、兩台就不一樣了（同 writeRunTime）
      addOp(b, NTO, newId, "upsert", { node_id: id, due_on: to, hhmm: hit.hhmm, deleted_at: null, ...(existed ? {} : { created_at: now }), updated_at: now });
    }
    await runWriteBatch(db, b.stmts, b.ops);
    await this.syncNode(db, id, dateKey, dayStartHour);
  }

  async setRunTime(
    id: string,
    dueOn: string,
    time: string | null,
    dayStartHour: number,
  ): Promise<void> {
    await this.writeRunTime(id, dueOn, { time, dayStartHour });
  }

  async clearRunTime(id: string, dueOn: string): Promise<void> {
    await this.writeRunTime(id, dueOn, null);
  }

  /**
   * setRunTime／clearRunTime 的核心：驗身分與日期 → 那一班的覆寫列 upsert（set）或軟刪（clear）＋一筆 op。
   * 過去班次的覆寫一律保留（歷史，D-主-32）。
   *
   * D-主-120：一班一列、id 由 (票, 班次日) 決定，兩台改不同班是不同列、互不干擾（#86 的根治）；改同一班照逐列 LWW。
   * `nodes` 一個欄位都不寫（舊欄停用；也不戳 nodes.updated_at——那會讓「改了某班時刻」去壓對面對這張票本身的編輯）。
   */
  private async writeRunTime(
    id: string,
    dueOn: string,
    set: { time: string | null; dayStartHour: number } | null,
  ): Promise<void> {
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node || node.deleted_at !== null) throw new Error("節點不存在");
    if (!parseRule(node.repeat_rule)) throw new Error(TIME_REPEAT_ONLY_MSG);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) throw new Error("班次日格式不正確");
    if (set) assertClockWritable(set.time, set.dayStartHour);
    const oid = await overrideId(id, dueOn);
    const hit = (
      await db.select<{ deleted_at: string | null }[]>(`SELECT deleted_at FROM node_time_overrides WHERE id = $1`, [oid])
    )[0];
    const now = nowUtcIso();
    const b = newWriteBatch();
    if (set === null) {
      if (!hit || hit.deleted_at !== null) return; // 這一班本來就沒覆寫：不寫、不進 op
      b.stmts.push({
        sql: `UPDATE node_time_overrides SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
        args: [now, oid],
      });
      addOp(b, NTO, oid, "delete", { deleted_at: now, updated_at: now });
    } else {
      b.stmts.push({
        sql: `INSERT INTO node_time_overrides (id, node_id, due_on, hhmm, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT(id) DO UPDATE SET hhmm = excluded.hhmm, deleted_at = NULL, updated_at = excluded.updated_at`,
        args: [oid, id, dueOn, set.time, now],
      });
      // node_id／due_on 每次都帶：對面可能還沒有這一列（新設、或被它的清除之前從沒同步到），INSERT 要有必填欄。
      // created_at 只在這台新建時帶——復活／改值不該改寫這一列的出生時刻
      addOp(b, NTO, oid, "upsert", {
        node_id: id,
        due_on: dueOn,
        hhmm: set.time,
        deleted_at: null,
        ...(hit ? {} : { created_at: now }),
        updated_at: now,
      });
    }
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async syncRepeats(dateKey: string, dayStartHour = 3): Promise<string[]> {
    const db = await getDb();
    // D-主-122：退役的也撈——它的執行日改成同步資料的純函數（retiredScheduledOn），各台每一輪自己重算才會收斂
    const rows = await db.select<NodeRow[]>(
      // 車庫與回顧 D-主-204：收進車庫的定期券停止發班（回到運行後照規則收斂）
      `SELECT * FROM nodes n WHERE n.${ALIVE} AND n.repeat_rule IS NOT NULL AND NOT ${inDepotSql("n")}`,
    );
    const changed: string[] = [];
    for (const node of rows) {
      if (await this.syncNode(db, node.id, dateKey, dayStartHour, node)) changed.push(node.id);
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
    const db = await getDb();
    const node = await this.getNode(id);
    if (!node) throw new Error("節點不存在");
    const rule = parseRule(node.repeat_rule);
    if (!rule) throw new Error(REPEAT_ONLY_MSG);
    const occs = await this.occurrencesOf(db, id);
    // 最後一班運休後跑完到站（D-主-293）：取消運休要回得來；其他退役的照舊擋
    if (node.status === "done" && (skip || !runEnded(rule, occs, dateKey, dayStartHour))) throw new Error(REPEAT_ONLY_MSG);
    const b = newWriteBatch();
    if (skip) {
      // 守門＋班次日口徑都在 resolveSkipDate（兩種實作同一份語義；含 ⑤ 的指定班次驗證）
      const due = resolveSkipDate(rule, occs, node.scheduled_on, dateKey, dayStartHour, dueOn);
      if (due) await this.stampOccurrence(db, b, id, due, "skipped", null);
    } else {
      // 取消運休：指定班次＝撤那一班的運休；沒指定＝撤「這一列在講的那一班」
      const target =
        dueOn === undefined || dueOn === null
          ? pickTodayOccurrence(occs, node.scheduled_on, dateKey, dayStartHour)
          : (occs.find((o) => o.due_on === dueOn) ?? null);
      if (target && target.status === "skipped") {
        this.dropOccurrence(b, target.id);
        if (node.status === "done") {
          const now = nowUtcIso();
          b.stmts.push({ sql: `UPDATE nodes SET status = 'todo', completed_at = NULL, updated_at = $1 WHERE id = $2`, args: [now, id] });
          addOp(b, "nodes", id, "upsert", { status: "todo", completed_at: null, updated_at: now });
        }
      }
    }
    await runWriteBatch(db, b.stmts, b.ops);
    // 同 setCompleted：syncNode 要讀得到剛落地的班次記錄，所以排在 COMMIT 之後
    await this.syncNode(db, id, dateKey, dayStartHour);
  }

  async listOccurrences(nodeId: string, from?: string, to?: string): Promise<Occurrence[]> {
    const db = await getDb();
    const args: unknown[] = [nodeId];
    let where = `node_id = $1 AND ${ALIVE}`;
    if (from) {
      args.push(from);
      where += ` AND due_on >= $${args.length}`;
    }
    if (to) {
      args.push(to);
      where += ` AND due_on <= $${args.length}`;
    }
    return db.select<Occurrence[]>(
      `SELECT * FROM occurrences WHERE ${where} ORDER BY due_on DESC, created_at DESC`,
      args,
    );
  }

  async listCurrentOccurrences(dateKey: string, dayStartHour = 3): Promise<Record<string, CurrentOccurrence>> {
    const db = await getDb();
    const nodes = await db.select<Pick<NodeRow, "id" | "scheduled_on" | "repeat_rule" | "status">[]>(
      `SELECT id, scheduled_on, repeat_rule, status FROM nodes
       WHERE ${ALIVE} AND repeat_rule IS NOT NULL AND status != 'done'`,
    );
    const live = nodes.filter((n) => parseRule(n.repeat_rule));
    const occByNode = await this.occurrencesByNode(db, live.map((n) => n.id));
    const out: Record<string, CurrentOccurrence> = {};
    for (const n of live) {
      const occ = pickTodayOccurrence(occByNode[n.id] ?? [], n.scheduled_on, dateKey, dayStartHour);
      if (occ) out[n.id] = toCurrentOccurrence(occ);
    }
    return out;
  }

  async listSchedule(
    from: string,
    to: string,
    opts?: { todayDateKey?: string; dayStartHour?: number; projectAfter?: boolean },
  ): Promise<ScheduleEntry[]> {
    const db = await getDb();
    const dayStartHour = opts?.dayStartHour ?? 3;
    const today = opts?.todayDateKey ?? todayKey(dayStartHour);
    const nodes = await this.withOverrides(
      db,
      await db.select<NodeRow[]>(
        `SELECT * FROM nodes n WHERE n.${ALIVE} AND n.kind IN ('train','car','ticket') AND NOT ${inDepotSql("n")}`,
      ),
      today,
    );
    const repeatIds = nodes.filter((n) => parseRule(n.repeat_rule)).map((n) => n.id);
    const occByNode = await this.occurrencesByNode(db, repeatIds);
    return buildSchedule(nodes, occByNode, from, to, today, dayStartHour, {
      projectAfter: opts?.projectAfter,
    });
  }

  async listCalendar(
    from: string,
    to: string,
    opts?: { todayDateKey?: string; dayStartHour?: number },
  ): Promise<CalendarData> {
    const db = await getDb();
    const dayStartHour = opts?.dayStartHour ?? 3;
    const today = opts?.todayDateKey ?? todayKey(dayStartHour);
    // 與 listSchedule 同一句、同一趟：締切層與節點表都從這批列裡摺出來，不再多打一次 SQL
    const nodes = await this.withOverrides(
      db,
      await db.select<NodeRow[]>(
        `SELECT * FROM nodes n WHERE n.${ALIVE} AND n.kind IN ('train','car','ticket') AND NOT ${inDepotSql("n")}`,
      ),
      today,
    );
    const repeatIds = nodes.filter((n) => parseRule(n.repeat_rule)).map((n) => n.id);
    const occByNode = await this.occurrencesByNode(db, repeatIds);
    return buildCalendar(nodes, occByNode, from, to, today, dayStartHour);
  }

  async scheduleBounds(): Promise<ScheduleBounds> {
    const db = await getDb();
    // 與 listCalendar 同一句、同一趟（主線車次① P5）：邊界只看會進日曆的那批列
    const nodes = await db.select<NodeRow[]>(
      `SELECT * FROM nodes n WHERE n.${ALIVE} AND n.kind IN ('train','car','ticket') AND NOT ${inDepotSql("n")}`,
    );
    const repeatIds = nodes.filter((n) => parseRule(n.repeat_rule)).map((n) => n.id);
    const occByNode = await this.occurrencesByNode(db, repeatIds);
    return buildScheduleBounds(nodes, occByNode);
  }

  async routeProgress(routeId: string): Promise<RouteProgress> {
    const db = await getDb();
    // 車站走 parent_id、任務走 route_id（含掛標籤的臨時車票）——一次撈完，分類全在 buildRouteProgress。
    // $1／$2 都綁同一個 id：sqlx 是照參數個數綁的，同一個佔位符不重用（與 listToday 的寫法同源）。
    const rows = await db.select<RouteProgressSeed[]>(
      `SELECT kind, parent_id, route_id, status, arrived_on, deleted_at FROM nodes
       WHERE ${ALIVE} AND (parent_id = $1 OR route_id = $2)`,
      [routeId, routeId],
    );
    return buildRouteProgress(routeId, rows);
  }

  async setArrival(writes: readonly ArrivalWrite[]): Promise<void> {
    if (!writes.length) return;
    const db = await getDb();
    const rows = await db.select<{ id: string; kind: NodeKind }[]>(
      `SELECT id, kind FROM nodes WHERE id IN (${placeholders(writes.length, 1)}) AND ${ALIVE}`,
      writes.map((w) => w.id),
    );
    const kindOf = new Map(rows.map((r) => [r.id, r.kind] as const));
    for (const w of writes) {
      const k = kindOf.get(w.id);
      if (!k) throw new Error("節點不存在");
      if (k !== "line" && k !== "route") throw new Error("只有路線和幹線能到站");
    }
    const now = nowUtcIso();
    const b = newWriteBatch();
    for (const w of writes) {
      b.stmts.push({
        sql: `UPDATE nodes SET arrived_on = $1, status = $2, updated_at = $3 WHERE id = $4`,
        args: [w.arrived_on, w.status, now, w.id],
      });
      addOp(b, "nodes", w.id, "upsert", { arrived_on: w.arrived_on, status: w.status, updated_at: now });
    }
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async routeOpenCounts(): Promise<Record<string, number>> {
    const db = await getDb();
    // 語義＝buildRouteOpenCounts（回饋甲 D-主-130）：末端（沒有活著的子項）、未済的列車／車廂／車票，依 route_id 分組
    const rows = await db.select<{ route_id: string; n: number }[]>(
      `SELECT n.route_id AS route_id, COUNT(*) AS n FROM nodes n
       WHERE n.deleted_at IS NULL AND n.kind IN ('train','car','ticket') AND n.status != 'done' AND n.route_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id AND c.deleted_at IS NULL)
       GROUP BY n.route_id`,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.route_id] = Number(r.n);
    return out;
  }

  /** 某節點的存活班次記錄（新→舊不保證，呼叫端自己排） */
  private async occurrencesOf(db: Database, nodeId: string): Promise<Occurrence[]> {
    return db.select<Occurrence[]>(`SELECT * FROM occurrences WHERE node_id = $1 AND ${ALIVE}`, [nodeId]);
  }

  /** 一次撈多個節點的班次記錄，分好組（今日聚合／投影都要，避免逐列往返） */
  private async occurrencesByNode(db: Database, nodeIds: string[]): Promise<Record<string, Occurrence[]>> {
    const out: Record<string, Occurrence[]> = {};
    if (!nodeIds.length) return out;
    const rows = await db.select<Occurrence[]>(
      `SELECT * FROM occurrences WHERE ${ALIVE} AND node_id IN (${placeholders(nodeIds.length, 1)})`,
      nodeIds,
    );
    for (const o of rows) (out[o.node_id] ??= []).push(o);
    return out;
  }

  /**
   * 寫下一班的結局（済／運休）；同一班次已經有存活記錄就改寫那一列（部分唯一索引不容第二列）。
   * 回傳 true＝這一次真的「從沒結局變成有結局」（呼叫端據此決定要不要寫済事件，重複蓋章不長第二枚）。
   *
   * v1.1.1：沒命中時的新列改用**確定性 id**（uuid v5 of `node_id|due_on`，契約 §2.4），
   * 兩台裝置對同一班算出同一個 id ⇒ 合併時有「同一列」可談。`ON CONFLICT(id) DO UPDATE` 是為了
   * 「同一班被反悔過（soft delete）之後再蓋」——復活原來那一列，而不是插一列撞部分唯一索引。
   * 讀取仍先走 `SELECT … AND ${ALIVE}`：舊的隨機 id 列（本版之前建的）照樣命中、原地改寫。
   */
  private async stampOccurrence(
    db: Database,
    b: WriteBatch,
    nodeId: string,
    dueOn: string,
    status: OccurrenceStatus,
    completedAt: string | null,
  ): Promise<boolean> {
    const now = nowUtcIso();
    const existing = await db.select<{ id: string; status: OccurrenceStatus }[]>(
      `SELECT id, status FROM occurrences WHERE node_id = $1 AND due_on = $2 AND ${ALIVE}`,
      [nodeId, dueOn],
    );
    const hit = existing[0];
    if (hit) {
      if (hit.status === status) return false;
      b.stmts.push({
        sql: `UPDATE occurrences SET status = $1, completed_at = $2, updated_at = $3 WHERE id = $4`,
        args: [status, completedAt, now, hit.id],
      });
      addOp(b, "occurrences", hit.id, "upsert", { status, completed_at: completedAt, updated_at: now });
      return status === "done";
    }
    const occId = await occurrenceId(nodeId, dueOn);
    const existed = (await db.select<{ id: string }[]>(`SELECT id FROM occurrences WHERE id = $1`, [occId])).length > 0;
    b.stmts.push({
      sql: `INSERT INTO occurrences (id, node_id, due_on, status, completed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at,
         mood = NULL, deleted_at = NULL, updated_at = excluded.updated_at`,
      args: [occId, nodeId, dueOn, status, completedAt, now],
    });
    addOp(b, "occurrences", occId, "upsert", {
      node_id: nodeId,
      due_on: dueOn,
      status,
      completed_at: completedAt,
      deleted_at: null,
      // 同一班反悔再蓋＝復活舊列，本機不改 created_at；op 帶新值會讓兩台不一樣（同 writeRunTime）
      ...(existed ? {} : { created_at: now }),
      updated_at: now,
    });
    return true;
  }

  /** 反悔＝soft delete 這一列（同一班次之後還能再蓋，唯一索引只管存活列） */
  private dropOccurrence(b: WriteBatch, occId: string): void {
    const now = nowUtcIso();
    b.stmts.push({
      sql: `UPDATE occurrences SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
      args: [now, occId],
    });
    addOp(b, "occurrences", occId, "delete", { deleted_at: now, updated_at: now });
  }

  /**
   * 心情鏡射：nodes.mood 寫下去時，順手蓋到「現在顯示的那一班」上（沒有班次記錄就不寫）。
   *
   * v1.1.1：批次還沒 COMMIT，這裡從 DB 讀到的是**更新前**的節點——把這一次 patch 裡會影響判斷的兩欄
   * （status／scheduled_on）疊上去，語義才與 v1.1.0「先 UPDATE 再讀」逐點對等
   * （例：同一次 patch 帶 status:'done'＋mood，舊版讀到 done 就不鏡射）。
   * 鏡射結果當資料同步（契約 §2.7 #6）：對面那台不重跑鏡射，直接收這一欄。
   */
  private async mirrorMoodToOccurrence(
    db: Database,
    b: WriteBatch,
    nodeId: string,
    mood: string | null,
    patch: NodePatch,
    dateKey: string,
    dayStartHour: number,
  ): Promise<void> {
    const base = await this.getNode(nodeId);
    if (!base) return;
    const node: NodeRow = { ...base };
    if ("status" in patch && patch.status !== undefined) node.status = patch.status as NodeStatus;
    if ("scheduled_on" in patch) node.scheduled_on = (patch.scheduled_on ?? null) as string | null;
    if (!parseRule(node.repeat_rule) || node.status === "done") return;
    const occs = await this.occurrencesOf(db, nodeId);
    const target = pickTodayOccurrence(occs, node.scheduled_on, dateKey, dayStartHour);
    if (!target) return;
    const now = nowUtcIso();
    b.stmts.push({
      sql: `UPDATE occurrences SET mood = $1, updated_at = $2 WHERE id = $3`,
      args: [mood, now, target.id],
    });
    addOp(b, "occurrences", target.id, "upsert", { mood, updated_at: now });
  }

  /**
   * 單一節點的班次同步：算出目前班次日，變了才寫 `scheduled_on`；回傳有沒有變。
   *
   * ⚠ 偏離草案 §4 一處：**不清 `today_position`**。草案原意是「新聚合尾插」（r7），
   * 但定期券蓋済之後 scheduled_on 當場推到下一班，若同時清掉今日序，這一列會在同一次重整裡
   * 跳到清單最後——把 r2「當日完成留原位」打破。這個節點本來就進過今日，跨日保留相對序（r7 後半）
   * 才是對的；真正的新聚合（today_position IS NULL）仍由 listToday 的 lazy 指派尾插。
   *
   * v1.1.1：這一筆**不進 oplog**（契約 §2.7 #28）。它是「規則＋班次記錄」的純推導值，
   * 每台裝置的 `syncRepeats` 都會自己算出同一個答案；同步它只會讓兩台互推推導結果。
   * 仍走 `runWriteBatch`（ops 空）——所有寫入同一扇門，也不會吵醒 syncStore 的去抖 push。
   */
  private async syncNode(
    db: Database,
    id: string,
    dateKey: string,
    dayStartHour: number,
    known?: NodeRow,
  ): Promise<boolean> {
    const node = known ?? (await this.getNode(id));
    if (!node || node.deleted_at !== null) return false;
    const rule = parseRule(node.repeat_rule);
    if (!rule) return false;
    const occs = await this.occurrencesOf(db, id);
    if (node.status === "done") {
      // 退役（D-主-122）：執行日＝最後一班済的班次日（沒済過＝NULL）。以前這裡直接 return，值凍在各台最後算到的那天、
      // 兩台可能不同（#103）。**不碰 updated_at**：這是推導重算、不是內容修改（同 move() 的 S-8 原則）；
      // 退役票的 updated_at 兩台本來相同，戳了就會各自不同。活票那條路照舊（它的 updated_at 本來就各台不同，另案）。
      const f = retiredScheduledOn(occs);
      if (f === node.scheduled_on) return false;
      await runWriteBatch(db, [{ sql: `UPDATE nodes SET scheduled_on = $1 WHERE id = $2`, args: [f, id] }], []);
      return true;
    }
    const due = currentDue(rule, occs, dateKey, dayStartHour);
    if (due === null) {
      // 跑完到站（D-主-293）：status 是主人資料要進 oplog；兩台各自算到這裡寫的是同一個值，LWW 收斂。執行日照退役那條公式推導
      const at = endedCompletedAt(occs);
      const now = nowUtcIso();
      const b = newWriteBatch();
      b.stmts.push({
        sql: `UPDATE nodes SET status = 'done', completed_at = $1, scheduled_on = $2, updated_at = $3 WHERE id = $4`,
        args: [at, retiredScheduledOn(occs), now, id],
      });
      addOp(b, "nodes", id, "upsert", { status: "done", completed_at: at, updated_at: now });
      await runWriteBatch(db, b.stmts, b.ops);
      return true;
    }
    if (due === node.scheduled_on) return false;
    await runWriteBatch(
      db,
      [{ sql: `UPDATE nodes SET scheduled_on = $1, updated_at = $2 WHERE id = $3`, args: [due, nowUtcIso(), id] }],
      [],
    );
    return true;
  }

  /**
   * 剛被一起完成（退役）的定期券當場重算執行日，不等下一輪 syncRepeats——
   * 否則「先済再退役」那一列會帶著被推到明天的值，直到下次重整才回到最後一班（今日第四條吃這個值）。
   */
  private async syncRetired(
    db: Database,
    changed: readonly { id: string; repeat_rule: string | null }[],
    dateKey: string,
    dayStartHour: number,
  ): Promise<void> {
    for (const r of changed) {
      if (parseRule(r.repeat_rule)) await this.syncNode(db, r.id, dateKey, dayStartHour);
    }
  }

  // ───────────── 乘務記錄的系統事件（発券／入鋏／済）─────────────

  /**
   * 手記／系統事件都走這一扇門：語句與 op 累加進批次，由呼叫端的 `runWriteBatch` 一次落。
   * 事件是**資料不是推導**（契約 §2.7 #3）——對面那台不會自己長出発券／入鋏／済，得靠同步搬過去。
   */
  private writeLog(
    b: WriteBatch,
    nodeId: string,
    body: string,
    event: WorkLogEvent | null,
    at: string,
    /** 磨光⑦：列的寫入時刻（created_at／updated_at）；沒給＝at。補記的済 logged_at 是過去、寫入時刻照實是現在 */
    writtenAt: string = at,
  ): WorkLog {
    const id = uuid();
    b.stmts.push({
      sql: `INSERT INTO work_logs (id, node_id, body, logged_at, event, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      args: [id, nodeId, body, at, event, writtenAt],
    });
    addOp(b, "work_logs", id, "upsert", {
      node_id: nodeId,
      body,
      logged_at: at,
      event,
      created_at: writtenAt,
      updated_at: writtenAt,
    });
    return {
      id, node_id: nodeId, body, logged_at: at, event,
      account_id: null, device_id: null, created_at: at, updated_at: at, synced_at: null, deleted_at: null,
    };
  }

  private writeEvent(b: WriteBatch, nodeId: string, event: WorkLogEvent, at: string): void {
    this.writeLog(b, nodeId, "", event, at);
  }

  private async hasEvent(db: Database, nodeId: string, event: WorkLogEvent): Promise<boolean> {
    const rows = await db.select<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM work_logs WHERE node_id = $1 AND event = $2 AND ${ALIVE}`,
      [nodeId, event],
    );
    return (rows[0]?.c ?? 0) > 0;
  }

  /** 收回最新一枚該類事件（反悔完成＝拿掉這一次的済，不是全部）；沿專案慣例走 soft delete */
  private async revokeLatestEvent(
    db: Database,
    b: WriteBatch,
    nodeId: string,
    event: WorkLogEvent,
  ): Promise<void> {
    const rows = await db.select<{ id: string }[]>(
      `SELECT id FROM work_logs WHERE node_id = $1 AND event = $2 AND ${ALIVE}
       ORDER BY logged_at DESC, created_at DESC LIMIT 1`,
      [nodeId, event],
    );
    const target = rows[0]?.id;
    if (!target) return;
    const now = nowUtcIso();
    b.stmts.push({
      sql: `UPDATE work_logs SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
      args: [now, target],
    });
    addOp(b, "work_logs", target, "delete", { deleted_at: now, updated_at: now });
  }
}
