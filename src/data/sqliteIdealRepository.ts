/**
 * 車窓・理想手札與「車窓の問い」的 SQLite 實作（第六本第四梯 v1.30）。
 *
 * 一支寫入＝一個 WriteBatch（資料語句與同步 op 同批原子送出）、只送變動欄、新列與復活送完整列。
 */
import type Database from "@tauri-apps/plugin-sql";
import { getDb, nowUtcIso, uuid } from "../lib/db";
import { escapeLike } from "../lib/sql";
import { newWriteBatch, runWriteBatch, type WriteBatch } from "./syncRepository";
import type { IdealRepository } from "./idealRepository";
import {
  defaultArtForTheme,
  isIdealArtPreset,
  isIdealTheme,
  isWindowCategory,
  validatePhotoDataUrl,
  type CreateIdealCardInput,
  type CreateReflectionInput,
  type IdealCardRow,
  type IdealReflectionRow,
  type UpdateIdealCardPatch,
  type UpdateReflectionPatch,
} from "../domain/idealTecho";

const ALIVE = "deleted_at IS NULL";

function unpinOthersInBatch(
  b: WriteBatch,
  now: string,
  pinnedCards: readonly { id: string }[],
  pinnedRefs: readonly { id: string }[],
  keep?: { kind: "card" | "reflection"; id: string } | null,
): void {
  for (const c of pinnedCards) {
    if (keep?.kind === "card" && keep.id === c.id) continue;
    b.stmts.push({
      sql: `UPDATE ideal_cards SET pinned = 0, updated_at = $1 WHERE id = $2`,
      args: [now, c.id],
    });
    b.ops.push({ tbl: "ideal_cards", row_id: c.id, op: "upsert", cols: { pinned: 0, updated_at: now } });
  }
  for (const r of pinnedRefs) {
    if (keep?.kind === "reflection" && keep.id === r.id) continue;
    b.stmts.push({
      sql: `UPDATE ideal_reflections SET pinned = 0, updated_at = $1 WHERE id = $2`,
      args: [now, r.id],
    });
    b.ops.push({ tbl: "ideal_reflections", row_id: r.id, op: "upsert", cols: { pinned: 0, updated_at: now } });
  }
}

