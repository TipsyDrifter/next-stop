/**
 * MemoryTagRepository——TagRepository 的記憶體實作（`?mock=1`；旅客筆記車次③契約 §3.5）。
 *
 * 語義對齊 `sqliteTagRepository.ts`：決定性 id（`tagId`／`taggingId`）、soft delete、讀取 JOIN 實體存活
 * （`nodeRepo.getNode`／`noteRepo.getNote`；別線 entity_type 不查）、收據與 undo 同形。重新整理即重置。
 *
 * 種子（`seed=true` 才種；全部虛構）：荷札約 12 個含三層巢狀與虛資料夾，掛到示範資料的車票／列車／車廂；
 * 筆記與日記的荷札來自 `memoryNoteRepository.ts` 種子內文——種完跑一次 backfill（契約 §3.5：讓提示條有數字）。
 */
import { nowUtcIso } from "../lib/db";
import type { NodeRow } from "../domain";
import {
  TAG_ENTITY_NODE_KINDS,
  TAGS_RECENT_KEY,
  deleteBody,
  isUnder,
  normalizeName,
  parseTags,
  pushRecentKeys,
  renameBody,
  type DeletePlan,
  type RenamePlan,
  type TagIndexSource,
} from "../domain/tags";
import type { NodeRepository } from "./nodeRepository";
import type { MemoryNoteRepository } from "./memoryNoteRepository";
import type { SettingsRepository } from "./settingsRepository";
import {
  emptyReceipt,
  followRename,
  followRenamePlan,
  recordTagBeforeWithRename,
  tagId,
  taggingId,
  type AttachResult,
  type BackfillResult,
  type CreateTagResult,
  type RenameFollow,
  type SyncBodyResult,
  type TagEntityType,
  type TaggedItem,
  type TaggingRow,
  type TagReceipt,
  type TagRepository,
  type TagRow,
} from "./tagRepository";
import { byNameKey, pickNode, readRecent, recordTagBefore, recordTaggingBefore } from "./tagRepoShared";
import { otherEntityAliveMemory, uncountedTagEntityTypes } from "./tagEntityAlive";

const clone = <T extends object>(o: T): T => ({ ...o });

/** 收據記改前值（連改名去向；同 sqlite 版） */
function recordTag(r: TagReceipt, t: TagRow): void {
  recordTagBeforeWithRename(r, t, recordTagBefore);
}

/** 種子荷札（虛構）：[名稱, 掛到第幾張可掛節點（-1＝不掛，只靠內文）] */
const SEED_TAGS: [string, number[]][] = [
  ["難度/高", [0, 2, 4]],
  ["難度/低", [1]],
  ["重要/高", [0, 3]],
  ["高", [2, 5]],
  ["專案/搬家/打包", [1, 6]],
  ["專案/搬家/退租", [6]],
  ["讀書/日文", [3]],
  ["等回覆", [5, 7]],
  ["AI/工具", [7]],
];

/** `&tagfail=1`：loadIndexSource 一直丟錯，直到使用者按下任何一顆「重試」（只有記憶體實作認，正式資料路徑碰不到；磨光③ 2-12）。
 *  只失敗一次的話，開頁時別處的載入就先把它吃掉了，畫面上看不到重試（磨光③ 評審 V18） */
function tagFailFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("tagfail") === "1";
  } catch {
    return false;
  }
}
let tagFailUsed = false;
let tagFailWatching = false;
/** 第一次丟錯時掛一個捕獲期點擊監聽：點到字是「重試」的按鈕 ⇒ 之後照常（監聽比按鈕的 onClick 先跑，所以這次重試就會成功） */
function watchRetryClick(): void {
  if (tagFailWatching || typeof document === "undefined") return;
  tagFailWatching = true;
  const onClick = (e: MouseEvent) => {
    const btn = e.target instanceof Element ? e.target.closest("button") : null;
    if (!btn || btn.textContent?.trim() !== "重試") return;
    tagFailUsed = true;
    document.removeEventListener("click", onClick, true);
  };
  document.addEventListener("click", onClick, true);
}

