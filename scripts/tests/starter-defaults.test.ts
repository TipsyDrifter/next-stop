/**
 * 癸 清空一致性（D-主-531）：預設分類與預設幹線的 id、同步排除清單、清空時要清的本機記憶，兩種語言各寫一份的都在這裡對帳。
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { LINE_ID_NAMESPACE, STARTER_LINES } from "../../src/domain/starterLines.ts";
import { DEFAULT_CATEGORIES, TICKET_ID_NAMESPACE } from "../../src/domain/ticket.ts";
import { KEY_REMINDER_RECENT, KEY_REMINDER_SENT } from "../../src/domain/reminders.ts";
import { TAGS_RECENT_KEY } from "../../src/domain/tags.ts";
import { KEY_AIMS_REVIEW_SEEN } from "../../src/domain/weekAims.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string): string => readFileSync(path.join(ROOT, p), "utf8");

function v5(ns: string, name: string): string {
  const h = createHash("sha1").update(Buffer.from(ns.replace(/-/g, ""), "hex")).update(name, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.subarray(0, 16).toString("hex");
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join("-");
}

describe("預設幹線", () => {
  test("工作、學習、生活三條，id 是決定性的", () => {
    assert.deepEqual(STARTER_LINES.map((l) => l.name), ["工作", "學習", "生活"]);
    assert.equal(v5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "lines.nextstop.shitetsu.app"), LINE_ID_NAMESPACE);
    for (const l of STARTER_LINES) assert.equal(l.id, v5(LINE_ID_NAMESPACE, `line:${l.key}`), l.key);
  });

  test("core.rs 的 NODES_ALIVE 排掉這三條，金樣字面值也一樣", () => {
    const m = read("src-tauri/src/sync/tables/core.rs").match(/const NODES_ALIVE[\s\S]*?;/);
    assert.ok(m, "core.rs 沒有 NODES_ALIVE");
    for (const l of STARTER_LINES) assert.ok(m[0].includes(`'${l.id}'`), `NODES_ALIVE 缺 ${l.key}`);
    const g = read("src-tauri/src/sync/foundation_golden.rs").match(/const SQL_ALIVE_COUNT[\s\S]*?;/);
    assert.ok(g, "金樣沒有 SQL_ALIVE_COUNT");
    for (const l of STARTER_LINES) assert.ok(g[0].includes(`'${l.id}'`), `金樣缺 ${l.key}`);
  });
});

describe("售票口預設分類", () => {
  const KEYS = ["food", "transport", "housing", "daily", "shopping", "fun", "medical", "learning", "salary", "bonus", "invest", "parttime"];

  test("支出八個、收入四個，都是頂層、順序照 position", () => {
    const names = (k: string) => DEFAULT_CATEGORIES.filter((c) => c.kind === k).map((c) => c.name);
    assert.deepEqual(names("expense"), ["飲食", "交通", "居住", "日用", "購物", "娛樂", "醫療", "學習"]);
    assert.deepEqual(names("income"), ["薪資", "獎金", "投資", "兼職"]);
    for (const c of DEFAULT_CATEGORIES) assert.equal(c.parent_id, null);
    for (const k of ["expense", "income"]) {
      assert.deepEqual(DEFAULT_CATEGORIES.filter((c) => c.kind === k).map((c) => c.position), names(k).map((_, i) => i));
    }
  });

  test("id 是決定性的，ticket.rs 的 alive_filter 排掉全部", () => {
    assert.equal(DEFAULT_CATEGORIES.length, KEYS.length);
    const m = read("src-tauri/src/sync/tables/ticket.rs").match(/const TK_CATEGORIES_ALIVE[\s\S]*?;/);
    assert.ok(m, "ticket.rs 沒有 TK_CATEGORIES_ALIVE");
    DEFAULT_CATEGORIES.forEach((c, i) => {
      assert.equal(c.id, v5(TICKET_ID_NAMESPACE, `category:${c.kind}:${KEYS[i]}`), c.name);
      assert.ok(m[0].includes(`'${c.id}'`), `alive_filter 缺 ${c.name}`);
    });
  });
});

describe("清空時一起清的本機記憶", () => {
  test("engine.rs 的清單對得上各模組的設定鍵，偏好不在裡面", () => {
    const m = read("src-tauri/src/sync/engine.rs").match(/const RESET_RESIDUE_SETTINGS[\s\S]*?\];/);
    assert.ok(m, "engine.rs 沒有 RESET_RESIDUE_SETTINGS");
    const keys = [
      TAGS_RECENT_KEY,
      KEY_REMINDER_RECENT,
      KEY_REMINDER_SENT,
      KEY_AIMS_REVIEW_SEEN.week,
      KEY_AIMS_REVIEW_SEEN.month,
      KEY_AIMS_REVIEW_SEEN.year,
      "ticket_transfer_to",
      "timetable_desktop_reminded",
      "timetable_notice_pins",
      "saved_filters",
    ];
    for (const k of keys) assert.ok(m[0].includes(`"${k}"`), `清單缺 ${k}`);
    assert.equal(m[0].match(/"/g)?.length, keys.length * 2, "清單多了沒對帳的鍵");
    for (const k of ["theme", "reminders", "hotkey_overrides", "day_start_hour", "week_start"]) {
      assert.ok(!m[0].includes(`"${k}"`), `${k} 是偏好，不該清`);
    }
  });
});
