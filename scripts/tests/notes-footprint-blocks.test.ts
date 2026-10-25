// 旅客筆記・日記足跡接時間塊的純函式（日記足跡班契約 §2.1、§5-1）
// 跑法：node --test scripts/tests/notes-footprint-blocks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockCatTotals,
  blockMs,
  blocksTotalMs,
  footprintAxisRange,
  footprintSummary,
  mapSegment,
  nodeMsOf,
  type FootprintBlock,
  type FootprintDay,
  type FootprintSegmentSrc,
} from "../../src/domain/notes.ts";
import { linkDeletedText, linkLabelOf, LINK_MISSING_TEXT, type LinkInfo } from "../../src/domain/timetableLink.ts";

const H = 3600_000;
const T0 = Date.parse("2026-10-25T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const seg = (o: Partial<FootprintSegmentSrc>): FootprintSegmentSrc => ({
  blockId: "b1",
  categoryId: "c-read",
  categoryName: "讀書",
  glyph: "読",
  colorIdx: 3,
  nodeId: null,
  from: iso(T0),
  to: iso(T0 + H),
  running: false,
  contFromPrev: false,
  contToNext: false,
  ...o,
});
const blk = (from: number, to: number, nodeId: string | null = null, o: Partial<FootprintSegmentSrc> = {}): FootprintBlock =>
  mapSegment(seg({ from: iso(from), to: iso(to), nodeId, ...o }), null);

test("mapSegment：沒連結＝分類名當主名、link null", () => {
  const b = mapSegment(seg({}), null);
  assert.equal(b.id, "b1");
  assert.equal(b.label, "讀書");
  assert.equal(b.catName, "讀書");
  assert.equal(b.link, null);
  assert.equal(b.glyph, "読");
  assert.equal(b.colorIdx, 3);
});

test("mapSegment：有連結＝連結名當主名、分類名保留", () => {
  const b = mapSegment(seg({ nodeId: "n1" }), "期中報告初稿");
  assert.equal(b.label, "期中報告初稿");
  assert.equal(b.catName, "讀書");
  assert.equal(b.link, "期中報告初稿");
  assert.equal(b.nodeId, "n1");
});

test("mapSegment：分類已刪（時刻表填「？」）、跨日旗標與運行中照抄", () => {
  const b = mapSegment(seg({ categoryName: "？", glyph: null, running: true, contFromPrev: true, contToNext: true }), null);
  assert.equal(b.label, "？");
  assert.equal(b.glyph, null);
  assert.equal(b.running, true);
  assert.equal(b.contFromPrev, true);
  assert.equal(b.contToNext, true);
});

test("連結字樣跟時刻表同一套：車票已刪／查不到／路線已刪", () => {
  const info = (o: Partial<LinkInfo>): LinkInfo => ({
    id: "x",
    kind: "ticket",
    kindLabel: "車票",
    name: "期中報告初稿",
    routeId: null,
    estimateMin: null,
    code: null,
    deleted: false,
    missing: false,
    ...o,
  });
  assert.equal(linkLabelOf({ node_id: "x", route_id: null }, { x: info({}) }), "期中報告初稿");
  assert.equal(linkLabelOf({ node_id: "x", route_id: null }, { x: info({ deleted: true }) }), linkDeletedText("車票"));
  assert.equal(linkLabelOf({ node_id: "x", route_id: null }, { x: info({ missing: true }) }), LINK_MISSING_TEXT);
  assert.equal(linkLabelOf({ node_id: null, route_id: "x" }, { x: info({ kind: "route", deleted: true }) }), linkDeletedText("路線"));
  assert.equal(linkLabelOf({ node_id: null, route_id: null }, {}), null);
});

test("blockMs：倒置或相等＝0", () => {
  assert.equal(blockMs({ from: iso(T0), to: iso(T0 + 90 * 60_000) }), 90 * 60_000);
  assert.equal(blockMs({ from: iso(T0 + H), to: iso(T0) }), 0);
  assert.equal(blockMs({ from: iso(T0), to: iso(T0) }), 0);
});

test("blocksTotalMs：null／空＝0；多塊相加", () => {
  assert.equal(blocksTotalMs(null), 0);
  assert.equal(blocksTotalMs([]), 0);
  assert.equal(blocksTotalMs([blk(T0, T0 + H), blk(T0 + 2 * H, T0 + 2.5 * H)]), 1.5 * H);
});

test("nodeMsOf：只加掛在那張票上的塊", () => {
  const bs = [blk(T0, T0 + H, "n1"), blk(T0 + H, T0 + 1.5 * H, "n2"), blk(T0 + 2 * H, T0 + 2.25 * H, "n1")];
  assert.equal(nodeMsOf(bs, "n1"), 1.25 * H);
  assert.equal(nodeMsOf(bs, "n3"), 0);
  assert.equal(nodeMsOf(null, "n1"), 0);
});

test("blockCatTotals：同分類相加、多的在前、運行中帶旗標", () => {
  const bs = [
    blk(T0, T0 + H),
    blk(T0 + H, T0 + 3 * H, null, { categoryId: "c-work", categoryName: "工作" }),
    blk(T0 + 3 * H, T0 + 3.5 * H, null, { running: true }),
  ];
  const t = blockCatTotals(bs);
  assert.deepEqual(
    t.map((c) => [c.catId, c.catName, c.ms, c.running]),
    [
      ["c-work", "工作", 2 * H, false],
      ["c-read", "讀書", 1.5 * H, true],
    ],
  );
  assert.deepEqual(blockCatTotals(null), []);
});

test("footprintAxisRange：預設 06–24；事件超出才往外擴到整點；不出日界線窗", () => {
  const Z = T0; // 當地 00:00（測試直接用一個基準 ms，函式只做相對運算）
  const win = { s: Z + 3 * H, e: Z + 27 * H }; // 日界線 03:00
  assert.deepEqual(footprintAxisRange([Z + 9 * H, Z + 12 * H], Z, win.s, win.e), { from: Z + 6 * H, to: Z + 24 * H });
  assert.deepEqual(footprintAxisRange([Z + 4.5 * H, Z + 25.2 * H], Z, win.s, win.e), { from: Z + 4 * H, to: Z + 26 * H });
  assert.deepEqual(footprintAxisRange([Z + 3 * H, Z + 27 * H], Z, win.s, win.e), { from: Z + 3 * H, to: Z + 27 * H });
  // 日界線 06:00、事件全在白天 ⇒ 06–24
  assert.deepEqual(footprintAxisRange([Z + 10 * H], Z, Z + 6 * H, Z + 30 * H), { from: Z + 6 * H, to: Z + 24 * H });
  assert.equal(footprintAxisRange([], Z, win.s, win.e), null);
});

test("footprintSummary：有時間塊就接在最後；只有時間塊也不寫「沒有足跡」", () => {
  const fd = (o: Partial<FootprintDay>): FootprintDay => ({ day: "2026-10-25", seals: [], logs: [], moods: [], blocks: null, ...o });
  const seal = { id: "s", nodeId: "n", name: "x", kind: "ticket" as const, routeId: null, at: iso(T0), mood: null, dueOn: null };
  assert.equal(footprintSummary(fd({ seals: [seal] }), "記錄 1h"), "1 枚済章・記錄 1h");
  assert.equal(footprintSummary(fd({ blocks: [blk(T0, T0 + H)] }), "記錄 1h"), "記錄 1h");
  assert.equal(footprintSummary(fd({}), ""), "沒有足跡");
});