export class SqliteIdealRepository implements IdealRepository {
  private async cardRow(db: Database, id: string): Promise<IdealCardRow | null> {
    const rows = await db.select<IdealCardRow[]>(`SELECT * FROM ideal_cards WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async reflectionRow(db: Database, id: string): Promise<IdealReflectionRow | null> {
    const rows = await db.select<IdealReflectionRow[]>(`SELECT * FROM ideal_reflections WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  private async pinnedIds(db: Database): Promise<{ cards: { id: string }[]; refs: { id: string }[] }> {
    const [cards, refs] = await Promise.all([
      db.select<{ id: string }[]>(`SELECT id FROM ideal_cards WHERE ${ALIVE} AND pinned = 1`),
      db.select<{ id: string }[]>(`SELECT id FROM ideal_reflections WHERE ${ALIVE} AND pinned = 1`),
    ]);
    return { cards, refs };
  }

  async listCards(): Promise<IdealCardRow[]> {
    const db = await getDb();
    return db.select<IdealCardRow[]>(
      `SELECT * FROM ideal_cards WHERE ${ALIVE} ORDER BY theme, position, created_at, id`,
    );
  }

  async getCard(id: string, opts?: { withDeleted?: boolean }): Promise<IdealCardRow | null> {
    const db = await getDb();
    const r = await this.cardRow(db, id);
    if (!r) return null;
    return r.deleted_at !== null && !opts?.withDeleted ? null : r;
  }

  async createCard(input: CreateIdealCardInput): Promise<IdealCardRow> {
    const title = input.title.trim();
    if (!title) throw new RangeError("請填寫風景卡標題");
    const theme = isIdealTheme(input.theme) ? input.theme : "person";
    const body = (input.body ?? "").trim();
    const motto = (input.motto ?? "").trim();
    const artPreset = isIdealArtPreset(input.artPreset) ? input.artPreset : defaultArtForTheme(theme);
    const photoData = validatePhotoDataUrl(input.photoData);
    const pinned = input.pinned ? 1 : 0;

    const db = await getDb();
    const maxRows = await db.select<{ m: number | null }[]>(
      `SELECT MAX(position) AS m FROM ideal_cards WHERE ${ALIVE} AND theme = $1`,
      [theme],
    );
    const position = (maxRows[0]?.m ?? -1) + 1;
    const now = nowUtcIso();
    const id = uuid();
    const b = newWriteBatch();

    if (pinned) {
      const cur = await this.pinnedIds(db);
      unpinOthersInBatch(b, now, cur.cards, cur.refs, { kind: "card", id });
    }

    b.stmts.push({
      sql: `INSERT INTO ideal_cards (id, theme, title, body, motto, art_preset, photo_data, pinned, position, created_at, updated_at, deleted_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)`,
      args: [id, theme, title, body, motto, artPreset, photoData, pinned, position, now, now],
    });
    b.ops.push({
      tbl: "ideal_cards",
      row_id: id,
      op: "upsert",
      cols: {
        theme,
        title,
        body,
        motto,
        art_preset: artPreset,
        photo_data: photoData,
        pinned,
        position,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    });
    await runWriteBatch(db, b.stmts, b.ops);
    return {
      id,
      theme,
      title,
      body,
      motto,
      art_preset: artPreset,
      photo_data: photoData,
      pinned,
      position,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
  }

  async updateCard(id: string, patch: UpdateIdealCardPatch): Promise<IdealCardRow> {
    const db = await getDb();
    const cur = await this.cardRow(db, id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這張手札風景卡");

    const now = nowUtcIso();
    const b = newWriteBatch();
    const sets: string[] = [];
    const args: unknown[] = [];
    const cols: Record<string, unknown> = {};
    const put = (col: string, val: unknown) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
      cols[col] = val;
    };

    const next: IdealCardRow = { ...cur };
    if (patch.theme !== undefined && isIdealTheme(patch.theme) && patch.theme !== cur.theme) {
      put("theme", patch.theme);
      next.theme = patch.theme;
    }
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new RangeError("請填寫風景卡標題");
      if (t !== cur.title) {
        put("title", t);
        next.title = t;
      }
    }
    if (patch.body !== undefined) {
      const bd = patch.body.trim();
      if (bd !== cur.body) {
        put("body", bd);
        next.body = bd;
      }
    }
    if (patch.motto !== undefined) {
      const mt = patch.motto.trim();
      if (mt !== cur.motto) {
        put("motto", mt);
        next.motto = mt;
      }
    }
    if (patch.artPreset !== undefined && isIdealArtPreset(patch.artPreset) && patch.artPreset !== cur.art_preset) {
      put("art_preset", patch.artPreset);
      next.art_preset = patch.artPreset;
    }
    if (patch.photoData !== undefined) {
      const pd = validatePhotoDataUrl(patch.photoData);
      if (pd !== cur.photo_data) {
        put("photo_data", pd);
        next.photo_data = pd;
      }
    }
    if (patch.position !== undefined && patch.position !== cur.position) {
      put("position", patch.position);
      next.position = patch.position;
    }
    if (patch.pinned !== undefined) {
      const pinVal = patch.pinned ? 1 : 0;
      if (pinVal !== cur.pinned) {
        if (pinVal === 1) {
          const p = await this.pinnedIds(db);
          unpinOthersInBatch(b, now, p.cards, p.refs, { kind: "card", id });
        }
        put("pinned", pinVal);
        next.pinned = pinVal;
      }
    }

    if (sets.length === 0) return cur;
    put("updated_at", now);
    next.updated_at = now;
    args.push(id);
    b.stmts.push({
      sql: `UPDATE ideal_cards SET ${sets.join(", ")} WHERE id = $${args.length}`,
      args,
    });
    b.ops.push({ tbl: "ideal_cards", row_id: id, op: "upsert", cols });
    await runWriteBatch(db, b.stmts, b.ops);
    return next;
  }

  async deleteCard(id: string): Promise<void> {
    const db = await getDb();
    const cur = await this.cardRow(db, id);
    if (!cur || cur.deleted_at !== null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE ideal_cards SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
      args: [now, id],
    });
    b.ops.push({ tbl: "ideal_cards", row_id: id, op: "delete", cols: { deleted_at: now, updated_at: now } });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async restoreCard(id: string): Promise<void> {
    const db = await getDb();
    const r = await this.cardRow(db, id);
    if (!r) throw new RangeError("找不到這張手札風景卡");
    if (r.deleted_at === null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE ideal_cards SET deleted_at = NULL, updated_at = $1 WHERE id = $2`,
      args: [now, id],
    });
    b.ops.push({
      tbl: "ideal_cards",
      row_id: id,
      op: "upsert",
      cols: {
        theme: r.theme,
        title: r.title,
        body: r.body,
        motto: r.motto,
        art_preset: r.art_preset,
        photo_data: r.photo_data,
        pinned: r.pinned,
        position: r.position,
        created_at: r.created_at,
        updated_at: now,
        deleted_at: null,
      },
    });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async listReflections(): Promise<IdealReflectionRow[]> {
    const db = await getDb();
    return db.select<IdealReflectionRow[]>(
      `SELECT * FROM ideal_reflections WHERE ${ALIVE} ORDER BY answered_on DESC, created_at DESC, id`,
    );
  }

  async getReflection(id: string, opts?: { withDeleted?: boolean }): Promise<IdealReflectionRow | null> {
    const db = await getDb();
    const r = await this.reflectionRow(db, id);
    if (!r) return null;
    return r.deleted_at !== null && !opts?.withDeleted ? null : r;
  }

  async createReflection(input: CreateReflectionInput): Promise<IdealReflectionRow> {
    const question = input.question.trim();
    const answer = input.answer.trim();
    const promptKey = input.promptKey.trim();
    if (!question) throw new RangeError("題目不能空白");
    if (!answer) throw new RangeError("請寫下此刻的想法再收進手札");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.answeredOn)) throw new RangeError("作答日期格式不正確");

    const category = isWindowCategory(input.category) ? input.category : "daily";
    const diaryNoteId = input.diaryNoteId ?? null;
    const pinned = input.pinned ? 1 : 0;

    const db = await getDb();
    const now = nowUtcIso();
    const id = uuid();
    const b = newWriteBatch();

    if (pinned) {
      const p = await this.pinnedIds(db);
      unpinOthersInBatch(b, now, p.cards, p.refs, { kind: "reflection", id });
    }

    b.stmts.push({
      sql: `INSERT INTO ideal_reflections (id, prompt_key, category, question, answer, answered_on, diary_note_id, pinned, created_at, updated_at, deleted_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
      args: [id, promptKey, category, question, answer, input.answeredOn, diaryNoteId, pinned, now, now],
    });
    b.ops.push({
      tbl: "ideal_reflections",
      row_id: id,
      op: "upsert",
      cols: {
        prompt_key: promptKey,
        category,
        question,
        answer,
        answered_on: input.answeredOn,
        diary_note_id: diaryNoteId,
        pinned,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      },
    });
    await runWriteBatch(db, b.stmts, b.ops);
    return {
      id,
      prompt_key: promptKey,
      category,
      question,
      answer,
      answered_on: input.answeredOn,
      diary_note_id: diaryNoteId,
      pinned,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
  }

  async updateReflection(id: string, patch: UpdateReflectionPatch): Promise<IdealReflectionRow> {
    const db = await getDb();
    const cur = await this.reflectionRow(db, id);
    if (!cur || cur.deleted_at !== null) throw new RangeError("找不到這則車窓問答");

    const now = nowUtcIso();
    const b = newWriteBatch();
    const sets: string[] = [];
    const args: unknown[] = [];
    const cols: Record<string, unknown> = {};
    const put = (col: string, val: unknown) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
      cols[col] = val;
    };

    const next: IdealReflectionRow = { ...cur };
    if (patch.question !== undefined) {
      const q = patch.question.trim();
      if (!q) throw new RangeError("題目不能空白");
      if (q !== cur.question) {
        put("question", q);
        next.question = q;
      }
    }
    if (patch.answer !== undefined) {
      const a = patch.answer.trim();
      if (!a) throw new RangeError("回答內容不能空白");
      if (a !== cur.answer) {
        put("answer", a);
        next.answer = a;
      }
    }
    if (patch.answeredOn !== undefined && patch.answeredOn !== cur.answered_on) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.answeredOn)) throw new RangeError("作答日期格式不正確");
      put("answered_on", patch.answeredOn);
      next.answered_on = patch.answeredOn;
    }
    if (patch.diaryNoteId !== undefined && patch.diaryNoteId !== cur.diary_note_id) {
      put("diary_note_id", patch.diaryNoteId);
      next.diary_note_id = patch.diaryNoteId;
    }
    if (patch.pinned !== undefined) {
      const pinVal = patch.pinned ? 1 : 0;
      if (pinVal !== cur.pinned) {
        if (pinVal === 1) {
          const p = await this.pinnedIds(db);
          unpinOthersInBatch(b, now, p.cards, p.refs, { kind: "reflection", id });
        }
        put("pinned", pinVal);
        next.pinned = pinVal;
      }
    }

    if (sets.length === 0) return cur;
    put("updated_at", now);
    next.updated_at = now;
    args.push(id);
    b.stmts.push({
      sql: `UPDATE ideal_reflections SET ${sets.join(", ")} WHERE id = $${args.length}`,
      args,
    });
    b.ops.push({ tbl: "ideal_reflections", row_id: id, op: "upsert", cols });
    await runWriteBatch(db, b.stmts, b.ops);
    return next;
  }

