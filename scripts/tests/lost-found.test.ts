/**
 * 失物招領的純函式（契約 `docs/research/2026-11-04-主線-失物招領-契約.md` §2、§3、§3.5）。
 * 跑法：`node --test scripts/tests/lost-found.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 真 SQLite 與記憶體版在 `lost-found-sqlite.test.ts`。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LOST_FOUND_DAYS,
  LOST_KINDS,
  LOST_NO_BACKFILL,
  aimPeriodText,
  groupDeleted,
  lostAlreadyHereToast,
  lostChildLabel,
  lostDaySection,
  lostDaysAgo,
  lostParentConfirm,
  lostRestoredToast,
  lostSubline,
  mergeSnapshotDiff,
  namesFromTables,
  placementFor,
  planNodeRestore,
  planRescue,
  snapshotDiff,
  type CloudSnapshot,
  type LostRow,
} from "../../src/domain/lostFound.ts";
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const ago = (days: number, ms = 0) => new Date(NOW - days * 86_400_000 - ms).toISOString();
const T1 = ago(1);
const T2 = ago(2);

const node = (id: string, kind: string, parent: string | null, deleted: string | null, extra: Partial<LostRow> = {}): LostRow => ({
  id,
  kind,
  parent_id: parent,
  name: id,
  deleted_at: deleted,
  ...extra,
});

describe("groupDeleted：一刀一列", () => {
  test("同一刀的子樹算一列，子項數往下走同一個 deleted_at", () => {
    const rows = [node("r", "route", "l", T1), node("t", "train", "r", T1), node("k", "ticket", "t", T1)];
    const items = groupDeleted({ nodes: rows }, NOW);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "r");
    assert.equal(items[0].kind, "route");
    assert.equal(items[0].childCount, 2);
    assert.deepEqual(items[0].ids, ["r", "t", "k"]);
    assert.equal(items[0].category, "tasks");
  });

  test("先後兩刀：先刪的票自成一列，路線那一刀不含它", () => {
    const rows = [node("k", "ticket", "t", T2), node("t", "train", "r", T1), node("r", "route", "l", T1)];
    const items = groupDeleted({ nodes: rows }, NOW);
    assert.deepEqual(items.map((x) => x.id), ["r", "k"], "新的在上");
    assert.deepEqual(items[0].ids, ["r", "t"]);
    assert.equal(items[0].childCount, 1);
    assert.deepEqual(items[1].ids, ["k"]);
  });

  test("父活子死：子自成一列（活著的父不在 tombstone 裡）", () => {
    const items = groupDeleted({ nodes: [node("k", "ticket", "t", T1)] }, NOW);
    assert.equal(items.length, 1);
    assert.equal(items[0].childCount, 0);
  });

  test("批次刪除：deleted_at 不同各成一列；同一毫秒但沒有父子關係也各算各的", () => {
    const a = groupDeleted({ nodes: [node("a", "ticket", null, ago(1, 1)), node("b", "ticket", null, ago(1, 2))] }, NOW);
    assert.equal(a.length, 2);
    const b = groupDeleted({ nodes: [node("a", "ticket", null, T1), node("b", "ticket", null, T1)] }, NOW);
    assert.equal(b.length, 2);
  });

  test("窗外不列；窗內邊界列", () => {
    const edge = ago(LOST_FOUND_DAYS);
    const out = ago(LOST_FOUND_DAYS, 1);
    const items = groupDeleted({ notes: [{ id: "in", kind: "note", body: "在", deleted_at: edge }, { id: "out", kind: "note", body: "外", deleted_at: out }] }, NOW);
    assert.deepEqual(items.map((x) => x.id), ["in"]);
  });

  test("活著的列不列", () => {
    assert.equal(groupDeleted({ notes: [{ id: "a", kind: "note", body: "x", deleted_at: null }] }, NOW).length, 0);
  });

  test("荷札：同一刀一組、最短 key 當代表；renamed_to 不是 null 不列", () => {
    const tags: LostRow[] = [
      { id: "b", name: "難度/高", name_key: "難度/高", renamed_to: null, deleted_at: T1 },
      { id: "a", name: "難度", name_key: "難度", renamed_to: null, deleted_at: T1 },
      { id: "c", name: "舊名", name_key: "舊名", renamed_to: "x", deleted_at: T1 },
    ];
    const items = groupDeleted({ tags }, NOW);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "a");
    assert.equal(items[0].title, "#難度");
    assert.deepEqual(items[0].ids, ["a", "b"]);
    assert.equal(lostChildLabel(items[0]), "和底下 1 個");
  });

  test("預算：同一刀一組，預設列當代表，月覆寫算進去", () => {
    const tk_budgets: LostRow[] = [
      { id: "m", kind: "total", category_id: null, month: "2026-11", amount_minor: 900, deleted_at: T1 },
      { id: "d", kind: "total", category_id: null, month: null, amount_minor: 500, deleted_at: T1 },
      { id: "x", kind: "total", category_id: null, month: "2026-10", amount_minor: 700, deleted_at: T2 },
    ];
    const items = groupDeleted({ tk_budgets }, NOW);
    assert.deepEqual(items.map((i) => i.id), ["d", "x"]);
    assert.deepEqual(items[0].ids.slice().sort(), ["d", "m"]);
    assert.equal(items[0].title, "總預算");
    assert.equal(lostChildLabel(items[0]), "含 1 個月的設定");
  });

  test("每種表都登記得到；日記與筆記分得開、分類對", () => {
    const items = groupDeleted(
      {
        notes: [
          { id: "n", kind: "note", title: null, body: "第一行\n第二行\n第三行", deleted_at: T1 },
          { id: "d", kind: "diary", title: null, body: "日記", entry_date: "2026-11-01", deleted_at: T2 },
        ],
        time_blocks: [{ id: "b", category_id: "c", started_at: ago(3), ended_at: ago(3), deleted_at: ago(3) }],
        tk_entries: [{ id: "e", kind: "expense", occurred_on: "2026-11-01", amount_minor: 180, currency: "TWD", note: "午餐", deleted_at: ago(4) }],
        week_aims: [{ id: "w", week_on: "2026-11-02", text: "讀完第三課", deleted_at: ago(5) }],
      },
      NOW,
      namesFromTables({ time_categories: [{ id: "c", name: "閱讀" }], tk_currencies: [{ id: "t", code: "TWD", decimals: 0, is_main: 1 }] }),
    );
    assert.deepEqual(items.map((i) => [i.id, i.kind, i.category]), [
      ["n", "note", "notes"],
      ["d", "diary", "notes"],
      ["b", "time_block", "timetable"],
      ["e", "tk_entry", "ticket"],
      ["w", "week_aim", "tasks"],
    ]);
    assert.equal(items[0].title, "第一行 第二行", "筆記取前兩行");
    assert.equal(items[1].detail, "11/1");
    assert.equal(items[2].title, "閱讀");
    assert.equal(items[3].title, "午餐");
    assert.equal(items[3].detail, "11/1・180");
  });

  test("補充：路線名＋子項數；根層臨時票", () => {
    const names = namesFromTables({ nodes: [{ id: "r", name: "日文", kind: "route" }] });
    const [a] = groupDeleted({ nodes: [node("t", "train", "r", T1, { route_id: "r" }), node("k", "ticket", "t", T1, { route_id: "r" })] }, NOW, names);
    assert.equal(lostSubline(a), "日文・含 1 個子項");
    const [b] = groupDeleted({ nodes: [node("k", "ticket", null, T1)] }, NOW, names);
    assert.equal(b.detail, "臨時車票");
  });

  test("登記表涵蓋 §2.1 全部種類", () => {
    assert.deepEqual(
      LOST_KINDS.map((k) => k.key).sort(),
      ["branch", "car", "diary", "line", "note", "route", "station", "tag", "ticket", "tk_budget", "tk_entry", "tk_repeat", "tk_template", "tk_wish", "time_block", "time_goal", "time_routine", "train", "week_aim"].sort(),
    );
  });
});

describe("week_on 是期間鍵（辛）", () => {
  test("四種期間都寫人看得懂的字，不露期間鍵", () => {
    assert.equal(aimPeriodText("2026-11-02"), "11/2 那週");
    assert.equal(aimPeriodText("M2026-11"), "2026 年 11 月");
    assert.equal(aimPeriodText("Y2026"), "2026 年");
    assert.equal(aimPeriodText("S123e4567"), "車站");
    assert.equal(aimPeriodText("S123e4567", { nodes: { "123e4567": { name: "考過 N5", kind: "station", parent_id: "r" } } }), "車站 考過 N5");
  });
});

describe("placementFor（§2.3）", () => {
  const route = { id: "r", kind: "route", deleted_at: null, name: "日文" };
  const deadTrain = { id: "t", kind: "train", deleted_at: T1, name: "N5" };

  test("幹線、根層臨時票：沒有上層＝原位", () => {
    assert.deepEqual(placementFor(node("l", "line", null, T1), null, null), { type: "inPlace" });
    assert.deepEqual(placementFor(node("k", "ticket", null, T1, { route_id: "r" }), null, route), { type: "inPlace" });
  });

  test("上層活著＝原位", () => {
    assert.deepEqual(placementFor(node("k", "ticket", "t", T1), { ...deadTrain, deleted_at: null }, null), { type: "inPlace" });
  });

  test("車票上層不在：放臨時車票；原路線活著掛標籤，路線也死了就不掛", () => {
    assert.deepEqual(placementFor(node("k", "ticket", "t", T1, { route_id: "r" }), deadTrain, route), { type: "loose", routeId: "r" });
    assert.deepEqual(placementFor(node("k", "ticket", "t", T1, { route_id: "r" }), deadTrain, { ...route, deleted_at: T1 }), { type: "loose", routeId: null });
    assert.deepEqual(placementFor(node("k", "ticket", "t", T1), null, null), { type: "loose", routeId: null }, "這台根本沒有上層");
  });

  test("上層活著但放不了票：車票也走臨時車票", () => {
    assert.deepEqual(placementFor(node("k", "ticket", "x", T1, { route_id: "r" }), { id: "x", kind: "route", deleted_at: null }, route), { type: "loose", routeId: "r" });
  });

  test("其他種類上層不在：回要連同上層與上層資訊", () => {
    const p = placementFor(node("c", "car", "t", T1), deadTrain, null);
    assert.deepEqual(p, { type: "needsParent", parent: { id: "t", name: "N5", kind: "train" } });
    const q = placementFor(node("c", "car", "t", T1), null, null, deadTrain);
    assert.deepEqual(q, { type: "needsParent", parent: { id: "t", name: "N5", kind: "train" } }, "這台沒有上層：名字從快照那列拿");
  });
});

describe("planNodeRestore", () => {
  const nodes = [
    node("l", "line", null, null),
    node("r", "route", "l", T1),
    node("t", "train", "r", T1),
    node("t2", "train", "r", T1),
    node("c", "car", "t", T2),
    node("k", "ticket", "t", T2, { route_id: "r" }),
  ];

  test("上層也刪了：沒帶 withParent 只回 needsParent、不給 ids", () => {
    const p = planNodeRestore({ id: "c", ids: ["c"] }, nodes);
    assert.deepEqual(p.ids, []);
    assert.equal(p.needsParent?.id, "t");
  });

  test("withParent：連上層那一刀（爬到頭、整刀）一起", () => {
    const p = planNodeRestore({ id: "c", ids: ["c"] }, nodes, { withParent: true });
    assert.deepEqual(p.ids.slice().sort(), ["c", "r", "t", "t2"].sort());
    assert.equal(p.needsParent, undefined);
  });

  test("兩層不同刀：一路往上都帶", () => {
    const list = [node("l", "line", null, ago(0, 1000)), node("r", "route", "l", T1), node("t", "train", "r", T2), node("c", "car", "t", ago(3))];
    const p = planNodeRestore({ id: "c", ids: ["c"] }, list, { withParent: true });
    assert.deepEqual(p.ids.slice().sort(), ["c", "l", "r", "t"]);
  });

  test("車票不問：走 loose，路線死了不掛標籤", () => {
    const p = planNodeRestore({ id: "k", ids: ["k"] }, nodes);
    assert.deepEqual(p.loose, { routeId: null });
    assert.equal(p.needsParent, undefined);
  });

  test("上層活著：照 ids", () => {
    const p = planNodeRestore({ id: "r", ids: ["r", "t", "t2"] }, nodes);
    assert.deepEqual(p, { ids: ["r", "t", "t2"] });
  });
});

const COLUMNS: Record<string, string[]> = {
  nodes: ["kind", "parent_id", "name", "description", "position", "status", "sort_key", "route_id", "created_at", "updated_at", "deleted_at"],
  work_logs: ["node_id", "body", "logged_at", "event", "created_at", "updated_at", "deleted_at"],
  occurrences: ["node_id", "due_on", "status", "completed_at", "created_at", "updated_at", "deleted_at"],
  node_time_overrides: ["node_id", "due_on", "hhmm", "created_at", "updated_at", "deleted_at"],
  notes: ["kind", "title", "body", "created_at", "updated_at", "deleted_at"],
  tags: ["name", "name_key", "renamed_to", "created_at", "updated_at", "deleted_at"],
  taggings: ["entity_type", "entity_id", "tag_id", "created_at", "updated_at", "deleted_at"],
  time_categories: ["name", "parent_id", "deleted_at", "updated_at"],
  time_blocks: ["category_id", "started_at", "ended_at", "deleted_at", "updated_at"],
  tk_accounts: ["name", "currency", "deleted_at", "updated_at"],
  tk_categories: ["kind", "name", "parent_id", "deleted_at", "updated_at"],
  tk_currencies: ["code", "deleted_at", "updated_at"],
  tk_entries: ["kind", "occurred_on", "account_id", "category_id", "amount_minor", "currency", "repeat_id", "deleted_at", "updated_at"],
};
const snap = (tables: Record<string, LostRow[]>): CloudSnapshot => ({ exported_at: ago(5), schema: 18, tables, columns: COLUMNS });
/** occurrenceId 的替身：真的 uuid v5 在 repository 那層算好帶進來，這裡只要看得出是決定性 id */
const detOcc = (n: unknown, d: unknown) => `det:${String(n)}|${String(d)}`;
function occIdsOf(s: CloudSnapshot): Map<string, string> {
  return new Map((s.tables.occurrences ?? []).map((o) => [`${String(o.node_id)}|${String(o.due_on)}`, detOcc(o.node_id, o.due_on)] as const));
}

