/**
 * ticketLock.test.ts——售票口 v1.33（3B G5 隱私遮罩與 4 碼帳本鎖 PIN 雜湊）純函式單元測試。
 * 執行：`node --test "src/domain/ticketLock.test.ts"`
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPinHashRecord,
  generatePinSalt,
  hasPinRecord,
  isValidPin,
  normalizePinDigits,
  parsePinHashRecord,
  parsePrivacyMasked,
  serializePrivacyMasked,
  sha256Hex,
  verifyPin,
} from "./ticketLock.ts";

test("3B-G5 — sha256Hex 符合 NIST FIPS 180-4 標準向量（含空字串、單區塊與跨區塊）", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("3B-G5 — PIN 正規化與合法性檢查（支援全形數字轉半形，嚴格要求 4 碼）", () => {
  assert.equal(normalizePinDigits("１２a３４５"), "1234");
  assert.equal(isValidPin("0428"), true);
  assert.equal(isValidPin("０４２８"), true);
  assert.equal(isValidPin("123"), false);
  assert.equal(isValidPin("12345"), false);
  assert.equal(isValidPin("12a4"), false);
});

test("3B-G5 — createPinHashRecord 與 verifyPin：以隨機 salt 雜湊、不洩漏明文且能正確驗證", () => {
  const s1 = generatePinSalt();
  const s2 = generatePinSalt();
  assert.equal(s1.length, 32);
  assert.notEqual(s1, s2);

  const rec1 = createPinHashRecord("2580");
  const rec2 = createPinHashRecord("2580");
  // 兩次獨立建置因隨機 salt 不同，雜湊記錄必不相同，且絕不含明文 PIN 欄位
  assert.notEqual(rec1, rec2);
  assert.equal(rec1.startsWith("v1:"), true);
  assert.equal(hasPinRecord(rec1), true);
  assert.notEqual(parsePinHashRecord(rec1), null);

  assert.equal(verifyPin("2580", rec1), true);
  assert.equal(verifyPin("２５８０", rec1), true);
  assert.equal(verifyPin("2581", rec1), false);
  assert.equal(verifyPin("0000", rec1), false);
  assert.equal(verifyPin("258", rec1), false);
  assert.equal(verifyPin("2580", null), false);
  assert.equal(verifyPin("2580", "v1:bad:record"), false);
  assert.equal(hasPinRecord(""), false);
  assert.equal(hasPinRecord("plaintext:2580"), false);

  assert.throws(() => createPinHashRecord("123"), RangeError);
  assert.throws(() => createPinHashRecord("abcd"), RangeError);
});

test("3B-G5 — 隱私遮罩本機偏好讀寫序列化", () => {
  assert.equal(parsePrivacyMasked(null), false);
  assert.equal(parsePrivacyMasked("0"), false);
  assert.equal(parsePrivacyMasked("1"), true);
  assert.equal(parsePrivacyMasked("true"), true);
  assert.equal(serializePrivacyMasked(true), "1");
  assert.equal(serializePrivacyMasked(false), "0");
});
