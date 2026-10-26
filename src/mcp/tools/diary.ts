/**
 * 外部助理・日記（module 'diary'；契約 §4）：find-diary-entries／get-footprints／add-diary-entries／update-diary-entries／delete-diary-entries。
 *
 * 與筆記同一張 notes 表：本檔只認 kind 'diary'，筆記的 id 一律當「找不到」。
 * 日記的日子＝entry_date（日界線日）；不能寫在未來（同 domain clampDay：UI 翻不到、也改不到未來）。
 * 內文的 #荷札 照 UI 存檔後的流程用 `tagRepo.syncBodyTags` 推導。
 */
import { batch, date, idList, int, nullableStr, range, str } from "../args";
import { McpUserError, type McpCtx, type McpTool } from "../types";
import type { NoteListItem, NotePatch } from "../../data/noteRepository";
import { KIND_LABEL, type NodeKind } from "../../domain/node";
import { entryExcerpt, entryTitle, isBackfilled, matchesQuery } from "../../domain/notes";
import { dayKeyOf, toDateKey } from "../../lib/date";
import { bodyArg, changedTables, clockOf, ID_LIST, loadAllOfKind, syncTags, tagNamesIn } from "./notes";

type Args = Record<string, unknown>;

const FIND_DEFAULT = 50;
const FIND_MAX = 100;
/** 區間最多幾天（約兩個月；契約 §4 的「一次別把整本手帳倒給模型」） */
const RANGE_MAX_DAYS = 62;

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/** 日記的日子：要是真的日子（args.date 會放過 2026-02-30 這種滾日的寫法）、不能晚於今天（營業日） */
function entryDateArg(a: Args, where: string, ctx: McpCtx): string | undefined {
  const d = date(a, "entryDate", { where });
  if (d === undefined) return undefined;
  const [y, m, dd] = d.split("-").map(Number);
  if (toDateKey(new Date(y, m - 1, dd)) !== d) throw new McpUserError(`${where}.entryDate 沒有這一天：「${d}」`);
  if (d > ctx.today) throw new McpUserError(`${where}.entryDate 不能是未來的日子（今天是 ${ctx.today}）`);
  return d;
}

/** 全文：time＝寫下那一刻（營業日表記）；補記（寫下那天不是日記的日子）另附 writtenOn，同 UI 篇頭「寫於 M/D HH:MM（補記）」 */
function full(n: NoteListItem, h: number) {
  const notedDay = dayKeyOf(n.noted_at, h);
  return {
    id: n.id,
    date: n.entry_date ?? "",
    title: n.title ?? undefined,
    body: n.body,
    time: clockOf(n.noted_at, notedDay, h),
    writtenOn: n.entry_date && isBackfilled(n.entry_date, notedDay) ? notedDay : undefined,
    tags: tagNamesIn(n.body),
  };
}

function brief(n: NoteListItem) {
  return { id: n.id, date: n.entry_date ?? "", title: entryTitle(n), excerpt: entryExcerpt(n, 120) || undefined };
}

