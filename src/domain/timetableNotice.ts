/**
 * 時刻表 ①c・通知用純函式（①b①c 契約 §4.7；丙席 Stage 0-C 全文）。
 *
 * 鐵則：只准 `import … from "./timetable.ts"`（含副檔名）——`scripts/tests/timetable-notice.test.ts` 以 node 直接載入。
 * 只用可剝除語法（不用 enum／namespace／參數屬性）；lib 目標 ES2020。時間一律毫秒。
 *
 * 內容：
 *   - `PENDING_DEPART_UNTIL_NEXT`（契約 0-5：主對話裁乙「蓋到下一班為止」）
 *   - `CAT_PALETTE`（＝timetable.css §A 逐值；測試 D8 對帳）、`TT_NOTICE_TEXT`（N 系列固定字）
 *   - 佇列動作 `PendingAction`、通知狀態 `NoticeState`（JS → Kotlin 的 JSON 形狀，§5.10.4 的 `state` 鍵）
 *   - `noticeTiles`（0-10、D-時-32）、`tileOf`、`buildNoticeState`、`sortPending`、`reminderOf`
 *
 * 車次②（② 契約 §4.5；丙）：`buildNoticeState` 多收 `linkLabel`／`taskEstimateMin`（運行中那班顯示「分類・任務名」、
 * 門檻多一層任務的預計時間）；`noticeRunName`（＝`timetableLink` 的 `runLabel(cat, clipLabel(label))` 同義副本）。
 */
import {
  MIN,
  colorSlot,
  fmtClock,
  fmtDur,
  leafCategories,
  msOf,
  thresholdOf,
  type Threshold,
  type TimeBlockRow,
  type TimeCategoryRow,
} from "./timetable.ts";

/** 0-5：false＝〈開工決定〉原文（照 at 套）；true＝「蓋到下一班為止」（主對話 2026-10-13 裁乙）。主對話放行才改 */
export const PENDING_DEPART_UNTIL_NEXT = true;

/** 通知用的分類色：與 timetable.css §A 逐值相同（測試 D8 對帳）。Kotlin 依系統深淺色挑一組 */
export const CAT_PALETTE: { light: readonly string[]; dark: readonly string[] } = {
  light: ["#4757a6", "#964468", "#326b4b", "#8a5a2b", "#2f6f86", "#6b4aa0", "#a0503f", "#5c5b7d"],
  dark: ["#a9c0ea", "#e6a8c0", "#a6c9ad", "#d9b98a", "#95c6d6", "#c2aee6", "#e6a88a", "#a3a9b8"],
};

export const TT_NOTICE_TEXT = {
  idleTitle: "目前沒有列車在跑",
  /** D-時-29：隱藏敏感內容時的簡短版 */
  publicRunning: "時刻表・運行中",
  publicIdle: "時刻表・停車中",
  arrive: "到着",
  startedSuffix: " 発",
  /** 展開版運行列「14:35 発・預估 1h」的後半（＝App 裡的預估 chip 字；Kotlin 用「・」接在 startedLabel 後面） */
  estimate: (min: number) => `預估 ${fmtDur(min * MIN)}`,
  reminderTitle: (name: string, thMin: number) => `${name}已經跑了 ${fmtDur(thMin * MIN)}，還在嗎？`,
  reminderBody: "點開時刻表修正",
  droppedArrive: "通知上的「到着」沒記上：那時已經沒有列車在跑",
  droppedDepartCategory: "通知上的発車沒記上：那個分類已經不在了",
  droppedDepartCovered: "通知上的発車沒記上：那段時間另一台已經記了別的",
} as const;

export interface PendingAction {
  /** Kotlin `UUID.randomUUID().toString()` */
  id: string;
  kind: "depart" | "arrive";
  /** depart 才有 */
  categoryId: string | null;
  /** 按下的 wall clock 毫秒 */
  at: number;
  /** 按下當時通知以為在跑的 block id（可能是 "pending:<actionId>"）；只記錄、不參與判斷 */
  expectRunningId: string | null;
}

export interface NoticeTile {
  categoryId: string;
  name: string;
  glyph: string;
  colorLight: string;
  colorDark: string;
  /** 這個分類發車後的門檻（分；分類預設→全域；null＝不排提醒）——Kotlin 樂觀更新時排提醒用 */
  thresholdMin: number | null;
  /** 預先排好的提醒標題（Kotlin 不格式化時長） */
  reminderTitle: string | null;
}