export class MemoryTagRepository implements TagRepository {
  private readonly tags = new Map<string, TagRow>();
  private readonly taggings = new Map<string, TaggingRow>();
  private ready: Promise<void> | null = null;
  private readonly nodeRepo: NodeRepository;
  private readonly noteRepo: MemoryNoteRepository;
  private readonly settingsRepo: SettingsRepository;
  private readonly seed: boolean;

  constructor(nodeRepo: NodeRepository, noteRepo: MemoryNoteRepository, settingsRepo: SettingsRepository, opts: { seed: boolean }) {
    this.nodeRepo = nodeRepo;
    this.noteRepo = noteRepo;
    this.settingsRepo = settingsRepo;
    this.seed = opts.seed;
  }

  /* ───────────── 讀 ───────────── */

  async loadIndexSource(): Promise<TagIndexSource> {
    // 評審端點 `?mock=1&tagfail=1`（磨光③ 2-12）：按「重試」之前一直丟錯，驗「荷札沒載入　重試」
    if (!tagFailUsed && tagFailFlag()) {
      watchRetryClick();
      throw new Error("荷札沒載入（tagfail=1）");
    }
    await this.ensureSeed();
    const tags = this.aliveTags().map((t) => ({ id: t.id, name: t.name, key: t.name_key }));
    const taggings: TagIndexSource["taggings"] = [];
    const kinds: Record<string, string> = {};
    const cache = new Map<string, string | null>();
    for (const g of this.aliveTaggings()) {
      const kind = await this.entityKind(g.entity_type, g.entity_id, cache);
      if (kind === null) continue;
      taggings.push({ tagId: g.tag_id, entityType: g.entity_type, entityId: g.entity_id });
      if (g.entity_type === "node" || g.entity_type === "note") kinds[g.entity_id] = kind;
    }
    // 磨光③ 0-1：同 sqlite 版（沒登記 counts:false＝不帶這個欄位）
    const uncounted = uncountedTagEntityTypes();
    return uncounted.length ? { tags, taggings, kinds, uncounted: [...uncounted] } : { tags, taggings, kinds };
  }

  async listTagsOf(entityType: TagEntityType, entityId: string): Promise<TagRow[]> {
    await this.ensureSeed();
    return this.tagsOf(entityType, entityId);
  }

  /** 不等種子（種子本身也會呼叫：seedDemo → backfillCore → syncBodyCore；等 ensureSeed 會自己等自己） */
  private tagsOf(entityType: TagEntityType, entityId: string): TagRow[] {
    const out: TagRow[] = [];
    for (const g of this.aliveTaggings()) {
      if (g.entity_type !== entityType || g.entity_id !== entityId) continue;
      const t = this.tags.get(g.tag_id);
      if (t && t.deleted_at === null) out.push(clone(t));
    }
    return out.sort(byNameKey);
  }

  async listUnder(key: string, entityType?: TagEntityType): Promise<TaggedItem[]> {
    await this.ensureSeed();
    const keyOfTag = new Map<string, string>();
    for (const t of this.aliveTags()) if (isUnder(t.name_key, key)) keyOfTag.set(t.id, t.name_key);
    const byEnt = new Map<string, { type: TagEntityType; id: string; matched: string[] }>();
    // 磨光③ 0-1：不算用量的類型不進「別處」（明指要那一種的除外；同 sqlite 版）
    const skip = uncountedTagEntityTypes().filter((t) => t !== entityType);
    for (const g of this.aliveTaggings()) {
      const k = keyOfTag.get(g.tag_id);
      if (!k || (entityType && g.entity_type !== entityType) || skip.includes(g.entity_type)) continue;
      const ref = g.entity_type + "\u0001" + g.entity_id;
      let e = byEnt.get(ref);
      if (!e) byEnt.set(ref, (e = { type: g.entity_type, id: g.entity_id, matched: [] }));
      if (!e.matched.includes(k)) e.matched.push(k);
    }
    const out: TaggedItem[] = [];
    for (const e of byEnt.values()) {
      const matched = e.matched.sort();
      if (e.type === "node") {
        const n = await this.nodeRepo.getNode(e.id);
        if (!n || n.deleted_at !== null || !TAG_ENTITY_NODE_KINDS.includes(n.kind)) continue;
        out.push({ kind: "node", id: e.id, node: pickNode(n), matched });
      } else if (e.type === "note") {
        const x = await this.noteRepo.getNote(e.id);
        if (!x) continue;
        out.push({
          kind: "note",
          id: e.id,
          note: { id: x.id, kind: x.kind, title: x.title, body: x.body, entry_date: x.entry_date, noted_at: x.noted_at },
          matched,
        });
      } else if (await otherEntityAliveMemory(e.type, e.id)) out.push({ kind: "other", entityType: e.type, id: e.id, matched });
    }
    return out;
  }