const findDiaryEntries: McpTool = {
  name: "find-diary-entries",
  title: "找日記",
  description:
    "找日記。三選一：day 某一天（回全文）、from＋to 區間（最多 62 天，回摘要）、或只給 query 搜全部日記（回摘要）；day／區間也可以再加 query 篩。日期 YYYY-MM-DD（照日界線算的日子）。新的日子在前。補記（事後才寫）的全文會附 writtenOn＝寫下那天。",
  inputSchema: {
    type: "object",
    properties: {
      day: { type: "string", description: "YYYY-MM-DD" },
      from: { type: "string", description: "YYYY-MM-DD，含" },
      to: { type: "string", description: "YYYY-MM-DD，含" },
      query: { type: "string", description: "關鍵字，比對標題與內文" },
      limit: { type: "integer", minimum: 1, maximum: FIND_MAX, description: `預設 ${FIND_DEFAULT}` },
    },
    additionalProperties: false,
  },
  module: "diary",
  access: "read",
  annotations: RO,
  async run(a, ctx) {
    const day = date(a, "day");
    const hasRange = a.from !== undefined || a.to !== undefined;
    const query = str(a, "query") ?? "";
    const limit = int(a, "limit", { min: 1, max: FIND_MAX }) ?? FIND_DEFAULT;
    if (day && hasRange) throw new McpUserError("day 與 from／to 只能擇一");
    if (!day && !hasRange && !query) throw new McpUserError("要給 day、from＋to，或 query 其中一種");
    const { noteRepo } = ctx.deps;

    if (day) {
      const rows = (await noteRepo.listDiary(day)).filter((n) => matchesQuery(n, query));
      const shown = rows.slice(0, limit).map((n) => full(n, ctx.dayStartHour));
      const cut = rows.length > limit;
      return {
        summary: shown.length ? `${day} 有 ${rows.length} 篇日記${cut ? `，只列前 ${limit} 篇` : ""}` : `${day} 沒有${query ? "符合的" : ""}日記`,
        data: { entries: shown, truncated: cut || undefined },
      };
    }

    let rows: NoteListItem[] = [];
    let span = "";
    if (hasRange) {
      const { from, to } = range(a, "from", "to", RANGE_MAX_DAYS);
      span = `${from}～${to} `;
      // listDiaryDays 只回有日記的日子；新的日子在前、同一天照 listDiary 的時刻順序
      const days = (await noteRepo.listDiaryDays(from, to)).reverse();
      for (const d of days) {
        rows.push(...(await noteRepo.listDiary(d)).filter((n) => matchesQuery(n, query)));
        if (rows.length > limit) break;
      }
    } else {
      rows = await noteRepo.searchDiary({ query, limit: limit + 1 });
    }
    const cut = rows.length > limit;
    const shown = rows.slice(0, limit).map(brief);
    return {
      summary: shown.length
        ? `${span}找到 ${cut ? `超過 ${limit}` : shown.length} 篇日記${cut ? `，只列最新的 ${limit} 篇` : ""}（全文用 day 查那一天）`
        : `${span}沒有${query ? "符合的" : ""}日記`,
      data: { entries: shown, truncated: cut || undefined },
    };
  },
};

const getFootprints: McpTool = {
  name: "get-footprints",
  title: "看當天足跡",
  description:
    "某一天的足跡：済章（那天完成的車票＝task、列車、車廂與定期券班次，含心情燈號）與手記（那天寫在車票上的工作日誌）。日子照日界線算，時刻 HH:MM 營業日表記（可能 ≥ 24:00）；taskId 可以拿去 get-task。時間塊請用 find-time-blocks。",
  inputSchema: {
    type: "object",
    properties: { day: { type: "string", description: "YYYY-MM-DD；預設今天" } },
    additionalProperties: false,
  },
  module: "diary",
  access: "read",
  annotations: RO,
  async run(a, ctx) {
    const day = date(a, "day") ?? ctx.today;
    const h = ctx.dayStartHour;
    // 同 notesStore.loadFootprint：listFootprints(day, uiStore.dayStartHour)
    const f = await ctx.deps.noteRepo.listFootprints(day, h);
    const seals = f.seals.map((s) => ({
      taskId: s.nodeId,
      name: s.name,
      kind: KIND_LABEL[s.kind as NodeKind],
      time: clockOf(s.at, day, h),
      mood: s.mood ?? undefined,
      runDate: s.dueOn ?? undefined,
    }));
    const logs = f.logs.map((l) => ({
      taskId: l.nodeMissing ? undefined : l.nodeId,
      ticket: l.nodeName,
      body: l.body,
      time: clockOf(l.at, day, h),
    }));
    const parts = [seals.length && `${seals.length} 枚済章`, logs.length && `${logs.length} 則手記`].filter(Boolean);
    return {
      summary: `${day} 的足跡：${parts.length ? parts.join("、") : "沒有"}`,
      data: { day, seals, logs },
    };
  },
};

const addDiaryEntries: McpTool = {
  name: "add-diary-entries",
  title: "寫日記",
  description:
    "寫日記，一次最多 50 篇。entryDate＝記在哪一天（YYYY-MM-DD，預設今天、不能是未來）；同一天可以有好幾篇。內文的 #荷札 會自動掛上。",
  inputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            entryDate: { type: "string", description: "YYYY-MM-DD；預設今天" },
            body: { type: "string", description: "內文（Markdown）；與 title 至少給一個" },
            title: { type: "string", description: "選填" },
          },
          additionalProperties: false,
        },
      },
    },
    required: ["entries"],
    additionalProperties: false,
  },
  module: "diary",
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async run(a, ctx) {
    const items = batch(a, "entries");
    const plans = items.map((it, i) => {
      const where = `entries[${i}]`;
      const p = {
        entryDate: entryDateArg(it, where, ctx) ?? ctx.today,
        body: bodyArg(it, "body", { required: false, where }) ?? "",
        title: str(it, "title", { where }) || null,
      };
      // 同 notesStore.saveDiaryDraft：標題與內文都空＝不建
      if (!p.body.trim() && !p.title) throw new McpUserError(`${where} 的 body 與 title 至少要有一個`);
      return p;
    });
    const { noteRepo } = ctx.deps;
    const created = [];
    let tagsTouched = false;
    for (const p of plans) {
      // 同 notesStore.saveDiaryDraft：create（inbox:false）之後 tagStore.syncNoteTags(row.id, body)
      const row = await noteRepo.create({ kind: "diary", body: p.body, title: p.title, inbox: false, entryDate: p.entryDate });
      if (await syncTags(ctx, row.id, p.body)) tagsTouched = true;
      created.push({ id: row.id, date: p.entryDate, title: entryTitle(row) });
    }
    const days = [...new Set(plans.map((p) => p.entryDate))];
    return {
      summary: `已寫 ${created.length} 篇日記（${days.length === 1 ? days[0] : `${days.length} 天`}）`,
      data: { created },
      changed: changedTables(tagsTouched),
      toast: `外部助理寫了 ${created.length} 篇日記`,
    };
  },
};

