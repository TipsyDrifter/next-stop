/**
 * timetableStore——時刻表線的畫面狀態與流程（車次①a 契約 §3.7、§3.8；甲席 Stage 0）。
 *
 * **UI 只讀 store、只叫 store 的動作，不直接碰 repository**（契約 §2.6-3）。
 *
 * - serial 佇列：每個寫入與 `reconcile` 都排進 `chain`，保證不交錯（repository 每支都先讀現況再算）。
 * - 時間：store 動作收毫秒，轉 ISO 給 repo；`now = Date.now()` 在動作開頭取一次。
 * - 錯誤：寫入失敗 toast（RangeError 吐它的 message；其他吐「存檔失敗——請再試一次」），不寫 `error`；
 *   `error` 只給 `init`／`refresh` 載入失敗（nodeStore 的教訓）。
 * - 設定三把 key：`timetable_long_run_max_min`（同步）、`timetable_view`／`timetable_notice`（本地）。
 * - toast 全文（契約 §5.10）集中在 `TT_TEXT`；固定文案（§5.11）給 UI 用的也放這裡。
 *
 * 車次①b（①b①c 契約 §3.6、§3.7；只加不改）：門檻改成「這一班的預估 → 分類預設長度 → 全域上限」（`blockMarker`／
 * `blockIsLongRun`）；預估、多切點、合併、封存／搬組／換圓牌字、F 鍵；F1（dayStartHour 變了就 refresh）。
 * ①c 要的狀態與動作也在這裡先寫好（①b 單獨進站時休眠）：三把本地通知鍵、`recentCategoryIds`、
 * 模組層匯出 `timetableWrite`／`waitForTimetableSyncSettle`。
 *
 * 車次②（② 契約 §3.7、§3.8；只加不改）：連到的節點資訊 `linkInfo`（＋序號 `linkSeq`）、`rev`；從任務發車
 * （`departFromTask`／`departWithLink`）；`depart`／`fill`／`editBlock` 收連結、`setLink`；側板「時間」用的讀取
 * （`linkedBlocks`／`subtreeNodes`／`routeNodes`）；門檻多一層任務的預計時間（`blockMarker`／`blockIsLongRun` 的 `links`）。
 * `nodeRepo` 只在本檔與 `taskWatch.ts` 用（② 契約 §1-5）。
 *
 * 車次③（③ 契約 §3.3、0-7；只加不改）：視圖多 `week`／`stats`、面板多 `goal`／`pendingList`；`ensureFreshDay()`（#72：進頁、
 * 切視圖、回前景都檢查換日）；時數目標的寫入動作（`createGoal`…）；`TT_TEXT` 增補（§5.9）；本週合計跟全 App 的 `week_start`。
 * 統計與週視圖的資料另開 `timetableStatsStore`（只讀，統計頁沒開時不載）。
 */
import { create } from "zustand";
import { timetableRepo } from "../data/timetableRepository";
import { settingsRepo, nodeRepo, MOCK_MODE } from "../data";
import { useUiStore } from "./uiStore";
import { useSyncStore } from "./syncStore";
import { indexTree, useNodeStore, type TreeIndex } from "./nodeStore";
import { addDays, dayWindow, todayKey } from "../lib/date";
import type { GoalInput, GoalPeriod, GoalDirection, StatsPeriod } from "../domain/timetableStats";
import type { LineReloadContext } from "../lines/types";
import { KIND_LABEL, type NodeRow } from "../domain/node";
import { notePulled } from "../ui/timetable/taskWatch";
import { waitTimetableIdle } from "../domain/timetableIdle";
import {
  LINKABLE_KINDS,
  LINK_MISSING_TEXT,
  linkDeletedText,
  linkLabelOf,
  taskEstimateOf,
  type LinkInfo,
} from "../domain/timetableLink";
import {
  MIN,
  currentRunning,
  fmtClock,
  fmtDur,
  findBlockIn,
  isLongRun,
  isoOf,
  latestGap,
  msOf,
  runMarker,
  segmentsOfDay,
  sheetBlockIdOf,
  thresholdOf,
  toSpan,
  weekStartKey,
  type BlockLink,
  type CoverSummary,
  type LongRunChoice,
  type MergePreview,
  type RunMarker,
  type TimeBlockRow,
  type TimeCategoryRow,
} from "../domain/timetable";

export const KEY_LONG_RUN_MAX = "timetable_long_run_max_min"; // 同步（manifest syncSettingsKeys）
export const KEY_VIEW = "timetable_view"; // 本地
export const KEY_NOTICE = "timetable_notice"; // 本地："0"＝關；沒有列＝開
export const LONG_RUN_MAX_DEFAULT = 840; // 14 小時；0＝關
// ①b①c 契約 0-11：以下全部本地、不同步（不進 manifest syncSettingsKeys；D-時-30 各台各記）
export const KEY_NOTICE_LONG_RUN = "timetable_notice_long_run"; // 本地："0"＝關；沒有列＝開（跑太久提醒）
export const KEY_NOTICE_TILES = "timetable_notice_tiles"; // 本地："0"＝關；沒有列＝開（常用分類格）
export const KEY_NOTICE_PINS = "timetable_notice_pins"; // 本地：JSON string[]（≤5；釘選分類）
export const NOTICE_PINS_MAX = 5;

/** 手機 board|axis|week|stats；桌機 split|axis|week|stats（①a 契約 0-6；③ 加 week／stats，D-時-46） */
export type TimetableView = "board" | "axis" | "split" | "week" | "stats";
export type TimetableShell = "desktop" | "mobile";

export type TimetableSheet =
  | { kind: "depart" }
  /** ②：then 的 tile 可以帶連結（從任務發車遇到長時間運行待確認，先問完再發車） */
  | { kind: "longRun"; blockId: string; then: "depart" | "arrive" | { tile: string; link?: BlockLink } | null }
  | { kind: "restart"; blockId: string }
  | { kind: "fill"; start: number; end: number }
  | { kind: "edit"; blockId: string }
  | { kind: "split"; blockId: string }
  | { kind: "categories" }
  /** ①b：這一班的預估（運行中那班） */
  | { kind: "estimate"; blockId: string }
  /** ②：從任務發車、第一次碰到的路線（☎一-1） */
  | { kind: "taskCategory"; nodeId: string }
  /** ②：改一塊的連結（運行列「連到…」與改一塊面板都開它） */
  | { kind: "link"; blockId: string }
  /** ③：時數目標面板；goalId null＝新增 */
  | { kind: "goal"; goalId: string | null }
  /** ③：待確認清單（from／to＝正在看的那一期的窗，毫秒；清單內容讀 timetableStatsStore） */
  | { kind: "pendingList"; from: number; to: number; /** 乙：有值＝只列這個目標範圍的待確認（目標卡「看看 ›」，〈原型定案〉1） */ goalId?: string | null };

