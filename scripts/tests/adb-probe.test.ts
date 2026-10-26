/**
 * 手機連線探針的判斷（`scripts/verify/adb-probe-core.mjs`）。
 * 跑法：`node --test scripts/tests/adb-probe.test.ts`（零依賴；不叫 adb）。
 *
 * 背景（接縫 #106）：10-25 探針拿 adb.log 裡 10-24 21:47 已經解決的拒絕當現行證據判 pair-broken，
 * 使用者白做一次配對。log 行取自那天的真實 adb.log。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, currentReject } from "../verify/adb-probe-core.mjs";

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
