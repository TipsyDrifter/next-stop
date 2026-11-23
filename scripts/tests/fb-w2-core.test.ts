/**
 * 第二梯回饋專卷（eng-tree）完整單元與整合測試：
 *   1. 【操作 4、5、10】quickAdd.ts：`=` 同乘車日、`14:00-15:30` 起訖區間、`@含空白路線/子項`（含 branch/train/car/ticket）
 *   2. 【操作 10】clockSpan.ts：startHm ⇄ endHm ⇄ durationMin 雙向互推、跨午夜與非法擋下理由
 *   3. 【操作 9】batchActions.ts：batchSetDate 同步締切、batchSetDue、batchSetTimeSpan、batchSetStatusAndSeal、
 *      batchSetStation、batchSetRepeat、batchSkip(skip=false) 取消運休，全數附復原測試
 *
 * 跑法：`node --test scripts/tests/fb-w2-core.test.ts`
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const FAKE_DB = `
let t = Date.now();
export function getDb() { throw new Error("測試不碰 SQLite"); }
export function uuid() { return crypto.randomUUID(); }
export function nowUtcIso() { t += 1000; return new Date(t).toISOString(); }
`;
const FAKE_DATA_INDEX = `
export const nodeRepo = new Proxy({}, {
  get(_, prop) {
    const mock = globalThis.__mockNodeRepoW2;
    if (!mock) throw new Error("測試沒設 __mockNodeRepoW2");
    const v = mock[prop];
    return typeof v === "function" ? v.bind(mock) : v;
  }
});
export const settingsRepo = { get: async () => null, set: async () => {} };
export const logRepo = {};
export const syncRepo = {};
export const backupRepo = {};
export const reorderIds = (ids) => ids;
export const SYNC_WRITE_EVENT = "ns:sync-write";
export const parseKeep = () => 10;
export const BACKUP_SETTING_KEYS = {};
export const BACKUP_KEEP_DEFAULT = 10;
export const DEV_FLAGS = { mock: false };
export const MOCK_MODE = false;
export const WIPED_MODE = false;
export const USE_SQLITE = false;
`;
const FAKE_TAG_REPO = `export const tagRepo = { attach: async () => ({}), detach: async () => ({}), undo: async () => {} };`;
const FAKE_MOOD_STORE = `export const useMoodStore = { getState: () => ({ notifyStamped() {} }) };`;
const FAKE_UI_STORE = `
const state = {
  dayStartHour: 6,
  toast: null,
  showToast(t) { state.toast = t; },
  askConfirm(opts) { state.lastConfirm = opts; },
  lastConfirm: null,
};
export const useUiStore = { getState: () => state };
`;
const FAKE_TAG_STORE = `export const useTagStore = { getState: () => ({ loadIndex: async () => {} }) };`;
const FAKE_SELECTION_STORE = `export const useSelectionStore = { getState: () => ({ clear() {} }) };`;
const FAKE_WINDOW_THEME = `export function syncWindowTheme() {}`;
const FAKE_CORE = `export async function invoke() { throw new Error("測試不 invoke"); }`;
const dataUrl = (src: string) => "data:text/javascript," + encodeURIComponent(src);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../src/store/uiStore.ts") {
      return { url: dataUrl(FAKE_UI_STORE), shortCircuit: true };
    }
    const fromSrc = context.parentURL !== undefined && context.parentURL.includes("/src/");
    if (fromSrc) {
      if (specifier === "../lib/db") return { url: dataUrl(FAKE_DB), shortCircuit: true };
      if (specifier === "@tauri-apps/api/core") return { url: dataUrl(FAKE_CORE), shortCircuit: true };
      if (specifier === "../lib/windowTheme") return { url: dataUrl(FAKE_WINDOW_THEME), shortCircuit: true };
      if (specifier === "../data" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_DATA_INDEX), shortCircuit: true };
      }
      if (specifier === "../data/tagRepo" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_TAG_REPO), shortCircuit: true };
      }
      if (specifier === "../ui/ambience/moodStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_MOOD_STORE), shortCircuit: true };
      }
      if (specifier === "./uiStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_UI_STORE), shortCircuit: true };
      }
      if (specifier === "./tagStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_TAG_STORE), shortCircuit: true };
      }
      if (specifier === "./selectionStore" && context.parentURL.includes("/src/store/")) {
        return { url: dataUrl(FAKE_SELECTION_STORE), shortCircuit: true };
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

const { parseQuickAdd, stripTokens } = await import("../../src/domain/quickAdd.ts");
const {
  applyDurationMin,
  applyEndClock,
  applyStartClock,
  deriveClockSpan,
  formatClockSpanSummary,
  parseClockSpanInput,
} = await import("../../src/domain/clockSpan.ts");
const { fixedRule } = await import("../../src/domain/repeat.ts");
const { addDays, todayKey } = await import("../../src/lib/date.ts");
const { MemoryNodeRepository } = await import("../../src/data/memoryRepository.ts");
const { useUiStore } = await import("../../src/store/uiStore.ts");
const {
  batchSetDate,
  batchSetDue,
  batchSetRepeat,
  batchSetStation,
  batchSetStatusAndSeal,
  batchSetTimeSpan,
  batchSkip,
} = await import("../../src/store/batchActions.ts");

const TODAY = "2026-11-20";

const qaCtx = {
  today: TODAY,
  dayStartHour: 6,
  routes: [
    { id: "r1", name: "生活", code: "LIFE" },
    { id: "r2", name: "Work Trip", code: null },
    { id: "r3", name: "日文", code: "JP" },
  ],
  tasksOf: (routeId: string) => {
    if (routeId === "r2") {
      return [
        { id: "b1", name: "Phase 1", kind: "branch" as const },
        { id: "t1", name: "Book Flight", kind: "train" as const },
        { id: "c1", name: "Hotel", kind: "car" as const },
        { id: "k1", name: "Check Passport", kind: "ticket" as const },
      ];
    }
    if (routeId === "r3") {
      return [
        { id: "jb", name: "文法支線", kind: "branch" as const },
        { id: "jk", name: "背單字", kind: "ticket" as const },
      ];
    }
    return [];
  },
};

/* ═════════════════════════════════════════════
 * 1. 【操作 4、5、10】quickAdd.ts 語法升級
 * ═════════════════════════════════════════════ */

