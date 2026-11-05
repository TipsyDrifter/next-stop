/**
 * MemoryLostFoundRepository——LostFoundRepository 的記憶體實作（`?mock=1`；失物招領）。
 *
 * 自帶幾筆假資料（涵蓋每個分類），不連動其他記憶體 repo：mock 只是看清單長相與撿回的手感，撿回後從清單消失就夠。
 * 規則走 `domain/lostFound.ts` 同一批純函式（分組、放哪裡、差異、撿回計畫），所以跟 SQLite 版是同一套語義。
 * 重新整理即重置（同其他記憶體實作）。
 */
import {
  LOST_TABLES,
  groupDeleted,
  namesFromTables,
  planNodeRestore,
  planRescue,
  rescueOccurrenceIds,
  snapshotDiff,
  type ChangedItem,
  type CloudSnapshot,
  type LostItem,
  type LostNow,
  type LostRow,
  type LostTables,
  type SnapshotDiff,
  type SnapshotItem,
} from "../domain/lostFound";
import type { CoverSummary } from "../domain/timetable";
import { bodyWithTag } from "../domain/tags";
import type { RepeatRow } from "../domain/ticket";
import { pickUpRepeatCols, shiftDayOf, withSkipped } from "../domain/ticketPlan";
import type { LostFoundRepository, LostRestoreResult, RevertReceipt } from "./lostFoundRepository";
import { occurrenceId } from "./syncRepository";

const NO_COVER: CoverSummary = { removed: 0, shortened: 0, splitCount: 0 };
const DAY = 86_400_000;

type Row = LostRow;

export class MemoryLostFoundRepository implements LostFoundRepository {
  private readonly tables = new Map<string, Map<string, Row>>();

  constructor(opts: { seed: boolean }) {
    if (opts.seed) this.seedDemo();
  }

