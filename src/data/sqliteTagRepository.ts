/**
 * SqliteTagRepository——TagRepository 的 SQLite 實作（tauri-plugin-sql 前端直連；旅客筆記車次③契約 §3.3–3.4）。
 *
 * 寫法照 `sqliteNoteRepository.ts`：每個公開寫入一個交易——語句與同步 op 累加進 `WriteBatch`，收尾
 * `runWriteBatch(db, b.stmts, b.ops)` 一次落；同一次手勢共用一個 `nowUtcIso()`。新列 op 帶白名單全部欄
 * （`src-tauri/src/sync/tables/notes.rs` 的 TAGS_COLS／TAGGINGS_COLS；`required` 缺欄整列會被對面跳過）。
 * 內文改寫走 `noteBodyUpdate`（與 noteRepo.update 的語句逐字相同）。
 *
 * 決定性 id 先算（uuid v5 是非同步的），再組批次。讀取一律 JOIN 實體存活（契約 0-12）。
 * 規則（解析、正規化、改名與刪除的計畫）都在 `src/domain/tags.ts`，本檔只執行計畫。
 */
import { getDb, nowUtcIso } from "../lib/db";
import { escapeLike } from "../domain/notes";
import type { NoteKind } from "../domain/notes";
import type { NodeKind, NodeStatus } from "../domain";
import {
  TAG_ENTITY_NODE_KINDS,
  TAGS_RECENT_KEY,
  deleteBody,
  normalizeName,
  parseTags,
  pushRecentKeys,
  renameBody,
  type DeletePlan,
  type RenamePlan,
  type TagIndexSource,
} from "../domain/tags";
import { nodeRepo, settingsRepo } from "./index";
import { noteBodyUpdate } from "./sqliteNoteRepository";
import { newWriteBatch, runWriteBatch } from "./syncRepository";
import { otherEntitiesAliveSql, uncountedTagEntityTypes } from "./tagEntityAlive";
import {
  emptyReceipt,
  tagId,
  taggingId,
  type AttachResult,
  type BackfillResult,
  type CreateTagResult,
  type SyncBodyResult,
  type TagEntityType,
  type TaggedItem,
  type TaggingRow,
  type TagReceipt,
  type TagRepository,
  type TagRow,
} from "./tagRepository";
import { pickNode, readRecent, recordTagBefore, recordTaggingBefore } from "./tagRepoShared";

type Db = Awaited<ReturnType<typeof getDb>>;

const NODE_KINDS_SQL = TAG_ENTITY_NODE_KINDS.map((k) => `'${k}'`).join(",");
/** backfill 每幾則一個交易（契約 §3.4 (j)） */
const BACKFILL_CHUNK = 50;

function placeholders(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(",");
}

/**
 * 一次手勢的暫存：讀到的列快取在這裡（同一批次裡改過的列以這裡為準），語句與 op 收進 `b`，改前值收進 `r`。
 * 最後 `commit()` 一次落。
 */
class Stage {
  readonly b = newWriteBatch();
  readonly r: TagReceipt = emptyReceipt();
  private readonly tagCache = new Map<string, TagRow | null>();
  private readonly tgCache = new Map<string, TaggingRow | null>();
  /** 本批次已發過「存活」op 的 tag id（新建、復活、touch）——同一列不重複 touch */
  private readonly liveTagOps = new Set<string>();
  private readonly db: Db;
  readonly now: string;

  constructor(db: Db, now: string) {
    this.db = db;
    this.now = now;
  }

  async getTag(id: string): Promise<TagRow | null> {
    if (!this.tagCache.has(id)) {
      const rows = await this.db.select<TagRow[]>(`SELECT * FROM tags WHERE id = $1`, [id]);
      this.tagCache.set(id, rows[0] ?? null);
    }
    return this.tagCache.get(id) ?? null;
  }
  async getTagging(id: string): Promise<TaggingRow | null> {
    if (!this.tgCache.has(id)) {
      const rows = await this.db.select<TaggingRow[]>(`SELECT * FROM taggings WHERE id = $1`, [id]);
      this.tgCache.set(id, rows[0] ?? null);
    }
    return this.tgCache.get(id) ?? null;
  }
  /** 已經 SELECT 過的列放進快取（避免逐列再查） */
  primeTaggings(rows: readonly TaggingRow[]): void {
    for (const g of rows) if (!this.tgCache.has(g.id)) this.tgCache.set(g.id, { ...g });
  }