describe("snapshotDiff", () => {
  test("不在／已刪進 missing；活著的不進；conflict log 不算", () => {
    const s = snap({
      notes: [
        { id: "gone", kind: "note", body: "不見了", deleted_at: null },
        { id: "dead", kind: "note", body: "刪了", deleted_at: null },
        { id: "alive", kind: "note", body: "同", deleted_at: null },
        { id: "wasdead", kind: "note", body: "快照時就刪了", deleted_at: ago(9) },
      ],
      work_logs: [{ id: "w", node_id: "n", body: "{}", logged_at: ago(5), event: "conflict", deleted_at: null }],
    });
    const { missing, changed } = snapshotDiff(s, {
      notes: [
        { id: "dead", kind: "note", body: "刪了", deleted_at: T1 },
        { id: "alive", kind: "note", body: "同", deleted_at: null },
      ],
    });
    assert.deepEqual(missing.map((x) => [x.id, x.status, x.deletedAt]).sort(), [
      ["dead", "deleted", T1],
      ["gone", "gone", null],
    ]);
    assert.equal(changed.length, 0);
  });

  test("節點平鋪、帶路線名；子項數只算現在不在或已刪的；走到活著的就停", () => {
    const s = snap({
      nodes: [
        node("r", "route", "l", null),
        node("t", "train", "r", null, { route_id: "r" }),
        node("k1", "ticket", "t", null, { route_id: "r" }),
        node("k2", "ticket", "t", null, { route_id: "r" }),
      ],
    });
    const { missing } = snapshotDiff(s, { nodes: [{ id: "k2", kind: "ticket", deleted_at: null }] });
    const byId = new Map(missing.map((x) => [x.id, x] as const));
    assert.deepEqual([...byId.keys()].sort(), ["k1", "r", "t"]);
    assert.equal(byId.get("r")?.childCount, 2, "t、k1；k2 還活著不算");
    assert.equal(byId.get("t")?.detail, "r");
    assert.equal(byId.get("k1")?.childCount, 0);
  });

  test("荷札：快照的殼、現在已改名的都不列", () => {
    const s = snap({
      tags: [
        { id: "a", name: "刪了", name_key: "刪了", renamed_to: null, deleted_at: null },
        { id: "b", name: "改名了", name_key: "改名了", renamed_to: null, deleted_at: null },
        { id: "c", name: "殼", name_key: "殼", renamed_to: "x", deleted_at: null },
      ],
    });
    const { missing } = snapshotDiff(s, { tags: [{ id: "a", deleted_at: T1, renamed_to: null }, { id: "b", deleted_at: T1, renamed_to: "x" }] });
    assert.deepEqual(missing.map((x) => x.id), ["a"]);
  });

  test("內容不同：只看比對欄；改 position、狀態、排程都不算", () => {
    const s = snap({
      nodes: [node("k", "ticket", null, null, { name: "同", description: "同", position: 1, status: "todo", scheduled_on: "2026-11-01" })],
      notes: [{ id: "n", kind: "note", title: "舊標題", body: "同", noted_at: ago(5), deleted_at: null }],
    });
    const { changed } = snapshotDiff(s, {
      nodes: [node("k", "ticket", null, null, { name: "同", description: "同", position: 9, status: "done", scheduled_on: "2026-12-01" })],
      notes: [{ id: "n", kind: "note", title: "新標題", body: "同", noted_at: ago(1), deleted_at: null }],
    });
    assert.deepEqual(changed, []);
  });

  test("內容不同：車票名稱與概要、筆記日記內文；帶兩邊的值、只放不同的欄", () => {
    const s = snap({
      nodes: [node("k", "ticket", null, null, { name: "舊名", description: "同" }), node("k2", "ticket", null, null, { name: "同", description: "舊概要" })],
      notes: [
        { id: "n", kind: "note", body: "舊內文", deleted_at: null },
        { id: "d", kind: "diary", body: "舊日記", entry_date: "2026-11-01", deleted_at: null },
      ],
    });
    const { changed, missing } = snapshotDiff(s, {
      nodes: [node("k", "ticket", null, null, { name: "新名", description: "同" }), node("k2", "ticket", null, null, { name: "同", description: null })],
      notes: [
        { id: "n", kind: "note", body: "", deleted_at: null },
        { id: "d", kind: "diary", body: "新日記", deleted_at: null },
      ],
    });
    assert.equal(missing.length, 0);
    const byId = new Map(changed.map((x) => [x.id, x] as const));
    assert.deepEqual(byId.get("k")?.fields, [{ col: "name", label: "名稱", snapshot: "舊名", current: "新名" }]);
    assert.deepEqual(byId.get("k2")?.fields, [{ col: "description", label: "概要", snapshot: "舊概要", current: null }]);
    assert.deepEqual(byId.get("n")?.fields, [{ col: "body", label: "內文", snapshot: "舊內文", current: "" }]);
    assert.equal(byId.get("d")?.kind, "diary");
  });

  test("已刪的不進 changed；NULL 與空字串算一樣；其他種類不比；車票轉了種類不比", () => {
    const s = snap({
      nodes: [node("k", "ticket", null, null, { name: "舊", description: null }), node("t", "train", "r", null, { name: "舊列車" }), node("x", "ticket", "t", null, { name: "舊" })],
      notes: [{ id: "n", kind: "note", body: "舊", deleted_at: null }],
      tk_wishes: [{ id: "w", name: "舊", deleted_at: null }],
    });
    const { changed, missing } = snapshotDiff(s, {
      nodes: [node("k", "ticket", null, T1, { name: "新" }), node("t", "train", "r", null, { name: "新列車" }), node("x", "car", "t", null, { name: "新" })],
      notes: [{ id: "n", kind: "note", body: "新", deleted_at: T1 }],
      tk_wishes: [{ id: "w", name: "新", deleted_at: null }],
    });
    assert.deepEqual(changed, []);
    assert.deepEqual(missing.map((x) => x.id).sort(), ["k", "n"]);
    const eq = snapshotDiff(snap({ nodes: [node("k", "ticket", null, null, { description: "" })] }), { nodes: [node("k", "ticket", null, null, { description: null })] });
    assert.deepEqual(eq.changed, []);
  });
});

