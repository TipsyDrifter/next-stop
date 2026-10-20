// 磨光①「手機返回鍵」・返回堆疊純邏輯單元測試（契約 docs/research/2026-10-20-主線-磨光①手機殼-契約.md §1、§5、§9.1）
// 跑法：node --test scripts/tests/back-stack.test.ts（node 24 直接剝除型別；不進 tsc——tsconfig 只 include src）
// 只 import backStackCore.ts（不碰 React、store、Tauri）。原生橋接用假的 register／時鐘／計時器注入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { BackStack, BackBridge, BACK_GRACE_MS } from "../../src/ui/mobile/backStackCore.ts";
import type { BackBridgeDeps, BackListener } from "../../src/ui/mobile/backStackCore.ts";

/* ───────────── 假的原生端：時鐘、計時器、register ───────────── */

interface FakeListener {
  /** 被拆了幾次（每個物件應該剛好一次） */
  unregistered: number;
  /** register 的 promise 還沒 resolve */
  pending: boolean;
  resolve(): void;
}

function harness(opts: { manual?: boolean; tab?: () => (() => void) | null } = {}) {
  let now = 0;
  let tid = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners: FakeListener[] = [];

  const deps: BackBridgeDeps = {
    register() {
      let resolveFn: (l: BackListener) => void = () => {};
      const p = new Promise<BackListener>((res) => (resolveFn = res));
      const rec: FakeListener = {
        unregistered: 0,
        pending: true,
        resolve() {
          if (!rec.pending) return;
          rec.pending = false;
          resolveFn({ unregister: () => void rec.unregistered++ });
        },
      };
      listeners.push(rec);
      if (!opts.manual) rec.resolve();
      return p;
    },
    now: () => now,
    setTimer(fn, ms) {
      const id = ++tid;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(t) {
      timers.delete(t as number);
    },
  };

  const stack = new BackStack();
  const bridge = new BackBridge(stack, deps);
  // 同 backStack.ts 的 useAndroidBack：堆疊一變就 reconcile
  stack.subscribe(() => bridge.reconcile());
  if (opts.tab) bridge.setTabRule(opts.tab);

  /** 時間往前走；到期的計時器依序觸發 */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = until;
  };
  /** 讓 register 的 then 跑完 */
  const flush = () => new Promise<void>((r) => setImmediate(r));
  /** 「掛著而且已經 resolve、還沒被拆」的監聽數 */
  const live = () => listeners.filter((l) => !l.pending && l.unregistered === 0).length;
  /** 開一層，關法照 React 的時序（onBack 設狀態 ⇒ 下一次 commit 的 effect cleanup 才放掉） */
  const open = (id: string, kind: Kind) => openLayer(stack, id, kind, undefined, true);
  /** 按一下返回，等這一下引起的卸載跑完 */
  const press = async () => {
    const r = bridge.handle();
    await flush();
    return r;
  };

  return { stack, bridge, listeners, timers, advance, flush, live, open, press };
}

type Kind = "page" | "sheet" | "full" | "dialog";

/**
 * 開一層：onBack＝關掉自己（同各元件的取消把 active 設回 false ⇒ 鉤子放掉）。
 * `deferRelease`：放掉延到 microtask——真實元件的 onBack 只是設狀態，useBackLayer 的 cleanup 在 React commit 之後才跑，
 *   不會在 `handle()` 呼叫 onBack 的當下同步回頭改堆疊。
 */
function openLayer(stack: InstanceType<typeof BackStack>, id: string, kind: Kind, log?: string[], deferRelease = false) {
  const release = stack.push(id, kind, () => {
    log?.push(id);
    if (deferRelease) queueMicrotask(release);
    else release();
  });
  return release;
}

/* ───────────── BackStack：排序、refcount ───────────── */

test("權重排序：page 先開、sheet 後開、dialog 最上；後開的 page 也壓不過 sheet", () => {
  const s = new BackStack();
  const log: string[] = [];
  openLayer(s, "core.schedule", "page", log);
  openLayer(s, "core.todaySheet", "sheet", log);
  openLayer(s, "core.confirm", "dialog", log);
  openLayer(s, "notes.notePage", "page", log); // 最後開的子頁
  assert.deepEqual(
    s.list().map((l) => l.id),
    ["core.schedule", "notes.notePage", "core.todaySheet", "core.confirm"],
  );
  assert.equal(s.top()?.id, "core.confirm");
  assert.equal(s.popTop(), "core.confirm");
  assert.equal(s.popTop(), "core.todaySheet");
  assert.equal(s.popTop(), "notes.notePage", "同為 page：後開的先關");
  assert.equal(s.popTop(), "core.schedule");
  assert.equal(s.popTop(), null);
  assert.deepEqual(log, ["core.confirm", "core.todaySheet", "notes.notePage", "core.schedule"]);
});

