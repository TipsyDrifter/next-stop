/**
 * reportQueries——運行報告唯讀查詢（② 運行報告 D-主-191 ＋ v1.33 3A 完全體）。0 migration、不改既有 repository 介面。
 *
 *   - `dueCountByDay(from, to)`：每天到締切的票數（存活的 train／car／ticket、`due_on` 落在區間，不分完成與否）
 *   - `dueFactsIn(from, to)`：同口徑的逐筆締切事實（帶 id、day、routeId，供跨模組篩選即時過濾）
 *   - `noteTimes(fromIso, toIso)`：筆記（kind='note'，含收件匣的一句）的寫下時刻
 *   - `noteFactsIn(fromIso, toIso)`：同口徑的逐筆筆記（帶 id、at、routeId，供路線／#荷札篩選）
 *   - `diarySummariesIn(fromDay, toDay)`：區間內各日第一篇日記的一行摘要（供單日展開卡「翻閱當日日記 ›」預覽）
 *   - `nodeMetaByIds(ids)`：時間塊連結節點的名稱與所屬路線（供單日時間塊明細與路線時數排行）
 *   - `firstNoteIn(fromIso, toIso)`：窗內寫下的第一則筆記（「一年前的今天」沒有日記時用）
 *
 * SQLite 直接 SELECT；mock 用既有 repository 的公開方法組裝（支援 `?mock=1` 雙端一致）。
 */
import { MOCK_MODE, nodeRepo } from "./index";
import { noteRepo } from "./noteRepo";
import { getDb } from "../lib/db";
import { oneLine } from "../domain/report";

export interface ReportDueFactRow {
  id: string;
  day: string;
  routeId: string | null;
}

export interface ReportNoteFactRow {
  id: string;
  at: string;
  routeId: string | null;
}

export interface ReportNodeMetaRow {
  id: string;
  name: string;
  routeId: string | null;
}

export interface ReportQueries {
  dueCountByDay(from: string, to: string): Promise<Record<string, number>>;
  dueFactsIn(from: string, to: string): Promise<ReportDueFactRow[]>;
  noteTimes(fromIso: string, toIso: string): Promise<string[]>;
  noteFactsIn(fromIso: string, toIso: string): Promise<ReportNoteFactRow[]>;
  diarySummariesIn(fromDay: string, toDay: string): Promise<Record<string, { id: string; text: string }>>;
  nodeMetaByIds(ids: readonly string[]): Promise<Record<string, ReportNodeMetaRow>>;
  firstNoteIn(fromIso: string, toIso: string): Promise<{ title: string | null; body: string } | null>;
}

const SQL_CHUNK = 200;

class SqliteReportQueries implements ReportQueries {
  async dueCountByDay(from: string, to: string): Promise<Record<string, number>> {
    const db = await getDb();
    const rows = await db.select<{ day: string; c: number }[]>(
      `SELECT due_on AS day, COUNT(*) AS c FROM nodes
       WHERE deleted_at IS NULL AND kind IN ('train','car','ticket') AND due_on IS NOT NULL AND due_on BETWEEN $1 AND $2
       GROUP BY due_on`,
      [from, to],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.day] = Number(r.c);
    return out;
  }

  async dueFactsIn(from: string, to: string): Promise<ReportDueFactRow[]> {
    if (from > to) return [];
    const db = await getDb();
    return db.select<ReportDueFactRow[]>(
      `SELECT id, due_on AS day, route_id AS routeId FROM nodes
       WHERE deleted_at IS NULL AND kind IN ('train','car','ticket') AND due_on IS NOT NULL AND due_on BETWEEN $1 AND $2`,
      [from, to],
    );
  }

