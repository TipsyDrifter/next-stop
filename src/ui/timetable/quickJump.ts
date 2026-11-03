/**
 * 時刻表線的頁首搜尋結果（時刻表⑦ 契約 §6 D-時-165、D-時-159；A 席）。經 `timetable.mount.tsx` 的 `quickJump` 登記；兩殼都列。
 *
 * 前綴 `@`（`#` 荷札、`$` 帳目已用）＝只找時刻表；沒有前綴＝一般結果之後多一組「時刻表」（QuickJump 給 limit 4）。
 * 三種東西（同一組，依序：分類 → 作息範本 → 時間塊）：
 *   - 分類（含組；名字比對、封存的不列）：glyph＝圓牌字、右側＝所屬組（組自己寫「群組」）。點了＝時刻表統計頁、只看這個分類（D-時-159）。
 *   - 作息範本（名字；封存的不列）：glyph「息」、右側＝「平日・8 段」。點了＝打開「分類與設定」的作息頁、展開那一套。
 *   - 時間塊（只比備註，新的在前；`timetableRepo.searchBlocks`）：列字「11/1 創作 14:00–16:00」（日界線日）、右側＝備註、
 *     glyph＝那個分類的圓牌字。點了＝跳到那天的軸、打開那一塊（`openBlock`；運行中那班開「改這一班」）。
 * 附加組模式只有 4 格：先每種各給一格（有對到的話），剩下的照順序補——不會被分類吃光、塊一個都看不到。
 * 只打 `@`（term 空）＝列分類與範本（塊要有字才比得到備註）。
 */
import type { QuickJumpHit, QuickJumpProviderSpec } from "../../lines/types";
import { gotoTimetable, openBlock } from "../../lines/timetableTagEntities";
import { timetableRepo } from "../../data/timetableRepository";
import { msOf, type TimeBlockRow, type TimeCategoryRow } from "../../domain/timetable";
import { parseRoutineItems, weekdaysSummary, type TimeRoutineRow } from "../../domain/timetableRoutine";
import { fairTake, matchByName } from "./quickJumpModel";
import { todayKey } from "../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../store/timetableStore";
import { useTimetablePlanStore } from "../../store/timetablePlanStore";
import { useTimetableStatsStore } from "../../store/timetableStatsStore";
import { useUiStore } from "../../store/uiStore";

export const TT_SEARCH_TEXT = {
  group: "時刻表",
  catGroup: "群組",
  routineGlyph: "息",
  routineAside: (mask: number, n: number | null) => (n === null ? weekdaysSummary(mask) : `${weekdaysSummary(mask)}・${n} 段`),
};

function shellNow(): "desktop" | "mobile" {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile" ? "mobile" : "desktop";
}

const glyphOf = (c: TimeCategoryRow | undefined): string => (c ? (c.glyph ?? Array.from(c.name)[0] ?? "・") : "？");

async function categoriesNow(): Promise<readonly TimeCategoryRow[]> {
  const tt = useTimetableStore.getState();
  return tt.ready ? tt.categories : timetableRepo.listCategories();
}

async function routinesNow(): Promise<readonly TimeRoutineRow[]> {
  const ps = useTimetablePlanStore.getState();
  return ps.routinesLoaded ? ps.routines : timetableRepo.listRoutines();
}

async function openCategoryStats(id: string): Promise<void> {
  await gotoTimetable(shellNow());
  useTimetableStore.getState().setView("stats");
  const st = useTimetableStatsStore.getState();
  if (st.shareBy !== "cat") st.setShareBy("cat"); // 荷札那一面看不到分類的過濾（D-時-130：切面會清掉另一種）
  st.setFilter({ kind: "cat", id });
}

async function openRoutine(id: string): Promise<void> {
  await gotoTimetable(shellNow());
  useTimetableStore.getState().openSheet({ kind: "categories", focus: "routine", focusId: id });
}

function catHit(c: TimeCategoryRow, byId: ReadonlyMap<string, TimeCategoryRow>): QuickJumpHit {
  return {
    id: "cat:" + c.id,
    label: c.name,
    aside: c.parent_id === null ? TT_SEARCH_TEXT.catGroup : (byId.get(c.parent_id)?.name ?? undefined),
    glyph: { text: glyphOf(c) },
    go: () => openCategoryStats(c.id),
  };
}

function routineHit(r: TimeRoutineRow): QuickJumpHit {
  const items = parseRoutineItems(r.items);
  return {
    id: "routine:" + r.id,
    label: r.name,
    aside: TT_SEARCH_TEXT.routineAside(r.weekdays, items === null ? null : items.length),
    glyph: { text: TT_SEARCH_TEXT.routineGlyph },
    go: () => openRoutine(r.id),
  };
}

function blockHit(b: TimeBlockRow, byId: ReadonlyMap<string, TimeCategoryRow>, dayStartHour: number): QuickJumpHit {
  const [, m, d] = todayKey(dayStartHour, new Date(b.started_at)).split("-").map(Number);
  const cat = byId.get(b.category_id);
  return {
    id: "block:" + b.id,
    label: TT_TEXT.tags.entityBlock(`${m}/${d}`, cat?.name ?? TT_TEXT.statsUi.catGone, msOf(b.started_at), b.ended_at === null ? null : msOf(b.ended_at)),
    aside: b.note ?? undefined,
    glyph: { text: glyphOf(cat) },
    go: () => openBlock(b, "edit"),
  };
}

export const TIMETABLE_QUICK_JUMP: QuickJumpProviderSpec = {
  id: "timetable.search",
  group: TT_SEARCH_TEXT.group,
  prefix: "@",
  // go() 自己分殼（gotoTimetable：桌機換頁、手機換 tab）⇒ 手機搜尋也列
  shells: ["desktop", "mobile"],
  async search(term, limit) {
    const t = term.trim();
    const [cats, routines, blocks] = await Promise.all([
      categoriesNow(),
      routinesNow().catch(() => [] as TimeRoutineRow[]),
      t ? timetableRepo.searchBlocks(t, limit).catch(() => [] as TimeBlockRow[]) : Promise.resolve([] as TimeBlockRow[]),
    ]);
    const byId = new Map(cats.map((c) => [c.id, c] as const));
    const catHits = matchByName(
      cats.filter((c) => c.archived_at === null),
      t,
    ).map((c) => catHit(c, byId));
    const routineHits = matchByName(
      routines.filter((r) => r.archived_at === null && r.deleted_at === null),
      t,
    ).map(routineHit);
    const h = useUiStore.getState().dayStartHour;
    const blockHits = blocks.map((b) => blockHit(b, byId, h));
    return fairTake([catHits, routineHits, blockHits], limit);
  },
};
