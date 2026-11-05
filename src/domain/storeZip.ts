/**
 * 零依賴的 zip 產生器（資料匯出 §4；D-主-322）：**只存不壓**（method 0），CRC32 自己算。
 *
 * 為什麼自己寫：匯出的 CSV 是純文字、量不大，壓縮省不了多少；加一個 npm 依賴（或 Rust crate）換這一點不值得，
 * store-only 的格式固定、六十來行就寫完，而且 Windows 檔案總管、macOS、Android 都解得開。
 *
 * 規矩：
 *   * 檔名一律 UTF-8，並把 general purpose bit 11（0x0800）設起來——中文檔名／資料夾名才不會在解壓縮時變亂碼。
 *   * 路徑分隔用 `/`（傳進來的 `\` 會被換掉）；不收空路徑、不收 `..`（不讓壓縮檔蓋到別處）。
 *   * 只做 zip32（檔數 < 65535、單檔與總長 < 4 GiB）；超過就直接丟錯，不默默做出壞檔。匯出的量離這個上限差得遠。
 *   * 時間戳預設固定 1980-01-01（同樣的輸入每次產出一模一樣的位元組，好測）；要真實時間就傳 `opts.date`。
 *
 * 純函式、不 import 任何東西，node 測試直接載入。
 */

export interface ZipFile {
  /** zip 內的路徑，例 `任務/車票.csv`（資料夾不用另外列） */
  path: string;
  bytes: Uint8Array;
}

/** CRC-32（IEEE 802.3，zip 用的那個）。表在第一次用到時才建。 */
let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 日期時間（zip 的時間格式；年份 1980 起、秒數兩秒一格） */
function dosStamp(d: Date | undefined): { time: number; date: number } {
  if (!d) return { time: 0, date: (0 << 9) | (1 << 5) | 1 }; // 1980-01-01 00:00:00
  const y = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX32 = 0xffffffff;

export function buildStoreZip(files: readonly ZipFile[], opts?: { date?: Date }): Uint8Array {
  if (files.length >= 0xffff) throw new Error("zip 檔案太多（上限 65534）。");
  const enc = new TextEncoder();
  const stamp = dosStamp(opts?.date);

  const entries = files.map((f) => {
    const path = f.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (path === "" || path.endsWith("/") || path.split("/").some((seg) => seg === ".." || seg === "")) {
      throw new Error(`zip 路徑不合法：${f.path}`);
    }
    const name = enc.encode(path);
    if (name.length > 0xffff) throw new Error("zip 檔名太長。");
    return { name, bytes: f.bytes, crc: crc32(f.bytes), offset: 0 };
  });

  // 先量總長，一次配好記憶體（避免大檔反覆複製）
  let total = 22; // end of central directory
  for (const e of entries) total += 30 + e.name.length + e.bytes.length + 46 + e.name.length;
  if (total > MAX32) throw new Error("zip 超過 4 GiB，無法產生。");

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;

  for (const e of entries) {
    e.offset = p;
    dv.setUint32(p, 0x04034b50, true); // local file header
    dv.setUint16(p + 4, 20, true); // version needed
    dv.setUint16(p + 6, 0x0800, true); // flags：bit 11＝檔名是 UTF-8
    dv.setUint16(p + 8, 0, true); // method 0＝store
    dv.setUint16(p + 10, stamp.time, true);
    dv.setUint16(p + 12, stamp.date, true);
    dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.bytes.length, true); // compressed size
    dv.setUint32(p + 22, e.bytes.length, true); // uncompressed size
    dv.setUint16(p + 26, e.name.length, true);
    dv.setUint16(p + 28, 0, true); // extra length
    out.set(e.name, p + 30);
    out.set(e.bytes, p + 30 + e.name.length);
    p += 30 + e.name.length + e.bytes.length;
  }

  const cdStart = p;
  for (const e of entries) {
    dv.setUint32(p, 0x02014b50, true); // central directory header
    dv.setUint16(p + 4, 20, true); // version made by
    dv.setUint16(p + 6, 20, true); // version needed
    dv.setUint16(p + 8, 0x0800, true);
    dv.setUint16(p + 10, 0, true);
    dv.setUint16(p + 12, stamp.time, true);
    dv.setUint16(p + 14, stamp.date, true);
    dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.bytes.length, true);
    dv.setUint32(p + 24, e.bytes.length, true);
    dv.setUint16(p + 28, e.name.length, true);
    dv.setUint16(p + 30, 0, true); // extra
    dv.setUint16(p + 32, 0, true); // comment
    dv.setUint16(p + 34, 0, true); // disk number
    dv.setUint16(p + 36, 0, true); // internal attrs
    dv.setUint32(p + 38, 0, true); // external attrs
    dv.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }

  const cdSize = p - cdStart;
  dv.setUint32(p, 0x06054b50, true); // end of central directory
  dv.setUint16(p + 4, 0, true);
  dv.setUint16(p + 6, 0, true);
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, cdSize, true);
  dv.setUint32(p + 16, cdStart, true);
  dv.setUint16(p + 20, 0, true); // comment length
  return out;
}
