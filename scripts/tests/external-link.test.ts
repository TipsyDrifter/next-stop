/**
 * ⑬ 外部入口・連結解析與小窗快照（契約 第一、三、九節）。
 * 跑法：`node --test scripts/tests/external-link.test.ts`（node 24，型別剝除預設開；零依賴）。
 * 案例表 `fixtures/external-links.json` 三份實作共用（Rust `external.rs` 用 include_str! 讀同一份）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTERNAL_LINK_MAX,
  EXTERNAL_SILENT_TTL_MS,
  arriveLink,
  categoryLink,
  createExternalDrainer,
  externalLinkExpired,
  isSilentAction,
  parseExternalLink,
  schemeFromIdentifier,
  ticketLink,
  todayLink,
  type ExternalQueueItem,
} from "../../src/domain/externalLink.ts";
import { PIN_TILES_MAX, buildPinSnapshot, buildWidgetState } from "../../src/domain/pinSnapshot.ts";
import { CAT_PALETTE, TT_NOTICE_TEXT } from "../../src/domain/timetableNotice.ts";
import { fmtClock, fmtDur, type TimeBlockRow, type TimeCategoryRow } from "../../src/domain/timetable.ts";
import { fmtElapsed, msToNextMinute } from "../../src/pin/pinTime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(path.join(here, "fixtures/external-links.json"), "utf8")) as {
  url: string;
  silent: boolean;
  valid: boolean;
}[];

describe("案例表", () => {
  for (const c of cases) {
    const label = c.url.length > 60 ? `${c.url.slice(0, 40)}…（${c.url.length} 字）` : c.url || "（空字串）";
    test(label, () => {
      const a = parseExternalLink(c.url);
      assert.equal(a !== null, c.valid, "valid");
      assert.equal(a !== null && isSilentAction(a), c.silent, "silent");
    });
  }

  test("涵蓋六種動作，上限照契約", () => {
    const kinds = new Set(cases.map((c) => parseExternalLink(c.url)?.kind).filter(Boolean));
    assert.deepEqual([...kinds].sort(), ["arrive", "departCategory", "departTicket", "openReminder", "openTicket", "openToday"]);
    assert.equal(EXTERNAL_LINK_MAX, 2048);
    assert.ok(cases.every((c) => c.valid || !c.silent), "認不得的不可能是不開 App 的");
  });
});

describe("parseExternalLink 的內容", () => {
  test("id 分大小寫、解百分比編碼；分類名是提示", () => {
    assert.deepEqual(parseExternalLink("NEXTSTOP://TICKET/AbC"), { kind: "openTicket", nodeId: "AbC" });
    assert.deepEqual(parseExternalLink("nextstop://ticket/a%20b"), { kind: "openTicket", nodeId: "a b" });
    assert.deepEqual(parseExternalLink("nextstop://depart?name=%E5%89%B5%E4%BD%9C&category=c1"), {
      kind: "departCategory",
      categoryId: "c1",
      name: "創作",
    });
    assert.deepEqual(parseExternalLink("nextstop://depart?category=c1"), { kind: "departCategory", categoryId: "c1", name: null });
    assert.deepEqual(parseExternalLink("nextstop://depart?ticket=t1"), { kind: "departTicket", nodeId: "t1" });
  });

  test("category 與 ticket 同時帶：category 優先（＝Rust 的判斷）", () => {
    assert.equal(parseExternalLink("nextstop://depart?ticket=t1&category=c1")?.kind, "departCategory");
  });

  test("解不開的百分比編碼＝認不得，不丟錯", () => {
    assert.equal(parseExternalLink("nextstop://ticket/%ZZ"), null);
    assert.equal(parseExternalLink("nextstop://depart?category=%ZZ"), null);
    // 分類名壞掉不影響発車：name 只給提示用
    assert.deepEqual(parseExternalLink("nextstop://depart?category=c1&name=%ZZ"), { kind: "departCategory", categoryId: "c1", name: null });
  });

  test("型別不可信的輸入不丟錯", () => {
    assert.equal(parseExternalLink(null as unknown as string), null);
    assert.equal(parseExternalLink(42 as unknown as string), null);
  });
});

describe("externalLinkExpired", () => {
  const t0 = 1_800_000_000_000;

  test("不開 App 的動作：滿 10 分鐘還算數，多 1ms 就過期", () => {
    assert.equal(EXTERNAL_SILENT_TTL_MS, 600_000);
    for (const a of [parseExternalLink("nextstop://arrive"), parseExternalLink("nextstop://depart?category=c1")]) {
      assert.ok(a);
      assert.equal(externalLinkExpired(a, t0, t0), false);
      assert.equal(externalLinkExpired(a, t0, t0 + EXTERNAL_SILENT_TTL_MS), false);
      assert.equal(externalLinkExpired(a, t0, t0 + EXTERNAL_SILENT_TTL_MS + 1), true);
    }
  });

  test("開 App 的連結放多久都照開", () => {
    for (const url of ["nextstop://today", "nextstop://ticket/t1", "nextstop://depart?ticket=t1"]) {
      const a = parseExternalLink(url);
      assert.ok(a, url);
      assert.equal(externalLinkExpired(a, t0, t0 + 365 * 86_400_000), false, url);
    }
  });

  test("時間在未來（兩個時鐘對不齊）不算過期", () => {
    const a = parseExternalLink("nextstop://arrive");
    assert.ok(a);
    assert.equal(externalLinkExpired(a, t0 + 60_000, t0), false);
  });
});

describe("組字", () => {
  test("組出來的都解得回去", () => {
    const name = "讀書 & 寫作？=#/+";
    const act = parseExternalLink(categoryLink("nextstop", "c/1", name));
    assert.deepEqual(act, { kind: "departCategory", categoryId: "c/1", name });
    assert.deepEqual(parseExternalLink(ticketLink("nextstop-dev", "a/b c")), { kind: "openTicket", nodeId: "a/b c" });
    assert.deepEqual(parseExternalLink(todayLink("nextstop")), { kind: "openToday" });
    assert.deepEqual(parseExternalLink(arriveLink("nextstop")), { kind: "arrive" });
  });

  test("schemeFromIdentifier（與 Rust scheme_for 同規則）", () => {
    assert.equal(schemeFromIdentifier("app.shitetsu.nextstop"), "nextstop");
    assert.equal(schemeFromIdentifier("app.shitetsu.nextstop.dev"), "nextstop-dev");
    assert.equal(schemeFromIdentifier("app.shitetsu.nextstop.dev.ticket"), "nextstop-dev-ticket");
    assert.equal(schemeFromIdentifier("app.shitetsu.nextstop.sandbox.a"), "nextstop-sandbox-a");
    assert.equal(schemeFromIdentifier("com.other.App"), "nextstop-com-other-app");
    assert.equal(schemeFromIdentifier(""), "nextstop");
    for (const id of ["app.shitetsu.nextstop.Dev_1", "x.y"]) {
      assert.ok(parseExternalLink(todayLink(schemeFromIdentifier(id))), id);
    }
  });
});

describe("createExternalDrainer", () => {
  function harness(batches: ExternalQueueItem[][], run?: (it: ExternalQueueItem) => Promise<void>) {
    const log: string[] = [];
    const errors: unknown[] = [];
    const drain = createExternalDrainer({
      take: async () => {
        log.push("take");
        return batches.shift() ?? [];
      },
      run: async (it) => {
        log.push(`run:${it.id}`);
        await run?.(it);
      },
      ack: async (ids) => {
        log.push(`ack:${ids.join(",")}`);
      },
      onError: (e) => errors.push(e),
    });
    return { drain, log, errors };
  }
  const item = (id: string): ExternalQueueItem => ({ id, url: `nextstop://ticket/${id}`, at: 0 });

  test("逐筆跑完才確認", async () => {
    const h = harness([[item("a"), item("b")]]);
    await h.drain();
    assert.deepEqual(h.log, ["take", "run:a", "run:b", "ack:a,b"]);
  });

  test("空佇列不確認", async () => {
    const h = harness([[]]);
    await h.drain();
    assert.deepEqual(h.log, ["take"]);
  });

  test("跑的時候又被敲門：不併行，跑完補一趟", async () => {
    let inner: Promise<void> | null = null;
    const h = harness([[item("a")], [item("b")]], async (it) => {
      if (it.id === "a") inner = h.drain();
    });
    await h.drain();
    await inner;
    assert.deepEqual(h.log, ["take", "run:a", "ack:a", "take", "run:b", "ack:b"]);
  });

  test("中途丟錯：跑過的確認、沒跑的留著，下一趟再來", async () => {
    const h = harness([[item("a"), item("b"), item("c")]], async (it) => {
      if (it.id === "b") throw new Error("boom");
    });
    await h.drain();
    assert.deepEqual(h.log, ["take", "run:a", "run:b", "ack:a"]);
    assert.equal(h.errors.length, 1);
    // 鎖要放開
    await h.drain();
    assert.equal(h.log.at(-1), "take");
  });

  test("一輪丟錯、期間又被敲門：會再跑一輪", async () => {
    let inner: Promise<void> | null = null;
    const h = harness([[item("a")], [item("b")]], async (it) => {
      if (it.id !== "a") return;
      inner = h.drain();
      throw new Error("boom");
    });
    await h.drain();
    await inner;
    assert.deepEqual(h.log, ["take", "run:a", "take", "run:b", "ack:b"]);
    assert.equal(h.errors.length, 1);
  });
});

/* ───────── 快照 ───────── */