/** toast 全文（契約 §5.10）與固定文案（§5.11）——顯示端不手抄 */
export const TT_TEXT = {
  depart: (cat: string, at: number) => `発車・${cat}　${fmtClock(at)}`,
  departAction: "改 10 分前",
  arrive: (cat: string, dur: number) => `到着・${cat}　${fmtDur(dur)}`,
  undo: "撤回",
  longRunGap: (cat: string, at: number) => `到着・${cat}　${fmtClock(at)}；之後留白`,
  longRunCat: (cat: string, at: number) => `${fmtClock(at)} 起改成「${cat}」`,
  fill: (cat: string, dur: number) => `補上・${cat}　${fmtDur(dur)}`,
  edit: (cat: string, start: number, end: number) => `改好了・${cat}　${fmtClock(start)}–${fmtClock(end)}`,
  deleted: "已刪除這一塊",
  split: (at: number) => `切開・${fmtClock(at)}`,
  restart: (at: number) => `出發時間改成 ${fmtClock(at)}`,
  alreadyRunning: "這一班已經在跑了",
  runningHint: "運行中的這一班：在運行列換車、到着或改出發時間",
  undoArriveFailed: "已經有下一班了，到站撤回不了",
  saveFailed: "存檔失敗——請再試一次",
  pickCategory: "選一個分類",
  categoryCreated: (name: string) => `已新增分類「${name}」`,
  categoryRenamed: (name: string) => `已改名為「${name}」`,
  /** W1：蓋到既有紀錄時的赭字；為 0 的部分省略；全 0 回空字串 */
  cover: (s: CoverSummary) => {
    const parts: string[] = [];
    if (s.removed) parts.push(`蓋掉 ${s.removed} 塊`);
    if (s.shortened) parts.push(`切短 ${s.shortened} 塊`);
    if (s.splitCount) parts.push(`切開 ${s.splitCount} 塊`);
    return parts.length ? `會${parts.join("、")}` : "";
  },

  /* ── ①b（①b①c 契約 §5.13 B1–B14） ── */
  /** B1 合併完成；end null＝運行中 */
  merged: (cat: string, start: number, end: number | null) => `合併・${cat}　${fmtClock(start)}–${end === null ? "運行中" : fmtClock(end)}`,
  /** B2 合併預覽行（不是 toast）；蓋住空白時尾加「（蓋住未記錄 X）」 */
  mergePreview: (cat: string, start: number, end: number | null, gapMs: number) =>
    `合併後：${cat} ${fmtClock(start)}–${end === null ? "運行中" : fmtClock(end)}` + (gapMs > 0 ? `（蓋住未記錄 ${fmtDur(gapMs)}）` : ""),
  /** B3 多切點 */
  splitMulti: (n: number) => `切成 ${n} 段`,
  /** B4 改預估 */
  estimateSet: (min: number) => `預估改成 ${fmtDur(min * MIN)}`,
  /** B5 清掉預估 */
  estimateCleared: "已清掉預估",
  /** B6 封存（帶「撤回」＝TT_TEXT.undo） */
  archived: (name: string) => `已封存「${name}」`,
  /** B7 還原 */
  unarchived: (name: string) => `已還原「${name}」`,
  /** B8 搬組 */
  movedToGroup: (name: string, group: string) => `「${name}」搬到「${group}」`,
  /** B9 換圓牌字 */
  glyphSet: (glyph: string) => `圓牌字改成「${glyph}」`,
  /** B10 圓牌字不是一個字 */
  glyphInvalid: "圓牌字只能一個字",
  /** B11 誤點 chip */
  late: (overMs: number) => `誤點 +${fmtDur(overMs)}`,
  latePending: (overMs: number) => `誤點 +${fmtDur(overMs)}・待確認`,
  /** B12 預估 chip */
  estimateChip: (min: number) => `預估 ${fmtDur(min * MIN)}`,
  estimateAdd: "＋預估",
  /** B13 F 鍵沒有空白 */
  noGap: "這一天沒有未記錄的時間",
  /** B14 切點驗證 */
  cutTooShort: "每段至少 1 分",

  /* ── ②（② 契約 §5.13；鍵名照契約） ── */
  DEPART_TASK: (cat: string, task: string, at: number) => `発車・${cat}・${task}　${fmtClock(at)}`,
  ALREADY_RUNNING_TASK: (task: string) => `「${task}」已經在跑了`,
  TASK_MISSING: "找不到這張車票",
  LINKED: (label: string) => `已連到「${label}」`,
  UNLINKED: "已取消連結",
  DONE_STILL_RUNNING: (task: string) => `「${task}」蓋済了，計時還在跑`,
  ARRIVE_ACTION: "到着",
  TASK_CATEGORY_TITLE: (task: string) => `「${task}」算哪一類？`,
  /** 節點掛著路線 */
  TASK_CATEGORY_NOTE: "之後從這條路線發車會記住",
  /** 沒掛路線的臨時車票（只查節點那一段，每一張第一次都會跳） */
  TASK_CATEGORY_NOTE_NO_ROUTE: "之後從這張票發車會記住",
  LINK_DELETED: linkDeletedText,
  LINK_MISSING: LINK_MISSING_TEXT,
  /** LinkPanel 標題 */
  LINK_TITLE: "連到…",
  /** 運行列沒連時的淡字 */
  LINK_NONE: "連到…",
  LINK_CLEAR: "取消連結",
  LINK_ROUTE_ONLY: "只連路線",
  TODAY_TICKETS: "今日車票",
  TIME_LABEL: "時間",
  TIME_HOVER: (self: string, below: string) => `自己 ${self}／底下 ${below}`,
  ROUTE_TIME: (month: string, total: string) => `本月 ${month}・累計 ${total}`,
  TIME_MANUAL: "手填",
  TIME_BLOCKS: (x: string) => `時間塊 ${x}`,
  FOCUS: "專注",
  TODAY_DEPART: "発車",
  TODAY_RUNNING: "正在跑",
  EST_FALLBACK_TASK: (x: string) => `；沒預估時用任務的預計時間 ${x}`,
  LONG_RUN_TASK: (task: string, est: string, over: string) => `「${task}」預計 ${est}，已經誤點 ${over}。其實到幾點？`,

  /* ── ③（③ 契約 §5.9；顯示端不手抄） ── */
  viewWeek: "週",
  viewStats: "統計",
  statsRecorded: "已記錄",
  statsUnrecorded: "未記錄",
  statsPending: (n: number, ms: number) => `待確認 ${n} 班・${fmtDur(ms)}`,
  /** 環比總述的前綴：「比上週同期」（進行中的期，same）／「比上週」（已過完的期） */
  statsCompare: (p: StatsPeriod, same: boolean) => `比${p === "day" ? "昨天" : p === "week" ? "上週" : "上個月"}${same ? "同期" : ""}`,
  statsEmpty: "這一期還沒有紀錄",
  statsToCurrent: "回到本期",
  weekToCurrent: "回到本週",
  routeNone: "沒連任務",
  routeGone: "（已刪除的任務）",
  goalAdd: "＋目標",
  goalMet: "達成",
  goalOver: (ms: number) => `超過 ${fmtDur(ms)}`,
  /** 至少＝「還差」、至多（atMost 傳 true）＝「還剩」 */
  goalLeft: (ms: number, atMost = false) => `${atMost ? "還剩" : "還差"} ${fmtDur(ms)}`,
  goalPendingHint: (n: number) => `另有 ${n} 班待確認`,
  /** D-時-60／61／62：期間過了／還沒開始／節奏 */
  goalEnded: "已結束",
  goalMissed: "沒達到",
  goalKept: "守住",
  goalStarts: (md: string) => `${md} 開始`,
  goalDaysLeft: (n: number) => `還剩 ${n} 天`,
  goalPace: (ms: number) => `平均每天還要 ${fmtDur(ms)}`,
  /** 已結束的卡上「收起來」（＝封存） */
  goalHide: "收起來",
  goalSaved: (name: string) => `目標「${name}」存好了`,
  goalDeleted: "目標刪掉了",
  goalArchived: (name: string) => `「${name}」收起來了`,
  goalUnarchived: (name: string) => `「${name}」叫回來了`,
  pendingAllDone: "都確認好了",
  syncBlockGone: "後來又被整理掉，現在不在軸上了",
  /** ③ 週視圖、視圖切換的畫面字（丙席；契約 §5.1、§5.5、D-時-54、66；顯示端不手抄） */
  weekUi: {
    /** 欄頭（D-時-66：寫「週一」，不是單一個「一」） */
    weekdays: ["週日", "週一", "週二", "週三", "週四", "週五", "週六"] as readonly string[],
    viewSplit: "兩欄",
    viewAxis: "只看軸",
    viewBoard: "發車台",
    viewAxisMobile: "軸",
    tagThisWeek: "本週",
    tagLastWeek: "上週",
    prevWeek: "上一週",
    nextWeek: "下一週",
    legendPending: "待確認",
    legendNow: "現在",
    running: "運行中",
    /** 塊的 tooltip／讀屏：「創作 14:00–16:30・2h30m」（＋待確認／碎塊） */
    blockTip: (name: string, from: string, to: string, dur: string, pending: boolean, tiny: boolean) =>
      `${name} ${from}–${to}・${dur}${pending ? "・待確認" : ""}${tiny ? "・碎塊（不進統計）" : ""}`,
    gapTip: (from: string, to: string, dur: string) => `未記錄 ${from}–${to}・${dur}　點了補記`,
    foot: (desktop: boolean) => `點塊＝跳到那天的軸、打開那塊；點空白＝補記那段${desktop ? "；← → 換週、T 回本週" : ""}`,
  },
  /** ③ 同步清單的時刻表三張表（丙席；契約 0-13、D-時-58；`lines/timetableSyncLabel.ts` 讀） */
  syncRunningFrom: "起",
  syncCatLabel: (name: string) => `分類『${name}』`,
  syncGoalLabel: (name: string) => `目標『${name}』`,
  syncCatGone: "已刪除的分類",
  syncNodeGone: "一張車票",
  syncRouteGone: "一條路線",
  syncTopLevel: "（頂層）",
  syncNoEstimate: "沒預估",
  syncNoDefault: "沒預設",
  syncNoScope: "（沒有分類）",
  syncRunning: "運行中",
  syncAck: "已確認",
  syncPending: "待確認",
  syncArchived: "已封存",
  syncNotArchived: "沒封存",
  syncCols: {
    time_blocks: {
      started_at: "開始時刻",
      ended_at: "結束時刻",
      category_id: "分類",
      node_id: "連結",
      route_id: "連結",
      estimate_min: "預估",
      long_run_ack: "確認",
    },
    time_categories: { name: "名字", parent_id: "分組", color_idx: "顏色", default_min: "預設長度", archived_at: "封存" },
    time_goals: {
      name: "名字",
      scope: "分類",
      period: "期間",
      target_min: "目標時數",
      direction: "方向",
      start_on: "起點",
      end_on: "終點",
      archived_at: "封存",
    },
  } as { time_blocks: Readonly<Record<string, string>>; time_categories: Readonly<Record<string, string>>; time_goals: Readonly<Record<string, string>> },
  /** 期間字、方向字（目標卡與目標面板共用） */
  goalPeriodWord: { day: "每日", week: "每週", month: "每月", since: "從某天起", until: "到某天為止", range: "單一區間" } as Readonly<Record<GoalPeriod, string>>,
  goalDirectionWord: { atLeast: "至少", atMost: "至多" } as Readonly<Record<GoalDirection, string>>,
  /** 期間分段鈕 */
  periodWord: { day: "日", week: "週", month: "月" } as Readonly<Record<StatsPeriod, string>>,
  /** ③ 統計頁、目標面板、待確認清單的畫面字（乙席；契約 §5.2–5.4 與〈原型定案〉；顯示端不手抄） */
  statsUi: {
    weekdays: "日一二三四五六",
    tagToday: "今天",
    tagYesterday: "昨天",
    tagThisWeek: "本週",
    tagLastWeek: "上週",
    tagThisMonth: "本月",
    tagLastMonth: "上個月",
    monthName: (y: number, m: number) => `${y} 年 ${m} 月`,
    monthShort: (m: number) => `${m} 月`,
    periodGroup: "期間",
    prevPeriod: "上一期",
    nextPeriod: "下一期",
    keysHint: "← → 換期",
    pendingCount: (n: number) => `待確認 ${n} 班`,
    pendingTip: "點開：逐塊看、修好就回到分類",
    pendingNone: "沒有跑太久沒確認的塊",
    cmpRecorded: "已記錄",
    cmpWhole: (name: string) => `上一期：${name}`,
    /** 環比的滑過／點開說明（〈原型定案〉1：「多 3h10m（上期 18h）」） */
    deltaTip: (ms: number, prevMs: number) =>
      Math.abs(ms) < MIN ? `一樣（上期 ${fmtDur(prevMs)}）` : `${ms > 0 ? "多" : "少"} ${fmtDur(Math.abs(ms))}（上期 ${fmtDur(prevMs)}）`,
    shareTitle: "占比與環比",
    shareNote: (cmp: string) => `分母＝已記錄・環比＝${cmp}`,
    shareFoot: "點名稱＝趨勢只看那一類（再點取消）；點 › 看子分類",
    expandKids: "展開子分類",
    collapseKids: "收起子分類",
    filterOn: "趨勢只看這一類",
    filterOff: "再點一次取消",
    trendTitle: "趨勢",
    trendNote: (p: StatsPeriod) => (p === "day" ? "近 14 天" : p === "week" ? "近 8 週" : "近 6 個月"),
    filterChip: (name: string) => `只看「${name}」`,
    filterClear: "取消過濾",
    toNow: "到現在",
    goalsTitle: "時數目標",
    goalsNone: "還沒有目標。「＋目標」可以設「每週至少 10h 創作」這種。",
    goalsMore: (upcoming: number, ended: number) =>
      `另有 ${[upcoming ? `${upcoming} 個未開始` : "", ended ? `${ended} 個已結束` : ""].filter(Boolean).join("、")}`,
    goalsLess: "收起來",
    goalEdit: "改這個目標",
    goalTarget: (dir: string, t: string) => `${dir} ${t}`,
    goalRepeat: (word: string, target: string) => `${word}${target}`,
    goalSince: (md: string, target: string) => `自 ${md} 起${target}`,
    goalUntil: (md: string, target: string) => `到 ${md} 為止${target}`,
    goalRange: (a: string, b: string, target: string) => `${a}–${b} ${target}`,
    scopeMore: (names: string, n: number) => `${names}…等 ${n} 類`,
    scopeNow: { day: "今天", week: "本週", month: "本月" } as Readonly<Record<StatsPeriod, string>>,
    scopePrev: { day: "昨天", week: "上週", month: "上個月" } as Readonly<Record<StatsPeriod, string>>,
    scopeToNow: "到現在",
    scopeLast: "最後",
    scopeNotYet: "還沒開始",
    prevLine: (label: string, dur: string, verdict: string) => `${label}：${dur}　${verdict}`,
    pendingLook: "看看 ›",
    /** 已結束、至多、超過的章（D-時-60／67；進行中的超過寫 goalOver 全句） */
    stampOver: "超過",
    catGone: "已刪除的分類",
    routesTitle: "依路線",
    routesNote: "分母＝已記錄",
    routeDeleted: (name: string) => `${name}（已刪除）`,
    loading: "算一下…",
    loadFailed: (msg: string) => `統計讀不出來：${msg}`,
    pendingSub: "跑太久、還沒確認的塊整塊另列，不算進任何分類，也不算進目標。修好（其實到幾點）或按「沒錯」就回到分類。",
    pendingGoalSub: (name: string) => `只列「${name}」範圍內的。`,
    pendingRowSub: (clock: string, dur: string, running: boolean) => `${clock} 起・跑了 ${dur}${running ? "（還在跑）" : ""}`,
    pendingEmpty: "沒有待確認的了",
    goalNewTitle: "新目標",
    goalEditTitle: "改目標",
    fName: "名字",
    fCats: "分類",
    fPeriod: "期間",
    fDir: "方向",
    fHours: "時數",
    fStart: "起點",
    fEnd: "截止",
    fRange: "起訖",
    namePlaceholder: "例：夜行列車",
    groupWhole: "整組（含之後新增的）",
    groupPicked: (n: number) => `勾了 ${n} 個`,
    kindRepeat: "週期重複",
    hintSince: "從這天的日界線開始累計、沒有終點",
    hintUntil: "那天整天都算",
    hintStartDefault: "預設＝今天",
    startLink: (md: string) => `從 ${md} 起算・改起點`,
    minutes: (m: number) => `${m} 分`,
    hourUnit: "h",
    hoursDown: (n: number) => `少 ${n} 小時`,
    hoursUp: (n: number) => `多 ${n} 小時`,
    noName: "取個名字",
    noCat: "勾至少一個分類",
    noHours: "時數要大於 0",
    noEndUntil: "選截止日",
    noEndRange: "選結束那天",
    noStart: "選起點",
    endBeforeUntil: "截止日不能早於起點",
    endBeforeRange: "結束不能早於開始",
    save: "儲存",
    archive: "封存",
    remove: "刪除",
    archivedList: (n: number) => `已封存的目標（${n}）`,
    restore: "叫回",
    goalGone: "這個目標已經不在了",
    close: "關閉",
  },
} as const;

