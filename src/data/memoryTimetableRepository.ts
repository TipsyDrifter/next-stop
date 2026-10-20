/**
 * 時刻表線的記憶體實作（車次①a 契約 §3.6；甲席 Stage 0）——`?mock=1` 純瀏覽器預覽用，乙丙席開發靠它。
 *
 * - 資料存 `Map`，進出一律複製（同 `memoryRepository.ts` 的慣例）。
 * - 寫入走**同一套純函式**（`plan*` → 套到 Map），所以 mock 與真機語義一致。`reconcile` 的寫入鍵與真機同語義
 *   （D-時-26）：mock 沒有 sync_cells，改在 `startStamp` 記每列 `started_at` 最後一次**真的被改寫**的時刻（ISO），
 *   代替真機 `started_at` 那一格的 hlc；改結束／改分類不動它。
 * - 分類：與真機同，`ensureStarterCategories()` 被呼叫時才種（`?mock=1&wiped=1` 也種——它是「空庫的 App 第一次打開」）。
 * - 示範時間塊（`seedDemo` 時，第一次讀取時 lazy 種）：照原型 `shared.js` 換算成今天的日界線日（`todayKey(3)`）。
 * - 評審端點（本檔自己讀 `location.search`，不經 `DEV_FLAGS`）：`&tt=long`＝運行中那班改成「洗漱，今天 06:30 発」；
 *   `&tt=idle`＝沒有運行中；`&tt=est`（①b）＝運行中那班「創作」帶預估 30 分、開始於 50 分前（一打開就誤點 +20m）；
 *   `&tt=link`（②，② 契約 0-17）＝運行中那班連到今日第一張未交代的票（優先有掛路線的車票）、往前兩塊已結束的連到同一張、再往前一塊只連那張票的路線。
 * - ③（`&tt=stats`，③ 契約 0-12）：種**最近 10 週**、照使用者的分類分布、每天 6–9 筆首尾相接；3 塊跑太久沒確認（一塊跨兩天）、
 *   5 塊 10–40 秒的碎塊、約三成連到兩條路線的車票、一成只連路線；四個目標（夜行列車：從 6 週前起至少 180h 創作＋學習＋興趣；
 *   娛樂每週至多 20h；到 2 週後為止至少 30h 上課＋學習；上個月的單一區間至少 N 小時創作〔已結束、沒達到；N 依示範資料算成約 7 成進度〕）。日界線讀當下設定（`day_start_hour`，沒有就 6）；種子固定（同一天開兩次長一樣）。
 * - ④（`&tt=sched`，④ 契約 0-9）：照名字從記憶體節點種子找票，種今天與昨天的實績（`ensureSchedDemo`）：準點一張（房東）、
 *   晚開始＋多花＋一段待確認一張（讀文法書）、済了沒記時間一張（收信）、定期券一張先一塊 30 秒碎塊再準點開始（背單字）、
 *   正在跑一塊連到某張排定的票、其餘不連任務的塊把一天鋪到現在；昨天也種一份（過去日唯讀）。日界線讀當下設定；種子固定（同一刻開兩次長一樣）。
 * - ⑤（`&tt=grid`，⑤ 契約 0-7）：今天＝零碎的一天、昨天＝首尾相接的一般日（`ensureGridDemo`）。日界線讀當下設定；種子固定。
 * - ②：建構子收 `nodeRepo`（照 `noteRepo.ts` 的注入法）——`lastCategoryFor`／`listBlocksByRoute` 由它取節點的路線、
 *   `setLink` 由它驗節點種類、`&tt=link` 由它找今日車票。
 * - ⑥（⑥ 契約 0-8、0-11、0-13）：建構子收 `tagRepo`（注入）——`applyPlan` 套完就搬手動荷札、目標的荷札兩步寫（同 sqlite）；
 *   `&tt=stats` 多種荷札（娛樂→#拖延、創作／學習／興趣→#高效、有「主線」組→#主線、最近三塊路上→#podcast、目標「夜行列車（荷札版）」綁 #高效），
 *   經荷札 repository 的 attach／setTags 寫。
 */
import { nowUtcIso, uuid } from "../lib/db";
import { addDays, clockInstant, dayWindow, todayKey } from "../lib/date";
import type { NodeRepository } from "./nodeRepository";
import type { SettingsRepository } from "./settingsRepository";
import { LINKABLE_KINDS, linkOfRow } from "../domain/timetableLink";
import {
  MIN,
  STARTER_CATEGORIES,
  canUndoArrive,
  currentRunning,
  insertLinkOf,
  groupedCategories,
  inReconcileWindow,
  isoOf,
  msOf,
  planArrive,
  planArriveBefore,
  planCover,
  planDepart,
  planDepartPending,
  planEdit,
  planFill,
  planMerge,
  planReconcile,
  planResolveLongRun,
  planRestart,
  planSetEstimate,
  planSetLink,
  planSplit,
  planSplitMulti,
  reconcileWindowStart,
  reconcileWriteKey,
  segmentsOfDay,
  summarizeCover,
  toDayBlockSegments,
  toSpan,
  type BlockLink,
  type CoverSummary,
  type DayBlockSegment,
  type KeyedSpan,
  type LongRunChoice,
  type Span,
  type TimeBlockRow,
  type TimeBlockSlim,
  type TimeCategoryRow,
  type TimeGoalRow,
  type WritePlan,
} from "../domain/timetable";
import { goalScopeJson, goalScopeNext, goalToInput, normalizeGoalInput, parseGoal, type GoalInput } from "../domain/timetableStats";
import { buildStatsDemo } from "../domain/timetableStatsDemo";
import { TT_TAG_BLOCK, TT_TAG_CATEGORY, TT_TAG_GOAL } from "../domain/timetableTags";
import { carryBlockTags, carryPairsOfPlan, checkTagNames, receiptWrote, type TimetableTagRepo } from "./timetableTagCarry";
import {
  buildPaintUndo,
  planPaintFill,
  planPaintLive,
  planUndoPaint,
  type PaintRow,
  type PaintUndo,
} from "../domain/timetableGrid";
import type { CategoryPatch, CreateCategoryInput, DepartOptions, MergePreview, TimetableRepository } from "./timetableRepository";
import { pieceId } from "./sqliteTimetableRepository";

const clone = <T extends object>(o: T): T => ({ ...o });
const isAlive = (r: { deleted_at: string | null }): boolean => r.deleted_at === null;

/** 評審端點：`&tt=long|idle|est|link|stats|sched|grid` */
function ttMode(): "long" | "idle" | "est" | "link" | "stats" | "sched" | "grid" | null {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("tt");
    return v === "long" || v === "idle" || v === "est" || v === "link" || v === "stats" || v === "sched" || v === "grid" ? v : null;
  } catch {
    return null;
  }
}

/** 起手分類的 key → id（示範資料用） */
const STARTER_ID: Record<string, string> = {};
for (const c of STARTER_CATEGORIES) STARTER_ID[c.key] = c.id;

/** 示範時間塊：距日界線（03:00）的分鐘數；end null＝運行中 */
const DEMO_TODAY: { key: string; start: number; end: number | null }[] = [
  { key: "sleep", start: 0, end: 280 }, // 03:00–07:40
  { key: "move", start: 310, end: 340 }, // 08:10–08:40
  { key: "class", start: 340, end: 450 }, // 08:40–10:30
  { key: "rest", start: 450, end: 470 }, // 10:30–10:50
  { key: "class", start: 470, end: 550 }, // 10:50–12:10
  { key: "meal", start: 550, end: 600 }, // 12:10–13:00
  { key: "study", start: 630, end: 680 }, // 13:30–14:20
  { key: "rest", start: 680, end: 695 }, // 14:20–14:35
  { key: "create", start: 695, end: null }, // 14:35–運行中
];
const DEMO_YESTERDAY: { key: string; start: number; end: number }[] = [
  { key: "sleep", start: 0, end: 270 }, // 03:00–07:30
  { key: "class", start: 360, end: 540 }, // 09:00–12:00
  { key: "meal", start: 540, end: 600 }, // 12:00–13:00
];

/* ③ `&tt=stats` 示範資料的產生器在 `domain/timetableStatsDemo.ts`（純函式，測試釘住待確認＝3、碎塊＝5；評審 #2） */