describe("planRescue（§3.3）", () => {
  const NOW_ISO = "2026-11-04T12:00:00.000Z";

  test("節點：子樹中不在或已刪的＋日誌、班次、逐班時刻、荷札；conflict 不帶；活著的不動；整列 op", () => {
    const s = snap({
      nodes: [
        node("r", "route", "l", null, { line_id: "l", created_at: ago(9), updated_at: ago(9) }),
        node("t", "train", "r", null, { line_id: "l", route_id: "r" }),
        node("alive", "ticket", "t", null, { line_id: "l", route_id: "r" }),
      ],
      work_logs: [
        { id: "w1", node_id: "t", body: "", logged_at: ago(9), event: "issued", deleted_at: null },
        { id: "w2", node_id: "t", body: "{}", logged_at: ago(9), event: "conflict", deleted_at: null },
        { id: "w3", node_id: "alive", body: "活著的票的日誌", logged_at: ago(9), event: null, deleted_at: null },
      ],
      occurrences: [{ id: "o1", node_id: "t", due_on: "2026-11-01", status: "done", deleted_at: null }],
      node_time_overrides: [{ id: "n1", node_id: "t", due_on: "2026-11-01", hhmm: "09:00", deleted_at: null }],
      taggings: [{ id: "g1", entity_type: "node", entity_id: "t", tag_id: "tg", deleted_at: null }],
      tags: [{ id: "tg", name: "難", name_key: "難", renamed_to: null, deleted_at: null }],
    });
    const cur = { nodes: [node("l", "line", null, null), node("alive", "ticket", "t", null), node("r", "route", "l", T1, { line_id: "l" })] };
    const plan = planRescue(s, { table: "nodes", id: "r" }, cur, NOW_ISO, occIdsOf(s));
    const ids = plan.writes.map((w) => `${w.table}:${w.id}`);
    assert.ok(ids.indexOf("nodes:r") < ids.indexOf("nodes:t"), "父先子後");
    assert.ok(!ids.includes("nodes:alive"), "活著的子節點不動");
    assert.ok(!ids.includes("work_logs:w2"), "競合日誌不帶");
    assert.ok(!ids.includes("work_logs:w3"), "活著的票的東西也不動");
    for (const want of ["work_logs:w1", `occurrences:${detOcc("t", "2026-11-01")}`, "node_time_overrides:n1", "taggings:g1", "tags:tg"]) assert.ok(ids.includes(want), want);

    const route = plan.writes.find((w) => w.id === "r")!;
    assert.equal(route.row.deleted_at, null);
    assert.equal(route.row.updated_at, NOW_ISO);
    assert.equal(route.row.line_id, "l", "快取欄走建票同一支推導");
    assert.equal(route.op.kind, "route");
    assert.equal(route.op.name, "r");
    assert.equal(route.op.deleted_at, null);
    assert.equal(route.op.updated_at, NOW_ISO);
    assert.ok(!("line_id" in route.op) && !("route_id" in route.op), "快取欄不進 op");
    const train = plan.writes.find((w) => w.id === "t")!;
    assert.equal(train.row.route_id, "r");
    assert.equal(train.row.line_id, "l");
    assert.ok(!("route_id" in train.op));
  });

  test("車票上層不在：放臨時車票，路線活著掛標籤；op 帶 parent_id、route_id，line_id 不進 op", () => {
    const s = snap({ nodes: [node("k", "ticket", "t", null, { route_id: "r", line_id: "l", sort_key: "a0" }), node("t", "train", "r", null, { route_id: "r" })] });
    const plan = planRescue(s, { table: "nodes", id: "k" }, { nodes: [node("r", "route", "l", null, { line_id: "l" })] }, NOW_ISO, occIdsOf(s));
    assert.equal(plan.placedAsLoose, true);
    const w = plan.writes.find((x) => x.id === "k")!;
    assert.equal(w.row.parent_id, null);
    assert.equal(w.row.route_id, "r");
    assert.equal(w.row.line_id, "l");
    assert.equal(w.row.sort_key, null, "換了清單，鍵清掉等回填");
    assert.equal(w.op.parent_id, null);
    assert.equal(w.op.route_id, "r");
    assert.ok(!("line_id" in w.op));
    assert.equal(plan.writes.filter((x) => x.table === "nodes").length, 1, "不帶上層");
  });

  test("非車票上層不在：沒同意就不寫；withParent 連上層鏈帶回", () => {
    const s = snap({ nodes: [node("r", "route", "l", null), node("t", "train", "r", null), node("c", "car", "t", null)] });
    const cur = { nodes: [node("l", "line", null, null)] };
    const a = planRescue(s, { table: "nodes", id: "c" }, cur, NOW_ISO, occIdsOf(s));
    assert.deepEqual(a.needsParent, { id: "t", name: "t", kind: "train" });
    assert.equal(a.writes.length, 0);
    const b = planRescue(s, { table: "nodes", id: "c" }, cur, NOW_ISO, occIdsOf(s), { withParent: true });
    assert.deepEqual(b.writes.map((w) => w.id), ["r", "t", "c"]);
    assert.equal(b.writes[2].row.route_id, "r");
  });

  test("外鍵依賴現在沒有：從快照一起帶、依賴在前；活著的依賴不動", () => {
    const s = snap({
      tk_entries: [{ id: "e", kind: "expense", occurred_on: "2026-11-01", account_id: "a", category_id: "c2", amount_minor: 1, currency: "USD", deleted_at: null }],
      tk_accounts: [{ id: "a", name: "現金", currency: "USD", deleted_at: null }],
      tk_categories: [{ id: "c1", kind: "expense", name: "主", parent_id: null, deleted_at: null }, { id: "c2", kind: "expense", name: "子", parent_id: "c1", deleted_at: null }],
      tk_currencies: [{ id: "u", code: "USD", deleted_at: null }],
    });
    const plan = planRescue(s, { table: "tk_entries", id: "e" }, { tk_categories: [{ id: "c1", deleted_at: null }] }, NOW_ISO, occIdsOf(s));
    assert.deepEqual(plan.writes.map((w) => `${w.table}:${w.id}`), ["tk_currencies:u", "tk_accounts:a", "tk_categories:c2", "tk_entries:e"]);
    assert.deepEqual(plan.entries, [], "沒有 repeat_id");
  });

  test("依賴快照也沒有、這台也沒有：擋下（外鍵會炸），講人話", () => {
    const s = snap({ tk_entries: [{ id: "e", kind: "expense", account_id: "a", amount_minor: 1, currency: "TWD", deleted_at: null }] });
    assert.throws(() => planRescue(s, { table: "tk_entries", id: "e" }, {}, NOW_ISO, occIdsOf(s)), /備份裡也沒有/);
  });

  test("荷札指到的 tag 現在已改名：掛載照帶、tag 不復活（由 reconcileRenamed 跟）", () => {
    const s = snap({
      notes: [{ id: "n", kind: "note", body: "#舊", deleted_at: null }],
      taggings: [{ id: "g", entity_type: "note", entity_id: "n", tag_id: "tg", deleted_at: null }],
      tags: [{ id: "tg", name: "舊", name_key: "舊", renamed_to: null, deleted_at: null }],
    });
    const plan = planRescue(s, { table: "notes", id: "n" }, { tags: [{ id: "tg", deleted_at: T1, renamed_to: "new" }] }, NOW_ISO, occIdsOf(s));
    assert.deepEqual(plan.writes.map((w) => `${w.table}:${w.id}`), ["notes:n", "taggings:g"]);
  });

  test("荷札本身：連掛載回來、活著的筆記要補內文；實體不在的掛載不帶", () => {
    const s = snap({
      tags: [{ id: "tg", name: "旅行", name_key: "旅行", renamed_to: null, deleted_at: null }],
      taggings: [
        { id: "g1", entity_type: "note", entity_id: "n1", tag_id: "tg", deleted_at: null },
        { id: "g2", entity_type: "note", entity_id: "n2", tag_id: "tg", deleted_at: null },
      ],
    });
    const plan = planRescue(s, { table: "tags", id: "tg" }, { notes: [{ id: "n1", deleted_at: null }] }, NOW_ISO, occIdsOf(s));
    assert.deepEqual(plan.writes.map((w) => w.id), ["tg", "g1"]);
    assert.deepEqual(plan.tagBodies, [{ noteId: "n1", key: "旅行", name: "旅行" }]);
  });

  test("時間塊：先寫成 tombstone（delete op），交給 restore；還在運行的結束在快照那一刻", () => {
    const s = snap({ time_blocks: [{ id: "b", category_id: "c", started_at: ago(6), ended_at: null, deleted_at: null }], time_categories: [{ id: "c", name: "讀", parent_id: null, deleted_at: null }] });
    const plan = planRescue(s, { table: "time_blocks", id: "b" }, {}, NOW_ISO, occIdsOf(s));
    assert.deepEqual(plan.writes.map((w) => w.id), ["c", "b"], "分類先");
    const w = plan.writes[1];
    assert.equal(w.opType, "delete");
    assert.equal(w.row.deleted_at, NOW_ISO);
    assert.equal(w.row.ended_at, s.exported_at);
    assert.equal(plan.restoreBlockId, "b");
  });

  test("同一班現在已有另一列活著（舊版隨機 id）：不帶，唯一索引不容兩列", () => {
    const s = snap({ nodes: [node("k", "ticket", null, null)], occurrences: [{ id: "old", node_id: "k", due_on: "2026-11-01", status: "done", deleted_at: null }] });
    const plan = planRescue(s, { table: "nodes", id: "k" }, { occurrences: [{ id: "new", node_id: "k", due_on: "2026-11-01", deleted_at: null }] }, NOW_ISO, occIdsOf(s));
    assert.deepEqual(plan.writes.map((w) => w.id), ["k"]);
  });

  test("快照裡找不到：擋下", () => {
    assert.throws(() => planRescue(snap({}), { table: "notes", id: "x" }, {}, NOW_ISO, occIdsOf(snap({}))), /找不到/);
  });
});

