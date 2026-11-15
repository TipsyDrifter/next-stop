/**
 * 車窓・理想手札與「車窓の問い」領域規則與記憶體儲存庫測試（第六本第四梯 v1.30；D-主-560～564）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  IDEAL_ART_PRESETS,
  IDEAL_THEMES,
  MAX_IDEAL_PHOTO_CHARS,
  WINDOW_PROMPTS,
  customPromptKey,
  formatPastPromptCue,
  formatReflectionDiaryBody,
  groupReflectionsByPrompt,
  pastReflectionsForPrompt,
  pickDailyPrompt,
  resolvePinnedMotto,
  validatePhotoDataUrl,
  type IdealCardRow,
  type IdealReflectionRow,
} from "../../src/domain/idealTecho.ts";
import { MemoryIdealRepository } from "../../src/data/memoryIdealRepository.ts";

describe("車窓の問い：每日出題與換一題", () => {
  test("題庫涵蓋四大類且每題 key 唯一", () => {
    assert.equal(IDEAL_THEMES.length, 3);
    assert.equal(IDEAL_ART_PRESETS.length, 12);
    assert.equal(WINDOW_PROMPTS.length, 28);
    const keys = new Set(WINDOW_PROMPTS.map((p) => p.key));
    assert.equal(keys.size, WINDOW_PROMPTS.length);
  });

  test("同一天跨裝置決定性出同一題；換一題 28 次走遍全題庫不連撞", () => {
    const a = pickDailyPrompt("2026-11-15", 0);
    const b = pickDailyPrompt("2026-11-15", 0);
    assert.deepEqual(a, b);

    const visited = new Set<string>();
    for (let i = 0; i < WINDOW_PROMPTS.length; i++) {
      visited.add(pickDailyPrompt("2026-11-15", i).key);
    }
    assert.equal(visited.size, WINDOW_PROMPTS.length, "28 次換一題應完整走遍 28 題");
  });

  test("自訂題目 key 正規化空白、大小寫與全半形問號", () => {
    assert.equal(
      customPromptKey("  三年後的自己  過得好嗎? "),
      customPromptKey("三年後的自己 過得好嗎？"),
    );
  });
});

describe("跨時空並排回顧與過去作答提示", () => {
  const rows: IdealReflectionRow[] = [
    {
      id: "r-2025",
      prompt_key: "daily.good-day",
      category: "daily",
      question: "怎樣的一天會讓你覺得今天真好？",
      answer: "把功課寫完、晚上看兩集動畫。",
      answered_on: "2025-11-10",
      diary_note_id: null,
      pinned: 0,
      created_at: "2025-11-10T14:00:00.000Z",
      updated_at: "2025-11-10T14:00:00.000Z",
      deleted_at: null,
    },
    {
      id: "r-2026",
      prompt_key: "daily.good-day",
      category: "daily",
      question: "怎樣的一天會讓你覺得今天真好？",
      answer: "午後泡杯熱茶寫手帳，不慌不忙推進喜歡的作品。",
      answered_on: "2026-11-15",
      diary_note_id: "note-1",
      pinned: 0,
      created_at: "2026-11-15T09:00:00.000Z",
      updated_at: "2026-11-15T09:00:00.000Z",
      deleted_at: null,
    },
    {
      id: "r-single",
      prompt_key: "self.safe-harbor",
      category: "self",
      question: "什麼環境最能讓你安定下來？",
      answer: "雨聲與微暗檯燈。",
      answered_on: "2026-11-12",
      diary_note_id: null,
      pinned: 0,
      created_at: "2026-11-12T20:00:00.000Z",
      updated_at: "2026-11-12T20:00:00.000Z",
      deleted_at: null,
    },
    {
      id: "r-deleted",
      prompt_key: "self.safe-harbor",
      category: "self",
      question: "什麼環境最能讓你安定下來？",
      answer: "已刪除",
      answered_on: "2026-11-14",
      diary_note_id: null,
      pinned: 0,
      created_at: "2026-11-14T20:00:00.000Z",
      updated_at: "2026-11-14T20:00:00.000Z",
      deleted_at: "2026-11-14T21:00:00.000Z",
    },
  ];

  test("groupReflectionsByPrompt：組間依最新作答降序、組內依作答日期升序（舊→新並排）", () => {
    const groups = groupReflectionsByPrompt(rows);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].promptKey, "daily.good-day");
    assert.equal(groups[0].isMultiEra, true);
    assert.deepEqual(
      groups[0].entries.map((e) => e.id),
      ["r-2025", "r-2026"],
    );
    assert.equal(groups[1].promptKey, "self.safe-harbor");
    assert.equal(groups[1].isMultiEra, false);
  });

  test("pastReflectionsForPrompt 與溫柔提示文案", () => {
    const past = pastReflectionsForPrompt(rows, "daily.good-day");
    assert.equal(past.length, 2);
    assert.equal(formatPastPromptCue(past), "曾於 2025.11 等寫過 2 次，收進手札後可並排回顧");
    assert.equal(
      formatPastPromptCue(past.slice(0, 1)),
      "曾於 2025.11 寫過這題，收進手札後可並排回顧",
    );
    assert.equal(formatPastPromptCue([]), null);
  });
});

describe("心之所向釘選解析、相片驗證與日記格式", () => {
  test("多裝置同時有 pinned=1 時，以 updated_at 最新者決定性勝出", () => {
    const cards: IdealCardRow[] = [
      {
        id: "c1",
        theme: "person",
        title: "沉靜",
        body: "內容",
        motto: "較早釘選的句子",
        art_preset: "starry-window",
        photo_data: null,
        pinned: 1,
        position: 0,
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-10T08:00:00.000Z",
        deleted_at: null,
      },
    ];
    const reflections: IdealReflectionRow[] = [
      {
        id: "r1",
        prompt_key: "daily.good-day",
        category: "daily",
        question: "題目",
        answer: "較晚在手機釘選的車窗回答\n第二行不進單行題詞",
        answered_on: "2026-11-14",
        diary_note_id: null,
        pinned: 1,
        created_at: "2026-11-14T00:00:00.000Z",
        updated_at: "2026-11-14T22:00:00.000Z",
        deleted_at: null,
      },
    ];
    const motto = resolvePinnedMotto(cards, reflections);
    assert.ok(motto);
    assert.equal(motto.kind, "reflection");
    assert.equal(motto.id, "r1");
    assert.equal(motto.motto, "較晚在手機釘選的車窗回答");
  });

  test("相片 DataURL 白名單與容量上限驗證", () => {
    assert.equal(validatePhotoDataUrl(null), null);
    assert.equal(validatePhotoDataUrl(""), null);
    const valid = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
    assert.equal(validatePhotoDataUrl(valid), valid);
    assert.throws(() => validatePhotoDataUrl("https://evil.example/a.jpg"), RangeError);
    assert.throws(
      () => validatePhotoDataUrl(`data:image/webp;base64,${"A".repeat(MAX_IDEAL_PHOTO_CHARS)}`),
      RangeError,
    );
  });

  test("同步寫入日記的內文含題目引用塊與 #車窓の問い 荷札", () => {
    const body = formatReflectionDiaryBody("理想的午後？", "泡一壺焙茶看雨。");
    assert.equal(body, "> 🪟 **車窓の問い**：理想的午後？\n\n泡一壺焙茶看雨。\n\n#車窓の問い");
  });
});

describe("MemoryIdealRepository：CRUD、排他釘選與軟刪除復原", () => {
  test("建立、排他釘選、搜尋與刪除復原", async () => {
    const repo = new MemoryIdealRepository({ seedDemo: false });
    const c1 = await repo.createCard({
      theme: "person",
      title: "溫潤而堅定",
      body: "把複雜留給架構",
      motto: "把複雜留給架構，把溫度留給日常",
      pinned: true,
    });
    const c2 = await repo.createCard({
      theme: "horizon",
      title: "鎌倉江之電",
      body: "看海平交道",
      motto: "吹著海風散步",
    });
    assert.equal(c1.pinned, 1);
    assert.equal(c2.pinned, 0);

    const r1 = await repo.createReflection({
      promptKey: "journey.next-trip",
      category: "journey",
      question: "下一趟慢旅想去哪？",
      answer: "京都鴨川與出町柳。",
      answeredOn: "2026-11-15",
    });
    await repo.setPinned({ kind: "reflection", id: r1.id });
    assert.equal((await repo.getCard(c1.id))?.pinned, 0, "排他釘選應自動卸下舊卡片釘選");
    assert.equal((await repo.getReflection(r1.id))?.pinned, 1);

    const hit = await repo.search("出町柳");
    assert.equal(hit.reflections.length, 1);

    await repo.deleteCard(c2.id);
    assert.equal((await repo.listCards()).length, 1);
    await repo.restoreCard(c2.id);
    assert.equal((await repo.listCards()).length, 2);
  });
});
