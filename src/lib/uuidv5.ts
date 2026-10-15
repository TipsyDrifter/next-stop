/**
 * UUID v5（RFC 4122 §4.3）——決定性 id 的共用 helper（旅客筆記車次③契約 0-18）。
 *
 * 做法與 `src/data/syncRepository.ts` 的 `occurrenceId` 同一套：namespace 16 bytes ‖ UTF-8 name → SHA-1 →
 * 取前 16 bytes、version 5、variant RFC 4122。用 Web Crypto（Tauri WebView 是 secure context；`?mock=1`
 * 在 http://localhost 也可用；node 24 有全域 `crypto.subtle`）。
 * `scripts/tests/tags-logic.test.ts` 拿 `occurrenceId("n1","2026-10-12")` 對照 `uuidv5(OCCURRENCE_ID_NAMESPACE, "n1|2026-10-12")`，鎖住演算法不漂。
 *
 * 零 import（node 測試直接載入）。
 */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** uuid v5(namespace, name)；namespace 是帶連字號的 uuid 字串 */
export async function uuidv5(namespace: string, name: string): Promise<string> {
  const ns = hexToBytes(namespace.replace(/-/g, ""));
  if (ns.length !== 16) throw new RangeError("uuidv5：namespace 不是 uuid");
  const nm = new TextEncoder().encode(name);
  const buf = new Uint8Array(ns.length + nm.length);
  buf.set(ns, 0);
  buf.set(nm, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