  async deleteReflection(id: string): Promise<void> {
    const db = await getDb();
    const cur = await this.reflectionRow(db, id);
    if (!cur || cur.deleted_at !== null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE ideal_reflections SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
      args: [now, id],
    });
    b.ops.push({ tbl: "ideal_reflections", row_id: id, op: "delete", cols: { deleted_at: now, updated_at: now } });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async restoreReflection(id: string): Promise<void> {
    const db = await getDb();
    const r = await this.reflectionRow(db, id);
    if (!r) throw new RangeError("找不到這則車窓問答");
    if (r.deleted_at === null) return;
    const now = nowUtcIso();
    const b = newWriteBatch();
    b.stmts.push({
      sql: `UPDATE ideal_reflections SET deleted_at = NULL, updated_at = $1 WHERE id = $2`,
      args: [now, id],
    });
    b.ops.push({
      tbl: "ideal_reflections",
      row_id: id,
      op: "upsert",
      cols: {
        prompt_key: r.prompt_key,
        category: r.category,
        question: r.question,
        answer: r.answer,
        answered_on: r.answered_on,
        diary_note_id: r.diary_note_id,
        pinned: r.pinned,
        created_at: r.created_at,
        updated_at: now,
        deleted_at: null,
      },
    });
    await runWriteBatch(db, b.stmts, b.ops);
  }