export interface TimetableStore {
  ready: boolean;
  loading: boolean;
  /** 只給「載入失敗」用（寫入失敗一律 toast，不釘紅字） */
  error: string | null;
  categories: TimeCategoryRow[];
  catById: Record<string, TimeCategoryRow>;
  /** 畫面上的「運行中那一班」＝currentRunning(listRunning)；同步後暫時兩筆時取開始較晚者（整理會收掉另一筆） */
  running: TimeBlockRow | null;
  /** 軸在看哪一個日界線日 */
  dayKey: string;
  dayBlocks: TimeBlockRow[];
  /** 今天（發車台合計、本週合計的「今天」那段）；dayKey＝今天時與 dayBlocks 相同 */
  todayKey: string;
  todayBlocks: TimeBlockRow[];
  /** 本週（週一的日界線起）到現在 */
  weekBlocks: TimeBlockRow[];
  longRunMaxMin: number;
  view: TimetableView;
  noticeEnabled: boolean;
  sheet: TimetableSheet | null;
  /**
   * ③ 評審 #1：開著的 sheet 帶 blockId（longRun／restart／edit／split／estimate／link）而那一塊不在 running／dayBlocks／todayBlocks／weekBlocks
   * （例：統計頁待確認清單點到 9 天前那塊）⇒ `openSheet` 先 `getBlock` 把它帶進來放這裡，寫入後（rev 變）`refresh` 再抓一次。
   * 面板／標題先查既有清單、找不到再看它（`useBlock`、`sheetTitle`）；sheet 關了＝null。
   */
  sheetBlock: TimeBlockRow | null;
  /** 「其實到幾點」被略過的那一班（契約 0-10）；回前景／換車／到站時清掉 */
  dismissedLongRunId: string | null;
  /** 回前景時不在時刻表頁 ⇒ 記下，進頁才問 */
  pendingAsk: boolean;
  /** ①c 用（①b 時休眠）：跑太久提醒開關（KEY_NOTICE_LONG_RUN，本地） */
  noticeLongRunEnabled: boolean;
  /** ①c 用：常用分類格開關（KEY_NOTICE_TILES，本地） */
  noticeTilesEnabled: boolean;
  /** ①c 用：釘選分類（KEY_NOTICE_PINS，本地；≤ NOTICE_PINS_MAX） */
  noticePins: string[];
  /** 最近 30 天用過的分類 id（refresh 時讀；給 ①c 的 noticeTiles），依最後一次開始遞減、最多 12 個 */
  recentCategoryIds: string[];
  /** ②：連到的節點／路線資訊（② 契約 0-16）；key＝節點 id 或路線 id */
  linkInfo: Record<string, LinkInfo>;
  /** ②：每次 refresh 成功 +1（側板「時間」據此重查） */
  rev: number;

