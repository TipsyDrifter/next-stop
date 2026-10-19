/**
 * 時刻表線③ 沙盒回報 F3：解同步清單名字前先等「同步一趟收完＋serial 佇列清空」（`src/domain/timetableIdle.ts`）。
 * 跑法：`node --test scripts/tests/timetable-idle.test.ts`（node 24，型別剝除；零依賴）。
 *
 * 這裡用一個假的 probe 重演 syncStore.runCycle 的時序：working=true → 先設 status（名字解析此刻開始）→ 隔一段才 reconcile → working=false。
 * 牙齒：沒有等的話，名字解析會在 reconcile 之前讀列（讀到「還活著」）；有等才讀到「已刪除」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { waitTimetableIdle, type IdleProbe } from "../../src/domain/timetableIdle.ts";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 假的 store 環境：working 旗標、serial 鏈 */
function makeEnv() {
  let working = false;
  const subs = new Set<() => void>();
  let chain: Promise<unknown> = Promise.resolve();
  const row = { deleted: false };
  const env = {
    row,
    setWorking(v: boolean) {
      working = v;
      for (const f of Array.from(subs)) f();
    },
    serial<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(fn, fn);
      chain = next.catch(() => undefined);
      return next;
    },
    probe: {
      syncWorking: () => working,
      onSyncChange: (cb) => {
        subs.add(cb);
        return () => void subs.delete(cb);
      },
      chainTail: () => chain,
    } satisfies IdleProbe,
    subCount: () => subs.size,
  };
  return env;
}

describe("waitTimetableIdle（F3）", () => {
  test("同步沒在跑、佇列空 ⇒ 立刻放行", async () => {
    const e = makeEnv();
    await waitTimetableIdle(e.probe);
    assert.equal(e.subCount(), 0);
  });

  test("R1 時序：status 先到、reconcile 晚幾十毫秒才跑 ⇒ 等完才讀列，讀到已刪除", async () => {
    const e = makeEnv();
    e.setWorking(true); // runCycle: working=true
    // refreshStatusInner：status 更新 ⇒ 名字解析此刻開始
    const resolve = (async () => {
      await waitTimetableIdle(e.probe);
      return e.row.deleted; // getBlock 讀列
    })();
    // 之後：node.refresh()（慢）→ reload → serial(reconcile) 把 s 刪掉 → working=false
    await tick(30);
    const rec = e.serial(async () => {
      await tick(10);
      e.row.deleted = true;
    });
    await rec;
    e.setWorking(false);
    assert.equal(await resolve, true, "名字解析要在整理之後讀列");
    assert.equal(e.subCount(), 0, "取消訂閱");
  });

  test("對照（沒等）：直接讀列會讀到還活著——時序確實會撞", async () => {
    const e = makeEnv();
    e.setWorking(true);
    const readNow = e.row.deleted;
    await tick(5);
    await e.serial(async () => {
      e.row.deleted = true;
    });
    assert.equal(readNow, false);
    assert.equal(e.row.deleted, true);
  });

  test("working 已結束但佇列還有寫入 ⇒ 等佇列", async () => {
    const e = makeEnv();
    void e.serial(async () => {
      await tick(20);
      e.row.deleted = true;
    });
    await waitTimetableIdle(e.probe);
    assert.equal(e.row.deleted, true);
  });

  test("等佇列的時候又排進新的 ⇒ 追到尾巴穩定", async () => {
    const e = makeEnv();
    const order: string[] = [];
    void e.serial(async () => {
      await tick(10);
      order.push("a");
      void e.serial(async () => {
        await tick(10);
        order.push("b");
      });
    });
    await waitTimetableIdle(e.probe);
    assert.deepEqual(order, ["a", "b"]);
  });

  test("佇列裡有一項失敗 ⇒ 不卡住", async () => {
    const e = makeEnv();
    void e.serial(async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    await waitTimetableIdle(e.probe);
  });

  test("working 一直不放（別的長動作）⇒ 逾時放行，並取消訂閱", async () => {
    const e = makeEnv();
    e.setWorking(true);
    const t0 = Date.now();
    await waitTimetableIdle(e.probe, { syncTimeoutMs: 40 });
    assert.ok(Date.now() - t0 >= 35);
    assert.equal(e.subCount(), 0);
  });

  test("working 在 true→false→true（rerun）⇒ 第一次放下就放行", async () => {
    const e = makeEnv();
    e.setWorking(true);
    const p = waitTimetableIdle(e.probe);
    e.setWorking(false);
    e.setWorking(true); // rerun 立刻又開始
    await p;
    assert.equal(e.subCount(), 0);
  });
});
