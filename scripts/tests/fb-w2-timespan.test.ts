/**
 * 第二梯回饋專卷（fe-pickers-board · feat/fb-w2-timespan）單元測試：
 *   1. 【操作 10 · D-FB-3】TimeSpanDurationFields：牆鐘毫秒區間雙向互推（改開始平移結束、改結束更新時長、改時長正推結束與過去補記回推開始、運行中預計到着反推時長）
 *   2. 【操作 9 · D-FB-4】notesStore 收件匣多選批量動作：排乘車日、掛路線、掛／摘 #荷札（含筆記內文同步）、刪除與單鍵復原
 *   3. 【操作 9 · D-FB-4】waitroomActs 候車室多選批量動作：換番線（種類）、掛／摘 #荷札、刪除與單鍵復原
 *
 * 跑法：`node --test scripts/tests/fb-w2-timespan.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const FAKE_DB = `
let t = Date.UTC(2026, 10, 20, 1, 0, 0);
export function getDb() { throw new Error("測試不用 SQLite"); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export const SYNC_SETTINGS_KEYS = new Set();
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch() {}
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const FAKE_DATA_INDEX = `
export const nodeRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__w2NodeRepo;
    if (!mock) throw new Error("測試沒設 __w2NodeRepo");
    const v = mock[prop];
    return typeof v === "function" ? v.bind(mock) : v;
  }
});
export const settingsRepo = { get: async () => null, set: async () => {} };
`;
const FAKE_NOTE_REPO = `
export const noteRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__w2NoteRepo;
    if (!mock) throw new Error("測試沒設 __w2NoteRepo");
    const v = mock[prop];
    return typeof v === "function" ? v.bind(mock) : v;
  }
});
`;
const FAKE_TAG_REPO = `
export const tagRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__w2TagRepo;
    if (!mock) throw new Error("測試沒設 __w2TagRepo");
    const v = mock[prop];
    return typeof v === "function" ? v.bind(mock) : v;
  }
});
`;
const FAKE_TICKET_REPO = `
export const ticketRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__w2TicketRepo;
    if (!mock) throw new Error("測試沒設 __w2TicketRepo");
    const v = mock[prop];
    return typeof v === "function" ? v.bind(mock) : v;
  }
});
`;
const FAKE_TIMETABLE_REPO = `export const timetableRepo = {};`;
const FAKE_DELETE_FLOW = `export async function confirmAndDeleteNode() {}`;
const FAKE_FOOTPRINT_BLOCKS = `export const dayBlocksProvider = { get: async () => [] };`;
const FAKE_LINES_RUNTIME = `export function lineCaptureTargets() { return []; }`;
const FAKE_NODE_STORE = `
const fn = () => [];
fn.getState = () => globalThis.__w2NodeStoreState;
export const useNodeStore = fn;
`;
const FAKE_TAG_STORE = `
const fn = () => null;
fn.getState = () => globalThis.__w2TagStoreState;
fn.setState = () => {};
export const useTagStore = fn;
`;
const FAKE_TICKET_STORE = `
const fn = () => null;
fn.getState = () => globalThis.__w2TicketStoreState;
export const useTicketStore = fn;
`;
const FAKE_TIMETABLE_STORE = `
const fn = () => null;
fn.getState = () => ({ ready: false, refresh: async () => {} });
export const useTimetableStore = fn;
`;
const FAKE_UI_STORE = `
const state = {
  dayStartHour: 4,
  lastToast: null,
  showToast(t) { state.lastToast = t; globalThis.__w2LastToast = t; },
  readLastNav: () => ({}),
  writeLastNav: () => {},
  bumpCalendarMarks: () => {},
};
export const useUiStore = { getState: () => state };
`;
const FAKE_NOOP_UI = `
export async function attachQuickTags() {}
export async function jumpToNode() {}
export async function jumpToNodeMobile() {}
export function routePresetColor() { return "indigo"; }
export function defaultRouteColorIndex() { return 0; }
export const notesFlush = { fn: null };
export async function gotoTimetable() {}
export async function openBlock() {}
`;

const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository") return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      if (specifier === "../../data" || specifier === "../data") return { url: dataUrl(FAKE_DATA_INDEX), shortCircuit: true };
      if (specifier === "../../data/noteRepo" || specifier === "../data/noteRepo") return { url: dataUrl(FAKE_NOTE_REPO), shortCircuit: true };
      if (specifier === "../../data/tagRepo" || specifier === "../data/tagRepo") return { url: dataUrl(FAKE_TAG_REPO), shortCircuit: true };
      if (specifier === "../../data/ticketRepository") return { url: dataUrl(FAKE_TICKET_REPO), shortCircuit: true };
      if (specifier === "../../data/timetableRepository") return { url: dataUrl(FAKE_TIMETABLE_REPO), shortCircuit: true };
      if (specifier === "../ui/common/deleteNodeFlow") return { url: dataUrl(FAKE_DELETE_FLOW), shortCircuit: true };
      if (specifier === "../ui/notes/footprintBlocks") return { url: dataUrl(FAKE_FOOTPRINT_BLOCKS), shortCircuit: true };
      if (specifier === "../lines/runtime") return { url: dataUrl(FAKE_LINES_RUNTIME), shortCircuit: true };
      if (specifier === "../../store/nodeStore" || specifier === "../store/nodeStore" || specifier === "./nodeStore") {
        return { url: dataUrl(FAKE_NODE_STORE), shortCircuit: true };
      }
      if (specifier === "../../store/tagStore" || specifier === "../store/tagStore" || specifier === "./tagStore") {
        return { url: dataUrl(FAKE_TAG_STORE), shortCircuit: true };
      }
      if (specifier === "../../store/ticketStore") return { url: dataUrl(FAKE_TICKET_STORE), shortCircuit: true };
      if (specifier === "../../store/timetableStore") return { url: dataUrl(FAKE_TIMETABLE_STORE), shortCircuit: true };
      if (specifier === "../../store/uiStore" || specifier === "./uiStore") return { url: dataUrl(FAKE_UI_STORE), shortCircuit: true };
      if (
        specifier === "../common/quickadd/useQuickAdd" ||
        specifier === "../common/QuickJump" ||
        specifier === "../mobile/routeMapReveal" ||
        specifier === "../common/ColorPicker" ||
        specifier === "../panel/routeFlowRules" ||
        specifier === "../notes/notesFlush" ||
        specifier === "../../lines/timetableTagEntities"
      ) {
        return { url: dataUrl(FAKE_NOOP_UI), shortCircuit: true };
      }
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          try {
            return nextResolve(specifier + ".tsx", context);
          } catch {
            return nextResolve(specifier + "/index.ts", context);
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  applySpanDurationMin,
  applySpanEndMs,
  applySpanStartMs,
  arrivalMsFromEst,
  estMinFromArrivalMs,
  spanDurationMin,
} = await import("../../src/ui/common/timespan/TimeSpanDurationFields.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { useNotesStore } = await import("../../src/store/notesStore.ts");
const {
  batchAttachWishTag,
  batchDeleteWishes,
  batchDetachWishTag,
  batchSetWishKind,
} = await import("../../src/ui/waitroom/waitroomActs.ts");

const MIN = 60_000;
const BASE_04 = Date.UTC(2026, 10, 20, 4, 0, 0); // 04:00 日界線起點
const atMin = (m: number) => BASE_04 + m * MIN;

describe("【操作 10 · D-FB-3】TimeSpanDurationFields 雙向互推純函式", () => {
  test("改開始毫秒平移結束毫秒並保留時長；頂到上限時夾住", () => {
    const lo = atMin(0);
    const hiEnd = atMin(1440);
    const moved = applySpanStartMs(
      { startMs: atMin(300), endMs: atMin(390) }, // 09:00–10:30 (90m)
      atMin(600), // 改為 14:00
      { lo, hiEnd },
    );
    assert.equal(moved.startMs, atMin(600));
    assert.equal(moved.endMs, atMin(690));
    assert.equal(spanDurationMin(moved.startMs, moved.endMs), 90);

    const clamped = applySpanStartMs(
      { startMs: atMin(300), endMs: atMin(420) }, // 120m
      atMin(1380), // 剩 60m 到日終點
      { lo, hiEnd },
    );
    assert.equal(clamped.startMs, atMin(1380));
    assert.equal(clamped.endMs, hiEnd);
  });

  test("改結束毫秒更新時長，合理 12h 內跨夜自動進位一天", () => {
    const lo = atMin(0);
    const hiEnd = atMin(1800);
    const prev = { startMs: atMin(1140), endMs: atMin(1200) }; // 23:00–24:00
    // 輸入當天 01:00（比開始早，但 +1440 後落在 12h 跨夜內且 <= hiEnd）
    const wrapped = applySpanEndMs(prev, atMin(1140 - 22 * 60), { lo, hiEnd });
    assert.equal(spanDurationMin(wrapped.startMs, wrapped.endMs), 120);
  });

  test("改持續時長：一般模式正推結束；過去補記（shiftStartIfCapped）遇到 now 上限時回推開始湊足時長", () => {
    const lo = atMin(0);
    const nowHi = atMin(840); // 18:00
    // 14:00–14:30 改 90m ⇒ 正推為 14:00–15:30
    const forward = applySpanDurationMin(
      { startMs: atMin(600), endMs: atMin(630) },
      90,
      { lo, hiEnd: nowHi, shiftStartIfCapped: true },
    );
    assert.equal(forward.startMs, atMin(600));
    assert.equal(forward.endMs, atMin(690));

    // 17:30–18:00（貼在 now）改 60m ⇒ 回推為 17:00–18:00（完整 1 小時！）
    const shifted = applySpanDurationMin(
      { startMs: atMin(810), endMs: nowHi },
      60,
      { lo, hiEnd: nowHi, shiftStartIfCapped: true },
    );
    assert.equal(shifted.startMs, atMin(780));
    assert.equal(shifted.endMs, nowHi);
    assert.equal(spanDurationMin(shifted.startMs, shifted.endMs), 60);
  });

  test("運行中／発車預估：預計到着毫秒 ⇄ 預估分鐘雙向換算", () => {
    const dep = atMin(600); // 14:00
    const arr = arrivalMsFromEst(dep, 95);
    assert.equal(arr, atMin(695));
    assert.equal(estMinFromArrivalMs(dep, arr), 95);
    // 跨午夜到着亦能正確反推
    assert.equal(estMinFromArrivalMs(atMin(1140), atMin(1140 - 23 * 60)), 60);
  });
});

describe("【操作 9 · D-FB-4】notesStore 收件匣多選批量整理與復原", () => {
  test("batchScheduleInbox / batchAttachInboxToTarget / batchAttachInboxTag / batchDeleteInbox 完整執行與撤回", async () => {
    const nodeRepo = new MemoryNodeRepository();
    const line = await nodeRepo.create({ kind: "line", name: "本線", parentId: null });
    const route = await nodeRepo.create({ kind: "route", name: "日語線", parentId: line.id });
    const tk1 = await nodeRepo.create({ kind: "ticket", name: "買單字書", parentId: null });
    const tk2 = await nodeRepo.create({ kind: "ticket", name: "訂機票", parentId: null });
    (globalThis as Record<string, unknown>).__w2NodeRepo = nodeRepo;

    interface MockNote {
      id: string;
      kind: "note";
      title: string | null;
      body: string;
      node_id: string | null;
      route_id: string | null;
      node_name: null;
      node_kind: null;
      node_missing: boolean;
      inbox: 0 | 1;
      entry_date: null;
      noted_at: string;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    }
    const notes = new Map<string, MockNote>([
      [
        "n1",
        {
          id: "n1",
          kind: "note",
          title: null,
          body: "靈感草稿",
          node_id: null,
          route_id: null,
          node_name: null,
          node_kind: null,
          node_missing: false,
          inbox: 1,
          entry_date: null,
          noted_at: "2026-11-20T05:00:00Z",
          created_at: "2026-11-20T05:00:00Z",
          updated_at: "2026-11-20T05:00:00Z",
          deleted_at: null,
        },
      ],
    ]);

    const nodeTags = new Map<string, Set<string>>();
    (globalThis as Record<string, unknown>).__w2NoteRepo = {
      listInbox: async () => [...notes.values()].filter((n) => n.inbox === 1 && n.deleted_at === null),
      listInboxTickets: () => nodeRepo.listInboxTickets(),
      listNotes: async () => [...notes.values()].filter((n) => n.inbox === 0 && n.deleted_at === null),
      countNotes: async () => [...notes.values()].filter((n) => n.inbox === 0 && n.deleted_at === null).length,
      getNote: async (id: string) => notes.get(id) ?? null,
      update: async (id: string, patch: Partial<MockNote>) => {
        const cur = notes.get(id);
        if (cur) Object.assign(cur, patch);
      },
      softDelete: async (id: string) => {
        const cur = notes.get(id);
        if (cur) cur.deleted_at = "2026-11-20T06:00:00Z";
      },
      restore: async (ids: string[]) => {
        for (const id of ids) {
          const cur = notes.get(id);
          if (cur) cur.deleted_at = null;
        }
      },
    };
    (globalThis as Record<string, unknown>).__w2TagRepo = {
      attach: async (_type: string, id: string, raw: string) => {
        const key = raw.toLowerCase();
        const set = nodeTags.get(id) ?? new Set<string>();
        const already = set.has(key);
        set.add(key);
        nodeTags.set(id, set);
        return { name: raw, key, already, receipt: { op: "attach", id, key } };
      },
      detach: async (_type: string, id: string, key: string) => {
        nodeTags.get(id)?.delete(key);
        return { op: "detach", id, key };
      },
      writeBodyAndSyncTags: async (id: string, _before: string, body: string) => {
        const cur = notes.get(id);
        if (cur) cur.body = body;
        return { added: [], removed: [] };
      },
      undo: async (r: { op: string; id: string; key: string }) => {
        if (r.op === "attach") nodeTags.get(r.id)?.delete(r.key);
        if (r.op === "detach") {
          const set = nodeTags.get(r.id) ?? new Set<string>();
          set.add(r.key);
          nodeTags.set(r.id, set);
        }
      },
    };
    (globalThis as Record<string, unknown>).__w2TagStoreState = {
      index: { byKey: {}, ents: [] },
      loadIndex: async () => {},
      nameOf: (k: string) => k,
    };
    (globalThis as Record<string, unknown>).__w2NodeStoreState = {
      liveRoutes: [route],
      routes: [route],
      refresh: async () => {},
      refreshSerials: async () => {},
      moveToAnchor: async (ids: string[], parentId: string | null) => {
        for (const id of ids) {
          if (parentId === null) {
            await nodeRepo.setRouteTag(id, null);
          } else {
            await nodeRepo.setRouteTag(id, parentId);
          }
        }
        return { ok: true };
      },
    };

    await useNotesStore.getState().loadInbox();

    // 1) 混合選取排乘車日：車票排到指定日、筆記留在收件匣，復原後車票回到收件匣
    await useNotesStore.getState().batchScheduleInbox(
      [
        { kind: "ticket", id: tk1.id },
        { kind: "note", id: "n1" },
      ],
      "2026-11-22",
    );
    assert.equal((await nodeRepo.getNode(tk1.id))?.scheduled_on, "2026-11-22");
    assert.equal(notes.get("n1")?.inbox, 1);
    const toast1 = (globalThis as Record<string, unknown>).__w2LastToast as { sub?: string; onAction?: () => void };
    assert.match(toast1.sub ?? "", /1 則筆記/);
    toast1.onAction?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await nodeRepo.getNode(tk1.id))?.scheduled_on, null);

    // 2) 混合選取掛路線：車票掛上路線、筆記移出收件匣並掛 node_id，復原後雙雙回原位
    await useNotesStore.getState().batchAttachInboxToTarget(
      [
        { kind: "ticket", id: tk1.id },
        { kind: "note", id: "n1" },
      ],
      { routeId: route.id, nodeId: null, nodeKind: "route" },
    );
    assert.equal((await nodeRepo.getNode(tk1.id))?.route_id, route.id);
    assert.equal(notes.get("n1")?.inbox, 0);
    assert.equal(notes.get("n1")?.node_id, route.id);
    const toast2 = (globalThis as Record<string, unknown>).__w2LastToast as { onAction?: () => void };
    toast2.onAction?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await nodeRepo.getNode(tk1.id))?.route_id, null);
    assert.equal(notes.get("n1")?.inbox, 1);
    assert.equal(notes.get("n1")?.node_id, null);

    // 3) 混合選取掛 #荷札：車票寫 taggings、筆記同步寫入內文 #旅行，復原後一併退回
    await useNotesStore.getState().batchAttachInboxTag(
      [
        { kind: "ticket", id: tk2.id },
        { kind: "note", id: "n1" },
      ],
      "旅行",
    );
    assert.equal(nodeTags.get(tk2.id)?.has("旅行"), true);
    assert.match(notes.get("n1")?.body ?? "", /#旅行/);
    const toast3 = (globalThis as Record<string, unknown>).__w2LastToast as { onAction?: () => void };
    toast3.onAction?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(nodeTags.get(tk2.id)?.has("旅行"), false);
    assert.equal(notes.get("n1")?.body, "靈感草稿");

    // 4) 混合選取刪除與復原
    await useNotesStore.getState().batchDeleteInbox([
      { kind: "ticket", id: tk2.id },
      { kind: "note", id: "n1" },
    ]);
    assert.notEqual((await nodeRepo.getNode(tk2.id))?.deleted_at, null);
    assert.notEqual(notes.get("n1")?.deleted_at, null);
    const toast4 = (globalThis as Record<string, unknown>).__w2LastToast as { onAction?: () => void };
    toast4.onAction?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await nodeRepo.getNode(tk2.id))?.deleted_at, null);
    assert.equal(notes.get("n1")?.deleted_at, null);
  });
});

describe("【操作 9 · D-FB-4】waitroomActs 候車室多選批量整理與復原", () => {
  test("batchSetWishKind / batchAttachWishTag / batchDetachWishTag / batchDeleteWishes 完整執行與撤回", async () => {
    const wishes = new Map<string, { id: string; name: string; kind_id: string; deleted_at: string | null }>([
      ["w1", { id: "w1", name: "買相機", kind_id: "k-buy", deleted_at: null }],
      ["w2", { id: "w2", name: "去京都", kind_id: "k-go", deleted_at: null }],
    ]);
    const wishTags = new Map<string, Set<string>>();

    (globalThis as Record<string, unknown>).__w2TicketRepo = {
      updateWish: async (id: string, patch: { kindId?: string }) => {
        const w = wishes.get(id);
        if (w && patch.kindId) w.kind_id = patch.kindId;
      },
      softDeleteWish: async (id: string) => {
        const w = wishes.get(id);
        if (w) w.deleted_at = "2026-11-20T06:00:00Z";
      },
      restoreWish: async (id: string) => {
        const w = wishes.get(id);
        if (w) w.deleted_at = null;
      },
    };
    (globalThis as Record<string, unknown>).__w2TicketStoreState = {
      wishKinds: [
        { id: "k-buy", name: "想買", action: "entry", position: 0 },
        { id: "k-go", name: "想去", action: "route", position: 1 },
      ],
      get wish() {
        return {
          want: [...wishes.values()].filter((w) => w.deleted_at === null),
          bought: [],
          wantTotal: 0,
          unpriced: 0,
          spent: 0,
          wantByKind: {},
        };
      },
      refresh: async () => {},
    };
    (globalThis as Record<string, unknown>).__w2TagRepo = {
      attach: async (_type: string, id: string, raw: string) => {
        const key = raw.toLowerCase();
        const set = wishTags.get(id) ?? new Set<string>();
        const already = set.has(key);
        set.add(key);
        wishTags.set(id, set);
        return { name: raw, key, already, receipt: { op: "attach", id, key } };
      },
      detach: async (_type: string, id: string, key: string) => {
        wishTags.get(id)?.delete(key);
        return { op: "detach", id, key };
      },
      undo: async (r: { op: string; id: string; key: string }) => {
        if (r.op === "attach") wishTags.get(r.id)?.delete(r.key);
        if (r.op === "detach") {
          const set = wishTags.get(r.id) ?? new Set<string>();
          set.add(r.key);
          wishTags.set(r.id, set);
        }
      },
    };
    (globalThis as Record<string, unknown>).__w2TagStoreState = {
      index: { byKey: {}, ents: [] },
      loadIndex: async () => {},
      nameOf: (k: string) => k,
    };

    // 1) 批量換番線（w2 已在 k-go 跳過，只改 w1；復原後 w1 回 k-buy）
    await batchSetWishKind(["w1", "w2"], "k-go");
    assert.equal(wishes.get("w1")?.kind_id, "k-go");
    assert.equal(wishes.get("w2")?.kind_id, "k-go");
    const t1 = (globalThis as Record<string, unknown>).__w2LastToast as { onAction?: () => void };
    t1.onAction?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(wishes.get("w1")?.kind_id, "k-buy");

    // 2) 批量掛荷札與摘荷札
    await batchAttachWishTag(["w1", "w2"], "京都");
    assert.equal(wishTags.get("w1")?.has("京都"), true);
    assert.equal(wishTags.get("w2")?.has("京都"), true);
    await batchDetachWishTag(["w1"], "京都");
    assert.equal(wishTags.get("w1")?.has("京都"), false);
    const tDetach = (globalThis as Record<string, unknown>).__w2LastToast as { onAction?: () => void };
    tDetach.onAction?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(wishTags.get("w1")?.has("京都"), true);

    // 3) 批量刪除與復原
    await batchDeleteWishes(["w1", "w2"]);
    assert.notEqual(wishes.get("w1")?.deleted_at, null);
    assert.notEqual(wishes.get("w2")?.deleted_at, null);
    const tDel = (globalThis as Record<string, unknown>).__w2LastToast as { onAction?: () => void };
    tDel.onAction?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(wishes.get("w1")?.deleted_at, null);
    assert.equal(wishes.get("w2")?.deleted_at, null);
  });
});
