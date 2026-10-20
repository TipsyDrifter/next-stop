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
 *
 * 車次②「日記・當天足跡」（docs/research/2026-10-08-旅客筆記-車次②日記與當天足跡-契約.md §4）：檔尾加足跡型別與日記純函式；
 * 票根放寬為「內建四枚 ∪ 別線登記的捕捉目的地 id」（D-筆-36）。月曆的週首一律由呼叫端傳 `weekStart`（uiStore.weekStart），本檔不寫死。
 */
import type { Mood, NodeKind, NodeRow } from "./node";

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

/** 旅客筆記內建的票根（本檔的去處表與 toast 只認這幾枚） */
export type BuiltinStub = "inbox" | "todo" | "note" | "diary";

/**
 * 捕捉框的票根 id＝內建 ∪ 別線登記的捕捉目的地 id（`<line>.<name>`，`lines/types.ts` 的 `CaptureTargetSpec`；
 * 車次② D-筆-36）。`string & {}` 只是讓編輯器保留內建字面值的自動完成，型別上等同 string。
 * 登記的票根不走本檔的 `resolveDestination`／`captureToast`（先用 `isBuiltinStub` 分流，存檔走 `spec.save`）。
 */
export type CaptureStub = BuiltinStub | (string & {});

/** 捕捉框的內建票根順序（車次② 0-11 加入日記成四枚；別線登記的接在後面，見 notesStore.captureStubList） */
export const CAPTURE_STUBS: readonly BuiltinStub[] = ["inbox", "todo", "note", "diary"];

/** 只有內建票根有；登記的票根顯示 `spec.label`／`spec.hint` */
export const STUB_LABEL: Record<BuiltinStub, string> = { inbox: "收件匣", todo: "待辦", note: "筆記", diary: "日記" };
export const STUB_HINT: Record<BuiltinStub, string> = { inbox: "之後再整理", todo: "排進今天", note: "存進筆記", diary: "記在今天" };

const BUILTIN_STUBS: readonly string[] = ["inbox", "todo", "note", "diary"];

/** 是不是旅客筆記內建的票根（否＝別線登記的捕捉目的地） */
export function isBuiltinStub(s: CaptureStub): s is BuiltinStub {
  return BUILTIN_STUBS.indexOf(s) >= 0;
}

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

/**
 * Tab／Shift+Tab 輪流切換：dir = +1／-1，頭尾相接（=logic.js:31-36）。清單由參數給，可含別線登記的 id
 * （捕捉框傳 `[...CAPTURE_STUBS, ...lineCaptureTargets(shell).map(t => t.id)]`）；預設只有內建。
 */
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
 *  日記         今天的日記 → 日記的家      同左（日記不掛路線）
 *  別線登記的票根不在這張表：呼叫端先 `isBuiltinStub` 分流（萬一傳進來，落到 default＝收件匣） */
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
    return { text: "有寫路線，已直接存進筆記 · " + routeName + "（不進收件匣）", stamp: null };
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
 * 車次④（契約 0-10）：stripMdLine 去 `#`、`>`、條列符號、`**`、`*斜體*`、行內程式碼的反引號、`[字](網址)` 的網址；
 * 分隔線與圍欄標記行整行丟掉（圍欄內的行照留）。不是 Markdown 渲染——列表不畫粗體或程式碼（D-筆-23）。 */

const RE_MD_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RE_MD_HR = /^[-*_]{3,}\s*$/;

