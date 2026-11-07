/**
 * pinSnapshot——主視窗算好、丟給桌面小窗的快照（⑬ 外部入口；契約 第三節、第九節），與手機小工具 `widget_sync` 的 state。
 *
 * 小窗沒有 DB 權限、沒有 store：畫面要的東西全在這一包裡（顏色兩組都給，小窗自己照主題挑；到着発車只回傳動作）。
 * 鐵則：只 import 同目錄帶 `.ts` 的純函式檔、只用可剝除語法——`scripts/tests/external-link.test.ts` 以 node 直接載入。
 */
import { colorSlot, fmtClock, msOf, type TimeBlockRow, type TimeCategoryRow } from "./timetable.ts";
import { CAT_PALETTE, TT_NOTICE_TEXT, noticeTiles, tileOf, type NoticeTile } from "./timetableNotice.ts";

export const PIN_TILES_MAX = 4;

export interface PinTile {
  categoryId: string;
  name: string;
  glyph: string;
  colorLight: string;
  colorDark: string;
}

export interface PinSnapshot {
  theme: "light" | "dark";
  /** 今日還有幾張（useTodayCount().left） */
  left: number;
  running: null | {
    name: string;
    ticket: string | null;
    glyph: string;
    colorLight: string;
    colorDark: string;
    startedAt: number;
    startedLabel: string;
  };
  /** ≤4，不含正在跑的 */
  tiles: PinTile[];
}

/** 圓牌：字＝glyph ?? 名稱第一字 ?? "・"（＝CategoryBadge）；顏色＝CAT_PALETTE；分類已不在（同步途中）＝「？」、第 1 色（＝通知） */
function faceOf(cat: TimeCategoryRow | null): { name: string; glyph: string; colorLight: string; colorDark: string } {
  const i = colorSlot(cat ? cat.color_idx : 1) - 1;
  return {
    name: cat ? cat.name : "？",
    glyph: cat ? (cat.glyph ?? Array.from(cat.name)[0] ?? "・") : "？",
    colorLight: CAT_PALETTE.light[i],
    colorDark: CAT_PALETTE.dark[i],
  };
}

/**
 * 格子先多算一格再濾掉正在跑的：noticeTiles 會把運行中那個留在格子裡（常駐通知要它亮著），小窗與小工具要的是「可以換去哪」。
 * 運行中那個也照傳給 noticeTiles：它算最近用過的第一名，換車時其餘格子不跳位。
 */
function otherTiles(
  cats: readonly TimeCategoryRow[],
  recentIds: readonly string[],
  pins: readonly string[],
  runningCatId: string | null,
): TimeCategoryRow[] {
  return noticeTiles(cats, recentIds, pins, runningCatId, PIN_TILES_MAX + 1)
    .filter((c) => c.id !== runningCatId)
    .slice(0, PIN_TILES_MAX);
}

export function buildPinSnapshot(input: {
  theme: "light" | "dark";
  left: number;
  running: TimeBlockRow | null;
  /** 運行中那班連到的任務名（`linkLabelOf`；沒連＝null）。不截字：小窗自己用省略號 */
  linkLabel: string | null;
  catById: Record<string, TimeCategoryRow>;
  categories: readonly TimeCategoryRow[];
  recentIds: readonly string[];
  pins: readonly string[];
}): PinSnapshot {
  const r = input.running;
  let running: PinSnapshot["running"] = null;
  if (r) {
    const startedAt = msOf(r.started_at);
    running = {
      ...faceOf(input.catById[r.category_id] ?? null),
      ticket: input.linkLabel,
      startedAt,
      startedLabel: fmtClock(startedAt) + TT_NOTICE_TEXT.startedSuffix,
    };
  }
  return {
    theme: input.theme,
    left: input.left,
    running,
    tiles: otherTiles(input.categories, input.recentIds, input.pins, r ? r.category_id : null).map((c) => {
      const { name, glyph, colorLight, colorDark } = faceOf(c);
      return { categoryId: c.id, name, glyph, colorLight, colorDark };
    }),
  };
}

/** `widget_sync` 的 state（契約 第九節）。counts：這筆有效到幾點；過了就輪下一筆，全過了小工具顯示「－」 */
export interface WidgetState {
  counts: { until: number; left: number }[];
  tiles: NoticeTile[];
}

/** 不看 noticeTilesEnabled：常駐通知的格子關著，小工具的格子照樣要有 */
export function buildWidgetState(input: {
  counts: { until: number; left: number }[];
  runningCatId: string | null;
  categories: readonly TimeCategoryRow[];
  recentIds: readonly string[];
  pins: readonly string[];
  globalMaxMin: number;
}): WidgetState {
  return {
    counts: input.counts,
    tiles: otherTiles(input.categories, input.recentIds, input.pins, input.runningCatId).map((c) => tileOf(c, input.globalMaxMin)),
  };
}