describe("1. quickAdd.ts：同乘車日、起訖時間區間與含空白 @路線", () => {
  test("締切同乘車日：支援 =、＝、〆=、締切=、截止=、同乘車日，並與顯式締切互蓋", () => {
    for (const kw of ["=", "＝", "〆=", "締切=", "截止=", "同乘車日"]) {
      const p = parseQuickAdd(`寫作業 明天 ${kw}`, qaCtx);
      assert.equal(p.name, "寫作業", kw);
      assert.equal(p.scheduledOn, "2026-11-21", kw);
      assert.equal(p.dueSameAsScheduled, true, kw);
      assert.equal(p.dueOn, undefined, kw);
      assert.equal(p.tokens.some((t) => t.kind === "due" && t.raw === kw), true, kw);
      assert.equal(stripTokens(`寫作業 ${kw}`, "due", qaCtx), "寫作業", kw);
    }

    // 黏在算式裡不誤認
    const math = parseQuickAdd("整理 1+1=2 筆記", qaCtx);
    assert.equal(math.dueSameAsScheduled, undefined);
    assert.equal(math.name, "整理 1+1=2 筆記");

    // 後寫的蓋過先寫的
    const p1 = parseQuickAdd("寫作業 = 〆11/30", qaCtx);
    assert.equal(p1.dueOn, "2026-11-30");
    assert.equal(p1.dueSameAsScheduled, undefined);

    const p2 = parseQuickAdd("寫作業 〆11/30 =", qaCtx);
    assert.equal(p2.dueSameAsScheduled, true);
    assert.equal(p2.dueOn, undefined);
  });

  test("起訖時間區間：14:00-15:30／~／～／9:30-11:00／23:30-25:00，不誤傷 11-15 日期", () => {
    const cases: [string, string, number][] = [
      ["14:00-15:30", "14:00", 90],
      ["14:00~16:00", "14:00", 120],
      ["14:00～16:00", "14:00", 120],
      ["9:30-11:00", "09:30", 90],
      ["23:30-25:00", "23:30", 90],
      ["23:30-01:00", "23:30", 90],
      ["14點-15點半", "14:00", 90],
    ];
    for (const [raw, time, min] of cases) {
      const p = parseQuickAdd(`專心 ${raw}`, qaCtx);
      assert.equal(p.name, "專心", raw);
      assert.equal(p.scheduledTime, time, raw);
      assert.equal(p.estimateMin, min, raw);
      assert.deepEqual(
        p.tokens,
        [{ kind: "time", start: 3, end: 3 + raw.length, raw }],
        raw,
      );
      assert.equal(stripTokens(`專心 ${raw}`, "time", qaCtx), "專心", raw);
    }

    // 11-15 仍當成日期
    const d = parseQuickAdd("繳費 11-15", qaCtx);
    assert.equal(d.scheduledOn, "2027-11-15");
    assert.equal(d.scheduledTime, undefined);

    // 結束早於開始且不屬合理跨夜：留在名稱裡
    const bad = parseQuickAdd("開會 15:00-14:00", qaCtx);
    assert.equal(bad.scheduledTime, undefined);
    assert.equal(bad.estimateMin, undefined);
    assert.equal(bad.name, "開會 15:00-14:00");
  });

  test("@路線 強化：支援引號／非引號含空白路線名與 @路線/子項（branch/train/car/ticket）", () => {
    const q1 = parseQuickAdd('帶護照 @"Work Trip" 明天', qaCtx);
    assert.equal(q1.name, "帶護照");
    assert.deepEqual(q1.dest, { routeId: "r2", nodeId: null });
    assert.equal(q1.scheduledOn, "2026-11-21");

    const q2 = parseQuickAdd("帶護照 @Work Trip 明天", qaCtx);
    assert.equal(q2.name, "帶護照");
    assert.deepEqual(q2.dest, { routeId: "r2", nodeId: null });

    const q3 = parseQuickAdd('確認機票 @"Work Trip"/"Book Flight"', qaCtx);
    assert.equal(q3.name, "確認機票");
    assert.deepEqual(q3.dest, { routeId: "r2", nodeId: "t1" });

    const q4 = parseQuickAdd('辦手續 @"Work Trip/Phase 1"', qaCtx);
    assert.equal(q4.name, "辦手續");
    assert.deepEqual(q4.dest, { routeId: "r2", nodeId: "b1" });

    const q5 = parseQuickAdd("看書 @Work Trip/Check Passport", qaCtx);
    assert.equal(q5.name, "看書");
    assert.deepEqual(q5.dest, { routeId: "r2", nodeId: "k1" });

    const q6 = parseQuickAdd("練習 @日文/文法支線", qaCtx);
    assert.deepEqual(q6.dest, { routeId: "r3", nodeId: "jb" });

    const q7 = parseQuickAdd("複習 @JP/背單字", qaCtx);
    assert.deepEqual(q7.dest, { routeId: "r3", nodeId: "jk" });

    const miss = parseQuickAdd('x @"No Such Route"', qaCtx);
    assert.equal(miss.dest, undefined);
    assert.equal(miss.name, 'x @"No Such Route"');
  });
});

