/**
 * 資料匯出（失物招領 §4）：範圍與表分類、清理規則、JSON 結構、CSV 跳脫與換名稱、zip 裝箱、讀資料庫。
 * 跑法：`node --test scripts/tests/data-export.test.ts`。
 *
 * 載入：domain/repeat.ts 以無副檔名 import "../lib/date"、data/dataExport.ts 也是——static import 會在 registerHooks 之前解析，
 * 所以 src 的值一律等 hook 掛好後動態載入（同 ticket-plan-logic.test.ts）。
 * 時區：測資的時刻一律用 `new Date(y, m-1, d, h, mi)` 造本地時刻，不寫 UTC 字面值（CSV 顯示本地時間，日界線也用本地）。
 * 讀資料庫的測試：node:sqlite 記憶體庫＋`src-tauri/migrations` 全部依序跑，`../lib/db` 換成回這顆庫的替身。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const FAKE_DB = `
let t = Date.UTC(2026, 10, 4, 1, 0, 0);
export function getDb() { const d = globalThis.__exDb; if (!d) throw new Error("測試沒設 __exDb"); return Promise.resolve(d); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_INDEX = `export const MOCK_MODE = false;`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "./index") return { url: dataUrl(FAKE_INDEX), shortCircuit: true };
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const D = await import("../../src/domain/dataExport.ts");
const { SYNC_TABLE_NAMES } = await import("../../src/data/syncTables.ts");
const { readExportRows } = await import("../../src/data/dataExport.ts");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Row = Record<string, unknown>;

const dec = new TextDecoder("utf-8", { ignoreBOM: true }); // 保留 BOM，才驗得到它
const textOf = (files: { path: string; bytes: Uint8Array }[], p: string): string => {
  const f = files.find((x) => x.path === p);
  assert.ok(f, `沒有 ${p}；有：${files.map((x) => x.path).join("、")}`);
  return dec.decode(f.bytes);
};
/** 去掉 BOM、按 CRLF 切成列（最後一個空段去掉） */
const linesOf = (csv: string): string[] => {
  assert.ok(csv.startsWith("\uFEFF"), "CSV 要有 BOM");
  const body = csv.slice(1);
  assert.ok(body.endsWith("\r\n"), "CSV 結尾要有 CRLF");
  return body.slice(0, -2).split("\r\n");
};
const local = (y: number, m: number, d: number, h = 0, mi = 0): string => new Date(y, m - 1, d, h, mi).toISOString();
const META = { schema: 18, exportedAt: "2026-11-04T08:00:00.000Z" };

/* ═══════════════ csvEscape／csvText ═══════════════ */

