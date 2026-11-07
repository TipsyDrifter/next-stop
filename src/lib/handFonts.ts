/**
 * handFonts.ts——商店的手寫字型清單與下載（第三梯 ⑩，D-主-434）。
 *
 * 真下載、不隨包：每多一套手寫體安裝包就多 10 MB，而多數字型不會被選（使用者 10-10：「用到才下載」）。
 * WebView 直接 fetch，兩端同一份碼，不用 Rust、不用新權限；存 IndexedDB，之後離線照常能用。
 * 兩個來源都釘在同一個 commit、都回 ACAO:*，jsDelivr 是 GitHub 連不上或作者刪庫時的備援。
 * 下載完比對長度與 SHA-256，對不上不存。字型檔是可重新下載的快取，不進同步、不進備份（選擇存 settings，本機鍵）。
 */
export type HandFontId = "iansui" | "chenyu";

export interface DownloadableFont {
  id: Exclude<HandFontId, "iansui">;
  name: string;
  /** @font-face 名；theme-library.css 的 :root[data-hand] 指著它 */
  family: string;
  bytes: number;
  sha256: string;
  urls: readonly string[];
  /** 授權行（SIL OFL 1.1 要求隨附版權聲明與授權連結） */
  credit: string;
  licenseUrl: string;
}

const CHENYU_COMMIT = "06207b4d03c53d37fe28e38fb4ae15d9f63621af";

export const DOWNLOADABLE_FONTS: readonly DownloadableFont[] = [
  {
    id: "chenyu",
    name: "辰宇落雁體",
    family: "Chenyuluoyan",
    bytes: 9522140,
    sha256: "1289e42a6d1ec995d0cb23aee89efc69fc95749fbd54a610057a3e992dc453db",
    urls: [
      `https://raw.githubusercontent.com/Chenyu-otf/chenyuluoyan_thin/${CHENYU_COMMIT}/ChenYuluoyan-2.0-Thin.ttf`,
      `https://cdn.jsdelivr.net/gh/Chenyu-otf/chenyuluoyan_thin@${CHENYU_COMMIT}/ChenYuluoyan-2.0-Thin.ttf`,
    ],
    credit: "© 2022 王立宇、劉韋辰・SIL OFL 1.1",
    licenseUrl: `https://github.com/Chenyu-otf/chenyuluoyan_thin/blob/${CHENYU_COMMIT}/license.txt`,
  },
];

export function downloadableFont(id: string | null | undefined): DownloadableFont | null {
  return DOWNLOADABLE_FONTS.find((f) => f.id === id) ?? null;
}

export function normalizeHandFont(raw: string | null | undefined): HandFontId {
  return downloadableFont(raw)?.id ?? "iansui";
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isIntact(font: DownloadableFont, data: ArrayBuffer): Promise<boolean> {
  return data.byteLength === font.bytes && (await sha256Hex(data)) === font.sha256;
}

/** 下載失敗的兩種講法：連不上（可再試）／內容不對（再試也一樣，多半是來源被換了） */
export type DownloadError = "network" | "corrupt";

/** 依序試每個來源；全部失敗才丟。回的一定是驗過的位元組 */
export async function downloadFont(
  font: DownloadableFont,
  onProgress: (ratio: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  let failure: DownloadError = "network";
  for (const url of font.urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok || !res.body) continue;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        onProgress(Math.min(1, got / font.bytes));
      }
      const data = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) {
        data.set(c, at);
        at += c.byteLength;
      }
      if (await isIntact(font, data.buffer)) return data.buffer;
      failure = "corrupt";
    } catch {
      /* 這個來源連不上，換下一個 */
    }
  }
  throw failure;
}

/* ─── IndexedDB：一個 store，key＝字型 id、value＝ArrayBuffer ─── */
const DB_NAME = "ns-hand-fonts";
const STORE = "files";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

export const fontFiles = {
  get: (id: string) => withStore<ArrayBuffer | undefined>("readonly", (s) => s.get(id)),
  put: (id: string, data: ArrayBuffer) => withStore<IDBValidKey>("readwrite", (s) => s.put(data, id)),
  remove: (id: string) => withStore<undefined>("readwrite", (s) => s.delete(id)),
  keys: () => withStore<IDBValidKey[]>("readonly", (s) => s.getAllKeys()),
};
