/**
 * 時刻表 ①c・桌機系統匣選單的純函式（①b①c 契約 §4.9、§5.11；丁席）。
 *
 * 鐵則：只准 `import … from "./timetable.ts"`（含副檔名）——`scripts/tests/timetable-tray.test.ts` 以 node 直接載入。
 * 只用可剝除語法；lib 目標 ES2020。時間一律毫秒。
 *
 * 分工：這裡只算「選單要長什麼樣」（`TrayMenuSpec`，與 Rust `tray.rs` 同形）與 tooltip 字；
 * 真的建選單、把點擊翻成 `TrayAction` 是 Rust（`tray.rs` 的 `build_menu`／`parse_tt_menu_id`）；
 * 收到 `tt-tray` 事件後換車／到着是 `TimetableDesktopAgent`＋`noticeDesktop.handleTrayAction`。
 * 長相照原型情境 2（`prototypes/時刻表-src/v-e.js` trayMenuHtml）：「全部分類 ▸」一層平鋪、灰字分組名——
 * 組在 spec 裡照舊是 `groups[]`，平鋪是 Rust 建選單時的畫法。
 *
 * 車次②（② 契約 §4.5；丙）：`buildTrayMenu`／`trayTooltipOf` 多收 `linkLabel`，header／tooltip 寫「分類・任務名」。
 */
import { MIN, fmtClock, fmtDur, groupedCategories, msOf, type TimeBlockRow, type TimeCategoryRow } from "./timetable.ts";

export interface TrayCat {
  id: string;
  label: string;
}

export interface TrayGroup {
  label: string;
  items: TrayCat[];
}

/** 與 Rust `tray.rs` 的 `TrayMenuSpec` 同形（serde camelCase） */
export interface TrayMenuSpec {
  /** 不可點的第一列 */
  header: string;
  /** true ⇒「到着」＋「換車 ▸」；false ⇒「発車 ▸」 */
  running: boolean;
  /** 常用分類（≤5；格子關掉＝[]） */
  quick: TrayCat[];
  /** 「全部分類 ▸」依組 */
  groups: TrayGroup[];
  /** 子選單裡這個分類 disabled */
  runningCategoryId: string | null;
}

export const TT_TRAY_TEXT = {
  idleHeader: "目前沒有列車在跑",
  header: (name: string, start: number, elapsedMs: number) => `${name}・${fmtClock(start)} 発（${fmtDur(elapsedMs)}）`,
  tooltip: (name: string, start: number, elapsedMs: number) => `Next Stop・${name}・${fmtClock(start)} 発（${fmtDur(elapsedMs)}）`,
  tooltipIdle: "Next Stop・目前沒有列車在跑",
  tooltipOff: "Next Stop",
  reminderBody: "回到時刻表修正",
} as const;

export interface TrayMenuInput {
  enabled: boolean;
  tilesEnabled: boolean;
  running: TimeBlockRow | null;
  catById: Record<string, TimeCategoryRow>;
  categories: readonly TimeCategoryRow[];
  tiles: readonly TimeCategoryRow[];
  now: number;
  /** ②：運行中那班連到的任務名（`linkLabelOf`；呼叫端不必先截）；有 ⇒ header 寫「分類・任務名」 */
  linkLabel?: string | null;
}

/**
 * ②（車次② 契約 §4.5、0-13）：「分類・任務名」，任務名截到 16 字（多的換「…」）。
 * 本檔只准 import `./timetable.ts`（§4.1）⇒ 這是 `timetableLink` 的 `runLabel(cat, clipLabel(label))` 同義副本；
 * `timetable-tray.test.ts` E-②3 逐例對帳。
 */
export function trayRunName(catName: string, linkLabel: string | null | undefined): string {
  if (linkLabel === null || linkLabel === undefined) return catName;
  const chars = Array.from(linkLabel);
  return `${catName}・${chars.length <= 16 ? linkLabel : chars.slice(0, 15).join("") + "…"}`;
}

/** Rust 收到「header 是空字串」的 spec ＝ 建回 ①a 的「開啟 Next Stop／分隔線／結束」（0-16：運行中顯示關掉） */
export const TRAY_MENU_OFF: TrayMenuSpec = { header: "", running: false, quick: [], groups: [], runningCategoryId: null };

/** Rust `tray.rs` 送上來的動作（`#[serde(tag = "kind", rename_all = "camelCase")]`） */
export type TrayAction = { kind: "arrive" } | { kind: "depart"; categoryId: string };

/** 經過時間取整到分（往下取）：同一分鐘內 spec／tooltip 都不變 ⇒ 去重簽章穩定；開始在未來（時鐘倒退）＝0 */
export function trayElapsedMs(start: number, now: number): number {
  return Math.max(0, Math.floor((now - start) / MIN)) * MIN;
}

function catName(catById: Record<string, TimeCategoryRow>, id: string): string {
  return catById[id]?.name ?? "？";
}

function trayCat(c: TimeCategoryRow): TrayCat {
  return { id: c.id, label: c.name };
}

/**
 * 系統匣選單（§4.9、§5.11）：
 *   enabled=false ⇒ null（0-16：呼叫端改送 `TRAY_MENU_OFF`，Rust 收到「空 header」＝建回「開啟／結束」）；
 *   groups＝groupedCategories(categories)（自動排除封存）、每組 items＝子分類；**沒有子分類的組不列**（空的灰字標題沒有意義）；
 *   quick＝tilesEnabled ? tiles : []（tiles＝`noticeTiles(...)`，與手機通知格同一份）；
 *   header＝running ? TT_TRAY_TEXT.header(...) : idleHeader；elapsed 取整到分。
 *   分類已不在（同步途中）⇒ 名稱「？」（＝①a notice 的「？」）。
 */
export function buildTrayMenu(input: TrayMenuInput): TrayMenuSpec | null {
  if (!input.enabled) return null;
  const r = input.running;
  const groups: TrayGroup[] = [];
  for (const g of groupedCategories(input.categories)) {
    if (g.children.length === 0) continue;
    groups.push({ label: g.group.name, items: g.children.map(trayCat) });
  }
  const quick = input.tilesEnabled ? input.tiles.map(trayCat) : [];
  let header: string = TT_TRAY_TEXT.idleHeader;
  if (r) {
    const start = msOf(r.started_at);
    header = TT_TRAY_TEXT.header(trayRunName(catName(input.catById, r.category_id), input.linkLabel), start, trayElapsedMs(start, input.now));
  }
  return { header, running: r !== null, quick, groups, runningCategoryId: r ? r.category_id : null };
}

/**
 * 系統匣 tooltip（§5.11）：運行中＝「Next Stop・創作・14:35 発（1h20m）」（經過時間取整到分）；
 * 停車中＝「Next Stop・目前沒有列車在跑」；運行中顯示關掉＝「Next Stop」（不透露運行狀態，①a 補充契約 §3-2）。
 * ②：`linkLabel`（運行中那班連到的任務名）有 ⇒「Next Stop・創作・寫契約・14:35 発（1h20m）」（任務名截到 16 字）。
 */
export function trayTooltipOf(input: {
  enabled: boolean;
  running: TimeBlockRow | null;
  catById: Record<string, TimeCategoryRow>;
  now: number;
  linkLabel?: string | null;
}): string {
  if (!input.enabled) return TT_TRAY_TEXT.tooltipOff;
  const r = input.running;
  if (!r) return TT_TRAY_TEXT.tooltipIdle;
  const start = msOf(r.started_at);
  return TT_TRAY_TEXT.tooltip(trayRunName(catName(input.catById, r.category_id), input.linkLabel), start, trayElapsedMs(start, input.now));
}