  async noteTimes(fromIso: string, toIso: string): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<{ at: string }[]>(
      `SELECT noted_at AS at FROM notes
       WHERE deleted_at IS NULL AND kind = 'note' AND noted_at >= $1 AND noted_at < $2`,
      [fromIso, toIso],
    );
    return rows.map((r) => r.at);
  }

  async noteFactsIn(fromIso: string, toIso: string): Promise<ReportNoteFactRow[]> {
    if (fromIso >= toIso) return [];
    const db = await getDb();
    return db.select<ReportNoteFactRow[]>(
      `SELECT nt.id, nt.noted_at AS at,
              CASE WHEN nd.deleted_at IS NOT NULL THEN NULL
                   WHEN nd.kind = 'route' THEN nd.id
                   ELSE nd.route_id END AS routeId
       FROM notes nt
       LEFT JOIN nodes nd ON nd.id = nt.node_id
       WHERE nt.deleted_at IS NULL AND nt.kind = 'note' AND nt.noted_at >= $1 AND nt.noted_at < $2`,
      [fromIso, toIso],
    );
  }

  async diarySummariesIn(fromDay: string, toDay: string): Promise<Record<string, { id: string; text: string }>> {
    if (fromDay > toDay) return {};
    const db = await getDb();
    const rows = await db.select<{ id: string; day: string; title: string | null; body: string }[]>(
      `SELECT id, entry_date AS day, title, body FROM notes
       WHERE deleted_at IS NULL AND kind = 'diary' AND entry_date BETWEEN $1 AND $2
       ORDER BY entry_date ASC, noted_at ASC, created_at ASC`,
      [fromDay, toDay],
    );
    const out: Record<string, { id: string; text: string }> = {};
    for (const r of rows) {
      const text = oneLine(r.title, r.body);
      const cur = out[r.day];
      if (!cur) out[r.day] = { id: r.id, text };
      else if (!cur.text && text) out[r.day] = { id: r.id, text };
    }
    return out;
  }

  async nodeMetaByIds(ids: readonly string[]): Promise<Record<string, ReportNodeMetaRow>> {
    const uniq = Array.from(new Set(ids.filter((x) => !!x)));
    if (uniq.length === 0) return {};
    const db = await getDb();
    const out: Record<string, ReportNodeMetaRow> = {};
    for (let i = 0; i < uniq.length; i += SQL_CHUNK) {
      const slice = uniq.slice(i, i + SQL_CHUNK);
      const ph = slice.map((_, idx) => `$${idx + 1}`).join(",");
      const rows = await db.select<ReportNodeMetaRow[]>(
        `SELECT id, name, CASE WHEN kind = 'route' THEN id ELSE route_id END AS routeId
         FROM nodes WHERE deleted_at IS NULL AND id IN (${ph})`,
        slice,
      );
      for (const r of rows) out[r.id] = r;
    }
    return out;
  }

  async firstNoteIn(fromIso: string, toIso: string): Promise<{ title: string | null; body: string } | null> {
    const db = await getDb();
    const rows = await db.select<{ title: string | null; body: string }[]>(
      `SELECT title, body FROM notes
       WHERE deleted_at IS NULL AND kind = 'note' AND noted_at >= $1 AND noted_at < $2
       ORDER BY noted_at ASC, created_at ASC LIMIT 1`,
      [fromIso, toIso],
    );
    return rows[0] ?? null;
  }
}

/** mock：締切走 listCalendar；筆記／日記／節點走既有記憶體 repository */
class MemoryReportQueries implements ReportQueries {
  async dueCountByDay(from: string, to: string): Promise<Record<string, number>> {
    if (from > to) return {};
    const cal = await nodeRepo.listCalendar(from, to);
    const out: Record<string, number> = {};
    for (const d of cal.dues) if (d.date >= from && d.date <= to) out[d.date] = (out[d.date] ?? 0) + 1;
    return out;
  }

  async dueFactsIn(from: string, to: string): Promise<ReportDueFactRow[]> {
    if (from > to) return [];
    const cal = await nodeRepo.listCalendar(from, to);
    const out: ReportDueFactRow[] = [];
    for (const d of cal.dues) {
      if (d.date < from || d.date > to) continue;
      const n = cal.nodes[d.node_id];
      out.push({ id: d.node_id, day: d.date, routeId: n?.route_id ?? null });
    }
    return out;
  }

  private async allNotes() {
    const [inbox, notes] = await Promise.all([noteRepo.listInbox(), noteRepo.listNotes({ limit: 5000 })]);
    return [...inbox, ...notes];
  }

  async noteTimes(fromIso: string, toIso: string): Promise<string[]> {
    return (await this.allNotes()).filter((n) => n.noted_at >= fromIso && n.noted_at < toIso).map((n) => n.noted_at);
  }

  async noteFactsIn(fromIso: string, toIso: string): Promise<ReportNoteFactRow[]> {
    if (fromIso >= toIso) return [];
    return (await this.allNotes())
      .filter((n) => n.noted_at >= fromIso && n.noted_at < toIso)
      .map((n) => ({ id: n.id, at: n.noted_at, routeId: n.route_id }));
  }

  async diarySummariesIn(fromDay: string, toDay: string): Promise<Record<string, { id: string; text: string }>> {
    if (fromDay > toDay) return {};
    const marks = await noteRepo.listDiaryMarks(fromDay, toDay);
    const out: Record<string, { id: string; text: string }> = {};
    for (const day of Object.keys(marks)) {
      if ((marks[day] ?? 0) <= 0) continue;
      const entries = await noteRepo.listDiary(day);
      for (const e of entries) {
        const text = oneLine(e.title, e.body);
        const cur = out[day];
        if (!cur) out[day] = { id: e.id, text };
        else if (!cur.text && text) out[day] = { id: e.id, text };
      }
    }
    return out;
  }

  async nodeMetaByIds(ids: readonly string[]): Promise<Record<string, ReportNodeMetaRow>> {
    const uniq = Array.from(new Set(ids.filter((x) => !!x)));
    if (uniq.length === 0) return {};
    const rows = await Promise.all(uniq.map((id) => nodeRepo.getNode(id)));
    const out: Record<string, ReportNodeMetaRow> = {};
    for (const n of rows) {
      if (!n || n.deleted_at !== null) continue;
      out[n.id] = { id: n.id, name: n.name, routeId: n.kind === "route" ? n.id : n.route_id };
    }
    return out;
  }

  async firstNoteIn(fromIso: string, toIso: string): Promise<{ title: string | null; body: string } | null> {
    const hit = (await this.allNotes())
      .filter((n) => n.noted_at >= fromIso && n.noted_at < toIso)
      .sort((a, b) => (a.noted_at < b.noted_at ? -1 : a.noted_at > b.noted_at ? 1 : 0))[0];
    return hit ? { title: hit.title, body: hit.body } : null;
  }
}

export const reportQueries: ReportQueries = MOCK_MODE ? new MemoryReportQueries() : new SqliteReportQueries();
