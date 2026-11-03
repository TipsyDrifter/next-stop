/**
 * reportStore——運行報告的畫面狀態（② 運行報告；契約 §7）。只讀：讀事實（data/reportFacts）→ 純函式算（domain/report）→ 存結果。
 *
 *   - `load(shell)`：進頁就載；今天清單變動（蓋済、取消）、回到前景時頁面再叫一次。同時多次叫只採最後一次的結果。
 *   - `setDays(7|30)`：表格天數；記在本機設定 `report_days`（不同步，同「螢幕偏好不同步」D-1.1-3），換天數不重讀（事實已讀 37 天）。
 *   - `loadBrief(shell)`：今日小結（只讀今天：済、已記錄、花了），今日頁自己叫（清單變動、每分鐘）。
 * 線沒通車（桌機看 page.status、手機看 mobile.status）就不讀那一段。
 * 時刻表的門檻跟統計頁同一支 `blockThresholdOf`：時刻表 store 已載就用它的分類、全域上限、任務預計；沒載用分類表＋預設上限。
 */
import { create } from "zustand";
import { settingsRepo } from "../data";
import {
  loadBriefFacts,
  loadReportFacts,
  type BriefFacts,
  type ReportOpen,
} from "../data/reportFacts";
import {
  buildOperationReport,
  type OperationReport,
  type ReportFacts,
} from "../domain/report";
import { blockThresholdOf, type TimeCategoryRow } from "../domain/timetable";
import { taskEstimateOf } from "../domain/timetableLink";
import type { StatsSpan } from "../domain/timetableStats";
import { todayKey } from "../lib/date";
import { lineById } from "../lines/index.ts";
import { reportDayNotesLoader } from "../ui/report/reportNotes";
import { useNodeStore } from "./nodeStore";
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

interface ReportState {
  days: ReportDays;
  facts: ReportFacts | null;
  report: OperationReport | null;
  loading: boolean;
  error: string | null;
  brief: BriefFacts | null;
  load(shell: ReportShell): Promise<void>;
  setDays(d: ReportDays): void;
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let daysLoaded = false;
let seq = 0;
let briefSeq = 0;

export const useReportStore = create<ReportState>((set, get) => ({
  days: 7,
  facts: null,
  report: null,
  loading: false,
  error: null,
  brief: null,

  async load(shell) {
    const my = ++seq;
    set({ loading: true });
    try {
      if (!daysLoaded) {
        daysLoaded = true;
        const raw = await settingsRepo.get(KEY_DAYS).catch(() => null);
        if (raw === "30") set({ days: 30 });
      }
      const ui = useUiStore.getState();
      const now = Date.now();
      const facts = await loadReportFacts({
        today: todayNow(),
        dayStartHour: ui.dayStartHour,
        weekStart: ui.weekStart,
        days: get().days,
        now,
        open: openOf(shell),
        routes: useNodeStore.getState().routes,
        timeThreshold: thresholdWith(await longRunMaxNow()),
        dayNotes: reportDayNotesLoader(),
      });
      if (my !== seq) return;
      set({
        facts,
        report: buildOperationReport(facts, now),
        error: null,
        loading: false,
      });
    } catch (e) {
      if (my !== seq) return;
      console.warn("運行報告讀取失敗", e);
      set({ error: errText(e), loading: false });
    }
  },

  setDays(d) {
    if (d === get().days) return;
    void settingsRepo.set(KEY_DAYS, String(d)).catch(() => undefined);
    const f = get().facts;
    set(
      f
        ? {
            days: d,
            facts: { ...f, days: d },
            report: buildOperationReport({ ...f, days: d }, Date.now()),
          }
        : { days: d },
    );
  },

  async loadBrief(shell) {
    const my = ++briefSeq;
    try {
      const brief = await loadBriefFacts({
        today: todayNow(),
        dayStartHour: useUiStore.getState().dayStartHour,
        now: Date.now(),
        open: openOf(shell),
        timeThreshold: thresholdWith(await longRunMaxNow()),
      });
      if (my === briefSeq) set({ brief });
    } catch (e) {
      // 小結讀不到不擋今日頁：留著上一次的數字（第一次就失敗＝不畫）
      console.warn("今日小結讀取失敗", e);
    }
  },
}));
