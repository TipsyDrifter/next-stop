/**
 * 📝 旅客筆記（notes）——型別＋純函式（車次①「捕捉・收件匣・筆記」；契約 §4）
 *
 * 規格：docs/research/2026-10-06-旅客筆記-車次①捕捉收件匣筆記-契約.md §4
 * 行為對照：prototypes/旅客筆記-src/logic.js（標 `=logic.js:行` 的地方逐字對齊）
 * 拍板：決策記錄 旅客筆記 D-筆-1／5／6／17／18／25；Plan 第〇節（票根×路線前綴的去處表）
 *
 * 寫法限制（契約 §4 開頭）：
 *   - 零 import（`NodeRow` 只用 `import type`）——`scripts/tests/notes-logic.test.ts` 用 node 直接載入本檔
 *   - 只用可剝除語法：不用 enum／namespace／參數屬性
 *   - 日界線與 todayKey 用 `src/lib/date.ts`，這裡不重寫
 *
 * 不移植的（契約 §4.3）：mdToHtml／escapeHtml（車次④）、dayKey／addDays／diffDays（用 lib/date）、fmtTime。
 */
import type { NodeRow } from "./node";

/* ═══ 型別（契約 §4.1） ═══ */

export type NoteKind = "note" | "diary";

export interface NoteRow {
  id: string;
  kind: NoteKind;
  /** 選填；NULL＝列表顯示內文第一行（D-筆-1） */
  title: string | null;
  /** 純文字（Markdown 排版在車次④） */
  body: string;
  /** 日記所屬日 YYYY-MM-DD（車次②）；筆記恆 NULL */
  entry_date: string | null;
  /** 顯示與排序用時刻（UTC ISO）；預設＝建立當下，可改（補記） */
  noted_at: string;
  /** 掛在樹上的節點（路線／支線／列車／車廂）；無 FK，節點可能已不在 */
  node_id: string | null;
  /** 0|1（SQLite 回整數）；1＝未整理（收件匣） */
  inbox: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type CaptureStub = "inbox" | "todo" | "note" | "diary";

/** 車次①捕捉框顯示的票根順序（日記等車次②再加進來） */
export const CAPTURE_STUBS: readonly CaptureStub[] = ["inbox", "todo", "note"];

export const STUB_LABEL: Record<CaptureStub, string> = { inbox: "收件匣", todo: "待辦", note: "筆記", diary: "日記" };
export const STUB_HINT: Record<CaptureStub, string> = { inbox: "之後再整理", todo: "排進今天", note: "存進筆記", diary: "記在今天" };

/** 路線前綴比對只需要這三欄（NodeRow 結構上就滿足） */
export interface RouteLike {
  id: string;
  code: string | null;
  name: string;
}

export interface RoutePrefix {
  route: RouteLike;
  routeId: string;
  /** 從字串開頭（含前導空白）算到冒號（含）的長度 */
  prefixLen: number;
  /** ＝text.slice(0, prefixLen)；store 的 dismissedPrefix 存的就是它 */
  matched: string;
  /** 前綴之後、去掉前導空白的內文（D-筆-25） */
  body: string;
}

export type DestinationTarget = "inbox" | "note" | "today" | "diary";

export interface Destination {
  target: DestinationTarget;
  /** 存檔時要不要帶路線 */
  withRoute: boolean;
  /** 存檔時要不要把前綴從內文拿掉（日記不掛路線 → 原文照留） */
  consumePrefix: boolean;
}

export interface TodoLine {
  text: string;
  isHeading: boolean;
  checked: boolean;
}

/** 「掛到哪」（D-筆-26 合成一欄）：只掛路線＝nodeId null；掛節點時 routeId＝該節點所屬路線 */
export interface AttachTarget {
  routeId: string | null;
  nodeId: string | null;
  nodeKind: "route" | "branch" | "train" | "car" | null;
}

/* ═══ 票根 ═══ */

/** Tab／Shift+Tab 輪流切換：dir = +1／-1，頭尾相接（=logic.js:31-36；清單由參數給，車次①三枚） */
export function nextStub(cur: CaptureStub, dir: 1 | -1, stubs: readonly CaptureStub[] = CAPTURE_STUBS): CaptureStub {
  let i = stubs.indexOf(cur);
  if (i < 0) i = 0;
  const n = stubs.length;
  return stubs[(i + (dir < 0 ? -1 : 1) + n) % n];
}

/* ═══ 路線前綴（=logic.js:45-72） ═══
 * 規則：文字開頭（容許前導半形／全形空白與 Tab）出現「路線代碼或路線全名」緊接半形「:」或全形「：」。
 * - 不分大小寫（代碼常是英文，cum：也算）
 * - 同時命中多個時取最長的那個（避免短代碼吃掉長名稱）
 * - 不認得的前綴（例：「備註：」「TODO:」）一律當一般文字，回傳 null
 * - 只打到「CUM：」沒有內文也要認（打字當下就要出票根）
 * - D-筆-25：冒號後空白可有可無，有就一併吃掉（body 去前導空白） */
export function parseRoutePrefix(text: string, routes: readonly RouteLike[]): RoutePrefix | null {
  if (!text || !routes || !routes.length) return null;
  const lead = /^[ \t　]*/.exec(text)![0].length;
  const rest = text.slice(lead);
  let best: { route: RouteLike; len: number } | null = null;
  for (const r of routes) {
    for (const label of [r.code, r.name]) {
      if (!label) continue;
      const head = rest.slice(0, label.length);
      if (head.toLowerCase() !== String(label).toLowerCase()) continue;
      const ch = rest.charAt(label.length);
      if (ch !== ":" && ch !== "：") continue;
      if (!best || label.length > best.len) best = { route: r, len: label.length };
    }
  }
  if (!best) return null;
  const prefixLen = lead + best.len + 1;
  return {
    route: best.route,
    routeId: best.route.id,
    prefixLen,
    matched: text.slice(0, prefixLen),
    body: text.slice(prefixLen).replace(/^[ \t　]+/, ""),
  };
}

/* ═══ 去處對照表（Plan 第〇節；=logic.js:84-96） ═══
 *  票根＼前綴   沒有路線前綴              有路線前綴
 *  收件匣       未整理的筆記 → 收件匣      筆記（掛該路線）→ 筆記的家（不進收件匣）
 *  待辦         今天的車票 → 今日          今天的車票（帶該路線）→ 今日
 *  筆記         筆記 → 筆記的家            筆記（掛該路線）→ 筆記的家
 *  日記         今天的日記 → 日記的家      同左（日記不掛路線） */
export function resolveDestination(stub: CaptureStub, hasRoute: boolean): Destination {
  const r = !!hasRoute;
  switch (stub) {
    case "todo":
      return { target: "today", withRoute: r, consumePrefix: r };
    case "note":
      return { target: "note", withRoute: r, consumePrefix: r };
    case "diary":
      return { target: "diary", withRoute: false, consumePrefix: false };
    case "inbox":
    default:
      return r
        ? { target: "note", withRoute: true, consumePrefix: true }
        : { target: "inbox", withRoute: false, consumePrefix: false };
  }
}

/** 存檔後 toast 的文案；stamp='uketsuke' 表示要附一枚小受付章（契約 §5.8 第 1–5 條；=logic.js:98-110） */
export function captureToast(
  stub: CaptureStub,
  dest: Destination,
  routeName: string,
): { text: string; stamp: "uketsuke" | null } {
  if (dest.target === "inbox") return { text: "已放進收件匣", stamp: "uketsuke" };
  if (dest.target === "today") {
    return { text: dest.withRoute ? "已排進今日 · " + routeName : "已排進今日", stamp: null };
  }
  if (dest.target === "diary") return { text: "已記在今天的日記", stamp: null };
  // note
  if (stub === "inbox" && dest.withRoute) {
    return { text: "有路線前綴，已直接存進筆記 · " + routeName + "（不進收件匣）", stamp: null };
  }
  return { text: dest.withRoute ? "已存進筆記 · " + routeName : "已存進筆記", stamp: null };
}

/* ═══ 多行拆解（變待辦；=logic.js:113-155） ═══ */

const RE_HASH_HEAD = /^#{1,6}[ \t　]+/; // Markdown 標題「## 今天」
const RE_BULLET_SPACED = /^[-*+－＊][ \t　]+/; // - * + 需要後接空白（不吃「**粗體**」「-5 度」）
const RE_BULLET_GLYPH = /^[・•‧·∙●○◦▪■□][ \t　]*/; // ・•‧·∙●○◦▪■□
const RE_BULLET_NUM = /^(?:[（(][0-9０-９]{1,3}[)）]|[0-9０-９]{1,3}[.．、)）](?![0-9０-９]))[ \t　]*/;
const RE_CHECKBOX = /^\[[ xX]\][ \t　]*/;
const RE_HEADING_TAIL = /[:：][ \t　]*$/;