  async recentKeys(): Promise<string[]> {
    return readRecent(this.settingsRepo);
  }

  /* ───────────── 寫 ───────────── */

  async attach(entityType: TagEntityType, entityId: string, rawName: string): Promise<AttachResult> {
    await this.ensureSeed();
    const n = normalizeName(rawName);
    if (!n.ok) throw new RangeError(n.reason);
    await this.assertAttachable(entityType, entityId);
    const r = emptyReceipt();
    const now = nowUtcIso();
    const { row, created } = await this.ensureTag(n.name, n.key, now, r);
    const { already } = await this.ensureTagging(entityType, entityId, row.id, now, r);
    return { key: n.key, name: row.name, created, already, receipt: r };
  }

  /** ＝attach 去掉 assertAttachable 與 ensureTagging（UI 丙-6 ☎-1；與 SqliteTagRepository.create 逐條對齊）：
   *  名稱不合法丟 RangeError、不存在就建、已刪除就復活（沿用先建的 name）、已存活不寫（收據空、created:false） */
  async create(rawName: string): Promise<CreateTagResult> {
    await this.ensureSeed();
    const n = normalizeName(rawName);
    if (!n.ok) throw new RangeError(n.reason);
    const r = emptyReceipt();
    const { row, created } = await this.ensureTag(n.name, n.key, nowUtcIso(), r);
    return { key: n.key, name: row.name, created, receipt: r };
  }

  async detach(entityType: TagEntityType, entityId: string, key: string): Promise<TagReceipt> {
    await this.ensureSeed();
    const r = emptyReceipt();
    const g = this.taggings.get(await taggingId(entityType, entityId, await tagId(key)));
    if (g && g.deleted_at === null) this.softDeleteTagging(g, nowUtcIso(), r);
    return r;
  }

  async setTags(
    entityType: TagEntityType,
    entityId: string,
    rawNames: readonly string[],
  ): Promise<{ receipt: TagReceipt; created: string[] }> {
    await this.ensureSeed();
    await this.assertAttachable(entityType, entityId);
    const want = new Map<string, string>();
    for (const raw of rawNames) {
      const n = normalizeName(raw);
      if (n.ok && !want.has(n.key)) want.set(n.key, n.name);
    }
    const r = emptyReceipt();
    const now = nowUtcIso();
    const created: string[] = [];
    const have = this.tagsOf(entityType, entityId);
    for (const t of have) {
      if (want.has(t.name_key)) continue;
      const g = this.taggings.get(await taggingId(entityType, entityId, t.id));
      if (g && g.deleted_at === null) this.softDeleteTagging(g, now, r);
    }
    for (const [key, name] of want) {
      const { row, created: c } = await this.ensureTag(name, key, now, r);
      if (c) created.push(row.name);
      await this.ensureTagging(entityType, entityId, row.id, now, r);
    }
    return { receipt: r, created };
  }

  async syncBodyTags(noteId: string, body: string): Promise<SyncBodyResult> {
    await this.ensureSeed();
    return this.syncBodyCore(noteId, body, nowUtcIso(), null);
  }

  async backfill(): Promise<BackfillResult> {
    await this.ensureSeed();
    return this.backfillCore();
  }

