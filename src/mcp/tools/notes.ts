/**
 * 外部助理・筆記（module 'notes'；契約 §4）：find-notes／get-note／add-notes／update-notes／delete-notes。
 *
 * 與日記同一張 notes 表（kind 'note'｜'diary'）：本檔只認 kind 'note'，日記的 id 一律當「找不到」。
 * 荷札＝內文的 `#名稱`（內文是正本）：tags／addTags 是改寫內文，再照 UI 存檔後的 `tagStore.syncNoteTags`
 * 呼叫 `tagRepo.syncBodyTags` 推導 taggings——直接 attach 的話，主人下次在 App 裡改內文就會被摘掉。
 * 日記工具（`diary.ts`）共用本檔下半段的小工具。
 */
import { batch, bool, idList, int, nullableStr, str } from "../args";
import { McpUserError, type JsonSchema, type McpCtx, type McpTool } from "../types";
import type { NoteListItem, NotePatch, NotesQuery } from "../../data/noteRepository";
import { KIND_LABEL, type NodeRow } from "../../domain/node";
import { descendantIds, excerpt, matchesQuery, noteTitle, NOTE_NODE_KINDS, type NoteKind } from "../../domain/notes";
import { normalizeName, parseTags, removeTagText, tagKeysIn } from "../../domain/tags";
import { dayKeyOf, nowClockMinutes, clockText } from "../../lib/date";

type Args = Record<string, unknown>;

const FIND_DEFAULT = 50;
const FIND_MAX = 100;
/** 一則筆記一次最多掛幾個荷札（防呆；UI 沒有上限，內文寫多少就掛多少） */
const TAGS_MAX = 20;

/* ───────── 共用小工具（diary.ts 也用） ───────── */

/** 內文：只去尾端空白（同 notesStore 的 `replace(/\s+$/, "")`；開頭縮排是 Markdown 的一部分，不能像 args.str 那樣吃掉） */
export function bodyArg(a: Args, key: string, opts: { required: boolean; where: string }): string | undefined {
  const v = a[key];
  const at = `${opts.where}.${key}`;
  if (v === undefined || v === null) {
    if (opts.required) throw new McpUserError(`缺少 ${at}`);
    return undefined;
  }
  if (typeof v !== "string") throw new McpUserError(`${at} 要是字串`);
  const t = v.replace(/\s+$/, "");
  if (opts.required && !t.trim()) throw new McpUserError(`${at} 不能是空字串`);
  return t;
}

/** 字串陣列（選填；荷札名稱清單之類） */
function strList(a: Args, key: string, where: string, max: number): string[] | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  const at = `${where}.${key}`;
  if (!Array.isArray(v)) throw new McpUserError(`${at} 要是字串陣列`);
  if (v.length > max) throw new McpUserError(`${at} 最多 ${max} 個`);
  return v.map((x, i) => {
    if (typeof x !== "string" || !x.trim()) throw new McpUserError(`${at}[${i}] 要是非空字串`);
    return x.trim();
  });
}

/** 荷札名稱 → key；不合法＝McpUserError（理由照 normalizeName 的字） */
function tagKey(raw: string, at: string): { name: string; key: string } {
  const n = normalizeName(raw);
  if (!n.ok) throw new McpUserError(`${at}「${raw}」不能當荷札：${n.reason}`);
  return { name: n.name, key: n.key };
}

/** 內文沒有的荷札補在最後一段（`#a #b`）；補完再解析一次，解析不出來（例如像色碼的 #ABC123）就退回 */
function addTagsToBody(body: string, raws: readonly string[], at: string): string {
  const have = new Set(tagKeysIn(body));
  const adds: { name: string; key: string }[] = [];
  raws.forEach((raw, i) => {
    const t = tagKey(raw, `${at}[${i}]`);
    if (!have.has(t.key) && !adds.some((x) => x.key === t.key)) adds.push(t);
  });
  if (!adds.length) return body;
  const next = body + (body.trim() ? "\n\n" : "") + adds.map((t) => `#${t.name}`).join(" ");
  const got = new Set(tagKeysIn(next));
  const bad = adds.find((t) => !got.has(t.key));
  if (bad) throw new McpUserError(`${at}「${bad.name}」寫進內文後不會被當成荷札（像色碼，或內文最後有沒關上的程式碼區塊），請換個名稱`);
  return next;
}

