/**
 * fracIndex——排序鍵（fractional index）的純算術（回饋乙；結接縫 #108／點子 #119）。
 *
 * 為什麼：整數 position 搬一列要把擠開的兄弟一起改寫，兩台各排同一個兄弟區時，同步逐「列×欄」LWW 會把兩邊的
 *   改動混成誰都沒排過的版本。排序鍵是可以無限插入的字串：搬一列只要算出「上下鄰居之間」的新鍵、只寫那一列，
 *   兩台各搬各的列互不覆蓋；兩台搬同一列＝那一列 LWW，結果仍是其中一台的完整意圖。
 *
 * 演算法：rocicorp/fractional-indexing（CC0）的 generateKeyBetween——鍵＝「整數部」（首字母決定長度：a–z 正、A–Z 負）
 *   ＋「小數部」（不以 '0' 結尾）。往尾端一直加只會遞增整數部，鍵長隨數量對數成長，不會越加越長。
 *   字元集是 base62、照 ASCII 排；SQLite 預設 BINARY 排序與 JS 字串比較都是逐位元組，三處結果一致。
 *
 * 不 import 任何東西：node test 直接載入（scripts/tests/frac-index.test.ts）。
 */

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];
const SMALLEST_INT = "A" + ZERO.repeat(26);

/** a < b（或其中一邊 null＝開放端）之間的小數部；a、b 都不能以 '0' 結尾 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`fracIndex: ${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new Error("fracIndex: trailing zero");
  if (b) {
    // 共同前綴照抄
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`fracIndex: bad head ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key[0]);
  if (len > key.length) throw new Error(`fracIndex: bad key ${key}`);
  return key.slice(0, len);
}

/** 合法的排序鍵（整數部完整、小數部不以 '0' 結尾、字元都在 base62 裡） */
export function isValidKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key === SMALLEST_INT) return false;
  for (const ch of key) if (DIGITS.indexOf(ch) < 0) return false;
  try {
    const i = integerPart(key);
    return key.slice(i.length).slice(-1) !== ZERO;
  } catch {
    return false;
  }
}

function assertKey(key: string): void {
  if (!isValidKey(key)) throw new Error(`fracIndex: invalid key ${JSON.stringify(key)}`);
}

function incrementInteger(x: string): string | null {
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = DIGITS[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return "a" + ZERO;
    if (head === "z") return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") digs.push(ZERO);
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

function decrementInteger(x: string): string | null {
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = DIGITS.slice(-1);
    else {
      digs[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") return "Z" + DIGITS.slice(-1);
    if (head === "A") return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < "Z") digs.push(DIGITS.slice(-1));
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

/**
 * a 與 b 之間的新鍵（a < b；null＝開放端：keyBetween(null, null) 是第一個鍵、(last, null) 接尾、(null, first) 插頭）。
 * 決定性：同樣的 a、b 永遠算出同一個鍵——兩台同時插在同一個縫會撞鍵，撞了顯示序靠呼叫端的決勝（created_at→id），
 *   要再插進兩個同鍵之間由 `keyForSlot` 處理。
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertKey(a);
  if (b !== null) assertKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`fracIndex: ${a} >= ${b}`);
  if (a === null) {
    if (b === null) return "a" + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error("fracIndex: cannot decrement");
    return res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error("fracIndex: cannot increment");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** a 與 b 之間的 n 個遞增新鍵（一次排好一整串：搬入一批、建 migration 的初始鍵） */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 1; i < n; i++) {
      c = keyBetween(c, b);
      out.push(c);
    }
    return out;
  }
  if (a === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 1; i < n; i++) {
      c = keyBetween(a, c);
      out.push(c);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

/**
 * 顯示序 `order`（已照「鍵→決勝」排好、每項帶目前的鍵）裡，把 `id` 放到「拿掉自己之後的第 index 格」要寫哪些列。
 * 通常只回被搬的那一列；上下鄰居的鍵相同（兩台同時插同一個縫撞鍵）或不合法（還沒遷移的舊值）時，
 *   無法在兩者之間插，這時把擋路的那幾列一起重新給鍵（只動「擋住這個縫」的最少列，不是整組）。
 * 回傳 [{id, key}]，照顯示序；呼叫端照單全寫（一手勢一批、同一個 hlc）。
 */
export function keyForSlot(
  order: readonly { id: string; key: string | null }[],
  id: string,
  index: number,
): { id: string; key: string }[] {
  const rest = order.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const usable = (k: string | null): k is string => k !== null && isValidKey(k);
  // 上鄰居：往上找第一個合法鍵；下鄰居：往下找第一個「嚴格大於上鄰居」的合法鍵。夾在中間的（同鍵、壞鍵）一起重排。
  let lo = at - 1;
  while (lo >= 0 && !usable(rest[lo].key)) lo--;
  const a = lo >= 0 ? (rest[lo].key as string) : null;
  let hi = at;
  while (hi < rest.length && !(usable(rest[hi].key) && (a === null || (rest[hi].key as string) > a))) hi++;
  const b = hi < rest.length ? (rest[hi].key as string) : null;
  // 縫裡要排的：上鄰居之後到插入點之前的擋路列、被搬的那列、插入點到下鄰居之前的擋路列
  const before = rest.slice(lo + 1, at).map((x) => x.id);
  const after = rest.slice(at, hi).map((x) => x.id);
  const ids = [...before, id, ...after];
  const keys = keysBetween(a, b, ids.length);
  return ids.map((x, i) => ({ id: x, key: keys[i] }));
}
