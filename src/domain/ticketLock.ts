/**
 * 售票口線・v1.33 3B G5「帳本金額隱私遮罩（****）＋ 4 位數密碼鎖（PIN Lock）」純函式層。
 *
 * 鐵則：零外部 import、純同步、只用可剝除語法（ES2020）——Node 測試與雙端 WebView 直接共用。
 * PIN 碼絕不以明文落盤，一律以隨機 16-byte salt ＋ FIPS 180-4 SHA-256 雜湊為 `v1:<saltHex>:<hashHex>` 存入本機 settings。
 */

export const KEY_PRIVACY_MASKED = "ticket_privacy_masked";
export const KEY_LOCK_PIN_HASH = "ticket_lock_pin_hash";
export const KEY_MONTH_START_DAY = "ticket_month_start_day";

export const PIN_LENGTH = 4;
const PIN_DOMAIN = "nextstop:ticket-pin:v1";

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

/** 同步 SHA-256（FIPS 180-4）：回傳 64 字元小寫 hex */
export function sha256Hex(message: string): string {
  const msg = new TextEncoder().encode(message);
  const ml = msg.length;
  const total = ((ml + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(ml / 0x20000000));
  dv.setUint32(total - 4, (ml * 8) >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0);
  odv.setUint32(4, h1);
  odv.setUint32(8, h2);
  odv.setUint32(12, h3);
  odv.setUint32(16, h4);
  odv.setUint32(20, h5);
  odv.setUint32(24, h6);
  odv.setUint32(28, h7);
  return bytesToHex(out);
}

/** 全形數字轉半形，僅保留 0–9 並截斷至最多 4 碼（供輸入框受控更新） */
export function normalizePinDigits(raw: string): string {
  const half = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48));
  return half.replace(/\D+/g, "").slice(0, PIN_LENGTH);
}

function toAsciiDigits(raw: string): string {
  return raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48)).trim();
}

/** 是否為合法的 4 位數字 PIN */
export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(toAsciiDigits(pin));
}

/** 產生 16-byte（32 hex）密碼學隨機 salt */
export function generatePinSalt(byteLength = 16): string {
  const len = Math.max(8, Math.min(32, Math.floor(byteLength)));
  const bytes = new Uint8Array(len);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytesToHex(bytes);
}

export interface ParsedPinHash {
  salt: string;
  hash: string;
}

/** 解析本機儲存的 `v1:<saltHex>:<hashHex>` 記錄；壞值或空字串回傳 null */
export function parsePinHashRecord(raw: string | null | undefined): ParsedPinHash | null {
  if (!raw) return null;
  const m = /^v1:([0-9a-fA-F]{16,64}):([0-9a-fA-F]{64})$/.exec(raw.trim());
  if (!m) return null;
  return { salt: m[1].toLowerCase(), hash: m[2].toLowerCase() };
}

/** 本機是否已啟用帳本密碼鎖 */
export function hasPinRecord(raw: string | null | undefined): boolean {
  return parsePinHashRecord(raw) !== null;
}

/** 建立 `v1:<saltHex>:<hashHex>` 雜湊記錄（不存明文；非法 PIN 拋 RangeError） */
export function createPinHashRecord(pin: string, saltHex?: string): string {
  const clean = toAsciiDigits(pin);
  if (!/^\d{4}$/.test(clean)) throw new RangeError("請輸入 4 位數字密碼");
  const salt = (saltHex ?? generatePinSalt()).trim().toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(salt)) throw new RangeError("密碼鹽值格式有誤");
  const hash = sha256Hex(`${PIN_DOMAIN}:${salt}:${clean}`);
  return `v1:${salt}:${hash}`;
}

/** 常數時間比對 PIN 是否與雜湊記錄相符 */
export function verifyPin(pin: string, record: string | null | undefined): boolean {
  const clean = toAsciiDigits(pin);
  if (!/^\d{4}$/.test(clean)) return false;
  const parsed = parsePinHashRecord(record);
  if (!parsed) return false;
  const actual = sha256Hex(`${PIN_DOMAIN}:${parsed.salt}:${clean}`);
  if (actual.length !== parsed.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ parsed.hash.charCodeAt(i);
  }
  return diff === 0;
}

/** 解析隱私遮罩設定（本機 `ticket_privacy_masked`） */
export function parsePrivacyMasked(raw: string | null | undefined): boolean {
  return raw === "1" || raw === "true";
}

export function serializePrivacyMasked(masked: boolean): string {
  return masked ? "1" : "0";
}
