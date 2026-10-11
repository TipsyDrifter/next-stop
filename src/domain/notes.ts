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
import type { Mood, NodeRow } from "./node";

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
  return isToday ? { text: "今天還沒有寫日記", button: "寫日記" } : { text: "這天沒有寫日記", button: "補記" };
}

/** 草稿內文的 placeholder（=app.js:378） */
export function diaryPlaceholder(isToday: boolean): string {
  return isToday ? "今天過得怎麼樣…" : "那天發生了什麼…（旁邊的足跡可以翻）";
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
  if (f.logs.length) parts.push(f.logs.length + " 則手記");
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