  /* 載入 */
  /** 冪等；第一次：讀設定 → 起手分類（§3.7.1）→ reconcile 一次 → refresh */
  init(shell: TimetableShell): Promise<void>;
  /** 重讀分類＋運行中＋三段時間塊（today 依 uiStore.dayStartHour 重算） */
  refresh(): Promise<void>;
  setDayKey(key: string): Promise<void>;
  /** mount 檔指到這裡（§3.8） */
  reload(ctx: LineReloadContext): Promise<void>;

  /* 視圖與設定 */
  setView(v: TimetableView): void; // 寫 KEY_VIEW（本地）；切到任何視圖都順手 ensureFreshDay（③ 0-7）
  /**
   * ③ 接縫 #72：`todayKey(dayStartHour, 現在) !== state.todayKey` ⇒ `refresh()`；否則什麼都不做。
   * 呼叫點：頁面每次掛上（桌機 TimetableView、手機 MobileTimetable）、`setView`；回前景原有的 refresh 照舊。
   */
  ensureFreshDay(): Promise<void>;
  /** V 鍵與頂端切換鈕：兩欄（發車台）⇄只看軸；在週／統計按 V 回兩欄（發車台）（D-時-57） */
  toggleView(shell: TimetableShell): void;
  setLongRunMax(min: number): Promise<void>; // settingsRepo.set(KEY_LONG_RUN_MAX)（會同步）
  setNoticeEnabled(on: boolean): Promise<void>;
  setNoticeLongRunEnabled(on: boolean): Promise<void>;
  setNoticeTilesEnabled(on: boolean): Promise<void>;
  /** 去重、只留存在的子分類、截前 NOTICE_PINS_MAX；寫 KEY_NOTICE_PINS */
  setNoticePins(ids: readonly string[]): Promise<void>;

  /* 流程（UI 只叫這些） */
  /** N／換車／発車：運行中那班長時間運行 ⇒ sheet=longRun(then:"depart")；否則 sheet=depart */
  requestDepart(): void;
  /** Enter／到着：沒有運行中 ⇒ 不動；長時間運行 ⇒ longRun(then:"arrive")；否則 arrive() */
  requestArrive(): void;
  /** 發車台點分類：同分類正在跑 ⇒ toast 12；長時間運行 ⇒ longRun(then:{tile})；否則 depart(categoryId, now) */
  tapCategory(categoryId: string): void;
  /** 契約 0-10 的規則 */
  autoAsk(where: "foreground" | "enter", onPage: boolean): void;
  openSheet(s: TimetableSheet): void;
  /** 關的是 longRun ⇒ dismissedLongRunId = 該 id（＝略過） */
  closeSheet(): void;
  /** ①b F 鍵：看的那一天最晚的一段未記錄 ⇒ openSheet fill；沒有 ⇒ toast B13 */
  requestFillLatestGap(): void;

  /* 寫入（面板確認時叫；成功 ⇒ refresh＋toast；失敗 ⇒ toast 15；全部經 serial 佇列） */
  /** ①b：第三參數＝這一班的預估（分；舊呼叫照舊成立）。②：第四參數＝新一班的連結 */
  depart(categoryId: string, at: number, estimateMin?: number | null, link?: BlockLink | null): Promise<void>;
  arrive(at?: number): Promise<void>;
  restart(blockId: string, at: number): Promise<void>;
  /** ②：第四參數＝新一塊的連結 */
  fill(categoryId: string, start: number, end: number, link?: BlockLink | null): Promise<void>;
  /** ②：link undefined＝不動連結 */
  editBlock(blockId: string, categoryId: string, start: number, end: number, link?: BlockLink | null): Promise<void>;
  split(blockId: string, at: number, categoryId2: string): Promise<void>;
  resolveLongRun(blockId: string, end: number, choice: LongRunChoice, categoryId2?: string): Promise<void>;
  deleteBlock(blockId: string): Promise<void>;
  previewCover(start: number, end: number | null, exceptId: string | null): Promise<CoverSummary>;
  /** ①b：運行中那班的預估（null＝清掉）；toast B4／B5 */
  setEstimate(blockId: string, estimateMin: number | null): Promise<void>;
  /** ①b：多切點；toast B3 */
  splitMulti(blockId: string, cuts: readonly number[], categoryIds: readonly string[]): Promise<void>;
  /** ①b：合併預演（不寫、不經 serial；bound＝畫面上那一側的界線，毫秒） */
  previewMerge(blockId: string, dir: "prev" | "next", bound: number): Promise<MergePreview | null>;
  /** ①b：合併；toast B1 */
  mergeBlock(blockId: string, dir: "prev" | "next", bound: number): Promise<void>;

  /* 分類 */
  createCategory(input: { parentId: string | null; name: string; colorIdx: number; defaultMin: number | null }): Promise<void>;
  updateCategory(id: string, patch: { name?: string; colorIdx?: number; defaultMin?: number | null }): Promise<void>;
  moveCategory(id: string, delta: 1 | -1): Promise<void>;
  /** ①b：封存（toast B6 帶「撤回」）／還原（B7） */
  archiveCategory(id: string, archived: boolean): Promise<void>;
  /** ①b：搬到另一個頂層組；toast B8 */
  moveCategoryToGroup(id: string, parentId: string): Promise<void>;
  /** ①b：換圓牌字；toast B9 */
  setCategoryGlyph(id: string, glyph: string): Promise<void>;

  /* ③ 時數目標（③ 契約 §3.3）：走 write()（serial → refresh → toast）；回 true＝寫成功（面板據此關），失敗已 toast */
  createGoal(input: GoalInput): Promise<boolean>;
  updateGoal(id: string, patch: Partial<GoalInput>): Promise<boolean>;
  /** 封存（toast 帶「撤回」）／叫回 */
  archiveGoal(id: string, on: boolean): Promise<boolean>;
  /** 軟刪除（toast 帶「撤回」＝restoreGoal） */
  deleteGoal(id: string): Promise<boolean>;
  restoreGoal(id: string): Promise<boolean>;

  /* ②（② 契約 §3.7） */
  /** 從任務發車（§5.2 的流程）：面板開著就不動；找不到／已刪／不能連 ⇒ TASK_MISSING；正在跑 ⇒ ALREADY_RUNNING_TASK；
   *  記得上次的分類 ⇒ departWithLink；否則開 taskCategory 面板 */
  departFromTask(nodeId: string): Promise<void>;
  /** 分類選擇面板選好之後（或其他已知分類的入口）真的發車；長時間運行待確認 ⇒ 先問「其實到幾點」 */
  departWithLink(categoryId: string, link: BlockLink, opts?: { estimateMin?: number | null; at?: number }): Promise<void>;
  /** 改一塊的連結；toast LINKED／UNLINKED */
  setLink(blockId: string, link: BlockLink | null): Promise<void>;
  /** 只重讀 linkInfo（taskWatch 叫；不經 serial、不 toast；帶序號，比後來開始的 refresh 舊的結果丟掉） */
  refreshLinks(): Promise<void>;
  /** 側板「時間」用的讀取（不寫狀態、不經 serial） */
  linkedBlocks(q: { nodeIds: readonly string[] } | { routeId: string }): Promise<TimeBlockRow[]>;
  /** 「記住上次的分類」的讀取（不寫狀態、不經 serial；直接轉 repository 的 lastCategoryFor，跟 departFromTask 用同一份）。
   *  nodeId null＝只連路線 ⇒ 只查路線段 */
  lastCategoryFor(nodeId: string | null, routeId: string | null): Promise<{ categoryId: string; from: "node" | "route" } | null>;
  /** 子樹（② 契約 0-5）：在 nodeStore.tree 就從樹取，否則 nodeRepo.listRouteTree 建臨時樹；回含自己的節點列 */
  subtreeNodes(node: NodeRow): Promise<NodeRow[]>;
  /** 路線樹的節點（② 契約 0-5、0-6）：不含路線自己；nodeStore.routeId === routeId 就從樹取，否則 nodeRepo.listRouteTree */
  routeNodes(routeId: string): Promise<NodeRow[]>;
}

/* ───────── 模組層狀態 ───────── */

/** serial 佇列：寫入與 reconcile 不交錯 */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

let initPromise: Promise<void> | null = null;
let initShell: TimetableShell = "desktop";
let enteredOnce = false;
/** `reload({wiped:true})` 觸發的重 init：這一趟剛拉完（而且是在 syncStore 那趟 `working:true` 裡被 await 的），
 *  起手分類的閘門沒有東西可等 ⇒ 跳過，不然必定等滿 10 秒才種分類、頁面 loading 10 秒 */
let skipSettleGateOnce = false;
/** ②：linkInfo 的序號（② 契約 §3.7-1）：refresh／refreshLinks 開始讀時 +1；refreshLinks 讀完發現被超車就丟掉 */
let linkSeq = 0;
/** ②：從任務發車進行中（重複點擊／鍵 n 連按時不再發一次；② 契約 0-9 的「再發一次」護欄之外多一道） */
let taskDepartBusy = false;
/** ③ 評審 #1：`openSheet` 非同步帶 `sheetBlock` 的序號——後來的 openSheet 蓋掉前一個還沒讀完的 */
let sheetSeq = 0;