function removeTagsFromBody(body: string, raws: readonly string[], at: string): string {
  const have = new Set(tagKeysIn(body));
  const keys = raws.map((raw, i) => {
    const t = tagKey(raw, `${at}[${i}]`);
    if (!have.has(t.key)) throw new McpUserError(`${at}[${i}] 內文沒有荷札 #${t.name}`);
    return t.key;
  });
  return removeTagText(body, keys).replace(/\s+$/, "");
}

/** 內文裡的荷札名稱（去重、照出現順序） */
export function tagNamesIn(body: string): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of parseTags(body)) {
    if (seen.has(o.key)) continue;
    seen.add(o.key);
    out.push(o.name);
  }
  return out.length ? out : undefined;
}

/** UTC ISO → 那個營業日的 HH:MM（營業日表記；落在別天就退回牆鐘 HH:MM） */
export function clockOf(iso: string, day: string, dayStartHour: number): string {
  const t = Date.parse(iso);
  const m = nowClockMinutes(day, dayStartHour, t);
  if (m !== null) return clockText(m) ?? "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 讀一則、而且要是這個 kind；別的 kind 一律當不存在（跨模組的 id 不透露） */
export async function getOfKind(ctx: McpCtx, id: string, kind: NoteKind): Promise<NoteListItem | null> {
  const n = await ctx.deps.noteRepo.getNote(id);
  return n && n.kind === kind ? n : null;
}

/** 陣列寫入共用：先全部檢查、有一筆不行就整批不寫（id 重複也擋，免得同一則被改兩次互蓋） */
export async function loadAllOfKind(ctx: McpCtx, ids: readonly string[], kind: NoteKind, label: string): Promise<NoteListItem[]> {
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new McpUserError(`同一${label === "筆記" ? "則" : "篇"}${label}出現兩次：${dup}`);
  const rows = await Promise.all(ids.map((id) => getOfKind(ctx, id, kind)));
  const missing = ids.filter((_, i) => !rows[i]);
  if (missing.length) throw new McpUserError(`找不到這些${label}（可能已刪除，或 id 不是${label}）：${missing.join("、")}；整批都沒有寫入`);
  return rows as NoteListItem[];
}

/**
 * 內文→荷札同步（＝tagStore.syncNoteTags）：失敗只記 log、不讓整個呼叫失敗——筆記已經寫進去了，
 * 回錯的話助理會以為沒寫成而重送一次（UI 同樣吞掉）；下次在 App 裡存檔或通車補掛會再對齊。回「有沒有動到荷札表」。
 */
export async function syncTags(ctx: McpCtx, id: string, body: string): Promise<boolean> {
  try {
    const r = await ctx.deps.tagRepo.syncBodyTags(id, body);
    return r.added.length > 0 || r.removed.length > 0;
  } catch (e) {
    console.warn("外部助理：荷札同步失敗", id, e);
    return false;
  }
}

export function changedTables(tagsTouched: boolean): string[] {
  return tagsTouched ? ["notes", "tags", "taggings"] : ["notes"];
}

export const ID_LIST: JsonSchema = { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 };
const TAG_LIST = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, maxItems: TAGS_MAX, description });

/* ───────── 給模型讀的形狀 ───────── */

function attachedTo(n: NoteListItem): { id: string; name?: string; kind?: string; missing?: true } | undefined {
  if (!n.node_id) return undefined;
  if (n.node_missing || !n.node_kind) return { id: n.node_id, missing: true };
  return { id: n.node_id, name: n.node_name ?? "", kind: KIND_LABEL[n.node_kind] };
}

function brief(n: NoteListItem, h: number) {
  return {
    id: n.id,
    title: noteTitle(n),
    excerpt: excerpt(n, 80) || undefined,
    date: dayKeyOf(n.noted_at, h),
    inbox: n.inbox === 1 || undefined,
    attachedTo: attachedTo(n),
    tags: tagNamesIn(n.body),
  };
}

/** ORDER BY noted_at DESC, created_at DESC（同 repository 的列表排序） */
function byNotedDesc(a: NoteListItem, b: NoteListItem): number {
  return b.noted_at.localeCompare(a.noted_at) || b.created_at.localeCompare(a.created_at);
}

/* ───────── 節點 ───────── */

/** 掛載目標：UI 的挑選器只給路線／支線／列車／車廂（NOTE_NODE_KINDS），這裡照同一張表擋 */
async function attachable(ctx: McpCtx, id: string, at: string): Promise<NodeRow> {
  const n = await ctx.deps.nodeRepo.getNode(id);
  if (!n || n.deleted_at !== null) throw new McpUserError(`${at} 找不到節點「${id}」`);
  if (!NOTE_NODE_KINDS.includes(n.kind)) {
    throw new McpUserError(`${at} 筆記只能掛在路線、支線、列車或車廂上（「${n.name}」是${KIND_LABEL[n.kind]}）`);
  }
  return n;
}