  async rename(plan: RenamePlan): Promise<TagReceipt> {
    if (!plan.ok) throw new RangeError(plan.reason);
    await this.ensureSeed();
    const r = emptyReceipt();
    const now = nowUtcIso();
    if (plan.same) {
      const row = this.tags.get(await tagId(plan.oldKey));
      if (row && row.deleted_at === null && row.name !== plan.newName) {
        recordTag(r, row);
        row.name = plan.newName;
        row.updated_at = now;
      }
      return r;
    }
    for (const m of plan.moves) {
      const fromId = await tagId(m.from);
      const { row: target } = await this.ensureTag(m.toName, m.to, now, r, true);
      for (const g of this.aliveTaggings()) {
        if (g.tag_id !== fromId) continue;
        await this.ensureTagging(g.entity_type, g.entity_id, target.id, now, r);
        this.softDeleteTagging(g, now, r);
      }
      const src = this.tags.get(fromId);
      // 併入同理：併入目標就是去向（D-主-121；同 sqlite 版）
      if (src && src.deleted_at === null) this.softDeleteTag(src, now, r, target.id);
    }
    for (const x of await this.noteRepo.bodiesWithHash()) {
      const next = renameBody(x.body, plan);
      if (next === x.body) continue;
      r.notesBefore.push({ id: x.id, body: x.body });
      this.noteRepo.setBodyRaw(x.id, next, now);
    }
    return r;
  }

  async remove(plan: DeletePlan): Promise<TagReceipt> {
    if (!plan.ok) throw new RangeError(plan.reason);
    await this.ensureSeed();
    const r = emptyReceipt();
    const now = nowUtcIso();
    for (const k of plan.keys) {
      const id = await tagId(k);
      for (const g of this.aliveTaggings()) if (g.tag_id === id) this.softDeleteTagging(g, now, r);
      const row = this.tags.get(id);
      if (row && row.deleted_at === null) this.softDeleteTag(row, now, r);
    }
    for (const x of await this.noteRepo.bodiesWithHash()) {
      const next = deleteBody(x.body, plan);
      if (next === x.body) continue;
      r.notesBefore.push({ id: x.id, body: x.body });
      this.noteRepo.setBodyRaw(x.id, next, now);
    }
    return r;
  }

  async undo(receipt: TagReceipt): Promise<void> {
    await this.ensureSeed();
    const now = nowUtcIso();
    for (const id of receipt.createdTaggingIds) {
      const g = this.taggings.get(id);
      if (g && g.deleted_at === null) Object.assign(g, { deleted_at: now, updated_at: now });
    }
    for (const id of receipt.createdTagIds) {
      const t = this.tags.get(id);
      if (t && t.deleted_at === null) Object.assign(t, { deleted_at: now, updated_at: now });
    }
    for (const b of receipt.tagsBefore) {
      const t = this.tags.get(b.id);
      // 改名去向一起寫回（同 sqlite 版）
      if (t) Object.assign(t, { name: b.name, deleted_at: b.deleted_at, renamed_to: b.renamed_to ?? null, updated_at: now });
    }
    for (const b of receipt.taggingsBefore) {
      const g = this.taggings.get(b.id);
      if (g) Object.assign(g, { deleted_at: b.deleted_at, updated_at: now });
    }
    for (const b of receipt.notesBefore) this.noteRepo.setBodyRaw(b.id, b.body, now);
  }

  async pushRecent(key: string): Promise<void> {
    const list = await readRecent(this.settingsRepo);
    await this.settingsRepo.set(TAGS_RECENT_KEY, JSON.stringify(pushRecentKeys(list, key)));
  }

  /* ───────────── 同步引擎班（D-主-121；語義同 sqlite 版） ───────────── */

  async getTagRow(id: string): Promise<TagRow | null> {
    await this.ensureSeed();
    const t = this.tags.get(id);
    return t ? clone(t) : null;
  }

