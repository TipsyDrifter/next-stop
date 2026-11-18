/**
 * `notesFilter.ts` 單測（v1.32 2B-2：旅客筆記與收件匣排序切換 ＋ `#荷札` 組合篩選）。
 * 執行：`node --test "src/domain/notesFilter.test.ts"`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, type TagIndexSource } from "./tags.ts";
import {
  buildInboxItems,
  collectAvailableTags,
  matchEntityTags,
  matchingEntityIdsByTags,
  noteTimestampOf,
  sortNoteItems,
} from "./notesFilter.ts";

const SAMPLE_SOURCE: TagIndexSource = {
  tags: [
    { id: "t-jp", name: "讀書/日文", key: "讀書/日文" },
    { id: "t-en", name: "讀書/英文", key: "讀書/英文" },
    { id: "t-hard", name: "難度/高", key: "難度/高" },
    { id: "t-errand", name: "採買", key: "採買" },
    { id: "t-diary", name: "心情", key: "心情" },
  ],
  taggings: [
    { tagId: "t-jp", entityType: "note", entityId: "n1" },
    { tagId: "t-hard", entityType: "note", entityId: "n1" },
    { tagId: "t-en", entityType: "note", entityId: "n2" },
    { tagId: "t-jp", entityType: "note", entityId: "in-n1" },
    { tagId: "t-errand", entityType: "node", entityId: "in-tk1" },
    { tagId: "t-hard", entityType: "node", entityId: "in-tk1" },
    { tagId: "t-diary", entityType: "note", entityId: "d1" },
  ],
  kinds: {
    n1: "note",
    n2: "note",
    "in-n1": "note",
    "in-tk1": "ticket",
    d1: "diary",
  },
};

test("matchEntityTags：支援 AND 交集與父荷札含子荷札（isUnder）", () => {
  assert.equal(matchEntityTags([], []), true);
  assert.equal(matchEntityTags([], ["讀書"]), false);
  // 父荷札「讀書」命中子荷札「讀書/日文」
  assert.equal(matchEntityTags(["讀書/日文", "難度/高"], ["讀書"]), true);
  // 多選 AND 交集：同時滿足「讀書」與「難度/高」
  assert.equal(matchEntityTags(["讀書/日文", "難度/高"], ["#讀書", "難度/高"]), true);
  // 缺其中一枚則不通過
  assert.equal(matchEntityTags(["讀書/英文"], ["讀書", "難度/高"]), false);
});

test("matchingEntityIdsByTags：依實體種類與排除 diary 篩出正確筆記 id", () => {
  const index = buildIndex(SAMPLE_SOURCE);
  const byParent = matchingEntityIdsByTags(index.ents, ["notes:note"], ["讀書"], {
    excludeKinds: ["diary"],
  });
  assert.deepEqual([...byParent].sort(), ["in-n1", "n1", "n2"]);

  const combo = matchingEntityIdsByTags(index.ents, ["note"], ["讀書", "難度"], {
    excludeKinds: ["diary"],
  });
  assert.deepEqual([...combo], ["n1"]);

  // d1 是日記，excludeKinds 排除後不應命中
  const diaryTag = matchingEntityIdsByTags(index.ents, ["note"], ["心情"], {
    excludeKinds: ["diary"],
  });
  assert.equal(diaryTag.size, 0);
});

test("sortNoteItems ＆ noteTimestampOf：支援『最近修改』與『建立時間』切換", () => {
  const notes = [
    {
      id: "a",
      noted_at: "2026-10-01T08:00:00.000Z",
      created_at: "2026-10-01T08:00:00.000Z",
      updated_at: "2026-11-15T10:00:00.000Z", // 最舊建立、最新修改
    },
    {
      id: "b",
      noted_at: "2026-11-10T09:00:00.000Z",
      created_at: "2026-11-10T09:00:00.000Z",
      updated_at: "2026-11-10T09:00:00.000Z",
    },
    {
      id: "c",
      noted_at: "2026-11-05T12:00:00.000Z",
      created_at: "2026-11-05T12:00:00.000Z",
      updated_at: "2026-11-12T15:00:00.000Z",
    },
  ];

  const byCreated = sortNoteItems(notes, "created");
  assert.deepEqual(byCreated.map((n) => n.id), ["b", "c", "a"]);
  assert.equal(noteTimestampOf(notes[0], "created"), "2026-10-01T08:00:00.000Z");

  const byUpdated = sortNoteItems(notes, "updated");
  assert.deepEqual(byUpdated.map((n) => n.id), ["a", "c", "b"]);
  assert.equal(noteTimestampOf(notes[0], "updated"), "2026-11-15T10:00:00.000Z");
});

test("buildInboxItems：同時涵蓋未整理筆記與臨時車票的種類、排序切換與 #荷札 組合篩選", () => {
  const index = buildIndex(SAMPLE_SOURCE);
  const inboxNotes = [
    {
      id: "in-n1",
      noted_at: "2026-11-10T08:00:00.000Z",
      created_at: "2026-11-10T08:00:00.000Z",
      updated_at: "2026-11-15T12:00:00.000Z", // 最近剛修改過
    },
    {
      id: "in-n2",
      noted_at: "2026-11-12T08:00:00.000Z",
      created_at: "2026-11-12T08:00:00.000Z",
      updated_at: "2026-11-12T08:00:00.000Z",
    },
  ];
  const inboxTickets = [
    {
      id: "in-tk1",
      created_at: "2026-11-14T09:00:00.000Z", // 建立最新
      updated_at: "2026-11-14T09:00:00.000Z",
    },
  ];

  // 1) 建立時間排序：in-tk1 (11/14) → in-n2 (11/12) → in-n1 (11/10)
  const createdAll = buildInboxItems({
    notes: inboxNotes,
    tickets: inboxTickets,
    kind: "all",
    sort: "created",
    tagKeys: [],
    tagEnts: index.ents,
  });
  assert.deepEqual(createdAll.map((x) => x.id), ["in-tk1", "in-n2", "in-n1"]);

  // 2) 最近修改排序：in-n1 (11/15) → in-tk1 (11/14) → in-n2 (11/12)
  const updatedAll = buildInboxItems({
    notes: inboxNotes,
    tickets: inboxTickets,
    kind: "all",
    sort: "updated",
    tagKeys: [],
    tagEnts: index.ents,
  });
  assert.deepEqual(updatedAll.map((x) => x.id), ["in-n1", "in-tk1", "in-n2"]);

  // 3) #荷札 篩選：選父荷札「讀書」命中筆記 in-n1；選「採買」＋「難度」組合命中臨時車票 in-tk1
  const byRead = buildInboxItems({
    notes: inboxNotes,
    tickets: inboxTickets,
    kind: "all",
    sort: "updated",
    tagKeys: ["讀書"],
    tagEnts: index.ents,
  });
  assert.deepEqual(byRead.map((x) => `${x.kind}:${x.id}`), ["note:in-n1"]);

  const byErrandHard = buildInboxItems({
    notes: inboxNotes,
    tickets: inboxTickets,
    kind: "all",
    sort: "updated",
    tagKeys: ["採買", "難度"],
    tagEnts: index.ents,
  });
  assert.deepEqual(byErrandHard.map((x) => `${x.kind}:${x.id}`), ["ticket:in-tk1"]);

  // 4) 疊加種類篩選（只看筆記 ＋ #採買 ⇒ 空）
  const kindMismatch = buildInboxItems({
    notes: inboxNotes,
    tickets: inboxTickets,
    kind: "note",
    sort: "updated",
    tagKeys: ["採買"],
    tagEnts: index.ents,
  });
  assert.equal(kindMismatch.length, 0);
});

test("collectAvailableTags：彙整範圍內荷札並正確去重計算父層數量與保留已選項目", () => {
  const index = buildIndex(SAMPLE_SOURCE);
  // 筆記頁（排除日記，只看 n1, n2）
  const noteTags = collectAvailableTags(index, {
    entityTypes: ["note"],
    allowedIds: new Set(["n1", "n2"]),
    excludeKinds: ["diary"],
    selectedKeys: ["已移除荷札"],
  });
  const byKey = Object.fromEntries(noteTags.map((t) => [t.key, t.count]));
  // 讀書 涵蓋 n1 (讀書/日文) 與 n2 (讀書/英文) ⇒ 2
  assert.equal(byKey["讀書"], 2);
  assert.equal(byKey["讀書/日文"], 1);
  assert.equal(byKey["讀書/英文"], 1);
  assert.equal(byKey["難度"], 1);
  assert.equal(byKey["難度/高"], 1);
  // 採買只在車票上、心情只在日記上 ⇒ 不出現
  assert.equal(byKey["採買"], undefined);
  assert.equal(byKey["心情"], undefined);
  // 已選但計數為 0 的荷札仍保留供取消
  assert.equal(byKey["已移除荷札"], 0);
});
