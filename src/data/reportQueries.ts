/**
 * reportQueries——運行報告多出來的三句唯讀查詢（② 運行報告 D-主-191；契約 §7）。0 migration、不加 repository 介面。
 *
 *   - `dueCountByDay(from, to)`：每天到締切的票數（存活的 train／car／ticket、`due_on` 落在區間，不分完成與否）
 *   - `noteTimes(fromIso, toIso)`：筆記（kind='note'，含收件匣的一句）的寫下時刻
 *   - `firstNoteIn(fromIso, toIso)`：窗內寫下的第一則筆記（「一年前的今天」沒有日記時用）
 *
 * SQLite 直接 SELECT；mock 用既有 repository 的公開方法拼（假資料量小）。
 */
import { MOCK_MODE, nodeRepo } from "./index";
import { noteRepo } from "./noteRepo";
import { getDb } from "../lib/db";

export interface ReportQueries {
  dueCountByDay(from: string, to: string): Promise<Record<string, number>>;
  noteTimes(fromIso: string, toIso: string): Promise<string[]>;
  firstNoteIn(fromIso: string, toIso: string): Promise<{ title: string | null; body: string } | null>;
}

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

  async noteTimes(fromIso: string, toIso: string): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<{ at: string }[]>(
      `SELECT noted_at AS at FROM notes
       WHERE deleted_at IS NULL AND kind = 'note' AND noted_at >= $1 AND noted_at < $2`,
      [fromIso, toIso],
    );
    return rows.map((r) => r.at);
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

/** mock：締切只拿得到還沒完成的（listCalendar 的締切層）——假資料夠看樣子 */
class MemoryReportQueries implements ReportQueries {
  async dueCountByDay(from: string, to: string): Promise<Record<string, number>> {
    const cal = await nodeRepo.listCalendar(from, to);
    const out: Record<string, number> = {};
    for (const d of cal.dues) if (d.date >= from && d.date <= to) out[d.date] = (out[d.date] ?? 0) + 1;
    return out;
  }

  private async allNotes() {
    const [inbox, notes] = await Promise.all([noteRepo.listInbox(), noteRepo.listNotes({ limit: 5000 })]);
    return [...inbox, ...notes];
  }

  async noteTimes(fromIso: string, toIso: string): Promise<string[]> {
    return (await this.allNotes()).filter((n) => n.noted_at >= fromIso && n.noted_at < toIso).map((n) => n.noted_at);
  }

  async firstNoteIn(fromIso: string, toIso: string): Promise<{ title: string | null; body: string } | null> {
    const hit = (await this.allNotes())
      .filter((n) => n.noted_at >= fromIso && n.noted_at < toIso)
      .sort((a, b) => (a.noted_at < b.noted_at ? -1 : a.noted_at > b.noted_at ? 1 : 0))[0];
    return hit ? { title: hit.title, body: hit.body } : null;
  }
}

export const reportQueries: ReportQueries = MOCK_MODE ? new MemoryReportQueries() : new SqliteReportQueries();