function cat(id: string, name: string, colorIdx: number, extra: Partial<TimeCategoryRow> = {}): TimeCategoryRow {
  return {
    id,
    name,
    color_idx: colorIdx,
    glyph: null,
    parent_id: "group",
    position: colorIdx,
    default_min: null,
    archived_at: null,
    deleted_at: null,
    ...extra,
  } as unknown as TimeCategoryRow;
}
const CATS: TimeCategoryRow[] = [
  cat("group", "組", 1, { parent_id: null }),
  cat("c1", "創作", 1),
  cat("c2", "學習", 2),
  cat("c3", "運動", 3, { glyph: "動" }),
  cat("c4", "家事", 4),
  cat("c5", "閱讀", 5),
  cat("c6", "其他", 6),
];
const byId = Object.fromEntries(CATS.map((c) => [c.id, c]));
const at = new Date(2026, 10, 6, 14, 35).getTime();
const block = (categoryId: string) => ({ id: "b1", category_id: categoryId, started_at: new Date(at).toISOString() }) as unknown as TimeBlockRow;

describe("buildPinSnapshot", () => {
  const base = { theme: "light" as const, left: 5, linkLabel: null, catById: byId, categories: CATS, recentIds: [], pins: [] };

  test("停車中：running＝null，格子 ≤4", () => {
    const s = buildPinSnapshot({ ...base, running: null });
    assert.equal(s.running, null);
    assert.equal(s.left, 5);
    assert.equal(s.tiles.length, PIN_TILES_MAX);
    assert.deepEqual(s.tiles[0], { categoryId: "c1", name: "創作", glyph: "創", colorLight: CAT_PALETTE.light[0], colorDark: CAT_PALETTE.dark[0] });
  });

  test("運行中：帶分類、任務、発車字；格子不含正在跑的", () => {
    const s = buildPinSnapshot({ ...base, running: block("c1"), linkLabel: "寫第三章大綱" });
    assert.deepEqual(s.running, {
      name: "創作",
      glyph: "創",
      colorLight: CAT_PALETTE.light[0],
      colorDark: CAT_PALETTE.dark[0],
      ticket: "寫第三章大綱",
      startedAt: at,
      startedLabel: fmtClock(at) + TT_NOTICE_TEXT.startedSuffix,
    });
    assert.ok(s.tiles.every((t) => t.categoryId !== "c1"));
    assert.equal(s.tiles.length, PIN_TILES_MAX);
  });

  test("釘滿五個又沒釘正在跑的：照樣 ≤4", () => {
    const s = buildPinSnapshot({ ...base, running: block("c6"), pins: ["c1", "c2", "c3", "c4", "c5"] });
    assert.deepEqual(s.tiles.map((t) => t.categoryId), ["c1", "c2", "c3", "c4"]);
  });

  test("正在跑的被釘：其餘補上，還是 4 格", () => {
    const s = buildPinSnapshot({ ...base, running: block("c1"), pins: ["c1", "c2"] });
    assert.equal(s.tiles.length, 4);
    assert.ok(!s.tiles.some((t) => t.categoryId === "c1"));
  });

  test("glyph 優先；分類已不在＝「？」", () => {
    assert.equal(buildPinSnapshot({ ...base, running: block("c3") }).running?.glyph, "動");
    const gone = buildPinSnapshot({ ...base, running: block("nope") }).running;
    assert.equal(gone?.name, "？");
    assert.equal(gone?.glyph, "？");
  });

  test("可以 JSON 來回（要過 Tauri 事件）", () => {
    const s = buildPinSnapshot({ ...base, running: block("c1") });
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  });
});