/** 一行去掉 Markdown 符號（摘要、標題行用）；分隔線、圍欄標記行＝空字串 */
export function stripMdLine(s: string): string {
  if (RE_MD_FENCE.test(s) || RE_MD_HR.test(s.trim())) return "";
  return s
    .replace(RE_HASH_HEAD, "")
    .replace(/^>[ \t]?/, "")
    .replace(RE_BULLET_SPACED, "")
    .replace(RE_BULLET_GLYPH, "")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\*(\S[^*]*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/** 內文逐行去符號、丟掉空行；圍欄裡的行只去頭尾空白（不當標題／條列剝）、圍欄標記行不出現 */
function summaryLines(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const l of String(body || "").split("\n")) {
    if (RE_MD_FENCE.test(l)) {
      inFence = !inFence;
      continue;
    }
    const t = inFence ? l.trim() : stripMdLine(l);
    if (t) out.push(t);
  }
  return out;
}

export function firstLine(body: string): string {
  return summaryLines(body)[0] ?? "";
}

/** 列表標題：有標題用標題，沒有用內文第一行，都沒有＝「（空白）」 */
export function noteTitle(n: Pick<NoteRow, "title" | "body">): string {
  const t = (n.title || "").trim();
  return t || firstLine(n.body) || "（空白）";
}

/** 摘要：有標題時從內文開頭取；沒標題時跳過已當成標題的第一行 */
export function excerpt(n: Pick<NoteRow, "title" | "body">, max: number): string {
  let lines = summaryLines(n.body);
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

/** LIKE 用的跳脫（配 `ESCAPE '\'`；契約 §3.4）——實作只留一份在 lib/sql.ts，這裡 re-export 給既有呼叫端 */
export { escapeLike } from "../lib/sql.ts";

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

/* ═══════════════════════════════════════════════════════════════════
 * 車次②：日記與當天足跡（契約 §4；=app.js:112-119、358-361、376-378、1074-1080、logic.js:258-278）
 * ═══════════════════════════════════════════════════════════════════ */

/* ═══ 型別（契約 §4.1） ═══ */

/** 一枚済章：那天完成的單發票／列車／車廂（含退役定期券）讀 nodes；那天済的定期券班次讀 occurrences（0-7） */
export interface FootprintSeal {
  /** 單發票等＝nodes.id；定期券班次＝occurrences.id */
  id: string;
  nodeId: string;
  name: string;
  kind: "train" | "car" | "ticket";
  /** 路線色由呼叫端對 nodeStore.routes 查 */
  routeId: string | null;
  /** 完成時刻（UTC ISO） */
  at: string;
  /** 跟著済章讀的心情燈號（nodes.mood 或 occurrences.mood）；沒點＝null */
  mood: Mood | null;
  /** 定期券班次日 YYYY-MM-DD；單發票 null */
  dueOn: string | null;
}

/** 一則手記：work_logs.event IS NULL 的主人手寫工作日誌（発券／入鋏／済／conflict 都不算） */
export interface FootprintLog {
  id: string;
  nodeId: string;
  /** 節點不在或已刪＝「（原車票已刪除）」（由 repository 填好） */
  nodeName: string;
  body: string;
  /** 寫下的時刻（UTC ISO） */
  at: string;
  nodeMissing: boolean;
}

/** 時間塊（時刻表線通車後才有；本線自己的窄型別，0-8） */
export interface FootprintBlock {
  id: string;
  label: string;
  glyph: string | null;
  colorIdx: number;
  /** UTC ISO */
  from: string;
  /** UTC ISO */
  to: string;
  running: boolean;
}

/** 一天的足跡 */
export interface FootprintDay {
  /** YYYY-MM-DD（日界線日） */
  day: string;
  /** 依 at 升冪 */
  seals: FootprintSeal[];
  /** 依 at 升冪 */
  logs: FootprintLog[];
  /** seals 裡非 null 的燈號，依完成時刻排 */
  moods: Mood[];
  /** null＝時刻表尚未通車（足跡欄底顯示說明）；非 null（含空陣列）＝畫「時間」段 */
  blocks: FootprintBlock[] | null;
}

/** 月曆／月份條一格的記號：有日記＝實心、只有足跡＝空心、都沒有＝空字串 */
export type DayMark = "diary" | "fp" | "";

/** 頁內搜尋結果一列（view model；補記標記由呼叫端以 isBackfilled 另算） */
export interface DiaryHit {
  id: string;
  /** entry_date */
  day: string;
  /** 標題或內文第一行 */
  title: string;
  /** 一行摘要 */
  excerpt: string;
}

/* ═══ 日記（契約 §4.2） ═══ */

/** 不能翻到未來：day > today 一律夾到 today（=app.js:1076） */
export function clampDay(day: string, today: string): string {
  return day > today ? today : day;
}

/** 補記判定（0-5）：歸屬日 ≠ 寫下那天的日界線日；notedDay 由呼叫端 dayKeyOf(noted_at, dayStartHour) 算 */
export function isBackfilled(entryDate: string, notedDay: string): boolean {
  return entryDate !== notedDay;
}

/** 篇頭：「寫於 HH:MM」／「寫於 M/D HH:MM（補記）」（=app.js:359-360）；shortDay＝寫下那天的「10/2」 */
export function entryWrittenLabel(entryDate: string, notedDay: string, hhmm: string, shortDay: string): string {
  return isBackfilled(entryDate, notedDay) ? `寫於 ${shortDay} ${hhmm}（補記）` : `寫於 ${hhmm}`;
}

/** 沒有篇也沒草稿時的空狀態（原型施工決定 12） */
export function diaryEmptyText(isToday: boolean): { text: string; button: string } {
  return isToday ? { text: "今天還沒寫日記", button: "寫日記" } : { text: "這天沒寫日記", button: "補記" };
}

/** 草稿內文的 placeholder（=app.js:378） */
export function diaryPlaceholder(isToday: boolean): string {
  return isToday ? "今天過得怎麼樣…" : "那天發生了什麼…（翻翻足跡）";
}

/** 草稿眉標：「今天的日記」／「補記 10 月 2 日」（=app.js:376） */
export function diaryDraftMeta(isToday: boolean, day: string): string {
  return isToday ? "今天的日記" : "補記 " + fmtMonthDay(day);
}

/**
 * 日記存檔類 toast（契約 §5.8 第 17–19 條）。
 *   capture（捕捉→日記）／convert（記成日記）：那天＝今天「已記在今天的日記」；否則「已記成 M 月 D 日的日記」
 *   draft（草稿存檔）：今天「已記在今天的日記」；否則「已補記在 M 月 D 日」
 */
export function diaryToast(kind: "capture" | "convert" | "draft", day: string, today: string): string {
  if (day === today) return "已記在今天的日記";
  return kind === "draft" ? "已補記在 " + fmtMonthDay(day) : "已記成 " + fmtMonthDay(day) + "的日記";
}

/** 搜尋結果列：標題或第一行＋摘要（＝noteTitle／excerpt） */
export function toDiaryHit(n: Pick<NoteRow, "id" | "entry_date" | "title" | "body">, max: number): DiaryHit {
  return { id: n.id, day: n.entry_date ?? "", title: noteTitle(n), excerpt: excerpt(n, max) };
}

/** 搜尋結果列的標題（＝noteTitle，不另寫） */
export const entryTitle = noteTitle;
/** 搜尋結果列的摘要（＝excerpt，不另寫） */
export const entryExcerpt = excerpt;

/* ═══ 當天足跡（契約 §4.2） ═══ */

/** 合成一天的足跡：seals 依 at 升冪、同 nodeId＋at 去重（退役定期券同時走兩條查詢的邊角）；logs 依 at 升冪；不改輸入 */
export function groupFootprints(
  day: string,
  seals: readonly FootprintSeal[],
  logs: readonly FootprintLog[],
  blocks: FootprintBlock[] | null,
): FootprintDay {
  const byAt = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const seen = new Set<string>();
  const outSeals: FootprintSeal[] = [];
  for (const s of [...seals].sort(byAt)) {
    const k = s.nodeId + "\u0000" + s.at;
    if (seen.has(k)) continue;
    seen.add(k);
    outSeals.push(s);
  }
  const moods: Mood[] = [];
  for (const s of outSeals) if (s.mood) moods.push(s.mood);
  return { day, seals: outSeals, logs: [...logs].sort(byAt), moods, blocks };
}

/** 有沒有足跡：済章／手記／心情任一非空。時間塊不算（避免時刻表通車後「每天都有足跡」） */
export function hasFootprint(f: FootprintDay | null): boolean {
  return !!f && (f.seals.length > 0 || f.logs.length > 0 || f.moods.length > 0);
}

/** 手機足跡區收合時的一行：「N 枚済章・M 則手記」／「N 枚済章」／「M 則手記」／「沒有足跡」 */
export function footprintSummary(f: FootprintDay | null): string {
  if (!f) return "沒有足跡";
  const parts: string[] = [];
  if (f.seals.length) parts.push(f.seals.length + " 枚済章");
  if (f.logs.length) parts.push(f.logs.length + " 則筆記");
  return parts.length ? parts.join("・") : "沒有足跡";
}

/** 手記的節點不在（還沒同步到／已不存在）時顯示的票名（契約 §3.4、§5.9） */
export const MISSING_NODE_NAME = "（原車票已刪除）";

/** 足跡來源的最小形狀（NodeRow／Occurrence／WorkLog 結構上都滿足；本檔零 import，所以各寫一份窄型別） */
export interface FootprintNodeSrc {
  id: string;
  name: string;
  kind: string;
  route_id: string | null;
  status: string;
  completed_at: string | null;
  mood: Mood | null;
  deleted_at: string | null;
}
export interface FootprintOccSrc {
  id: string;
  node_id: string;
  due_on: string;
  status: string;
  completed_at: string | null;
  mood: Mood | null;
  deleted_at: string | null;
}
export interface FootprintLogSrc {
  id: string;
  node_id: string;
  body: string;
  logged_at: string;
  event: string | null;
  deleted_at: string | null;
}

/** 時刻視窗 [start, end)（UTC ISO；＝lib/date 的 dayWindow） */
export interface IsoWindow {
  start: string;
  end: string;
}

const SEAL_KINDS: readonly string[] = ["train", "car", "ticket"];
const inWin = (iso: string | null, w: IsoWindow): iso is string => !!iso && iso >= w.start && iso < w.end;

/**
 * 済章（＝SQLite 版 §3.4 (a)＋(b) 的同義過濾；mock 用、測試鎖語義）：
 *   (a) 節點 kind∈{train,car,ticket}、存活、status='done'、completed_at 落在視窗（含 cascade 蓋章的子項與退役定期券）
 *   (b) 班次 存活、status='done'（運休不列）、completed_at 落在視窗、所屬節點存活
 * 不排序不去重（交給 groupFootprints）。
 */
export function footprintSeals(
  w: IsoWindow,
  nodes: readonly FootprintNodeSrc[],
  occurrences: readonly FootprintOccSrc[],
): FootprintSeal[] {
  const out: FootprintSeal[] = [];
  const byId = new Map<string, FootprintNodeSrc>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    if (n.deleted_at !== null || n.status !== "done" || SEAL_KINDS.indexOf(n.kind) < 0 || !inWin(n.completed_at, w)) continue;
    out.push({
      id: n.id,
      nodeId: n.id,
      name: n.name,
      kind: n.kind as FootprintSeal["kind"],
      routeId: n.route_id,
      at: n.completed_at,
      mood: n.mood,
      dueOn: null,
    });
  }
  for (const o of occurrences) {
    const n = byId.get(o.node_id);
    if (!n || n.deleted_at !== null || o.deleted_at !== null || o.status !== "done" || !inWin(o.completed_at, w)) continue;
    out.push({
      id: o.id,
      nodeId: n.id,
      name: n.name,
      kind: n.kind as FootprintSeal["kind"],
      routeId: n.route_id,
      at: o.completed_at,
      mood: o.mood,
      dueOn: o.due_on,
    });
  }
  return out;
}

/**
 * 手記（＝SQLite 版 §3.4 (c)）：存活、event IS NULL（発券／入鋏／済／conflict 都不列，D-筆-22）、body 非空字串、
 * logged_at 落在視窗。節點已 soft delete ⇒ 不列（子樹 soft delete 不會連帶標 work_logs，§8-2 結論）；
 * 節點根本不在 nodes 裡（還沒同步到）⇒ 列出、票名「（原車票已刪除）」、nodeMissing=true。不排序。
 */
export function footprintLogs(
  w: IsoWindow,
  logs: readonly FootprintLogSrc[],
  nodes: readonly FootprintNodeSrc[],
): FootprintLog[] {
  const byId = new Map<string, FootprintNodeSrc>();
  for (const n of nodes) byId.set(n.id, n);
  const out: FootprintLog[] = [];
  for (const l of logs) {
    if (l.deleted_at !== null || l.event !== null || l.body === "" || !inWin(l.logged_at, w)) continue;
    const n = byId.get(l.node_id);
    if (n && n.deleted_at !== null) continue;
    out.push({
      id: l.id,
      nodeId: l.node_id,
      nodeName: n ? n.name : MISSING_NODE_NAME,
      body: l.body,
      at: l.logged_at,
      nodeMissing: !n,
    });
  }
  return out;
}

/** 時間戳分桶成日 key（dayOf＝iso => dayKeyOf(iso, dayStartHour)），去重、升冪 */
export function footprintDayKeys(isos: readonly string[], dayOf: (iso: string) => string): string[] {
  return [...new Set(isos.map(dayOf))].sort();
}

/** 一格的記號（=app.js:119） */
export function dayMark(diaryCount: number, hasFp: boolean): DayMark {
  return diaryCount > 0 ? "diary" : hasFp ? "fp" : "";
}

/* ═══ 月曆（週首由呼叫端傳 uiStore.weekStart：1＝週一、0＝週日＝JS getDay()） ═══ */

function partsOf(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m, d || 1];
}

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