export class MemoryTimetableRepository implements TimetableRepository {
  private readonly cats = new Map<string, TimeCategoryRow>();
  private readonly blocks = new Map<string, TimeBlockRow>();
  private readonly goals = new Map<string, TimeGoalRow>();
  private readonly settings: Pick<SettingsRepository, "get"> | null;
  /** id → started_at 最後被寫的時刻（ISO）；＝真機 sync_cells 裡 `started_at` 那一格的 hlc 的替身（整理寫入鍵用，D-時-26） */
  private readonly startStamp = new Map<string, string>();
  private readonly seedDemo: boolean;
  private readonly nodeRepo: NodeRepository;
  private demoSeeded = false;
  /** ② `&tt=link` 的連結示範（async；做過一次就直接回同一個 promise） */
  private linkDemo: Promise<void> | null = null;

  /** ⑥：荷札 repository（注入；沒給＝不搬手動荷札、目標不寫荷札、`&tt=stats` 不種荷札——`node --test` 直載時） */
  private readonly tags: TimetableTagRepo | null;
  /** ⑥：上次 consumeTagWrites 以來有沒有寫過 taggings */
  private tagWrites = false;

  constructor(opts: {
    seedDemo: boolean;
    nodeRepo: NodeRepository;
    settingsRepo?: Pick<SettingsRepository, "get">;
    tagRepo?: TimetableTagRepo | null;
  }) {
    this.seedDemo = opts.seedDemo;
    this.nodeRepo = opts.nodeRepo;
    this.settings = opts.settingsRepo ?? null;
    this.tags = opts.tagRepo ?? null;
  }

  consumeTagWrites(): boolean {
    const v = this.tagWrites;
    this.tagWrites = false;
    return v;
  }

  /* ───────── 內部 ───────── */

  /**
   * ② 契約 0-17：`&tt=link` 的連結示範。ensureDemo 是同步的，連結要讀 nodeRepo（async）⇒ 另寫，
   * 每個碰時間塊的公開 async 方法開頭 `await this.ready()`。沒有今日票 ⇒ 不連。
   */
  private ready(): Promise<void> {
    if (!this.linkDemo) {
      const mode = ttMode();
      this.linkDemo = !this.seedDemo
        ? Promise.resolve()
        : mode === "link"
          ? this.ensureLinkDemo()
          : mode === "stats"
            ? this.ensureStatsDemo()
            : mode === "sched"
              ? this.ensureSchedDemo()
              : mode === "grid"
                ? this.ensureGridDemo()
                : Promise.resolve();
    }
    return this.linkDemo;
  }

  /**
   * ③ `&tt=stats`（契約 0-12）：取代 `ensureDemo`（先把 `demoSeeded` 設成 true）。日界線讀當下設定（`day_start_hour`，沒有／壞了＝6）；
   * 路線與車票從 nodeRepo 取（前兩條有車票的路線）；讀不到就不連。
   */
  private async ensureStatsDemo(): Promise<void> {
    if (this.demoSeeded) return;
    this.demoSeeded = true;
    const now = Date.now();
    let h = 6;
    try {
      const raw = await this.settings?.get("day_start_hour");
      const n = raw === null || raw === undefined ? NaN : Number(raw);
      if (Number.isInteger(n) && n >= 0 && n <= 23) h = n;
    } catch {
      /* 用預設 */
    }
    const links = { nodeIds: [] as string[], routeIds: [] as string[] };
    try {
      const side = await this.nodeRepo.listSidebar();
      for (const route of side.routes) {
        if (links.routeIds.length >= 2) break;
        const tree = await this.nodeRepo.listRouteTree(route.id);
        const ids = tree
          .filter((n) => n.deleted_at === null && LINKABLE_KINDS.includes(n.kind))
          .slice(0, 6)
          .map((n) => n.id);
        if (!ids.length) continue;
        links.routeIds.push(route.id);
        links.nodeIds.push(...ids);
      }
    } catch {
      /* 示範資料失敗不影響主流程 */
    }
    const stamp = nowUtcIso();
    let seq = 0;
    const demoBlocks = buildStatsDemo(h, now, links);
    for (const b of demoBlocks) {
      const id = `5ca70000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
      this.blocks.set(id, {
        id,
        category_id: STARTER_ID[b.key],
        started_at: isoOf(b.start),
        ended_at: b.end === null ? null : isoOf(b.end),
        estimate_min: null,
        node_id: b.nodeId ?? null,
        route_id: b.routeId ?? null,
        long_run_ack: b.ack ? 1 : 0,
        account_id: null,
        device_id: null,
        created_at: stamp,
        updated_at: stamp,
        synced_at: null,
        deleted_at: null,
      });
      this.startStamp.set(id, stamp);
    }
    const today = todayKey(h, new Date(now));
    const goal = (n: number, g: GoalInput): void => {
      const v = normalizeGoalInput(g);
      const id = `90a10000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
      this.goals.set(id, {
        id,
        name: v.name,
        scope: goalScopeJson(v.categoryIds, (v.tagNames?.length ?? 0) > 0), // ⑥：綁荷札的寫 v2
        period: v.period,
        target_min: v.targetMin,
        direction: v.direction,
        start_on: v.startOn,
        end_on: v.endOn,
        position: n - 1,
        archived_at: null,
        account_id: null,
        device_id: null,
        created_at: stamp,
        updated_at: stamp,
        synced_at: null,
        deleted_at: null,
      });
    };
    // 上個月的單一區間：目標時數依示範資料算成約 7 成進度（保證「已結束、沒達到」）
    const monthStart = addDays(today.slice(0, 7) + "-01", -1).slice(0, 7) + "-01";
    const monthEnd = addDays(today.slice(0, 7) + "-01", -1);
    const rs = msOf(dayWindow(monthStart, h).start);
    const re = msOf(dayWindow(addDays(monthEnd, 1), h).start);
    let createMs = 0;
    for (const b of demoBlocks) {
      if (b.key !== "create") continue;
      createMs += Math.max(0, Math.min(b.end ?? now, re) - Math.max(b.start, rs));
    }
    const rangeTarget = Math.max(60, Math.ceil((createMs / MIN / 60) * 1.4));
    goal(1, {
      name: "夜行列車",
      categoryIds: [STARTER_ID.create, STARTER_ID.study, STARTER_ID.hobby],
      period: "since",
      targetMin: 180 * 60,
      direction: "atLeast",
      startOn: addDays(today, -42),
      endOn: null,
    });
    goal(2, { name: "娛樂別太多", categoryIds: [STARTER_ID.play], period: "week", targetMin: 20 * 60, direction: "atMost", startOn: null, endOn: null });
    goal(3, {
      name: "期中衝刺",
      categoryIds: [STARTER_ID.class, STARTER_ID.study],
      period: "until",
      targetMin: 30 * 60,
      direction: "atLeast",
      startOn: today,
      endOn: addDays(today, 14),
    });
    goal(4, {
      name: "上個月的創作",
      categoryIds: [STARTER_ID.create],
      period: "range",
      targetMin: rangeTarget * 60,
      direction: "atLeast",
      startOn: monthStart,
      endOn: monthEnd,
    });
    // ⑥（⑥ 契約 0-13）：照備份分析的用法種荷札——經 MemoryTagRepository 的 attach／setTags 寫（不直接塞 Map）
    goal(5, {
      name: "夜行列車（荷札版）",
      categoryIds: [],
      tagNames: ["高效"],
      period: "since",
      targetMin: 180 * 60,
      direction: "atLeast",
      startOn: addDays(today, -42),
      endOn: null,
    });
    await this.seedStatsTags(seq);
  }