describe("文案", () => {
  test("分段、幾天前、toast、確認框", () => {
    const now = new Date(2026, 10, 4, 12).getTime();
    assert.equal(lostDaySection(new Date(2026, 10, 4, 1).toISOString(), now), "今天");
    assert.equal(lostDaySection(new Date(2026, 10, 3, 23).toISOString(), now), "昨天");
    assert.equal(lostDaySection(new Date(2026, 9, 30, 1).toISOString(), now), "10/30");
    assert.equal(lostDaysAgo(new Date(2026, 10, 4, 1).toISOString(), now), "今天");
    assert.equal(lostDaysAgo(new Date(2026, 10, 1, 1).toISOString(), now), "3 天前");
    assert.equal(lostRestoredToast("票"), "已撿回「票」");
    assert.equal(lostRestoredToast("票", { placedAsLoose: true }), "已撿回「票」，放到臨時車票");
    assert.equal(lostParentConfirm("N5"), "它的上層「N5」也刪了，要連同上層一起撿回嗎？");
  });
});

/* ═══════════════ 對抗審查的修正（docs/research/2026-11-05-失物招領-對抗審查.md） ═══════════════ */

const NOW_ISO2 = "2026-11-04T12:00:00.000Z";
const rescuePlan = (s: CloudSnapshot, item: { table: string; id: string }, cur: Record<string, LostRow[]>, opts?: { withParent?: boolean }) =>
  planRescue(s, item, cur, NOW_ISO2, occIdsOf(s), opts);