/** ②：節點列 → linkInfo 的一格（路線那格 routeId＝自己、code 取 node.code） */
function linkInfoOf(n: NodeRow): LinkInfo {
  const isRoute = n.kind === "route";
  return {
    id: n.id,
    kind: n.kind,
    kindLabel: KIND_LABEL[n.kind] ?? n.kind,
    name: n.name,
    routeId: isRoute ? n.id : n.route_id,
    estimateMin: n.estimate_min,
    code: isRoute ? n.code : null,
    deleted: n.deleted_at !== null,
    missing: false,
  };
}

function missingInfo(id: string): LinkInfo {
  return { id, kind: "", kindLabel: "", name: "", routeId: null, estimateMin: null, code: null, deleted: false, missing: true };
}

/**
 * ② 契約 §3.7-1：逐一 `nodeRepo.getNode`（含已刪除）。**照抄這一行的寫法**——不可寫成 `ids.map(nodeRepo.getNode)`
 * （方法拆離物件後 this 是 undefined，mock 會每格都丟錯）。回 null 或讀失敗 ⇒ 那格 missing，不讓整個 refresh 失敗。
 */
async function loadLinkInfo(ids: readonly string[]): Promise<Record<string, LinkInfo>> {
  const nodes = await Promise.all(ids.map((id) => nodeRepo.getNode(id).catch(() => null)));
  const out: Record<string, LinkInfo> = {};
  ids.forEach((id, i) => {
    const n = nodes[i];
    out[id] = n ? linkInfoOf(n) : missingInfo(id);
  });
  return out;
}

/** ②：要載 linkInfo 的 id（去重）：運行中、看的那天、今天的塊的 node_id／route_id，加開著的 taskCategory 面板的節點 */
function linkIdsOf(rowsList: readonly (readonly TimeBlockRow[])[], sheet: TimetableSheet | null, sheetBlock: TimeBlockRow | null = null): string[] {
  const set = new Set<string>();
  for (const rows of rowsList) {
    for (const r of rows) {
      if (r.node_id !== null) set.add(r.node_id);
      if (r.route_id !== null) set.add(r.route_id);
    }
  }
  if (sheet?.kind === "taskCategory") set.add(sheet.nodeId);
  if (sheetBlock !== null) {
    if (sheetBlock.node_id !== null) set.add(sheetBlock.node_id);
    if (sheetBlock.route_id !== null) set.add(sheetBlock.route_id);
  }
  return Array.from(set);
}

/** ②：從樹上取含自己的子樹（只含樹裡的活節點） */
function walkTree(tree: TreeIndex, root: NodeRow): NodeRow[] {
  const out: NodeRow[] = [root];
  const stack = [...(tree.childrenOf[root.id] ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    const n = tree.byId[id];
    if (!n) continue;
    out.push(n);
    stack.push(...(tree.childrenOf[id] ?? []));
  }
  return out;
}

const toast =(message: string, actionLabel?: string, onAction?: () => void): void =>
  useUiStore.getState().showToast(actionLabel ? { message, actionLabel, onAction } : { message });

function failToast(e: unknown): void {
  toast(e instanceof RangeError ? e.message : TT_TEXT.saveFailed);
}

function normalizeView(raw: string | null, shell: TimetableShell): TimetableView {
  if (raw === "week" || raw === "stats") return raw; // ③：兩殼都有（D-時-46）
  if (shell === "mobile") return raw === "axis" ? "axis" : "board";
  return raw === "axis" ? "axis" : "split";
}

function parseLongRunMax(raw: string | null): number {
  if (raw === null || raw === "") return LONG_RUN_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : LONG_RUN_MAX_DEFAULT;
}

/** KEY_NOTICE_PINS：解析失敗＝[]；只留字串、去重、截前 NOTICE_PINS_MAX（①b①c 契約 §3.6） */
function parsePins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) if (typeof x === "string" && !out.includes(x)) out.push(x);
    return out.slice(0, NOTICE_PINS_MAX);
  } catch {
    return [];
  }
}

/**
 * 起手分類的閘門（契約 §3.7.1、0-3 的緩解）：已加入同步、開著、在線 ⇒ 先等一趟拉下來（最多 ms），
 * 讓別台已種、已改過名的起手分類先到，這台才不會用預設值蓋掉它。
 */
function waitForSyncSettle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const s0 = useSyncStore.getState();
    const lastAt0 = s0.status?.last_sync_at ?? null;
    let sawWorking = s0.working;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const unsub = useSyncStore.subscribe((s) => {
      // boot 回來了、但這台沒加入或開關關著 ⇒ 不必等
      if (s.status && !(s.status.joined && s.status.enabled)) finish();
      if (s.status && (s.status.last_sync_at ?? null) !== lastAt0) finish();
      if (s.working) sawWorking = true;
      else if (sawWorking) finish();
    });
  });
}

/**
 * ①c 用（佇列套用前先等同步一趟，①b①c 契約 §3.9）：＝`waitForSyncSettle`，另加三種立即 resolve——
 * mock、離線、boot 已回來但這台沒加入或開關關著（`waitForSyncSettle` 本身只在 store 有變化時才判斷這一條）。
 */
export function waitForTimetableSyncSettle(ms: number): Promise<void> {
  if (MOCK_MODE) return Promise.resolve();
  if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve();
  const st = useSyncStore.getState().status;
  if (st && !(st.joined && st.enabled)) return Promise.resolve();
  return waitForSyncSettle(ms);
}

/**
 * 沙盒回報 F3（③ 契約 §9-2）：同步清單解名字前先等「同步這一趟收完（含 reload／reconcile）＋serial 佇列清空」。
 * 給 `timetable.mount.tsx` 的 `syncRowLabel` 用；等待邏輯在純函式 `domain/timetableIdle.ts`（為什麼要等寫在那裡）。
 * mock 沒有同步 ⇒ `working` 恆 false，只剩等佇列。
 */
export function whenTimetableIdle(): Promise<void> {
  return waitTimetableIdle({
    syncWorking: () => useSyncStore.getState().working,
    onSyncChange: (cb) => useSyncStore.subscribe((s, p) => (s.working !== p.working ? cb() : undefined)),
    chainTail: () => chain,
  });
}

