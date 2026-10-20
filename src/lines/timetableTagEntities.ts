/**
 * timetableTagEntities——時刻表掛在荷札上的四種東西，給旅客筆記的荷札頁認（⑥ 契約 0-6、§5.6；D-時-123；丙席）。
 * `timetable.mount.tsx` 的 `tagEntities` 直接用這四筆；登記由 `lines/runtime.ts` 收進 `data/tagEntityAlive.ts`（存活條件）。
 *
 *   timetable:block     手動掛的塊（分類帶的不一塊一塊列，0-1）。存活＝`time_blocks.deleted_at IS NULL`
 *                       列字「10/17 上課 10:50–13:00」（日界線日；運行中「…–運行中」）；點了跳到那天的軸、打開那塊
 *                       （運行中那班＝桌機開荷札小面板 `{kind:"tags"}`、手機只跳過去——它的操作在運行列）
 *   timetable:category  分類（或組）的預設荷札。存活＝沒刪（封存的算在）。列字「分類「娛樂」的預設荷札」＋小字「這個分類過去和以後的紀錄都算」；
 *                       點了開分類管理（刪荷札之前看得到它會連帶影響時刻表，評審第 5 條）
 *   timetable:goal      目標綁的荷札。存活＝沒刪（封存的算在）。列字「目標「夜行列車」」＋小字＝期間與方向；點了跳統計頁、捲到那張卡
 *   timetable:block-off 塊排除的預設荷札（磨光③ 2-1）。存活同 timetable:block；`counts: false`＝荷札頁不算用量、不列（describe 回空）
 *
 * `existsSql` 的別名 `g`＝taggings；`aliveMemory` 只在 mock 模式被叫（那時 `timetableRepo` 就是 memory 版）。
 * 段名、列字一律從 `TT_TEXT.tags` 取。`tables`：三張表任一有同步進來 ⇒ 荷札 index 重載（存活可能變了）。
 */
import type { TagEntityRow, TagEntitySpec } from "./types";
import { timetableRepo } from "../data/timetableRepository";
import type { TimeBlockRow, TimeCategoryRow } from "../domain/timetable";
import { parseGoal } from "../domain/timetableStats";
import { TT_TAG_BLOCK, TT_TAG_BLOCK_OFF, TT_TAG_CATEGORY, TT_TAG_GOAL } from "../domain/timetableTags";
import { todayKey } from "../lib/date";
import { TT_TEXT, useTimetableStore } from "../store/timetableStore";
import { useTimetableStatsStore } from "../store/timetableStatsStore";
import { useUiStore } from "../store/uiStore";
import { goalPeriodText } from "../ui/timetable/stats/format";
import { focusGoalCard } from "../ui/timetable/stats/GoalCards";

const TABLES = ["time_blocks", "time_categories", "time_goals"] as const;
const T = TT_TEXT.tags;

/** 荷札頁在哪個殼（同 tagStore：useShell 把 data-shell 同步到 <html>） */
function shellNow(): "desktop" | "mobile" {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile" ? "mobile" : "desktop";
}

/** 先回時刻表頁（桌機關掉設定面板再換頁；手機換 tab），等 store 載好（`timetable.mount.tsx` 的 syncRowLabel／settingsLinks 跳轉也用這一份） */
export async function gotoTimetable(shell: "desktop" | "mobile"): Promise<void> {
  const ui = useUiStore.getState();
  if (shell === "desktop") {
    ui.setSettingsOpen(false);
    ui.setPage("timetable");
  } else ui.setMobileTab("timetable");
  await useTimetableStore.getState().init(shell);
}

/** 分類表：store 已載就用（含封存），沒載讀一次 */
async function categoriesNow(): Promise<readonly TimeCategoryRow[]> {
  const tt = useTimetableStore.getState();
  return tt.ready ? tt.categories : timetableRepo.listCategories();
}

/** 「M/D」（日界線日） */
function mdOfStart(iso: string, h: number): string {
  const [, m, d] = todayKey(h, new Date(iso)).split("-").map(Number);
  return `${m}/${d}`;
}

async function openBlock(row: TimeBlockRow): Promise<void> {
  const shell = shellNow();
  await gotoTimetable(shell);
  const tt = useTimetableStore.getState();
  // 軸只在 axis（兩殼）／split（桌機）畫；其他視圖先切過去
  const onAxis = tt.view === "axis" || (shell === "desktop" && tt.view === "split");
  if (!onAxis) tt.setView(shell === "mobile" ? "axis" : "split");
  await tt.setDayKey(todayKey(useUiStore.getState().dayStartHour, new Date(row.started_at)));
  const s = useTimetableStore.getState();
  if (row.ended_at === null) {
    if (shell === "desktop" && s.running?.id === row.id) s.openSheet({ kind: "tags", blockId: row.id });
    return;
  }
  if (s.dayBlocks.some((b) => b.id === row.id)) s.openSheet({ kind: "edit", blockId: row.id });
}