const updateDiaryEntries: McpTool = {
  name: "update-diary-entries",
  title: "修改日記",
  description: "修改日記，一次最多 50 篇；只給要改的欄位。entryDate 改記在哪一天（不能是未來）；title 給 null＝清掉標題；body 整份取代內文。",
  inputSchema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            entryDate: { type: "string", description: "YYYY-MM-DD" },
            title: { type: ["string", "null"] },
            body: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["entries"],
    additionalProperties: false,
  },
  module: "diary",
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async run(a, ctx) {
    const items = batch(a, "entries");
    const ids = items.map((it, i) => str(it, "id", { required: true, where: `entries[${i}]` }));
    const cur = await loadAllOfKind(ctx, ids, "diary", "日記");
    const plans = items.map((it, i) => {
      const where = `entries[${i}]`;
      const patch: NotePatch = {};
      // 同 notesStore.setDiaryEntryDate：只改 entry_date（clampDay 的「不能到未來」在 entryDateArg 擋）
      const d = entryDateArg(it, where, ctx);
      if (d !== undefined) patch.entry_date = d;
      const title = nullableStr(it, "title", where);
      if (title !== undefined) patch.title = title || null;
      const body = bodyArg(it, "body", { required: false, where });
      if (body !== undefined) patch.body = body;
      if (!Object.keys(patch).length) throw new McpUserError(`${where} 沒有要改的欄位`);
      return { id: cur[i].id, patch };
    });
    const { noteRepo } = ctx.deps;
    let tagsTouched = false;
    for (const p of plans) {
      await noteRepo.update(p.id, p.patch);
      // 同 DiaryEntry／MobileDiaryEntry：改過內文 ⇒ tagStore.syncNoteTags(id, body)
      if (p.patch.body !== undefined && (await syncTags(ctx, p.id, p.patch.body))) tagsTouched = true;
    }
    return {
      summary: `已修改 ${plans.length} 篇日記`,
      data: { updated: plans.map((p) => p.id) },
      changed: changedTables(tagsTouched),
      toast: `外部助理修改了 ${plans.length} 篇日記`,
    };
  },
};

const deleteDiaryEntries: McpTool = {
  name: "delete-diary-entries",
  title: "刪除日記",
  description: "刪除日記，一次最多 50 篇。刪除可以在 App 裡復原。",
  inputSchema: {
    type: "object",
    properties: { ids: { ...ID_LIST, description: "日記 id" } },
    required: ["ids"],
    additionalProperties: false,
  },
  module: "diary",
  access: "write",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  async run(a, ctx) {
    const ids = [...new Set(idList(a, "ids"))];
    const rows = await loadAllOfKind(ctx, ids, "diary", "日記");
    // 同 notesStore.deleteDiaryEntry：softDelete
    for (const n of rows) await ctx.deps.noteRepo.softDelete(n.id);
    return {
      summary: `已刪除 ${rows.length} 篇日記（App 裡可以復原）`,
      data: { deleted: rows.map((n) => ({ id: n.id, date: n.entry_date ?? "", title: entryTitle(n) })) },
      changed: ["notes"],
      toast: `外部助理刪除了 ${rows.length} 篇日記`,
      undo: async () => (await ctx.deps.noteRepo.restore(rows.map((n) => n.id)), ["notes"]),
    };
  },
};

export const DIARY_TOOLS: McpTool[] = [findDiaryEntries, getFootprints, addDiaryEntries, updateDiaryEntries, deleteDiaryEntries];