  async reconcileRenamed(opts?: { beforeBodyRewrite?: () => Promise<void> }): Promise<RenameFollow[]> {
    await this.ensureSeed();
    const get = async (id: string) => this.tags.get(id) ?? null;
    const live: string[] = [];
    for (const t of this.aliveTags()) if (t.renamed_to && (await followRename(t.id, get))) live.push(t.id);
    if (!live.length) return [];
    if (opts?.beforeBodyRewrite && this.aliveTaggings().some((g) => g.entity_type === "note" && live.includes(g.tag_id))) {
      await opts.beforeBodyRewrite();
    }
    const now = nowUtcIso();
    const r = emptyReceipt(); // 整理不給復原；收據只是讓共用的寫法照走
    const out: RenameFollow[] = [];
    const plans: RenamePlan[] = [];
    const noteIds = new Set<string>();
    for (const id of live) {
      const shell = this.tags.get(id);
      if (!shell || shell.deleted_at !== null || !shell.renamed_to) continue;
      const toId = await followRename(id, get);
      const target = toId ? this.tags.get(toId) : undefined;
      if (!target) continue;
      let moved = 0;
      for (const g of this.aliveTaggings()) {
        if (g.tag_id !== id) continue;
        await this.ensureTagging(g.entity_type, g.entity_id, target.id, now, r);
        this.softDeleteTagging(g, now, r);
        if (g.entity_type === "note") noteIds.add(g.entity_id);
        moved++;
      }
      this.softDeleteTag(shell, now, r);
      plans.push(followRenamePlan(shell, target));
      out.push({ fromId: id, fromName: shell.name, toId: target.id, toKey: target.name_key, toName: target.name, moved });
    }
    if (noteIds.size) {
      for (const x of await this.noteRepo.bodiesWithHash()) {
        if (!noteIds.has(x.id)) continue;
        const next = plans.reduce((b, p) => renameBody(b, p), x.body);
        if (next !== x.body) this.noteRepo.setBodyRaw(x.id, next, now);
      }
    }
    return out;
  }

  /* ───────────── 內部 ───────────── */

  private aliveTags(): TagRow[] {
    return [...this.tags.values()].filter((t) => t.deleted_at === null);
  }
  private aliveTaggings(): TaggingRow[] {
    return [...this.taggings.values()].filter((g) => g.deleted_at === null);
  }

  /** 實體存活＋種類（node：ticket/train/car；note：note/diary；別線：other）；不存活／掛不上＝null */
  private async entityKind(type: string, id: string, cache: Map<string, string | null>): Promise<string | null> {
    const ref = type + "\u0001" + id;
    if (cache.has(ref)) return cache.get(ref) ?? null;
    let kind: string | null = "other";
    if (type === "node") {
      const n = await this.nodeRepo.getNode(id);
      kind = n && n.deleted_at === null && TAG_ENTITY_NODE_KINDS.includes(n.kind) ? n.kind : null;
    } else if (type === "note") {
      const x = await this.noteRepo.getNote(id);
      kind = x ? x.kind : null;
    } else if (!(await otherEntityAliveMemory(type, id))) {
      // 別線有登記存活條件（tagEntityAlive.ts；沒登記＝一律 "other"，同插槽之前）
      kind = null;
    }
    cache.set(ref, kind);
    return kind;
  }

  private async assertAttachable(entityType: TagEntityType, entityId: string): Promise<void> {
    if (entityType !== "node") return;
    const n = await this.nodeRepo.getNode(entityId);
    if (!n || n.deleted_at !== null || !TAG_ENTITY_NODE_KINDS.includes(n.kind)) throw new RangeError("這裡掛不上荷札");
  }

  /**
   * 建或復活一個荷札。已存活＝不動（名稱以先建的為準）；不存在＝新建；已刪除＝復活（`renameTo` 時名稱改成新名，
   * 否則沿用先建的 name）。created＝新建或復活（主人眼中它原本不在）。
   */
  private async ensureTag(
    name: string,
    key: string,
    now: string,
    r: TagReceipt,
    renameTo = false,
  ): Promise<{ row: TagRow; created: boolean }> {
    const id = await tagId(key);
    const row = this.tags.get(id);
    if (!row) {
      const fresh: TagRow = { id, name, name_key: key, created_at: now, updated_at: now, deleted_at: null, renamed_to: null };
      this.tags.set(id, fresh);
      r.createdTagIds.push(id);
      return { row: fresh, created: true };
    }
    if (row.deleted_at !== null) {
      // 親手用回已刪的荷札＝刻意重建：改名去向清掉（D-主-121；同 sqlite 版）
      recordTag(r, row);
      row.deleted_at = null;
      row.updated_at = now;
      row.renamed_to = null;
      if (renameTo) row.name = name;
      return { row, created: true };
    }
    return { row, created: false };
  }