/**
 * find-notes 的節點篩選＝App 的兩種：路線＝整條（listNotes 的 routeId，含掛在它底下的）；
 * 支線／列車／車廂＝它與它底下（underNode，同側板「還有 N 則 → 到旅客筆記看」；子孫照 nodeStore 的 childrenOf 從路線樹推）
 */
async function nodeFilter(ctx: McpCtx, id: string): Promise<{ query: Pick<NotesQuery, "routeId" | "underNode">; test: (n: NoteListItem) => boolean }> {
  const node = await attachable(ctx, id, "nodeId");
  if (node.kind === "route") return { query: { routeId: node.id }, test: (n) => n.route_id === node.id };
  const childrenOf: Record<string, string[]> = {};
  if (node.route_id) {
    for (const r of await ctx.deps.nodeRepo.listRouteTree(node.route_id)) {
      if (r.parent_id) (childrenOf[r.parent_id] ??= []).push(r.id);
    }
  }
  const ids = [node.id, ...descendantIds(childrenOf, node.id)];
  const set = new Set(ids);
  return { query: { underNode: { id: node.id, ids, label: node.name } }, test: (n) => n.node_id !== null && set.has(n.node_id) };
}

/* ───────── 工具 ───────── */

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const findNotes: McpTool = {
  name: "find-notes",
  title: "找筆記",
  description:
    "找旅客筆記（不含日記）。可依關鍵字（標題與內文）、荷札（tag，含子荷札）、收件匣（inbox＝未整理）、掛在哪個節點（路線／支線／列車／車廂）篩選，條件可並用；新的在前。回摘要，全文用 get-note。",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "關鍵字，比對標題與內文" },
      tag: { type: "string", description: "荷札名稱，可帶或不帶 #；含它的子荷札（例 專案 也找到 專案/搬家）" },
      inbox: { type: "boolean", description: "true＝只看收件匣；false＝只看已整理的筆記；省略＝都看" },
      nodeId: { type: "string", description: "路線＝整條路線；支線／列車／車廂＝它與它底下" },
      limit: { type: "integer", minimum: 1, maximum: FIND_MAX, description: `預設 ${FIND_DEFAULT}` },
    },
    additionalProperties: false,
  },
  module: "notes",
  access: "read",
  annotations: RO,
  async run(a, ctx) {
    const query = str(a, "query") ?? "";
    const tagRaw = str(a, "tag");
    const inbox = bool(a, "inbox");
    const nodeId = str(a, "nodeId");
    const limit = int(a, "limit", { min: 1, max: FIND_MAX }) ?? FIND_DEFAULT;
    const { noteRepo, tagRepo } = ctx.deps;
    const node = nodeId ? await nodeFilter(ctx, nodeId) : null;

    let rows: NoteListItem[] = [];
    if (tagRaw) {
      const { key } = tagKey(tagRaw, "tag");
      const hits = await tagRepo.listUnder(key, "note");
      const got = await Promise.all(hits.filter((h) => h.kind === "note" && h.note.kind === "note").map((h) => noteRepo.getNote(h.id)));
      rows = got.filter((n): n is NoteListItem => !!n);
    } else {
      if (inbox !== false) rows.push(...(await noteRepo.listInbox()));
      if (inbox !== true) rows.push(...(await noteRepo.listNotes({ query, ...node?.query, limit: limit + 1 })));
    }
    const hits = rows
      .filter((n) => n.kind === "note")
      .filter((n) => inbox === undefined || (n.inbox === 1) === inbox)
      .filter((n) => matchesQuery(n, query))
      .filter((n) => !node || node.test(n))
      .sort(byNotedDesc);
    const shown = hits.slice(0, limit).map((n) => brief(n, ctx.dayStartHour));
    const cut = hits.length > limit;
    return {
      summary: shown.length
        ? `找到 ${cut ? `超過 ${limit}` : shown.length} 則筆記${cut ? `，只列最新的 ${limit} 則（加條件可以縮小範圍）` : ""}`
        : "沒有符合的筆記",
      data: { notes: shown, truncated: cut || undefined },
    };
  },
};