/** 去掉一行開頭的條列符號；回傳 { text, hashHeading }（=logic.js:113-131） */
export function stripBullet(line: string): { text: string; hashHeading: boolean } {
  let s = line.replace(/^[ \t　]+/, "").replace(/[ \t　]+$/, "");
  let hashHeading = false;
  if (RE_HASH_HEAD.test(s)) {
    s = s.replace(RE_HASH_HEAD, "");
    hashHeading = true;
  } else if (RE_BULLET_SPACED.test(s)) s = s.replace(RE_BULLET_SPACED, "");
  else if (RE_BULLET_GLYPH.test(s)) s = s.replace(RE_BULLET_GLYPH, "");
  else if (RE_BULLET_NUM.test(s)) s = s.replace(RE_BULLET_NUM, "");
  else if (/^[-*+－＊]$/.test(s)) s = ""; // 只有一個條列符號的行＝空行
  s = s.replace(RE_CHECKBOX, "");
  return { text: s, hashHeading };
}

/** 逐行拆成預覽清單：空行略過；冒號結尾（或 # 標題）＝標題行，預設不勾（=logic.js:134-144） */
export function splitTodoLines(text: string): TodoLine[] {
  const out: TodoLine[] = [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const st = stripBullet(raw);
    if (!st.text) continue;
    const isHeading = st.hashHeading || RE_HEADING_TAIL.test(st.text);
    out.push({ text: st.text, isHeading, checked: !isHeading });
  }
  return out;
}

