/**
 * reportStore——運行報告的畫面狀態、一日運行專頁（手帳跨頁）與 G6 方針回顧轉日記（② 運行報告 ＋ v1.33 3A 完全體）。
 *
 *   - `load(shell)`：進頁就載；今天清單變動（蓋済、取消）、回到前景時頁面再叫一次。同時多次叫只採最後一次的結果。
 *   - `setPeriod(spec, shell)`：彈性期間切換（今日｜近 7 天｜近 30 天｜按月翻頁｜自訂區間），記本機設定 `report_period`（相容舊鍵 `report_days`）。
 *     若目標區間仍在已載入的事實窗內，直接純函式同步重算；超出則自動重載擴充窗。
 *   - `setScopeFilter`／`toggleTagKey`／`clearFilter`：幹線／路線 ＋ `#荷札`（多選 AND）跨模組即時篩選。
 *   - `openDaySpread`／`closeDaySpread`／`setFocusedDay`／`stepFocusedDay`／`loadSingleDaySpread`：
 *     「一日運行專頁（手帳跨頁）」狀態、捲動位置記憶、`lastVisitedDay` 返回微高亮，以及區間外單日輕量按需載入。
 *   - `writeAimsReviewToDiary(...)`：G6 方針回顧一鍵「寫成日記 ›」——溫柔附加至當日日記文末（絕不覆蓋既有文字）或建立當日日記，並以 `runAtomicNav` 跳轉至旅客筆記日記。
 *   - `loadBrief(shell)`：今日小結（只讀今天：済、已記錄、花了），今日頁自己叫。
 */
import { create } from "zustand";
import { settingsRepo } from "../data";
import { depotRepo } from "../data/depotRepo";
import { noteRepo } from "../data/noteRepo";
import {
  loadBriefFacts,
  loadReportFacts,
  loadSingleDaySpread as fetchSingleDaySpread,
  type BriefFacts,
  type ReportOpen,
} from "../data/reportFacts";
import {
  DEFAULT_REPORT_FILTER,
  appendReviewToDiaryBody,
  buildOperationReport,
  buildSingleDayDetail,
  formatAimsReviewDiary,
  normalizeReportTagKeys,
  parseReportPeriodPref,
  reportFetchWindow,
  resolveReportRange,
  serializeReportPeriodPref,
  stepReportDay,
  type AimDiaryItem,
  type OperationReport,
  type ReportDaySpreadData,
  type ReportFacts,
  type ReportFilter,
  type ReportPeriodSpec,
  type ReportScopeFilter,
  type RouteRankSort,
} from "../domain/report";
import { blockThresholdOf, type TimeCategoryRow } from "../domain/timetable";
import { compareStamps, stampShort } from "../domain/stamps";
import { taskEstimateOf } from "../domain/timetableLink";
import type { StatsSpan } from "../domain/timetableStats";
import { todayKey } from "../lib/date";
import { lineById } from "../lines/index.ts";
import { notesFlush } from "../ui/notes/notesFlush";
import {
  pushUniqueReportNote,
  registerReportNoteSource,
  reportDayNotesLoader,
} from "../ui/report/reportNotes";
import { useNodeStore } from "./nodeStore";
import { useNotesStore } from "./notesStore";
import { useTagStore } from "./tagStore";
import { useTicketStore } from "./ticketStore";
import {
  KEY_LONG_RUN_MAX,
  LONG_RUN_MAX_DEFAULT,
  useTimetableStore,
} from "./timetableStore";
import { useUiStore } from "./uiStore";

export type ReportShell = "desktop" | "mobile";
export type ReportDays = 7 | 30;

/** 本機設定鍵（不在同步白名單裡＝不同步） */
const KEY_DAYS = "report_days";
const KEY_PERIOD = "report_period";

export interface WriteAimsDiaryInput {
  day?: string;
  title: string;
  rangeText?: string | null;
  aims: readonly AimDiaryItem[];
  shell: ReportShell;
  onBeforeJump?: () => void;
}