/* ═════════════════════════════════════════════
 * 2. 【操作 10】clockSpan.ts 雙向連動底座
 * ═════════════════════════════════════════════ */

describe("2. clockSpan.ts：開始 ⇄ 結束 ⇄ 時長雙向互推與跨午夜", () => {
  test("deriveClockSpan 與 formatClockSpanSummary", () => {
    const s = deriveClockSpan("14:00", 90);
    assert.equal(s.ok, true);
    assert.equal(s.startHm, "14:00");
    assert.equal(s.endHm, "15:30");
    assert.equal(s.durationMin, 90);
    assert.equal(s.endNextDayNote, null);

    const late = deriveClockSpan("23:30", 90);
    assert.equal(late.endHm, "25:00");
    assert.equal(late.endNextDayNote, "隔天 01:00");

    assert.equal(formatClockSpanSummary("14:00", 90), "14:00–15:30 · 1h30");
    assert.equal(formatClockSpanSummary("14:00", null), "14:00");
    assert.equal(formatClockSpanSummary(null, 90), "1h30");
    assert.equal(formatClockSpanSummary(null, null), null);
  });

  test("applyStartClock：改開始平移結束（保時長），清空開始保留時長", () => {
    const shifted = applyStartClock({ startHm: "14:00", durationMin: 90 }, "16:30", 6);
    assert.equal(shifted.ok, true);
    assert.equal(shifted.startHm, "16:30");
    assert.equal(shifted.endHm, "18:00");
    assert.equal(shifted.durationMin, 90);

    const cleared = applyStartClock(shifted, "", 6);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.startHm, null);
    assert.equal(cleared.endHm, null);
    assert.equal(cleared.durationMin, 90);

    const invalid = applyStartClock(shifted, "99:99", 6);
    assert.equal(invalid.ok, false);
    assert.ok(invalid.error);
  });

  test("applyDurationMin：有時長正推結束；無開始時刻僅存時長", () => {
    const pushed = applyDurationMin({ startHm: "23:00" }, 150);
    assert.equal(pushed.ok, true);
    assert.equal(pushed.endHm, "25:30");
    assert.equal(pushed.endNextDayNote, "隔天 01:30");

    const noStart = applyDurationMin({ startHm: null }, 45);
    assert.equal(noStart.ok, true);
    assert.equal(noStart.startHm, null);
    assert.equal(noStart.endHm, null);
    assert.equal(noStart.durationMin, 45);

    const cleared = applyDurationMin(pushed, null);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.startHm, "23:00");
    assert.equal(cleared.endHm, null);
    assert.equal(cleared.durationMin, null);
  });

  test("applyEndClock：反推時長、合理跨夜自動換算 24:00+、非法擋下並附理由", () => {
    // 正常同日
    const sameDay = applyEndClock({ startHm: "09:30" }, "11:00", 6);
    assert.equal(sameDay.ok, true);
    assert.equal(sameDay.endHm, "11:00");
    assert.equal(sameDay.durationMin, 90);

    // 日界線 0 時下，22:00 → 01:00 自動跨夜為 25:00 / 180 分
    const crossZero = applyEndClock({ startHm: "22:00" }, "01:00", 0);
    assert.equal(crossZero.ok, true);
    assert.equal(crossZero.endHm, "25:00");
    assert.equal(crossZero.durationMin, 180);
    assert.equal(crossZero.endNextDayNote, "隔天 01:00");

    // 日界線 6 時下，23:30 → 01:00 透過 parseClockInput 直接換成 25:00 / 90 分
    const crossSix = applyEndClock({ startHm: "23:30" }, "01:00", 6);
    assert.equal(crossSix.ok, true);
    assert.equal(crossSix.endHm, "25:00");
    assert.equal(crossSix.durationMin, 90);

    // 無開始時刻先設結束 → 擋下
    const noStart = applyEndClock({ startHm: null }, "15:00", 6);
    assert.equal(noStart.ok, false);
    assert.match(noStart.error ?? "", /開始時刻/);

    // 白天結束早於開始（14:00 → 13:00）→ 擋下不誤當 23h 跨夜
    const earlier = applyEndClock({ startHm: "14:00" }, "13:00", 6);
    assert.equal(earlier.ok, false);
    assert.match(earlier.error ?? "", /早於開始/);

    // 同時刻 → 擋下
    const equal = applyEndClock({ startHm: "14:00" }, "14:00", 6);
    assert.equal(equal.ok, false);

    // parseClockSpanInput
    assert.deepEqual(parseClockSpanInput("14:00-15:30", 6), {
      startHm: "14:00",
      endHm: "15:30",
      durationMin: 90,
    });
  });
});