export interface NoticeRunning extends NoticeTile {
  id: string;
  startedAt: number;
  /** 「14:35 発」 */
  startedLabel: string;
  /** 「創作・14:35 発」（＝notice.ts runningNoticeText 的 title，同一份字） */
  subText: string;
  /** 這一班的預估「預估 1h」（沒預估＝null）；只畫在展開版運行列（「14:35 発・預估 1h」，原型 v-e.js ntContent） */
  estimateText: string | null;
}

export interface NoticeState {
  v: 1;
  /** 運行中顯示（關＝收掉 72501） */
  enabled: boolean;
  tilesEnabled: boolean;
  longRunEnabled: boolean;
  running: NoticeRunning | null;
  /** ≤5 */
  tiles: NoticeTile[];
  text: {
    idleTitle: string;
    publicRunning: string;
    publicIdle: string;
    arrive: string;
    startedSuffix: string;
    reminderBody: string;
  };
}

/** 佇列套用的一筆結果（noticePending 用） */
export type PendingOutcome =
  | { kind: "departed"; blockId: string }
  | { kind: "arrived"; blockIds: string[] }
  | { kind: "duplicate" }
  | { kind: "dropped"; reason: "noRunning" | "unknownCategory" | "covered" | "invalid" };

export const NOTICE_TILES_MAX = 5;

/**
 * 常用分類格（契約 0-10、D-時-32）。回 ≤ n 個「還在、沒封存、是子分類」的分類。
 *   1. 釘選先放，照主人排的順序（含運行中那個也照放——那格亮起來）。
 *   2. 不足 n 補最近用過（`recentIds` 依最後一次開始遞減；運行中那個**不排除**，且一律當成最近用過的第一名）。
 *   3. 還不足補 `leafCategories(cats)` 的順序（新裝置、還沒記過什麼）。
 * 顯示順序：釘選在前（主人排的順序）；補進來的（2＋3）照 leafCategories 的順序排，**不照最近排**——
 * 點格子換車時格子不跳位。釘滿 n 個、運行中那個沒被釘 ⇒ 沒有亮的那格（主人接受）。
 */
export function noticeTiles(
  cats: readonly TimeCategoryRow[],
  recentIds: readonly string[],
  pins: readonly string[],
  runningCatId: string | null,
  n: number = NOTICE_TILES_MAX,
): TimeCategoryRow[] {
  const leaves = leafCategories(cats);
  const leafById = new Map<string, TimeCategoryRow>();
  const leafRank = new Map<string, number>();
  leaves.forEach((c, i) => {
    leafById.set(c.id, c);
    leafRank.set(c.id, i);
  });
  const limit = Math.max(0, Math.floor(n));
  const taken = new Set<string>();

  const pinned: TimeCategoryRow[] = [];
  for (const id of pins) {
    if (pinned.length >= limit) break;
    const c = leafById.get(id);
    if (!c || taken.has(id)) continue;
    taken.add(id);
    pinned.push(c);
  }

  const fill: TimeCategoryRow[] = [];
  const room = (): boolean => pinned.length + fill.length < limit;
  const recent = runningCatId !== null ? [runningCatId, ...recentIds] : recentIds;
  for (const id of recent) {
    if (!room()) break;
    const c = leafById.get(id);
    if (!c || taken.has(id)) continue;
    taken.add(id);
    fill.push(c);
  }
  for (const c of leaves) {
    if (!room()) break;
    if (taken.has(c.id)) continue;
    taken.add(c.id);
    fill.push(c);
  }
  fill.sort((a, b) => (leafRank.get(a.id) ?? 0) - (leafRank.get(b.id) ?? 0));
  return pinned.concat(fill);
}

function paletteOf(colorIdx: number): { colorLight: string; colorDark: string } {
  const i = colorSlot(colorIdx) - 1;
  return { colorLight: CAT_PALETTE.light[i], colorDark: CAT_PALETTE.dark[i] };
}

function glyphOf(cat: TimeCategoryRow): string {
  return cat.glyph ?? Array.from(cat.name)[0] ?? "・";
}

/**
 * ②（車次② 契約 §4.5、0-13）：「分類・任務名」與 16 字截字。
 * 本檔只准 import `./timetable.ts`（§4.1），所以這兩支是 `timetableLink.ts` 的 `runLabel`／`clipLabel` 的同義副本；
 * `timetable-notice.test.ts` D-②5 逐例對帳兩邊相同。
 */
