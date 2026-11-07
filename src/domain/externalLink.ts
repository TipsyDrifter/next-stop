/**
 * externalLink——`nextstop://` 連結的解析與組字（⑬ 外部入口；契約 第一節、第九節）。
 *
 * 鐵則：零 import、只用可剝除語法——`scripts/tests/external-link.test.ts` 以 node 直接載入。
 * 「不開 App」的判斷有三份（這裡、Rust `external.rs`、Kotlin），都用同一張案例表 `scripts/tests/fixtures/external-links.json` 測。
 *
 * 連結只有五種，沒有刪除、沒有讀資料、不帶內文寫入；発車到着都能復原，所以連結可以直接動作、不再跳確認（D-主-492）。
 *
 * 用手拆字串、不用 `new URL()`：非標準 scheme 的 host／pathname 切法跟瀏覽器引擎版本有關（舊版 Android WebView 會整段進 pathname），
 * 這裡的切法要跟 Rust、Kotlin 那兩份一致，自己拆最穩。
 */

export type ExternalAction =
  | { kind: "openTicket"; nodeId: string }
  | { kind: "openToday" }
  /** 點桌機提醒回來：`target`＝提醒落點的 JSON 字串（`parseTarget` 再驗一次） */
  | { kind: "openReminder"; target: string }
  | { kind: "departCategory"; categoryId: string; name: string | null }
  | { kind: "departTicket"; nodeId: string }
  | { kind: "arrive" };

/** 連結長度上限：超過一律認不得（連結是別的程式丟進來的，長度不可信） */
export const EXTERNAL_LINK_MAX = 2048;

const OFFICIAL_IDENTIFIER = "app.shitetsu.nextstop";
const OFFICIAL_SCHEME = "nextstop";
const SCHEME_RE = /^nextstop(-[a-z0-9-]+)?$/;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** query 取值：同名取第一個；解不開百分比編碼＝null */
function queryOf(query: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const kv of query.split("&")) {
    const at = kv.indexOf("=");
    if (at <= 0) continue;
    const key = kv.slice(0, at);
    if (!out.has(key)) out.set(key, decode(kv.slice(at + 1).replace(/\+/g, " ")));
  }
  return out;
}

/**
 * 認得的連結 ⇒ 動作；其餘（別的 scheme、認不得的路徑、缺參數、空 id、超長）⇒ null。
 * scheme 與路徑不分大小寫（連結可能被別的工具轉過大小寫）；id 分大小寫、照原樣帶。
 * `depart` 同時帶 category 與 ticket：category 優先（Rust 只看有沒有 category，兩邊才一致）。
 */
export function parseExternalLink(url: string): ExternalAction | null {
  if (typeof url !== "string" || url.length > EXTERNAL_LINK_MAX) return null;
  const sep = url.indexOf("://");
  if (sep <= 0) return null;
  if (!SCHEME_RE.test(url.slice(0, sep).toLowerCase())) return null;
  const rest = url.slice(sep + 3).split("#")[0];
  const q = rest.indexOf("?");
  const rawPath = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? "" : rest.slice(q + 1);
  const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  const segs = path.split("/");
  const head = segs[0].toLowerCase();

  if (head === "today" && segs.length === 1) return { kind: "openToday" };
  if (head === "arrive" && segs.length === 1) return { kind: "arrive" };
  if (head === "ticket" && segs.length === 2) {
    const nodeId = decode(segs[1]);
    return nodeId ? { kind: "openTicket", nodeId } : null;
  }
  if (head === "reminder" && segs.length === 1) {
    const target = queryOf(query).get("target");
    return target ? { kind: "openReminder", target } : null;
  }
  if (head === "depart" && segs.length === 1) {
    const params = queryOf(query);
    const categoryId = params.get("category");
    if (categoryId) return { kind: "departCategory", categoryId, name: params.get("name") || null };
    const nodeId = params.get("ticket");
    if (nodeId) return { kind: "departTicket", nodeId };
  }
  return null;
}

/** 不開 App 的動作：只有発車到分類、到着（`departTicket` 可能要選分類，要開 App） */
export function isSilentAction(a: ExternalAction): boolean {
  return a.kind === "departCategory" || a.kind === "arrive";
}

/** 不開 App 的動作過了這麼久就不執行：使用者早就不記得碰過，這時才発車只會弄亂時刻表 */
export const EXTERNAL_SILENT_TTL_MS = 10 * 60_000;

/** `at`＝連結發生的時間（epoch ms）。開 App 的連結沒有這個問題，放多久都照開 */
export function externalLinkExpired(a: ExternalAction, at: number, now: number): boolean {
  return isSilentAction(a) && now - at > EXTERNAL_SILENT_TTL_MS;
}

/**
 * identifier → 這個建置用的 scheme：正式版 `nextstop`；其他 `nextstop-` 加去掉前綴的部分、點換連字號
 * （`app.shitetsu.nextstop.dev.ticket` → `nextstop-dev-ticket`）。dev 與沙盒才不會去搶正式版的連結。與 Rust `scheme_for` 同規則。
 */
export function schemeFromIdentifier(identifier: string): string {
  const id = identifier.trim();
  if (id === "" || id === OFFICIAL_IDENTIFIER) return OFFICIAL_SCHEME;
  const tail = id.startsWith(OFFICIAL_IDENTIFIER) ? id.slice(OFFICIAL_IDENTIFIER.length).replace(/^\.+/, "") : id;
  const clean = tail
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean === "" ? OFFICIAL_SCHEME : `${OFFICIAL_SCHEME}-${clean}`;
}

export function ticketLink(scheme: string, id: string): string {
  return `${scheme}://ticket/${encodeURIComponent(id)}`;
}

export function todayLink(scheme: string): string {
  return `${scheme}://today`;
}

export function categoryLink(scheme: string, id: string, name: string): string {
  return `${scheme}://depart?category=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
}

export function arriveLink(scheme: string): string {
  return `${scheme}://arrive`;
}

/* ───────── 取＋確認才刪（兩端共用；同 notes.ts 的 createShareDrainer） ───────── */

export interface ExternalQueueItem {
  id: string;
  url: string;
  /** 連結進來的時間（epoch ms）：動作照這個時間記，不是 JS 輪到它的時間 */
  at: number;
}

export interface ExternalDrainDeps {
  take(): Promise<ExternalQueueItem[]>;
  /** 跑一筆。自己吞掉預期內的失敗（toast）；丟錯＝這筆不確認、下一趟再來 */
  run(item: ExternalQueueItem): Promise<void>;
  ack(ids: string[]): Promise<void>;
  onError(e: unknown): void;
}

/**
 * 同時只跑一趟；跑的時候又被敲門就補一趟（取的當下才進來的連結不會掉）。
 * 一次跑完才 ack：中途掛掉，沒確認的下次還在；前面跑過的那幾筆靠「同分類正在跑不動、沒在跑不到着」不會重複生效。
 * 每一輪各自接錯：這一輪丟錯時若又有人敲過門，那次敲門帶來的連結不能跟著被丟下，要再跑一輪。
 */
export function createExternalDrainer(deps: ExternalDrainDeps): () => Promise<void> {
  let running = false;
  let again = false;
  return async function drain(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          const items = await deps.take();
          if (items.length === 0) continue;
          const done: string[] = [];
          try {
            for (const it of items) {
              await deps.run(it);
              done.push(it.id);
            }
          } finally {
            if (done.length > 0) await deps.ack(done);
          }
        } catch (e) {
          deps.onError(e);
        }
      } while (again);
    } finally {
      running = false;
    }
  };
}