/** 該月所有日 key（month＝YYYY-MM） */
export function monthDays(month: string): string[] {
  const [y, m] = partsOf(month);
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${month}-${pad2(i + 1)}`);
}

/** YYYY-MM ±n 月（=logic.js:271-274） */
export function addMonths(month: string, n: number): string {
  const [y, m] = partsOf(month);
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
}

/** 1 日前面要空幾格：(1 日的 getDay − weekStart + 7) % 7 */
export function monthLeadBlanks(month: string, weekStart: number): number {
  const [y, m] = partsOf(month);
  return (new Date(y, m - 1, 1).getDay() - weekStart + 7) % 7;
}

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** 一週七欄的 getDay() 順序：weekStart=1 ⇒ [1,2,3,4,5,6,0]；0 ⇒ [0..6] */
export function weekdayOrder(weekStart: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
}

/** 月曆欄頭：weekStart=1 ⇒「一二三四五六日」；0 ⇒「日一二三四五六」 */
export function weekdayHeads(weekStart: number): string[] {
  return weekdayOrder(weekStart).map((d) => WEEK_ZH[d]);
}

/** 星期幾的一個字：「日一二三四五六」（=logic.js:266） */
export function weekdayZh(day: string): string {
  const [y, m, d] = partsOf(day);
  return WEEK_ZH[new Date(y, m - 1, d).getDay()];
}

/** 「10/5」（store 的 toast 用） */
export function fmtShortDay(day: string): string {
  const [, m, d] = partsOf(day);
  return m + "/" + d;
}

/* ═══ 車次④・筆記掛樹（契約 §4.3；Stage 0 定稿、之後只加不改） ═══ */

/** 側板筆記區的 kinds（`AttachTarget.nodeKind` 的同一組；車票不含，D-筆-6） */
export const NOTE_NODE_KINDS: readonly NodeKind[] = ["route", "branch", "train", "car"];

/**
 * 某節點底下所有子孫的 id（深度優先、前序；不含自己）。`childrenOf`＝parent id → 子節點 id 陣列（nodeStore.tree 的 childrenOf）。
 * 防環：走過的不再走，自己也不會出現在結果裡（同 flattenAttachTree 的 seen）。
 */
export function descendantIds(childrenOf: Readonly<Record<string, readonly string[]>>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const walk = (cur: string): void => {
    for (const c of childrenOf[cur] ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      walk(c);
    }
  };
  walk(id);
  return out;
}

/** 側板筆記區的快取值（`notesStore.nodeNotes[nodeId]`）：items＝最多 5 則（直接掛的在前）、total＝含底下的總數 */
export interface NodeNotesSummary<T extends NoteRow = NoteRow> {
  items: T[];
  total: number;
}

/** 列表列需要的欄（`NoteListItem` 結構上滿足；domain 不 import data 層） */
export interface NoteItemLike extends NoteRow {
  route_id: string | null;
  node_name: string | null;
  node_kind: NodeKind | null;
}

/**
 * 側板的一列：`noteTitle`、`excerpt(n, 40)`；`where`＝掛在子孫上時「› 節點名」（`node_id !== here`），直接掛的＝null。
 * `here`＝側板目前這個節點的 id；沒有（null）＝一律當直接掛的。
 */
export function nodeNotesLine(
  item: NoteItemLike,
  here: string | null,
): { title: string; excerpt: string; where: string | null } {
  const sub = here !== null && item.node_id !== here && !!item.node_name;
  return { title: noteTitle(item), excerpt: excerpt(item, 40), where: sub ? "› " + item.node_name : null };
}

/**
 * Ctrl+P 的一列：
 *   筆記＝label 是 `noteTitle`、aside 是「M/D・路線名」（沒掛路線只有「M/D」）
 *   日記＝label 是「M/D（週X）」、aside 是 `excerpt(n, 24)`
 * 日期要日界線日：呼叫端傳 `opts.dayOf`（＝`iso => dayKeyOf(iso, dayStartHour)`）；沒傳就取 ISO 前十碼。
 * 路線名：節點本身是路線＝`node_name`；其餘由 `opts.routeName(route_id)` 查（沒傳或查不到＝改用 `node_name`）。
 */
export function quickHitLabel(
  item: NoteItemLike,
  opts: { dayOf?: (iso: string) => string; routeName?: (routeId: string) => string | null | undefined } = {},
): { label: string; aside: string } {
  if (item.kind === "diary") {
    const day = item.entry_date ?? "";
    return {
      label: day ? fmtShortDay(day) + "（週" + weekdayZh(day) + "）" : "（無日期）",
      aside: excerpt(item, 24),
    };
  }
  const day = opts.dayOf ? opts.dayOf(item.noted_at) : item.noted_at.slice(0, 10);
  const when = fmtShortDay(day);
  const where =
    item.node_kind === "route"
      ? item.node_name
      : ((item.route_id && opts.routeName ? opts.routeName(item.route_id) : null) ?? item.node_name);
  return { label: noteTitle(item), aside: where ? when + "・" + where : when };
}

/* ─── 捕捉框的預掛節點（契約 0-2 甲、§3.3、§5.1；store 的 saveCapture 與測試共用這一份） ─── */

/** 捕捉框的預掛節點（側板「＋ 在這裡記一則」帶進來） */
export interface CapturePresetLike {
  /** 筆記存檔時的 node_id（路線／支線／列車／車廂） */
  nodeId: string;
  /** 該節點所屬路線（節點本身是路線＝它自己）；路線已不在＝null */
  routeId: string | null;
  /** 落點列用的字，例「私鐵手帳 › 第三列車」 */
  label: string;
}

/**
 * 預掛節點對存檔的影響（只在 `preset` 有值時動；沒有＝原樣回傳、`nodeId`＝null）：
 *   - 票根＝筆記／收件匣：存成筆記、掛在預掛節點（收件匣票根＋預掛節點＝直接進筆記，不進收件匣）；路線前綴認到的路線與預掛節點的
 *     路線不同＝前綴當一般文字（`prefix`＝null）；相同＝照舊吃掉前綴。回傳 `nodeId`＝預掛節點 id
 *   - 票根＝待辦：不建進樹，只拿預掛節點所屬的路線當路線標籤（落點「→ 今日 · 路線名」）——前綴規則同上；沒打前綴就合成一個
 *     （`matched`＝""；內文＝原字）。預掛節點的路線已不在 `routes` 裡＝不動。`nodeId`＝null
 *   - 日記與別線登記的票根：照舊（預掛節點不影響）
 */
export function applyCapturePreset(
  stub: CaptureStub,
  rawPrefix: RoutePrefix | null,
  text: string,
  preset: CapturePresetLike | null,
  routes: readonly RouteLike[],
): { prefix: RoutePrefix | null; nodeId: string | null } {
  if (!preset) return { prefix: rawPrefix, nodeId: null };
  if (stub === "note" || stub === "inbox") {
    const same = !rawPrefix || rawPrefix.route.id === preset.routeId;
    return { prefix: same ? rawPrefix : null, nodeId: preset.nodeId };
  }
  if (stub === "todo" && preset.routeId) {
    const route = routes.find((r) => r.id === preset.routeId);
    if (!route) return { prefix: rawPrefix, nodeId: null };
    if (rawPrefix && rawPrefix.route.id === route.id) return { prefix: rawPrefix, nodeId: null };
    return {
      prefix: { route, routeId: route.id, prefixLen: 0, matched: "", body: text.replace(/^[ \t　]+/, "") },
      nodeId: null,
    };
  }
  return { prefix: rawPrefix, nodeId: null };
}

/**
 * 筆記清單的篩選互斥（契約 §0-0 P5）：`routeId`（整條路線）與 `underNode`（某節點底下）只能有一個。
 * 兩個同時有值時，與 `prev` 不同的那個（剛設的）勝出、另一個清掉；其餘原樣回傳。
 */
export function exclusiveNodeFilter<Q extends { routeId?: string; underNode?: unknown }>(prev: Q, next: Q): Q {
  if (!next.underNode || !next.routeId) return next;
  return next.underNode !== prev.underNode ? { ...next, routeId: undefined } : { ...next, underNode: undefined };
}

/**
 * 離開編輯那一刻，荷札與閱讀態「該用哪份字」（兩台同時編輯、LWW 後寫贏的收尾）。
 *
 * 情境：B 在編輯態，別台（A）後寫整份改掉並同步拉到 B；B 之後沒再打字就離開。
 * B 的本地 state 還是自己舊打的字，DB／store 裡卻是 A 的版本——拿本地字解析荷札會掛上 DB 內文根本沒有的荷札（孤兒 tagging）。
 *
 * 呼叫時機：存檔鏈 flush 完成之後。自己剛存出去的字，store 會就地換成同一份，所以「store≠本地」只可能是別處改的：
 *   - hasUnsent＝true（還有沒送出的字，例：送出失敗後又打字）⇒ 本地為準；
 *   - 讀不到 store 那一則（被刪、換了篩選）⇒ 本地為準；
 *   - 其餘：比對時忽略內文尾端空白（草稿建檔會 trim 尾端）與空標題（空／空白＝null），不同 ⇒ 遠端贏、用 store 的。
 * 打字途中不套用（會讓游標跳）——只在離開編輯那一刻對齊。
 */
export function resolveLeaveText(
  local: { title: string; body: string },
  stored: { title: string | null; body: string } | null | undefined,
  hasUnsent: boolean,
): { remote: boolean; title: string; body: string } {
  if (hasUnsent || !stored) return { remote: false, ...local };
  const normTitle = (t: string | null | undefined) => (t && t.trim() ? t : "");
  const same = stored.body.trimEnd() === local.body.trimEnd() && normTitle(stored.title) === normTitle(local.title);
  if (same) return { remote: false, ...local };
  return { remote: true, title: stored.title ?? "", body: stored.body };
}

// ───────────────────────── 階段⑤ 捕捉小窗（契約 §4.6）─────────────────────────

/** 正式版的 identifier（`src-tauri/tauri.conf.json`）；「預設開機自啟」只對它做，dev／沙盒的 identifier 都不同 */
export const NS_PROD_IDENTIFIER = "app.shitetsu.nextstop";

/**
 * 這個網址的查詢字串是不是捕捉小窗（`?window=capture`）。不分大小寫、容許其他參數、壞字串回 false。
 * 小窗的網址由 `tauri.conf.json` 第二個視窗的 `url` 給；`?mock=1&window=capture` 則是瀏覽器預覽。
 */
export function captureWindowFromSearch(search: string): boolean {
  try {
    for (const [k, v] of new URLSearchParams(search)) {
      if (k.toLowerCase() === "window" && v.trim().toLowerCase() === "capture") return true;
    }
  } catch {
    // 非法字串：當成不是小窗
  }
  return false;
}

/**
 * 「第一次執行就把開機自啟打開」該不該做（契約 0-15）：只在打包版（isProd）＋正式 identifier、且還沒做過（旗標不是 "1"）時為真。
 * dev／沙盒（identifier 不同，或 import.meta.env.PROD 為 false）永遠為假——它們不能去動使用者真實的開機項目。
 */
export function shouldApplyAutostartDefault(isProd: boolean, identifier: string, flag: string | null): boolean {
  return isProd && identifier === NS_PROD_IDENTIFIER && flag !== "1";
}

/** 小窗的開合狀態（只看「有沒有東西開著」：捕捉票、變待辦預覽框） */
export interface CaptureWindowOpenState {
  capture: boolean;
  preview: boolean;
}

/**
 * 小窗的收法（契約 §4.3-3、§0-0／D-筆-61）：store 從 `prev` 變成 `next` 時小窗該做什麼。
 * - `saved`：票（或預覽框）收起、而且是存檔／建立正在飛的時候收的 ⇒ 還前景、蓋章、播完才 hide。
 * - `esc`：收起、但不是存檔收的（Esc 放棄、預覽框取消）⇒ 還前景再 hide。
 * - `null`：沒收起（剛開、捕捉票換成預覽框、還開著）。
 * `saving`＝`saveCapture`／`confirmPreview` 正在執行（小窗包一層計數；store 在寫入成功後才把 capture／preview 設成 null，
 * 失敗時留著——所以「飛行中收起」就是存成功）。
 */
export function captureWindowTransition(
  prev: CaptureWindowOpenState,
  next: CaptureWindowOpenState,
  saving: boolean,
): "saved" | "esc" | null {
  const wasOpen = prev.capture || prev.preview;
  const isOpen = next.capture || next.preview;
  if (!wasOpen || isOpen) return null;
  return saving ? "saved" : "esc";
}

/**
 * 小窗：Enter／Ctrl+Enter 一按下去，要不要**馬上**把前景還給原 App（不等存檔寫完；D-筆-61 的補強）。
 * 存檔的 DB 寫入加 IPC 要 65–125ms，這段期間鍵盤還在小窗手上，Enter 後馬上打的字會掉。
 * 只在「幾乎確定會寫入」時還：
 * - `save`（saveCapture）：有票、去掉空白後有字、而且不是會轉成預覽框的多行待辦（轉預覽框時小窗要留著給人挑）。
 * - `confirm`（confirmPreview）：預覽框開著、而且有東西可建（單筆，或至少勾了一行）。
 * 判斷錯了（例如只剩路線前綴的空內文、寫入失敗）也不會丟字：呼叫端事後用 `revive` 把小窗叫回來。
 */
export function captureWindowReleaseEarly(
  s: {
    capture: { text: string; stub: CaptureStub } | null;
    preview: { single: boolean; lines: { checked: boolean }[] } | null;
  },
  kind: "save" | "confirm",
): boolean {
  if (kind === "confirm") {
    return !!s.preview && (s.preview.single || s.preview.lines.some((l) => l.checked));
  }
  const c = s.capture;
  if (!c || !c.text.trim()) return false;
  return !needsPreview(c.stub, c.text.replace(/\s+$/, ""));
}

/** 小窗的 DB 附著在主視窗的連線上（契約 0-10）：主視窗還沒 load 好時 plugin-sql 回「database … not loaded」 */
export const CAPTURE_DB_NOT_READY = "App 還在開啟，請再按一次 Enter";

/** 小窗的存檔失敗 toast 要不要換字：plugin-sql 的「not loaded」換成 `CAPTURE_DB_NOT_READY`；其餘照原文（回 null） */
export function captureWindowToastText(message: string): string | null {
  return /not\s+loaded/i.test(message) ? CAPTURE_DB_NOT_READY : null;
}

/** 「預設開機自啟一次」用到的外部動作（autostartBoot.ts 接真的；測試接假的） */
export interface AutostartDefaultDeps {
  isProd: boolean;
  /** 開機自啟現況；`name`＝登錄檔值名＝identifier；`debugBuild`＝這支 exe 是 debug 建置（Rust `cfg!(debug_assertions)`） */
  get(): Promise<{ available: boolean; enabled: boolean; name: string; debugBuild: boolean }>;
  enable(): Promise<unknown>;
  readFlag(): Promise<string | null>;
  writeFlag(): Promise<void>;
}

/**
 * 「第一次執行就把開機自啟打開」整趟（契約 0-15）：
 * 外掛沒掛成功（available=false）、或是 debug 建置（debugBuild）⇒ 什麼都不做、旗標也不寫（下次啟動再看）；
 * `shouldApplyAutostartDefault` 為假 ⇒ 不做；已經開著 ⇒ 只寫旗標；
 * 否則 enable——**不論成敗**都寫旗標（只做一次，失敗由呼叫端 toast 一次，開關仍在設定〈一般〉）。
 * 永遠 resolve；回傳結果給呼叫端決定要不要 toast。
 */
export async function autostartDefaultOnce(
  deps: AutostartDefaultDeps,
): Promise<{ kind: "skipped" } | { kind: "enabled" } | { kind: "already" } | { kind: "failed"; error: string }> {
  let info: { available: boolean; enabled: boolean; name: string; debugBuild: boolean };
  let flag: string | null;
  try {
    info = await deps.get();
    if (!info.available) return { kind: "skipped" };
    // 第三道閘：debug exe 不做——「正式 identifier 的 debug exe」（沙盒流程換回正式 exe 時 build 出來的）與安裝版共用
    // 登錄檔值名和 DB，做了會把使用者真實的 Run 值改成指向 debug exe、旗標又寫進共用的 settings。旗標也不寫（留給真正的安裝版）。
    if (info.debugBuild) return { kind: "skipped" };
    flag = await deps.readFlag();
  } catch {
    return { kind: "skipped" };
  }
  if (!shouldApplyAutostartDefault(deps.isProd, info.name, flag)) return { kind: "skipped" };
  let out: { kind: "enabled" } | { kind: "already" } | { kind: "failed"; error: string };
  if (info.enabled) out = { kind: "already" };
  else {
    try {
      await deps.enable();
      out = { kind: "enabled" };
    } catch (e) {
      out = { kind: "failed", error: e instanceof Error ? e.message : String(e ?? "") };
    }
  }
  try {
    await deps.writeFlag();
  } catch {
    // 旗標寫不進去：下次啟動會再試一次 enable（已開著就只補旗標），不致命
  }
  return out;
}

/* ═══ 手機分享進收件匣（⑤ D-筆-63；手機沙盒 M7） ═══ */

/** Kotlin `take_shared` 交出來的一筆 */
export interface SharedItemLike {
  id: string;
  text: string;
  subject?: string;
}

/** 標題（例如網頁標題）有、且內文沒包含它時，放在第一行 */
export function shareBody(it: SharedItemLike): string {
  const text = it.text.trim();
  const subject = it.subject?.trim();
  return subject && !text.includes(subject) ? `${subject}\n${text}` : text;
}

/** 收完一輪的提示句 */
export function shareToastText(count: number): string {
  return count === 1 ? "收到分享，放進收件匣了" : `收到 ${count} 則分享，放進收件匣了`;
}

/** 「取分享」整趟用到的外部動作（useShareIntake.ts 接真的；測試接假的） */
export interface ShareDrainDeps {
  take(): Promise<SharedItemLike[]>;
  create(body: string): Promise<void>;
  ack(ids: string[]): Promise<void>;
  /** 這一輪收進來的則數（>0 才叫）：重讀收件匣＋提示 */
  after(count: number): Promise<void> | void;
  onError(e: unknown): void;
}

/**
 * 取分享的排程器：取＋確認兩段（每筆先建成收件匣筆記，成功後才 ack——中途被殺，下次再取不丟字）。
 * 觸發點有好幾個（冷啟動、回前景、plugin 的 `shared` 事件），收到一半又被敲門時**不能直接丟掉**——
 * 記一筆 `again`，這輪收完再取一次，直到佇列是空的（手機沙盒 M7：背景連送兩則，第二則的事件
 * 撞上第一則的 drain，舊寫法直接 return，第二則要等下一次回前景才收）。整輪只提示一次（合計則數）。
 */
export function createShareDrainer(deps: ShareDrainDeps): () => Promise<void> {
  let running = false;
  let again = false;
  return async function drain(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    let total = 0;
    try {
      do {
        again = false;
        const items = await deps.take();
        if (items.length === 0) continue;
        const done: string[] = [];
        for (const it of items) {
          const body = shareBody(it);
          if (body) await deps.create(body);
          done.push(it.id);
        }
        await deps.ack(done);
        total += done.length;
      } while (again);
    } catch (e) {
      deps.onError(e);
    } finally {
      running = false;
    }
    if (total > 0) {
      try {
        await deps.after(total);
      } catch (e) {
        deps.onError(e);
      }
    }
  };
}