  /** 建或復活荷札（見 MemoryTagRepository.ensureTag 的說明；語義相同） */
  async ensureTag(name: string, key: string, renameTo = false): Promise<{ row: TagRow; created: boolean }> {
    const id = await tagId(key);
    const row = await this.getTag(id);
    const now = this.now;
    if (!row) {
      const fresh: TagRow = { id, name, name_key: key, created_at: now, updated_at: now, deleted_at: null };
      this.tagCache.set(id, fresh);
      this.b.stmts.push({
        sql: `INSERT INTO tags (id, name, name_key, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)`,
        args: [id, name, key, now, now],
      });
      this.b.ops.push({ tbl: "tags", row_id: id, op: "upsert", cols: { name, name_key: key, created_at: now, updated_at: now, deleted_at: null } });
      this.r.createdTagIds.push(id);
      this.liveTagOps.add(id);
      return { row: fresh, created: true };
    }
    if (row.deleted_at !== null) {
      this.liveTagOps.add(id);
      recordTagBefore(this.r, row);
      row.deleted_at = null;
      row.updated_at = now;
      if (renameTo && row.name !== name) {
        row.name = name;
        this.b.stmts.push({ sql: `UPDATE tags SET deleted_at = NULL, name = $1, updated_at = $2 WHERE id = $3`, args: [name, now, id] });
        this.b.ops.push({ tbl: "tags", row_id: id, op: "upsert", cols: { name, deleted_at: null, updated_at: now } });
      } else {
        this.b.stmts.push({ sql: `UPDATE tags SET deleted_at = NULL, updated_at = $1 WHERE id = $2`, args: [now, id] });
        this.b.ops.push({ tbl: "tags", row_id: id, op: "upsert", cols: { deleted_at: null, updated_at: now } });
      }
      return { row, created: true };
    }
    return { row, created: false };
  }

  /**
   * 「用到這個荷札」的 touch：新掛（或復活）一筆 tagging 時，對它指向的存活 tag 發一筆 upsert
   * `{name, updated_at}`（不帶 deleted_at、收據不記——不是改前值）。
   *
   * 為什麼：A 改名 `#高`→`#難度/高`（`#高` soft delete）、B 離線同時在別張票掛 `#高`（B 本機 `#高` 還活著）——
   * 沒有這筆 op，B 的 tagging 會指向對面已刪的 tag、荷札無聲消失（契約 §7.4-2）。有了它，引擎的「編輯勝刪除」
   * （`engine.rs` 套 op 的 ②）兩個方向都成立：A 收到 B 這筆非 deleted_at 的併發編輯 ⇒ 復活；B 收到 A 的刪除、
   * 本列有 A 沒看過的編輯 ⇒ 拒收。兩台收斂成 `#高` 復活、與 `#難度/高` 並存。
   * 帶 `name`（值不變）是為了讓 A 那邊的 LWW 一定有欄採用——只帶 `updated_at` 時 B 若早於 A 的刪除就整筆輸掉、
   * 不觸發復活，而 B 那邊仍會拒收刪除，兩台分岔；帶 `deleted_at: null` 則會跳過復活分支，同樣分岔。
   */
  private async touchTag(tid: string): Promise<void> {
    if (this.liveTagOps.has(tid)) return;
    const t = await this.getTag(tid);
    if (!t || t.deleted_at !== null) return;
    this.liveTagOps.add(tid);
    t.updated_at = this.now;
    this.b.stmts.push({ sql: `UPDATE tags SET updated_at = $1 WHERE id = $2 AND deleted_at IS NULL`, args: [this.now, tid] });
    this.b.ops.push({ tbl: "tags", row_id: tid, op: "upsert", cols: { name: t.name, updated_at: this.now } });
  }