test("full 在 sheet 之上、dialog 之下", () => {
  const s = new BackStack();
  openLayer(s, "ticket.form", "full");
  openLayer(s, "ticket.office.sheet", "sheet"); // 後開，但權重低
  assert.equal(s.top()?.id, "ticket.form");
  openLayer(s, "ticket.form.pick", "dialog");
  assert.equal(s.top()?.id, "ticket.form.pick");
});

test("同種類比序號：後開的在上；放掉上面那層，下面那層回到頂", () => {
  const s = new BackStack();
  const releaseA = openLayer(s, "timetable.sheet", "sheet");
  const releaseB = openLayer(s, "notes.tagPicker", "sheet");
  assert.equal(s.top()?.id, "notes.tagPicker");
  releaseB();
  assert.equal(s.top()?.id, "timetable.sheet");
  releaseA();
  assert.equal(s.top(), null);
  assert.equal(s.size, 0);
});

test("refcount：同 id 兩個登記合併成一層；放掉一個還在；onBack 用最後登記的那一個", () => {
  const s = new BackStack();
  const calls: string[] = [];
  const r1 = s.push("timetable.sheet", "sheet", () => calls.push("hostA"));
  const r2 = s.push("timetable.sheet", "sheet", () => calls.push("hostB"));
  assert.equal(s.size, 1);
  s.popTop();
  assert.deepEqual(calls, ["hostB"]);
  r2();
  assert.equal(s.size, 1, "還有一個登記者");
  s.popTop();
  assert.deepEqual(calls, ["hostB", "hostA"]);
  r2(); // 重複放掉同一個：不影響別人
  assert.equal(s.size, 1);
  r1();
  assert.equal(s.size, 0);
});

test("refcount（A-2 換手）：同 id 新登記者接手時序號保留最早，不會跳到疊在上面的挑選器之上", () => {
  const s = new BackStack();
  const hostA = s.push("timetable.sheet", "sheet", () => {});
  openLayer(s, "notes.tagPicker", "sheet"); // 疊在時刻表面板上的挑選器
  const hostB = s.push("timetable.sheet", "sheet", () => {}); // 切 tab：另一個 host 掛上
  hostA(); // 舊 host 卸載
  assert.equal(s.size, 2);
  assert.equal(s.top()?.id, "notes.tagPicker", "面板保留最早序號，挑選器仍在上面");
  assert.equal(s.popTop(), "notes.tagPicker");
  assert.equal(s.top()?.id, "timetable.sheet");
  hostB();
  assert.equal(s.size, 0);
});

test("吞掉：onBack 什麼都不做 ⇒ 層還在、每一下返回都被它擋住", () => {
  const s = new BackStack();
  s.push("core.recovery", "dialog", () => {});
  for (let i = 0; i < 3; i++) assert.equal(s.popTop(), "core.recovery");
  assert.equal(s.size, 1);
});

/* ───────────── BackBridge：tab 規則、寬限、監聽掛拆 ───────────── */

test("tabRule 只在堆疊空時用（A-1）：子頁與 tab 同時，返回先關子頁、再回今日", async () => {
  let tab = "notes";
  const toToday: string[] = [];
  const h = harness({ tab: () => (tab === "today" ? null : () => (toToday.push(tab), (tab = "today"))) });
  // 同一個 commit 切 tab＋開子頁（荷札頁跳轉）
  h.open("notes.tagPage", "page");
  h.bridge.reconcile();
  await h.flush();
  assert.equal(h.live(), 1);
  assert.equal(await h.press(), "layer:notes.tagPage");
  assert.deepEqual(toToday, [], "第一下關的是子頁，不是回今日");
  assert.equal(await h.press(), "tab");
  assert.deepEqual(toToday, ["notes"]);
  assert.equal(tab, "today");
});

test("在今日、堆疊空：不掛監聽（返回交還 Android＝退到背景）", async () => {
  const h = harness({ tab: () => null });
  h.bridge.reconcile();
  await h.flush();
  assert.equal(h.listeners.length, 0);
  assert.equal(h.bridge.listening, false);
});

test("寬限內吞掉、寬限外拆監聽", async () => {
  const h = harness({ tab: () => null });
  h.open("core.todaySheet", "sheet");
  await h.flush();
  assert.equal(h.live(), 1);

  assert.equal(await h.press(), "layer:core.todaySheet"); // t=0 關面板
  assert.equal(h.stack.size, 0);
  h.advance(200);
  assert.equal(await h.press(), "swallow", "連按的第二下（200ms）被吞掉");
  assert.equal(h.live(), 1, "寬限內監聽還掛著");

  h.advance(BACK_GRACE_MS - 200 - 1);
  assert.equal(h.live(), 1, "寬限最後 1ms 還掛著");
  h.advance(1);
  assert.equal(h.live(), 0, "寬限一過就拆");
  assert.equal(h.listeners[0].unregistered, 1);
  assert.equal(h.bridge.listening, false, "再按＝Android 預設（退到背景）");
});

