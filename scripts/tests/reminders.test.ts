/**
 * 提醒的純函式（`src/domain/reminders.ts`；⑨ 契約 §3、§4）。
 * 跑法：`node --test scripts/tests/reminders.test.ts`（node 24，型別剝除；零依賴）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REMINDER_SETTINGS,
  KEY_REMINDERS,
  KEY_REMINDER_RECENT,
  KEY_REMINDER_SENT,
  MAX_REMINDER_RECENT,
  buildReminderPlan,
  clockForDay,
  daysBetween,
  dueNow,
  parseRecent,
  parseReminderSettings,
  parseSent,
  parseTarget,
  pruneSent,
  pushRecent,
  reminderDayText,
  type ReminderFacts,
  type ReminderSettings,
} from "../../src/domain/reminders.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const at = (day: string, hm: string): number => {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
};

const TODAY = "2026-11-04";

function facts(over: Partial<ReminderFacts> = {}): ReminderFacts {
  return { today: TODAY, dayStartHour: 6, dues: [], lates: [], timed: [], aimWeeks: [], repeats: [], routines: [], ...over };
}

const allOff: ReminderSettings = {
  ...DEFAULT_REMINDER_SETTINGS,
  dueEve: false,
  dueDay: false,
  late: false,
  timed: false,
  review: false,
  routine: false,
  repeat: false,
};

const due = (nodeId: string, day: string, routeName: string | null = null) => ({ nodeId, name: `票${nodeId}`, day, routeName });

describe("預設與解析", () => {
  test("預設時刻照作息：早上 11:30、晚上 21:00；定期帳與作息預設關", () => {
    const d = DEFAULT_REMINDER_SETTINGS;
    assert.equal(d.morning, "11:30");
    assert.equal(d.evening, "21:00");
    assert.equal(d.repeat, false);
    assert.equal(d.routine, false);
    assert.equal(d.dueEve && d.dueDay && d.late && d.timed && d.review && d.sync && d.backup, true);
  });

  test("壞值與缺鍵回預設，已有的值保留", () => {
    assert.deepEqual(parseReminderSettings(null), DEFAULT_REMINDER_SETTINGS);
    assert.deepEqual(parseReminderSettings("{壞"), DEFAULT_REMINDER_SETTINGS);
    assert.deepEqual(parseReminderSettings("[]"), DEFAULT_REMINDER_SETTINGS);
    const s = parseReminderSettings(JSON.stringify({ dueEve: false, morning: "abc", lateDays: 0, timedBefore: 5 }));
    assert.equal(s.dueEve, false);
    assert.equal(s.morning, "11:30");
    assert.equal(s.lateDays, 3);
    assert.equal(s.timedBefore, 5);
    assert.equal(s.dueDay, true);
  });

  test("日界線改過：範圍外的時刻照新的日界線解讀", () => {
    assert.equal(clockForDay("25:00", 6), "25:00");
    assert.equal(clockForDay("11:30", 6), "11:30");
    // 日界線改成 12:00：11:30 已經算前一天深夜
    assert.equal(clockForDay("11:30", 12), "35:30");
    // 日界線改成 00:00：25:00 就是 01:00
    assert.equal(clockForDay("25:00", 0), "01:00");
  });

  test("文案日子與天數", () => {
    assert.equal(reminderDayText("2026-11-05"), "11/5（四）");
    assert.equal(daysBetween("2026-11-04", "2026-11-01"), 3);
    assert.equal(daysBetween("2026-03-09", "2026-03-07"), 2);
  });
});

describe("締切", () => {
  const s = { ...allOff, dueEve: true, dueDay: true };

  test("前一天晚上、當天早上各一則，點開到那張票", () => {
    const plan = buildReminderPlan(facts({ dues: [due("a", "2026-11-06", "畢業專題")] }), s, {}, at(TODAY, "12:00"));
    assert.equal(plan.length, 2);
    assert.equal(plan[0].kind, "due-eve");
    assert.equal(plan[0].fireAt, at("2026-11-05", "21:00"));
    assert.equal(plan[0].title, "明天締切：票a");
    assert.equal(plan[0].body, "11/6（五）・畢業專題");
    assert.deepEqual(plan[0].target, { kind: "node", id: "a" });
    assert.equal(plan[1].kind, "due-day");
    assert.equal(plan[1].fireAt, at("2026-11-06", "11:30"));
    assert.equal(plan[1].title, "今天締切：票a");
  });

  test("同一天好幾張＝一則總結，點開到行程表那天；memberKeys 每張一個", () => {
    const plan = buildReminderPlan(
      facts({ dues: [due("a", "2026-11-06"), due("b", "2026-11-06"), due("c", "2026-11-06"), due("d", "2026-11-06")] }),
      { ...allOff, dueEve: true },
      {},
      at(TODAY, "12:00"),
    );
    assert.equal(plan.length, 1);
    assert.equal(plan[0].title, "明天有 4 個締切");
    assert.equal(plan[0].body, "票a、票b、票c…");
    assert.deepEqual(plan[0].target, { kind: "day", day: "2026-11-06" });
    assert.equal(plan[0].memberKeys.length, 4);
  });

  test("總結響過之後才加進來的那張，單獨響一則，不重響前面的", () => {
    const sent = { "due-eve:a:2026-11-06": 1, "due-eve:b:2026-11-06": 1 };
    const plan = buildReminderPlan(
      facts({ dues: [due("a", "2026-11-06"), due("b", "2026-11-06"), due("c", "2026-11-06")] }),
      { ...allOff, dueEve: true },
      sent,
      at(TODAY, "12:00"),
    );
    assert.equal(plan.length, 1);
    assert.equal(plan[0].title, "明天締切：票c");
  });

  test("前一天那則過了日界線就不補；當天那則補到當天結束", () => {
    const f = facts({ dues: [due("a", TODAY)] });
    const s2 = { ...allOff, dueEve: true, dueDay: true };
    // 昨晚 23:00 開 App：前一天那則還能補
    let items = dueNow(buildReminderPlan({ ...f, today: "2026-11-03" }, s2, {}, at("2026-11-03", "23:00")), at("2026-11-03", "23:00"));
    assert.deepEqual(items.map((x) => x.kind), ["due-eve"]);
    // 過了日界線 06:00：前一天那則不補，等當天早上
    items = dueNow(buildReminderPlan(f, s2, {}, at(TODAY, "07:00")), at(TODAY, "07:00"));
    assert.deepEqual(items, []);
    // 12:00 才開：當天那則補
    items = dueNow(buildReminderPlan(f, s2, {}, at(TODAY, "12:00")), at(TODAY, "12:00"));
    assert.deepEqual(items.map((x) => x.kind), ["due-day"]);
    // 隔天凌晨 05:00 還算今天：補得到；06:00 就不補
    items = dueNow(buildReminderPlan(f, s2, {}, at("2026-11-05", "05:00")), at("2026-11-05", "05:00"));
    assert.deepEqual(items.map((x) => x.kind), ["due-day"]);
    items = dueNow(buildReminderPlan(f, s2, {}, at("2026-11-05", "06:00")), at("2026-11-05", "06:00"));
    assert.deepEqual(items, []);
  });

  test("同一天兩批不同的總結是兩則；成員一樣重算不會變", () => {
    const s2 = { ...allOff, dueEve: true };
    const now = at(TODAY, "12:00");
    const a = buildReminderPlan(facts({ dues: [due("a", "2026-11-06"), due("b", "2026-11-06")] }), s2, {}, now);
    const b = buildReminderPlan(facts({ dues: [due("c", "2026-11-06"), due("d", "2026-11-06")] }), s2, {}, now);
    const again = buildReminderPlan(facts({ dues: [due("b", "2026-11-06"), due("a", "2026-11-06")] }), s2, {}, now);
    assert.notEqual(a[0].key, b[0].key);
    assert.equal(a[0].key, again[0].key);
  });

  test("關掉前一天：當天照響", () => {
    const plan = buildReminderPlan(facts({ dues: [due("a", "2026-11-06")] }), { ...allOff, dueDay: true }, {}, at(TODAY, "12:00"));
    assert.deepEqual(plan.map((x) => x.kind), ["due-day"]);
  });

  test("晚上時刻設成 25:00：是前一天營業日的深夜（實際是當天凌晨）", () => {
    const plan = buildReminderPlan(facts({ dues: [due("a", "2026-11-06")] }), { ...allOff, dueEve: true, evening: "25:00" }, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].fireAt, at("2026-11-06", "01:00"));
  });
});

describe("誤點", () => {
  const s = { ...allOff, late: true, lateDays: 3 };
  const late = (nodeId: string, anchor: string) => ({ nodeId, name: `票${nodeId}`, anchor });

  test("還沒滿 N 天：排在滿的那天早上", () => {
    const plan = buildReminderPlan(facts({ lates: [late("a", "2026-11-03")] }), s, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].fireAt, at("2026-11-06", "11:30"));
    assert.equal(plan[0].title, "誤點 3 天：票a");
    assert.equal(plan[0].body, "原定 11/3（二）");
    assert.deepEqual(plan[0].target, { kind: "node", id: "a" });
  });

  test("早就滿了：排今天早上，過了今天早上就馬上響", () => {
    const f = facts({ lates: [late("a", "2026-10-20")] });
    let plan = buildReminderPlan(f, s, {}, at(TODAY, "08:00"));
    assert.equal(plan[0].fireAt, at(TODAY, "11:30"));
    assert.deepEqual(dueNow(plan, at(TODAY, "08:00")), []);
    plan = buildReminderPlan(f, s, {}, at(TODAY, "12:00"));
    assert.equal(dueNow(plan, at(TODAY, "12:00")).length, 1);
    assert.equal(plan[0].title, "誤點 15 天：票a");
  });

  test("只響一次；改了執行日算新的一次", () => {
    const sent = { "late:a:2026-10-20": 1 };
    assert.deepEqual(buildReminderPlan(facts({ lates: [late("a", "2026-10-20")] }), s, sent, at(TODAY, "12:00")), []);
    assert.equal(buildReminderPlan(facts({ lates: [late("a", "2026-10-25")] }), s, sent, at(TODAY, "12:00")).length, 1);
  });

  test("好幾張同一天：一則總結到今日頁", () => {
    const plan = buildReminderPlan(facts({ lates: [late("a", "2026-10-01"), late("b", "2026-10-02")] }), s, {}, at(TODAY, "12:00"));
    assert.equal(plan.length, 1);
    assert.equal(plan[0].title, "有 2 張票誤點滿 3 天");
    assert.deepEqual(plan[0].target, { kind: "today" });
  });

  test("帳本：誤點的鍵照還誤點著留，其他鍵照時間清", () => {
    const now = at(TODAY, "12:00");
    const old = now - 100 * 86_400_000;
    const sent = { "late:a:2026-01-01": old, "late:b:2026-01-01": old, "due-eve:c:2026-01-01": old, "due-day:d:2026-11-04": now };
    const out = pruneSent(sent, { lates: [{ nodeId: "a", name: "", anchor: "2026-01-01" }] }, now);
    assert.deepEqual(Object.keys(out).sort(), ["due-day:d:2026-11-04", "late:a:2026-01-01"]);
  });
});

describe("排了時刻", () => {
  const s = { ...allOff, timed: true, timedBefore: 10 };
  const t = (time: string, planId: string | null = null) => ({ nodeId: "a", name: "寫報告", day: TODAY, time, routeName: "專題", planId });

  test("開始前 10 分鐘，開始之後就不補", () => {
    const plan = buildReminderPlan(facts({ timed: [t("14:00")] }), s, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].fireAt, at(TODAY, "13:50"));
    assert.equal(plan[0].title, "14:00 寫報告");
    assert.equal(plan[0].body, "10 分鐘後開始・專題");
    assert.deepEqual(buildReminderPlan(facts({ timed: [t("14:00")] }), s, {}, at(TODAY, "14:00")), []);
  });

  test("多時段第二段用自己的鍵，跟第一段互不影響", () => {
    const plan = buildReminderPlan(facts({ timed: [t("14:00"), t("16:00", "p1")] }), s, { "timed:a:2026-11-04:14:00": 1 }, at(TODAY, "12:00"));
    assert.deepEqual(plan.map((x) => x.key), ["slot:p1:2026-11-04:16:00"]);
  });

  test("改時刻算新的一次", () => {
    const plan = buildReminderPlan(facts({ timed: [t("15:00")] }), s, { "timed:a:2026-11-04:14:00": 1 }, at(TODAY, "12:00"));
    assert.equal(plan.length, 1);
  });

  test("0 分鐘＝開始時響，留一分鐘給 tick", () => {
    const plan = buildReminderPlan(facts({ timed: [t("14:00")] }), { ...s, timedBefore: 0 }, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].fireAt, at(TODAY, "14:00"));
    assert.equal(plan[0].body, "現在開始・專題");
    assert.equal(dueNow(plan, at(TODAY, "14:00") + 30_000).length, 1);
  });
});

describe("回顧、定期帳、作息", () => {
  test("週末回顧：最後一天晚上，點開到回顧，補到當天結束", () => {
    const f = facts({ aimWeeks: [{ weekOn: "2026-11-02", lastDay: "2026-11-08" }] });
    const plan = buildReminderPlan(f, { ...allOff, review: true }, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].fireAt, at("2026-11-08", "21:00"));
    assert.deepEqual(plan[0].target, { kind: "review", weekOn: "2026-11-02" });
    assert.equal(plan[0].expireAt, at("2026-11-09", "06:00"));
  });

  test("定期帳：當天早上；好幾筆併一則，點開到售票口那天", () => {
    const r = (repeatId: string, label: string, amountText: string) => ({ repeatId, day: "2026-11-05", label, amountText });
    let plan = buildReminderPlan(facts({ repeats: [r("x", "房租", "−12,000")] }), { ...allOff, repeat: true }, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].title, "今天定期帳：房租");
    assert.equal(plan[0].body, "−12,000");
    assert.deepEqual(plan[0].target, { kind: "ticketDay", day: "2026-11-05" });
    plan = buildReminderPlan(facts({ repeats: [r("x", "房租", "−12,000"), r("y", "網路", "−699")] }), { ...allOff, repeat: true }, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].title, "今天定期帳 2 筆");
    assert.equal(plan[0].body, "房租 −12,000、網路 −699");
    assert.equal(plan[0].memberKeys.length, 2);
  });

  test("作息：開始時響；過了 15 分鐘就不響", () => {
    const f = facts({ routines: [{ segId: "s1", day: TODAY, name: "睡前收尾", start: "26:30", end: "27:30" }] });
    const plan = buildReminderPlan(f, { ...allOff, routine: true }, {}, at(TODAY, "12:00"));
    assert.equal(plan[0].fireAt, at("2026-11-05", "02:30"));
    assert.equal(plan[0].title, "02:30 睡前收尾");
    assert.equal(plan[0].body, "作息範本・到 03:30");
    assert.deepEqual(buildReminderPlan(f, { ...allOff, routine: true }, {}, at("2026-11-05", "02:45")), []);
  });

  test("設定全關：什麼都不排", () => {
    const f = facts({
      dues: [due("a", "2026-11-06")],
      lates: [{ nodeId: "b", name: "", anchor: "2026-10-01" }],
      aimWeeks: [{ weekOn: "2026-11-02", lastDay: "2026-11-08" }],
    });
    assert.deepEqual(buildReminderPlan(f, allOff, {}, at(TODAY, "12:00")), []);
  });

  test("清單依響的時間排序", () => {
    const plan = buildReminderPlan(
      facts({ dues: [due("a", "2026-11-06")], timed: [{ nodeId: "t", name: "x", day: TODAY, time: "14:00", routeName: null, planId: null }] }),
      DEFAULT_REMINDER_SETTINGS,
      {},
      at(TODAY, "12:00"),
    );
    assert.deepEqual(plan.map((x) => x.kind), ["timed", "due-eve", "due-day"]);
  });
});

describe("Android 點開不靠 MainActivity 的 intent（E15）", () => {
  const J = "src-tauri/plugins/tauri-plugin-tt-notice/android/src/main/";
  const read = (p: string) => readFileSync(path.join(ROOT, J, p), "utf8");

  test("三種點開都走中繼頁，落點不放在開 MainActivity 的 intent 上", () => {
    const renderer = read("java/TtNoticeRenderer.kt");
    assert.ok(renderer.includes("Intent(ctx, NsNoticeOpenActivity::class.java)"));
    for (const [name, next] of [["private fun openPi", "private fun askPi"], ["private fun askPi", "private fun chronoBase"], ["private fun nsReminderPi", "fun postNsReminder"]]) {
      const body = renderer.slice(renderer.indexOf(name), renderer.indexOf(next));
      assert.ok(body.length > 0, name);
      assert.ok(body.includes("openerIntent(ctx)"), name);
      assert.ok(!body.includes("launchIntent("), name);
    }
  });

  test("launchIntent 只有中繼頁在用，帶落點的 extra 不會加到它身上", () => {
    const renderer = read("java/TtNoticeRenderer.kt");
    assert.equal(renderer.split("launchIntent(").length - 1, 1); // 只剩定義
    assert.ok(read("java/NsNoticeOpenActivity.kt").includes("launchIntent(this)"));
  });

  test("MainActivity 那邊不再讀落點（否則系統重建時會重放舊的）", () => {
    const plugin = read("java/TtNoticePlugin.kt");
    for (const key of ["EXTRA_NS_REM_TARGET", "EXTRA_ASK", "EXTRA_OPEN"]) assert.ok(!plugin.includes(key), key);
  });

  test("中繼頁不留在任何任務裡", () => {
    const m = read("AndroidManifest.xml").replace(/\s+/g, " ");
    const tag = /<activity [^>]*NsNoticeOpenActivity[^>]*>/.exec(m)?.[0] ?? "";
    for (const attr of ['android:exported="false"', 'android:excludeFromRecents="true"', 'android:noHistory="true"', 'android:taskAffinity=""']) {
      assert.ok(tag.includes(attr), attr);
    }
  });
});

describe("帳本、最近、點開的字串", () => {
  test("壞資料讀成空", () => {
    assert.deepEqual(parseSent("{壞"), {});
    assert.deepEqual(parseSent('{"a":1,"b":"x"}'), { a: 1 });
    assert.deepEqual(parseRecent("{}"), []);
    assert.deepEqual(parseRecent('[{"at":1}]'), []);
  });

  test("最近：新的在前，超過上限丟舊的", () => {
    const row = (n: number) => ({ at: n, kind: "late" as const, title: String(n), body: "", target: { kind: "today" as const } });
    const cur = Array.from({ length: MAX_REMINDER_RECENT }, (_, i) => row(i));
    const out = pushRecent(cur, [row(1000)]);
    assert.equal(out.length, MAX_REMINDER_RECENT);
    assert.equal(out[0].at, 1000);
    assert.equal(out.at(-1)?.at, 1);
  });

  test("target 字串往返；看不懂回 null", () => {
    assert.deepEqual(parseTarget('{"kind":"node","id":"a"}'), { kind: "node", id: "a" });
    assert.deepEqual(parseTarget('{"kind":"today"}'), { kind: "today" });
    assert.equal(parseTarget('{"kind":"node"}'), null);
    assert.equal(parseTarget('{"kind":"x"}'), null);
    assert.equal(parseTarget("壞"), null);
    assert.equal(parseTarget(null), null);
  });

  test("三把本機鍵不進同步白名單（TS 與 Rust）", () => {
    const sources = [
      "src/data/syncTables.ts",
      "src/lines/notes.manifest.ts",
      "src/lines/timetable.manifest.ts",
      "src/lines/ticket.manifest.ts",
      "src-tauri/src/sync/tables/core.rs",
      "src-tauri/src/sync/tables/notes.rs",
      "src-tauri/src/sync/tables/timetable.rs",
      "src-tauri/src/sync/tables/ticket.rs",
    ].map((p) => readFileSync(path.join(ROOT, p), "utf8"));
    for (const key of [KEY_REMINDERS, KEY_REMINDER_SENT, KEY_REMINDER_RECENT]) {
      for (const src of sources) assert.equal(src.includes(`"${key}"`), false, key);
    }
  });
});