const LABEL_CLIP = 16;
function clipTaskLabel(s: string): string {
  const chars = Array.from(s);
  return chars.length <= LABEL_CLIP ? s : chars.slice(0, LABEL_CLIP - 1).join("") + "…";
}
/** 有任務名 ⇒ `${catName}・${clip(label)}`；null／undefined ⇒ 只有分類名 */
export function noticeRunName(catName: string, linkLabel: string | null | undefined): string {
  return linkLabel === null || linkLabel === undefined ? catName : `${catName}・${clipTaskLabel(linkLabel)}`;
}

/** 一格：圓牌字＝glyph ?? 名稱第一字 ?? "・"（＝CategoryBadge）；顏色＝CAT_PALETTE；門檻＝分類預設→全域（發車時還沒有預估） */
export function tileOf(cat: TimeCategoryRow, globalMaxMin: number): NoticeTile {
  const th = thresholdOf(null, cat, globalMaxMin);
  return {
    categoryId: cat.id,
    name: cat.name,
    glyph: glyphOf(cat),
    ...paletteOf(cat.color_idx),
    thresholdMin: th ? th.min : null,
    reminderTitle: th ? TT_NOTICE_TEXT.reminderTitle(cat.name, th.min) : null,
  };
}

/**
 * 給 Kotlin 的整份通知狀態（§5.10.4 `state`）。
 * running 的 subText＝`${name}・${fmtClock(start)} 発`（＝notice.ts runningNoticeText 的 title，補充契約 §3-4）；
 * running 的門檻用 `thresholdOf(running.estimate_min, cat, globalMaxMin)`（這一班的預估優先）；
 * running.estimateText＝`預估 ${fmtDur}`（沒預估＝null），Kotlin 只在展開版接成「14:35 発・預估 1h」。
 * 分類已不在（同步途中）⇒ 名稱「？」、圓牌「？」、色盤第 1 色（＝①a notice 的「？」）。
 * tiles 一律照算（tilesEnabled 只是給 Kotlin 決定畫不畫）。
 *
 * ②（契約 §4.5）：`linkLabel`＝運行中那班連到的任務名（`linkLabelOf` 的結果；呼叫端不必先截）——有 ⇒ running.name、
 * subText、reminderTitle 都用「分類・任務名」（任務名截到 16 字）；圓牌、顏色照舊是分類的。
 * `taskEstimateMin`＝任務的預計時間（`taskEstimateOf`）——門檻多一層（預估 → 任務 → 分類 → 全域）。兩欄不給＝跟 ①c 一樣。
 */
export function buildNoticeState(input: {
  enabled: boolean;
  tilesEnabled: boolean;
  longRunEnabled: boolean;
  running: TimeBlockRow | null;
  catById: Record<string, TimeCategoryRow>;
  categories: readonly TimeCategoryRow[];
  recentIds: readonly string[];
  pins: readonly string[];
  globalMaxMin: number;
  linkLabel?: string | null;
  taskEstimateMin?: number | null;
}): NoticeState {
  let running: NoticeRunning | null = null;
  const r = input.running;
  if (r) {
    const cat = input.catById[r.category_id] ?? null;
    const name = noticeRunName(cat ? cat.name : "？", input.linkLabel);
    const th: Threshold | null = thresholdOf(r.estimate_min, cat, input.globalMaxMin, input.taskEstimateMin ?? null);
    const startedAt = msOf(r.started_at);
    const startedLabel = fmtClock(startedAt) + TT_NOTICE_TEXT.startedSuffix;
    running = {
      categoryId: r.category_id,
      name,
      glyph: cat ? glyphOf(cat) : "？",
      ...paletteOf(cat ? cat.color_idx : 1),
      thresholdMin: th ? th.min : null,
      reminderTitle: th ? TT_NOTICE_TEXT.reminderTitle(name, th.min) : null,
      id: r.id,
      startedAt,
      startedLabel,
      subText: `${name}・${startedLabel}`,
      estimateText: r.estimate_min !== null && r.estimate_min > 0 ? TT_NOTICE_TEXT.estimate(r.estimate_min) : null,
    };
  }
  const tiles = noticeTiles(input.categories, input.recentIds, input.pins, r ? r.category_id : null).map((c) =>
    tileOf(c, input.globalMaxMin),
  );
  return {
    v: 1,
    enabled: input.enabled,
    tilesEnabled: input.tilesEnabled,
    longRunEnabled: input.longRunEnabled,
    running,
    tiles,
    text: {
      idleTitle: TT_NOTICE_TEXT.idleTitle,
      publicRunning: TT_NOTICE_TEXT.publicRunning,
      publicIdle: TT_NOTICE_TEXT.publicIdle,
      arrive: TT_NOTICE_TEXT.arrive,
      startedSuffix: TT_NOTICE_TEXT.startedSuffix,
      reminderBody: TT_NOTICE_TEXT.reminderBody,
    },
  };
}

