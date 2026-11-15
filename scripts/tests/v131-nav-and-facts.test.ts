/**
 * 第一梯（v1.31）eng-core 補充回歸測試：
 *   1. Bug 2：reminderFacts.ts 與 reportFacts.ts 全面排除 paused（途中下車）
 *   2. Bug 5b：navHistoryStore.ts 的 runAtomicNav 跨頁多步跳轉原子化（支援巢狀、不記錄中間態、例外時正常復原、goBack 直退原頁）
 *
 * 跑法：`node --test scripts/tests/v131-nav-and-facts.test.ts`
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const FAKE_DB = `
export function getDb() { throw new Error("測試不碰 SQLite"); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { return new Date().toISOString(); }
`;
const FAKE_SYNC = `
export const SYNC_WRITE_EVENT = "ns:sync-write";
export const SYNC_SETTINGS_KEYS = new Set();
export const MOCK_FIRST_TICKET = "2026-01-01";
export function resetSyncTablesProbe() {}
export function newWriteBatch() { return { stmts: [], ops: [] }; }
export async function runWriteBatch() {}
export async function occurrenceId(n, d) { return n + "|" + d; }
export async function ensureSyncTables() { return false; }
`;
const FAKE_CORE = `export async function invoke() { return null; }`;
const FAKE_WINDOW_THEME = `export function syncWindowTheme() {}`;
const FAKE_CAPTURE_SHELL = `export function isCaptureWindow() { return false; }`;
const FAKE_REPOS_INDEX = `
export const nodeRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__mockRepos?.nodeRepo;
    if (mock && prop in mock) return mock[prop];
    return async () => [];
  }
});
export const settingsRepo = { get: async () => null, set: async () => {} };
export const logRepo = {};
export const syncRepo = {};
export const backupRepo = {};
export const parseKeep = () => 10;
export const BACKUP_SETTING_KEYS = {};
export const reorderIds = (ids) => ids;
export const SYNC_WRITE_EVENT = "ns:sync-write";
export const BACKUP_KEEP_DEFAULT = 10;
export const DEV_FLAGS = { mock: false };
export const MOCK_MODE = false;
export const WIPED_MODE = false;
export const USE_SQLITE = false;
`;
const FAKE_BACKUP_REPO = `
export const backupRepo = {};
export class MemoryBackupRepository {}
export class TauriBackupRepository {}
`;
const FAKE_TAG_REPO = `export const tagRepo = { listAll: async () => [], listByTarget: async () => [] };`;
const FAKE_DEPOT_REPO = `export const depotRepo = { list: async () => ({ books: [], items: [] }) };`;
const FAKE_DELETE_FLOW = `export async function confirmAndDeleteNode() {}`;
const FAKE_SYNC_STORE = `export const useSyncStore = { getState: () => ({ markLocalWrite() {} }) };`;
const FAKE_TT_REPO = `
export const timetableRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__mockRepos?.timetableRepo;
    if (mock && prop in mock) return mock[prop];
    return async () => [];
  }
});
`;
const FAKE_TK_REPO = `
export const ticketRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__mockRepos?.ticketRepo;
    if (mock && prop in mock) return mock[prop];
    return async () => [];
  }
});
`;
const FAKE_WA_REPO = `
export const weekAimRepo = { listRange: async () => [], listRangeByKeys: async () => [] };
`;
const FAKE_SEAL_REPO = `
export const sealRepo = { listSeals: async () => [] };
`;
const FAKE_NOTE_REPO = `
export const noteRepo = { listDiary: async () => [], listNotes: async () => [], listDiaryMarks: async () => ({}) };
`;
const FAKE_REPORT_Q = `
export const reportQueries = { dueCountByDay: async () => ({}), noteTimes: async () => [] };
`;

const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./syncRepository" || specifier === "../data/syncRepository") {
        return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      }
      if (specifier.startsWith("@tauri-apps/")) return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (specifier === "../lib/windowTheme") return { url: dataUrl(FAKE_WINDOW_THEME), shortCircuit: true };
      if (specifier === "../ui/notes/capture-window/shell") return { url: dataUrl(FAKE_CAPTURE_SHELL), shortCircuit: true };
      if (specifier === "./index" && context.parentURL.includes("/src/data/")) {
        return { url: dataUrl(FAKE_REPOS_INDEX), shortCircuit: true };
      }
      if (specifier === "../data" || specifier === "../data/index" || specifier === "../../data" || specifier === "../../data/index") {
        return { url: dataUrl(FAKE_REPOS_INDEX), shortCircuit: true };
      }
      if (specifier === "./timetableRepository" || specifier === "../data/timetableRepository") {
        return { url: dataUrl(FAKE_TT_REPO), shortCircuit: true };
      }
      if (specifier === "./ticketRepository" || specifier === "../data/ticketRepository") {
        return { url: dataUrl(FAKE_TK_REPO), shortCircuit: true };
      }
      if (specifier === "./weekAimRepository" || specifier === "../data/weekAimRepository") {
        return { url: dataUrl(FAKE_WA_REPO), shortCircuit: true };
      }
      if (specifier === "./sealRepo") return { url: dataUrl(FAKE_SEAL_REPO), shortCircuit: true };
      if (specifier === "./noteRepo" || specifier === "../data/noteRepo") {
        return { url: dataUrl(FAKE_NOTE_REPO), shortCircuit: true };
      }
      if (specifier === "./reportQueries") return { url: dataUrl(FAKE_REPORT_Q), shortCircuit: true };
      if (specifier === "./backupRepository" || specifier === "../data/backupRepository") {
        return { url: dataUrl(FAKE_BACKUP_REPO), shortCircuit: true };
      }
      if (specifier === "../data/tagRepo") return { url: dataUrl(FAKE_TAG_REPO), shortCircuit: true };
      if (specifier === "../data/depotRepo") return { url: dataUrl(FAKE_DEPOT_REPO), shortCircuit: true };
      if (specifier === "../data/idealRepository") return { url: dataUrl(`export const idealRepo = {};`), shortCircuit: true };
      if (specifier === "../ui/common/deleteNodeFlow") return { url: dataUrl(FAKE_DELETE_FLOW), shortCircuit: true };
      if (specifier === "./syncStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_SYNC_STORE), shortCircuit: true };
      }

      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          return nextResolve(specifier + "/index.ts", context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const res = nextLoad(url, context);
    if (url.includes("/src/store/") && typeof res.source === "string" && res.source.includes("import.meta.env")) {
      return { ...res, source: res.source.replaceAll("import.meta.env.DEV", "false") };
    }
    if (url.includes("/src/store/") && res.source instanceof Uint8Array) {
      const txt = Buffer.from(res.source).toString("utf8");
      if (txt.includes("import.meta.env")) {
        return { ...res, source: txt.replaceAll("import.meta.env.DEV", "false") };
      }
    }
    return res;
  },
});

const { DEFAULT_REMINDER_SETTINGS } = await import("../../src/domain/reminders.ts");
const { loadReminderFacts } = await import("../../src/data/reminderFacts.ts");
const { loadReportFacts } = await import("../../src/data/reportFacts.ts");
const { useUiStore } = await import("../../src/store/uiStore.ts");
const { useTimetableStore } = await import("../../src/store/timetableStore.ts");
const { useTicketStore } = await import("../../src/store/ticketStore.ts");
const { useNavHistoryStore, runAtomicNav } = await import("../../src/store/navHistoryStore.ts");

function makeNode(over: Partial<import("../../src/domain/node.ts").NodeRow> & { id: string }): import("../../src/domain/node.ts").NodeRow {
  return {
    parent_id: "R1",
    line_id: "L1",
    route_id: "R1",
    kind: "ticket",
    name: over.id,
    note: null,
    code: null,
    color: null,
    status: "todo",
    position: 0,
    sort_key: null,
    scheduled_on: null,
    scheduled_time: null,
    due_on: null,
    estimate_min: null,
    repeat_rule: null,
    repeat_paused: 0,
    done_at: null,
    arrived_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  };
}

describe("Bug 2 · reminderFacts 與 reportFacts 排除 paused", () => {
  test("loadReminderFacts：paused 不會進入 dues、timed（含多時段排程）、lates", async () => {
    const today = "2026-11-10";
    const pausedNode = makeNode({
      id: "P_REM",
      name: "途中下車票",
      status: "paused",
      due_on: today,
      scheduled_on: "2026-11-08",
      scheduled_time: "14:00",
    });
    const activeNode = makeNode({
      id: "A_REM",
      name: "進行中票",
      status: "todo",
      due_on: today,
      scheduled_on: today,
      scheduled_time: "15:00",
    });
    const lateActiveNode = makeNode({
      id: "L_REM",
      name: "真誤點票",
      status: "todo",
      scheduled_on: "2026-11-09",
    });

    (globalThis as Record<string, unknown>).__mockRepos = {
      nodeRepo: {
        listCalendar: async () => ({
          entries: [
            { date: today, node_id: "P_REM", time: "14:00", kind: "single", occurrence_status: null, is_late: false, is_done: false, is_assumed: false },
            { date: today, node_id: "A_REM", time: "15:00", kind: "single", occurrence_status: null, is_late: false, is_done: false, is_assumed: false },
          ],
          dues: [
            { date: today, node_id: "P_REM" },
            { date: today, node_id: "A_REM" },
          ],
          nodes: { P_REM: pausedNode, A_REM: activeNode },
        }),
        getNode: async (id: string) => ({ P_REM: pausedNode, A_REM: activeNode }[id] ?? null),
        listToday: async () => [
          { ...pausedNode, bucket: "late", child_total: 0, child_done: 0, carried_from: null, serial: null, occurrence: null },
          { ...lateActiveNode, bucket: "late", child_total: 0, child_done: 0, carried_from: null, serial: null, occurrence: null },
        ],
        listSidebar: async () => ({ lines: [], routes: [], stations: [] }),
        listTasks: async () => [pausedNode, activeNode],
      },
      timetableRepo: {
        listPlans: async () => [
          { id: "PL_P", node_id: "P_REM", day: today, start_hm: "16:00", deleted_at: null },
          { id: "PL_A", node_id: "A_REM", day: today, start_hm: "17:00", deleted_at: null },
        ],
        listRoutines: async () => [],
      },
      ticketRepo: {
        listRepeats: async () => [],
      },
    };

    const now = new Date(2026, 10, 10, 10, 0).getTime();
    const facts = await loadReminderFacts({
      now,
      dayStartHour: 6,
      weekStart: 1,
      settings: { ...DEFAULT_REMINDER_SETTINGS, review: false, routine: false, repeat: false },
      open: { timetable: true, ticket: false },
    });

    assert.deepEqual(facts.dues.map((d) => d.nodeId), ["A_REM"], "paused 不得進入締切提醒");
    assert.deepEqual(facts.timed.map((t) => `${t.nodeId}@${t.time}`), ["A_REM@15:00", "A_REM@17:00"], "paused 不得進入定時與多時段提醒");
    assert.deepEqual(facts.lates.map((l) => l.nodeId), ["L_REM"], "paused 不得進入誤點提醒");
  });

  test("loadReportFacts：lateDays 與 dueSoon 排除 paused", async () => {
    const today = "2026-11-10";
    const pausedNode = makeNode({ id: "P_REP", status: "paused", due_on: "2026-11-11", scheduled_on: "2026-11-08" });
    const activeNode = makeNode({ id: "A_REP", status: "todo", due_on: "2026-11-11", scheduled_on: "2026-11-09" });

    (globalThis as Record<string, unknown>).__mockRepos = {
      nodeRepo: {
        listToday: async () => [
          { ...pausedNode, bucket: "late", child_total: 0, child_done: 0, carried_from: null, serial: null, occurrence: null },
          { ...activeNode, bucket: "late", child_total: 0, child_done: 0, carried_from: null, serial: null, occurrence: null },
        ],
        listCalendar: async () => ({
          entries: [],
          dues: [
            { date: "2026-11-11", node_id: "P_REP" },
            { date: "2026-11-11", node_id: "A_REP" },
          ],
          nodes: { P_REP: pausedNode, A_REP: activeNode },
        }),
      },
    };

    const facts = await loadReportFacts({
      today,
      dayStartHour: 6,
      weekStart: 1,
      days: 7,
      now: new Date(2026, 10, 10, 12, 0).getTime(),
      open: { timetable: false, ticket: false, notes: false },
      routes: [],
      timeThreshold: () => () => null,
      dayNotes: null,
    });

    assert.deepEqual(facts.late.map((l) => l.day), ["2026-11-09"], "運行報告誤點清單須排除 paused");
    assert.deepEqual(facts.dueSoon.map((s) => s.nodeId), ["A_REP"], "運行報告近期締切清單須排除 paused");
  });
});

describe("Bug 5b · navHistoryStore.runAtomicNav 原子跨頁跳轉", () => {
  const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

  test("多步非同步跨頁跳轉只推入一筆最終快照，goBack 直接回到原頁", async () => {
    useUiStore.getState().setPage("report");
    useTimetableStore.setState({ view: "week", sheet: null });
    useNavHistoryStore.getState().reset();
    assert.equal(useNavHistoryStore.getState().entries.length, 1);

    await runAtomicNav(async () => {
      useUiStore.getState().setPage("timetable");
      // 模擬呼叫 gotoTimetable 等非同步等待（期間 microtask 會轉動）
      await Promise.resolve();
      await flushMicrotasks();
      useTimetableStore.getState().setView("stats");
    });

    const st = useNavHistoryStore.getState();
    assert.equal(st.entries.length, 2, "不應推入 timetable:week 中間態快照，僅保留原頁與最終頁共 2 筆");
    assert.equal(st.index, 1);
    assert.equal(st.entries[0].page, "report");
    assert.equal(st.entries[1].page, "timetable");
    assert.equal(st.entries[1].timetableView, "stats");

    const moved = st.goBack();
    assert.equal(moved, true);
    assert.equal(useUiStore.getState().page, "report", "按上一頁應直接退回 report，而不是時刻表舊分頁");
  });

  test("巢狀 runAtomicNav：等最外層結束才一次性寫入最終快照", async () => {
    useUiStore.getState().setPage("today");
    useTicketStore.setState({ view: "ledger" });
    useNavHistoryStore.getState().reset();

    await runAtomicNav(async () => {
      useUiStore.getState().setPage("ticket");
      await runAtomicNav(async () => {
        await flushMicrotasks();
        useTicketStore.getState().setView("stats");
      });
      // 內層結束時外層還沒完，此時歷史仍應只有 1 筆
      assert.equal(useNavHistoryStore.getState().entries.length, 1);
      useTicketStore.getState().setSpan("month");
    });

    const st = useNavHistoryStore.getState();
    assert.equal(st.entries.length, 2);
    assert.equal(st.entries[1].page, "ticket");
    assert.equal(st.entries[1].ticketView, "stats");
    assert.equal(st.entries[1].ticketStatsSpan, "month");
  });

  test("fn 拋錯時 finally 正確歸零深度，不影響後續正常導航記錄", async () => {
    useUiStore.getState().setPage("today");
    useNavHistoryStore.getState().reset();

    await assert.rejects(
      runAtomicNav(async () => {
        useUiStore.getState().setPage("calendar");
        await Promise.resolve();
        throw new Error("boom");
      }),
      /boom/,
    );

    // 之後一般切頁應恢復正常紀錄
    useUiStore.getState().setPage("report");
    await flushMicrotasks();
    const st = useNavHistoryStore.getState();
    assert.equal(st.entries.at(-1)?.page, "report");
    assert.ok(st.entries.length >= 2);
  });
});
