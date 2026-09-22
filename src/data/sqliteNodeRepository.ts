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
 *
 * 同步總開關關著時（`sync_meta.enabled` ≠ '1'）：同步語句是 `INSERT … WHERE EXISTS(...)`，一列都不寫，
 * 行為與 v1.1.0 逐點對等——唯一的形狀差別是外面多包了一層 `BEGIN IMMEDIATE … COMMIT`。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { dayWindow, todayKey } from "../lib/date";
import {
  KIND_LABEL,
  allowedChildKinds,
  currentDue,
  parseRule,
  serializeRule,
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
  NodePatch,
  NodeRepository,
  RouteProgress,
  RouteProgressSeed,
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

// repeat_rule 不在這裡：寫規則的唯一入口是 setRepeatRule（update 收到會改道，M3 ④）
const PATCHABLE = new Set<string>([
  "name", "description", "color", "code", "status", "scheduled_on", "due_on", "priority",
  "estimate_min", "progress", "time_spent_min", "mood", "expected_on", "arrived_on",
  "carried_from", "route_id",
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

export class SqliteNodeRepository implements NodeRepository {
  async listSidebar(): Promise<SidebarData> {
    const db = await getDb();
    const rows = await db.select<NodeRow[]>(
      `SELECT * FROM nodes WHERE kind IN ('line','route','station') AND ${ALIVE}
       ORDER BY position ASC, created_at ASC`,
    );
    return {
      lines: rows.filter((r) => r.kind === "line"),
      routes: rows.filter((r) => r.kind === "route"),
      stations: rows.filter((r) => r.kind === "station"),
    };
  }

  async listRouteTree(routeId: string): Promise<NodeRow[]> {
    const db = await getDb();
    return db.select<NodeRow[]>(
      `SELECT * FROM nodes WHERE route_id = $1 AND kind != 'station' AND ${ALIVE}
       ORDER BY position ASC, created_at ASC`,
      [routeId],
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
    return rows[0] ?? null;
  }

  async create(input: CreateNodeInput): Promise<NodeRow> {
    const db = await getDb();
    const name = input.name.trim();
    if (!name) throw new Error("名稱不能空白");

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

    // 兄弟區：同父；根層以 kind 分區（幹線一區、臨時車票一區）
    const sibWhere = parent ? `parent_id = $1` : `parent_id IS NULL AND kind = $1`;
    const sibArg = parent ? parent.id : input.kind;
    const now = nowUtcIso();
    const b = newWriteBatch();
    let position: number;
    if (input.afterId) {
      const after = await this.getNode(input.afterId);
      if (!after) throw new Error("afterId 不存在");
      position = after.position + 1;
      // 被擠開的鄰居也是主人資料：先問「是誰、原本排第幾」，UPDATE 順手補戳 updated_at（盲探 U1），
      // 每一列各記一筆 op——否則對面那台不知道兄弟序動過（契約 §2.7 #1）
      const shifted = await db.select<{ id: string; position: number }[]>(
        `SELECT id, position FROM nodes WHERE ${sibWhere} AND position >= $2 AND ${ALIVE}`,
        [sibArg, position],
      );
      if (shifted.length) {
        b.stmts.push({
          sql: `UPDATE nodes SET position = position + 1, updated_at = $3 WHERE ${sibWhere} AND position >= $2 AND ${ALIVE}`,
          args: [sibArg, position, now],
        });
        for (const s of shifted) {
          addOp(b, "nodes", s.id, "upsert", { position: s.position + 1, updated_at: now });
        }
      }
    } else {
      const r = await db.select<{ m: number | null }[]>(
        `SELECT MAX(position) AS m FROM nodes WHERE ${sibWhere} AND ${ALIVE}`,
        [sibArg],
      );
      position = (r[0]?.m ?? -1) + 1;
    }

    const id = uuid();
    b.stmts.push({
      sql: `INSERT INTO nodes
         (id, kind, parent_id, line_id, route_id, name, description, position, color, code, scheduled_on, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      args: [
        id, input.kind, parent?.id ?? null, lineId, routeId, name,
        input.description ?? null, position, input.color ?? null, input.code ?? null,
        input.scheduledOn ?? null, now, now,
      ],
    });
    const cols: Record<string, unknown> = {
      kind: input.kind,
      parent_id: parent?.id ?? null,
      name,
      description: input.description ?? null,
      position,
      color: input.color ?? null,
      code: input.code ?? null,
      scheduled_on: input.scheduledOn ?? null,
      created_at: now,
      updated_at: now,
    };
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
    }

    const now = nowUtcIso();
    const b = newWriteBatch();
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
    const kids = await db.select<{ kind: NodeKind }[]>(
      `SELECT DISTINCT kind FROM nodes WHERE parent_id = $1 AND ${ALIVE}`,
      [id],
    );
    const ok = allowedChildKinds(kind);
    const bad = kids.find((k) => !ok.includes(k.kind));
    if (bad) throw new Error(`底下還有${KIND_LABEL[bad.kind]}，不能轉為${KIND_LABEL[kind]}`);
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({ sql: `UPDATE nodes SET kind = $1, updated_at = $2 WHERE id = $3`, args: [kind, now, id] });
    addOp(b, "nodes", id, "upsert", { kind, updated_at: now });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async move(id: string, newParentId: string | null, index: number, newKind?: NodeKind): Promise<void> {
    const db = await getDb();
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

    const now = nowUtcIso();
    const b = newWriteBatch();
    let lineId: string | null;
    let routeId: string | null;
    if (newParent) {
      lineId = newParent.kind === "line" ? newParent.id : newParent.line_id;
      routeId = newParent.kind === "route" ? newParent.id : newParent.route_id;
    } else {
      lineId = null;
      routeId = node.kind === "ticket" ? node.route_id : null; // 臨時車票保留路線標籤
    }
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
    if (node.kind !== "route" && routeId !== node.route_id) {
      b.stmts.push({
        sql: `UPDATE nodes SET route_id = $1 WHERE id IN (${placeholders(sub.length, 2)})`,
        args: [routeId, ...sub],
      });
    }

    const sibWhere = newParent ? `parent_id = $1` : `parent_id IS NULL AND kind = $1`;
    const sibArg = newParent ? newParent.id : node.kind;
    // 目標兄弟區的位移：同 #1，補戳 updated_at＋逐列記 op
    const shifted = await db.select<{ id: string; position: number }[]>(
      `SELECT id, position FROM nodes WHERE ${sibWhere} AND position >= $2 AND id != $3 AND ${ALIVE}`,
      [sibArg, index, id],
    );
    if (shifted.length) {
      b.stmts.push({
        sql: `UPDATE nodes SET position = position + 1, updated_at = $4 WHERE ${sibWhere} AND position >= $2 AND id != $3 AND ${ALIVE}`,
        args: [sibArg, index, id, now],
      });
      for (const s of shifted) {
        addOp(b, "nodes", s.id, "upsert", { position: s.position + 1, updated_at: now });
      }
    }
    b.stmts.push({
      sql: `UPDATE nodes SET parent_id = $1, position = $2, kind = $3, updated_at = $4 WHERE id = $5`,
      args: [newParent?.id ?? null, index, kind, now, id],
    });
    addOp(b, "nodes", id, "upsert", {
      parent_id: newParent?.id ?? null,
      position: index,
      kind,
      updated_at: now,
      // 搬到根層的車票：`route_id` 從快取變成**資料**（臨時車票的路線標籤），這一筆必須進 op。
      // 評審 S5：漏了它，單向下因為「副本重算出來的快取值恰好等於標籤值」而僥倖一致，
      // 雙向一開就分歧。非根層（newParent 有值）不帶——那時它又只是快取，副本自己重算。
      ...(!newParent && kind === "ticket" ? { route_id: routeId } : {}),
    });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async softDelete(id: string): Promise<string[]> {
    const db = await getDb();
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
        const due = node.scheduled_on ?? currentDue(rule, await this.occurrencesOf(db, id), dateKey, dayStartHour);
        if (due) {
          const wrote = await this.stampOccurrence(db, b, id, due, "done", now);
          if (wrote) this.writeEvent(b, id, "done", now);
        }
      } else {
        const occs = await this.occurrencesOf(db, id);
        const target = pickTodayOccurrence(occs, node.scheduled_on, dateKey, dayStartHour);
        if (target) {
          this.dropOccurrence(b, target.id);
          if (target.status === "done") await this.revokeLatestEvent(db, b, id, "done");
        }
      }
      await runWriteBatch(db, b.stmts, b.ops);
      // syncNode 排在 COMMIT 之後（不能併進上面那個交易）：它要讀得到剛剛寫下的班次記錄才算得對下一班。
      // 本身是推導、不進 oplog，所以拆成兩個交易不會讓同步少掉任何一筆主人資料。
      await this.syncNode(db, id, dateKey, dayStartHour);
      // 連帶完成：子樹裡的定期券照 D2 退役（status='done'），不寫 occurrence——走下面的一般路徑
      if (done && opts?.cascade) {
        const sub = (await subtreeIds(db, id)).filter((x) => x !== id);
        if (sub.length) {
          const changed = await db.select<{ id: string }[]>(
            `SELECT id FROM nodes WHERE id IN (${placeholders(sub.length, 1)}) AND status != 'done'`,
            sub,
          );
          const cb = newWriteBatch();
          cb.stmts.push({
            sql: `UPDATE nodes SET status = 'done', completed_at = $1, updated_at = $1
             WHERE id IN (${placeholders(sub.length, 2)}) AND status != 'done'`,
            args: [now, ...sub],
          });
          for (const r of changed) {
            addOp(cb, "nodes", r.id, "upsert", { status: "done", completed_at: now, updated_at: now });
            this.writeEvent(cb, r.id, "done", now);
          }
          await runWriteBatch(db, cb.stmts, cb.ops);
          ids.push(...sub);
        }
      }
      return ids;
    }

    if (done) {
      const ids = opts?.cascade ? await subtreeIds(db, id) : [id];
      // 先問「這一輪誰真的從未完成變成完成」，済只給他們（重複蓋章不會長出第二枚）
      const changed = await db.select<{ id: string }[]>(
        `SELECT id FROM nodes WHERE id IN (${placeholders(ids.length, 1)}) AND status != 'done'`,
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
      return ids;
    }

    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE nodes SET status = 'todo', completed_at = NULL, updated_at = $1 WHERE id = $2`,
      args: [now, id],
    });
    addOp(b, "nodes", id, "upsert", { status: "todo", completed_at: null, updated_at: now });
    // 反悔完成：只收回「該次」済（最新一枚），舊的完成史留著
    await this.revokeLatestEvent(db, b, id, "done");
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
    const raw = await db.select<(NodeRow & { child_total: number; child_done: number })[]>(
      `SELECT r.*,
              (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = r.id AND c.${ALIVE}) AS child_total,
              (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = r.id AND c.${ALIVE} AND c.status = 'done') AS child_done
       FROM nodes r
       WHERE r.${ALIVE}
         AND r.kind IN ('train','car','ticket')
         AND (
              r.scheduled_on = $1
           OR (r.scheduled_on IS NOT NULL AND r.scheduled_on < $1 AND r.status != 'done')
           OR (r.status != 'done' AND r.due_on IS NOT NULL AND r.due_on <= $1
               AND (r.scheduled_on IS NULL OR r.scheduled_on > $1))
           OR (r.status = 'done' AND r.completed_at IS NOT NULL AND r.completed_at >= $2 AND r.completed_at < $3
               AND (
                    (r.scheduled_on IS NOT NULL AND r.scheduled_on <= $1)
                 OR (r.scheduled_on IS NULL AND r.due_on IS NOT NULL AND r.due_on <= $1)
               ))
           OR (r.repeat_rule IS NOT NULL AND r.status != 'done' AND EXISTS (
                 SELECT 1 FROM occurrences o
                 WHERE o.node_id = r.id AND o.${ALIVE}
                   AND COALESCE(o.completed_at, o.updated_at) >= $2
                   AND COALESCE(o.completed_at, o.updated_at) < $3))
         )`,
      [dateKey, start, end],
    );
    // 第五條 OR＝定期券變體（r2 的定期券版）：蓋済／運休之後 scheduled_on 已被引擎推到下一班，
    // 「今天交代過的那一班」只能靠 occurrence 的時刻戳留在清單裡。活著的定期券 status 恆非 done，
    // 所以第四條（原樣）碰不到它；退役的定期券反過來只走第四條。

    // 這一輪出現的定期券，把班次記錄撈回來配對（一次查完，不逐列往返）
    const repeatIds = raw.filter((n) => n.status !== "done" && parseRule(n.repeat_rule)).map((n) => n.id);
    const occByNode = await this.occurrencesByNode(db, repeatIds);

    const rows: TodayRow[] = raw.map((n) => {
      const occ = repeatIds.includes(n.id)
        ? pickTodayOccurrence(occByNode[n.id] ?? [], n.scheduled_on, dateKey, dayStartHour)
        : null;
      return {
        ...n,
        serial: serials[n.id] ?? "",
        // 分區用「班次日」：蓋済留原位（今天）／漏班進誤點帶原定 M/D（D-④-4）
        bucket: todayBucketOf(n, dateKey, occ ? occ.due_on : n.scheduled_on),
        occurrence: occ ? toCurrentOccurrence(occ) : null,
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
    const ids = rows.filter((r) => r.bucket === "today").map((r) => r.id);
    if (!ids.includes(id)) throw new Error("這張票不在今天的清單裡");
    await this.assignTodayPositions(reorderIds(ids, id, index));
  }

  async setRouteTag(ticketId: string, routeId: string | null): Promise<void> {
    await this.update(ticketId, { route_id: routeId });
  }

  async reschedule(id: string, nextDate: string | null, todayDateKey: string): Promise<void> {
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
    const b = newWriteBatch();
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
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async search(query: string, limit = 50): Promise<NodeRow[]> {
    const q = query.trim();
    if (!q) return [];
    const db = await getDb();
    return db.select<NodeRow[]>(
      `SELECT * FROM nodes WHERE ${ALIVE} AND kind != 'line' AND name LIKE $1
       ORDER BY updated_at DESC LIMIT $2`,
      [`%${q}%`, limit],
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
        throw new Error(`${KIND_LABEL[node.kind]}不能設重複——只有車票與無子項的列車／車廂可以`);
      }
      const kids = await db.select<{ c: number }[]>(
        `SELECT COUNT(*) AS c FROM nodes WHERE parent_id = $1 AND ${ALIVE}`,
        [id],
      );
      if ((kids[0]?.c ?? 0) > 0) throw new Error("有子項的列車／車廂不能設重複（v1）");
      if (!parseRule(serializeRule(rule))) throw new Error("重複規則格式不正確");
    }
    const serialized = rule ? serializeRule(rule) : null;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE nodes SET repeat_rule = $1, updated_at = $2 WHERE id = $3`,
      args: [serialized, now, id],
    });
    const cols: Record<string, unknown> = { repeat_rule: serialized, updated_at: now };
    // 清規則＝票變回乘車券（D-④-5）：scheduled_on 從「引擎推導值」轉為主人資料，這一刻起要同步。
    // 值沒變，但對面那台從此不會再自己算它——所以得把現值帶過去一次（契約 §2.7 #23）。
    if (!rule) cols.scheduled_on = node.scheduled_on;
    addOp(b, "nodes", id, "upsert", cols);
    await runWriteBatch(db, b.stmts, b.ops);
    // 掛規則＝立刻算出目前班次日；清規則＝scheduled_on 留在現值（票變回乘車券，D-④-5）
    if (rule) await this.syncNode(db, id, dateKey, dayStartHour);
  }

  async syncRepeats(dateKey: string, dayStartHour = 3): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<NodeRow[]>(
      `SELECT * FROM nodes WHERE ${ALIVE} AND repeat_rule IS NOT NULL AND status != 'done'`,
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
    if (!rule || node.status === "done") throw new Error(REPEAT_ONLY_MSG);
    const occs = await this.occurrencesOf(db, id);
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
      if (target && target.status === "skipped") this.dropOccurrence(b, target.id);
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
    const nodes = await db.select<NodeRow[]>(
      `SELECT * FROM nodes WHERE ${ALIVE} AND kind IN ('train','car','ticket')`,
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
    const nodes = await db.select<NodeRow[]>(
      `SELECT * FROM nodes WHERE ${ALIVE} AND kind IN ('train','car','ticket')`,
    );
    const repeatIds = nodes.filter((n) => parseRule(n.repeat_rule)).map((n) => n.id);
    const occByNode = await this.occurrencesByNode(db, repeatIds);
    return buildCalendar(nodes, occByNode, from, to, today, dayStartHour);
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
      created_at: now,
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
    dateKey: string = todayKey(),
    dayStartHour = 3,
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
    if (!node || node.deleted_at !== null || node.status === "done") return false;
    const rule = parseRule(node.repeat_rule);
    if (!rule) return false;
    const occs = await this.occurrencesOf(db, id);
    const due = currentDue(rule, occs, dateKey, dayStartHour);
    if (due === null || due === node.scheduled_on) return false;
    await runWriteBatch(
      db,
      [{ sql: `UPDATE nodes SET scheduled_on = $1, updated_at = $2 WHERE id = $3`, args: [due, nowUtcIso(), id] }],
      [],
    );
    return true;
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
  ): WorkLog {
    const id = uuid();
    b.stmts.push({
      sql: `INSERT INTO work_logs (id, node_id, body, logged_at, event, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      args: [id, nodeId, body, at, event, at],
    });
    addOp(b, "work_logs", id, "upsert", {
      node_id: nodeId,
      body,
      logged_at: at,
      event,
      created_at: at,
      updated_at: at,
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
