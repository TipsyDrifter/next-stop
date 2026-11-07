/**
 * 動態氛圍層的排程與「藏起來就停」（⑪；prototypes/m3-mood-b-motion.html 的節奏）。
 * 跑法：`node --test scripts/tests/mood-director.test.ts`（零依賴；假時鐘）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MoodDirector, duskTintAt, type MoodClock, type MoodConfig, type MoodEvent } from "../../src/ui/ambience/moodDirector.ts";
import { twinkleAt } from "../../src/ui/ambience/starfield.ts";

function fakeClock(random = 0.5) {
  let t = 0;
  let seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const clock: MoodClock = {
    now: () => t,
    setTimeout(fn, ms) {
      seq += 1;
      q.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout(id) {
      q.delete(id as number);
    },
    random: () => random,
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      q.delete(next[0]);
      t = next[1].at;
      next[1].fn();
    }
    t = end;
  };
  return { clock, advance, pending: () => q.size };
}

const PARTS = { train: true, birds: true, meteor: true, dusk: true };
const cfg = (over: Partial<MoodConfig> = {}): MoodConfig => ({
  mode: "ambient",
  parts: PARTS,
  skyKinds: ["birds"],
  reduced: false,
  ...over,
});

function setup(over: Partial<MoodConfig> = {}, random = 0.5) {
  const c = fakeClock(random);
  const events: MoodEvent[] = [];
  const d = new MoodDirector((e) => events.push(e), c.clock);
  d.configure(cfg(over));
  return { ...c, events, d };
}

describe("環境循環的節奏", () => {
  test("列車落在 60–120 秒、候鳥 40–80 秒，不做暖場", () => {
    const { advance, events } = setup();
    advance(39_999);
    assert.equal(events.length, 0, "開頁不暖場");
    advance(21_000); // random=.5 ⇒ 候鳥 60s
    assert.deepEqual(events[0], { kind: "birds", count: 3 });
    advance(30_000); // 列車 90s
    assert.ok(events.some((e) => e.kind === "train"));
  });

  test("粉彩候鳥與流星共用同一條天象排程，總頻率不會變兩倍", () => {
    const { advance, events } = setup({ skyKinds: ["birds", "meteor"], parts: { ...PARTS, train: false } });
    advance(600_000);
    assert.equal(events.length, 10, "60 秒一次");
  });

  test("元件關掉就不放", () => {
    const { advance, events } = setup({ parts: { ...PARTS, birds: false, train: false } });
    advance(600_000);
    assert.equal(events.length, 0, "這個主題只有候鳥，關了就沒有天象");
  });
});

describe("藏起來就停", () => {
  test("睡著時手上沒有任何計時器，醒來照剩餘秒數接著算", () => {
    const { d, advance, events, pending } = setup();
    advance(50_000);
    d.setAwake(false);
    assert.equal(pending(), 0, "睡著時一個計時器都不留");
    assert.equal(d.armedTimers, 0);
    advance(3_600_000);
    assert.equal(events.length, 0, "睡一小時，什麼都沒放");
    d.setAwake(true);
    assert.equal(pending(), 2);
    advance(9_999);
    assert.equal(events.length, 0, "候鳥還差 10 秒，不是一醒就放");
    advance(2);
    assert.equal(events.length, 1);
  });

  test("睡著時改設定也不會偷偷開計時器", () => {
    const { d, pending } = setup();
    d.setAwake(false);
    d.configure(cfg({ mode: "ritual" }));
    d.configure(cfg({ mode: "ambient" }));
    assert.equal(pending(), 0);
    d.setAwake(true);
    assert.equal(pending(), 2);
  });

  test("destroy（切到別頁）後沒有殘留", () => {
    const { d, pending } = setup();
    d.destroy();
    assert.equal(pending(), 0);
  });

  test("關閉模式、減少動態：什麼都不排", () => {
    assert.equal(setup({ mode: "off" }).pending(), 0);
    assert.equal(setup({ reduced: true }).pending(), 0);
  });
});

describe("儀式觸發", () => {
  test("蓋一枚來一班短車；環境循環模式蓋章沒反應", () => {
    const a = setup({ mode: "ritual" });
    assert.equal(a.pending(), 0, "儀式模式平常不排");
    a.d.stamped(false);
    assert.deepEqual(a.events, [{ kind: "train", long: false }]);
    const b = setup();
    b.d.stamped(false);
    assert.equal(b.events.length, 0);
  });

  test("全済：長列車出發 420ms 後才放雁行（亮）", () => {
    const { d, advance, events } = setup({ mode: "ritual" });
    d.stamped(true);
    assert.deepEqual(events, [{ kind: "train", long: true }]);
    advance(419);
    assert.equal(events.length, 1);
    advance(1);
    assert.deepEqual(events[1], { kind: "flock" });
  });

  test("全済（暗）：流星群 2.6 秒內六顆", () => {
    const { d, advance, events } = setup({ mode: "ritual", skyKinds: ["meteor"] });
    d.stamped(true);
    advance(420 + 2200);
    assert.equal(events.filter((e) => e.kind === "meteor").length, 6);
  });

  test("一次一班：前一班還在跑就排隊，升格成長列車不會被降回去", () => {
    const { d, events } = setup({ mode: "ritual" });
    d.stamped(false);
    d.stamped(true);
    d.stamped(false);
    assert.equal(events.length, 1, "第二班排隊中");
    d.trainEnded();
    assert.deepEqual(events[1], { kind: "train", long: true });
    d.trainEnded();
    assert.equal(events.filter((e) => e.kind === "train").length, 2, "隊伍清空就停");
  });

  test("列車關著，全済的高潮照放", () => {
    const { d, advance, events } = setup({ mode: "ritual", parts: { ...PARTS, train: false } });
    d.stamped(true);
    advance(420);
    assert.deepEqual(events, [{ kind: "flock" }]);
  });
});

describe("星星的呼吸", () => {
  const s = { lo: 0.2, hi: 0.8, period: 6, phase: 0 };
  test("來回一趟：起點最暗、半途最亮、回到起點", () => {
    assert.ok(Math.abs(twinkleAt(0, s) - 0.2) < 1e-9);
    assert.ok(Math.abs(twinkleAt(3, s) - 0.8) < 1e-9);
    assert.ok(Math.abs(twinkleAt(6, s) - 0.2) < 1e-9);
  });
  test("每 0.1 秒的變化不到一步，慢慢閃的星不會跳", () => {
    for (let t = 0; t < 12; t += 0.1) assert.ok(Math.abs(twinkleAt(t + 0.1, s) - twinkleAt(t, s)) < 0.04);
  });
});

describe("晨昏", () => {
  const at = (h: number, m = 0) => duskTintAt(h * 60 + m);
  test("正午與主題原貌一樣", () => {
    assert.deepEqual(at(12), { dawn: 0, dusk: 0, night: 0 });
  });
  test("清晨與傍晚有色、深夜只有夜色", () => {
    assert.equal(at(7).dawn, 1);
    assert.equal(at(18).dusk, 1);
    assert.equal(at(1).night, 1);
    assert.equal(at(1).dawn, 0);
  });
  test("一步五分鐘變化很小，看不出跳動", () => {
    for (let m = 0; m < 1440; m += 5) {
      const a = duskTintAt(m);
      const b = duskTintAt(m + 5);
      for (const k of ["dawn", "dusk", "night"] as const) {
        assert.ok(Math.abs(a[k] - b[k]) <= 0.09, `${m} 分 ${k}：${a[k]} → ${b[k]}`);
      }
    }
  });
});
