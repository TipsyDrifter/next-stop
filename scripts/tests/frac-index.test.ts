// 回饋乙：排序鍵（fractional index）純算術（src/domain/fracIndex.ts）
// 跑法：node --test scripts/tests/frac-index.test.ts（node 24 直接剝除型別；零 runtime import）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidKey, keyBetween, keyForSlot, keysBetween } from "../../src/domain/fracIndex.ts";

test("第一個鍵、接尾、插頭", () => {
  assert.equal(keyBetween(null, null), "a0");
  assert.equal(keyBetween("a0", null), "a1");
  assert.equal(keyBetween(null, "a0"), "Zz");
  assert.equal(keyBetween("a0", "a1"), "a0V");
});

test("一直接尾，鍵長對數成長", () => {
  let k: string | null = null;
  for (let i = 0; i < 5000; i++) k = keyBetween(k, null);
  assert.ok(k!.length <= 4, k!);
});

test("一直插在同一個縫，仍嚴格遞增且合法", () => {
  let lo = "a0";
  const hi = "a1";
  for (let i = 0; i < 200; i++) {
    const m = keyBetween(lo, hi);
    assert.ok(lo < m && m < hi, `${lo} < ${m} < ${hi}`);
    assert.ok(isValidKey(m));
    lo = m;
  }
});

test("keysBetween 給 n 個嚴格遞增、落在範圍內", () => {
  for (const [a, b] of [[null, null], ["a0", null], [null, "a5"], ["a0", "a1"]] as const) {
    const ks = keysBetween(a, b, 50);
    assert.equal(ks.length, 50);
    for (let i = 0; i < ks.length; i++) {
      assert.ok(isValidKey(ks[i]));
      if (i > 0) assert.ok(ks[i - 1] < ks[i]);
      if (a) assert.ok(a < ks[i]);
      if (b) assert.ok(ks[i] < b);
    }
  }
});

test("鍵的字串比較＝SQLite BINARY（ASCII）序", () => {
  const ks = keysBetween(null, null, 300);
  const sorted = [...ks].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
  assert.deepEqual(sorted, ks);
});

test("isValidKey 擋掉不合法的值", () => {
  for (const bad of ["", "a", "a00", "b0", "!x", "3", "a0 "]) assert.equal(isValidKey(bad), false, bad);
  for (const ok of ["a0", "a1V", "Zz", "b00"]) assert.equal(isValidKey(ok), true, ok);
});

const row = (id: string, key: string | null) => ({ id, key });

test("keyForSlot：一般搬移只寫被搬那一列", () => {
  const order = [row("A", "a0"), row("B", "a1"), row("C", "a2"), row("D", "a3")];
  const w = keyForSlot(order, "D", 1); // D 放到 A 後面
  assert.equal(w.length, 1);
  assert.equal(w[0].id, "D");
  assert.ok("a0" < w[0].key && w[0].key < "a1");
  const top = keyForSlot(order, "C", 0);
  assert.equal(top.length, 1);
  assert.ok(top[0].key < "a0");
  const end = keyForSlot(order, "A", 3);
  assert.equal(end.length, 1);
  assert.ok(end[0].key > "a3");
});

test("keyForSlot：插進兩個同鍵之間，只重排擋路的那幾列", () => {
  // 兩台同時插同一個縫 → B、C 同鍵
  const order = [row("A", "a0"), row("B", "a0V"), row("C", "a0V"), row("D", "a1"), row("E", "a2")];
  const w = keyForSlot(order, "E", 2); // E 放到 B、C 之間
  assert.deepEqual(w.map((x) => x.id), ["E", "C"]);
  const merged = order.filter((x) => x.id !== "E" && x.id !== "C").concat(w);
  const byKey = new Map(merged.map((x) => [x.id, x.key]));
  const seq = ["A", "B", "E", "C", "D"].map((id) => byKey.get(id)!);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i - 1] < seq[i], seq.join(" "));
});

test("keyForSlot：鄰居是還沒給鍵的舊列，一起補鍵", () => {
  const order = [row("A", "a0"), row("B", null), row("C", "a1")];
  const w = keyForSlot(order, "C", 1); // C 放到 A、B 之間
  assert.deepEqual(w.map((x) => x.id), ["C", "B"]);
  assert.ok("a0" < w[0].key && w[0].key < w[1].key);
});

test("keyForSlot：不在清單裡的 id＝搬進來（跨父層）", () => {
  const order = [row("A", "a0"), row("B", "a1")];
  const w = keyForSlot(order, "X", 2);
  assert.deepEqual(w, [{ id: "X", key: "a2" }]);
  assert.deepEqual(keyForSlot([], "X", 0), [{ id: "X", key: "a0" }]);
});