interface ReportState {
  days: ReportDays;
  period: ReportPeriodSpec;
  filter: ReportFilter;
  rankSort: RouteRankSort;
  historyQuery: string;
  /** 一日運行專頁（手帳跨頁）目前聚焦的營業日 YYYY-MM-DD；null＝在運行報告總表 */
  focusedDay: string | null;
  /** 最近一次進入過的營業日（返回總表時提供溫和微標記銜接視線） */
  lastVisitedDay: string | null;
  /** 進入單日專頁前總表的捲動高度 */
  savedScrollTop: number;
  /** 單日專頁完整資料（含日記全文與車窓の問い） */
  spread: ReportDaySpreadData | null;
  spreadLoading: boolean;
  lastShell: ReportShell;
  facts: ReportFacts | null;
  report: OperationReport | null;
  loading: boolean;
  error: string | null;
  brief: BriefFacts | null;
  load(shell: ReportShell): Promise<void>;
  setDays(d: ReportDays): void;
  setPeriod(spec: ReportPeriodSpec, shell?: ReportShell): void;
  setScopeFilter(scope: ReportScopeFilter): void;
  toggleTagKey(key: string): void;
  clearFilter(): void;
  setRankSort(sort: RouteRankSort): void;
  setHistoryQuery(q: string): void;
  openDaySpread(day: string, shell?: ReportShell, scrollTop?: number): void;
  closeDaySpread(): void;
  setFocusedDay(day: string | null, shell?: ReportShell): void;
  stepFocusedDay(delta: number, shell?: ReportShell): void;
  setSavedScrollTop(top: number): void;
  loadSingleDaySpread(day: string, shell?: ReportShell): Promise<void>;
  writeAimsReviewToDiary(input: WriteAimsDiaryInput): Promise<void>;
  loadBrief(shell: ReportShell): Promise<void>;
}

function openOf(shell: ReportShell): ReportOpen {
  const st = (id: "timetable" | "ticket" | "notes") => {
    const m = lineById(id);
    return (shell === "desktop" ? m.page.status : m.mobile.status) === "open";
  };
  return {
    timetable: st("timetable"),
    ticket: st("ticket"),
    notes: st("notes"),
  };
}

/** 今天＝今日頁同一把尺（loadToday 算出來的那一天；還沒載完退回日界線換算） */
function todayNow(): string {
  return (
    useNodeStore.getState().today.dateKey ??
    todayKey(useUiStore.getState().dayStartHour)
  );
}

/** 全域「跑太久」上限：時刻表 store 已載用它的；沒載讀設定（同 timetableStore 的解析：空／壞值＝預設） */
async function longRunMaxNow(): Promise<number> {
  const tt = useTimetableStore.getState();
  if (tt.ready) return tt.longRunMaxMin;
  const raw = await settingsRepo.get(KEY_LONG_RUN_MAX).catch(() => null);
  if (raw === null || raw === "") return LONG_RUN_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : LONG_RUN_MAX_DEFAULT;
}

function thresholdWith(
  max: number,
): (cats: readonly TimeCategoryRow[]) => (s: StatsSpan) => number | null {
  return (cats) => {
    const tt = useTimetableStore.getState();
    const catById: Record<string, TimeCategoryRow> = tt.ready
      ? tt.catById
      : Object.fromEntries(cats.map((c) => [c.id, c]));
    return (s) =>
      blockThresholdOf(
        s.end !== null,
        s.estimateMin,
        catById[s.categoryId] ?? null,
        max,
        s.end === null
          ? taskEstimateOf(
              { node_id: s.nodeId, route_id: s.routeId },
              tt.linkInfo,
            )
          : null,
      )?.min ?? null;
  };
}

