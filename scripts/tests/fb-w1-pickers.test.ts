/**
 * 第一梯回饋專卷（fe-pickers-board）純函式與篩選／預覽建票單元測試：
 *   1. 【討論 5】groupRoutesByLine：依幹線順序分組、略過空幹線、無幹線或孤立 line_id 歸入「其他」
 *   2. 【操作 7】flattenAttachTree：納入樹內車票與掛路線標籤的根層車票，搭配 excludeSubtrees／pruneToSelectable 過濾多棵子樹與不可選葉車票
 *   3. 【Bug 2】boardStore 篩選排序：預設為 `"outline"`（路線順序），切換時間／優先排序時保留對應鍵值
 *   4. 【操作 7 連動】notesStore.confirmPreview：變待辦預覽支援掛載至支線與車票（自動升格目標車票、復原時退回車票）
 *
 * 跑法：`node --test scripts/tests/fb-w1-pickers.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { NodeRow } from "../../src/domain/node.ts";
import { excludeSubtrees, pruneToSelectable } from "../../src/domain/moveTo.ts";

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
    const mock = globalThis.__mockNodeRepo;
    if (!mock) throw new Error("測試沒設 __mockNodeRepo");
    const v = mock[prop];
    return typeof v === "function" ? v.bind(mock) : v;
  }
});
export const settingsRepo = { get: async () => null, set: async () => {} };
`;
const FAKE_NOTE_REPO = `
export const noteRepo = {
  softDelete: async () => {},
  restore: async () => {},
  listInbox: async () => [],
  listInboxNotes: async () => [],
  listInboxTickets: async () => [],
  listNotes: async () => ({ rows: [], hasMore: false }),
  countNotes: async () => 0,
  listNoteTags: async () => ({}),
};
`;
const FAKE_TAG_REPO = `export const tagRepo = {};`;
const FAKE_DELETE_FLOW = `export async function confirmAndDeleteNode() {}`;
const FAKE_FOOTPRINT_BLOCKS = `export const dayBlocksProvider = { get: async () => [] };`;
const FAKE_LINES_RUNTIME = `export function lineCaptureTargets() { return []; }`;
const FAKE_NODE_STORE = `
const fn = () => [];
fn.getState = () => ({
  routes: globalThis.__mockRoutes ?? [],
  liveRoutes: globalThis.__mockRoutes ?? [],
  refresh: async () => {},
  reschedule: async () => {},
});
export const useNodeStore = fn;
`;
const FAKE_TAG_STORE = `export const useTagStore = { getState: () => ({ loadIndex: async () => {} }) };`;
const FAKE_SELECTION_STORE = `export const useSelectionStore = { getState: () => ({ clear() {} }) };`;
const FAKE_UI_STORE = `
const state = {
  dayStartHour: 4,
  lastToast: null,
  showToast(t) { state.lastToast = t; globalThis.__lastToast = t; },
};
export const useUiStore = { getState: () => state };
`;

const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") {
        return { url: dataUrl(FAKE_DB), shortCircuit: true };
      }
      if (specifier === "./syncRepository") {
        return { url: dataUrl(FAKE_SYNC), shortCircuit: true };
      }
      if (specifier === "../../data" || specifier === "../data") {
        return { url: dataUrl(FAKE_DATA_INDEX), shortCircuit: true };
      }
      if (specifier === "../data/noteRepo") {
        return { url: dataUrl(FAKE_NOTE_REPO), shortCircuit: true };
      }
      if (specifier === "../data/tagRepo") {
        return { url: dataUrl(FAKE_TAG_REPO), shortCircuit: true };
      }
      if (specifier === "../ui/common/deleteNodeFlow") {
        return { url: dataUrl(FAKE_DELETE_FLOW), shortCircuit: true };
      }
      if (specifier === "../ui/notes/footprintBlocks") {
        return { url: dataUrl(FAKE_FOOTPRINT_BLOCKS), shortCircuit: true };
      }
      if (specifier === "../lines/runtime") {
        return { url: dataUrl(FAKE_LINES_RUNTIME), shortCircuit: true };
      }
      if (specifier === "../../store/nodeStore" || specifier === "./nodeStore") {
        return { url: dataUrl(FAKE_NODE_STORE), shortCircuit: true };
      }
      if (specifier === "./tagStore") {
        return { url: dataUrl(FAKE_TAG_STORE), shortCircuit: true };
      }
      if (specifier === "./selectionStore") {
        return { url: dataUrl(FAKE_SELECTION_STORE), shortCircuit: true };
      }
      if (specifier === "./uiStore") {
        return { url: dataUrl(FAKE_UI_STORE), shortCircuit: true };
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
});

const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { flattenAttachTree, groupRoutesByLine } = await import("../../src/ui/notes/useAttachOptions.ts");
const { FILTER_SORT_LABEL, FILTER_SORT_ORDER, parseFilterSort, useBoardStore } = await import(
  "../../src/store/boardStore.ts"
);
const { useNotesStore } = await import("../../src/store/notesStore.ts");

function makeNode(id: string, patch: Partial<NodeRow> = {}): NodeRow {
  return {
    id,
    kind: "ticket",
    parent_id: null,
    line_id: null,
    route_id: null,
    name: id,
    description: null,
    position: 0,
    sort_key: null,
    station_id: null,
    color: null,
    code: null,
    status: "todo",
    scheduled_on: null,
    due_on: null,
    priority: "mid",
    estimate_min: null,
    progress: null,
    time_spent_min: null,
    mood: null,
    repeat_rule: null,
    completed_at: null,
    expected_on: null,
    arrived_on: null,
    today_position: null,
    carried_from: null,
    scheduled_time: null,
    time_overrides: null,
    created_at: "2026-11-20T00:00:00.000Z",
    updated_at: "2026-11-20T00:00:00.000Z",
    deleted_at: null,
    hlc: "0",
    ...patch,
  };
}

describe("1. groupRoutesByLine：全站路線依幹線分組", () => {
  test("依 lines 順序輸出「幹線・名稱」、略過無路線的空幹線、無幹線與孤立幹線歸入「其他」", () => {
    const lines = [
      makeNode("L1", { kind: "line", name: "學業" }),
      makeNode("L_EMPTY", { kind: "line", name: "空幹線" }),
      makeNode("L2", { kind: "line", name: "生活" }),
    ];
    const routes = [
      makeNode("R_OTHER_1", { kind: "route", name: "雜項", line_id: null }),
      makeNode("R_L2", { kind: "route", name: "家務", line_id: "L2" }),
      makeNode("R_L1_A", { kind: "route", name: "日文", line_id: "L1" }),
      makeNode("R_ORPHAN", { kind: "route", name: "舊專案", line_id: "L_DELETED" }),
      makeNode("R_L1_B", { kind: "route", name: "線代", line_id: "L1" }),
    ];

    const groups = groupRoutesByLine(routes, lines);
    assert.deepEqual(
      groups.map((g) => ({ lineId: g.lineId, header: g.header, ids: g.routes.map((r) => r.id) })),
      [
        { lineId: "L1", header: "幹線・學業", ids: ["R_L1_A", "R_L1_B"] },
        { lineId: "L2", header: "幹線・生活", ids: ["R_L2"] },
        { lineId: null, header: "其他", ids: ["R_OTHER_1", "R_ORPHAN"] },
      ],
    );
  });

  test("空路線清單回傳空陣列", () => {
    assert.deepEqual(groupRoutesByLine([], [makeNode("L1", { kind: "line", name: "學業" })]), []);
  });
});

describe("2. flattenAttachTree：納入樹內車票、根層路線車票與多選排除", () => {
  const rows: NodeRow[] = [
    makeNode("B1", { kind: "branch", parent_id: "R1", route_id: "R1", name: "文法", position: 0 }),
    makeNode("T1", { kind: "train", parent_id: "B1", route_id: "R1", name: "第1課", position: 0 }),
    makeNode("K_TREE", { kind: "ticket", parent_id: "T1", route_id: "R1", name: "背例句", position: 0 }),
    makeNode("K_ROOT_TAGGED", { kind: "ticket", parent_id: null, route_id: "R1", name: "買參考書", position: 1 }),
    makeNode("K_OTHER_ROUTE", { kind: "ticket", parent_id: null, route_id: "R2", name: "別線臨時票", position: 2 }),
    makeNode("ST1", { kind: "station", parent_id: "R1", route_id: "R1", name: "N4 檢定", position: 3 }),
    makeNode("K_DELETED", {
      kind: "ticket",
      parent_id: "T1",
      route_id: "R1",
      name: "已刪除",
      deleted_at: "2026-11-20T01:00:00.000Z",
    }),
  ];

  test("預設全種類可選：包含支線／列車／樹內車票與掛該路線標籤的根層車票，排除車站與已刪列", () => {
    const flat = flattenAttachTree("R1", rows);
    assert.deepEqual(
      flat.map((o) => ({ id: o.id, kind: o.kind, depth: o.depth, selectable: o.selectable })),
      [
        { id: "B1", kind: "branch", depth: 0, selectable: true },
        { id: "T1", kind: "train", depth: 1, selectable: true },
        { id: "K_TREE", kind: "ticket", depth: 2, selectable: true },
        { id: "K_ROOT_TAGGED", kind: "ticket", depth: 0, selectable: true },
      ],
    );
  });

  test("指定 kinds=['train','car'] 搭配 pruneToSelectable：保留支線群組頭、剪除不可選葉車票", () => {
    const flat = flattenAttachTree("R1", rows, ["train", "car"]);
    const pruned = pruneToSelectable(flat);
    assert.deepEqual(
      pruned.map((o) => ({ id: o.id, selectable: o.selectable })),
      [
        { id: "B1", selectable: false },
        { id: "T1", selectable: true },
      ],
    );
  });

  test("搭配 excludeSubtrees 一次排除多棵選取子樹", () => {
    const flat = flattenAttachTree("R1", rows);
    const afterExclude = excludeSubtrees(flat, new Set(["T1", "K_ROOT_TAGGED"]));
    assert.deepEqual(afterExclude.map((o) => o.id), ["B1"]);
  });
});

describe("3. boardStore 篩選排序預設與解析", () => {
  test("預設為 outline（路線順序），支援切換至締切／乘車日／優先／最近更新", () => {
    assert.equal(useBoardStore.getState().sort, "outline");
    assert.deepEqual([...FILTER_SORT_ORDER], ["outline", "smart", "scheduled", "priority", "updated"]);
    assert.equal(FILTER_SORT_LABEL.outline, "路線順序");
    assert.equal(FILTER_SORT_LABEL.smart, "締切");
    assert.equal(parseFilterSort(null), "outline");
    assert.equal(parseFilterSort("outline"), "outline");
    assert.equal(parseFilterSort("unknown"), "outline");
    assert.equal(parseFilterSort("smart"), "smart");
    assert.equal(parseFilterSort("scheduled"), "scheduled");
    assert.equal(parseFilterSort("priority"), "priority");
    assert.equal(parseFilterSort("updated"), "updated");
  });
});

describe("4. notesStore.confirmPreview：支援掛載至支線與車票（自動升格＋復原）", () => {
  test("選取支線（branch）與車票（ticket）時皆正確寫入 parentId，且復原時將被升格車票退回 ticket", async () => {
    const repo = new MemoryNodeRepository();
    (globalThis as Record<string, unknown>).__mockNodeRepo = repo;
    const line = await repo.create({ kind: "line", name: "主幹線", parentId: null });
    const route = await repo.create({ kind: "route", name: "日文線", parentId: line.id });
    const branch = await repo.create({ kind: "branch", name: "文法支線", parentId: route.id });
    const targetTicket = await repo.create({ kind: "ticket", name: "原葉車票", parentId: route.id });
    (globalThis as Record<string, unknown>).__mockRoutes = [route];

    // (a) 掛載至支線 branch
    useNotesStore.setState({
      preview: {
        source: "capture",
        noteId: null,
        text: "支線底下的新票",
        lines: [{ text: "支線底下的新票", isHeading: false, checked: true }],
        single: true,
        attach: { routeId: route.id, nodeId: branch.id, nodeKind: "branch" },
        scheduledOn: "2026-11-20",
      },
    });
    await useNotesStore.getState().confirmPreview();
    const branchTree = await repo.listRouteTree(route.id);
    const underBranch = branchTree.find((n) => n.name === "支線底下的新票");
    assert.ok(underBranch, "應建立車票");
    assert.equal(underBranch.parent_id, branch.id, "選取支線時應直接掛在支線底下，不退回根層");
    assert.equal(underBranch.route_id, route.id);

    // (b) 掛載至車票 ticket（目標車票自動升格為 train，復原後退回 ticket）
    useNotesStore.setState({
      preview: {
        source: "capture",
        noteId: null,
        text: "車票底下的子票",
        lines: [{ text: "車票底下的子票", isHeading: false, checked: true }],
        single: true,
        attach: { routeId: route.id, nodeId: targetTicket.id, nodeKind: "ticket" },
        scheduledOn: "2026-11-20",
      },
    });
    await useNotesStore.getState().confirmPreview();
    const promoted = await repo.getNode(targetTicket.id);
    assert.equal(promoted?.kind, "train", "目標車票應自動升格為列車");
    const afterTree = await repo.listRouteTree(route.id);
    const underTicket = afterTree.find((n) => n.name === "車票底下的子票");
    assert.ok(underTicket);
    assert.equal(underTicket.parent_id, targetTicket.id, "選取車票時應掛在該車票底下");

    // 觸發 toast 復原
    const lastToast = (globalThis as Record<string, unknown>).__lastToast as { onAction?: () => Promise<void> } | null;
    assert.ok(lastToast?.onAction, "應提供復原動作");
    await lastToast.onAction!();
    const reverted = await repo.getNode(targetTicket.id);
    assert.equal(reverted?.kind, "ticket", "復原後目標節點應退回車票");
  });
});