/* ═════════════════════════════════════════════
 * 3. 【操作 9】batchActions.ts 批量完全體
 * ═════════════════════════════════════════════ */

describe("3. batchActions.ts：全項批量操作與復原", () => {
  async function setup() {
    const repo = new MemoryNodeRepository();
    (globalThis as Record<string, unknown>).__mockNodeRepoW2 = repo;
    const dsh = useUiStore.getState().dayStartHour;
    const dk = todayKey(dsh);
    const line = await repo.create({ kind: "line", name: "幹線", parentId: null });
    const r1 = await repo.create({ kind: "route", name: "日文", parentId: line.id });
    const r2 = await repo.create({ kind: "route", name: "英文", parentId: line.id });
    const s1 = await repo.create({ kind: "station", name: "N3 站", parentId: r1.id });
    const t1 = await repo.create({ kind: "train", name: "文法列車", parentId: r1.id });
    const k1 = await repo.create({ kind: "ticket", name: "同步締切票", parentId: t1.id, scheduledOn: dk, dueOn: dk });
    const k2 = await repo.create({ kind: "ticket", name: "獨立締切票", parentId: r2.id, scheduledOn: dk, dueOn: "2099-12-31" });
    const k3 = await repo.create({ kind: "ticket", name: "無乘車日票", parentId: t1.id });
    return { repo, dk, dsh, r1, r2, s1, t1, k1, k2, k3 };
  }

  async function undoLast() {
    const toast = useUiStore.getState().toast;
    assert.ok(toast?.onAction, "應產出附「復原」按鈕的 toast");
    toast.onAction!();
    await new Promise((r) => setTimeout(r, 15));
  }

  test("batchSetDate：原本 due_on === scheduled_on 的票自動同步推進 due_on，並可復原", async () => {
    const { repo, dk, k1, k2 } = await setup();
    const nextDk = addDays(dk, 5);
    await batchSetDate([k1.id, k2.id], nextDk);
    const after1 = await repo.getNode(k1.id);
    const after2 = await repo.getNode(k2.id);
    assert.equal(after1?.scheduled_on, nextDk);
    assert.equal(after1?.due_on, nextDk, "原本同乘車日者應自動同步締切");
    assert.equal(after2?.scheduled_on, nextDk);
    assert.equal(after2?.due_on, "2099-12-31", "獨立締切者不受影響");

    await undoLast();
    assert.equal((await repo.getNode(k1.id))?.scheduled_on, dk);
    assert.equal((await repo.getNode(k1.id))?.due_on, dk);
  });

  test("batchSetDue：設締切、清締切、同乘車日（跳過無乘車日者）與復原", async () => {
    const { repo, dk, k1, k3 } = await setup();
    const dueDk = addDays(dk, 10);
    await batchSetDue([k1.id, k3.id], dueDk);
    assert.equal((await repo.getNode(k1.id))?.due_on, dueDk);
    assert.equal((await repo.getNode(k3.id))?.due_on, dueDk);

    await batchSetDue([k1.id, k3.id], "sync");
    assert.equal((await repo.getNode(k1.id))?.due_on, dk);
    assert.equal((await repo.getNode(k3.id))?.due_on, dueDk, "無乘車日票應跳過不誤清");
    assert.match(useUiStore.getState().toast?.sub ?? "", /尚未設定乘車日/);

    await undoLast();
    assert.equal((await repo.getNode(k1.id))?.due_on, dueDk);

    await batchSetDue([k1.id], null);
    assert.equal((await repo.getNode(k1.id))?.due_on, null);
  });

  test("batchSetTimeSpan：批量設開始時刻／預計時長、清除與復原", async () => {
    const { repo, k1, k2 } = await setup();
    await batchSetTimeSpan([k1.id, k2.id], { scheduledTime: "14:00", estimateMin: 90 });
    assert.equal((await repo.getNode(k1.id))?.scheduled_time, "14:00");
    assert.equal((await repo.getNode(k2.id))?.estimate_min, 90);

    await undoLast();
    assert.equal((await repo.getNode(k1.id))?.scheduled_time, null);
    assert.equal((await repo.getNode(k2.id))?.estimate_min, null);
  });

  test("batchSetStatusAndSeal：todo / doing / done / uncomplete / paused / unpause 與定期券對齊＋復原", async () => {
    const { repo, dk, dsh, k1, k2, k3 } = await setup();
    await repo.setRepeatRule(k2.id, fixedRule("daily", dk), dk, dsh);

    await batchSetStatusAndSeal([k1.id, k2.id], "doing");
    assert.equal((await repo.getNode(k1.id))?.status, "doing");
    assert.equal((await repo.getNode(k2.id))?.status, "doing");

    await batchSetStatusAndSeal([k1.id, k2.id], "done");
    assert.equal((await repo.getNode(k1.id))?.status, "done");
    assert.equal((await repo.listCurrentOccurrences(dk, dsh))[k2.id]?.status, "done");

    await batchSetStatusAndSeal([k1.id, k2.id], "uncomplete");
    assert.equal((await repo.getNode(k1.id))?.status, "todo");
    assert.equal((await repo.listCurrentOccurrences(dk, dsh))[k2.id], undefined);

    await batchSetStatusAndSeal([k1.id, k3.id], "paused");
    assert.equal((await repo.getNode(k1.id))?.status, "paused");
    assert.equal((await repo.getNode(k3.id))?.status, "paused");

    await batchSetStatusAndSeal([k1.id, k3.id], "unpause");
    assert.equal((await repo.getNode(k1.id))?.status, "todo");
    assert.equal((await repo.getNode(k3.id))?.status, "todo");

    await undoLast();
    assert.equal((await repo.getNode(k1.id))?.status, "paused");
    assert.equal((await repo.getNode(k3.id))?.status, "paused");
  });

  test("batchSetStation：僅指派同路線之車站，跨路線自動跳過並附復原", async () => {
    const { repo, s1, t1, k1, k2 } = await setup();
    await batchSetStation([t1.id, k1.id, k2.id], s1.id);
    assert.equal((await repo.getNode(t1.id))?.station_id, s1.id);
    assert.equal((await repo.getNode(k1.id))?.station_id, s1.id);
    assert.equal((await repo.getNode(k2.id))?.station_id, null, "別條路線的票不可誤掛");
    assert.match(useUiStore.getState().toast?.sub ?? "", /同一條路線/);

    await undoLast();
    assert.equal((await repo.getNode(t1.id))?.station_id, null);
    assert.equal((await repo.getNode(k1.id))?.station_id, null);
  });

  test("batchSetRepeat 與 batchSkip(skip=true/false)：定期規則與批量運休／取消運休＋復原", async () => {
    const { repo, dk, dsh, k1, k2, k3 } = await setup();
    const rule = fixedRule("daily", dk);

    await batchSetRepeat([k1.id, k3.id], rule);
    assert.ok((await repo.getNode(k1.id))?.repeat_rule);
    assert.ok((await repo.getNode(k3.id))?.repeat_rule);

    await undoLast();
    assert.equal((await repo.getNode(k1.id))?.repeat_rule, null);
    assert.equal((await repo.getNode(k3.id))?.scheduled_on, null, "復原時應還原原本無乘車日狀態");

    // 設規則後測運休與批量取消運休
    await batchSetRepeat([k1.id, k2.id], rule);
    await batchSkip([k1.id, k2.id, k3.id], true);
    let occs = await repo.listCurrentOccurrences(dk, dsh);
    assert.equal(occs[k1.id]?.status, "skipped");
    assert.equal(occs[k2.id]?.status, "skipped");
    assert.match(useUiStore.getState().toast?.sub ?? "", /只有定期券能運休/);

    await batchSkip([k1.id, k2.id], false);
    occs = await repo.listCurrentOccurrences(dk, dsh);
    assert.equal(occs[k1.id], undefined);
    assert.equal(occs[k2.id], undefined);

    await undoLast();
    occs = await repo.listCurrentOccurrences(dk, dsh);
    assert.equal(occs[k1.id]?.status, "skipped");
    assert.equal(occs[k2.id]?.status, "skipped");
  });
});