const getNote: McpTool = {
  name: "get-note",
  title: "看一則筆記",
  description:
    "讀一則旅客筆記的全文、荷札（tags）、掛在哪個節點、是否還在收件匣。date／time 照日界線算（time 是營業日表記，凌晨可能 ≥ 24:00）。日記請用 find-diary-entries。",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "筆記 id（find-notes 回的）" } },
    required: ["id"],
    additionalProperties: false,
  },
  module: "notes",
  access: "read",
  annotations: RO,
  async run(a, ctx) {
    const id = str(a, "id", { required: true });
    const n = await getOfKind(ctx, id, "note");
    if (!n) throw new McpUserError(`找不到筆記「${id}」（可能已刪除，或這個 id 不是筆記）`);
    const tags = await ctx.deps.tagRepo.listTagsOf("note", n.id);
    const day = dayKeyOf(n.noted_at, ctx.dayStartHour);
    return {
      summary: `筆記「${noteTitle(n)}」`,
      data: {
        id: n.id,
        title: n.title ?? undefined,
        body: n.body,
        date: day,
        time: clockOf(n.noted_at, day, ctx.dayStartHour),
        inbox: n.inbox === 1,
        attachedTo: attachedTo(n),
        tags: tags.length ? tags.map((t) => t.name) : undefined,
      },
    };
  },
};

const addNotes: McpTool = {
  name: "add-notes",
  title: "新增筆記",
  description:
    "新增旅客筆記，一次最多 50 則。tags 會以 #荷札 補在內文最後（內文裡已有的 #荷札 也會自動掛上）。nodeId 掛在路線／支線／列車／車廂上；inbox:true 放進收件匣（未整理），但掛了節點就直接存進筆記。",
  inputSchema: {
    type: "object",
    properties: {
      notes: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "選填；省略時列表顯示內文第一行" },
            body: { type: "string", description: "內文（Markdown）；與 title 至少給一個" },
            tags: TAG_LIST("荷札名稱，可帶或不帶 #；階層用 /（例 專案/搬家）"),
            nodeId: { type: "string", description: "要掛的路線／支線／列車／車廂 id" },
            inbox: { type: "boolean", description: "預設 false" },
          },
          additionalProperties: false,
        },
      },
    },
    required: ["notes"],
    additionalProperties: false,
  },
  module: "notes",
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(a, ctx) {
    const items = batch(a, "notes");
    // 先全部檢查（節點、荷札名稱），一筆不行就整批不寫
    const plans = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const where = `notes[${i}]`;
      const title = str(it, "title", { where }) || null;
      let body = bodyArg(it, "body", { required: false, where }) ?? "";
      const tags = strList(it, "tags", where, TAGS_MAX);
      if (tags) body = addTagsToBody(body, tags, `${where}.tags`);
      // 同 notesStore.saveNote：標題與內文都空＝不建
      if (!body.trim() && !title) throw new McpUserError(`${where} 的 body 與 title 至少要有一個`);
      const nodeId = str(it, "nodeId", { where });
      const node = nodeId ? await attachable(ctx, nodeId, `${where}.nodeId`) : null;
      // 掛了節點就不進收件匣（同 domain resolveDestination／applyCapturePreset：收件匣票根＋路線或預掛節點＝存進筆記的家）
      const inbox = !!bool(it, "inbox", where) && !node;
      plans.push({ title, body, nodeId: node?.id ?? null, inbox });
    }
    const { noteRepo } = ctx.deps;
    const created = [];
    let tagsTouched = false;
    for (const p of plans) {
      // 同 notesStore.saveCapture：create 之後 tagStore.syncNoteTags(row.id, body)
      const row = await noteRepo.create({ kind: "note", body: p.body, title: p.title, nodeId: p.nodeId, inbox: p.inbox });
      if (await syncTags(ctx, row.id, p.body)) tagsTouched = true;
      created.push({ id: row.id, title: noteTitle(row), inbox: p.inbox || undefined, tags: tagNamesIn(p.body) });
    }
    const inboxN = plans.filter((p) => p.inbox).length;
    return {
      summary: `已建立 ${created.length} 則筆記${inboxN ? `（${inboxN} 則在收件匣）` : ""}`,
      data: { created },
      changed: changedTables(tagsTouched),
      toast: `外部助理建立了 ${created.length} 則筆記`,
    };
  },
};