  async setPinned(target: { kind: "card" | "reflection"; id: string } | null): Promise<void> {
    const db = await getDb();
    const now = nowUtcIso();
    const cur = await this.pinnedIds(db);
    const b = newWriteBatch();
    unpinOthersInBatch(b, now, cur.cards, cur.refs, target);

    if (target) {
      if (target.kind === "card") {
        const row = await this.cardRow(db, target.id);
        if (!row || row.deleted_at !== null) throw new RangeError("找不到這張手札風景卡");
        if (row.pinned !== 1) {
          b.stmts.push({
            sql: `UPDATE ideal_cards SET pinned = 1, updated_at = $1 WHERE id = $2`,
            args: [now, target.id],
          });
          b.ops.push({ tbl: "ideal_cards", row_id: target.id, op: "upsert", cols: { pinned: 1, updated_at: now } });
        }
      } else {
        const row = await this.reflectionRow(db, target.id);
        if (!row || row.deleted_at !== null) throw new RangeError("找不到這則車窓問答");
        if (row.pinned !== 1) {
          b.stmts.push({
            sql: `UPDATE ideal_reflections SET pinned = 1, updated_at = $1 WHERE id = $2`,
            args: [now, target.id],
          });
          b.ops.push({ tbl: "ideal_reflections", row_id: target.id, op: "upsert", cols: { pinned: 1, updated_at: now } });
        }
      }
    }

    if (b.stmts.length > 0) await runWriteBatch(db, b.stmts, b.ops);
  }

  async search(query: string): Promise<{ cards: IdealCardRow[]; reflections: IdealReflectionRow[] }> {
    const q = query.trim();
    if (!q) return { cards: [], reflections: [] };
    const db = await getDb();
    const pat = `%${escapeLike(q)}%`;
    const [cards, reflections] = await Promise.all([
      db.select<IdealCardRow[]>(
        `SELECT * FROM ideal_cards WHERE ${ALIVE} AND (title LIKE $1 ESCAPE '\\' OR body LIKE $1 ESCAPE '\\' OR motto LIKE $1 ESCAPE '\\') ORDER BY updated_at DESC, id`,
        [pat],
      ),
      db.select<IdealReflectionRow[]>(
        `SELECT * FROM ideal_reflections WHERE ${ALIVE} AND (question LIKE $1 ESCAPE '\\' OR answer LIKE $1 ESCAPE '\\') ORDER BY answered_on DESC, updated_at DESC, id`,
        [pat],
      ),
    ]);
    return { cards, reflections };
  }
}