test("吞掉不延長寬限：狂按也只多等寬限那麼久", async () => {
  const h = harness({ tab: () => null });
  h.open("core.todaySheet", "sheet");
  await h.flush();
  await h.press(); // t=0
  for (let i = 0; i < 6; i++) {
    h.advance(50);
    if (h.bridge.listening) assert.equal(await h.press(), "swallow");
  }
  assert.equal(h.bridge.listening, true, "300ms 時還在寬限內");
  h.advance(BACK_GRACE_MS);
  assert.equal(h.bridge.listening, false);
});

test("回今日（tab）也算一個動作：之後一樣有寬限", async () => {
  let tab = "routemap";
  const h = harness({ tab: () => (tab === "today" ? null : () => (tab = "today")) });
  h.bridge.reconcile();
  await h.flush();
  assert.equal(h.live(), 1, "不在今日 ⇒ 掛著");
  assert.equal(await h.press(), "tab");
  h.advance(100);
  assert.equal(await h.press(), "swallow");
  h.advance(BACK_GRACE_MS);
  assert.equal(h.live(), 0);
});

test("register 還沒 resolve 就不要了 ⇒ resolve 後自動 unregister", async () => {
  const h = harness({ manual: true, tab: () => null });
  const release = openLayer(h.stack, "core.confirm", "dialog");
  assert.equal(h.listeners.length, 1);
  assert.equal(h.listeners[0].pending, true);
  release(); // 掛到一半就關了（沒有按過返回 ⇒ 不等寬限）
  h.advance(0);
  assert.equal(h.bridge.listening, false);
  h.listeners[0].resolve();
  await h.flush();
  assert.equal(h.listeners[0].unregistered, 1, "晚到的監聽自己拆掉");
  assert.equal(h.live(), 0);
});

test("register 在寬限計時中才 resolve ⇒ 計時到了照樣拆", async () => {
  const h = harness({ manual: true, tab: () => null });
  h.open("core.todaySheet", "sheet");
  await h.press(); // 監聽還沒 resolve 就收到事件（測試直接叫）：關掉那層、開始寬限
  assert.equal(h.listeners[0].pending, true);
  h.listeners[0].resolve();
  await h.flush();
  assert.equal(h.live(), 1);
  h.advance(BACK_GRACE_MS);
  assert.equal(h.live(), 0);
  assert.equal(h.listeners[0].unregistered, 1);
});

test("寬限中又開新層（A-3）⇒ 計時取消、監聽保留、不重掛", async () => {
  const h = harness({ tab: () => null });
  h.open("core.todaySheet", "sheet");
  await h.flush();
  await h.press(); // 關面板，開始寬限
  assert.equal(h.timers.size, 1);
  h.advance(100);
  h.open("core.confirm", "dialog"); // 寬限中又開
  assert.equal(h.timers.size, 0, "計時取消");
  h.advance(BACK_GRACE_MS * 3);
  await h.flush();
  assert.equal(h.listeners.length, 1, "沿用同一個監聽，沒有再 register");
  assert.equal(h.live(), 1);
  assert.equal(await h.press(), "layer:core.confirm");
});

test("每次掛的監聽物件各自被拆（不會拆錯、不會拆兩次）", async () => {
  const h = harness({ tab: () => null });
  for (let i = 0; i < 3; i++) {
    h.open(`core.sheet${i}`, "sheet");
    await h.flush();
    await h.press();
    h.advance(BACK_GRACE_MS);
    await h.flush();
  }
  assert.equal(h.listeners.length, 3);
  assert.deepEqual(
    h.listeners.map((l) => l.unregistered),
    [1, 1, 1],
  );
});

test("交錯 resolve：被放棄的舊監聽晚到也只拆它自己，新監聽留著", async () => {
  const h = harness({ manual: true, tab: () => null });
  const r1 = openLayer(h.stack, "core.a", "sheet");
  r1();
  h.advance(0); // 第一次：掛到一半就不要了
  h.open("core.b", "sheet"); // 第二次：重新 register
  assert.equal(h.listeners.length, 2);
  h.listeners[1].resolve(); // 新的先到
  await h.flush();
  h.listeners[0].resolve(); // 舊的晚到
  await h.flush();
  assert.equal(h.listeners[0].unregistered, 1, "舊的被拆");
  assert.equal(h.listeners[1].unregistered, 0, "新的留著");
  assert.equal(h.live(), 1);
  assert.equal(await h.press(), "layer:core.b");
});

// onBack 若「同步」放掉自己那層（例：onBack 直接叫 release，或日後某層用同步卸載），popTop 裡就會 release → emit → reconcile；
//   handle() 要先記 lastAction 再 popTop，寬限才從這一下算，不會當場拆監聽、連按第二下退到背景。
test("同步放掉層也要有寬限", async () => {
  const h = harness({ tab: () => null });
  openLayer(h.stack, "core.todaySheet", "sheet"); // onBack 同步 release
  await h.flush();
  h.bridge.handle();
  h.advance(100);
  assert.equal(h.bridge.listening, true);
});