const updateNotes: McpTool = {
  name: "update-notes",
  title: "修改筆記",
  description:
    "修改旅客筆記，一次最多 50 則；只給要改的欄位。title 給 null＝清掉標題；nodeId 給 null＝不掛；inbox:false＝從收件匣整理成筆記。addTags／removeTags 會改寫內文裡的 #荷札。",
  inputSchema: {
    type: "object",
    properties: {
      notes: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: ["string", "null"] },
            body: { type: "string", description: "整份取代內文" },
            nodeId: { type: ["string", "null"], description: "路線／支線／列車／車廂 id；null＝不掛" },
            inbox: { type: "boolean", description: "false＝整理出收件匣；掛著節點的不能放回收件匣" },
            addTags: TAG_LIST("要加的荷札（補在內文最後）"),
            removeTags: TAG_LIST("要拿掉的荷札（從內文刪掉那個 #字，子荷札不受影響）"),
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["notes"],
    additionalProperties: false,
  },
  module: "notes",
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async run(a, ctx) {
    const items = batch(a, "notes");
    const ids = items.map((it, i) => str(it, "id", { required: true, where: `notes[${i}]` }));
    const cur = await loadAllOfKind(ctx, ids, "note", "筆記");
    const plans: { id: string; patch: NotePatch }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const n = cur[i];
      const where = `notes[${i}]`;
      const patch: NotePatch = {};
      const title = nullableStr(it, "title", where);
      if (title !== undefined) patch.title = title || null;
      const body0 = bodyArg(it, "body", { required: false, where });
      let body = body0 ?? n.body;
      const rm = strList(it, "removeTags", where, TAGS_MAX);
      if (rm) body = removeTagsFromBody(body, rm, `${where}.removeTags`);
      const add = strList(it, "addTags", where, TAGS_MAX);
      if (add) body = addTagsToBody(body, add, `${where}.addTags`);
      if (body0 !== undefined || body !== n.body) patch.body = body;
      let nodeId = n.node_id;
      if (it.nodeId === null) patch.node_id = nodeId = null;
      else if (it.nodeId !== undefined) {
        const node = await attachable(ctx, str(it, "nodeId", { required: true, where }), `${where}.nodeId`);
        patch.node_id = nodeId = node.id;
        if (n.inbox === 1) patch.inbox = 0; // 掛上節點＝存進筆記的家（同 add-notes 的規則）
      }
      const inbox = bool(it, "inbox", where);
      if (inbox !== undefined) {
        if (inbox && nodeId) throw new McpUserError(`${where} 掛在節點上的筆記不能放回收件匣（先把 nodeId 設成 null）`);
        patch.inbox = inbox ? 1 : 0;
      }
      if (!Object.keys(patch).length) throw new McpUserError(`${where} 沒有要改的欄位`);
      plans.push({ id: n.id, patch });
    }
    const { noteRepo } = ctx.deps;
    let tagsTouched = false;
    for (const p of plans) {
      await noteRepo.update(p.id, p.patch);
      // 同 NoteContent／MobileNotePage：改過內文 ⇒ tagStore.syncNoteTags(id, body)
      if (p.patch.body !== undefined && (await syncTags(ctx, p.id, p.patch.body))) tagsTouched = true;
    }
    return {
      summary: `已修改 ${plans.length} 則筆記`,
      data: { updated: plans.map((p) => p.id) },
      changed: changedTables(tagsTouched),
      toast: `外部助理修改了 ${plans.length} 則筆記`,
    };
  },
};

const deleteNotes: McpTool = {
  name: "delete-notes",
  title: "刪除筆記",
  description: "刪除旅客筆記，一次最多 50 則。刪除可以在 App 裡復原。",
  inputSchema: {
    type: "object",
    properties: { ids: { ...ID_LIST, description: "筆記 id" } },
    required: ["ids"],
    additionalProperties: false,
  },
  module: "notes",
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async run(a, ctx) {
    const ids = [...new Set(idList(a, "ids"))];
    const rows = await loadAllOfKind(ctx, ids, "note", "筆記");
    // 同 notesStore.deleteNote：softDelete；taggings 不用摘（荷札的讀取一律 JOIN 實體存活）
    for (const n of rows) await ctx.deps.noteRepo.softDelete(n.id);
    return {
      summary: `已刪除 ${rows.length} 則筆記（App 裡可以復原）`,
      data: { deleted: rows.map((n) => ({ id: n.id, title: noteTitle(n) })) },
      changed: ["notes"],
      toast: `外部助理刪除了 ${rows.length} 則筆記`,
      undo: async () => (await ctx.deps.noteRepo.restore(rows.map((n) => n.id)), ["notes"]),
    };
  },
};

export const NOTE_TOOLS: McpTool[] = [findNotes, getNote, addNotes, updateNotes, deleteNotes];