  async ensureTagging(entityType: TagEntityType, entityId: string, tid: string): Promise<{ already: boolean }> {
    const id = await taggingId(entityType, entityId, tid);
    const g = await this.getTagging(id);
    const now = this.now;
    if (!g || g.deleted_at !== null) await this.touchTag(tid);
    if (!g) {
      this.tgCache.set(id, { id, entity_type: entityType, entity_id: entityId, tag_id: tid, created_at: now, updated_at: now, deleted_at: null });
      this.b.stmts.push({
        sql: `INSERT INTO taggings (id, entity_type, entity_id, tag_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        args: [id, entityType, entityId, tid, now, now],
      });
      this.b.ops.push({
        tbl: "taggings",
        row_id: id,
        op: "upsert",
        cols: { entity_type: entityType, entity_id: entityId, tag_id: tid, created_at: now, updated_at: now, deleted_at: null },
      });
      this.r.createdTaggingIds.push(id);
      return { already: false };
    }
    if (g.deleted_at !== null) {
      recordTaggingBefore(this.r, g);
      g.deleted_at = null;
      g.updated_at = now;
      this.b.stmts.push({ sql: `UPDATE taggings SET deleted_at = NULL, updated_at = $1 WHERE id = $2`, args: [now, id] });
      this.b.ops.push({ tbl: "taggings", row_id: id, op: "upsert", cols: { deleted_at: null, updated_at: now } });
      return { already: false };
    }
    return { already: true };
  }

  softDeleteTagging(g: TaggingRow): void {
    if (g.deleted_at !== null) return;
    recordTaggingBefore(this.r, g);
    g.deleted_at = this.now;
    g.updated_at = this.now;
    this.b.stmts.push({ sql: `UPDATE taggings SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND deleted_at IS NULL`, args: [this.now, g.id] });
    this.b.ops.push({ tbl: "taggings", row_id: g.id, op: "delete", cols: { deleted_at: this.now, updated_at: this.now } });
  }
  softDeleteTag(t: TagRow): void {
    if (t.deleted_at !== null) return;
    recordTagBefore(this.r, t);
    t.deleted_at = this.now;
    t.updated_at = this.now;
    this.b.stmts.push({ sql: `UPDATE tags SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND deleted_at IS NULL`, args: [this.now, t.id] });
    this.b.ops.push({ tbl: "tags", row_id: t.id, op: "delete", cols: { deleted_at: this.now, updated_at: this.now } });
  }
  setTagName(t: TagRow, name: string): void {
    if (t.name === name) return;
    recordTagBefore(this.r, t);
    t.name = name;
    t.updated_at = this.now;
    this.b.stmts.push({ sql: `UPDATE tags SET name = $1, updated_at = $2 WHERE id = $3`, args: [name, this.now, t.id] });
    this.b.ops.push({ tbl: "tags", row_id: t.id, op: "upsert", cols: { name, updated_at: this.now } });
  }
  /** 改寫一則內文（收據記改前全文） */
  noteBody(id: string, before: string, after: string): void {
    if (!this.r.notesBefore.some((n) => n.id === id)) this.r.notesBefore.push({ id, body: before });
    const { stmt, op } = noteBodyUpdate(id, after, this.now);
    this.b.stmts.push(stmt);
    this.b.ops.push(op);
  }

  async commit(): Promise<void> {
    await runWriteBatch(this.db, this.b.stmts, this.b.ops);
  }
}

/** 某則筆記現有的存活掛載（tag 也存活）：key → tagging 列 */
type NoteHave = Map<string, { tag: TagRow; tagging: TaggingRow }>;

export class SqliteTagRepository implements TagRepository {
  /* ───────────── 讀 ───────────── */

  async loadIndexSource(): Promise<TagIndexSource> {
    const db = await getDb();
    const tags = await db.select<{ id: string; name: string; key: string }[]>(
      `SELECT id, name, name_key AS key FROM tags WHERE deleted_at IS NULL`,
    );
    // ＝契約 §3.4 (a) 的 EXISTS，改寫成 LEFT JOIN 以順手帶回實體種類（affectedCounts 用）
    const rows = await db.select<{ tag_id: string; entity_type: string; entity_id: string; kind: string | null }[]>(
      `SELECT g.tag_id, g.entity_type, g.entity_id, COALESCE(n.kind, x.kind) AS kind
       FROM taggings g
       LEFT JOIN nodes n ON g.entity_type = 'node' AND n.id = g.entity_id
       LEFT JOIN notes x ON g.entity_type = 'note' AND x.id = g.entity_id
       WHERE g.deleted_at IS NULL AND (
            (g.entity_type = 'node' AND n.id IS NOT NULL AND n.deleted_at IS NULL AND n.kind IN (${NODE_KINDS_SQL}))
         OR (g.entity_type = 'note' AND x.id IS NOT NULL AND x.deleted_at IS NULL)
         OR (${otherEntitiesAliveSql()}))`,
    );
    const kinds: Record<string, string> = {};
    const taggings = rows.map((r) => {
      if (r.kind) kinds[r.entity_id] = r.kind;
      return { tagId: r.tag_id, entityType: r.entity_type, entityId: r.entity_id };
    });
    // 磨光③ 0-1：登記了 counts:false 的類型（沒有＝不帶這個欄位，輸出同插槽之前）
    const uncounted = uncountedTagEntityTypes();
    return uncounted.length ? { tags, taggings, kinds, uncounted: [...uncounted] } : { tags, taggings, kinds };
  }

  async listTagsOf(entityType: TagEntityType, entityId: string): Promise<TagRow[]> {
    const db = await getDb();
    return db.select<TagRow[]>(
      `SELECT t.* FROM taggings g JOIN tags t ON t.id = g.tag_id
       WHERE g.deleted_at IS NULL AND t.deleted_at IS NULL AND g.entity_type = $1 AND g.entity_id = $2
       ORDER BY t.name_key`,
      [entityType, entityId],
    );
  }

  async listUnder(key: string, entityType?: TagEntityType): Promise<TaggedItem[]> {
    const db = await getDb();
    const tags = await db.select<{ id: string; name_key: string }[]>(
      `SELECT id, name_key FROM tags WHERE deleted_at IS NULL AND (name_key = $1 OR name_key LIKE $2 ESCAPE '\\')`,
      [key, escapeLike(key) + "/%"],
    );
    if (!tags.length) return [];
    const keyOf = new Map(tags.map((t) => [t.id, t.name_key]));
    const ids = tags.map((t) => t.id);
    const inList = placeholders(ids.length, 1);
    const want = (t: string) => !entityType || entityType === t;
    // 磨光③ 0-1：不算用量的類型不進「別處」（明指要那一種的除外）；沒登記＝SQL 同插槽之前
    const skip = uncountedTagEntityTypes().filter((t) => t !== entityType);
    const skipSql = skip.length ? ` AND g.entity_type NOT IN (${placeholders(skip.length, ids.length + 1)})` : "";
    type NodeHit = { entity_id: string; tag_id: string; id: string; name: string; kind: NodeKind; route_id: string | null; status: NodeStatus; scheduled_on: string | null; parent_id: string | null; repeat_rule: string | null };
    type NoteHit = { entity_id: string; tag_id: string; id: string; kind: NoteKind; title: string | null; body: string; entry_date: string | null; noted_at: string };
    const [nodes, notes, others] = await Promise.all([
      want("node")
        ? db.select<NodeHit[]>(
            `SELECT g.entity_id, g.tag_id, n.id, n.name, n.kind, n.route_id, n.status, n.scheduled_on, n.parent_id, n.repeat_rule
             FROM taggings g JOIN nodes n ON n.id = g.entity_id
             WHERE g.deleted_at IS NULL AND n.deleted_at IS NULL AND g.entity_type = 'node' AND n.kind IN (${NODE_KINDS_SQL})
               AND g.tag_id IN (${inList})`,
            ids,
          )
        : Promise.resolve([] as NodeHit[]),
      want("note")
        ? db.select<NoteHit[]>(
            `SELECT g.entity_id, g.tag_id, x.id, x.kind, x.title, x.body, x.entry_date, x.noted_at
             FROM taggings g JOIN notes x ON x.id = g.entity_id
             WHERE g.deleted_at IS NULL AND x.deleted_at IS NULL AND g.entity_type = 'note' AND g.tag_id IN (${inList})`,
            ids,
          )
        : Promise.resolve([] as NoteHit[]),
      entityType === "node" || entityType === "note"
        ? Promise.resolve([] as { entity_type: TagEntityType; entity_id: string; tag_id: string }[])
        : db.select<{ entity_type: TagEntityType; entity_id: string; tag_id: string }[]>(
            `SELECT g.entity_type, g.entity_id, g.tag_id FROM taggings g
             WHERE g.deleted_at IS NULL AND ${otherEntitiesAliveSql()} AND g.tag_id IN (${inList})${skipSql}`,
            skip.length ? [...ids, ...skip] : ids,
          ),
    ]);
    const out = new Map<string, TaggedItem>();
    const addKey = (it: TaggedItem, tid: string) => {
      const k = keyOf.get(tid);
      if (k && !it.matched.includes(k)) it.matched.push(k);
    };
    for (const r of nodes) {
      const ref = "node\u0001" + r.entity_id;
      let it = out.get(ref);
      if (!it) out.set(ref, (it = { kind: "node", id: r.entity_id, node: pickNode(r), matched: [] }));
      addKey(it, r.tag_id);
    }
    for (const r of notes) {
      const ref = "note\u0001" + r.entity_id;
      let it = out.get(ref);
      if (!it) {
        it = { kind: "note", id: r.entity_id, note: { id: r.id, kind: r.kind, title: r.title, body: r.body, entry_date: r.entry_date, noted_at: r.noted_at }, matched: [] };
        out.set(ref, it);
      }
      addKey(it, r.tag_id);
    }
    for (const r of others) {
      if (entityType && r.entity_type !== entityType) continue;
      const ref = r.entity_type + "\u0001" + r.entity_id;
      let it = out.get(ref);
      if (!it) out.set(ref, (it = { kind: "other", entityType: r.entity_type, id: r.entity_id, matched: [] }));
      addKey(it, r.tag_id);
    }
    const items = [...out.values()];
    for (const it of items) it.matched.sort();
    return items;
  }

  async recentKeys(): Promise<string[]> {
    return readRecent(settingsRepo);
  }

  /* ───────────── 寫 ───────────── */

  async attach(entityType: TagEntityType, entityId: string, rawName: string): Promise<AttachResult> {
    const n = normalizeName(rawName);
    if (!n.ok) throw new RangeError(n.reason);
    await assertAttachable(entityType, entityId);
    const st = new Stage(await getDb(), nowUtcIso());
    const { row, created } = await st.ensureTag(n.name, n.key);
    const { already } = await st.ensureTagging(entityType, entityId, row.id);
    await st.commit();
    return { key: n.key, name: row.name, created, already, receipt: st.r };
  }

  /** ＝attach 去掉 assertAttachable 與 ensureTagging（UI 丙-6 ☎-1；與 MemoryTagRepository.create 逐條對齊）。
   *  已存活時 ensureTag 不發語句——不開交易、收據空、created:false */
  async create(rawName: string): Promise<CreateTagResult> {
    const n = normalizeName(rawName);
    if (!n.ok) throw new RangeError(n.reason);
    const st = new Stage(await getDb(), nowUtcIso());
    const { row, created } = await st.ensureTag(n.name, n.key);
    if (created) await st.commit();
    return { key: n.key, name: row.name, created, receipt: st.r };
  }

  async detach(entityType: TagEntityType, entityId: string, key: string): Promise<TagReceipt> {
    const st = new Stage(await getDb(), nowUtcIso());
    const g = await st.getTagging(await taggingId(entityType, entityId, await tagId(key)));
    if (g && g.deleted_at === null) st.softDeleteTagging(g);
    await st.commit();
    return st.r;
  }

  async setTags(
    entityType: TagEntityType,
    entityId: string,
    rawNames: readonly string[],
  ): Promise<{ receipt: TagReceipt; created: string[] }> {
    await assertAttachable(entityType, entityId);
    const want = new Map<string, string>();
    for (const raw of rawNames) {
      const n = normalizeName(raw);
      if (n.ok && !want.has(n.key)) want.set(n.key, n.name);
    }
    const have = await this.listTagsOf(entityType, entityId);
    const st = new Stage(await getDb(), nowUtcIso());
    const created: string[] = [];
    for (const t of have) {
      if (want.has(t.name_key)) continue;
      const g = await st.getTagging(await taggingId(entityType, entityId, t.id));
      if (g) st.softDeleteTagging(g);
    }
    for (const [key, name] of want) {
      const { row, created: c } = await st.ensureTag(name, key);
      if (c) created.push(row.name);
      await st.ensureTagging(entityType, entityId, row.id);
    }
    await st.commit();
    return { receipt: st.r, created };
  }

  async syncBodyTags(noteId: string, body: string): Promise<SyncBodyResult> {
    const db = await getDb();
    const have = await this.noteHave(db, [noteId]);
    const st = new Stage(db, nowUtcIso());
    const res = await syncBodyInto(st, noteId, body, have.get(noteId) ?? new Map(), null);
    await st.commit();
    return res;
  }

  async backfill(): Promise<BackfillResult> {
    const db = await getDb();
    const notes = await db.select<{ id: string; body: string }[]>(
      `SELECT id, body FROM notes WHERE deleted_at IS NULL AND body LIKE '%#%' ORDER BY created_at`,
    );
    const all = new Set<string>();
    const created = new Set<string>();
    let places = 0;
    for (let i = 0; i < notes.length; i += BACKFILL_CHUNK) {
      const chunk = notes.slice(i, i + BACKFILL_CHUNK);
      const have = await this.noteHave(db, chunk.map((x) => x.id));
      const st = new Stage(db, nowUtcIso());
      for (const x of chunk) {
        const keys = new Set(parseTags(x.body).map((o) => o.key));
        keys.forEach((k) => all.add(k));
        places += keys.size;
        await syncBodyInto(st, x.id, x.body, have.get(x.id) ?? new Map(), created);
      }
      await st.commit();
    }
    return { tagCount: all.size, placeCount: places, createdTags: created.size };
  }

  async rename(plan: RenamePlan): Promise<TagReceipt> {
    if (!plan.ok) throw new RangeError(plan.reason);
    const db = await getDb();
    const st = new Stage(db, nowUtcIso());
    if (plan.same) {
      const row = await st.getTag(await tagId(plan.oldKey));
      if (row && row.deleted_at === null) st.setTagName(row, plan.newName);
      await st.commit();
      return st.r;
    }
    for (const m of plan.moves) {
      const fromId = await tagId(m.from);
      const { row: target } = await st.ensureTag(m.toName, m.to, true);
      const gs = await db.select<TaggingRow[]>(`SELECT * FROM taggings WHERE tag_id = $1 AND deleted_at IS NULL`, [fromId]);
      st.primeTaggings(gs);
      for (const g0 of gs) {
        const g = await st.getTagging(g0.id);
        if (!g || g.deleted_at !== null) continue;
        await st.ensureTagging(g.entity_type, g.entity_id, target.id);
        st.softDeleteTagging(g);
      }
      const src = await st.getTag(fromId);
      if (src) st.softDeleteTag(src);
    }
    for (const x of await bodiesWithHash(db)) {
      const next = renameBody(x.body, plan);
      if (next !== x.body) st.noteBody(x.id, x.body, next);
    }
    await st.commit();
    return st.r;
  }

  async remove(plan: DeletePlan): Promise<TagReceipt> {
    if (!plan.ok) throw new RangeError(plan.reason);
    const db = await getDb();
    const st = new Stage(db, nowUtcIso());
    for (const k of plan.keys) {
      const id = await tagId(k);
      const gs = await db.select<TaggingRow[]>(`SELECT * FROM taggings WHERE tag_id = $1 AND deleted_at IS NULL`, [id]);
      st.primeTaggings(gs);
      for (const g0 of gs) {
        const g = await st.getTagging(g0.id);
        if (g) st.softDeleteTagging(g);
      }
      const row = await st.getTag(id);
      if (row) st.softDeleteTag(row);
    }
    for (const x of await bodiesWithHash(db)) {
      const next = deleteBody(x.body, plan);
      if (next !== x.body) st.noteBody(x.id, x.body, next);
    }
    await st.commit();
    return st.r;
  }

  async undo(receipt: TagReceipt): Promise<void> {
    const db = await getDb();
    const st = new Stage(db, nowUtcIso());
    const now = st.now;
    for (const id of receipt.createdTaggingIds) {
      const g = await st.getTagging(id);
      if (g) st.softDeleteTagging(g);
    }
    for (const id of receipt.createdTagIds) {
      const t = await st.getTag(id);
      if (t) st.softDeleteTag(t);
    }
    for (const b of receipt.tagsBefore) {
      st.b.stmts.push({ sql: `UPDATE tags SET name = $1, deleted_at = $2, updated_at = $3 WHERE id = $4`, args: [b.name, b.deleted_at, now, b.id] });
      st.b.ops.push({ tbl: "tags", row_id: b.id, op: b.deleted_at === null ? "upsert" : "delete", cols: { name: b.name, deleted_at: b.deleted_at, updated_at: now } });
    }
    for (const b of receipt.taggingsBefore) {
      st.b.stmts.push({ sql: `UPDATE taggings SET deleted_at = $1, updated_at = $2 WHERE id = $3`, args: [b.deleted_at, now, b.id] });
      st.b.ops.push({ tbl: "taggings", row_id: b.id, op: b.deleted_at === null ? "upsert" : "delete", cols: { deleted_at: b.deleted_at, updated_at: now } });
    }
    for (const b of receipt.notesBefore) {
      const { stmt, op } = noteBodyUpdate(b.id, b.body, now);
      st.b.stmts.push(stmt);
      st.b.ops.push(op);
    }
    await st.commit();
  }

  async pushRecent(key: string): Promise<void> {
    const list = await readRecent(settingsRepo);
    await settingsRepo.set(TAGS_RECENT_KEY, JSON.stringify(pushRecentKeys(list, key)));
  }

  /* ───────────── 內部 ───────────── */

  /** 幾則筆記現有的存活掛載（tag 也存活） */
  private async noteHave(db: Db, noteIds: readonly string[]): Promise<Map<string, NoteHave>> {
    const out = new Map<string, NoteHave>();
    if (!noteIds.length) return out;
    const rows = await db.select<(TaggingRow & { t_name: string; t_key: string; t_created: string; t_updated: string })[]>(
      `SELECT g.*, t.name AS t_name, t.name_key AS t_key, t.created_at AS t_created, t.updated_at AS t_updated
       FROM taggings g JOIN tags t ON t.id = g.tag_id
       WHERE g.deleted_at IS NULL AND t.deleted_at IS NULL AND g.entity_type = 'note'
         AND g.entity_id IN (${placeholders(noteIds.length, 1)})`,
      [...noteIds],
    );
    for (const r of rows) {
      let m = out.get(r.entity_id);
      if (!m) out.set(r.entity_id, (m = new Map()));
      m.set(r.t_key, {
        tag: { id: r.tag_id, name: r.t_name, name_key: r.t_key, created_at: r.t_created, updated_at: r.t_updated, deleted_at: null },
        tagging: { id: r.id, entity_type: r.entity_type, entity_id: r.entity_id, tag_id: r.tag_id, created_at: r.created_at, updated_at: r.updated_at, deleted_at: null },
      });
    }
    return out;
  }
}

/** 內文→taggings 差集（契約 §3.4 (f)）：掛多的、摘少的；`created` 給了就收新建（含復活）的 key */
async function syncBodyInto(st: Stage, noteId: string, body: string, have: NoteHave, created: Set<string> | null): Promise<SyncBodyResult> {
  const want = new Map<string, string>();
  for (const o of parseTags(body)) if (!want.has(o.key)) want.set(o.key, o.name);
  const added: string[] = [];
  const removed: string[] = [];
  st.primeTaggings([...have.values()].map((h) => h.tagging));
  for (const [key, h] of have) {
    if (want.has(key)) continue;
    const g = await st.getTagging(h.tagging.id);
    if (g) {
      st.softDeleteTagging(g);
      removed.push(key);
    }
  }
  for (const [key, name] of want) {
    if (have.has(key)) continue;
    const { row, created: c } = await st.ensureTag(name, key);
    if (c && created) created.add(key);
    await st.ensureTagging("note", noteId, row.id);
    added.push(key);
  }
  return { added, removed };
}

/** 存活的筆記與日記（含收件匣）裡內文有 `#` 的（改名／刪除改寫內文的候選） */
function bodiesWithHash(db: Db): Promise<{ id: string; body: string }[]> {
  return db.select<{ id: string; body: string }[]>(`SELECT id, body FROM notes WHERE deleted_at IS NULL AND body LIKE '%#%'`);
}

async function assertAttachable(entityType: TagEntityType, entityId: string): Promise<void> {
  if (entityType !== "node") return;
  const n = await nodeRepo.getNode(entityId);
  if (!n || n.deleted_at !== null || !TAG_ENTITY_NODE_KINDS.includes(n.kind)) throw new RangeError("這裡掛不上荷札");
}

