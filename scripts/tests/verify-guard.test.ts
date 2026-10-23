/**
 * 真機代驗護欄的閒置守衛（`scripts/verify/idle-gate.mjs`、`idle-reader.mjs`、`guard-state.mjs`）。
 * 跑法：`node --test scripts/tests/verify-guard.test.ts`（node 24，型別剝除；零依賴；不連 CDP、不開 App、不起 PowerShell）。
 *
 * 背景：磨光⑦ 真機代驗，護欄不分是誰送的寫入一律擋，使用者回到桌機換車兩次都沒存進去（docs/經驗筆記.md〈【事故】…〉）。
 * 牙齒：把「掉到門檻下就解除」「滿門檻才重上」「重上前要新指紋」任何一條拿掉，對應的測試會紅。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { createIdleGate } from "../verify/idle-gate.mjs";
import { parseIdleLine, startIdleReader } from "../verify/idle-reader.mjs";
import { checkGuard, writeState } from "../verify/guard-state.mjs";

/** 把一串閒置秒數依序餵進去，回傳每一步的 action（方便斷言整段時序） */
function run(gate: ReturnType<typeof createIdleGate>, samples: Array<number | null>) {
  return samples.map((s) => gate.step(s).action);
}
/** 讓 gate 走到 armed（第一份基準指紋） */
function armed(opts = {}) {
  const g = createIdleGate(opts);
  assert.equal(g.step(500).action, "rearm");
  g.confirmArmed({ fingerprint: { n: 1 } });
  assert.equal(g.state, "armed");
  return g;
}

describe("idle-gate：解除", () => {
  test("護欄開著，閒置掉到 5 秒以下就 disarm，並記一次「使用者回來」", () => {
    const g = armed();
    assert.deepEqual(run(g, [300, 120, 30, 6, 5]), ["none", "none", "none", "none", "none"]); // 5 秒整數還算不在
    assert.equal(g.step(4).action, "disarm");
    assert.equal(g.state, "paused");
    assert.equal(g.userBackCount, 1);
  });
  test("門檻可調：userBackBelow=30 時 29 秒就解除", () => {
    const g = armed({ userBackBelow: 30, rearmAfter: 300 });
    assert.equal(g.step(31).action, "none");
    assert.equal(g.step(29).action, "disarm");
  });
  test("disarm 只回一次：已經 paused 再餵低閒置不重複觸發", () => {
    const g = armed();
    assert.equal(g.step(0).action, "disarm");
    assert.deepEqual(run(g, [0, 1, 2, 3]), ["none", "none", "none", "none"]);
    assert.equal(g.userBackCount, 1);
  });
  test("量不到閒置（null／NaN／負數）當使用者在：護欄開著就解除", () => {
    for (const bad of [null, Number.NaN, -1]) {
      const g = armed();
      const r = g.step(bad as number);
      assert.equal(r.action, "disarm");
      assert.equal(r.reason, "idle-unknown");
      assert.equal(g.state, "paused");
    }
  });
});

describe("idle-gate：重上", () => {
  test("解除後要再閒置滿 120 秒才 rearm；119 秒不行", () => {
    const g = armed();
    g.step(2); // 使用者回來
    assert.deepEqual(run(g, [3, 10, 60, 119]), ["none", "none", "none", "none"]);
    assert.equal(g.state, "paused");
    const r = g.step(120);
    assert.equal(r.action, "rearm");
    assert.equal(r.needFingerprint, true);
    assert.equal(g.state, "rearming");
  });
  test("重上必須帶新指紋：不帶、或拿上一份基準交差都丟錯，狀態不變", () => {
    const g = armed();
    const first = g.baseline;
    g.step(1);
    g.step(200);
    assert.throws(() => g.confirmArmed(), /fresh fingerprint/);
    assert.throws(() => g.confirmArmed({ fingerprint: null as never }), /fresh fingerprint/);
    assert.throws(() => g.confirmArmed({ fingerprint: first }), /previous baseline/);
    assert.equal(g.state, "rearming");
    g.confirmArmed({ fingerprint: { n: 2 } });
    assert.equal(g.state, "armed");
    assert.deepEqual(g.baseline, { n: 2 });
  });
  test("沒有進 rearming 就 confirmArmed 會丟錯（不能不等閒置就把護欄標成開著）", () => {
    const g = createIdleGate();
    assert.throws(() => g.confirmArmed({ fingerprint: { n: 1 } }), /not rearming/);
    g.step(60); // 不到 120
    assert.throws(() => g.confirmArmed({ fingerprint: { n: 1 } }), /not rearming/);
  });
  test("上護欄做到一半使用者回來：abort，回 paused，要重新等滿門檻", () => {
    const g = createIdleGate();
    assert.equal(g.step(130).action, "rearm");
    const r = g.step(0);
    assert.equal(r.action, "abort");
    assert.equal(g.state, "paused");
    assert.throws(() => g.confirmArmed({ fingerprint: { n: 1 } }), /not rearming/);
    assert.equal(g.userBackCount, 0); // 還沒開過，不算「護欄擋了使用者」
    assert.equal(g.step(100).action, "none");
    assert.equal(g.step(121).action, "rearm");
  });
  test("取指紋失敗：abortArm 回 paused，下一筆達標再重試", () => {
    const g = createIdleGate();
    assert.equal(g.step(200).action, "rearm");
    g.abortArm();
    assert.equal(g.state, "paused");
    assert.equal(g.step(201).action, "rearm");
  });
  test("啟動時護欄是關的：第一次也要閒置滿門檻才上", () => {
    const g = createIdleGate();
    assert.equal(g.state, "paused");
    assert.deepEqual(run(g, [0, 30, 119]), ["none", "none", "none"]);
    assert.equal(g.step(120).action, "rearm");
  });
  test("整段時序：上→回來→等→重上（兩份基準不同）→再回來", () => {
    const g = createIdleGate();
    const acts = run(g, [150]);
    g.confirmArmed({ fingerprint: { n: 1 } });
    acts.push(...run(g, [160, 3, 4, 50, 130]));
    g.confirmArmed({ fingerprint: { n: 2 } });
    acts.push(...run(g, [140, 1]));
    assert.deepEqual(acts, ["rearm", "none", "disarm", "none", "none", "rearm", "none", "disarm"]);
    assert.equal(g.userBackCount, 2);
    assert.deepEqual(g.baseline, { n: 2 });
  });
  test("設定不合理（重上門檻不大於解除門檻）直接丟錯", () => {
    assert.throws(() => createIdleGate({ userBackBelow: 10, rearmAfter: 10 }));
  });
});

