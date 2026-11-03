/**
 * 手機連線探針的判斷（`scripts/verify/adb-probe-core.mjs`）。
 * 跑法：`node --test scripts/tests/adb-probe.test.ts`（零依賴；不叫 adb）。
 *
 * 背景（接縫 #106）：10-25 探針拿 adb.log 裡 10-24 21:47 已經解決的拒絕當現行證據判 pair-broken，
 * 使用者白做一次配對。log 行取自那天的真實 adb.log。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, currentReject, parseKeepAdbDump, localIso, shortAt, lastKnownRecord, compareWithLast } from "../verify/adb-probe-core.mjs";

const REJECT_1024 = "10-24 21:47:03.023 57988 58228 E adb     : tls_connection.cpp:290 [client]: Post-handshake SSL_peek failed [SSLV3_ALERT_CERTIFICATE_UNKNOWN]";
const PAIR_FAIL = "10-24 21:48:47.190 57988 64272 E adb     : tls_connection.cpp:278 [client]: Handshake failed in SSL_accept/SSL_connect [invalid library (0)]";
const OK_1024 = "10-24 21:48:47.391 57988 69296 I adb     : tls_connection.cpp:298 [client]: Handshake succeeded.";
const DROP_1025 = "10-25 12:24:27.346 57988 21432 E adb     : transport.cpp:1222 adb-WKFQUOMFUKPJSOXO-ihmZBs._adb-tls-connect._tcp: connection terminated: read failed";
const REJECT_LATER = "10-26 09:00:00.000 1 2 E adb     : tls_connection.cpp:290 [client]: Post-handshake SSL_peek failed [SSLV3_ALERT_CERTIFICATE_UNKNOWN]";

const ON_NET = "adb-WKFQUOMFUKPJSOXO-ihmZBs\t_adb-tls-connect._tcp\t192.168.1.188:40489";
const NO_DEV = "List of devices attached\n";

describe("currentReject：只認最後一次握手成功之後的拒絕", () => {
  test("10-25 的實況：拒絕之後重配成功、再斷線 ⇒ 沒有現行拒絕", () => {
    assert.equal(currentReject([REJECT_1024, PAIR_FAIL, OK_1024, DROP_1025].join("\n")), null);
  });
  test("成功之後又被拒 ⇒ 是現行拒絕，回最後那筆", () => {
    assert.equal(currentReject([REJECT_1024, OK_1024, REJECT_LATER].join("\n")), REJECT_LATER);
  });
  test("從沒成功過、只有拒絕 ⇒ 是現行拒絕（10-24 那次真的掉配對）", () => {
    assert.equal(currentReject([REJECT_1024, REJECT_1024].join("\r\n")), REJECT_1024);
  });
  test("空 log", () => assert.equal(currentReject(""), null));
});

describe("classify", () => {
  test("10-25 19:49 的情況：在網路上、只有舊拒絕 ⇒ on-network-not-attached（不是 pair-broken）", () => {
    const r = classify({ devices: NO_DEV, mdns: ON_NET, log: [REJECT_1024, OK_1024, DROP_1025].join("\n") });
    assert.equal(r.state, "on-network-not-attached");
  });
  test("在網路上＋現行拒絕 ⇒ pair-broken，附證據", () => {
    const r = classify({ devices: NO_DEV, mdns: ON_NET, log: [OK_1024, REJECT_LATER].join("\n") });
    assert.equal(r.state, "pair-broken");
    assert.equal(r.evidence, REJECT_LATER);
  });
  test("不在網路上 ⇒ unreachable（就算 log 有現行拒絕）", () => {
    assert.equal(classify({ devices: NO_DEV, mdns: "", log: REJECT_LATER }).state, "unreachable");
  });
  test("只有 AVD 模擬器 ⇒ 不算手機連上", () => {
    const devices = NO_DEV + "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:2\n";
    assert.equal(classify({ devices, mdns: "", log: "" }).state, "unreachable");
  });
  test("手機和模擬器都在 ⇒ connected，序號是手機的", () => {
    const devices = NO_DEV + "emulator-5554 device product:x transport_id:2\n192.168.1.188:40489    device product:goya_global model:25069PTEBG transport_id:5\n";
    const r = classify({ devices, mdns: ON_NET, log: "" });
    assert.equal(r.state, "connected");
    assert.equal(r.serial, "192.168.1.188:40489");
  });
});

// ── KeepADB 強制停止旗標（2026-11-02）──────────────────────────────────────────
const USER0_OK = "    User 0: ceDataInode=12345 installed=true hidden=false suspended=false distractionFlags=0 stopped=false notLaunched=false enabled=0 instant=false virtual=false";
const USER0_STOPPED = "    User 0: ceDataInode=0 installed=true hidden=false suspended=false distractionFlags=0 stopped=true notLaunched=true enabled=0 instant=false virtual=false";
const dump = (u: string) => ["Packages:", "  Package [de.hohnepeople.keepadb] (abc123):", "    userId=10290", "    versionName=1.8.38", "  User 0 header", u, "    gids=[3003]"].join("\r\n");

describe("parseKeepAdbDump", () => {
  test("stopped=false notLaunched=false", () => {
    const r = parseKeepAdbDump(dump(USER0_OK));
    assert.equal(r.stopped, false);
    assert.equal(r.notLaunched, false);
    assert.equal(r.error, undefined);
    assert.equal(r.raw, USER0_OK.trim());
  });
  test("stopped=true notLaunched=true（強制停止後的樣子）", () => {
    const r = parseKeepAdbDump(dump(USER0_STOPPED));
    assert.equal(r.stopped, true);
    assert.equal(r.notLaunched, true);
  });
  test("stopped 與 notLaunched 可以不同", () => {
    const r = parseKeepAdbDump(dump("    User 0: installed=true stopped=true notLaunched=false enabled=0"));
    assert.deepEqual([r.stopped, r.notLaunched], [true, false]);
  });
  test("套件不存在 ⇒ stopped:null 加 error", () => {
    const r = parseKeepAdbDump("Unable to find package: de.hohnepeople.keepadb\n");
    assert.equal(r.stopped, null);
    assert.ok(r.error);
  });
  test("沒有 User 0 那行（只有 User 10 之類）⇒ stopped:null", () => {
    const r = parseKeepAdbDump(dump("    User 10: installed=true stopped=true notLaunched=false"));
    assert.equal(r.stopped, null);
    assert.ok(r.error);
  });
  test("User 0 那行沒有 stopped= ⇒ stopped:null，但 raw 還在", () => {
    const r = parseKeepAdbDump(dump("    User 0: installed=true"));
    assert.equal(r.stopped, null);
    assert.equal(r.raw, "User 0: installed=true");
  });
  test("空輸出／undefined 不炸", () => {
    assert.equal(parseKeepAdbDump("").stopped, null);
    assert.equal(parseKeepAdbDump(undefined as unknown as string).stopped, null);
  });
});

describe("localIso／shortAt", () => {
  test("本地時間 ISO 帶偏移，且 shortAt 取 MM-DD HH:mm", () => {
    const iso = localIso(new Date(2026, 10, 2, 21, 18, 3));
    assert.match(iso, /^2026-11-02T21:18:03[+-]\d{2}:\d{2}$/);
    assert.equal(shortAt(iso), "11-02 21:18");
  });
  test("shortAt 遇到壞值原樣回", () => assert.equal(shortAt("亂碼"), "亂碼"));
});

describe("lastKnownRecord", () => {
  const rec = (at: string, stopped: boolean | null) => JSON.stringify({ at, serial: "x", stopped, notLaunched: false, raw: "" });
  test("取最後一筆有布林 stopped 的；壞行與 null 略過", () => {
    const text = [rec("2026-11-02T20:00:00+08:00", false), "{壞掉", rec("2026-11-02T21:00:00+08:00", true), rec("2026-11-02T21:30:00+08:00", null), ""].join("\n");
    assert.equal(lastKnownRecord(text)?.at, "2026-11-02T21:00:00+08:00");
  });
  test("空／沒有可用紀錄 ⇒ null", () => {
    assert.equal(lastKnownRecord(""), null);
    assert.equal(lastKnownRecord(rec("2026-11-02T20:00:00+08:00", null)), null);
  });
});

describe("compareWithLast", () => {
  const at1 = "2026-11-02T21:18:03+08:00";
  const at2 = "2026-11-03T09:05:40+08:00";
  const last = (stopped: boolean) => ({ at: at1, stopped });
  const now = (stopped: boolean | null, error?: string) => ({ at: at2, serial: "x", stopped, notLaunched: null, raw: "", ...(error ? { error } : {}) });
  test("跟上次一樣 ⇒ 一行、沒有警告", () => {
    const r = compareWithLast(now(false), last(false));
    assert.equal(r.line, "KeepADB：stopped=false（上次 11-02 21:18 也是 false）");
    assert.equal(r.warning, null);
  });
  test("false→true ⇒ 警告夾出兩次探測的時間", () => {
    const r = compareWithLast(now(true), last(false));
    assert.equal(r.line, "KeepADB：stopped=true（上次 11-02 21:18 是 false）");
    assert.equal(r.warning, "⚠ 在 11-02 21:18 與 11-03 09:05 之間被強制停止");
  });
  test("true→false ⇒ 提示恢復，不是強制停止警告", () => {
    const r = compareWithLast(now(false), last(true));
    assert.ok(r.warning && !r.warning.includes("被強制停止"));
  });
  test("一直是 true ⇒ 沒有新警告（時間點早已夾出）", () => {
    assert.equal(compareWithLast(now(true), last(true)).warning, null);
  });
  test("沒有上次紀錄 ⇒ 說沒有上次、沒有警告", () => {
    const r = compareWithLast(now(true), null);
    assert.equal(r.line, "KeepADB：stopped=true（沒有上次紀錄）");
    assert.equal(r.warning, null);
  });
  test("這次讀不到 ⇒ 說讀不到與原因，沒有警告", () => {
    const r = compareWithLast(now(null, "dumpsys 失敗：ETIMEDOUT"), last(false));
    assert.match(r.line, /讀不到 stopped 旗標.*ETIMEDOUT/);
    assert.equal(r.warning, null);
  });
});