describe("問題 1＋8：本機有 tombstone＝照本機內容復活，只有本機沒有這一列才用快照", () => {
  test("筆記：內文用本機 tombstone 的（比快照新）；op 整列、deleted_at 清掉", () => {
    const s = snap({ notes: [{ id: "n", kind: "note", title: null, body: "週一版", created_at: ago(9), updated_at: ago(9), deleted_at: null }] });
    const cur = { notes: [{ id: "n", kind: "note", title: "後來加的", body: "週二版", created_at: ago(9), updated_at: T1, deleted_at: T1 }] };
    const plan = rescuePlan(s, { table: "notes", id: "n" }, cur);
    const w = plan.writes.find((x) => x.id === "n")!;
    assert.equal(w.row.body, "週二版");
    assert.equal(w.op.body, "週二版");
    assert.equal(w.op.title, "後來加的");
    assert.equal(w.op.kind, "note", "整列同步欄：對面可能沒有這一列");
    assert.equal(w.op.deleted_at, null);
    assert.equal(w.op.updated_at, NOW_ISO2);
  });

  test("節點：根與子都用本機內容；本機沒有的子節點才用快照列", () => {
    const s = snap({
      nodes: [
        node("r", "route", "l", null, { name: "快照路線", status: "todo" }),
        node("k1", "ticket", "r", null, { name: "快照票一" }),
        node("k2", "ticket", "r", null, { name: "快照票二" }),
      ],
    });
    const cur = { nodes: [node("l", "line", null, null), node("r", "route", "l", T1, { name: "較新的路線", status: "doing" }), node("k1", "ticket", "r", T1, { name: "較新的票" })] };
    const plan = rescuePlan(s, { table: "nodes", id: "r" }, cur);
    const by = new Map(plan.writes.map((w) => [w.id, w] as const));
    assert.equal(by.get("r")?.row.name, "較新的路線");
    assert.equal(by.get("r")?.op.status, "doing");
    assert.equal(by.get("k1")?.op.name, "較新的票");
    assert.equal(by.get("k2")?.op.name, "快照票二", "本機沒有這一列");
  });

  test("連同上層：上層有 tombstone 也送整列（快照沒有這列時不能只送兩欄）", () => {
    const s = snap({ nodes: [node("c", "car", "t", null)] });
    const cur = { nodes: [node("l", "line", null, null), node("r", "route", "l", null, { line_id: "l" }), node("t", "train", "r", T1, { line_id: "l", route_id: "r", name: "本機列車", description: "概要", position: 3 })] };
    const plan = rescuePlan(s, { table: "nodes", id: "c" }, cur, { withParent: true });
    const up = plan.writes[0];
    assert.equal(up.id, "t");
    assert.equal(up.op.kind, "train");
    assert.equal(up.op.name, "本機列車");
    assert.equal(up.op.parent_id, "r");
    assert.equal(up.op.position, 3);
    assert.equal(up.op.deleted_at, null);
    assert.equal(up.row.deleted_at, null);
    assert.equal("reviveOnly" in up, false);
    assert.equal(plan.writes[1].row.route_id, "r");
  });

  test("連同上層：快照也有上層時，一樣用本機 tombstone 的內容", () => {
    const s = snap({ nodes: [node("t", "train", "r", null, { name: "快照列車" }), node("c", "car", "t", null)] });
    const cur = { nodes: [node("r", "route", "l", null), node("t", "train", "r", T1, { name: "較新的列車" })] };
    const plan = rescuePlan(s, { table: "nodes", id: "c" }, cur, { withParent: true });
    assert.equal(plan.writes.find((w) => w.id === "t")?.op.name, "較新的列車");
  });

  test("本機 tombstone 的上層跟快照不同：放在本機記的位置，不看快照的上層", () => {
    const s = snap({ nodes: [node("k", "ticket", "t", null, { route_id: "r" })] });
    const cur = { nodes: [node("t2", "train", "r", null), node("k", "ticket", "t2", T1, { name: "搬過的票" })] };
    const plan = rescuePlan(s, { table: "nodes", id: "k" }, cur);
    assert.equal(plan.placedAsLoose, false);
    assert.equal(plan.writes[0].row.parent_id, "t2");
  });

  test("子節點本機 tombstone 搬到別處、那裡也不在：不帶，免得復活到看不見的地方", () => {
    const s = snap({ nodes: [node("t", "train", "r", null), node("k", "ticket", "t", null)] });
    const cur = { nodes: [node("r", "route", "l", null), node("t", "train", "r", T1), node("x", "train", "r", T2), node("k", "ticket", "x", T1)] };
    const plan = rescuePlan(s, { table: "nodes", id: "t" }, cur);
    assert.deepEqual(plan.writes.map((w) => w.id), ["t"]);
  });

  test("時間塊有 tombstone：用本機內容、刪除時刻不變（restore 靠它算結束時刻），op 整列", () => {
    const s = snap({ time_blocks: [{ id: "b", category_id: "c", started_at: ago(6), ended_at: ago(5), deleted_at: null }] });
    const cur = { time_blocks: [{ id: "b", category_id: "c2", started_at: ago(6), ended_at: null, deleted_at: T1 }], time_categories: [{ id: "c2", deleted_at: null }] };
    const plan = rescuePlan(s, { table: "time_blocks", id: "b" }, cur);
    const w = plan.writes[0];
    assert.equal(w.row.category_id, "c2");
    assert.equal(w.row.deleted_at, T1);
    assert.equal(w.row.ended_at, null);
    assert.equal(w.op.category_id, "c2");
    assert.equal(w.op.updated_at, NOW_ISO2);
    assert.equal(plan.restoreBlockId, "b");
  });

  test("snapshotDiff：有 tombstone 的列顯示本機的字", () => {
    const s = snap({ notes: [{ id: "n", kind: "note", body: "週一版", deleted_at: null }], nodes: [node("k", "ticket", null, null, { name: "舊名" })] });
    const { missing } = snapshotDiff(s, { notes: [{ id: "n", kind: "note", body: "週二版", deleted_at: T1 }], nodes: [node("k", "ticket", null, T1, { name: "新名" })] });
    const by = new Map(missing.map((x) => [x.id, x] as const));
    assert.equal(by.get("n")?.title, "週二版");
    assert.equal(by.get("k")?.title, "新名");
  });

  test("本體照本機復活時，子列也以本機為準：刪之前就拿掉的不帶，同一刀的帶，本機沒有的從快照帶", () => {
    const s = snap({
      notes: [{ id: "n", kind: "note", body: "#a #b #c", deleted_at: null }],
      tags: [
        { id: "ta", name: "a", name_key: "a", renamed_to: null, deleted_at: null },
        { id: "tb", name: "b", name_key: "b", renamed_to: null, deleted_at: null },
        { id: "tc", name: "c", name_key: "c", renamed_to: null, deleted_at: null },
      ],
      taggings: [
        { id: "ga", entity_type: "note", entity_id: "n", tag_id: "ta", deleted_at: null },
        { id: "gb", entity_type: "note", entity_id: "n", tag_id: "tb", deleted_at: null },
        { id: "gc", entity_type: "note", entity_id: "n", tag_id: "tc", deleted_at: null },
      ],
    });
    const cur = {
      notes: [{ id: "n", kind: "note", body: "#b", deleted_at: T1 }],
      taggings: [
        { id: "ga", entity_type: "note", entity_id: "n", tag_id: "ta", deleted_at: T2 }, // 使用者先摘掉
        { id: "gb", entity_type: "note", entity_id: "n", tag_id: "tb", deleted_at: T1 }, // 同一刀
      ],
      tags: [{ id: "ta", deleted_at: null }, { id: "tb", deleted_at: null }, { id: "tc", deleted_at: null }],
    };
    const plan = rescuePlan(s, { table: "notes", id: "n" }, cur);
    assert.deepEqual(plan.writes.map((w) => w.id), ["n", "gb", "gc"]);
  });

  test("撤掉的済章不會跟著撿回（班次有 tombstone、時刻跟車票不同）", () => {
    const s = snap({ nodes: [node("k", "ticket", null, null)], occurrences: [{ id: detOcc("k", "2026-11-01"), node_id: "k", due_on: "2026-11-01", status: "done", deleted_at: null }] });
    const cur = { nodes: [node("k", "ticket", null, T1)], occurrences: [{ id: detOcc("k", "2026-11-01"), node_id: "k", due_on: "2026-11-01", status: "done", deleted_at: T2 }] };
    assert.deepEqual(rescuePlan(s, { table: "nodes", id: "k" }, cur).writes.map((w) => w.id), ["k"]);
  });
});