  /** 放一列（假資料與測試用） */
  put(table: string, row: Row): void {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = new Map()));
    t.set(row.id, { ...row });
  }

  get(table: string, id: string): Row | undefined {
    return this.tables.get(table)?.get(id);
  }

  private snapshotOfTables(): LostTables {
    const out: Record<string, readonly Row[]> = {};
    for (const [t, m] of this.tables) out[t] = [...m.values()];
    return out;
  }

  async list(now: LostNow): Promise<LostItem[]> {
    const all = this.snapshotOfTables();
    const rows: LostTables = {};
    for (const t of LOST_TABLES) rows[t] = all[t] ?? [];
    return groupDeleted(rows, now, namesFromTables(all));
  }

  async previewCover(): Promise<CoverSummary | null> {
    return null; // 假資料沒有時間軸，沒有東西可蓋
  }

  private revive(table: string, ids: readonly string[], now: string): void {
    for (const id of ids) {
      const r = this.get(table, id);
      if (r && r.deleted_at) Object.assign(r, { deleted_at: null, updated_at: now });
    }
  }

  async restore(item: Pick<LostItem, "table" | "id" | "ids">, opts?: { withParent?: boolean }): Promise<LostRestoreResult> {
    const now = new Date().toISOString();
    switch (item.table) {
      case "nodes": {
        const plan = planNodeRestore(item, [...(this.tables.get("nodes")?.values() ?? [])], opts);
        if (plan.needsParent) return { needsParent: plan.needsParent };
        if (plan.loose) {
          const r = this.get("nodes", item.id);
          if (r) Object.assign(r, { deleted_at: null, parent_id: null, route_id: plan.loose.routeId, updated_at: now });
          return { placedAsLoose: true };
        }
        this.revive("nodes", plan.ids, now);
        return {};
      }
      case "tags":
        this.restoreTags(item.ids, now);
        return {};
      case "time_blocks":
        this.revive(item.table, [item.id], now);
        return { cover: NO_COVER };
      case "tk_entries":
        this.restoreEntry(item.id, now);
        return {};
      case "tk_repeats": {
        const r = this.get("tk_repeats", item.id);
        if (r && r.deleted_at) Object.assign(r, this.repeatCols(r), { deleted_at: null, updated_at: now });
        return { noBackfill: true };
      }
      case "tk_budgets":
        this.revive(item.table, item.ids, now);
        return {};
      default:
        this.revive(item.table, [item.id], now);
        return {};
    }
  }

  /** 同 `restoreDeleted`：荷札與同一刀的掛載清回 null，活著的筆記內文補回 */
  private restoreTags(ids: readonly string[], now: string): void {
    const taggings = [...(this.tables.get("taggings")?.values() ?? [])];
    for (const id of ids) {
      const t = this.get("tags", id);
      if (!t || !t.deleted_at || t.renamed_to) continue;
      for (const g of taggings) {
        if (g.tag_id !== id || g.deleted_at !== t.deleted_at) continue;
        Object.assign(g, { deleted_at: null, updated_at: now });
        if (g.entity_type !== "note") continue;
        const note = this.get("notes", String(g.entity_id));
        if (note && !note.deleted_at) note.body = bodyWithTag(String(note.body ?? ""), String(t.name_key), String(t.name));
      }
      Object.assign(t, { deleted_at: null, updated_at: now });
    }
  }

  /** 同 `restoreEntry`：規則活著才把那一班從 skipped_days 拿掉 */
  private restoreEntry(id: string, now: string): void {
    const e = this.get("tk_entries", id);
    if (!e || !e.deleted_at) return;
    Object.assign(e, { deleted_at: null, updated_at: now });
    const r = typeof e.repeat_id === "string" ? this.get("tk_repeats", e.repeat_id) : undefined;
    if (!r || r.deleted_at) return; // 規則是 tombstone 不碰（同 SQLite 版的 touchSkipped，沙盒 F-2）
    const day = shiftDayOf(
      { id: r.id, rule: String(r.rule ?? "") },
      { id: e.id, occurred_on: String(e.occurred_on) },
      new Date().toISOString().slice(0, 10),
      // 假資料的帳 id 不是決定性的：認 occurred_on 就好
      () => e.id,
    );
    if (day !== null) r.skipped_days = withSkipped(String(r.skipped_days ?? "[]"), day, false);
  }

  /** 同 `pickUpRepeat`：刪除期間的班次不補、帳活著的班從 skipped_days 拿掉 */
  private repeatCols(r: Row): { next_on: string | null; skipped_days: string } {
    const entries = [...(this.tables.get("tk_entries")?.values() ?? [])];
    const alive = new Set(entries.filter((e) => !e.deleted_at).map((e) => e.id));
    return pickUpRepeatCols(r as unknown as RepeatRow, entries as never, alive, new Date().toISOString().slice(0, 10));
  }

  /** 假快照：現在的清單再加一筆「快照才有的」＋一筆內容不同的筆記與車票（給撿回畫面看長相） */
  async readSnapshot(): Promise<CloudSnapshot> {
    const at = new Date(Date.now() - 7 * DAY).toISOString();
    const nodeCols = ["kind", "parent_id", "name", "description", "position", "status", "route_id", "created_at", "updated_at", "deleted_at"];
    return {
      exported_at: at,
      schema: 18,
      tables: {
        nodes: [
          { id: "mock-snap-ticket", kind: "ticket", parent_id: null, route_id: null, name: "備份裡才有的票", description: null, position: 0, status: "todo", created_at: at, updated_at: at, deleted_at: null },
          { id: "mock-alive-ticket", kind: "ticket", parent_id: null, route_id: null, name: "訂下週的票", description: "備份那時的概要", position: 1, status: "todo", created_at: at, updated_at: at, deleted_at: null },
        ],
        notes: [
          { id: "mock-snap-note", kind: "note", title: null, body: "備份裡才有的筆記", entry_date: null, noted_at: at, node_id: null, inbox: 0, created_at: at, updated_at: at, deleted_at: null },
          { id: "mock-alive-note", kind: "note", title: null, body: "備份那時寫得很長的一段內文", entry_date: null, noted_at: at, node_id: null, inbox: 0, created_at: at, updated_at: at, deleted_at: null },
        ],
        tk_wishes: [{ id: "mock-snap-wish", name: "備份裡才有的願望", amount_minor: 120000, note: "", category_id: null, position: 0, created_at: at, updated_at: at, deleted_at: null }],
        taggings: [],
        tags: [],
      },
      columns: {
        nodes: nodeCols,
        notes: ["kind", "title", "body", "entry_date", "noted_at", "node_id", "inbox", "created_at", "updated_at", "deleted_at"],
        tk_wishes: ["name", "amount_minor", "note", "category_id", "position", "created_at", "updated_at", "deleted_at"],
        taggings: ["entity_type", "entity_id", "tag_id", "created_at", "updated_at", "deleted_at"],
        tags: ["name", "name_key", "renamed_to", "created_at", "updated_at", "deleted_at"],
      },
    };
  }

  async diffSnapshot(snapshot: CloudSnapshot): Promise<SnapshotDiff> {
    return snapshotDiff(snapshot, this.snapshotOfTables());
  }

  async rescue(snapshot: CloudSnapshot, item: Pick<SnapshotItem, "table" | "id">, opts?: { withParent?: boolean }): Promise<LostRestoreResult> {
    const now = new Date().toISOString();
    const plan = planRescue(snapshot, item, this.snapshotOfTables(), now, await rescueOccurrenceIds(snapshot, occurrenceId), opts);
    if (plan.needsParent) return { needsParent: plan.needsParent };
    if (plan.alreadyHere && !plan.writes.length) return { alreadyHere: true };
    let noBackfill = false;
    for (const w of plan.writes) {
      const cur = this.get(w.table, w.id);
      const row = { ...cur, ...w.row } as Row;
      if (w.table === "tk_repeats") {
        Object.assign(row, this.repeatCols(row));
        noBackfill = true;
      }
      this.put(w.table, row);
    }
    for (const t of plan.tagBodies) {
      const note = this.get("notes", t.noteId);
      if (note && !note.deleted_at) note.body = bodyWithTag(String(note.body ?? ""), t.key, t.name);
    }
    if (plan.restoreBlockId) {
      this.revive("time_blocks", [plan.restoreBlockId], now);
      return { cover: NO_COVER };
    }
    if (plan.alreadyHere) return { alreadyHere: true, filled: plan.writes.filter((w) => w.table === "nodes").length };
    return { ...(plan.placedAsLoose ? { placedAsLoose: true } : {}), ...(noBackfill ? { noBackfill: true } : {}) };
  }

  private writeCompared(table: string, id: string, vals: Record<string, string | null>): Record<string, string | null> {
    const r = this.get(table, id);
    if (!r || r.deleted_at) throw new RangeError("這一筆已經刪除了");
    const before: Record<string, string | null> = {};
    for (const c of Object.keys(vals)) {
      before[c] = (r[c] as string | null | undefined) ?? null;
      r[c] = vals[c];
    }
    r.updated_at = new Date().toISOString();
    return before;
  }

  async revertToSnapshot(item: Pick<ChangedItem, "table" | "id" | "fields">): Promise<RevertReceipt> {
    const after: Record<string, string | null> = {};
    for (const f of item.fields) after[f.col] = f.snapshot;
    return { table: item.table, id: item.id, before: this.writeCompared(item.table, item.id, after), after };
  }

  async undoRevert(receipt: RevertReceipt): Promise<void> {
    this.writeCompared(receipt.table, receipt.id, receipt.before);
  }

  /* ───────── 假資料（全部虛構；涵蓋每個分類） ───────── */

  private seedDemo(): void {
    const ago = (days: number, minutes = 0) => new Date(Date.now() - days * DAY - minutes * 60_000).toISOString();
    const base = { created_at: ago(60), updated_at: ago(60) };
    const line = { ...base, id: "mock-line", kind: "line", parent_id: null, line_id: null, route_id: null, name: "學習", deleted_at: null };
    const route = { ...base, id: "mock-route", kind: "route", parent_id: "mock-line", line_id: "mock-line", route_id: null, name: "日文", deleted_at: null };
    this.put("nodes", line);
    this.put("nodes", route);

    // 同一刀：列車連兩張票（一列「含 2 個子項」）
    const cut = ago(0, 30);
    const inRoute = { ...base, line_id: "mock-line", route_id: "mock-route", deleted_at: cut };
    this.put("nodes", { ...inRoute, id: "mock-train", kind: "train", parent_id: "mock-route", name: "N5 文法" });
    this.put("nodes", { ...inRoute, id: "mock-t1", kind: "ticket", parent_id: "mock-train", name: "て形練習" });
    this.put("nodes", { ...inRoute, id: "mock-t2", kind: "ticket", parent_id: "mock-train", name: "背單字" });
    // 更早先被單獨刪的票：上層也不在，撿回會放到臨時車票
    this.put("nodes", { ...inRoute, id: "mock-t3", kind: "ticket", parent_id: "mock-train", name: "聽力練習", deleted_at: ago(2) });
    // 車廂比它的列車更早刪：撿回要問要不要連同上層
    this.put("nodes", { ...inRoute, id: "mock-car", kind: "car", parent_id: "mock-train", name: "助詞", deleted_at: ago(3) });
    this.put("nodes", { ...base, id: "mock-alive-ticket", kind: "ticket", parent_id: null, line_id: null, route_id: null, name: "訂下週的票", description: "現在的概要", position: 1, status: "todo", deleted_at: null });

    this.put("notes", { ...base, id: "mock-note", kind: "note", title: null, body: "週末去看展\n順便買明信片", entry_date: null, noted_at: base.created_at, node_id: null, inbox: 0, deleted_at: ago(1) });
    this.put("notes", { ...base, id: "mock-diary", kind: "diary", title: null, body: "今天跑了五公里。", entry_date: ago(5).slice(0, 10), noted_at: ago(5), node_id: null, inbox: 0, deleted_at: ago(4) });
    this.put("notes", { ...base, id: "mock-alive-note", kind: "note", title: null, body: "#旅行 現在只剩一句", entry_date: null, noted_at: base.created_at, node_id: null, inbox: 0, deleted_at: null });
    const tagCut = ago(6);
    this.put("tags", { ...base, id: "mock-tag", name: "旅行", name_key: "旅行", renamed_to: null, deleted_at: tagCut });
    this.put("tags", { ...base, id: "mock-tag-sub", name: "旅行/日本", name_key: "旅行/日本", renamed_to: null, deleted_at: tagCut });

    this.put("time_categories", { ...base, id: "mock-cat", name: "閱讀", parent_id: null, deleted_at: null });
    this.put("time_blocks", { ...base, id: "mock-block", category_id: "mock-cat", started_at: ago(1, 180), ended_at: ago(1, 120), deleted_at: ago(1) });
    this.put("time_goals", { ...base, id: "mock-goal", name: "每週閱讀十小時", scope: "{}", period: "week", target_min: 600, direction: "atLeast", deleted_at: ago(8) });
    this.put("time_routines", { ...base, id: "mock-routine", name: "上班日", deleted_at: ago(9) });

    this.put("tk_currencies", { ...base, id: "mock-twd", code: "TWD", decimals: 0, is_main: 1, deleted_at: null });
    this.put("tk_categories", { ...base, id: "mock-food", kind: "expense", name: "餐飲", parent_id: null, deleted_at: null });
    this.put("tk_entries", { ...base, id: "mock-entry", kind: "expense", occurred_on: ago(2).slice(0, 10), occurred_at: ago(2), account_id: "mock-acc", category_id: "mock-food", amount_minor: 180, currency: "TWD", note: "午餐", deleted_at: ago(2) });
    this.put("tk_wishes", { ...base, id: "mock-wish", name: "新耳機", amount_minor: 3200, note: "", deleted_at: ago(10) });
    this.put("tk_templates", { ...base, id: "mock-tpl", name: "午餐", kind: "expense", amount_minor: 150, currency: "TWD", note: "", deleted_at: ago(11) });
    this.put("tk_repeats", { ...base, id: "mock-repeat", kind: "expense", account_id: "mock-acc", amount_minor: 390, currency: "TWD", note: "音樂訂閱", rule: "{}", deleted_at: ago(12) });
    const budgetCut = ago(13);
    this.put("tk_budgets", { ...base, id: "mock-budget", kind: "category", category_id: "mock-food", month: null, amount_minor: 6000, deleted_at: budgetCut });
    this.put("tk_budgets", { ...base, id: "mock-budget-11", kind: "category", category_id: "mock-food", month: "2026-11", amount_minor: 8000, deleted_at: budgetCut });
    this.put("week_aims", { ...base, id: "mock-aim", week_on: ago(7).slice(0, 10), text: "把日文第三課讀完", deleted_at: ago(7) });
  }
}