  private async ensureTagging(
    entityType: TagEntityType,
    entityId: string,
    tagIdValue: string,
    now: string,
    r: TagReceipt,
  ): Promise<{ already: boolean }> {
    const id = await taggingId(entityType, entityId, tagIdValue);
    const g = this.taggings.get(id);
    if (!g || g.deleted_at !== null) {
      // 「用到這個荷札」的 touch（語義對齊 SqliteTagRepository 的 Stage.touchTag；記憶體版沒有同步，只更新 updated_at）
      const t = this.tags.get(tagIdValue);
      if (t && t.deleted_at === null) t.updated_at = now;
    }
    if (!g) {
      this.taggings.set(id, { id, entity_type: entityType, entity_id: entityId, tag_id: tagIdValue, created_at: now, updated_at: now, deleted_at: null });
      r.createdTaggingIds.push(id);
      return { already: false };
    }
    if (g.deleted_at !== null) {
      recordTaggingBefore(r, g);
      g.deleted_at = null;
      g.updated_at = now;
      return { already: false };
    }
    return { already: true };
  }

  private softDeleteTagging(g: TaggingRow, now: string, r: TagReceipt): void {
    recordTaggingBefore(r, g);
    g.deleted_at = now;
    g.updated_at = now;
  }
  /** `renamedTo` 給了＝改名／併入的「刪舊」，記下去向（同 sqlite 版的 softDeleteTag） */
  private softDeleteTag(t: TagRow, now: string, r: TagReceipt, renamedTo?: string): void {
    recordTag(r, t);
    t.deleted_at = now;
    t.updated_at = now;
    if (renamedTo !== undefined) t.renamed_to = renamedTo;
  }

  /** 內文→taggings 差集；`created` 給了就把新建（含復活）的 tag key 收進去 */
  private async syncBodyCore(noteId: string, body: string, now: string, created: Set<string> | null): Promise<SyncBodyResult> {
    const want = new Map<string, string>();
    for (const o of parseTags(body)) if (!want.has(o.key)) want.set(o.key, o.name);
    const have = this.tagsOf("note", noteId);
    const r = emptyReceipt();
    const added: string[] = [];
    const removed: string[] = [];
    for (const t of have) {
      if (want.has(t.name_key)) continue;
      const g = this.taggings.get(await taggingId("note", noteId, t.id));
      if (g && g.deleted_at === null) {
        this.softDeleteTagging(g, now, r);
        removed.push(t.name_key);
      }
    }
    const haveKeys = new Set(have.map((t) => t.name_key));
    for (const [key, name] of want) {
      if (haveKeys.has(key)) continue;
      const { row, created: c } = await this.ensureTag(name, key, now, r);
      if (c && created) created.add(key);
      await this.ensureTagging("note", noteId, row.id, now, r);
      added.push(key);
    }
    return { added, removed };
  }

  private async backfillCore(): Promise<BackfillResult> {
    const now = nowUtcIso();
    const all = new Set<string>();
    const created = new Set<string>();
    let places = 0;
    for (const x of await this.noteRepo.bodiesWithHash()) {
      const keys = new Set(parseTags(x.body).map((o) => o.key));
      keys.forEach((k) => all.add(k));
      places += keys.size;
      await this.syncBodyCore(x.id, x.body, now, created);
    }
    return { tagCount: all.size, placeCount: places, createdTags: created.size };
  }

  private ensureSeed(): Promise<void> {
    if (!this.ready) this.ready = this.seed ? this.seedDemo() : Promise.resolve();
    return this.ready;
  }

  private async seedDemo(): Promise<void> {
    const targets: NodeRow[] = [];
    try {
      const { routes } = await this.nodeRepo.listSidebar();
      for (const route of routes) {
        const tree = await this.nodeRepo.listRouteTree(route.id);
        for (const n of tree) if (n.deleted_at === null && TAG_ENTITY_NODE_KINDS.includes(n.kind)) targets.push(n);
        if (targets.length >= 12) break;
      }
    } catch (e) {
      console.warn("MemoryTagRepository：讀路線失敗，種子荷札不掛車票", e);
    }
    const now = nowUtcIso();
    const r = emptyReceipt();
    for (const [name, slots] of SEED_TAGS) {
      const n = normalizeName(name);
      if (!n.ok) continue;
      const { row } = await this.ensureTag(n.name, n.key, now, r);
      for (const i of slots) {
        const t = targets[i];
        if (t) await this.ensureTagging("node", t.id, row.id, now, r);
      }
    }
    await this.backfillCore();
  }
}