describe("問題 2：目標現在活著就不寫", () => {
  test("活著的筆記：回已經在了、一列都不寫", () => {
    const s = snap({ notes: [{ id: "n", kind: "note", body: "快照", deleted_at: null }] });
    const plan = rescuePlan(s, { table: "notes", id: "n" }, { notes: [{ id: "n", kind: "note", body: "另一台改過", deleted_at: null }] });
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.alreadyHere, true);
  });

  test("活著的節點：自己不寫，只補底下不在的子節點", () => {
    const s = snap({ nodes: [node("t", "train", "r", null, { name: "快照名" }), node("k", "ticket", "t", null), node("alive", "ticket", "t", null)] });
    const cur = { nodes: [node("r", "route", "l", null), node("t", "train", "r", null, { name: "現在的名字" }), node("alive", "ticket", "t", null)] };
    const plan = rescuePlan(s, { table: "nodes", id: "t" }, cur);
    assert.deepEqual(plan.writes.map((w) => w.id), ["k"]);
    assert.equal(plan.alreadyHere, true);
  });

  test("活著的時間塊：不寫 tombstone、也不走 restore", () => {
    const s = snap({ time_blocks: [{ id: "b", category_id: "c", started_at: ago(6), ended_at: ago(5), deleted_at: null }] });
    const plan = rescuePlan(s, { table: "time_blocks", id: "b" }, { time_blocks: [{ id: "b", deleted_at: null }] });
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.restoreBlockId, null);
    assert.equal(plan.alreadyHere, true);
  });

  test("活著的荷札、已改名的荷札：都不寫", () => {
    const s = snap({ tags: [{ id: "tg", name: "x", name_key: "x", renamed_to: null, deleted_at: null }], taggings: [{ id: "g", entity_type: "note", entity_id: "n", tag_id: "tg", deleted_at: null }] });
    const notes = [{ id: "n", deleted_at: null }];
    for (const tags of [[{ id: "tg", deleted_at: null, renamed_to: null }], [{ id: "tg", deleted_at: T1, renamed_to: "y" }]]) {
      const plan = rescuePlan(s, { table: "tags", id: "tg" }, { tags, notes });
      assert.deepEqual(plan.writes, []);
      assert.deepEqual(plan.tagBodies, []);
      assert.equal(plan.alreadyHere, true);
    }
  });
});