function normalizePeriod(spec: ReportPeriodSpec, today: string): ReportPeriodSpec {
  if (spec.mode === "month") {
    const r = resolveReportRange(today, spec);
    return { mode: "month", month: r.month };
  }
  if (spec.mode === "custom") {
    const r = resolveReportRange(today, spec);
    return { mode: "custom", customFrom: r.from, customTo: r.to };
  }
  return { mode: spec.mode };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function ensureTicketPrivacyReady(open: ReportOpen): Promise<void> {
  if (!open.ticket) return;
  const tk = useTicketStore.getState();
  if (!tk.ready) {
    await tk.warm().catch(() => undefined);
  }
}

registerReportNoteSource({
  id: "depot.stamps",
  async load(from, to) {
    const out: Record<string, string[]> = {};
    const repo = depotRepo as Partial<typeof depotRepo>;
    if (typeof repo.listStamps === "function") {
      const rows = await repo.listStamps();
      const matched = rows
        .filter((s) => s.deleted_at === null && s.stamped_on >= from && s.stamped_on <= to)
        .sort(compareStamps);
      for (const s of matched) {
        pushUniqueReportNote(out, s.stamped_on, stampShort(s));
      }
    }

    const ns = useNodeStore.getState();
    for (const st of ns.stations ?? []) {
      if (st.deleted_at === null && st.arrived_on && st.arrived_on >= from && st.arrived_on <= to) {
        pushUniqueReportNote(out, st.arrived_on, `${st.name} 到着`);
      }
    }
    for (const r of ns.routes ?? []) {
      if (r.deleted_at === null && r.arrived_on && r.arrived_on >= from && r.arrived_on <= to) {
        pushUniqueReportNote(out, r.arrived_on, `${r.name} 到站`);
      }
    }
    for (const l of ns.lines ?? []) {
      if (l.deleted_at === null && l.arrived_on && l.arrived_on >= from && l.arrived_on <= to) {
        pushUniqueReportNote(out, l.arrived_on, `幹線「${l.name}」到站`);
      }
    }
    return out;
  },
});

let prefLoaded = false;
let seq = 0;
let briefSeq = 0;
let spreadSeq = 0;

export const useReportStore = create<ReportState>((set, get) => ({
  days: 7,
  period: { mode: "7d" },
  filter: DEFAULT_REPORT_FILTER,
  rankSort: "seals",
  historyQuery: "",
  focusedDay: null,
  lastVisitedDay: null,
  savedScrollTop: 0,
  spread: null,
  spreadLoading: false,
  lastShell: "desktop",
  facts: null,
  report: null,
  loading: false,
  error: null,
  brief: null,

  async load(shell) {
    const my = ++seq;
    set({ loading: true, lastShell: shell });
    try {
      const today = todayNow();
      if (!prefLoaded) {
        prefLoaded = true;
        const [rawPeriod, rawDays] = await Promise.all([
          settingsRepo.get(KEY_PERIOD).catch(() => null),
          settingsRepo.get(KEY_DAYS).catch(() => null),
        ]);
        const parsed = parseReportPeriodPref(rawPeriod ?? rawDays, today);
        set({
          period: parsed,
          days: parsed.mode === "30d" ? 30 : 7,
        });
      }
      const open = openOf(shell);
      if (open.notes) {
        const ts = useTagStore.getState();
        if (!ts.index && !ts.loading) void ts.loadIndex();
      }
      const ui = useUiStore.getState();
      const now = Date.now();
      const curPeriod = normalizePeriod(get().period, today);
      const curFilter = get().filter;
      const [facts] = await Promise.all([
        loadReportFacts({
          today,
          dayStartHour: ui.dayStartHour,
          weekStart: ui.weekStart,
          days: curPeriod.mode === "30d" ? 30 : 7,
          period: curPeriod,
          filter: curFilter,
          now,
          open,
          routes: useNodeStore.getState().routes,
          timeThreshold: thresholdWith(await longRunMaxNow()),
          dayNotes: reportDayNotesLoader(),
        }),
        ensureTicketPrivacyReady(open),
      ]);
      if (my !== seq) return;
      const report = buildOperationReport(facts, now);
      set({
        facts,
        report,
        error: null,
        loading: false,
      });
      const activeDay = get().focusedDay;
      if (activeDay !== null) {
        void get().loadSingleDaySpread(activeDay, shell);
      }
    } catch (e) {
      if (my !== seq) return;
      console.warn("運行報告讀取失敗", e);
      set({ error: errText(e), loading: false });
    }
  },

  setDays(d) {
    get().setPeriod({ mode: d === 30 ? "30d" : "7d" });
  },

  setPeriod(spec, shell) {
    const today = get().facts?.today ?? todayNow();
    const norm = normalizePeriod(spec, today);
    const nextDays: ReportDays = norm.mode === "30d" ? 30 : 7;
    void settingsRepo.set(KEY_PERIOD, serializeReportPeriodPref(norm)).catch(() => undefined);
    if (norm.mode === "7d" || norm.mode === "30d") {
      void settingsRepo.set(KEY_DAYS, String(nextDays)).catch(() => undefined);
    }

    const f = get().facts;
    if (!f) {
      set({ period: norm, days: nextDays });
      return;
    }

    const range = resolveReportRange(f.today, norm);
    const needWin = reportFetchWindow(f.today, f.weekStart, range);
    const loadedFrom = f.loadedFrom ?? f.today;

    if (needWin.from < loadedFrom) {
      set({ period: norm, days: nextDays });
      void get().load(shell ?? get().lastShell);
      return;
    }

    const nextFacts: ReportFacts = {
      ...f,
      days: nextDays,
      period: norm,
      filter: get().filter,
    };
    const report = buildOperationReport(nextFacts, Date.now());
    set({
      period: norm,
      days: nextDays,
      facts: nextFacts,
      report,
    });
  },

  setScopeFilter(scope) {
    const nextFilter: ReportFilter = { ...get().filter, scope };
    const f = get().facts;
    if (!f) {
      set({ filter: nextFilter });
      return;
    }
    const nextFacts: ReportFacts = { ...f, filter: nextFilter };
    set({
      filter: nextFilter,
      facts: nextFacts,
      report: buildOperationReport(nextFacts, Date.now()),
    });
  },

  toggleTagKey(rawKey) {
    const [norm] = normalizeReportTagKeys([rawKey]);
    if (!norm) return;
    const cur = get().filter.tagKeys;
    const nextKeys = cur.includes(norm) ? cur.filter((k) => k !== norm) : [...cur, norm];
    const nextFilter: ReportFilter = { ...get().filter, tagKeys: nextKeys };
    const f = get().facts;
    if (!f) {
      set({ filter: nextFilter });
      return;
    }
    const nextFacts: ReportFacts = { ...f, filter: nextFilter };
    set({
      filter: nextFilter,
      facts: nextFacts,
      report: buildOperationReport(nextFacts, Date.now()),
    });
  },

  clearFilter() {
    const f = get().facts;
    if (!f) {
      set({ filter: DEFAULT_REPORT_FILTER });
      return;
    }
    const nextFacts: ReportFacts = { ...f, filter: DEFAULT_REPORT_FILTER };
    set({
      filter: DEFAULT_REPORT_FILTER,
      facts: nextFacts,
      report: buildOperationReport(nextFacts, Date.now()),
    });
  },

  setRankSort(rankSort) {
    if (rankSort !== get().rankSort) set({ rankSort });
  },

  setHistoryQuery(historyQuery) {
    set({ historyQuery });
  },

  setSavedScrollTop(top) {
    set({ savedScrollTop: Math.max(0, Math.round(top)) });
  },

  openDaySpread(day, shell, scrollTop) {
    const today = get().facts?.today ?? todayNow();
    const target = day > today ? today : day;
    const sh = shell ?? get().lastShell;
    const wasOverview = get().focusedDay === null;
    const nextScroll =
      wasOverview && typeof scrollTop === "number"
        ? Math.max(0, Math.round(scrollTop))
        : get().savedScrollTop;

    const f = get().facts;
    const curSpread = get().spread;
    let seeded: ReportDaySpreadData | null = curSpread?.day === target ? curSpread : null;
    if (!seeded && f && target >= (f.loadedFrom ?? f.today) && target <= f.today) {
      const detail = buildSingleDayDetail(f, target, Date.now());
      seeded = {
        day: target,
        isToday: target === f.today,
        detail,
        routes: f.routes,
        dayNotes: f.dayNotes?.[target] ?? [],
        workLogs: [],
        moods: detail.seals.flatMap((s) => (s.mood ? [s.mood] : [])),
        diaries: null,
        reflections: [],
      };
    }

    set({
      focusedDay: target,
      lastVisitedDay: target,
      savedScrollTop: nextScroll,
      lastShell: sh,
      spread: seeded,
      spreadLoading: true,
    });
    void get().loadSingleDaySpread(target, sh);
  },

  closeDaySpread() {
    const cur = get().focusedDay;
    if (cur === null) return;
    spreadSeq++;
    set({
      focusedDay: null,
      lastVisitedDay: cur,
      spreadLoading: false,
    });
  },

  setFocusedDay(day, shell) {
    if (day === null) {
      get().closeDaySpread();
      return;
    }
    get().openDaySpread(day, shell);
  },

  stepFocusedDay(delta, shell) {
    const cur = get().focusedDay;
    if (!cur) return;
    const today = get().facts?.today ?? todayNow();
    const next = stepReportDay(cur, delta, today);
    if (next !== cur) {
      get().openDaySpread(next, shell ?? get().lastShell);
    }
  },

  async loadSingleDaySpread(day, shell) {
    const sh = shell ?? get().lastShell;
    const my = ++spreadSeq;
    set({ spreadLoading: true, lastShell: sh });
    try {
      const today = get().facts?.today ?? todayNow();
      const target = day > today ? today : day;
      const open = openOf(sh);
      if (open.notes) {
        const ts = useTagStore.getState();
        if (!ts.index && !ts.loading) void ts.loadIndex();
      }
      const ui = useUiStore.getState();
      const now = Date.now();
      const [spread] = await Promise.all([
        fetchSingleDaySpread({
          day: target,
          today,
          dayStartHour: ui.dayStartHour,
          now,
          open,
          routes: useNodeStore.getState().routes,
          timeThreshold: thresholdWith(await longRunMaxNow()),
          dayNotes: reportDayNotesLoader(),
        }),
        ensureTicketPrivacyReady(open),
      ]);
      if (my !== spreadSeq || get().focusedDay !== target) return;
      set({
        spread,
        spreadLoading: false,
      });
    } catch (e) {
      if (my !== spreadSeq) return;
      console.warn("一日運行專頁讀取失敗", e);
      set({ spreadLoading: false });
    }
  },

  async writeAimsReviewToDiary(input) {
    const ui = useUiStore.getState();
    if (!openOf(input.shell).notes) {
      ui.showToast({ message: "旅客筆記尚未通車" });
      return;
    }
    if (input.aims.length === 0) {
      ui.showToast({ message: "目前沒有可寫入日記的方針" });
      return;
    }

    const day = input.day ?? todayNow();
    const mdBlock = formatAimsReviewDiary({
      title: input.title,
      rangeText: input.rangeText,
      aims: input.aims,
    });

    try {
      const { runAtomicNav } = await import("./navHistoryStore");
      await notesFlush.fn?.();
      const existing = await noteRepo.listDiary(day);

      if (existing.length > 0) {
        const target = existing[existing.length - 1]!;
        const beforeBody = target.body;
        const merged = appendReviewToDiaryBody(beforeBody, mdBlock);
        if (!merged.alreadyPresent) {
          await noteRepo.update(target.id, { body: merged.body });
          await useTagStore.getState().syncNoteTags(target.id, merged.body);
        }

        input.onBeforeJump?.();
        await runAtomicNav(async () => {
          if (input.shell === "desktop") ui.setPage("notes");
          else ui.setMobileTab("notes");
          const ns = useNotesStore.getState();
          if (ns.diaryQuery) void ns.setDiaryQuery("");
          ns.openDiaryAt(day);
          await ns.loadDiary();
          ns.selectDiaryEntry(target.id);
          ns.setDiaryEditing(target.id);
        });

        if (merged.alreadyPresent) {
          ui.showToast({ message: "這段方針回顧已在日記裡，為你翻到那裡" });
        } else {
          ui.showToast({
            message: "已將方針回顧附在日記文末",
            actionLabel: "復原",
            onAction: () => {
              void (async () => {
                await noteRepo.update(target.id, { body: beforeBody });
                await useTagStore.getState().syncNoteTags(target.id, beforeBody);
                await useNotesStore.getState().loadDiary();
              })();
            },
          });
        }
        return;
      }

      const merged = appendReviewToDiaryBody("", mdBlock);
      const created = await noteRepo.create({
        kind: "diary",
        entryDate: day,
        title: null,
        body: merged.body,
        inbox: false,
      });
      await useTagStore.getState().syncNoteTags(created.id, merged.body);

      input.onBeforeJump?.();
      await runAtomicNav(async () => {
        if (input.shell === "desktop") ui.setPage("notes");
        else ui.setMobileTab("notes");
        const ns = useNotesStore.getState();
        if (ns.diaryQuery) void ns.setDiaryQuery("");
        ns.openDiaryAt(day);
        await ns.loadDiary();
        ns.selectDiaryEntry(created.id);
        ns.setDiaryEditing(created.id);
      });

      ui.showToast({
        message: "已將方針回顧寫入日記",
        actionLabel: "復原",
        onAction: () => {
          void (async () => {
            await noteRepo.softDelete(created.id);
            await useNotesStore.getState().loadDiary();
          })();
        },
      });
    } catch (e) {
      console.warn("方針回顧寫入日記失敗", e);
      ui.showToast({ message: `寫入日記失敗：${errText(e)}` });
    }
  },

  async loadBrief(shell) {
    const my = ++briefSeq;
    try {
      const open = openOf(shell);
      const [brief] = await Promise.all([
        loadBriefFacts({
          today: todayNow(),
          dayStartHour: useUiStore.getState().dayStartHour,
          now: Date.now(),
          open,
          timeThreshold: thresholdWith(await longRunMaxNow()),
        }),
        ensureTicketPrivacyReady(open),
      ]);
      if (my === briefSeq) set({ brief });
    } catch (e) {
      // 小結讀不到不擋今日頁：留著上一次的數字（第一次就失敗＝不畫）
      console.warn("今日小結讀取失敗", e);
    }
  },
}));