describe("csvEscape", () => {
  test("一般文字原樣；逗號、雙引號、換行包引號，雙引號加倍", () => {
    assert.equal(D.csvEscape("午餐"), "午餐");
    assert.equal(D.csvEscape("a,b"), '"a,b"');
    assert.equal(D.csvEscape('他說"好"'), '"他說""好"""');
    assert.equal(D.csvEscape("第一行\n第二行"), '"第一行\n第二行"');
    assert.equal(D.csvEscape("a\r\nb"), '"a\r\nb"');
  });

  test("文字開頭是 = + - @（以及 Tab、CR）前面補單引號", () => {
    assert.equal(D.csvEscape("=1+1"), "'=1+1");
    assert.equal(D.csvEscape("+886912"), "'+886912");
    assert.equal(D.csvEscape("-5 折"), "'-5 折");
    assert.equal(D.csvEscape("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(D.csvEscape("\t=cmd"), '\'\t=cmd'); // Tab 開頭也補；Tab 不用包引號
    assert.equal(D.csvEscape('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  });

  test("補單引號之後該包引號還是要包", () => {
    assert.equal(D.csvEscape("=a,b"), `"'=a,b"`);
  });

  test("數字不補單引號：負數金額照原樣、不加引號", () => {
    assert.equal(D.csvEscape(-120), "-120");
    assert.equal(D.csvEscape(-120.5), "-120.5");
    assert.equal(D.csvEscape(0), "0");
    assert.equal(D.csvEscape(12.5), "12.5");
  });

  test("日期與時刻（數字開頭）不受影響；null／undefined／NaN → 空", () => {
    assert.equal(D.csvEscape("2026-11-04"), "2026-11-04");
    assert.equal(D.csvEscape("2026-11-04 08:30"), "2026-11-04 08:30");
    assert.equal(D.csvEscape(null), "");
    assert.equal(D.csvEscape(undefined), "");
    assert.equal(D.csvEscape(Number.NaN), "");
  });
});

describe("csvText", () => {
  test("UTF-8 BOM 開頭、列間 CRLF、結尾 CRLF", () => {
    const t = D.csvText([
      ["欄A", "欄B"],
      ["x", -3],
    ]);
    assert.equal(t, "\uFEFF欄A,欄B\r\nx,-3\r\n");
    // 編成位元組後開頭真的是 EF BB BF
    const bytes = new TextEncoder().encode(t);
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  });
});

/* ═══════════════ 範圍與表分類 ═══════════════ */

describe("範圍與同步表對帳", () => {
  const all = D.EXPORT_SCOPES.find((s: Any) => s.id === "all")!;

  test("範圍就是 all／tasks／notes／timetable／ticket", () => {
    assert.deepEqual(
      D.EXPORT_SCOPES.map((s: Any) => s.id),
      ["all", "tasks", "notes", "timetable", "ticket"],
    );
  });

  test("每張同步表不是被分進某個範圍，就是明列「不匯出」——新表沒分類這裡就紅", () => {
    const unclassified = SYNC_TABLE_NAMES.filter((t: string) => !all.tables.includes(t) && !D.EXPORT_SKIPPED_TABLES.includes(t));
    assert.deepEqual(unclassified, [], `這些同步表還沒決定要不要匯出（去 domain/dataExport.ts 的 EXPORT_SCOPES 分類）：${unclassified.join("、")}`);
  });

  test("匯出的表都真的是同步表（不能有打錯的表名）；不匯出的不在任何範圍", () => {
    for (const s of D.EXPORT_SCOPES) for (const t of s.tables) assert.ok(SYNC_TABLE_NAMES.includes(t), `${s.id} 的 ${t} 不是同步表`);
    for (const t of D.EXPORT_SKIPPED_TABLES) {
      assert.ok(SYNC_TABLE_NAMES.includes(t), `${t} 不是同步表，不必列在不匯出`);
      for (const s of D.EXPORT_SCOPES) assert.ok(!s.tables.includes(t), `${t} 不該出現在 ${s.id}`);
    }
    assert.ok(D.EXPORT_SKIPPED_TABLES.includes("settings"));
  });

  test("各單一範圍的表都收在「整份」裡；除了荷札兩張表，單一範圍之間不重複", () => {
    const seen = new Map<string, string>();
    for (const s of D.EXPORT_SCOPES.filter((x: Any) => x.id !== "all")) {
      for (const t of s.tables) {
        assert.ok(all.tables.includes(t), `${t} 不在整份裡`);
        if (t === "tags" || t === "taggings") continue;
        assert.equal(seen.get(t), undefined, `${t} 同時在 ${seen.get(t)} 與 ${s.id}`);
        seen.set(t, s.id);
      }
    }
    assert.equal(new Set(all.tables).size, all.tables.length, "整份裡有重複的表");
  });
});

/* ═══════════════ 清理規則 ═══════════════ */

function sampleRaw(): Record<string, Row[]> {
  const node = (p: Row): Row => ({
    parent_id: null, line_id: null, route_id: null, description: null, position: 0, sort_key: null, color: null, code: null,
    status: "todo", scheduled_on: null, due_on: null, priority: "mid", estimate_min: null, completed_at: null, repeat_rule: null,
    scheduled_time: null, arrived_on: null, account_id: null, device_id: "dev1", synced_at: "2026-11-01T00:00:00.000Z",
    created_at: local(2026, 11, 1, 9), updated_at: local(2026, 11, 1, 9), deleted_at: null, ...p,
  });
  return {
    nodes: [
      node({ id: "L1", kind: "line", name: "生活" }),
      node({ id: "R1", kind: "route", name: "健身", parent_id: "L1", line_id: "L1", code: "FIT", color: "#ff0000", arrived_on: "2026-10-30" }),
      node({ id: "T1", kind: "train", name: "本週課表", parent_id: "R1", line_id: "L1", route_id: "R1" }),
      node({
        id: "K1", kind: "ticket", name: "深蹲 =3組", parent_id: "T1", line_id: "L1", route_id: "R1", description: "5x5, 加重",
        priority: "high", status: "doing", scheduled_on: "2026-11-05", scheduled_time: "07:30", estimate_min: 45, due_on: "2026-11-07",
        repeat_rule: JSON.stringify({ v: 1, mode: "after", days: 3, start: "2026-11-01", until: null, count: null }),
        created_at: local(2026, 11, 1, 10, 5),
      }),
      node({ id: "K2", kind: "ticket", name: "臨時買水", route_id: "R1", status: "done", completed_at: local(2026, 11, 2, 18, 30) }),
      node({ id: "X1", kind: "ticket", name: "已刪的票", parent_id: "T1", deleted_at: "2026-11-03T00:00:00.000Z" }),
    ],
    work_logs: [
      { id: "W1", node_id: "K1", body: "第一組做完", logged_at: local(2026, 11, 2, 7, 0), event: null, deleted_at: null, device_id: "dev1" },
      { id: "W2", node_id: "K1", body: "", logged_at: local(2026, 11, 1, 10, 5), event: "issued", deleted_at: null },
      { id: "W3", node_id: "K1", body: '{"col":"name"}', logged_at: local(2026, 11, 2, 8, 0), event: "conflict", deleted_at: null },
      { id: "W4", node_id: "K1", body: "已刪的日誌", logged_at: local(2026, 11, 2, 9, 0), event: null, deleted_at: "2026-11-03T00:00:00.000Z" },
      { id: "W5", node_id: "X1", body: "掛在已刪票上", logged_at: local(2026, 11, 2, 9, 0), event: null, deleted_at: null },
    ],
    occurrences: [
      { id: "O1", node_id: "K1", due_on: "2026-11-02", status: "done", deleted_at: null },
      { id: "O2", node_id: "X1", due_on: "2026-11-02", status: "done", deleted_at: null },
    ],
    node_time_overrides: [],
    week_aims: [
      { id: "A1", week_on: "2026-11-02", text: "把深蹲加到 60kg", node_id: "R1", position: 0, done_at: null, deleted_at: null },
      { id: "A2", week_on: "2026-11-02", text: "刪掉的方針", node_id: null, position: 1, done_at: null, deleted_at: "2026-11-03T00:00:00.000Z" },
    ],
    stamps: [],
    tags: [
      { id: "G1", name: "難度/高", name_key: "難度/高", deleted_at: null },
      { id: "G2", name: "居家", name_key: "居家", deleted_at: null },
      { id: "G3", name: "已刪荷札", name_key: "已刪荷札", deleted_at: "2026-11-03T00:00:00.000Z" },
    ],
    taggings: [
      { id: "g1", entity_type: "node", entity_id: "K1", tag_id: "G1", deleted_at: null },
      { id: "g2", entity_type: "node", entity_id: "K1", tag_id: "G2", deleted_at: null },
      { id: "g3", entity_type: "node", entity_id: "K1", tag_id: "G3", deleted_at: null }, // 荷札本身已刪
      { id: "g4", entity_type: "node", entity_id: "K2", tag_id: "G1", deleted_at: "2026-11-03T00:00:00.000Z" }, // 摘掉了
      { id: "g5", entity_type: "node", entity_id: "X1", tag_id: "G1", deleted_at: null }, // 掛在已刪的票上
      { id: "g6", entity_type: "note", entity_id: "N1", tag_id: "G2", deleted_at: null },
      { id: "g7", entity_type: "timetable:block", entity_id: "B1", tag_id: "G2", deleted_at: null },
      { id: "g8", entity_type: "ticket:entry", entity_id: "E1", tag_id: "G1", deleted_at: null },
      { id: "g9", entity_type: "future:thing", entity_id: "Z1", tag_id: "G1", deleted_at: null },
    ],
  };
}

describe("prepareExportTables", () => {
  test("已刪不帶；競合日誌不帶；掛在已刪節點上的乘務記錄與班次不帶", () => {
    const t = D.prepareExportTables("tasks", sampleRaw());
    assert.deepEqual(t.nodes.map((r: Row) => r.id), ["L1", "R1", "T1", "K1", "K2"]);
    assert.deepEqual(t.work_logs.map((r: Row) => r.id), ["W1", "W2"]);
    assert.deepEqual(t.occurrences.map((r: Row) => r.id), ["O1"]);
    assert.deepEqual(t.week_aims.map((r: Row) => r.id), ["A1"]);
    assert.deepEqual(t.tags.map((r: Row) => r.id), ["G1", "G2"]);
  });

  test("快取欄與同步簿記拿掉；根層臨時車票的 route_id（路線標籤）要留", () => {
    const t = D.prepareExportTables("tasks", sampleRaw());
    const byId = Object.fromEntries(t.nodes.map((r: Row) => [r.id, r]));
    for (const r of t.nodes) {
      assert.ok(!("line_id" in r), "line_id 是快取");
      assert.ok(!("synced_at" in r) && !("device_id" in r) && !("account_id" in r), "簿記欄不帶");
    }
    assert.ok(!("route_id" in byId.K1), "有上層的票，route_id 是快取");
    assert.equal(byId.K2.route_id, "R1", "臨時車票的 route_id 是路線標籤，是資料");
    assert.equal(byId.K1.name, "深蹲 =3組");
    assert.ok(!("device_id" in t.work_logs[0]));
  });

  test("荷札：只帶活著的、掛在活東西上的、屬於這個範圍的", () => {
    const tasks = D.prepareExportTables("tasks", sampleRaw());
    assert.deepEqual(tasks.taggings.map((r: Row) => r.id), ["g1", "g2"]);
    const notes = D.prepareExportTables("notes", { ...sampleRaw(), notes: [{ id: "N1", kind: "note", body: "x", noted_at: local(2026, 11, 1), deleted_at: null }] });
    assert.deepEqual(notes.taggings.map((r: Row) => r.id), ["g6"]);
    const all = D.prepareExportTables("all", {
      ...sampleRaw(),
      notes: [{ id: "N1", kind: "note", body: "x", noted_at: local(2026, 11, 1), deleted_at: null }],
      time_blocks: [{ id: "B1", category_id: "C1", started_at: local(2026, 11, 1), deleted_at: null }],
      tk_entries: [{ id: "E1", kind: "expense", deleted_at: null }],
    });
    // 整份：認得的種類看東西還在不在；認不得的種類（以後新增）照樣帶
    assert.deepEqual(all.taggings.map((r: Row) => r.id), ["g1", "g2", "g6", "g7", "g8", "g9"]);
  });

  test("沒有 settings；表的順序照範圍；沒給的表當空", () => {
    const t = D.prepareExportTables("notes", {});
    assert.deepEqual(Object.keys(t), ["notes", "tags", "taggings"]);
    assert.ok(!("settings" in D.prepareExportTables("all", {})));
  });
});

/* ═══════════════ JSON ═══════════════ */

describe("JSON", () => {
  test("{ app, schema, exported_at, scope, tables }；表只含這個範圍；留 id", () => {
    const t = D.prepareExportTables("tasks", sampleRaw());
    const doc = JSON.parse(D.buildJson("tasks", t, META));
    assert.deepEqual(Object.keys(doc), ["app", "schema", "exported_at", "scope", "tables"]);
    assert.equal(doc.app, "next-stop");
    assert.equal(doc.schema, 18);
    assert.equal(doc.exported_at, META.exportedAt);
    assert.equal(doc.scope, "tasks");
    assert.deepEqual(Object.keys(doc.tables), ["nodes", "work_logs", "occurrences", "node_time_overrides", "week_aims", "stamps", "tags", "taggings"]);
    assert.equal(doc.tables.nodes.find((r: Row) => r.id === "K1").name, "深蹲 =3組"); // JSON 不做公式防護，原文照給
    assert.equal(doc.tables.work_logs.length, 2);
    assert.ok(!JSON.stringify(doc).includes("已刪的票"));
    assert.ok(!JSON.stringify(doc).includes("conflict"));
  });

  test("schema 讀不到就是 null", () => {
    const doc = JSON.parse(D.buildJson("notes", {}, { schema: null, exportedAt: META.exportedAt }));
    assert.equal(doc.schema, null);
    assert.deepEqual(doc.tables, { notes: [], tags: [], taggings: [] });
  });
});

/* ═══════════════ CSV：任務 ═══════════════ */

describe("CSV・任務", () => {
  const raw = sampleRaw();
  const tables = D.prepareExportTables("tasks", raw);
  const files = D.buildCsvFiles("tasks", tables, { dayStartHour: 6, nodes: raw.nodes.filter((r) => r.deleted_at == null) });

  test("單一範圍：檔放根目錄；四張表都有", () => {
    assert.deepEqual(files.map((f) => f.path), ["車票.csv", "路線.csv", "乘務記錄.csv", "方針.csv"]);
  });

  test("車票.csv：欄名中文、id 換名稱（幹線、路線、上層）、荷札、狀態、重複", () => {
    const lines = linesOf(textOf(files, "車票.csv"));
    assert.equal(
      lines[0],
      "幹線,路線,上層,車站,種類,名稱,概要,優先順序,狀態,執行日,幾點,長度（分）,締切日,完成時刻,重複,荷札,建立時刻",
    );
    // 列車、車票各一，加臨時車票；已刪的不在
    assert.equal(lines.length, 1 + 3);
    assert.equal(lines[1], "生活,健身,健身,,列車,本週課表,,中,未開始,,,,,,,,2026-11-01 09:00");
    // 名稱中間的 `=` 不是開頭、不補單引號；概要含逗號包引號；荷札兩個，依名稱排序
    assert.equal(
      lines[2],
      `生活,健身,本週課表,,車票,深蹲 =3組,"5x5, 加重",高,進行中,2026-11-05,07:30,45,2026-11-07,,完成後 3 天,居家、難度/高,2026-11-01 10:05`,
    );
    // 臨時車票：沒有上層，路線來自標籤、幹線順路帶出；完成時刻是本地時間
    assert.equal(lines[3], "生活,健身,,,車票,臨時買水,,中,已完成,,,,,2026-11-02 18:30,,,2026-11-01 09:00");
  });

  test("車票.csv 的車站：還在而且同一條路線才印站名（同畫面的 effectiveStation）", () => {
    const station = (id: string, name: string, routeId: string, deleted: string | null = null): Row => ({ ...raw.nodes[0], id, kind: "station", name, parent_id: routeId, route_id: routeId, deleted_at: deleted });
    const csv = (station_id: string) => {
      const nodes = [...raw.nodes.map((n) => (n.id === "K1" ? { ...n, station_id } : n)), station("S1", "第一站", "R1"), station("S2", "別線的站", "R9"), station("S3", "刪掉的站", "R1", "2026-11-03T00:00:00.000Z")];
      const t = D.prepareExportTables("tasks", { ...raw, nodes });
      const f = D.buildCsvFiles("tasks", t, { dayStartHour: 6, nodes: nodes.filter((r) => r.deleted_at == null) });
      return linesOf(textOf(f, "車票.csv")).find((l: string) => l.includes("深蹲"))!.split(",")[3];
    };
    assert.equal(csv("S1"), "第一站");
    assert.equal(csv("S2"), "", "搬到別條路線＝當沒掛");
    assert.equal(csv("S3"), "", "車站被刪＝當沒掛");
  });

  test("路線.csv：幹線與路線都列，到站日、代碼、顏色", () => {
    assert.deepEqual(linesOf(textOf(files, "路線.csv")), ["幹線,路線,代碼,顏色,到站日", "生活,,,,", "生活,健身,FIT,#ff0000,2026-10-30"]);
  });

  test("乘務記錄.csv：車票名稱、時刻、內容；系統事件用事件名；競合日誌與已刪票上的不在", () => {
    assert.deepEqual(linesOf(textOf(files, "乘務記錄.csv")), [
      "車票,時刻,內容",
      "深蹲 =3組,2026-11-01 10:05,発券", // 車票欄是名稱：`=` 在中間不用補
      "深蹲 =3組,2026-11-02 07:00,第一組做完",
    ]);
  });

  test("方針.csv：路線換名稱、済是「是／否」", () => {
    assert.deepEqual(linesOf(textOf(files, "方針.csv")), ["期間,內容,路線,済", "2026-11-02,把深蹲加到 60kg,健身,否"]);
  });
});

/* ═══════════════ CSV：筆記 ═══════════════ */

describe("CSV・筆記", () => {
  const raw = {
    ...sampleRaw(),
    notes: [
      { id: "N1", kind: "note", title: null, body: "=SUM(1,2)\n第二行", entry_date: null, noted_at: local(2026, 11, 3, 21, 15), node_id: "R1", deleted_at: null },
      { id: "N2", kind: "diary", title: "好天氣", body: "去跑步", entry_date: "2026-11-03", noted_at: local(2026, 11, 3, 22, 0), node_id: null, deleted_at: null },
      { id: "N3", kind: "note", title: null, body: "刪掉的", entry_date: null, noted_at: local(2026, 11, 3, 23, 0), node_id: null, deleted_at: "2026-11-04T00:00:00.000Z" },
    ],
  };
  const tables = D.prepareExportTables("notes", raw);
  const files = D.buildCsvFiles("notes", tables, { dayStartHour: 6, nodes: raw.nodes.filter((r) => r.deleted_at == null) });

  test("筆記.csv：公式防護、換行包引號、荷札、掛在換成名稱；已刪不在", () => {
    assert.equal(
      textOf(files, "筆記.csv"),
      '\uFEFF建立時刻,標題,內容,荷札,掛在\r\n2026-11-03 21:15,,"\'=SUM(1,2)\n第二行",居家,健身\r\n',
    );
  });

  test("日記.csv：日期、標題、內容", () => {
    assert.deepEqual(linesOf(textOf(files, "日記.csv")), ["日期,標題,內容,荷札", "2026-11-03,好天氣,去跑步,"]);
  });
});

/* ═══════════════ CSV：時刻表 ═══════════════ */

describe("CSV・時刻表", () => {
  const nodes = sampleRaw().nodes.filter((r) => r.deleted_at == null);
  const raw = {
    time_categories: [
      { id: "C0", parent_id: null, name: "運動", glyph: null, color_idx: 3, position: 0, default_min: null, archived_at: null, created_at: local(2026, 10, 1), deleted_at: null },
      { id: "C1", parent_id: "C0", name: "重訓", glyph: "訓", color_idx: 3, position: 0, default_min: 60, archived_at: null, created_at: local(2026, 10, 1), deleted_at: null },
      { id: "C2", parent_id: "C0", name: "跑步", glyph: "跑", color_idx: 4, position: 1, default_min: null, archived_at: "2026-10-20T00:00:00.000Z", created_at: local(2026, 10, 1), deleted_at: null },
    ],
    time_blocks: [
      // 凌晨 2 點：日界線 6 點 ⇒ 算前一天
      { id: "B1", category_id: "C1", started_at: local(2026, 11, 3, 2, 0), ended_at: local(2026, 11, 3, 3, 30), node_id: "K1", route_id: null, note: "-3 組", deleted_at: null },
      { id: "B2", category_id: "C2", started_at: local(2026, 11, 3, 7, 0), ended_at: local(2026, 11, 3, 7, 25), node_id: null, route_id: "R1", note: null, deleted_at: null },
      { id: "B3", category_id: "C1", started_at: local(2026, 11, 4, 9, 0), ended_at: null, node_id: null, route_id: null, note: null, deleted_at: null },
      { id: "B4", category_id: "C1", started_at: local(2026, 11, 4, 5, 0), ended_at: local(2026, 11, 4, 6, 0), node_id: null, route_id: null, note: null, deleted_at: "2026-11-04T00:00:00.000Z" },
    ],
    time_goals: [
      { id: "GL1", name: "每週運動", scope: JSON.stringify({ categories: ["C0", "C2"] }), period: "week", target_min: 180, direction: "atLeast", start_on: null, end_on: null, position: 0, archived_at: null, deleted_at: null },
    ],
    time_routines: [
      { id: "RT1", name: "平日", items: JSON.stringify({ v: 1, items: [{ cat: "C1", s: "07:00", e: "08:00" }, { cat: "C2", s: "18:00", e: "18:30", n: "慢跑" }] }), weekdays: 0b0011111, position: 0, archived_at: null, deleted_at: null },
    ],
    time_plans: [],
    tags: [{ id: "G2", name: "居家", name_key: "居家", deleted_at: null }],
    taggings: [{ id: "g7", entity_type: "timetable:block", entity_id: "B2", tag_id: "G2", deleted_at: null }],
  };
  const tables = D.prepareExportTables("timetable", raw);
  const files = D.buildCsvFiles("timetable", tables, { dayStartHour: 6, nodes });

  test("時間塊.csv：日期依日界線歸日、分鐘、分類／組、車票或路線名稱、荷札、備註；進行中；已刪不在", () => {
    assert.deepEqual(linesOf(textOf(files, "時間塊.csv")), [
      "日期（日界線）,開始,結束,分鐘,分類,組,車票／路線,荷札,備註",
      "2026-11-02,2026-11-03 02:00,2026-11-03 03:30,90,重訓,運動,深蹲 =3組,,'-3 組",
      "2026-11-03,2026-11-03 07:00,2026-11-03 07:25,25,跑步,運動,健身,居家,",
      "2026-11-04,2026-11-04 09:00,進行中,,重訓,運動,,,",
    ]);
  });

  test("分類.csv：組在前、底下的分類跟著", () => {
    assert.deepEqual(linesOf(textOf(files, "分類.csv")), [
      "組,分類,顏色,預設長度（分）,已封存",
      "運動,,3,,否",
      "運動,重訓,3,60,否",
      "運動,跑步,4,,是",
    ]);
  });

  test("目標.csv、作息範本.csv：id 換成分類名、星期與段落讀得懂", () => {
    assert.deepEqual(linesOf(textOf(files, "目標.csv")), [
      "名稱,範圍,週期,目標（分）,方向,起,迄,荷札,已封存",
      "每週運動,運動、跑步,每週,180,至少,,,,否",
    ]);
    assert.deepEqual(linesOf(textOf(files, "作息範本.csv")), [
      "名稱,自動帶的星期,內容,已封存",
      "平日,一二三四五,07:00–08:00 重訓；18:00–18:30 慢跑,否",
    ]);
  });
});

/* ═══════════════ CSV：售票口 ═══════════════ */

describe("CSV・售票口", () => {
  const nodes = sampleRaw().nodes.filter((r) => r.deleted_at == null);
  const raw = {
    tk_currencies: [
      { id: "U1", code: "TWD", decimals: 2, is_main: 1, deleted_at: null },
      { id: "U2", code: "JPY", decimals: 0, is_main: 0, deleted_at: null },
    ],
    tk_accounts: [
      { id: "A1", name: "錢包", group_key: "cash", currency: "TWD", position: 0, archived_at: null, deleted_at: null },
      { id: "A2", name: "玉山帳戶", group_key: "bank", currency: "TWD", position: 0, archived_at: null, deleted_at: null },
      { id: "A3", name: "日圓現金", group_key: "cash", currency: "JPY", position: 1, archived_at: "2026-10-01T00:00:00.000Z", deleted_at: null },
    ],
    tk_categories: [
      { id: "CE", kind: "expense", name: "🍱 飲食", parent_id: null, position: 0, archived_at: null, deleted_at: null },
      { id: "CE1", kind: "expense", name: "午餐", parent_id: "CE", position: 0, archived_at: null, deleted_at: null },
      { id: "CI", kind: "income", name: "薪水", parent_id: null, position: 0, archived_at: null, deleted_at: null },
    ],
    tk_entries: [
      { id: "E1", kind: "expense", occurred_on: "2026-11-03", occurred_at: local(2026, 11, 3, 12, 30), account_id: "A1", to_account_id: null, category_id: "CE1", amount_minor: 12050, currency: "TWD", note: "=便當", route_id: "R1", deleted_at: null },
      { id: "E2", kind: "expense", occurred_on: "2026-11-03", occurred_at: local(2026, 11, 3, 13, 0), account_id: "A1", to_account_id: null, category_id: "CE1", amount_minor: -5000, currency: "TWD", note: "退款", route_id: null, deleted_at: null },
      { id: "E3", kind: "transfer", occurred_on: "2026-11-02", occurred_at: local(2026, 11, 2, 9, 0), account_id: "A2", to_account_id: "A1", category_id: null, amount_minor: 300000, currency: "TWD", note: "", route_id: null, deleted_at: null },
      { id: "E4", kind: "expense", occurred_on: "2026-11-04", occurred_at: local(2026, 11, 4, 9, 0), account_id: "A3", to_account_id: null, category_id: "CE", amount_minor: 1200, currency: "JPY", note: "", route_id: null, deleted_at: null },
      { id: "E5", kind: "expense", occurred_on: "2026-11-04", occurred_at: local(2026, 11, 4, 10, 0), account_id: "A1", to_account_id: null, category_id: "CE", amount_minor: 99, currency: "TWD", note: "已刪", route_id: null, deleted_at: "2026-11-04T00:00:00.000Z" },
      // 跨幣別轉帳（問題 14）：轉出 TWD（小數兩位）、轉入 JPY（小數 0 位）
      { id: "E6", kind: "transfer", occurred_on: "2026-11-05", occurred_at: local(2026, 11, 5, 9, 0), account_id: "A1", to_account_id: "A3", category_id: null, amount_minor: 100000, to_amount_minor: 4800, currency: "TWD", note: "換匯", route_id: null, deleted_at: null },
    ],
    tk_budgets: [
      { id: "BU1", kind: "total", category_id: null, month: null, amount_minor: 3000000, position: 0, deleted_at: null },
      { id: "BU2", kind: "category", category_id: "CE", month: "2026-11", amount_minor: 800000, position: 1, deleted_at: null },
    ],
    tk_repeats: [
      { id: "RP1", kind: "expense", account_id: "A2", to_account_id: null, category_id: "CE", amount_minor: 1500000, currency: "TWD", note: "房租", route_id: null, rule: JSON.stringify({ v: 1, mode: "fixed", freq: "monthly", interval: 1, byweekday: null, bymonthday: [5], start: "2026-01-05", until: null, count: null }), hhmm: "09:00", next_on: "2026-12-05", paused_at: null, position: 0, deleted_at: null },
    ],
    wr_kinds: [{ id: "WK1", name: "買", action: "entry", position: 0, deleted_at: null }],
    tk_wishes: [{ id: "WS1", name: "降噪耳機", amount_minor: 800000, note: "", category_id: null, position: 0, entry_id: null, bought_at: null, kind_id: "WK1", target_kind: null, target_id: null, deleted_at: null }],
    tk_templates: [{ id: "TP1", name: "午餐", kind: "expense", amount_minor: 15000, currency: null, account_id: "A1", to_account_id: null, category_id: "CE1", note: "", route_id: null, position: 0, deleted_at: null }],
    tags: [{ id: "G1", name: "難度/高", name_key: "難度/高", deleted_at: null }],
    taggings: [{ id: "g8", entity_type: "ticket:entry", entity_id: "E1", tag_id: "G1", deleted_at: null }],
  };
  const tables = D.prepareExportTables("ticket", raw);
  const files = D.buildCsvFiles("ticket", tables, { dayStartHour: 6, nodes });
  const text = textOf(files, "帳目.csv");

  test("帳目.csv：id 換名稱、金額依幣別小數位、轉帳有轉入帳戶、已刪不在、依日期排", () => {
    assert.deepEqual(linesOf(text), [
      "日期,類型,金額,幣別,帳戶,轉入帳戶,轉入金額,分類,上層分類,備註,荷札,路線",
      "2026-11-02,轉帳,3000,TWD,玉山帳戶,錢包,,,,,,",
      "2026-11-03,支出,120.5,TWD,錢包,,,午餐,🍱 飲食,'=便當,難度/高,健身",
      "2026-11-03,支出,-50,TWD,錢包,,,午餐,🍱 飲食,退款,,",
      "2026-11-04,支出,1200,JPY,日圓現金,,,🍱 飲食,,,,",
      "2026-11-05,轉帳,1000,TWD,錢包,日圓現金,4800,,,換匯,,",
    ]);
  });

  test("負數金額：沒加引號、沒加單引號", () => {
    assert.ok(text.includes(",支出,-50,TWD,"), "負數要原樣");
    assert.ok(!text.includes('"-50"') && !text.includes("'-50"));
  });

  test("帳戶、分類、定期帳、預算、願望、常用票種", () => {
    assert.deepEqual(linesOf(textOf(files, "帳戶.csv")), ["名稱,群組,幣別,已封存", "錢包,現金,TWD,否", "日圓現金,現金,JPY,是", "玉山帳戶,帳戶,TWD,否"]);
    assert.deepEqual(linesOf(textOf(files, "分類.csv")), [
      "種類,分類,上層分類,已封存",
      "支出,🍱 飲食,,否",
      "支出,午餐,🍱 飲食,否",
      "收入,薪水,,否",
    ]);
    assert.deepEqual(linesOf(textOf(files, "定期帳.csv")), [
      "類型,金額,幣別,帳戶,轉入帳戶,分類,上層分類,備註,重複,時刻,下一班,已暫停,路線",
      "支出,15000,TWD,玉山帳戶,,🍱 飲食,,房租,每月 5 號,09:00,2026-12-05,否,",
    ]);
    assert.deepEqual(linesOf(textOf(files, "預算.csv")), [
      "種類,分類,上層分類,月份,金額",
      "分類預算,🍱 飲食,,2026-11,8000",
      "總預算,,,每月預設,30000",
    ]);
    assert.deepEqual(linesOf(textOf(files, "願望.csv")), ["名稱,種類,預估金額,分類,備註,實現時刻", "降噪耳機,買,8000,,,"]);
    assert.deepEqual(linesOf(textOf(files, "常用票種.csv")), [
      "名稱,類型,金額,幣別,帳戶,轉入帳戶,分類,上層分類,備註,路線",
      "午餐,支出,150,TWD,錢包,,午餐,🍱 飲食,,",
    ]);
  });
});

/* ═══════════════ 整份・zip・檔名 ═══════════════ */

describe("整份與 zip", () => {
  const raw = sampleRaw();
  const input = { tables: raw, nodes: raw.nodes.filter((r) => r.deleted_at == null), dayStartHour: 6 };

  test("整份 CSV：任務／筆記／時刻表／售票口四個子資料夾", () => {
    const tables = D.prepareExportTables("all", raw);
    const files = D.buildCsvFiles("all", tables, { dayStartHour: 6, nodes: input.nodes });
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes("任務/車票.csv") && paths.includes("筆記/筆記.csv") && paths.includes("時刻表/時間塊.csv") && paths.includes("售票口/帳目.csv"));
    assert.ok(paths.every((p) => /^(任務|筆記|時刻表|售票口)\/[^/]+\.csv$/.test(p)), paths.join("、"));
    // 空表也有檔，且只有欄名那一列
    assert.deepEqual(linesOf(textOf(files, "售票口/帳目.csv")), ["日期,類型,金額,幣別,帳戶,轉入帳戶,轉入金額,分類,上層分類,備註,荷札,路線"]);
  });

  test("buildExportPayload：JSON 是一個檔、CSV 是 zip；回報各表列數", () => {
    const j = D.buildExportPayload("tasks", "json", input, META);
    assert.equal(j.fileCount, 1);
    assert.equal(j.counts.nodes, 5);
    assert.equal(j.counts.work_logs, 2);
    assert.equal(JSON.parse(new TextDecoder().decode(j.bytes)).scope, "tasks");

    const c = D.buildExportPayload("all", "csv", input, META);
    assert.equal(c.fileCount, 4 + 2 + 4 + 8); // 售票口多「候車室種類.csv」（壬 0019）
    assert.deepEqual([...c.bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], "zip 的開頭");
  });

  test("整份 CSV 的 zip 用系統 tar 解得開，中文檔名與內容都在", () => {
    const c = D.buildExportPayload("all", "csv", input, META);
    const work = mkdtempSync(path.join(tmpdir(), "ns-export-"));
    try {
      const zipPath = path.join(work, "x.zip");
      writeFileSync(zipPath, c.bytes);
      const out = path.join(work, "out");
      mkdirSync(out);
      const r = spawnSync(TAR, ["-xf", zipPath, "-C", out], { encoding: "utf8" });
      assert.equal(r.status, 0, `tar 解壓失敗：${r.stderr || r.error}`);
      const walk = (dir: string, base = dir): string[] =>
        readdirSync(dir).flatMap((n) => {
          const f = path.join(dir, n);
          return statSync(f).isDirectory() ? walk(f, base) : [path.relative(base, f).split(path.sep).join("/")];
        });
      const got = walk(out).sort();
      assert.ok(got.includes("任務/車票.csv") && got.includes("售票口/常用票種.csv"), got.join("、"));
      assert.equal(got.length, c.fileCount);
      const ticketCsv = readFileSync(path.join(out, "任務", "車票.csv"));
      assert.deepEqual([...ticketCsv.subarray(0, 3)], [0xef, 0xbb, 0xbf], "解出來的 CSV 仍是 BOM 開頭");
      assert.ok(ticketCsv.toString("utf8").includes("深蹲"));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("預設檔名：私鐵手帳-<範圍>-<YYYYMMDD>.json｜zip", () => {
    const now = new Date(2026, 10, 4, 12, 0);
    assert.equal(D.exportFileName("all", "json", now), "私鐵手帳-整份-20261104.json");
    assert.equal(D.exportFileName("ticket", "csv", now), "私鐵手帳-售票口-20261104.zip");
    assert.equal(D.exportFileName("timetable", "csv", new Date(2026, 0, 5)), "私鐵手帳-時刻表-20260105.zip");
  });

  test("bytesToBase64 與 Buffer 的結果一致（含超過一個分塊的大檔）", () => {
    const big = new Uint8Array(100_003);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
    assert.equal(D.bytesToBase64(big), Buffer.from(big).toString("base64"));
    assert.equal(D.bytesToBase64(new Uint8Array(0)), "");
    assert.equal(D.bytesToBase64(new TextEncoder().encode("你好")), Buffer.from("你好").toString("base64"));
  });
});

/* ═══════════════ 讀資料庫（node:sqlite＋全部 migration） ═══════════════ */

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  const dir = path.join(ROOT, "src-tauri/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(path.join(dir, f), "utf8"));
  raw.exec("PRAGMA foreign_keys = OFF");
  const bind = (args: unknown[] = []) => Object.fromEntries(args.map((v, i) => ["$" + (i + 1), v])) as Record<string, never>;
  return {
    raw,
    async select(sql: string, args?: unknown[]) {
      return raw.prepare(sql).all(bind(args)).map((r) => ({ ...r }));
    },
  };
}

describe("readExportRows（SQLite）", () => {
  test("只讀活著的列；競合日誌、已刪節點上的乘務記錄不讀；範圍之外的表不讀", async () => {
    const db = makeDb();
    (globalThis as Any).__exDb = db;
    const DEL = "2026-11-03T00:00:00.000Z";
    db.raw.exec(`
      INSERT INTO nodes (id, kind, name) VALUES ('L1','line','生活'), ('R1','route','健身'), ('K1','ticket','活票');
      INSERT INTO nodes (id, kind, name, deleted_at) VALUES ('K2','ticket','死票','${DEL}');
      INSERT INTO work_logs (id, node_id, body, logged_at, event) VALUES
        ('W1','K1','手記','2026-11-02T00:00:00.000Z',NULL),
        ('W2','K1','','2026-11-02T01:00:00.000Z','issued'),
        ('W3','K1','{"x":1}','2026-11-02T02:00:00.000Z','conflict'),
        ('W5','K2','死票上的','2026-11-02T03:00:00.000Z',NULL);
      INSERT INTO work_logs (id, node_id, body, logged_at, deleted_at) VALUES ('W4','K1','刪掉的','2026-11-02T04:00:00.000Z','${DEL}');
      INSERT INTO occurrences (id, node_id, due_on, status) VALUES ('O1','K1','2026-11-02','done'), ('O2','K2','2026-11-02','done');
      INSERT INTO notes (id, kind, body, noted_at) VALUES ('N1','note','活筆記','2026-11-02T00:00:00.000Z');
      INSERT INTO notes (id, kind, body, noted_at, deleted_at) VALUES ('N2','note','死筆記','2026-11-02T00:00:00.000Z','${DEL}');
      INSERT INTO settings (key, value) VALUES ('day_start_hour','4');
    `);

    const tasks = await readExportRows("tasks");
    assert.deepEqual(tasks.tables.nodes.map((r: Row) => r.id).sort(), ["K1", "L1", "R1"]);
    assert.deepEqual(tasks.tables.work_logs.map((r: Row) => r.id).sort(), ["W1", "W2"]);
    assert.deepEqual(tasks.tables.occurrences.map((r: Row) => r.id), ["O1"]);
    assert.ok(!("notes" in tasks.tables) && !("settings" in tasks.tables));
    assert.equal(tasks.dayStartHour, 4);
    assert.equal(tasks.nodes.length, 3);

    // 筆記範圍不匯出 nodes 這張表，但仍要有節點名單給 CSV 換名稱
    const notes = await readExportRows("notes");
    assert.deepEqual(notes.tables.notes.map((r: Row) => r.id), ["N1"]);
    assert.ok(!("nodes" in notes.tables));
    assert.deepEqual(notes.nodes.map((r: Row) => r.id).sort(), ["K1", "L1", "R1"]);

    // 讀完的資料餵進 payload：沒有死資料、沒有競合日誌
    const all = await readExportRows("all");
    const payload = D.buildExportPayload("all", "json", all, { schema: all.schema, exportedAt: META.exportedAt });
    const text = new TextDecoder().decode(payload.bytes);
    for (const bad of ["死票", "死筆記", "刪掉的", "conflict"]) assert.ok(!text.includes(bad), `不該出現：${bad}`);
    assert.ok(text.includes("活筆記") && text.includes("手記"));
    assert.deepEqual(Object.keys(JSON.parse(text).tables), [...D.tablesOfScope("all")]);
  });

  test("沒設日界線＝預設；沒有 _sqlx_migrations（測試庫）＝schema null", async () => {
    (globalThis as Any).__exDb = makeDb();
    const r = await readExportRows("notes");
    assert.equal(r.dayStartHour, 6);
    assert.equal(r.schema, null);
  });
});

describe("方針.csv 的期間（辛）", () => {
  test("週留日期；月、年、站寫人看得懂的字，不露期間鍵", async () => {
    const { periodLabel } = await import("../../src/domain/weekAims.ts");
    assert.equal(periodLabel("M2026-11"), "2026 年 11 月");
    assert.equal(periodLabel("Y2026"), "2026 年");
    assert.equal(periodLabel("Sabc", "考過 N5"), "車站 考過 N5");
    assert.equal(periodLabel("Sabc"), "車站");
    assert.equal(periodLabel("2026-11-02"), "11/2 那週");
  });
});