describe("問題 5：荷札快照撿回不帶使用者自己摘掉的", () => {
  const s = snap({
    tags: [{ id: "tg", name: "x", name_key: "x", renamed_to: null, deleted_at: null }],
    taggings: [
      { id: "own", entity_type: "note", entity_id: "n1", tag_id: "tg", deleted_at: null },
      { id: "cut", entity_type: "note", entity_id: "n2", tag_id: "tg", deleted_at: null },
      { id: "new", entity_type: "note", entity_id: "n3", tag_id: "tg", deleted_at: null },
    ],
  });
  test("時刻不同＝使用者摘的：不帶、不補內文；同一刀的帶；本機沒有這列的照快照帶", () => {
    const cur = {
      tags: [{ id: "tg", name: "x", name_key: "x", renamed_to: null, deleted_at: T1 }],
      notes: [{ id: "n1", deleted_at: null }, { id: "n2", deleted_at: null }, { id: "n3", deleted_at: null }],
      taggings: [
        { id: "own", entity_type: "note", entity_id: "n1", tag_id: "tg", deleted_at: T2 },
        { id: "cut", entity_type: "note", entity_id: "n2", tag_id: "tg", deleted_at: T1 },
      ],
    };
    const plan = rescuePlan(s, { table: "tags", id: "tg" }, cur);
    assert.deepEqual(plan.writes.map((w) => w.id), ["tg", "cut", "new"]);
    assert.deepEqual(plan.tagBodies.map((b) => b.noteId), ["n2", "n3"]);
  });
});