/**
 * 這一筆佇列動作合不合法（不合法＝歸 invalid、照樣 ack 掉）：
 * id 是非空字串、kind 是 depart／arrive、at 是有限數；depart 另要非空的 categoryId。
 * 輸入來自 Kotlin 的 JSON，型別不可信，所以每一欄都實查。
 */
export function pendingIsValid(a: PendingAction): boolean {
  if (a === null || typeof a !== "object") return false;
  if (typeof a.id !== "string" || a.id === "") return false;
  if (typeof a.at !== "number" || !Number.isFinite(a.at)) return false;
  if (a.kind === "arrive") return true;
  return a.kind === "depart" && typeof a.categoryId === "string" && a.categoryId !== "";
}

/**
 * 通知／系統匣上的発車套不套得上這個分類（noticePending.applyOne 與 noticeDesktop.handleTrayAction 共用，兩端一致）：
 * 分類還在（沒刪）而且是子分類 ⇒ 套。**封存的照樣套**——封存只是不出現在格子／選單裡，分類本身還在
 * （按下去那一刻通知或選單上還有它，主人的意思就是記這個）。不在／已刪／頂層組 ⇒ 不套。
 */
export function noticeDepartCategoryOk(cat: TimeCategoryRow | null | undefined): cat is TimeCategoryRow {
  return !!cat && cat.deleted_at === null && cat.parent_id !== null;
}

/**
 * 套用順序：合法的依 at 遞增、同 at 依 id；不合法的排在最後（依 id，沒有 id 的照原順序）。
 * 不改輸入、不丟錯。
 */
export function sortPending(actions: readonly PendingAction[]): PendingAction[] {
  const idOf = (a: PendingAction): string => (a !== null && typeof a === "object" && typeof a.id === "string" ? a.id : "");
  const byId = (a: PendingAction, b: PendingAction): number => {
    const x = idOf(a);
    const y = idOf(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const ok: PendingAction[] = [];
  const bad: PendingAction[] = [];
  for (const a of actions) (pendingIsValid(a) ? ok : bad).push(a);
  ok.sort((a, b) => a.at - b.at || byId(a, b));
  bad.sort(byId);
  return ok.concat(bad);
}

/**
 * 下一次「跑太久」提醒（Android／桌機共用）：running 存在、longRunEnabled、未確認（long_run_ack !== 1）、
 * 門檻非 null、提醒時刻 > now + 60 秒 才回；其餘 null（＝取消）。
 */
export function reminderOf(
  running: TimeBlockRow | null,
  th: Threshold | null,
  name: string,
  longRunEnabled: boolean,
  now: number,
): { blockId: string; fireAt: number; title: string } | null {
  if (!running || !longRunEnabled || running.long_run_ack === 1 || th === null) return null;
  const fireAt = msOf(running.started_at) + th.min * MIN;
  if (!(fireAt > now + 60_000)) return null;
  return { blockId: running.id, fireAt, title: TT_NOTICE_TEXT.reminderTitle(name, th.min) };
}

/** 一則提醒的簽章（去重／比對「已經排好的是不是同一個」用） */
export function reminderSig(rem: { blockId: string; fireAt: number; title: string }): string {
  return `${rem.blockId}|${rem.fireAt}|${rem.title}`;
}

/**
 * 現在該排著的提醒（Android 的 `syncLongRunReminder` 用；桌機 desktopReminder 同一套規則）：
 * 60 秒規則只擋「新排」。`reminderOf` 給了 ⇒ 照排；落在提醒前 60 秒內（還沒到點）而且已經排好的就是同一個
 * （`scheduledSig` 相同；`null`＝這個行程還沒排過、不知道 Kotlin 手上有什麼，也當成同一個留著）⇒ 留著；
 * 已經到點／過點、換了班、改了門檻、確認過、關掉開關 ⇒ null（＝取消）。
 */
export function reminderToKeep(
  running: TimeBlockRow | null,
  th: Threshold | null,
  name: string,
  longRunEnabled: boolean,
  now: number,
  scheduledSig: string | null,
): { blockId: string; fireAt: number; title: string } | null {
  const rem = reminderOf(running, th, name, longRunEnabled, now);
  if (rem) return rem;
  const keep = reminderOf(running, th, name, longRunEnabled, Number.NEGATIVE_INFINITY);
  if (!keep || !(keep.fireAt > now)) return null;
  return scheduledSig === null || scheduledSig === reminderSig(keep) ? keep : null;
}