describe("idle-reader", () => {
  test("parseIdleLine：IDLE 12 → 12；-1（API 失敗）與雜訊 → null", () => {
    assert.equal(parseIdleLine("IDLE 12"), 12);
    assert.equal(parseIdleLine("IDLE 0\r"), 0);
    assert.equal(parseIdleLine("IDLE -1"), null);
    assert.equal(parseIdleLine("IDLE"), null);
    assert.equal(parseIdleLine("warning: x"), null);
  });
  test("讀值串流：分段到達的資料能拼回整行，每行一筆樣本", () => {
    const samples: Array<number | null> = [];
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const spawnFn = () => child;
    const r = startIdleReader({ onSample: (s: number | null) => samples.push(s), spawnFn: spawnFn as never });
    child.stdout.emit("data", Buffer.from("IDLE 1"));
    child.stdout.emit("data", Buffer.from("2\r\nIDLE 3\r\nIDLE -1\r\nIDLE 7"));
    child.stdout.emit("data", Buffer.from("\r\n"));
    r.stop();
    assert.deepEqual(samples, [12, 3, null, 7]);
  });
});

describe("guard-state：步驗腳本停手的依據", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-test-"));
  const file = path.join(dir, "state.json");
  const alive = process.pid;
  test("護欄 armed → 兩種模式都放行", () => {
    writeState({ pid: alive, state: "armed" }, file);
    assert.equal(checkGuard("armed", file).ok, true);
    assert.equal(checkGuard("not-paused", file).ok, true);
  });
  test("護欄 paused（使用者回來了）→ 兩種模式都停手，理由帶閒置秒數", () => {
    writeState({ pid: alive, state: "paused", reason: "user-back", idleSec: 2 }, file);
    for (const mode of ["armed", "not-paused"] as const) {
      const r = checkGuard(mode, file);
      assert.equal(r.ok, false);
      assert.match(r.reason, /paused/);
      assert.match(r.reason, /2 秒/);
    }
    writeState({ pid: alive, state: "rearming" }, file);
    assert.equal(checkGuard("armed", file).ok, false);
  });
  test("沒有旗標檔：只讀可以，會送真輸入的流程不行", () => {
    const none = path.join(dir, "nope.json");
    assert.equal(checkGuard("not-paused", none).ok, true);
    assert.equal(checkGuard("armed", none).ok, false);
  });
  test("旗標檔的 pid 已經不在（護欄被砍）：當作沒有護欄，不讓殘檔卡死後面的人", () => {
    writeState({ pid: 2 ** 22 + 12345, state: "paused" }, file);
    assert.equal(checkGuard("not-paused", file).ok, true);
    assert.equal(checkGuard("armed", file).ok, false);
  });
  test("CDP_NO_GUARD=1（獨立 identifier 沙盒）略過檢查", () => {
    writeState({ pid: alive, state: "paused" }, file);
    process.env.CDP_NO_GUARD = "1";
    try { assert.equal(checkGuard("armed", file).ok, true); } finally { delete process.env.CDP_NO_GUARD; }
  });
});