describe("問題 7：班次一律寫決定性 id", () => {
  test("快照裡的舊隨機 id 改寫成決定性 id（列與 op 都是）", () => {
    const s = snap({ nodes: [node("k", "ticket", null, null)], occurrences: [{ id: "old-random", node_id: "k", due_on: "2026-11-01", status: "done", deleted_at: null }] });
    const plan = rescuePlan(s, { table: "nodes", id: "k" }, {});
    const w = plan.writes.find((x) => x.table === "occurrences")!;
    assert.equal(w.id, detOcc("k", "2026-11-01"));
    assert.equal(w.row.id, detOcc("k", "2026-11-01"));
    assert.equal(w.op.status, "done");
    assert.ok(!plan.writes.some((x) => x.id === "old-random"));
  });

  test("本機該班已有活列（不管哪個 id）：不帶", () => {
    const s = snap({ nodes: [node("k", "ticket", null, null)], occurrences: [{ id: "old", node_id: "k", due_on: "2026-11-01", status: "done", deleted_at: null }] });
    for (const id of ["old", "new", detOcc("k", "2026-11-01")]) {
      const plan = rescuePlan(s, { table: "nodes", id: "k" }, { occurrences: [{ id, node_id: "k", due_on: "2026-11-01", deleted_at: null }] });
      assert.deepEqual(plan.writes.map((w) => w.id), ["k"], id);
    }
  });
});

describe("問題 9：根層臨時車票的路線不在", () => {
  test("placementFor：路線死了或沒有就放收件匣、清標籤；路線活著照原位；沒標籤照原位", () => {
    const r = { id: "r", kind: "route", deleted_at: null };
    const t = node("k", "ticket", null, T1, { route_id: "r" });
    assert.deepEqual(placementFor(t, null, { ...r, deleted_at: T1 }), { type: "loose", routeId: null });
    assert.deepEqual(placementFor(t, null, null), { type: "loose", routeId: null });
    assert.deepEqual(placementFor(t, null, r), { type: "inPlace" });
    assert.deepEqual(placementFor(node("k", "ticket", null, T1), null, null), { type: "inPlace" });
  });

  test("planNodeRestore 與 planRescue：清標籤、op 帶 route_id null、toast 走放到臨時車票", () => {
    const list = [node("r", "route", "l", T2), node("k", "ticket", null, T1, { route_id: "r" })];
    assert.deepEqual(planNodeRestore({ id: "k", ids: ["k"] }, list), { ids: ["k"], loose: { routeId: null } });
    const s = snap({ nodes: [node("k", "ticket", null, null, { route_id: "r", sort_key: "a0" })] });
    const plan = rescuePlan(s, { table: "nodes", id: "k" }, { nodes: [node("r", "route", "l", T2)] });
    assert.equal(plan.placedAsLoose, true);
    const w = plan.writes[0];
    assert.equal(w.row.route_id, null);
    assert.equal(w.op.route_id, null);
    assert.ok("route_id" in w.op);
    assert.equal(w.row.sort_key, null);
  });
});

describe("問題 10：復活依賴幣別不能多一個主幣別", () => {
  const s = snap({
    tk_entries: [{ id: "e", kind: "expense", account_id: "a", amount_minor: 1, currency: "USD", deleted_at: null }],
    tk_accounts: [{ id: "a", name: "美金", currency: "USD", deleted_at: null }],
    tk_currencies: [{ id: "usd", code: "USD", is_main: 1, deleted_at: null }],
  });
  test("本機已有活的主幣別：復活列 is_main＝0", () => {
    const plan = rescuePlan(s, { table: "tk_entries", id: "e" }, { tk_currencies: [{ id: "twd", code: "TWD", is_main: 1, deleted_at: null }] });
    assert.equal(plan.writes.find((x) => x.table === "tk_currencies")?.row.is_main, 0);
  });
  test("本機沒有活的主幣別：維持主幣別", () => {
    const plan = rescuePlan(s, { table: "tk_entries", id: "e" }, { tk_currencies: [] });
    assert.equal(plan.writes.find((x) => x.table === "tk_currencies")?.row.is_main, 1);
  });
});

describe("問題 2：重算差異（mergeSnapshotDiff）", () => {
  const item = (id: string) => ({ key: `notes:${id}`, id, title: id }) as never;
  const ch = (id: string) => ({ key: `notes:${id}`, id, title: id, fields: [] }) as never;
  test("已撿回的留著打勾；別台撿回的消失；又被刪的取消打勾；新出現的加進來", () => {
    const prev = { missing: [item("a"), item("b"), item("c")], changed: [] };
    const next = { missing: [item("b"), item("d")], changed: [ch("a")] };
    const out = mergeSnapshotDiff(prev, next, { "notes:a": true, "notes:b": true }, {});
    assert.deepEqual(out.diff.missing.map((x: { id: string }) => x.id), ["a", "b", "d"]);
    assert.deepEqual(out.picked, { "notes:a": true }, "b 又不在了，要能再撿一次");
    assert.deepEqual(out.diff.changed.map((x: { id: string }) => x.id), ["a"], "復活後內容不同的列進內容不同");
  });
  test("已改回的留著；又變不同的取消已改回；sweep＝這次撿回順手帶回的列也打勾", () => {
    const prev = { missing: [item("up"), item("x")], changed: [ch("r1"), ch("r2"), ch("r3")] };
    const next = { missing: [item("x")], changed: [ch("r2")] };
    const rc = { "notes:r1": { id: "r1" }, "notes:r2": { id: "r2" } } as never;
    const out = mergeSnapshotDiff(prev, next, {}, rc, { sweep: true });
    assert.deepEqual(out.diff.changed.map((x: { id: string }) => x.id), ["r1", "r2"]);
    assert.deepEqual(Object.keys(out.reverted), ["notes:r1"]);
    assert.deepEqual(out.picked, { "notes:up": true });
    assert.deepEqual(out.diff.missing.map((x: { id: string }) => x.id), ["up", "x"]);
  });
  test("沒有前一份：照新的", () => {
    const next = { missing: [item("a")], changed: [] };
    assert.deepEqual(mergeSnapshotDiff(null, next, {}, {}).diff, next);
  });
});

describe("文案：問題 2、4", () => {
  test("已經在了；補回子項；中間的班次不補", () => {
    assert.equal(lostAlreadyHereToast("票", 0), "「票」已經在了");
    assert.equal(lostAlreadyHereToast("路線", 2), "「路線」已經在了，補回底下 2 個");
    assert.equal(LOST_NO_BACKFILL, "中間的班次不補");
  });
});