export const useTimetableStore = create<TimetableStore>((set, get) => {
  async function readLongRunMax(): Promise<void> {
    set({ longRunMaxMin: parseLongRunMax(await settingsRepo.get(KEY_LONG_RUN_MAX)) });
  }

  async function firstInit(shell: TimetableShell): Promise<void> {
    set({ loading: true, error: null });
    try {
      const [view, notice, longRun, tiles, pins] = await Promise.all([
        settingsRepo.get(KEY_VIEW),
        settingsRepo.get(KEY_NOTICE),
        settingsRepo.get(KEY_NOTICE_LONG_RUN),
        settingsRepo.get(KEY_NOTICE_TILES),
        settingsRepo.get(KEY_NOTICE_PINS),
      ]);
      await readLongRunMax();
      set({
        view: normalizeView(view, shell),
        noticeEnabled: notice !== "0",
        noticeLongRunEnabled: longRun !== "0",
        noticeTilesEnabled: tiles !== "0",
        noticePins: parsePins(pins),
      });

      const skipGate = skipSettleGateOnce;
      skipSettleGateOnce = false;
      if ((await timetableRepo.countCategoriesIncludingDeleted()) === 0) {
        const st = useSyncStore.getState();
        const online = typeof navigator === "undefined" || navigator.onLine !== false;
        if (!skipGate && !MOCK_MODE && online && (st.status === null || (st.status.joined && st.status.enabled))) {
          await waitForSyncSettle(10_000);
        }
        await timetableRepo.ensureStarterCategories();
      }
      await serial(() => timetableRepo.reconcile());
      await get().refresh();
      set({ ready: true });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      set({ loading: false });
    }
  }

  /** 長時間運行的判斷（運行中那班 × 門檻：這一班的預估 → 分類預設長度 → 全域上限；〈開工決定〉二-4） */
  function longRunNow(): TimeBlockRow | null {
    const { running, catById, longRunMaxMin, linkInfo } = get();
    if (!running) return null;
    return blockIsLongRun(running, catById, longRunMaxMin, Date.now(), linkInfo) ? running : null;
  }

  const catName = (id: string): string => get().catById[id]?.name ?? "？";

  /** 寫入共用殼：serial → refresh → 成功回呼；失敗 toast 15 */
  async function write<T>(fn: () => Promise<T>, after?: (r: T) => void): Promise<void> {
    try {
      const r = await serial(fn);
      await get().refresh();
      after?.(r);
    } catch (e) {
      failToast(e);
    }
  }

  /** longRun 面板確認後依 `then` 接續 */
  function continueAfterLongRun(then: Extract<TimetableSheet, { kind: "longRun" }>["then"]): void {
    if (then === null) return;
    if (then === "depart") {
      setTimeout(() => get().openSheet({ kind: "depart" }), 300);
    } else if (then === "arrive") {
      if (get().running) void get().arrive();
    } else {
      void get().depart(then.tile, Date.now(), null, then.link ?? null);
    }
  }

  return {
    ready: false,
    loading: false,
    error: null,
    categories: [],
    catById: {},
    running: null,
    dayKey: todayKey(useUiStore.getState().dayStartHour),
    dayBlocks: [],
    todayKey: todayKey(useUiStore.getState().dayStartHour),
    todayBlocks: [],
    weekBlocks: [],
    longRunMaxMin: LONG_RUN_MAX_DEFAULT,
    view: "split",
    noticeEnabled: true,
    sheet: null,
    sheetBlock: null,
    dismissedLongRunId: null,
    pendingAsk: false,
    noticeLongRunEnabled: true,
    noticeTilesEnabled: true,
    noticePins: [],
    recentCategoryIds: [],
    linkInfo: {},
    rev: 0,

    /* ───────── 載入 ───────── */

    init(shell) {
      initShell = shell;
      if (!initPromise) {
        initPromise = firstInit(shell).catch((e) => {
          initPromise = null; // 失敗可重試
          throw e;
        });
      }
      return initPromise;
    },

    async refresh() {
      try {
        const dayStartHour = useUiStore.getState().dayStartHour;
        const newToday = todayKey(dayStartHour);
        const prev = get();
        // 主人停在今天就一直是今天（換日跟著換）
        const dayKey = prev.dayKey === prev.todayKey && newToday !== prev.todayKey ? newToday : prev.dayKey;
        const dw = dayWindow(dayKey, dayStartHour);
        const tw = dayWindow(newToday, dayStartHour);
        const ww = dayWindow(weekStartKey(newToday, useUiStore.getState().weekStart), dayStartHour); // ③：週起點跟全 App 的 week_start（D-時-48）
        const [categories, runningRows, dayBlocks, todayBlocks, weekBlocks, recentCategoryIds] = await Promise.all([
          timetableRepo.listCategories(),
          timetableRepo.listRunning(),
          timetableRepo.listBlocks(dw.start, dw.end),
          dayKey === newToday ? null : timetableRepo.listBlocks(tw.start, tw.end),
          timetableRepo.listBlocks(ww.start, tw.end),
          timetableRepo.listRecentCategoryIds(isoOf(Date.now() - 30 * 24 * 60 * MIN), 12),
        ]);
        const catById: Record<string, TimeCategoryRow> = {};
        for (const c of categories) catById[c.id] = c;
        const cur = currentRunning(runningRows.map(toSpan));
        // ③ 評審 #1：開著的 sheet 那一塊不在這幾段裡 ⇒ 重抓一次（寫入後它的內容變了；抓不到＝已被整理掉，面板顯示「不在了」）
        const runningRow = cur ? (runningRows.find((r) => r.id === cur.id) ?? null) : null;
        const sheetId = sheetBlockIdOf(get().sheet);
        let sheetBlock: TimeBlockRow | null = null;
        if (sheetId !== null && !findBlockIn(sheetId, runningRow, [dayBlocks, todayBlocks ?? [], weekBlocks])) {
          sheetBlock = await timetableRepo.getBlock(sheetId).catch(() => null);
        }
        // ②：連到的節點資訊（跟時間塊同一次 set；序號讓晚回來的 refreshLinks 丟掉舊結果）
        ++linkSeq;
        const linkInfo = await loadLinkInfo(linkIdsOf([runningRows, dayBlocks, todayBlocks ?? []], get().sheet, sheetBlock));
        // 讀的期間 departFromTask 開了 taskCategory 面板（開工時 sheet 還是 null、沒算到那個節點）⇒ 保留它塞進去的那一格
        const sh = get().sheet;
        if (sh?.kind === "taskCategory" && !(sh.nodeId in linkInfo)) {
          const keep = get().linkInfo[sh.nodeId];
          if (keep) linkInfo[sh.nodeId] = keep;
        }
        set({
          categories,
          catById,
          running: runningRow,
          dayKey,
          dayBlocks,
          todayKey: newToday,
          todayBlocks: todayBlocks ?? dayBlocks,
          weekBlocks,
          // 讀的期間 sheet 換了／關了 ⇒ 不蓋；沒換 ⇒ 用剛抓的（找得到清單裡有的就清成 null）
          sheetBlock: sheetBlockIdOf(get().sheet) === sheetId ? sheetBlock : get().sheetBlock,
          recentCategoryIds,
          linkInfo,
          rev: get().rev + 1,
          error: null,
        });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    async setDayKey(key) {
      set({ dayKey: key });
      await get().refresh();
    },

    async reload(ctx) {
      notePulled(ctx.changed); // ②：蓋済偵測分辨「同步拉下來的」（② 契約 §3.8、0-8）
      if (ctx.wiped) set({ sheet: null, sheetBlock: null, dismissedLongRunId: null, pendingAsk: false, ready: false });
      const touched =
        ctx.wiped || ctx.changed.includes("time_blocks") || ctx.changed.includes("time_categories") || ctx.changed.includes("time_goals"); // ③：目標變了也要 refresh（rev 變 ⇒ 統計重載）
      if (ctx.changed.includes("settings")) await readLongRunMax(); // 全域保險上限可能被別台改了
      if (ctx.wiped) {
        initPromise = null; // 整批換掉：重走 init（表可能是空的 ⇒ 重種起手分類）
        skipSettleGateOnce = true; // 這一趟剛拉完，閘門沒有東西可等
        await get().init(ctx.shell);
        return;
      }
      if (ctx.changed.includes("time_blocks")) await serial(() => timetableRepo.reconcile());
      if (touched || ctx.changed.includes("settings")) await get().refresh();
    },

    /* ───────── 視圖與設定 ───────── */

    setView(v) {
      set({ view: v });
      void settingsRepo.set(KEY_VIEW, v).catch(() => undefined);
      void get().ensureFreshDay(); // ③ #72：切到任何視圖都檢查換日
    },

    async ensureFreshDay() {
      if (todayKey(useUiStore.getState().dayStartHour, new Date()) !== get().todayKey) await get().refresh();
    },

    toggleView(shell) {
      const cur = get().view;
      const home: TimetableView = shell === "mobile" ? "board" : "split";
      const next: TimetableView = cur === "axis" ? home : cur === "week" || cur === "stats" ? home : "axis";
      get().setView(next);
    },

    async setLongRunMax(min) {
      const v = Math.max(0, Math.round(min));
      set({ longRunMaxMin: v });
      try {
        await settingsRepo.set(KEY_LONG_RUN_MAX, String(v));
      } catch (e) {
        failToast(e);
      }
    },

    async setNoticeEnabled(on) {
      set({ noticeEnabled: on });
      try {
        await settingsRepo.set(KEY_NOTICE, on ? "1" : "0");
      } catch (e) {
        failToast(e);
      }
    },

    async setNoticeLongRunEnabled(on) {
      set({ noticeLongRunEnabled: on });
      try {
        await settingsRepo.set(KEY_NOTICE_LONG_RUN, on ? "1" : "0");
      } catch (e) {
        failToast(e);
      }
    },

    async setNoticeTilesEnabled(on) {
      set({ noticeTilesEnabled: on });
      try {
        await settingsRepo.set(KEY_NOTICE_TILES, on ? "1" : "0");
      } catch (e) {
        failToast(e);
      }
    },

    async setNoticePins(ids) {
      const { catById } = get();
      const out: string[] = [];
      for (const id of ids) {
        const c = catById[id];
        if (!c || c.deleted_at !== null || c.parent_id === null || out.includes(id)) continue;
        out.push(id);
        if (out.length >= NOTICE_PINS_MAX) break;
      }
      set({ noticePins: out });
      try {
        await settingsRepo.set(KEY_NOTICE_PINS, JSON.stringify(out));
      } catch (e) {
        failToast(e);
      }
    },

    /* ───────── 流程 ───────── */

    requestDepart() {
      set({ dismissedLongRunId: null });
      const lr = longRunNow();
      if (lr) get().openSheet({ kind: "longRun", blockId: lr.id, then: "depart" });
      else get().openSheet({ kind: "depart" });
    },

    requestArrive() {
      set({ dismissedLongRunId: null });
      if (!get().running) return;
      const lr = longRunNow();
      if (lr) get().openSheet({ kind: "longRun", blockId: lr.id, then: "arrive" });
      else void get().arrive();
    },

    tapCategory(categoryId) {
      set({ dismissedLongRunId: null });
      const { running } = get();
      if (running && running.category_id === categoryId) {
        toast(TT_TEXT.alreadyRunning);
        return;
      }
      const lr = longRunNow();
      if (lr) get().openSheet({ kind: "longRun", blockId: lr.id, then: { tile: categoryId } });
      else void get().depart(categoryId, Date.now());
    },

    autoAsk(where, onPage) {
      if (where === "foreground") set({ dismissedLongRunId: null });
      if (where === "enter") {
        const first = !enteredOnce;
        enteredOnce = true;
        if (!first && !get().pendingAsk) return;
      }
      const lr = longRunNow();
      if (!lr || lr.id === get().dismissedLongRunId || get().sheet !== null) {
        if (onPage) set({ pendingAsk: false });
        return;
      }
      if (!onPage) {
        set({ pendingAsk: true });
        return;
      }
      set({ pendingAsk: false });
      get().openSheet({ kind: "longRun", blockId: lr.id, then: null });
    },

    openSheet(s) {
      const my = ++sheetSeq;
      const id = sheetBlockIdOf(s);
      const st = get();
      // 那一塊就在畫面的清單裡（絕大多數）：同步開
      if (id === null || findBlockIn(id, st.running, [st.dayBlocks, st.todayBlocks, st.weekBlocks])) {
        set({ sheet: s, sheetBlock: null });
        return;
      }
      // 不在（例：統計頁待確認清單點到更早的塊）⇒ 讀到了才開，面板初值才算得出來；讀不到也開（面板顯示「這一班已經不在了」）
      void (async () => {
        let block: TimeBlockRow | null = null;
        let info: Record<string, LinkInfo> = {};
        try {
          block = await timetableRepo.getBlock(id);
          if (block) {
            const want = [block.node_id, block.route_id].filter((x): x is string => x !== null && !(x in get().linkInfo));
            if (want.length) info = await loadLinkInfo(want);
          }
        } catch {
          block = null;
        }
        if (my !== sheetSeq) return; // 中間有別的 openSheet ⇒ 這個作廢
        set({ sheet: s, sheetBlock: block, linkInfo: { ...info, ...get().linkInfo } });
      })();
    },

    closeSheet() {
      ++sheetSeq;
      const s = get().sheet;
      set({ sheet: null, sheetBlock: null, dismissedLongRunId: s?.kind === "longRun" ? s.blockId : get().dismissedLongRunId });
    },

    requestFillLatestGap() {
      const { dayKey, dayBlocks } = get();
      const dw = dayWindow(dayKey, useUiStore.getState().dayStartHour);
      const items = segmentsOfDay(dayBlocks.map(toSpan), { start: msOf(dw.start), end: msOf(dw.end) }, Date.now());
      const g = latestGap(items);
      if (g) get().openSheet({ kind: "fill", start: g.from, end: g.to });
      else toast(TT_TEXT.noGap);
    },

    /* ───────── 寫入 ───────── */

    async depart(categoryId, at, estimateMin, link) {
      const now = Date.now();
      const atMs = Math.min(at, now);
      await write(
        () => timetableRepo.depart(categoryId, isoOf(atMs), { estimateMin: estimateMin ?? null, link: link ?? null }),
        ({ block }) => {
          const start = msOf(block.started_at);
          const name = catName(block.category_id);
          // ②：有連結 ⇒「発車・分類・任務」（refresh 已經載好這一班的 linkInfo）
          const label = linkLabelOf(block, get().linkInfo);
          const text = label !== null ? TT_TEXT.DEPART_TASK(name, label, start) : TT_TEXT.depart(name, start);
          if (now - atMs < MIN) {
            // 出發＝現在：帶「改 10 分前」（該班仍運行中才動）
            toast(text, TT_TEXT.departAction, () => {
              if (get().running?.id === block.id) void get().restart(block.id, start - 10 * MIN);
            });
          } else {
            toast(text);
          }
        },
      );
    },

    async arrive(at) {
      const now = Date.now();
      await write(
        () => timetableRepo.arrive(at === undefined ? undefined : isoOf(Math.min(at, now))),
        (rows) => {
          const r = rows[0];
          if (!r) return;
          const dur = Math.max(0, msOf(r.ended_at ?? r.started_at) - msOf(r.started_at));
          toast(TT_TEXT.arrive(catName(r.category_id), dur), TT_TEXT.undo, () => {
            void (async () => {
              try {
                const ok = await serial(() => timetableRepo.undoArrive(r.id));
                if (!ok) toast(TT_TEXT.undoArriveFailed);
                await get().refresh();
              } catch (e) {
                failToast(e);
              }
            })();
          });
        },
      );
    },

    async restart(blockId, at) {
      const now = Date.now();
      const atMs = Math.min(at, now - MIN);
      await write(
        () => timetableRepo.restart(blockId, isoOf(atMs)),
        () => toast(TT_TEXT.restart(atMs)),
      );
    },

    async fill(categoryId, start, end, link) {
      await write(
        () => timetableRepo.fill(categoryId, isoOf(start), isoOf(end), { link: link ?? null }),
        ({ block }) => toast(TT_TEXT.fill(catName(block.category_id), end - start)),
      );
    },

    async editBlock(blockId, categoryId, start, end, link) {
      await write(
        () => timetableRepo.editBlock(blockId, { categoryId, startIso: isoOf(start), endIso: isoOf(end), link }),
        () => toast(TT_TEXT.edit(catName(categoryId), start, end)),
      );
    },

    async split(blockId, at, categoryId2) {
      await write(
        () => timetableRepo.split(blockId, isoOf(at), categoryId2),
        (r) => {
          if (r) toast(TT_TEXT.split(at));
          else toast("切點要在這一塊的開頭與尾端之間");
        },
      );
    },

    async resolveLongRun(blockId, end, choice, categoryId2) {
      const sheet = get().sheet;
      const then = sheet?.kind === "longRun" && sheet.blockId === blockId ? sheet.then : null;
      const st = get();
      const block = findBlockIn(blockId, st.running, [st.dayBlocks, st.todayBlocks, st.weekBlocks]) ?? (st.sheetBlock?.id === blockId ? st.sheetBlock : null);
      if (choice === "cat" && !categoryId2) {
        toast(TT_TEXT.pickCategory);
        return;
      }
      await write(
        () => timetableRepo.resolveLongRun(blockId, isoOf(end), choice, categoryId2),
        () => {
          ++sheetSeq;
          set({ sheet: null, sheetBlock: null });
          if (choice === "gap" && block) toast(TT_TEXT.longRunGap(catName(block.category_id), end));
          else if (choice === "cat" && categoryId2) toast(TT_TEXT.longRunCat(catName(categoryId2), end));
          continueAfterLongRun(then);
        },
      );
    },

    async deleteBlock(blockId) {
      await write(
        () => timetableRepo.softDelete(blockId),
        () =>
          toast(TT_TEXT.deleted, TT_TEXT.undo, () => {
            void write(() => timetableRepo.restore(blockId));
          }),
      );
    },

    previewCover(start, end, exceptId) {
      return timetableRepo.previewCover(isoOf(start), end === null ? null : isoOf(end), exceptId);
    },

    async setEstimate(blockId, estimateMin) {
      await write(
        () => timetableRepo.setEstimate(blockId, estimateMin),
        () => toast(estimateMin === null ? TT_TEXT.estimateCleared : TT_TEXT.estimateSet(estimateMin)),
      );
    },

    async splitMulti(blockId, cuts, categoryIds) {
      await write(
        () => timetableRepo.splitMulti(blockId, cuts.map(isoOf), categoryIds),
        (rows) => toast(TT_TEXT.splitMulti(rows.length)),
      );
    },

    previewMerge(blockId, dir, bound) {
      return timetableRepo.previewMerge(blockId, dir, isoOf(bound));
    },

    async mergeBlock(blockId, dir, bound) {
      await write(
        () => timetableRepo.merge(blockId, dir, isoOf(bound)),
        (p) => {
          if (p) toast(TT_TEXT.merged(catName(p.categoryId), p.start, p.end));
        },
      );
    },

    /* ───────── 分類 ───────── */

    async createCategory(input) {
      await write(
        () => timetableRepo.createCategory(input),
        (row) => toast(TT_TEXT.categoryCreated(row.name)),
      );
    },

    async updateCategory(id, patch) {
      await write(
        () => timetableRepo.updateCategory(id, patch),
        () => {
          if (patch.name !== undefined) toast(TT_TEXT.categoryRenamed(patch.name.trim()));
        },
      );
    },

    async moveCategory(id, delta) {
      const me = get().catById[id];
      if (!me) return;
      const siblings = get()
        .categories.filter((c) => c.parent_id === me.parent_id && c.archived_at === null)
        .map((c) => c.id);
      const i = siblings.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= siblings.length) return;
      const next = siblings.slice();
      next[i] = siblings[j];
      next[j] = siblings[i];
      await write(() => timetableRepo.reorderCategories(me.parent_id, next));
    },

    async archiveCategory(id, archived) {
      const name = catName(id);
      await write(
        () => timetableRepo.updateCategory(id, { archived }),
        () => {
          if (archived) toast(TT_TEXT.archived(name), TT_TEXT.undo, () => void get().archiveCategory(id, false));
          else toast(TT_TEXT.unarchived(name));
        },
      );
    },

    async moveCategoryToGroup(id, parentId) {
      const name = catName(id);
      await write(
        () => timetableRepo.updateCategory(id, { parentId }),
        () => toast(TT_TEXT.movedToGroup(name, catName(parentId))),
      );
    },

    async setCategoryGlyph(id, glyph) {
      const g = glyph.trim();
      await write(
        () => timetableRepo.updateCategory(id, { glyph: g }),
        () => toast(TT_TEXT.glyphSet(g)),
      );
    },

    /* ───────── ③ 時數目標（③ 契約 §3.3、0-5） ───────── */

    async createGoal(input) {
      let ok = false;
      await write(
        () => timetableRepo.createGoal(input),
        (row) => {
          ok = true;
          toast(TT_TEXT.goalSaved(row.name));
        },
      );
      return ok;
    },

    async updateGoal(id, patch) {
      let ok = false;
      await write(
        async () => {
          await timetableRepo.updateGoal(id, patch);
          return (await timetableRepo.getGoal(id))?.name ?? "";
        },
        (name) => {
          ok = true;
          toast(TT_TEXT.goalSaved(name));
        },
      );
      return ok;
    },

    async archiveGoal(id, on) {
      let ok = false;
      await write(
        async () => {
          await timetableRepo.archiveGoal(id, on);
          return (await timetableRepo.getGoal(id))?.name ?? "";
        },
        (name) => {
          ok = true;
          if (on) toast(TT_TEXT.goalArchived(name), TT_TEXT.undo, () => void get().archiveGoal(id, false));
          else toast(TT_TEXT.goalUnarchived(name));
        },
      );
      return ok;
    },

    async deleteGoal(id) {
      let ok = false;
      await write(
        () => timetableRepo.deleteGoal(id),
        () => {
          ok = true;
          toast(TT_TEXT.goalDeleted, TT_TEXT.undo, () => void get().restoreGoal(id));
        },
      );
      return ok;
    },

    async restoreGoal(id) {
      let ok = false;
      await write(
        () => timetableRepo.restoreGoal(id),
        () => {
          ok = true;
        },
      );
      return ok;
    },

    /* ───────── ②（② 契約 §3.7） ───────── */

    async departFromTask(nodeId) {
      if (get().sheet !== null || taskDepartBusy) return; // 面板開著時鍵 n、重複點擊都不再發一次（0-9）
      taskDepartBusy = true;
      try {
        const node = await nodeRepo.getNode(nodeId).catch(() => null);
        if (!node || node.deleted_at !== null || !LINKABLE_KINDS.includes(node.kind)) {
          toast(TT_TEXT.TASK_MISSING);
          return;
        }
        if (get().running?.node_id === nodeId) {
          toast(TT_TEXT.ALREADY_RUNNING_TASK(node.name));
          return;
        }
        const hit = await timetableRepo.lastCategoryFor(nodeId, node.route_id);
        if (get().sheet !== null) return; // 讀的期間別的面板開了
        if (!hit) {
          // 面板標題要任務名：先放進 linkInfo（refresh 收集 id 時也會把開著的 taskCategory 面板的節點算進去）。
          // ++linkSeq：讓進行中的 refreshLinks（開工時 sheet 還是 null）作廢，不把這一格蓋掉；進行中的 refresh 寫回時自己保留
          ++linkSeq;
          set({ linkInfo: { ...get().linkInfo, [nodeId]: linkInfoOf(node) } });
          get().openSheet({ kind: "taskCategory", nodeId });
          return;
        }
        await get().departWithLink(hit.categoryId, { nodeId, routeId: null });
      } catch (e) {
        failToast(e);
      } finally {
        taskDepartBusy = false;
      }
    },

    async departWithLink(categoryId, link, opts) {
      set({ dismissedLongRunId: null });
      const lr = longRunNow();
      if (lr) {
        get().openSheet({ kind: "longRun", blockId: lr.id, then: { tile: categoryId, link } });
        return;
      }
      await get().depart(categoryId, opts?.at ?? Date.now(), opts?.estimateMin ?? null, link);
    },

    async setLink(blockId, link) {
      await write(
        async () => {
          await timetableRepo.setLink(blockId, link);
          // toast 用的名字：refresh 之後 linkInfo 通常已經有；沒有（這一塊不在畫面的範圍）就自己讀一次
          const id = link ? (link.nodeId ?? link.routeId) : null;
          const n = id ? await nodeRepo.getNode(id).catch(() => null) : null;
          return n ? n.name : null;
        },
        (fetched) => {
          if (!link) {
            toast(TT_TEXT.UNLINKED);
            return;
          }
          const label = linkLabelOf({ node_id: link.nodeId, route_id: link.routeId }, get().linkInfo) ?? fetched ?? "";
          toast(TT_TEXT.LINKED(label));
        },
      );
    },

    async refreshLinks() {
      const my = ++linkSeq;
      const s = get();
      const ids = linkIdsOf([s.running ? [s.running] : [], s.dayBlocks, s.todayBlocks], s.sheet, s.sheetBlock);
      try {
        const linkInfo = await loadLinkInfo(ids);
        if (my !== linkSeq) return; // 中間有別的 refresh／refreshLinks 開始過 ⇒ 這份可能是舊的 id 集合
        set({ linkInfo });
      } catch {
        // 只是顯示資訊，讀不到下次再補
      }
    },

    linkedBlocks(q) {
      return "nodeIds" in q ? timetableRepo.listBlocksByNodes(q.nodeIds) : timetableRepo.listBlocksByRoute(q.routeId);
    },

    lastCategoryFor(nodeId, routeId) {
      return timetableRepo.lastCategoryFor(nodeId, routeId);
    },

    async subtreeNodes(node) {
      const t = useNodeStore.getState().tree;
      const inTree = t.byId[node.id];
      if (inTree) return walkTree(t, inTree);
      if (node.route_id !== null) {
        // 節點不在開著的那條路線（側板從今日頁、行程表、日曆開的）⇒ 讀那一條路線建臨時樹；不改 nodeStore
        const tmp = indexTree(await nodeRepo.listRouteTree(node.route_id), node.route_id);
        const hit = tmp.byId[node.id];
        if (hit) return walkTree(tmp, hit);
      }
      return [node];
    },

    async routeNodes(routeId) {
      const ns = useNodeStore.getState();
      // 路線節點自己不在 tree.byId 裡 ⇒ 判斷要看 ns.routeId
      if (ns.routeId === routeId) return Object.values(ns.tree.byId);
      return nodeRepo.listRouteTree(routeId);
    },
  };
});

/* ───────── 模組層訂閱與匯出 ───────── */

// F1（①b①c 契約 §3.7）：設定裡改「一天的開始時間」⇒ 時刻表當場重讀；refresh() 的「停在今天就跟著換」把 dayKey 帶到新的今天
useUiStore.subscribe((s, p) => {
  if (s.dayStartHour !== p.dayStartHour && useTimetableStore.getState().ready) void useTimetableStore.getState().refresh();
});
// ③（D-時-48）：設定裡改「每週從星期幾開始」⇒ 軸頂的本週合計（weekBlocks）一起改跟設定
useUiStore.subscribe((s, p) => {
  if (s.weekStart !== p.weekStart && useTimetableStore.getState().ready) void useTimetableStore.getState().refresh();
});

/**
 * ①c 用（契約 0-12：佇列套用模組直接叫 repository，但一律包在這裡）：serial＋成功後 refresh；失敗原樣丟出
 * （呼叫端決定要不要 toast）。
 */
export async function timetableWrite<T>(fn: () => Promise<T>): Promise<T> {
  const r = await serial(fn);
  await useTimetableStore.getState().refresh();
  return r;
}

/**
 * 這一班的門檻與長時間運行記號（兩殼、notice、NavBadge 共用）：門檻＝這一班的預估 → 任務的預計時間（②）→ 分類預設長度 → 全域上限。
 * 「待確認」＝`marker.kind !== "none" && marker.pending`（＝blockIsLongRun）。
 */
/** 任務的預計時間只套在運行中那一班：任務預計是會改的計畫資料，套到已結束的塊會讓改一次預計就回頭翻掉歷史的誤點標記（②評審 #4，時刻表線裁定）。 */
function liveTaskEstimate(block: TimeBlockRow, links: Record<string, LinkInfo>): number | null {
  return block.ended_at === null ? taskEstimateOf(block, links) : null;
}
export function blockMarker(
  block: TimeBlockRow,
  catById: Record<string, TimeCategoryRow>,
  globalMaxMin: number,
  now: number,
  links: Record<string, LinkInfo>,
): RunMarker {
  return runMarker(
    toSpan(block),
    thresholdOf(block.estimate_min, catById[block.category_id] ?? null, globalMaxMin, liveTaskEstimate(block, links)),
    now,
  );
}

/**
 * 乙丙席共用：某塊是不是「長時間運行・待確認」（①b：門檻改成 預估 → 分類預設長度 → 全域上限）。
 * ②：門檻多一層任務的預計時間（預估之後、分類之前）⇒ 第五參數 `links`（store 的 linkInfo）必填。
 */
export function blockIsLongRun(
  block: TimeBlockRow,
  catById: Record<string, TimeCategoryRow>,
  globalMaxMin: number,
  now: number,
  links: Record<string, LinkInfo>,
): boolean {
  return isLongRun(
    toSpan(block),
    thresholdOf(block.estimate_min, catById[block.category_id] ?? null, globalMaxMin, liveTaskEstimate(block, links))?.min ?? null,
    now,
  );
}

/** 乙丙席共用：昨天的 dayKey（「昨日 ›」一鍵） */
export function yesterdayKey(dayKey: string): string {
  return addDays(dayKey, -1);
}

/** 目前 init 用的殼（通知／試驗提醒判斷用） */
export function timetableShell(): TimetableShell {
  return initShell;
}