  /**
   * ⑥ `&tt=stats` 的荷札（0-13）：娛樂的預設 #拖延；創作、學習、興趣的預設 #高效；有叫「主線」的組就給它 #主線；
   * 最近三塊「路上」（通勤）手動掛 #podcast；目標 5「夜行列車（荷札版）」綁 #高效。沒注入荷札 repository 就不種；失敗不影響主流程。
   */
  private async seedStatsTags(blockCount: number): Promise<void> {
    if (!this.tags) return;
    const tags = this.tags;
    try {
      await tags.attach(TT_TAG_CATEGORY, STARTER_ID.play, "拖延");
      for (const k of ["create", "study", "hobby"]) await tags.attach(TT_TAG_CATEGORY, STARTER_ID[k], "高效");
      for (const c of this.cats.values()) {
        if (c.parent_id === null && c.deleted_at === null && c.name === "主線") await tags.attach(TT_TAG_CATEGORY, c.id, "主線");
      }
      const commute: string[] = [];
      for (let i = blockCount; i >= 1 && commute.length < 3; i--) {
        const id = `5ca70000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
        const b = this.blocks.get(id);
        if (b && b.category_id === STARTER_ID.move && b.ended_at !== null) commute.push(id);
      }
      for (const id of commute) await tags.attach(TT_TAG_BLOCK, id, "podcast");
      await tags.setTags(TT_TAG_GOAL, `90a10000-0000-4000-8000-${(5).toString(16).padStart(12, "0")}`, ["高效"]);
      this.tagWrites = true;
    } catch (e) {
      console.warn("時刻表 &tt=stats：示範荷札沒種成", e);
    }
  }

  /** 當下的日界線設定（`day_start_hour`；沒有／壞了＝6，同 ensureStatsDemo） */
  private async readDayStartHour(): Promise<number> {
    try {
      const raw = await this.settings?.get("day_start_hour");
      const n = raw === null || raw === undefined ? NaN : Number(raw);
      if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
    } catch {
      /* 用預設 */
    }
    return 6;
  }

  /**
   * ④ `&tt=sched`（契約 0-9）：取代 `ensureDemo`（先把 `demoSeeded` 設成 true）。預定時刻一律讀節點種子當天的有效時刻
   * （`listCalendar` 的 `time`），實績照它排；找不到某張票（名字改了）就略過那一段。種子固定：只依「現在」與節點種子決定。
   *   今天：房東 +3 分開始、做 22 分（準點）；背 N5 單字 −3 分一塊 30 秒碎塊、+1 分開始做 29 分（準點，碎塊不當第一塊）；
   *         讀文法書 +25 分開始、做 100 分（晚 25 分・多花 40m）＋隔 5 分一塊 100 分、這一班預估 30 分沒確認（待確認）；
   *         收信不種（済・沒記時間）；夜班回報不種。超過現在的不種、跨到現在的那塊改成運行中；
   *         正在跑的那塊沒連任務 ⇒ 連到最近一張有時刻、還沒交代、沒有實績的票。其餘空白用不連任務的塊鋪滿（每塊短於分類預設長度，免得變待確認）。
   *   昨天：有時刻、沒運休的票依時刻輪流「+2 分準點」「+15 分晚開始、多 20 分」「不種」；其餘鋪滿整天。
   */
  private async ensureSchedDemo(): Promise<void> {
    if (this.demoSeeded) return;
    this.demoSeeded = true;
    const now = Date.now();
    const h = await this.readDayStartHour();
    const today = todayKey(h, new Date(now));
    const yday = addDays(today, -1);
    type Plan = { nodeId: string; date: string; time: string; est: number | null; settled: boolean };
    const plans: Plan[] = [];
    const idByName = new Map<string, string>();
    try {
      const cal = await this.nodeRepo.listCalendar(yday, today, { todayDateKey: today, dayStartHour: h });
      for (const n of Object.values(cal.nodes)) if (!idByName.has(n.name)) idByName.set(n.name, n.id);
      for (const e of cal.entries) {
        if (e.time === null || e.occurrence_status === "skipped") continue;
        const est = cal.nodes[e.node_id]?.estimate_min ?? null;
        plans.push({ nodeId: e.node_id, date: e.date, time: e.time, est: typeof est === "number" && est > 0 ? est : null, settled: e.is_done });
      }
    } catch {
      /* 示範資料失敗不影響主流程：只鋪不連任務的塊 */
    }
    const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    plans.sort((a, b) => cmp(a.date, b.date) || cmp(a.time, b.time) || cmp(a.nodeId, b.nodeId));
    const planOf = (date: string, name: string): Plan | null => {
      const id = idByName.get(name);
      return (id !== undefined && plans.find((p) => p.date === date && p.nodeId === id)) || null;
    };
    type Seed = { key: string; start: number; end: number | null; nodeId: string | null; est: number | null };
    const at = (p: Plan, offMin: number): number => (clockInstant(p.date, p.time) ?? now) + offMin * MIN;
    const seed = (key: string, start: number, end: number, nodeId: string | null, est: number | null = null): Seed => ({ key, start, end, nodeId, est });

    // 今天的幾個角色
    const todaySeeds: Seed[] = [];
    const landlord = planOf(today, "回覆房東訊息");
    if (landlord) todaySeeds.push(seed("chore", at(landlord, 3), at(landlord, 25), landlord.nodeId));
    const vocab = planOf(today, "背 N5 單字");
    if (vocab) {
      todaySeeds.push(seed("study", at(vocab, -3), at(vocab, -3) + 30_000, vocab.nodeId)); // 30 秒碎塊
      todaySeeds.push(seed("study", at(vocab, 1), at(vocab, 30), vocab.nodeId));
    }
    const grammar = planOf(today, "讀文法書 §3 做筆記");
    if (grammar) {
      todaySeeds.push(seed("study", at(grammar, 25), at(grammar, 125), grammar.nodeId));
      todaySeeds.push(seed("study", at(grammar, 130), at(grammar, 230), grammar.nodeId, 30)); // 預估 30 分、跑了 100 分、沒確認＝待確認
    }
    // 昨天：輪流 準點／晚開始多做／不種
    const ydaySeeds: Seed[] = [];
    plans
      .filter((p) => p.date === yday)
      .forEach((p, i) => {
        const len = p.est ?? 30;
        if (i % 3 === 0) ydaySeeds.push(seed("study", at(p, 2), at(p, 2 + len), p.nodeId));
        else if (i % 3 === 1) ydaySeeds.push(seed("chore", at(p, 15), at(p, 15 + len + 20), p.nodeId));
      });

    const FILL = ["meal", "chore", "play", "rest", "move"];
    const FILL_MAX = 75 * MIN; // 都短於這幾類的預設長度（90 分起），不會變待確認
    const SLEEP_MAX = 8 * 60 * MIN; // 睡覺預設 600 分
    const RUN_MAX = 20 * MIN; // 運行中那塊：短於任何示範票的預計（夜班回報 30 分），不會一打開就變待確認
    /** 一天：角色塊去重疊、截到 until（跨過 until 的那塊改成運行中＝end null，之後的不種）、空白鋪滿 */
    const lay = (date: string, seeds: readonly Seed[], until: number): Seed[] => {
      const w = dayWindow(date, h);
      const ws = msOf(w.start);
      const wEnd = msOf(w.end);
      const we = Math.min(wEnd, until);
      const kept: Seed[] = [];
      for (const s of [...seeds].sort((a, b) => a.start - b.start)) {
        if (s.start < ws || s.start >= we) continue;
        const last = kept[kept.length - 1];
        if (last && s.start < (last.end ?? we)) continue;
        kept.push(s);
      }
      const out: Seed[] = [];
      let cursor = ws;
      let fi = 0;
      const fill = (to: number): void => {
        while (to - cursor >= MIN) {
          const first = cursor === ws;
          const end = Math.min(to, cursor + (first ? SLEEP_MAX : FILL_MAX));
          out.push(seed(first ? "sleep" : FILL[fi++ % FILL.length], cursor, end, null));
          cursor = end;
        }
      };
      for (const s of kept) {
        fill(s.start);
        cursor = Math.max(cursor, s.start);
        const end = s.end ?? we;
        if (end > we) {
          out.push({ ...s, end: we < wEnd ? null : we }); // 跨到現在：運行中
          return out;
        }
        out.push(s);
        cursor = end;
      }
      if (we < wEnd) {
        // 今天：鋪到「現在前 20 分」，最後一塊從那裡跑到現在
        const runFrom = Math.max(cursor, we - RUN_MAX);
        fill(runFrom);
        if (we - runFrom >= MIN) out.push({ key: "create", start: runFrom, end: null, nodeId: null, est: null });
      } else {
        fill(we);
      }
      return out;
    };

    const todayBlocks = lay(today, todaySeeds, now);
    // 正在跑的那塊沒連任務 ⇒ 連到最近一張有時刻、還沒交代、沒有實績的票
    const run = todayBlocks.find((b) => b.end === null);
    if (run && run.nodeId === null) {
      const used = new Set(todayBlocks.flatMap((b) => (b.nodeId === null ? [] : [b.nodeId])));
      const open = plans.filter((p) => p.date === today && !p.settled && !used.has(p.nodeId));
      open.sort((a, b) => Math.abs(at(a, 0) - run.start) - Math.abs(at(b, 0) - run.start) || cmp(a.nodeId, b.nodeId));
      if (open[0]) {
        run.nodeId = open[0].nodeId;
        run.key = "study";
      }
    }
    const yBlocks = lay(yday, ydaySeeds, msOf(dayWindow(yday, h).end));

    const stamp = nowUtcIso();
    let seq = 0;
    for (const b of [...yBlocks, ...todayBlocks]) {
      const id = `5c4ed000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
      this.blocks.set(id, {
        id,
        category_id: STARTER_ID[b.key],
        started_at: isoOf(b.start),
        ended_at: b.end === null ? null : isoOf(b.end),
        estimate_min: b.est,
        node_id: b.nodeId,
        route_id: null,
        long_run_ack: 0,
        account_id: null,
        device_id: null,
        created_at: stamp,
        updated_at: stamp,
        synced_at: null,
        deleted_at: null,
      });
      this.startStamp.set(id, stamp);
    }
  }

  /**
   * ⑤ `&tt=grid`（契約 0-7；同原型 `v-i.js` 的 generate）：取代 `ensureDemo`（先把 `demoSeeded` 設成 true）。日界線讀當下設定。
   * 時刻以「今天的日界線 + 分」寫（日界線 06:00 時＝原型的時刻）：
   *   今天：−372（昨天 23:48）起的睡覺跨進來、睡到 +72（07:12）；洗漱 +72 跑 79 分沒確認（門檻 60 ⇒ 待確認）；空白 13 分；
   *         上課 63（08:44）；學習 51（09:47）；娛樂 30 秒碎塊（10:38）；創作 41.5；空白 1h40m（11:20–13:00）；吃飯 46；空白 7 分；
   *         休息 14（13:53–14:07）；空白 45 分（14:07–14:52，試頭尾貼齊）；之後正在跑一班創作。
   *   相對 now（不種未來）：現在離日界線不夠排完 ⇒ 等比壓縮可縮的六段（起床、上課、學習、創作、吃飯、休息；空白、待確認、碎塊照原長，
   *         最多縮到一成）；還排不下 ⇒ 超過現在的不種、跨到現在的那塊改成運行中（停在空白裡 ⇒ 創作從空白開頭跑）。
   *         現在比樣板晚 ⇒ 樣板之後用一般的塊（每塊 ≤ 75 分，都短於分類預設）鋪到「現在前 50 分」，創作從那裡跑到現在。
   *   昨天：前一天 −400 起的睡覺跨進來、+65 起床，照平日首尾相接鋪到 −372＋1 天（今天那塊睡覺的開始）。
   * 種子固定：只依「現在」與日界線決定（同一刻開兩次長一樣）。
   */
  private async ensureGridDemo(): Promise<void> {
    if (this.demoSeeded) return;
    this.demoSeeded = true;
    const now = Date.now();
    const h = await this.readDayStartHour();
    const today = todayKey(h, new Date(now));
    const t0 = msOf(dayWindow(today, h).start);
    const y0 = msOf(dayWindow(addDays(today, -1), h).start);
    const ms = (min: number): number => Math.round(min * 60) * 1000;
    type Seed = { key: string; start: number; end: number | null };
    const seeds: Seed[] = [];
    const push = (key: string, start: number, end: number | null): void => {
      seeds.push({ key, start, end });
    };

    // 昨天：首尾相接的平日（每塊都不超過分類預設，不會變待確認）
    const bed = t0 - ms(372);
    let cur = y0 + ms(65);
    push("sleep", y0 - ms(400), cur);
    const yday: [string, number][] = [
      ["wash", 25], ["meal", 30], ["move", 35], ["class", 180], ["meal", 55], ["create", 170],
      ["sport", 60], ["meal", 60], ["study", 105], ["play", 120],
    ];
    for (const [key, min] of yday) {
      push(key, cur, cur + ms(min));
      cur += ms(min);
    }
    const hobbyEnd = Math.max(cur + MIN, bed - ms(30));
    push("hobby", cur, hobbyEnd);
    push("wash", hobbyEnd, bed);

    // 今天：零碎的一天（key null＝空白；scale＝現在不夠時可以等比壓縮）
    const steps: { key: string | null; min: number; scale: boolean }[] = [
      { key: "wash", min: 79, scale: false }, // 待確認
      { key: null, min: 13, scale: false },
      { key: "class", min: 63, scale: true },
      { key: "study", min: 51, scale: true },
      { key: "play", min: 0.5, scale: false }, // 30 秒碎塊
      { key: "create", min: 41.5, scale: true },
      { key: null, min: 100, scale: false },
      { key: "meal", min: 46, scale: true },
      { key: null, min: 7, scale: false },
      { key: "rest", min: 14, scale: true },
      { key: null, min: 45, scale: false },
    ];
    const WAKE = 72;
    const fixedMin = steps.reduce((s, x) => s + (x.scale ? 0 : x.min), 0);
    const scaleMin = WAKE + steps.reduce((s, x) => s + (x.scale ? x.min : 0), 0);
    const avail = (now - t0) / MIN - 10; // 運行中那班至少留 10 分
    const f = Math.max(0.1, Math.min(1, (avail - fixedMin) / scaleMin));
    const len = (x: { min: number; scale: boolean }): number => ms(x.scale ? x.min * f : x.min);

    let running = false;
    let stopped = false;
    cur = t0 + ms(WAKE * f);
    if (cur > now) {
      push("sleep", bed, null);
      running = true;
      stopped = true;
    } else {
      push("sleep", bed, cur);
      for (const x of steps) {
        const end = cur + len(x);
        if (x.key === null) {
          if (end >= now) {
            stopped = true;
            break;
          }
          cur = end;
          continue;
        }
        if (cur >= now) {
          stopped = true;
          break;
        }
        if (end > now) {
          push(x.key, cur, null);
          running = true;
          stopped = true;
          break;
        }
        push(x.key, cur, end);
        cur = end;
      }
    }
    if (!running) {
      if (!stopped) {
        const FILL = ["meal", "chore", "play", "rest", "move"];
        const runFrom = Math.max(cur, now - 50 * MIN);
        let fi = 0;
        while (runFrom - cur >= MIN) {
          const end = Math.min(runFrom, cur + 75 * MIN);
          push(FILL[fi++ % FILL.length], cur, end);
          cur = end;
        }
        cur = runFrom;
      }
      push("create", Math.min(cur, now - 1000), null);
    }

    const stamp = nowUtcIso();
    let seq = 0;
    for (const b of seeds) {
      const id = `9e1d0000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
      this.blocks.set(id, {
        id,
        category_id: STARTER_ID[b.key],
        started_at: isoOf(b.start),
        ended_at: b.end === null ? null : isoOf(b.end),
        estimate_min: null,
        node_id: null,
        route_id: null,
        long_run_ack: 0,
        account_id: null,
        device_id: null,
        created_at: stamp,
        updated_at: stamp,
        synced_at: null,
        deleted_at: null,
      });
      this.startStamp.set(id, stamp);
    }
  }

  private async ensureLinkDemo(): Promise<void> {
    this.ensureDemo();
    try {
      const rows = await this.nodeRepo.listToday(todayKey(3), 3);
      // 還沒交代的（同今日頁 isSettledRow 的反面：沒有班次結局、也不是 done）。優先挑**有掛路線的車票**：
      // 「只連路線」那一塊、路線與子樹的合計（§7.1-12a、15、16、17）都要 X 有路線才看得到；
      // 示範資料的第一張未交代是根層臨時票（沒路線），照字面挑它就示範不到。都沒有才退回第一張能連的
      const open = rows.filter((r) => r.occurrence === null && r.status !== "done" && LINKABLE_KINDS.includes(r.kind));
      const t = open.find((r) => r.kind === "ticket" && r.route_id !== null) ?? open[0];
      if (!t) return;
      const ordered = Array.from(this.blocks.values())
        .filter(isAlive)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0)); // 新到舊
      const run = ordered.findIndex((r) => r.ended_at === null);
      if (run < 0) return;
      const toNode = ordered.slice(run, run + 3); // 運行中那班＋往前兩塊
      for (const r of toNode) {
        r.node_id = t.id;
        r.route_id = null;
      }
      const routeOnly = ordered[run + 3];
      if (routeOnly && t.route_id !== null) {
        routeOnly.node_id = null;
        routeOnly.route_id = t.route_id;
      }
    } catch {
      // 示範資料失敗不影響主流程
    }
  }

  private ensureDemo(): void {
    if (this.demoSeeded || !this.seedDemo) return;
    this.demoSeeded = true;
    const now = Date.now();
    const stamp = nowUtcIso();
    const today = todayKey(3);
    const base = msOf(dayWindow(today, 3).start);
    const ybase = msOf(dayWindow(addDays(today, -1), 3).start);
    const put = (key: string, start: number, end: number | null): TimeBlockRow => {
      const row: TimeBlockRow = {
        id: uuid(),
        category_id: STARTER_ID[key],
        started_at: isoOf(start),
        ended_at: end === null ? null : isoOf(end),
        estimate_min: null,
        node_id: null,
        route_id: null,
        long_run_ack: 0,
        account_id: null,
        device_id: null,
        created_at: stamp,
        updated_at: stamp,
        synced_at: null,
        deleted_at: null,
      };
      this.blocks.set(row.id, row);
      this.startStamp.set(row.id, stamp);
      return row;
    };
    for (const b of DEMO_YESTERDAY) put(b.key, ybase + b.start * MIN, ybase + b.end * MIN);
    for (const b of DEMO_TODAY) {
      const start = base + b.start * MIN;
      if (start >= now) break; // 現在早於這塊的開始 ⇒ 不種這塊之後的
      const end = b.end === null ? null : base + b.end * MIN;
      if (end !== null && end > now) {
        put(b.key, start, null); // 跨到未來的那塊改成運行中，之後的不種
        break;
      }
      put(b.key, start, end);
    }
    const mode = ttMode();
    if (mode === "idle") {
      for (const r of this.blocks.values()) if (r.ended_at === null) this.blocks.delete(r.id);
    } else if (mode === "long") {
      // 原型 demoOverdue：06:30 之後的今天全部收掉，洗漱從 06:30 跑到現在
      const at = base + 210 * MIN;
      for (const r of Array.from(this.blocks.values())) {
        const s = msOf(r.started_at);
        if (s < base) continue; // 昨天的不動
        if (s >= at) this.blocks.delete(r.id);
        else if (r.ended_at === null || msOf(r.ended_at) > at) r.ended_at = isoOf(at);
      }
      put("wash", at, null);
    } else if (mode === "est") {
      // ①b：運行中那班帶預估 30 分、開始於 50 分前 ⇒ 一打開就是「誤點 +20m」＋其實到幾點（①b①c 契約 §3.4）
      const at = now - 50 * MIN;
      for (const r of Array.from(this.blocks.values())) {
        const s = msOf(r.started_at);
        if (s >= at) this.blocks.delete(r.id);
        else if (r.ended_at === null || msOf(r.ended_at) > at) r.ended_at = isoOf(at);
      }
      put("create", at, null).estimate_min = 30;
    }
  }

  private aliveSpans(): Span[] {
    this.ensureDemo();
    const out: Span[] = [];
    for (const r of this.blocks.values()) if (isAlive(r)) out.push(toSpan(r));
    return out;
  }

  private rowOrThrow(id: string): TimeBlockRow {
    const r = this.blocks.get(id);
    if (!r || !isAlive(r)) throw new RangeError("找不到這一塊");
    return r;
  }

  /** 套用 WritePlan；回 inserts 依序對應的 id */
  private async applyPlan(plan: WritePlan, nowIso: string): Promise<string[]> {
    for (const p of plan.patches) {
      const r = this.blocks.get(p.id);
      if (!r) continue;
      if (p.start !== undefined) {
        const s = isoOf(p.start);
        // 同真機 applyPlan 的「值相同的欄不寫、不戳」：沒真的改開始就不算重新發車
        if (r.started_at !== s) this.startStamp.set(r.id, nowIso);
        r.started_at = s;
      }
      if (p.end !== undefined) r.ended_at = p.end === null ? null : isoOf(p.end);
      if (p.categoryId !== undefined) r.category_id = p.categoryId;
      if (p.ack !== undefined) r.long_run_ack = p.ack ? 1 : 0;
      if (p.estimateMin !== undefined) r.estimate_min = p.estimateMin;
      if (p.link !== undefined) {
        // ② 契約 0-2：連結兩欄成對寫
        r.node_id = p.link.nodeId;
        r.route_id = p.link.routeId;
      }
      r.updated_at = nowIso;
    }
    const ids: string[] = [];
    for (const i of plan.inserts) {
      const id = i.fixedId ?? (i.key ? await pieceId(i.key) : uuid());
      const src = i.fromId ? this.blocks.get(i.fromId) : undefined;
      const from = i.inherit ? src : undefined;
      // ② 契約 §3.1：明寫的連結優先；否則 inherit 或 keepLink 時照 fromId 那一列抄；其餘沒連（規則在純函式 insertLinkOf）
      const link: BlockLink = insertLinkOf(i, src);
      const prev = this.blocks.get(id);
      const row: TimeBlockRow = {
        id,
        category_id: i.categoryId,
        started_at: isoOf(i.start),
        ended_at: i.end === null ? null : isoOf(i.end),
        // ①b：insert 明寫的預估蓋過 inherit 抄來的（undefined＝照 inherit 規則；同 sqlite 實作）
        estimate_min: i.estimateMin !== undefined ? i.estimateMin : (from?.estimate_min ?? null),
        node_id: link.nodeId,
        route_id: link.routeId,
        long_run_ack: i.ack ? 1 : 0,
        account_id: null,
        device_id: null,
        created_at: prev?.created_at ?? nowIso,
        updated_at: nowIso,
        synced_at: null,
        deleted_at: null,
      };
      this.blocks.set(id, row);
      this.startStamp.set(id, nowIso); // 同真機：insert 送完整列 op ⇒ started_at 那一格也戳
      ids.push(id);
    }
    for (const d of plan.deletes) {
      const r = this.blocks.get(d);
      if (!r) continue;
      r.deleted_at = nowIso;
      r.updated_at = nowIso;
    }
    // ⑥ 0-8：時間資料落地之後搬手動荷札（同 sqlite 的「commit 之後」；memory 沒有批次，套完就是落地）
    const pairs = carryPairsOfPlan(plan.inserts, ids, plan.absorbedInto);
    if (pairs.length && (await carryBlockTags(pairs, this.tags))) this.tagWrites = true;
    return ids;
  }

  private sameLayer(parentId: string | null): TimeCategoryRow[] {
    return Array.from(this.cats.values()).filter((c) => isAlive(c) && c.parent_id === parentId);
  }

  /* ───────── 分類 ───────── */

  async listCategories(): Promise<TimeCategoryRow[]> {
    const all = Array.from(this.cats.values()).filter(isAlive);
    const grouped = groupedCategories(all.map((c) => ({ ...c, archived_at: null }))); // 排序用；封存的也要列
    const ordered: TimeCategoryRow[] = [];
    const seen = new Set<string>();
    for (const g of grouped) {
      const real = this.cats.get(g.group.id)!;
      ordered.push(clone(real));
      seen.add(real.id);
      for (const c of g.children) {
        ordered.push(clone(this.cats.get(c.id)!));
        seen.add(c.id);
      }
    }
    for (const c of all) if (!seen.has(c.id)) ordered.push(clone(c)); // 孤兒（父已刪）排最後
    return ordered;
  }

  async countCategoriesIncludingDeleted(): Promise<number> {
    return this.cats.size;
  }

  async ensureStarterCategories(): Promise<boolean> {
    if (this.cats.size > 0) return false;
    const now = nowUtcIso();
    for (const s of STARTER_CATEGORIES) {
      this.cats.set(s.id, {
        id: s.id,
        parent_id: s.parentId,
        name: s.name,
        glyph: s.glyph,
        color_idx: s.colorIdx,
        position: s.position,
        default_min: s.defaultMin,
        archived_at: null,
        account_id: null,
        device_id: null,
        created_at: now,
        updated_at: now,
        synced_at: null,
        deleted_at: null,
      });
    }
    return true;
  }

  async createCategory(input: CreateCategoryInput): Promise<TimeCategoryRow> {
    const name = input.name.trim();
    if (!name) throw new RangeError("分類名稱不能是空的");
    if (input.parentId !== null) {
      const parent = this.cats.get(input.parentId);
      if (!parent || !isAlive(parent) || parent.parent_id !== null) throw new RangeError("找不到這個分組");
    }
    const now = nowUtcIso();
    const siblings = this.sameLayer(input.parentId);
    const position = siblings.reduce((m, c) => Math.max(m, c.position), -1) + 1;
    const row: TimeCategoryRow = {
      id: uuid(),
      parent_id: input.parentId,
      name,
      glyph: input.parentId === null ? null : (Array.from(name)[0] ?? null),
      color_idx: input.colorIdx,
      position,
      default_min: input.defaultMin,
      archived_at: null,
      account_id: null,
      device_id: null,
      created_at: now,
      updated_at: now,
      synced_at: null,
      deleted_at: null,
    };
    this.cats.set(row.id, row);
    return clone(row);
  }

  async updateCategory(id: string, patch: CategoryPatch): Promise<void> {
    const c = this.cats.get(id);
    if (!c || !isAlive(c)) throw new RangeError("找不到這個分類");
    // 先全部驗證、再一起改（同 sqlite 一個 batch 的原子性）。規則＝①b①c 契約 §3.3-3
    const name = patch.name !== undefined ? patch.name.trim() : undefined;
    if (name !== undefined && !name) throw new RangeError("分類名稱不能是空的");
    let target: TimeCategoryRow | null = null;
    if (patch.parentId !== undefined) {
      if (c.parent_id === null) throw new RangeError("分組不能搬");
      const t = this.cats.get(patch.parentId);
      if (!t || !isAlive(t) || t.parent_id !== null) throw new RangeError("找不到這個分組");
      target = t;
    }
    if (patch.archived !== undefined && c.parent_id === null) throw new RangeError("分組不能封存");
    const glyph = patch.glyph !== undefined ? patch.glyph.trim() : undefined;
    if (glyph !== undefined) {
      if (c.parent_id === null) throw new RangeError("分組沒有圓牌字");
      if (Array.from(glyph).length !== 1) throw new RangeError("圓牌字只能一個字");
    }
    const now = nowUtcIso();
    if (name !== undefined) {
      // 圓牌字只在「還是自動的」（＝舊名第一字或 null）時跟著換；主人換過的不動（取代 ①a 的無條件覆寫）
      if (c.parent_id !== null && (c.glyph === null || c.glyph === Array.from(c.name)[0])) c.glyph = Array.from(name)[0] ?? null;
      c.name = name;
    }
    if (patch.colorIdx !== undefined) c.color_idx = patch.colorIdx;
    if (patch.defaultMin !== undefined) c.default_min = patch.defaultMin;
    if (target && target.id !== c.parent_id) {
      c.position = this.sameLayer(target.id).reduce((m, x) => Math.max(m, x.position), -1) + 1;
      c.parent_id = target.id;
    }
    if (patch.archived !== undefined) {
      if (patch.archived && c.archived_at === null) c.archived_at = now;
      else if (!patch.archived) c.archived_at = null;
    }
    if (glyph !== undefined) c.glyph = glyph;
    c.updated_at = now;
  }

  async reorderCategories(parentId: string | null, orderedIds: readonly string[]): Promise<void> {
    const now = nowUtcIso();
    orderedIds.forEach((id, i) => {
      const c = this.cats.get(id);
      if (!c || !isAlive(c) || c.parent_id !== parentId) return;
      if (c.position !== i) {
        c.position = i;
        c.updated_at = now;
      }
    });
  }

  /* ───────── 時間塊：讀 ───────── */

  async listRunning(): Promise<TimeBlockRow[]> {
    await this.ready();
    this.ensureDemo();
    return Array.from(this.blocks.values())
      .filter((r) => isAlive(r) && r.ended_at === null)
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
      .map(clone);
  }

  async listBlocks(fromIso: string, toIso: string): Promise<TimeBlockRow[]> {
    await this.ready();
    this.ensureDemo();
    return Array.from(this.blocks.values())
      .filter((r) => isAlive(r) && r.started_at < toIso && (r.ended_at === null || r.ended_at > fromIso))
      .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))
      .map(clone);
  }

  async listBlocksSlim(fromIso: string, toIso: string): Promise<TimeBlockSlim[]> {
    await this.ready();
    this.ensureDemo();
    return Array.from(this.blocks.values())
      .filter((r) => isAlive(r) && r.started_at < toIso && (r.ended_at === null || r.ended_at > fromIso))
      .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))
      .map((r) => ({
        id: r.id,
        category_id: r.category_id,
        started_at: r.started_at,
        ended_at: r.ended_at,
        estimate_min: r.estimate_min,
        node_id: r.node_id,
        route_id: r.route_id,
        long_run_ack: r.long_run_ack,
      }));
  }

  async listDaySegments(dateKey: string, dayStartHour: number): Promise<DayBlockSegment[]> {
    const w = dayWindow(dateKey, dayStartHour);
    const rows = await this.listBlocks(w.start, w.end);
    const items = segmentsOfDay(rows.map(toSpan), { start: msOf(w.start), end: msOf(w.end) }, Date.now());
    const catById: Record<string, TimeCategoryRow> = {};
    for (const c of await this.listCategories()) catById[c.id] = c;
    const rowsById: Record<string, TimeBlockRow> = {};
    for (const r of rows) rowsById[r.id] = r;
    return toDayBlockSegments(items, catById, rowsById);
  }

  /* ───────── 時間塊：寫 ───────── */

  async depart(categoryId: string, atIso: string, opts?: DepartOptions): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    await this.ready();
    const now = Date.now();
    const plan = planDepart(this.aliveSpans(), {
      categoryId,
      at: msOf(atIso),
      now,
      estimateMin: opts?.estimateMin ?? null,
      link: opts?.link ?? null,
    });
    const ids = await this.applyPlan(plan, isoOf(now));
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    return { block: clone(this.blocks.get(newId)!), summary: summarizeCover(plan) };
  }

  async arrive(atIso?: string): Promise<TimeBlockRow[]> {
    await this.ready();
    const now = Date.now();
    const plan = planArrive(this.aliveSpans(), { at: atIso ? msOf(atIso) : null, now });
    await this.applyPlan(plan, isoOf(now));
    return plan.patches.map((p) => clone(this.blocks.get(p.id)!));
  }

  async undoArrive(id: string): Promise<boolean> {
    await this.ready();
    if (!canUndoArrive(this.aliveSpans(), id)) return false;
    const r = this.rowOrThrow(id);
    r.ended_at = null;
    r.updated_at = nowUtcIso();
    return true;
  }

  async restart(id: string, atIso: string): Promise<CoverSummary> {
    await this.ready();
    const now = Date.now();
    const plan = planRestart(this.aliveSpans(), { id, at: msOf(atIso), now });
    await this.applyPlan(plan, isoOf(now));
    return summarizeCover(plan, id);
  }

  async fill(
    categoryId: string,
    startIso: string,
    endIso: string,
    opts?: { link?: BlockLink | null },
  ): Promise<{ block: TimeBlockRow; summary: CoverSummary }> {
    await this.ready();
    const now = Date.now();
    const plan = planFill(this.aliveSpans(), {
      categoryId,
      start: msOf(startIso),
      end: msOf(endIso),
      now,
      link: opts?.link ?? null,
    });
    const ids = await this.applyPlan(plan, isoOf(now));
    const newId = ids[plan.inserts.findIndex((i) => !i.inherit)];
    return { block: clone(this.blocks.get(newId)!), summary: summarizeCover(plan) };
  }

  async editBlock(
    id: string,
    input: { categoryId: string; startIso: string; endIso: string; link?: BlockLink | null },
  ): Promise<CoverSummary> {
    await this.ready();
    const now = Date.now();
    const cur = this.blocks.get(id);
    const plan = planEdit(this.aliveSpans(), {
      id,
      categoryId: input.categoryId,
      start: msOf(input.startIso),
      end: msOf(input.endIso),
      now,
      link: input.link, // undefined＝不動
      curLink: cur ? linkOfRow(cur) : undefined,
    });
    await this.applyPlan(plan, isoOf(now));
    return summarizeCover(plan, id);
  }

  async split(id: string, atIso: string, categoryId2: string): Promise<TimeBlockRow | null> {
    await this.ready();
    const now = Date.now();
    const plan = planSplit(this.aliveSpans(), { id, at: msOf(atIso), categoryId2, now });
    if (!plan) return null;
    const ids = await this.applyPlan(plan, isoOf(now));
    return clone(this.blocks.get(ids[0])!);
  }

  async resolveLongRun(id: string, endIso: string, choice: LongRunChoice, categoryId2?: string): Promise<void> {
    await this.ready();
    const now = Date.now();
    const plan = planResolveLongRun(this.aliveSpans(), { id, end: msOf(endIso), choice, categoryId2: categoryId2 ?? null, now });
    await this.applyPlan(plan, isoOf(now));
  }

  async softDelete(id: string): Promise<void> {
    await this.ready();
    const r = this.rowOrThrow(id);
    const now = nowUtcIso();
    r.deleted_at = now;
    r.updated_at = now;
    this.tagWrites = true; // ⑥ 評審後：index 只收實體存活的 taggings（0-6）⇒ 刪／復活都要重載（同 sqlite）
  }

  async restore(id: string): Promise<CoverSummary> {
    await this.ready();
    const r = this.blocks.get(id);
    if (!r || r.deleted_at === null) throw new RangeError("找不到這一塊");
    const now = Date.now();
    const me = toSpan(r);
    // 刪掉時還在運行中的塊：復原成「結束於刪除那一刻」（同 sqlite 實作；否則蓋到 +∞、刪掉之後発車的都被收掉）
    const endedAtRestore = r.ended_at === null ? r.deleted_at : null;
    const plan = planCover(this.aliveSpans(), { start: me.start, end: me.end ?? msOf(r.deleted_at) }, id);
    await this.applyPlan(plan, isoOf(now));
    if (endedAtRestore !== null) r.ended_at = endedAtRestore;
    r.deleted_at = null;
    r.updated_at = isoOf(now);
    this.tagWrites = true; // ⑥ 評審後：復活的塊的手動荷札要回到 index（同 sqlite）
    return summarizeCover(plan, id);
  }

  async previewCover(startIso: string, endIso: string | null, exceptId: string | null): Promise<CoverSummary> {
    await this.ready();
    const plan = planCover(this.aliveSpans(), { start: msOf(startIso), end: endIso === null ? null : msOf(endIso) }, exceptId);
    return summarizeCover(plan, exceptId);
  }

  /* ───────── ①b（①b①c 契約 §3.2、§3.4） ───────── */

  async setEstimate(id: string, estimateMin: number | null): Promise<void> {
    await this.ready();
    const plan = planSetEstimate(this.aliveSpans(), { id, estimateMin });
    await this.applyPlan(plan, nowUtcIso());
  }

  async splitMulti(id: string, cutsIso: readonly string[], categoryIds: readonly string[]): Promise<TimeBlockRow[]> {
    await this.ready();
    const now = Date.now();
    const r = this.rowOrThrow(id);
    const plan = planSplitMulti(this.aliveSpans(), { id, cuts: cutsIso.map(msOf), categoryIds, now, estimateMin: r.estimate_min });
    const ids = await this.applyPlan(plan, isoOf(now));
    return [id, ...ids].map((x) => clone(this.blocks.get(x)!));
  }

  async previewMerge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null> {
    await this.ready();
    const out = planMerge(this.aliveSpans(), { id, dir, bound: msOf(boundIso), now: Date.now() });
    return out ? { ...out.preview } : null;
  }

  async merge(id: string, dir: "prev" | "next", boundIso: string): Promise<MergePreview | null> {
    await this.ready();
    const now = Date.now();
    const out = planMerge(this.aliveSpans(), { id, dir, bound: msOf(boundIso), now });
    if (!out) return null;
    await this.applyPlan(out.plan, isoOf(now));
    return { ...out.preview };
  }

  async listRecentCategoryIds(sinceIso: string, limit: number): Promise<string[]> {
    await this.ready();
    this.ensureDemo();
    const last = new Map<string, string>();
    for (const r of this.blocks.values()) {
      if (!isAlive(r) || r.started_at < sinceIso) continue;
      const m = last.get(r.category_id);
      if (m === undefined || r.started_at > m) last.set(r.category_id, r.started_at);
    }
    return Array.from(last.entries())
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
      .slice(0, limit)
      .map((e) => e[0]);
  }

  /* ───────── ①c 預留 ───────── */

  async blockExists(id: string): Promise<boolean> {
    await this.ready();
    this.ensureDemo();
    return this.blocks.has(id);
  }

  async departPending(categoryId: string, atIso: string, opts: { fixedId: string; untilNext: boolean }): Promise<TimeBlockRow | null> {
    await this.ready();
    const now = Date.now();
    const plan = planDepartPending(this.aliveSpans(), { categoryId, at: msOf(atIso), now, fixedId: opts.fixedId, untilNext: opts.untilNext });
    if (!plan) return null;
    await this.applyPlan(plan, isoOf(now));
    const row = this.blocks.get(opts.fixedId);
    return row ? clone(row) : null;
  }

  async arrivePending(atIso: string): Promise<TimeBlockRow[]> {
    await this.ready();
    const now = Date.now();
    const plan = planArriveBefore(this.aliveSpans(), { at: msOf(atIso), now });
    await this.applyPlan(plan, isoOf(now));
    return plan.patches.map((p) => clone(this.blocks.get(p.id)!));
  }

  /* ───────── 同步後整理 ───────── */

  async reconcile(): Promise<number> {
    await this.ready();
    this.ensureDemo();
    // 與真機同語義：只掃最近 RECONCILE_WINDOW_DAYS 天＋所有運行中（契約 §9-6 退路）
    const floor = reconcileWindowStart(Date.now());
    const keyed: KeyedSpan[] = [];
    for (const r of this.blocks.values()) {
      if (!isAlive(r)) continue;
      const span = toSpan(r);
      if (!inReconcileWindow(span, floor)) continue;
      keyed.push({ ...span, writeKey: reconcileWriteKey(this.startStamp.get(r.id), r.updated_at) });
    }
    const plan = planReconcile(keyed);
    const n = plan.patches.length + plan.inserts.length + plan.deletes.length;
    if (n) await this.applyPlan(plan, nowUtcIso());
    return n;
  }

  /* ───────── ②（② 契約 §3.3、§3.5） ───────── */

  /** 依 started_at 遞減（新到舊）的存活塊 */
  private aliveNewestFirst(): TimeBlockRow[] {
    this.ensureDemo();
    return Array.from(this.blocks.values())
      .filter(isAlive)
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0));
  }

  private sortAsc(rows: TimeBlockRow[]): TimeBlockRow[] {
    return rows.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0)).map(clone);
  }

  async setLink(id: string, link: BlockLink | null): Promise<void> {
    await this.ready();
    this.ensureDemo();
    const r = this.rowOrThrow(id);
    if (link?.nodeId) {
      const node = await this.nodeRepo.getNode(link.nodeId);
      // 節點不在這台 ⇒ 照樣允許（可能還沒同步過來；同 sqlite）
      if (node && !LINKABLE_KINDS.includes(node.kind)) throw new RangeError("只能連到車票、列車或車廂");
    }
    const plan = planSetLink([toSpan(r)], { id, link, curLink: linkOfRow(r) });
    await this.applyPlan(plan, nowUtcIso());
  }

  async lastCategoryFor(nodeId: string | null, routeId: string | null): Promise<{ categoryId: string; from: "node" | "route" } | null> {
    await this.ready();
    const usable = (catId: string): boolean => {
      const c = this.cats.get(catId);
      return !!c && c.deleted_at === null && c.archived_at === null && c.parent_id !== null;
    };
    const rows = this.aliveNewestFirst();
    // nodeId null（只連路線）⇒ 跳過節點段；不能拿 null 去比（沒連的塊 node_id 也是 null）
    if (nodeId !== null) {
      for (const b of rows) {
        if (b.node_id === nodeId && usable(b.category_id)) return { categoryId: b.category_id, from: "node" };
      }
    }
    if (routeId === null) return null;
    // 路線那段：經節點推導（不看節點的 deleted_at，同 sqlite）＋只連這條路線；getNode 一次呼叫內快取
    const routeOf = new Map<string, string | null>();
    for (const b of rows) {
      let hit = false;
      if (b.node_id !== null) {
        if (!routeOf.has(b.node_id)) {
          const n = await this.nodeRepo.getNode(b.node_id).catch(() => null);
          routeOf.set(b.node_id, n ? n.route_id : null);
        }
        hit = routeOf.get(b.node_id) === routeId;
      } else {
        hit = b.route_id === routeId;
      }
      if (hit && usable(b.category_id)) return { categoryId: b.category_id, from: "route" };
    }
    return null;
  }

  async listBlocksByNodes(nodeIds: readonly string[]): Promise<TimeBlockRow[]> {
    await this.ready();
    if (!nodeIds.length) return [];
    const want = new Set(nodeIds);
    return this.sortAsc(this.aliveNewestFirst().filter((b) => b.node_id !== null && want.has(b.node_id)));
  }

  async listBlocksByRoute(routeId: string): Promise<TimeBlockRow[]> {
    await this.ready();
    const alive = new Map<string, boolean>(); // node id → 在這條路線上而且沒刪
    const out: TimeBlockRow[] = [];
    for (const b of this.aliveNewestFirst()) {
      if (b.node_id !== null) {
        if (!alive.has(b.node_id)) {
          const n = await this.nodeRepo.getNode(b.node_id).catch(() => null);
          alive.set(b.node_id, !!n && n.route_id === routeId && n.deleted_at === null);
        }
        if (alive.get(b.node_id)) out.push(b);
      } else if (b.route_id === routeId) {
        out.push(b);
      }
    }
    return this.sortAsc(out);
  }

  /* ───────── ③：公開的取一塊、時數目標 ───────── */

  async getBlock(id: string, opts?: { withDeleted?: boolean }): Promise<TimeBlockRow | null> {
    await this.ready();
    this.ensureDemo();
    const r = this.blocks.get(id);
    if (!r) return null;
    return !isAlive(r) && !opts?.withDeleted ? null : clone(r);
  }

  private aliveGoalOrThrow(id: string): TimeGoalRow {
    const g = this.goals.get(id);
    if (!g || !isAlive(g)) throw new RangeError("找不到這個目標");
    return g;
  }

  async listGoals(): Promise<TimeGoalRow[]> {
    await this.ready();
    return Array.from(this.goals.values())
      .filter(isAlive)
      .sort((a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : 1))
      .map(clone);
  }

  async getGoal(id: string, opts?: { withDeleted?: boolean }): Promise<TimeGoalRow | null> {
    await this.ready();
    const g = this.goals.get(id);
    if (!g) return null;
    return !isAlive(g) && !opts?.withDeleted ? null : clone(g);
  }

  /** ⑥ 0-11：目標列寫好之後才掛荷札（同 sqlite）；`names` 是 undefined＝不動 */
  private async writeGoalTags(id: string, names: readonly string[] | undefined): Promise<void> {
    if (names === undefined || !this.tags) return;
    const r = await this.tags.setTags(TT_TAG_GOAL, id, names);
    if (receiptWrote(r.receipt)) this.tagWrites = true;
  }

  async createGoal(input: GoalInput): Promise<TimeGoalRow> {
    await this.ready();
    const v = normalizeGoalInput(input);
    const tagNames = v.tagNames !== undefined ? checkTagNames(v.tagNames) : undefined; // 不合法 ⇒ 目標列也不寫
    const now = nowUtcIso();
    const position = Array.from(this.goals.values()).filter(isAlive).reduce((m, g) => Math.max(m, g.position), -1) + 1;
    const row: TimeGoalRow = {
      id: uuid(),
      name: v.name,
      scope: goalScopeJson(v.categoryIds, (tagNames?.length ?? 0) > 0), // ⑥ 0-4：有荷札 ⇒ v2
      period: v.period,
      target_min: v.targetMin,
      direction: v.direction,
      start_on: v.startOn,
      end_on: v.endOn,
      position,
      archived_at: null,
      account_id: null,
      device_id: null,
      created_at: now,
      updated_at: now,
      synced_at: null,
      deleted_at: null,
    };
    this.goals.set(row.id, row);
    await this.writeGoalTags(row.id, tagNames);
    return clone(row);
  }

  async updateGoal(id: string, patch: Partial<GoalInput>): Promise<void> {
    await this.ready();
    const cur = this.aliveGoalOrThrow(id);
    const parsed = parseGoal(cur);
    if (!parsed) throw new RangeError("這個目標是新版本寫的，這一版改不了");
    // ⑥ 0-4：patch 沒帶荷札 ⇒ 驗證與 scope 版本照 taggings 現在掛的（同 sqlite）
    const curTags = this.tags ? (await this.tags.listTagsOf(TT_TAG_GOAL, id)).map((t) => t.name) : [];
    const v = normalizeGoalInput({ ...goalToInput(parsed), ...patch, tagNames: patch.tagNames ?? curTags });
    const tagNames = patch.tagNames !== undefined ? checkTagNames(v.tagNames ?? []) : undefined;
    const scope = goalScopeNext(cur.scope, v.categoryIds, (tagNames ?? curTags).length > 0); // v2 有黏性
    const same =
      v.name === cur.name &&
      scope === cur.scope &&
      v.period === cur.period &&
      v.targetMin === cur.target_min &&
      v.direction === cur.direction &&
      v.startOn === cur.start_on &&
      v.endOn === cur.end_on;
    if (!same) {
      cur.name = v.name;
      cur.scope = scope;
      cur.period = v.period;
      cur.target_min = v.targetMin;
      cur.direction = v.direction;
      cur.start_on = v.startOn;
      cur.end_on = v.endOn;
      cur.updated_at = nowUtcIso();
    }
    await this.writeGoalTags(id, tagNames); // 欄都沒變也照樣對荷札做差
  }

  async archiveGoal(id: string, on: boolean): Promise<void> {
    await this.ready();
    const cur = this.aliveGoalOrThrow(id);
    if (on === (cur.archived_at !== null)) return;
    const now = nowUtcIso();
    cur.archived_at = on ? now : null;
    cur.updated_at = now;
  }

  async deleteGoal(id: string): Promise<void> {
    await this.ready();
    const cur = this.aliveGoalOrThrow(id);
    const now = nowUtcIso();
    cur.deleted_at = now;
    cur.updated_at = now;
    this.tagWrites = true; // ⑥ 評審後：同 softDelete
  }

  async restoreGoal(id: string): Promise<void> {
    await this.ready();
    const cur = this.goals.get(id);
    if (!cur || isAlive(cur)) throw new RangeError("找不到這個目標");
    cur.deleted_at = null;
    cur.updated_at = nowUtcIso();
    this.tagWrites = true; // ⑥ 評審後：復活的目標綁的荷札要回到 index（同 sqlite）
  }

  /* ── ⑤（⑤ 契約 0-5、§3.2；語義同 sqlite 實作） ── */

  /**
   * 方眼塗色（同 sqlite）：plan（fill＝planPaintFill；live＝planPaintLive）→ 寫前複製 patch／delete 對象 → applyPlan →
   * 讀回 → buildPaintUndo。memory 的 applyPlan 每個 patch 都動 `updated_at`（跟 sqlite 不同）；兩邊都「讀回寫後的
   * `updated_at`」，撤回的守門就一致。
   */
  async paint(
    categoryId: string,
    startIso: string,
    endIso: string,
    mode: "fill" | "live",
  ): Promise<{ block: TimeBlockRow; summary: CoverSummary; undo: PaintUndo }> {
    await this.ready();
    const now = Date.now();
    const start = msOf(startIso);
    const spans = this.aliveSpans();
    let plan: WritePlan | null;
    let restartId: string | null = null;
    if (mode === "fill") {
      plan = planPaintFill(spans, { categoryId, start, end: msOf(endIso), now });
    } else {
      const R = currentRunning(spans);
      plan = planPaintLive(spans, { categoryId, at: Math.min(start, now), now });
      if (R && R.categoryId === categoryId) {
        restartId = R.id;
        if (plan === null) {
          return {
            block: clone(this.rowOrThrow(R.id)),
            summary: { removed: 0, shortened: 0, splitCount: 0 },
            undo: { inserted: [], touched: [] },
          };
        }
      }
    }
    if (plan === null) throw new Error("塗色失敗");
    const before: Record<string, TimeBlockRow> = {};
    for (const id of [...plan.patches.map((p) => p.id), ...plan.deletes]) {
      const r = this.blocks.get(id);
      if (r) before[id] = clone(r);
    }
    const ids = await this.applyPlan(plan, isoOf(now));
    const after: Record<string, TimeBlockRow | null> = {};
    for (const id of [...Object.keys(before), ...ids]) {
      const r = this.blocks.get(id);
      after[id] = r ? clone(r) : null;
    }
    const undo = buildPaintUndo(plan, before, after, ids);
    const blockId = restartId ?? ids[plan.inserts.findIndex((i) => !i.inherit)];
    const block = after[blockId];
    if (!block) throw new Error("塗色失敗");
    return { block, summary: summarizeCover(plan, restartId), undo };
  }

  /** 撤回一次塗色（同 sqlite）：守門比 `updated_at`（含已刪除的列）；只寫變了的欄；不叫 restore()、不跑 planCover */
  async undoPaint(undo: PaintUndo): Promise<boolean> {
    await this.ready();
    const current: Record<string, PaintRow | null> = {};
    for (const id of [...undo.inserted.map((x) => x.id), ...undo.touched.map((x) => x.id)]) {
      const r = this.blocks.get(id);
      current[id] = r ? clone(r) : null;
    }
    const writes = planUndoPaint(undo, current);
    if (writes === null) return false;
    const nowIso = isoOf(Date.now());
    for (const w of writes) {
      const r = this.blocks.get(w.id)!;
      if (w.op === "delete") {
        r.deleted_at = nowIso;
      } else {
        if (w.cols.started_at !== undefined) {
          r.started_at = w.cols.started_at;
          this.startStamp.set(r.id, nowIso); // 同真機：寫到 started_at 那一格就戳
        }
        if (w.cols.ended_at !== undefined) r.ended_at = w.cols.ended_at;
        if (w.cols.deleted_at !== undefined) r.deleted_at = w.cols.deleted_at;
      }
      r.updated_at = nowIso;
    }
    this.tagWrites = true; // ⑥ 評審後：撤回會讓被蓋掉的塊復活、切出的片段軟刪 ⇒ index 要重載（同 sqlite）
    return true;
  }
}