async function describeBlocks(ids: readonly string[]): Promise<Record<string, TagEntityRow | null>> {
  const [rows, cats] = await Promise.all([Promise.all(ids.map((id) => timetableRepo.getBlock(id).catch(() => null))), categoriesNow()]);
  const catName = new Map(cats.map((c) => [c.id, c.name] as const));
  const h = useUiStore.getState().dayStartHour;
  const out: Record<string, TagEntityRow | null> = {};
  ids.forEach((id, i) => {
    const row = rows[i];
    if (!row) {
      out[id] = null;
      return;
    }
    const start = Date.parse(row.started_at);
    const end = row.ended_at === null ? null : Date.parse(row.ended_at);
    out[id] = {
      label: T.entityBlock(mdOfStart(row.started_at, h), catName.get(row.category_id) ?? TT_TEXT.statsUi.catGone, start, end),
      open: () => void openBlock(row),
    };
  });
  return out;
}

async function describeCategories(ids: readonly string[]): Promise<Record<string, TagEntityRow | null>> {
  const cats = await categoriesNow();
  const byId = new Map(cats.map((c) => [c.id, c] as const));
  const out: Record<string, TagEntityRow | null> = {};
  for (const id of ids) {
    const c = byId.get(id);
    // 組（頂層）的預設荷札會傳給底下每個分類（D-時-111）⇒ 寫「組「X」」，刪荷札前才看得出影響範圍（評審後）
    const isGroup = c ? c.parent_id === null : false;
    out[id] = c
      ? {
          label: isGroup ? T.entityGroupDefault(c.name) : T.entityCategory(c.name),
          sub: isGroup ? T.entityGroupDefaultSub : T.entityCategorySub,
          open: () =>
            void (async () => {
              await gotoTimetable(shellNow());
              useTimetableStore.getState().openSheet({ kind: "categories", focusId: id }); // 磨光③ 2-11：展開那一列、閃一下
            })(),
        }
      : null;
  }
  return out;
}

async function openGoal(goalId: string): Promise<void> {
  await gotoTimetable(shellNow());
  useTimetableStore.getState().setView("stats");
  const st = useTimetableStatsStore.getState();
  st.toCurrent();
  focusGoalCard(goalId); // 卡區掛上、目標算好之後才真的捲（GoalCards 等它）
  await st.load();
}

async function describeGoals(ids: readonly string[]): Promise<Record<string, TagEntityRow | null>> {
  const rows = await Promise.all(ids.map((id) => timetableRepo.getGoal(id).catch(() => null)));
  const h = useUiStore.getState().dayStartHour;
  const out: Record<string, TagEntityRow | null> = {};
  ids.forEach((id, i) => {
    const row = rows[i];
    if (!row) {
      out[id] = null;
      return;
    }
    const g = parseGoal(row, h);
    out[id] = {
      label: T.entityGoal(row.name),
      sub: g ? goalPeriodText(g) : undefined,
      open: () => void openGoal(id),
    };
  });
  return out;
}

/** 三張表各一條：`g.entity_id` 指到的列還在（沒軟刪除；分類、目標的封存不算刪） */
const existsIn = (table: (typeof TABLES)[number]): string =>
  `EXISTS (SELECT 1 FROM ${table} x WHERE x.id = g.entity_id AND x.deleted_at IS NULL)`;

export const TIMETABLE_TAG_ENTITIES: readonly TagEntitySpec[] = [
  {
    type: TT_TAG_BLOCK,
    group: T.entityGroup,
    existsSql: existsIn("time_blocks"),
    aliveMemory: async (id) => (await timetableRepo.getBlock(id).catch(() => null)) !== null,
    describe: describeBlocks,
    tables: TABLES,
  },
  {
    type: TT_TAG_CATEGORY,
    group: T.entityGroup,
    existsSql: existsIn("time_categories"),
    aliveMemory: async (id) => (await timetableRepo.listCategories().catch(() => [] as TimeCategoryRow[])).some((c) => c.id === id),
    describe: describeCategories,
    tables: TABLES,
  },
  {
    type: TT_TAG_GOAL,
    group: T.entityGroup,
    existsSql: existsIn("time_goals"),
    aliveMemory: async (id) => (await timetableRepo.getGoal(id).catch(() => null)) !== null,
    describe: describeGoals,
    tables: TABLES,
  },
  {
    // 磨光③ 2-1（D-時-134）：塊排除的預設荷札。只給時刻表自己讀（tagStore.index.ents → tagMapsOf 的 off），荷札頁不算用量、不列
    type: TT_TAG_BLOCK_OFF,
    group: T.entityGroup,
    existsSql: existsIn("time_blocks"),
    aliveMemory: async (id) => (await timetableRepo.getBlock(id).catch(() => null)) !== null,
    describe: async () => ({}),
    tables: TABLES,
    counts: false,
  },
];