describe("buildWidgetState", () => {
  test("counts 照傳、tiles ≤4 不含正在跑的、帶門檻", () => {
    const counts = [{ until: 1, left: 3 }, { until: 2, left: 7 }];
    const s = buildWidgetState({ counts, runningCatId: "c1", categories: CATS, recentIds: [], pins: [], globalMaxMin: 180 });
    assert.deepEqual(s.counts, counts);
    assert.equal(s.tiles.length, 4);
    assert.ok(s.tiles.every((t) => t.categoryId !== "c1"));
    assert.equal(s.tiles[0].thresholdMin, 180);
  });
});

describe("小窗的時間（自帶一份，不 import domain/timetable：見 pinTime.ts 檔頭）", () => {
  test("fmtElapsed 與 fmtDur 逐例相同", () => {
    for (const ms of [-5, 0, 29_000, 31_000, 60_000, 59 * 60_000, 3_600_000, 3_660_000, 4_800_000, 7_200_000, 90_000_000]) {
      assert.equal(fmtElapsed(ms), fmtDur(ms), String(ms));
    }
  });

  test("msToNextMinute 對齊整分", () => {
    assert.equal(msToNextMinute(new Date(2026, 0, 1, 10, 0, 0, 0).getTime()), 60_000);
    assert.equal(msToNextMinute(new Date(2026, 0, 1, 10, 0, 59, 500).getTime()), 500);
  });
});