/** 非空行數（決定要不要跳預覽、預覽要不要顯示清單；=logic.js:147-150） */
export function lineCount(text: string): number {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.replace(/[ \t　]/g, "") !== "").length;
}

/** 捕捉框選「待辦」時要不要改跳預覽框（=logic.js:153-155） */
export function needsPreview(stub: CaptureStub, text: string): boolean {
  return stub === "todo" && lineCount(text) > 1;
}

/**
 * 預覽框確定後，這批車票去了哪（toast 用；=logic.js:159-167）。
 * 有日期＝「今日」或「M 月 D 日」；否則有 parent＝節點名；否則有路線＝路線名；否則「收件匣」。
 * 支線視同路線（Plan 附錄 M1）由呼叫端處理：掛支線時 parentId 傳 null、routeId 傳路線 id。
 */
export function previewDestination(
  f: { routeId: string | null; parentId: string | null; scheduledOn: string | null },
  today: string,
  names: { route?: string; parent?: string },
): string {
  if (f.scheduledOn) {
    if (f.scheduledOn === today) return "今日";
    return fmtMonthDay(f.scheduledOn);
  }
  if (f.parentId) return (names && names.parent) || "列車";
  if (f.routeId) return (names && names.route) || "路線";
  return "收件匣";
}

/**
 * 收件匣的車票（D-筆-17 清空定義；=logic.js:170-172 換成 NodeRow 欄名）：
 * 車票、沒 parent、沒執行日、沒路線標籤、未完成、未刪除。有日期、或掛進樹、或掛了路線，就算整理過。
 */
export function isInboxTicket(
  n: Pick<NodeRow, "kind" | "parent_id" | "scheduled_on" | "route_id" | "status" | "deleted_at">,
): boolean {
  return n.kind === "ticket" && !n.deleted_at && n.status !== "done" && !n.scheduled_on && !n.parent_id && !n.route_id;
}

/* ═══ 筆記的標題與摘要（=logic.js:175-202） ═══
 * stripMdLine 只去 `#`、`>`、條列符號、`**`——不是 Markdown 渲染。 */

function stripMdLine(s: string): string {
  return s
    .replace(RE_HASH_HEAD, "")
    .replace(/^>[ \t]?/, "")
    .replace(RE_BULLET_SPACED, "")
    .replace(RE_BULLET_GLYPH, "")
    .replace(/\*\*/g, "")
    .trim();
}

export function firstLine(body: string): string {
  const lines = String(body || "").split("\n");
  for (const l of lines) {
    const t = stripMdLine(l);
    if (t) return t;
  }
  return "";
}

/** 列表標題：有標題用標題，沒有用內文第一行，都沒有＝「（空白）」 */
export function noteTitle(n: Pick<NoteRow, "title" | "body">): string {
  const t = (n.title || "").trim();
  return t || firstLine(n.body) || "（空白）";
}

/** 摘要：有標題時從內文開頭取；沒標題時跳過已當成標題的第一行 */
export function excerpt(n: Pick<NoteRow, "title" | "body">, max: number): string {
  let lines = String(n.body || "")
    .split("\n")
    .map(stripMdLine)
    .filter(Boolean);
  if (!(n.title || "").trim()) lines = lines.slice(1);
  const s = lines.join(" ");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 前端比對（mock／即時過濾用）：title＋body 含 q（不分大小寫）；空白＝全中 */
export function matchesQuery(n: Pick<NoteRow, "title" | "body">, q: string): boolean {
  const k = String(q || "").trim().toLowerCase();
  if (!k) return true;
  return ((n.title || "") + "\n" + (n.body || "")).toLowerCase().indexOf(k) >= 0;
}

/** LIKE 用的跳脫（配 `ESCAPE '\'`）：`\`→`\\`、`%`→`\%`、`_`→`\_`（契約 §3.4） */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * 閱讀態用：以空行（含只有空白的行）切段、段內以 `\n` 切行；不處理任何標記（Markdown 在車次④）。
 * 回傳 [段][行]；沒有內容＝空陣列。
 */
export function plainParagraphs(body: string): string[][] {
  const out: string[][] = [];
  let para: string[] = [];
  for (const line of String(body || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line.replace(/[ \t　]/g, "") === "") {
      if (para.length) out.push(para);
      para = [];
      continue;
    }
    para.push(line);
  }
  if (para.length) out.push(para);
  return out;
}

/* ═══ 日期顯示（=logic.js:266-270；key＝本地日 YYYY-MM-DD） ═══ */

/** 「10 月 5 日」 */
export function fmtMonthDay(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  return m + " 月 " + d + " 日";
}

/** 「2026 年 9 月」；收 YYYY-MM-DD 或 YYYY-MM */
export function fmtMonthHeader(key: string): string {
  const [y, m] = key.slice(0, 7).split("-");
  return y + " 年 " + Number(m) + " 月";
}

/** `YYYY-MM` */
export function monthKey(key: string): string {
  return key.slice(0, 7);
}
