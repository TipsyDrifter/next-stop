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
 *   磨光② A15：①c 的釘選分類 `timetable_notice_pins` 也改成同步（拉到 settings ⇒ reload 重讀）。
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
 *
 * 車次④（④ 契約 §3.2、0-7、0-8；只加不改）：視圖多 `schedule`（兩殼都有；V 回 home）、面板多 `plan`；`TT_TEXT` 增補（§5.8、§5.6）；
 * `syncCols` 補 #73 R5 三個欄名。日程的資料另開 `timetableScheduleStore`（只讀＋排時刻的寫入，日程頁沒開時不載）。
 *
 * 車次⑤（⑤ 契約 0-5、§3.3；只加不改）：方眼塗色 `paint`（復原走 repository 的 `undoPaint`）；`TT_TEXT` 增補（§5.6）。
 * 選取與格子大小另開 `timetableGridStore`（純 UI 狀態）；`view` 的 `"grid"` 由整合席加。
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
import { PLAN_TEXT } from "../domain/timetableSchedule";
import { paintCoverOf, paintKindOf, paintUndoable } from "../domain/timetableGrid";
import type { FillPiece } from "../domain/timetableFillCont";
import { TT_TAG_BLOCK, TT_TAG_BLOCK_OFF } from "../domain/timetableTags";
import { tagRepo } from "../data/tagRepo";
import { applyBlockTagEdit, blockTagEditOf, checkTagNames, receiptWrote, type BlockTagEdit } from "../data/timetableTagCarry";
import { useTagStore } from "./tagStore";
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
  blockThresholdOf,
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
// ①b①c 契約 0-11：以下本地、不同步（不進 manifest syncSettingsKeys；D-時-30 各台各記）——例外：KEY_NOTICE_PINS 磨光② 起同步（D-主-40）
export const KEY_NOTICE_LONG_RUN = "timetable_notice_long_run"; // 本地："0"＝關；沒有列＝開（跑太久提醒）
export const KEY_NOTICE_TILES = "timetable_notice_tiles"; // 本地："0"＝關；沒有列＝開（常用分類格）
// 磨光② A15（使用者 Q4「搬」）：釘選分類例外——改成同步（manifest syncSettingsKeys＋Rust SETTINGS_KEYS），拉到 settings 時 reload 重讀
export const KEY_NOTICE_PINS = "timetable_notice_pins"; // 同步：JSON string[]（≤5；釘選分類）
export const NOTICE_PINS_MAX = 5;

/** 手機 board|axis|week|stats|schedule|grid；桌機 split|axis|week|stats|schedule|grid（①a 契約 0-6；③ 加 week／stats，D-時-46；④ 加 schedule，D-時-74；⑤ 加 grid，D-時-92） */
export type TimetableView = "board" | "axis" | "split" | "week" | "stats" | "schedule" | "grid";
export type TimetableShell = "desktop" | "mobile";

export type TimetableSheet =
  | { kind: "depart" }
  /** ②：then 的 tile 可以帶連結（從任務發車遇到長時間運行待確認，先問完再發車） */
  | { kind: "longRun"; blockId: string; then: "depart" | "arrive" | { tile: string; link?: BlockLink } | null }
  /**
   * 磨光⑥ §1-4（D-時-145）：cont＝連續補換過來的段（有值＝副標多一行「剩下 X–Y 還沒記」；取消鈕原叫「先這樣」，UI 丙-4 起照規範 §4 叫「取消」）。
   * rest＝同一段未記錄裡往後補時跳過、還沒補的段（往後補完了再回頭補它）；toNow＝這段一路到現在（到着快捷叫「接到現在」）。
   * 選填、只有 BlockPanel 讀
   */
  | { kind: "fill"; start: number; end: number; cont?: { rest: readonly FillPiece[]; toNow: boolean } }
  /**
   * 改一塊（已結束）／改這一班（運行中，磨光⑦ D-時-152：RestartPanel 併進來）。focus "start"＝從「HH:MM 発」或
   * 改出發時間的快捷鍵進來：桌機游標落在発車框、手機把発車列捲進畫面閃一下（不叫鍵盤）
   */
  | { kind: "edit"; blockId: string; focus?: "start" }
  | { kind: "split"; blockId: string }
  /**
   * 磨光③ 2-11：focusId＝打開就展開那一列（分類或組）的 ⋯、捲進畫面閃一下；focus "notice"＝捲到〈通知〉。都不帶＝照舊。
   * UI 丙-4 B1：對話框分成「分類｜通知｜目標」三籤，tab＝開在哪一籤（省略＝分類）。舊的兩種寫法照收：
   * focus "notice"＝tab "notice"、focusId＝tab "cats"（呼叫端不用改）；tab 跟它們打架時以 focus／focusId 為準（定位要找得到列）。
   */
  | { kind: "categories"; focusId?: string; focus?: "notice"; tab?: "cats" | "notice" | "goals" }
  /** ①b：這一班的預估（運行中那班） */
  | { kind: "estimate"; blockId: string }
  /** ②：從任務發車、第一次碰到的路線（☎一-1） */
  | { kind: "taskCategory"; nodeId: string }
  /** ②：改一塊的連結（運行列「連到…」與改一塊面板都開它） */
  | { kind: "link"; blockId: string }
  /**
   * ③：時數目標面板；goalId null＝新增。UI 丙-4 修：back "goals"＝從「分類與設定」的目標籤點進來，
   * 儲存／取消／封存／刪除後回到那一籤（不是整個關掉），面板底的「已封存的目標」也不畫（目標籤已經有一份）
   */
  | { kind: "goal"; goalId: string | null; back?: "goals" }
  /** ③：待確認清單（from／to＝正在看的那一期的窗，毫秒；清單內容讀 timetableStatsStore） */
  | { kind: "pendingList"; from: number; to: number; /** 乙：有值＝只列這個目標範圍的待確認（目標卡「看看 ›」，〈原型定案〉1） */ goalId?: string | null }
  /** ④：日程上點已排的卡開的小面板；key＝預定項（`${date}-${nodeId}`，timetableScheduleStore.items 的 key） */
  | { kind: "plan"; key: string }
  /** ⑥：運行中那一班的荷札小面板（D-時-116；桌機放 `EntityTagField`，手機不用它、直接開 `openPicker`） */
  | { kind: "tags"; blockId: string };

/** toast 全文（契約 §5.10）與固定文案（§5.11）——顯示端不手抄 */
export const TT_TEXT = {
  depart: (cat: string, at: number) => `発車・${cat}　${fmtClock(at)}`,
  departAction: "改 10 分前",
  arrive: (cat: string, dur: number) => `到着・${cat}　${fmtDur(dur)}`,
  undo: "復原",
  longRunGap: (cat: string, at: number) => `到着・${cat}　${fmtClock(at)}；之後留白`,
  longRunCat: (cat: string, at: number) => `${fmtClock(at)} 起改成「${cat}」`,
  fill: (cat: string, dur: number) => `補上・${cat}　${fmtDur(dur)}`,
  edit: (cat: string, start: number, end: number) => `改好了・${cat}　${fmtClock(start)}–${fmtClock(end)}`,
  deleted: "已刪除這一塊",
  split: (at: number) => `切開・${fmtClock(at)}`,
  restart: (at: number) => `出發時間改成 ${fmtClock(at)}`,
  alreadyRunning: "這一班已經在跑了",
  /** 磨光⑦：運行中那班改了分類（出發時間沒動或一起動） */
  editRunning: (cat: string, start: number) => `改成 ${cat}・${fmtClock(start)} 発`,
  /** 磨光⑦：運行中那班只改了連結或荷札 */
  editRunningOther: (cat: string) => `改好了・${cat}（運行中）`,
  /** 磨光⑦：運行列分類名的滑過提示 */
  dockEditTitle: "改這一班",
  /** 磨光⑦：運行中面板的「到着」那一列（結束時間對正在跑的班不適用） */
  runningNoEnd: "還在跑——到站請按運行列的「到着」",
  /** 磨光⑦：面板開著時這一班被別台按了到着 */
  justArrived: "這一班剛到站了",
  /** 磨光③ 2-2：運行列的「切開」鈕（D-時-138）；2-3：視圖列固定的「分類與設定」鈕（手機寫短字） */
  dockSplit: "切開",
  dockSplitTitle: "切開這一班",
  settingsBtn: "分類與設定",
  /** UI 丙-4 F1：手機籤列末端的文字鈕＝規範 §2.1 的「管理」（各線同一個字；開的仍是分類與設定） */
  settingsBtnShort: "管理",
  /** UI 丙-4 A1：桌機頁首第二格「＋ 補記」（＝F 鍵）與它的滑過說明（鍵帽由呼叫端補） */
  fillBtn: "補記",
  fillBtnTitle: "補記剛才的空檔",
  undoArriveFailed: "已經有下一班了，到站復原不了",
  saveFailed: "存檔失敗——請再試一次",
  pickCategory: "請選分類",
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
  /** B6 封存（帶「復原」＝TT_TEXT.undo） */
  archived: (name: string) => `已封存「${name}」`,
  /** B7 還原 */
  unarchived: (name: string) => `已還原「${name}」`,
  /** B8 搬組 */
  movedToGroup: (name: string, group: string) => `「${name}」搬到「${group}」`,
  /** B9 換圓牌字 */
  glyphSet: (glyph: string) => `圖示字改成「${glyph}」`,
  /** B10 圓牌字不是一個字 */
  glyphInvalid: "圖示只能填一個字",
  /** B11 誤點 chip */
  late: (overMs: number) => `誤點 +${fmtDur(overMs)}`,
  latePending: (overMs: number) => `誤點 +${fmtDur(overMs)}・待確認`,
  /** B12 預估 chip */
  estimateChip: (min: number) => `預估 ${fmtDur(min * MIN)}`,
  estimateAdd: "＋預估",
  /** B13 F 鍵沒有空白 */
  noGap: "這天沒有漏記的時間",
  /** B14 切點驗證 */
  cutTooShort: "每段至少 1 分鐘",

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
  TASK_CATEGORY_NOTE: "之後從這條路線發車都會套用",
  /** 沒掛路線的臨時車票（只查節點那一段，每一張第一次都會跳） */
  TASK_CATEGORY_NOTE_NO_ROUTE: "之後從這張車票發車都會套用",
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
  TIME_HOVER: (self: string, below: string) => `本身 ${self}／子項目 ${below}`,
  ROUTE_TIME: (month: string, total: string) => `本月 ${month}・累計 ${total}`,
  /** 手機路線圖列尾（RouteTimeAside）：帶「本月」，跟售票口「本月花 …」並排也看得懂（D-時-140） */
  ROUTE_ASIDE: (month: string) => `本月 ${month}`,
  TIME_MANUAL: "手填",
  TIME_BLOCKS: (x: string) => `時間塊 ${x}`,
  FOCUS: "專注",
  TODAY_DEPART: "発車",
  TODAY_RUNNING: "正在跑",
  EST_FALLBACK_TASK: (x: string) => `；沒設預估時，沿用車票的預計時間 ${x}`,
  LONG_RUN_TASK: (task: string, est: string, over: string) => `「${task}」預計 ${est}，已經誤點 ${over}。實際到幾點？`,

  /* ── ③（③ 契約 §5.9；顯示端不手抄） ── */
  viewWeek: "週",
  viewStats: "統計",
  statsRecorded: "已記錄",
  statsUnrecorded: "未記錄",
  statsPending: (n: number, ms: number) => `待確認 ${n} 班・${fmtDur(ms)}`,
  /** 環比總述的前綴：「比上週同期」（進行中的期，same）／「比上週」（已過完的期） */
  statsCompare: (p: StatsPeriod, same: boolean) => `比${p === "day" ? "昨天" : p === "week" ? "上週" : "上個月"}${same ? "同期" : ""}`,
  statsEmpty: "這期還沒有紀錄",
  statsToCurrent: "回到本期",
  weekToCurrent: "回到本週",
  routeNone: "沒連車票",
  routeNoRoute: "沒有路線的任務",
  routeGone: "（已刪除的車票）",
  goalAdd: "＋目標",
  goalMet: "達成",
  goalOver: (ms: number) => `超過 ${fmtDur(ms)}`,
  /** 至少＝「還差」、至多（atMost 傳 true）＝「還剩」 */
  goalLeft: (ms: number, atMost = false) => `${atMost ? "還剩" : "還差"} ${fmtDur(ms)}`,
  goalPendingHint: (n: number) => `另有 ${n} 班待確認`,
  /** D-時-60／61／62：期間過了／還沒開始／節奏 */
  goalEnded: "已結束",
  goalMissed: "未達標",
  goalKept: "守住",
  goalStarts: (md: string) => `${md} 開始`,
  goalDaysLeft: (n: number) => `還剩 ${n} 天`,
  goalPace: (ms: number) => `平均每天還要 ${fmtDur(ms)}`,
  /** 已結束的卡上「收起來」（＝封存） */
  goalHide: "收起來",
  goalSaved: (name: string) => `目標「${name}」存好了`,
  goalDeleted: "目標刪掉了",
  goalArchived: (name: string) => `「${name}」收起來了`,
  goalUnarchived: (name: string) => `「${name}」取回來了`,
  pendingAllDone: "都確認好了",
  syncBlockGone: "這筆紀錄已被合併或刪除",
  /** ③ 週視圖、視圖切換的畫面字（丙席；契約 §5.1、§5.5、D-時-54、66；顯示端不手抄） */
  weekUi: {
    /** 欄頭（D-時-66：寫「週一」，不是單一個「一」） */
    weekdays: ["週日", "週一", "週二", "週三", "週四", "週五", "週六"] as readonly string[],
    viewSplit: "兩欄",
    /** UI 丙-4 A2：籤字一律名詞（舊「只看時間軸」留在 manifest 的鍵 label，滑過說明照用） */
    viewAxis: "時間軸",
    /** UI 丙-4 A1：V 鍵併進前兩籤滑過說明的那一段 */
    viewToggleTitle: "兩欄⇄時間軸",
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
    gapTip: (from: string, to: string, dur: string) => `未記錄 ${from}–${to}・${dur}　點擊補記`,
    foot: (desktop: boolean) => `點時間塊可查看或編輯；點空白處可補記${desktop ? "；← → 換週、T 回本週" : ""}`,
  },
  /** ③ 同步清單的時刻表三張表（丙席；契約 0-13、D-時-58；`lines/timetableSyncLabel.ts` 讀） */
  syncRunningFrom: "起",
  syncCatLabel: (name: string) => `分類「${name}」`,
  syncGoalLabel: (name: string) => `目標「${name}」`,
  syncCatGone: "已刪除的分類",
  syncNodeGone: "一張車票",
  syncRouteGone: "一條路線",
  syncTopLevel: "（最上層）",
  syncNoEstimate: "沒預估",
  syncNoDefault: "無預設",
  syncNoScope: "（沒有分類）",
  syncRunning: "運行中",
  syncAck: "已確認",
  syncPending: "待確認",
  syncArchived: "已封存",
  syncNotArchived: "未封存",
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
    // ④ #73 R5：glyph、position（兩台改同一分類的圓牌字／排序時同步清單印中文）
    time_categories: { name: "名字", parent_id: "分組", color_idx: "顏色", default_min: "預設長度", archived_at: "封存", glyph: "圓牌字", position: "排序" },
    time_goals: {
      name: "名字",
      scope: "分類",
      period: "期間",
      target_min: "目標時數",
      direction: "方向",
      start_on: "起點",
      end_on: "終點",
      archived_at: "封存",
      position: "排序", // ④ #73 R5
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
    pendingTip: "點開逐一確認，修好就會歸入分類",
    pendingNone: "沒有跑太久、待確認的時間塊",
    cmpRecorded: "已記錄",
    cmpWhole: (name: string) => `上一期：${name}`,
    /** 環比的滑過／點開說明（〈原型定案〉1：「多 3h10m（上期 18h）」） */
    deltaTip: (ms: number, prevMs: number) =>
      Math.abs(ms) < MIN ? `持平（上期 ${fmtDur(prevMs)}）` : `${ms > 0 ? "多" : "少"} ${fmtDur(Math.abs(ms))}（上期 ${fmtDur(prevMs)}）`,
    shareTitle: "占比與上期比較",
    shareNote: (cmp: string) => `占已記錄時數・與${cmp}比較`,
    shareFoot: "點名稱只看該類趨勢（再點取消）；點 › 看子分類",
    expandKids: "展開子分類",
    collapseKids: "收起子分類",
    filterOn: "趨勢只看這一類",
    filterOff: "再點一次取消",
    trendTitle: "趨勢",
    trendNote: (p: StatsPeriod) => (p === "day" ? "近 14 天" : p === "week" ? "近 8 週" : "近 6 個月"),
    filterChip: (name: string) => `只看「${name}」`,
    filterClear: "顯示全部",
    toNow: "到現在",
    goalsTitle: "時數目標",
    goalsNone: "還沒有目標。點「＋目標」就能設定（例如：每週創作 10 小時）。",
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
    routesNote: "占已記錄時數",
    routeDeleted: (name: string) => `${name}（已刪除）`,
    loading: "計算中…",
    loadFailed: (msg: string) => `統計讀不出來：${msg}`,
    pendingSub: "跑太久、待確認的時間塊不會算進分類與目標。改好結束時刻或按「沒錯」就會歸入分類。",
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
    kindRepeat: "定期重複",
    hintSince: "從這天的日界線開始持續累計",
    hintUntil: "包含當天整天",
    hintStartDefault: "預設為今天",
    startLink: (md: string) => `從 ${md} 起算・改起點`,
    minutes: (m: number) => `${m} 分`,
    hourUnit: "h",
    hoursDown: (n: number) => `少 ${n} 小時`,
    hoursUp: (n: number) => `多 ${n} 小時`,
    noName: "請取個名字",
    noCat: "請至少勾一個分類",
    noHours: "時數要大於 0",
    noEndUntil: "請選截止日",
    noEndRange: "請選結束日期",
    noStart: "請選開始日期",
    endBeforeUntil: "截止日不能早於開始日",
    endBeforeRange: "結束不能早於開始",
    save: "儲存",
    archive: "封存",
    remove: "刪除",
    archivedList: (n: number) => `已封存的目標（${n}）`,
    restore: "還原", // UI 丙-4 修：同分類、目標籤的「還原」（規範法則 06 同一件事同一個名字）
    goalGone: "找不到這個目標，可能已刪除",
    // UI 丙-4 修：close「關閉」拿掉（C4 後沒人用；規範 §4 不放「關閉」字鈕，×／返回就是關）
  },

  /* ── ④ 日程（④ 契約 §5.8；顯示端不手抄） ── */
  viewSchedule: "日程",
  schedToday: "今天",
  /**
   * 總結行（今天、過去；D-時-83 使用者改題）：「排了 6 件・済 3・只記時間 1・準點 2」。
   * stamped＝排了的裡面蓋了済的、timedOnly＝有記到時間但還沒済的（互斥）；只記時間 0 ⇒ 不印那一段，済 0 照印
   */
  schedPlanned: (n: number, stamped: number, timedOnly: number, onTime: number) =>
    `排了 ${n} 件・済 ${stamped}` + (timedOnly > 0 ? `・只記時間 ${timedOnly}` : "") + `・準點 ${onTime}`,
  /** 總結行（未來）：「排了 3 件・共 4h30m（2 件長度未定）」；ms＝預計加總（毫秒）、noEst＝沒預計的件數；預計加總 0 ⇒ 不寫「共」 */
  schedFuture: (n: number, ms: number, noEst: number) =>
    `排了 ${n} 件` + (ms > 0 ? `・共 ${fmtDur(ms)}` : "") + (noEst > 0 ? `（${noEst} 件未定時長）` : ""),
  schedEmpty: "這天還沒有排定時刻的車票",
  schedTrayTitle: "還沒排",
  schedTrayEmpty: "這天的車票都排好了",
  /** 「還沒排」底下的灰字（D-時-80 改題）：誤點的單發票都進清單了，只剩定期券漏班要去今日頁（主線擋改執行日） */
  schedLateRepeat: (n: number) => `今日視圖還有 ${n} 班誤點的定期券`,
  /** 誤點的單發票排上來的收據：執行日改到今天＋排時刻 */
  schedLateMoved: (t: string) => `移到今天 ${t}`,
  /** 定期券「改回每班時刻」的收據（PlanPanel 的「改回 20:00」；store.revertRun） */
  schedReverted: (t: string) => `改回每班時刻 ${t}`,
  schedRevertedNone: "改回每班時刻（沒有時刻）",
  schedOutOfAxis: (t: string) => `未排時刻 ${t}`,
  schedPickHint: "點預定欄的位置排上去",
  schedPickCancel: "取消",
  schedPast: "過去的日子只能看",
  schedPlaced: (t: string) => `已排到 ${t}`,
  schedMoved: (t: string) => `改到 ${t}`,
  schedCleared: "已清除時刻",
  /** 收據後面補的一句：原本的時刻在現在的日界線外（軸外），寫不回去 ⇒ 這筆不出「復原」（修正席） */
  schedNoUndo: (t: string) => `（原本的 ${t} 在日界線外，無法復原）`,
  schedNoEstimate: "長度未定",
  schedRun: "本班",
  /** 預定卡上的時刻：「14:00 発」（照存的字；≥ 24:00 另加 `nextDayNote` 的「隔天 01:00」） */
  schedDepart: (t: string) => `${t} 発`,
  schedDone: "済",
  schedSkipped: "運休",
  /** 面板 PlanPanel 的字（§5.5） */
  schedTimeLabel: "時刻",
  schedMinus15: "−15",
  schedPlus15: "＋15",
  schedClear: "清除時刻",
  schedOpenTicket: "打開車票",
  schedTimePlaceholder: "14:00",
  /** §5.6 差多少的字（`fmtPlanDelta` 用同一份 `PLAN_TEXT`） */
  schedOnTime: PLAN_TEXT.onTime,
  schedLateStart: PLAN_TEXT.lateStart,
  schedCarried: PLAN_TEXT.carried,
  schedRunning: PLAN_TEXT.running,
  schedNotStarted: PLAN_TEXT.notStarted,
  schedDoneNoTime: PLAN_TEXT.doneNoTime,
  schedOver: PLAN_TEXT.over,
  schedUnder: PLAN_TEXT.under,
  schedSoFar: PLAN_TEXT.soFar,
  schedPendingNote: PLAN_TEXT.pendingNote,

  /* ── ⑤ 方眼（⑤ 契約 §5.6＋〈原型定案〉1；顯示端不手抄）。讀數類收已排好的字串（UI 自己分段上樣式）；toast 類收毫秒 ── */
  viewGrid: "方眼",
  /** 格子大小分段鈕的一格（讀屏／tooltip 用；鈕面只印數字＋「分」） */
  gridCell: (m: number) => `${m} 分`,
  gridCellGroup: "格子大小",
  gridCellUnit: "分",
  /** 讀數：「14:00–15:30・1h30m」 */
  gridRead: (a: string, b: string, dur: string) => `${a}–${b}・${dur}`,
  /** 讀數（live）：「14:00 起換成・繼續跑」 */
  gridLive: (a: string) => `${a} 起換成・繼續計時`,
  /** 〈原型定案〉1：放開後的貼齊說明「貼齊空白：頭 14:00→14:07、尾 15:00→14:52」；parts＝gridSnapHead／gridSnapTail 的結果 */
  gridSnap: (parts: readonly string[]) => `填滿空白：${parts.join("、")}`,
  gridSnapHead: (from: string, to: string) => `頭 ${from}→${to}`,
  gridSnapTail: (from: string, to: string) => `尾 ${from}→${to}`,
  /** 〈原型定案〉1：live 時塗色列多一行（點運行中那班的分類會怎樣） */
  gridLiveRestart: (cat: string, at: string) => `點「${cat}」＝這一班提早到 ${at} 出發`,
  gridLiveSame: (cat: string) => `點「${cat}」＝本來就是，不變動`,
  /** 沙盒 F2：同一行接著講點別的分類時運行中那班的結局（讀數的「會蓋掉」不算它）；whole＝選區頭不晚於它的開始 */
  gridLiveOther: (whole: boolean, at: string) => (whole ? "點其他分類＝整班換掉" : `點其他分類＝這一班在 ${at} 到站`),
  /** 桌機塗色列的說明一行（live 時運行中那班的結局在下面那一行講，這裡不重複） */
  gridPaintHint: (live: boolean) => `點分類直接填入${live ? "、從選區頭繼續跑" : ""}`,
  gridMore: "更多…",
  gridCancel: "取消",
  /** live 模式不給「更多…」時那一格的說明 */
  gridLiveNoMore: "計時中不能用「更多…」，請直接點分類",
  gridFuture: "還沒到的時間不能記",
  /** 點了過去的空白格、卻沒有可補的空白（不到 1 分的縫） */
  gridNoGap: "這一格已經滿了",
  /** 手機：起點離螢幕左右邊 < 24px 不開始拖（讓給返回手勢） */
  gridEdge: "太靠螢幕邊緣，請往內滑一點",
  gridLegendFuture: "還沒到",
  /** 操作說明一行 */
  gridFoot: (isDesk: boolean) =>
    `拖曳選取格子再點分類可補記；點色塊可修改${isDesk ? "；← → 換日、T 今天、Esc 取消" : ""}`,
  /** toast：補上（fill） */
  paint: (cat: string, durMs: number) => `補上・${cat}　${fmtDur(durMs)}`,
  /** toast：live 換車 */
  paintLive: (cat: string, at: number) => `${fmtClock(at)} 起換成 ${cat}`,
  /**
   * toast 的副標（〈原型定案〉1；Toast 主訊息下面的第二行小字）：「蓋掉 2 塊、切短 2 塊——復原會全部回來」；沒蓋到＝空字串。
   * undoable＝false（提早出發不給復原，沙盒 F3）⇒ 不接「復原會全部回來」。
   */
  paintCoverSub: (s: CoverSummary, undoable = true) => {
    const parts: string[] = [];
    if (s.removed) parts.push(`蓋掉 ${s.removed} 塊`);
    if (s.shortened) parts.push(`切短 ${s.shortened} 塊`);
    if (s.splitCount) parts.push(`切開 ${s.splitCount} 塊`);
    return parts.length ? `${parts.join("、")}${undoable ? "——復原會全部回來" : ""}` : "";
  },
  paintSame: (cat: string) => `本來就是「${cat}」`,
  paintUndone: "已復原・回到塗之前",
  paintUndoFailed: "後來又改過了，復原不了",

  /* ── ⑥ 荷札接軌（⑥ 契約 §5.9、D-時-115～123、129；顯示端不手抄）。荷札名一律傳「不含 #」的顯示名，# 由這裡加 ── */
  tags: {
    /** 塊面板那一列的列名（D-時-115）、運行列的小鈕（D-時-116）、手機運行列「荷札 N」（D-時-126） */
    row: "荷札",
    /** 手機新增鈕（磨光③ 2-10：跟桌機、旅客筆記同字） */
    add: "掛荷札",
    runCount: (n: number) => `荷札 ${n}`,
    /** 分類帶的牌子的滑過字（D-時-115；磨光③ 統一用「」） */
    fromCategory: (name: string) => `來自分類「${name}」`,
    fromGroup: (name: string) => `來自「${name}」群組`,
    /** 磨光③ 2-1 單塊排除（D-時-136）：src＝`srcCategory`／`srcGroup` 的字 */
    srcCategory: (name: string) => `分類「${name}」`,
    srcGroup: (name: string) => `組「${name}」`,
    offTitle: (tag: string, src: string) => `這一塊不算 #${tag}（${src}還是帶著）`,
    offTitleRestore: (tag: string, src: string) => `這一塊不算 #${tag}（${src}還是帶著）；點一下還原`,
    offLabel: (tag: string) => `這一塊不算 #${tag}`,
    restoreTitle: (tag: string) => `還原：這一塊也算 #${tag}`,
    restoreLabel: (tag: string) => `還原 #${tag}`,
    /** 運行中那班的荷札小面板（立刻寫）的 toast */
    offToast: (tag: string) => `這一塊不算 #${tag}`,
    onToast: (tag: string) => `這一塊也算 #${tag}`,
    /** 手機點選器 insert 模式的標題（磨光③ 2-8）：補記還沒選分類／目標面板 */
    pickerFill: "荷札・補記",
    pickerGoal: "荷札・目標",
    /** 荷札 index 載入失敗（磨光③ 2-12） */
    loadFailed: "荷札沒載入",
    retry: "重試",
    /** 分類管理：子分類列「組帶的：#高效」（D-時-121）；⋯ 展開區那一列的列名 */
    groupCarried: "群組預設：",
    defaults: "預設荷札",
    /** 一個荷札的顯示字「#高效」 */
    chip: (name: string) => `#${name}`,
    /** 運行列淡字（D-時-116）：最多 2 個＋「…」；names＝全部（不含 #） */
    runList: (names: readonly string[]) => (names.length ? "・" + names.slice(0, 2).map((n) => `#${n}`).join(" ") + (names.length > 2 ? " …" : "") : ""),
    /** 手機點選器標題（D-時-129）：已結束「荷札・娛樂 23:20」（分類＋發車時刻）／運行中「荷札・創作 14:35 起」 */
    pickerTitle: (cat: string, start: number, running: boolean) => `荷札・${cat} ${fmtClock(start)}${running ? " 起" : ""}`,
    /** 占比卡分段鈕（D-時-118） */
    shareCat: "分類",
    shareTag: "荷札",
    shareGroup: "占比依",
    /** 荷札面（D-時-119） */
    untagged: "沒掛荷札",
    overNote: "一個時間塊可能有多個荷札，總和會超過 100%",
    virtual: "上層分類",
    shareFoot: "點名稱只看該荷札的趨勢（再點取消）；點 › 看底下的荷札；上層的時數含底下的荷札、同一塊不重複算",
    filterTitle: (on: boolean) => (on ? "再點一次取消" : "趨勢只看這個荷札"),
    /** 空狀態（D-時-120） */
    empty: "還沒有荷札。幫分類掛上預設荷札（例如娛樂 → #拖延），過去的紀錄也會一起算進來。",
    goSet: "去設定",
    /** 目標面板（D-時-122）與目標卡 */
    goalSection: "荷札",
    goalScopeEmpty: "請選至少一個分類或荷札",
    goalTagsGone: "綁定的荷札已刪除",
    /** 荷札頁「時刻表」段（D-時-123；`tagEntities` 的 group 與 describe 用） */
    entityGroup: "時刻表",
    /** 手動掛的塊：「10/17 上課 10:50–13:00」；end null＝運行中 */
    entityBlock: (md: string, cat: string, start: number, end: number | null) =>
      `${md} ${cat} ${fmtClock(start)}–${end === null ? "運行中" : fmtClock(end)}`,
    entityCategory: (name: string) => `分類「${name}」的預設荷札`,
    entityCategorySub: "這個分類過去和未來的紀錄都會套用",
    /** 組（頂層）的預設荷札：會傳給底下每個分類（D-時-111），寫成「組」才看得出刪它的影響範圍（評審後） */
    entityGroupDefault: (name: string) => `「${name}」群組的預設荷札`,
    entityGroupDefaultSub: "群組內所有分類過去和未來的紀錄都會套用",
    /* ── 評審後從顯示端收進來的字（§5.9；只搬文字） ── */
    /** 補記還沒選分類時荷札列的淡字 */
    fillHint: "選分類後，會自動帶入它的預設荷札",
    /** 改一塊：荷札 index 還沒載好（先不給編輯，免得在空的基準上改） */
    loading: "荷札載入中…",
    /** 運行中那班的荷札小面板 */
    runGone: "找不到這一班",
    runStart: (clock: string) => `${clock} 発`,
    runHint: "手動加的荷札會跟著這一班，到站或切開後也會保留",
    // UI 丙-4 修：close「關閉」／done「好了」拿掉（C4：荷札小面板即時存，不放字鈕；規範 §4）
    /** 運行列「荷札」鈕的滑過字（還沒有荷札時） */
    runBtnTitle: "幫這一班加荷札",
    /** 目標面板荷札段的說明 */
    goalTagHint: "同時選分類與荷札時，只要符合其一就會計入（不重複計算）",
    /** 分類管理：子分類的「組帶的」那一行尾巴、⋯ 展開區的兩句說明、組頭 ⋯ 的 aria-label */
    grpEditAt: (group: string) => `（請到「${group}」群組的 ⋯ 修改）`,
    catNote: "預設荷札＝這個分類的每一塊都帶上，過去的也算（改了會改到過去的統計）。",
    groupNote: "組的預設荷札，底下每個分類都會帶上（含之後新增的）；過去的紀錄一起算。",
    groupMore: (group: string) => `${group} 的預設荷札`,
    /** 荷札牌：名稱可點時的滑過字、摘下鈕 */
    openList: (name: string) => `看 #${name} 的清單`,
    remove: "摘下",
    removeLabel: (name: string) => `摘下 #${name}`,
    /** 點牌進荷札頁時「‹ 回到剛才」的字 */
    backLabel: "時刻表",
    entityGoal: (name: string) => `目標「${name}」`,
    /* 丙席・統計（原型 v-tags.js scopeText／goalsHtml）：範圍混了荷札超過 3 項「創作・#高效…等 4 項」；範圍空了的卡尾鈕 */
    scopeMore: (names: string, n: number) => `${names}…等 ${n} 項`,
    goalRescope: "重選範圍 ›",
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
  /** V 鍵與頂端切換鈕：兩欄（發車台）⇄只看軸；在週／統計／日程按 V 回兩欄（發車台）（D-時-57；④ 0-7） */
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
  /**
   * ②：第四參數＝新一塊的連結。⑥（0-12）：第五參數＝面板草稿的手動荷札名稱（不含分類帶的）；拿到新塊的 id 後
   * `tagRepo.setTags('timetable:block', id, names)`（不另 toast）。undefined 或空陣列＝不掛。名稱不合法 ⇒ toast 理由、整筆不寫。
   * 磨光③ 2-1：第六參數＝草稿裡排除的分類帶荷札名稱（`timetable:block-off`，同一時間寫）；undefined 或空陣列＝不排除
   * 磨光⑤ 收尾（沙盒 O1）：第七參數 longOk＝面板上按了「確定記這麼長」⇒ 新塊記成已確認（不再標「長時間運行・待確認」）
   */
  fill(
    categoryId: string,
    start: number,
    end: number,
    link?: BlockLink | null,
    tagNames?: readonly string[],
    offNames?: readonly string[],
    longOk?: boolean,
  ): Promise<void>;
  /**
   * ②：link undefined＝不動連結。⑥（0-12；評審後改）：tagEdit＝面板草稿相對於「面板打開時的手動荷札」的差集
   * （`blockTagEditOf`；只 attach／detach 差的那幾個，不整份 setTags——基準不完整時才不會摘掉既有的）；undefined＝不動荷札。
   * 磨光③ 2-1（D-時-134）：offNames＝送出後這一塊**全部**排除的分類帶荷札名稱（含畫面上沒畫出來、照留的舊排除）；
   * store 跟 index 裡現在排除的比出差集再 attach／detach（`timetable:block-off`）。undefined＝不動排除；[]＝全部還原
   * 磨光⑤ 收尾（沙盒 O1）：longOk＝按了「確定記這麼長」⇒ 這一塊記成已確認
   */
  editBlock(
    blockId: string,
    categoryId: string,
    start: number,
    end: number,
    link?: BlockLink | null,
    tagEdit?: BlockTagEdit,
    offNames?: readonly string[],
    longOk?: boolean,
  ): Promise<void>;
  /**
   * 磨光⑦（D-時-152）：改運行中那一班——分類、出發時間、連結（undefined＝不動）、荷札差集／排除（同 editBlock）。
   * 什麼都沒變 ⇒ 不寫。toast：換了分類「改成 X・HH:MM 発」；只改出發時間「出發時間改成 HH:MM」。
   */
  editRunning(
    blockId: string,
    categoryId: string,
    start: number,
    link?: BlockLink | null,
    tagEdit?: BlockTagEdit,
    offNames?: readonly string[],
  ): Promise<void>;
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
  /** ①b：封存（toast B6 帶「復原」）／還原（B7） */
  archiveCategory(id: string, archived: boolean): Promise<void>;
  /** ①b：搬到另一個頂層組；toast B8 */
  moveCategoryToGroup(id: string, parentId: string): Promise<void>;
  /** ①b：換圓牌字；toast B9 */
  setCategoryGlyph(id: string, glyph: string): Promise<void>;

  /* ③ 時數目標（③ 契約 §3.3）：走 write()（serial → refresh → toast）；回 true＝寫成功（面板據此關），失敗已 toast */
  createGoal(input: GoalInput): Promise<boolean>;
  updateGoal(id: string, patch: Partial<GoalInput>): Promise<boolean>;
  /** 封存（toast 帶「復原」）／叫回 */
  archiveGoal(id: string, on: boolean): Promise<boolean>;
  /** 軟刪除（toast 帶「復原」＝restoreGoal） */
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

  /* ⑤ 方眼（⑤ 契約 0-5、§3.3；只加不改） */
  /**
   * 方眼塗色列點了分類：走 write()（serial → refresh → toast）。start／end 在這一刻夾到 now（呼叫端已依 liveTail 重算 end、重做 paintModeOf）。
   * toast：fill＝`paint`；live 換車＝`paintLive`；live 同分類提早出發＝`restart`；live 同分類不早於它＝`paintSame`（沒寫、沒有復原）；
   * live 但資料庫裡已經沒有運行中的班（另一台剛到站、還沒 refresh）＝repository 補到現在 ⇒ `paint`。
   * 蓋到既有紀錄 ⇒ toast 的副標（第二行）＝`paintCoverSub`（蓋掉數跟讀數同一口徑：live 不算運行中那班，`paintCoverOf`）。
   * 「復原」＝`undoPaint`，false ⇒ toast `paintUndoFailed`；都 refresh。只保證最近一次可復原（快照在閉包裡）。
   * **提早出發（restart）不給復原**（沙盒 F3＝契約 §9-3 降級；`paintUndoable`）：復原得把運行中那班的 started_at 寫回去，跨裝置會拼出零長度塊。
   */
  paint(categoryId: string, start: number, end: number, mode: "fill" | "live"): Promise<void>;
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

const toast =(message: string, actionLabel?: string, onAction?: () => void, sub?: string): void =>
  useUiStore.getState().showToast({ message, ...(sub ? { sub } : {}), ...(actionLabel ? { actionLabel, onAction } : {}) });

function failToast(e: unknown): void {
  toast(e instanceof RangeError ? e.message : TT_TEXT.saveFailed);
}

/* ───────── ⑥ 荷札（⑥ 契約 0-8、0-12；甲席資料） ───────── */

/** store 自己經 tagRepo 寫過塊的手動荷札（補記／改一塊的草稿）、還沒重載 index */
let blockTagsWritten = false;

/**
 * 0-8 必改段：repository 寫過 taggings（切開／整理／合併搬手動荷札、目標的荷札、mock 示範荷札）或 store 剛寫過塊的荷札，
 * 而且 `tagStore.index` 已經載過 ⇒ `loadIndex()`（tagStore.reload 只認同步的 changed；本機寫的要自己叫）。
 * 由 `refresh()` 開頭叫（`write()`／`reload()` 都經過 refresh）；沒載過的 index 留給要用的人第一次載。
 */
async function syncTagIndex(): Promise<void> {
  const wrote = timetableRepo.consumeTagWrites() || blockTagsWritten;
  blockTagsWritten = false;
  if (!wrote) return;
  const ts = useTagStore.getState();
  if (ts.index) await ts.loadIndex();
}

/** 0-12 草稿的名稱：undefined ⇒ undefined（不動）；不合法 ⇒ toast 旅客筆記的理由、回 false（整筆不寫） */
function draftTagNames(names: readonly string[] | undefined): string[] | undefined | false {
  if (names === undefined) return undefined;
  try {
    return checkTagNames(names);
  } catch (e) {
    failToast(e);
    return false;
  }
}

/**
 * 補記的新塊掛上草稿的手動荷札（`tagRepo.setTags`：一個交易、一張收據；不另 toast）。回 null＝成功；失敗回錯誤（時間資料已經寫好）。
 * 只給剛建的塊用（本來就沒有荷札，整份換＝全部掛上）；改既有的塊走 `applyBlockTagEdit` 的差集（評審後）。
 * 磨光③ 2-1：`type` 傳 `TT_TAG_BLOCK_OFF` 寫排除的那份（同一支、同一張收據規則）。
 */
async function writeBlockTags(blockId: string, names: readonly string[], type: typeof TT_TAG_BLOCK | typeof TT_TAG_BLOCK_OFF = TT_TAG_BLOCK): Promise<unknown> {
  try {
    const r = await tagRepo.setTags(type, blockId, names);
    if (receiptWrote(r.receipt)) blockTagsWritten = true;
    return null;
  } catch (e) {
    console.warn("時刻表：塊的荷札沒掛上（時間資料已經寫好）", e);
    return e;
  }
}

/**
 * ⑥（⑤ 交接 O1）：荷札小面板（`{kind:"tags"}`）只對著運行中那一班。對著的不是它 ⇒ 換成運行中那班的；沒有運行中的 ⇒ null（關掉）。
 * 不是荷札小面板、或對得上 ⇒ undefined（不動）。refresh 與 openSheet 共用。
 */
function tagSheetFollow(sheet: TimetableSheet | null, runningId: string | null): TimetableSheet | null | undefined {
  if (sheet?.kind !== "tags" || sheet.blockId === runningId) return undefined;
  return runningId ? { kind: "tags", blockId: runningId } : null;
}

function normalizeView(raw: string | null, shell: TimetableShell): TimetableView {
  if (raw === "week" || raw === "stats" || raw === "schedule" || raw === "grid") return raw; // ③：兩殼都有（D-時-46）；④ schedule、⑤ grid 同（D-時-74、92）
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

  /**
   * 磨光② A15：釘選分類會同步——別台改了，拉到 settings 時重讀（同 readLongRunMax）。
   * 內容沒變就不換陣列：兩殼的通知代理以參照比 `noticePins`，換了就會重貼一次通知（拉到別的設定鍵也會進這裡）。
   */
  async function readNoticePins(): Promise<void> {
    const next = parsePins(await settingsRepo.get(KEY_NOTICE_PINS));
    const cur = get().noticePins;
    if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) set({ noticePins: next });
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
      await get().refresh(); // ⑥：refresh 開頭 syncTagIndex（搬過手動荷札 ⇒ 重載 index，0-8）
      after?.(r);
    } catch (e) {
      void syncTagIndex(); // 寫到一半丟錯（例：目標列寫了、荷札沒掛上）也要讓已寫的 taggings 進 index
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
        await syncTagIndex(); // ⑥ 0-8：write()／reload() 的整理寫過 taggings ⇒ 先重載荷札 index（rev 變時統計拿到的就是新的）
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
        // ⑥（⑤ 交接 O1）：荷札小面板跟著運行中那一班——在運行中那班中間塗一段會換 id（後段是新塊）、到站了就不是運行中
        // ⇒ 有新的運行中那班就換過去，沒有就關掉；不讓面板對著舊塊（或已刪的塊）寫荷札
        const follow = tagSheetFollow(sh, runningRow?.id ?? null);
        if (follow !== undefined) ++sheetSeq;
        set({
          ...(follow !== undefined ? { sheet: follow } : {}),
          categories,
          catById,
          running: runningRow,
          dayKey,
          dayBlocks,
          todayKey: newToday,
          todayBlocks: todayBlocks ?? dayBlocks,
          weekBlocks,
          // 讀的期間 sheet 換了／關了 ⇒ 不蓋；沒換 ⇒ 用剛抓的（找得到清單裡有的就清成 null）
          sheetBlock: follow !== undefined ? null : sheetBlockIdOf(get().sheet) === sheetId ? sheetBlock : get().sheetBlock,
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
      if (ctx.changed.includes("settings")) {
        await readLongRunMax(); // 全域保險上限可能被別台改了
        await readNoticePins(); // 磨光② A15：釘選分類也同步了
      }
      if (ctx.wiped) {
        initPromise = null; // 整批換掉：重走 init（表可能是空的 ⇒ 重種起手分類）
        skipSettleGateOnce = true; // 這一趟剛拉完，閘門沒有東西可等
        await get().init(ctx.shell);
        return;
      }
      // ⑥ 0-8：整理切出的片段會搬手動荷札；緊接的 refresh 開頭 syncTagIndex 重載 index（time_blocks ⊂ touched，一定會 refresh）
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
      const next: TimetableView = cur === "axis" ? home : cur === "week" || cur === "stats" || cur === "schedule" || cur === "grid" ? home : "axis";
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

    openSheet(s0) {
      // ⑥ O1：荷札小面板只開給運行中那一班（荷札頁「回到剛才」重開時那班可能已經到站、換 id）
      const followed = tagSheetFollow(s0, get().running?.id ?? null);
      if (followed === null) return;
      const s = followed ?? s0;
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

    async fill(categoryId, start, end, link, tagNames, offNames, longOk) {
      const names = draftTagNames(tagNames); // ⑥ 0-12：先驗名稱（不合法 ⇒ 不寫）
      if (names === false) return;
      const offs = draftTagNames(offNames); // 磨光③ 2-1：排除的是既有的預設荷札，照樣驗
      if (offs === false) return;
      let tagErr: unknown = null;
      await write(
        async () => {
          const r = await timetableRepo.fill(categoryId, isoOf(start), isoOf(end), { link: link ?? null, ack: longOk === true });
          if (names && names.length) tagErr = await writeBlockTags(r.block.id, names);
          if (offs && offs.length) tagErr = (await writeBlockTags(r.block.id, offs, TT_TAG_BLOCK_OFF)) ?? tagErr;
          return r;
        },
        ({ block }) => {
          if (tagErr) failToast(tagErr);
          else toast(TT_TEXT.fill(catName(block.category_id), end - start));
        },
      );
    },

    async editBlock(blockId, categoryId, start, end, link, tagEdit, offNames, longOk) {
      const add = draftTagNames(tagEdit?.add); // 只驗要新掛的名稱（摘的是現有的 key）
      if (add === false) return;
      // 磨光③ 2-1：排除那份交的是整份名稱 ⇒ 跟 index 裡現在排除的比出差集（同手動那份，只 attach／detach 差的；index 沒載＝基準空、只掛不摘）
      const offEdit = offNames === undefined ? null : blockTagEditOf(useTagStore.getState().keysOf(TT_TAG_BLOCK_OFF, blockId), offNames);
      const offAdd = draftTagNames(offEdit?.add);
      if (offAdd === false) return;
      let tagErr: unknown = null;
      await write(
        async () => {
          const r = await timetableRepo.editBlock(blockId, {
            categoryId,
            startIso: isoOf(start),
            endIso: isoOf(end),
            link,
            ack: longOk === true ? true : undefined, // 磨光⑤ 收尾：沒按確定鈕＝不給（照舊）
          });
          // 評審後：只套差集（attach／detach），不整份 setTags；排除那份（D-時-134）同一招、改分類也不裁（D-時-135）
          const edits: [BlockTagEdit, typeof TT_TAG_BLOCK | typeof TT_TAG_BLOCK_OFF][] = [];
          if (tagEdit) edits.push([{ add: add ?? [], remove: tagEdit.remove }, TT_TAG_BLOCK]);
          if (offEdit) edits.push([{ add: offAdd ?? [], remove: offEdit.remove }, TT_TAG_BLOCK_OFF]);
          for (const [edit, type] of edits) {
            try {
              if (await applyBlockTagEdit(tagRepo, blockId, edit, type)) blockTagsWritten = true;
            } catch (e) {
              blockTagsWritten = true; // 寫到一半也可能已經動了幾個 ⇒ 重載 index
              console.warn("時刻表：塊的荷札沒改好（時間資料已經寫好）", e);
              tagErr = e;
            }
          }
          return r;
        },
        () => {
          if (tagErr) failToast(tagErr);
          else toast(TT_TEXT.edit(catName(categoryId), start, end));
        },
      );
    },

    async editRunning(blockId, categoryId, start, link, tagEdit, offNames) {
      const add = draftTagNames(tagEdit?.add);
      if (add === false) return;
      const offEdit = offNames === undefined ? null : blockTagEditOf(useTagStore.getState().keysOf(TT_TAG_BLOCK_OFF, blockId), offNames);
      const offAdd = draftTagNames(offEdit?.add);
      if (offAdd === false) return;
      const before = get().running;
      const catChanged = !before || before.id !== blockId || before.category_id !== categoryId;
      const startChanged = !before || before.id !== blockId || msOf(before.started_at) !== start;
      let tagErr: unknown = null;
      await write(
        async () => {
          const r = await timetableRepo.editRunning(blockId, { categoryId, startIso: isoOf(start), link });
          const edits: [BlockTagEdit, typeof TT_TAG_BLOCK | typeof TT_TAG_BLOCK_OFF][] = [];
          if (tagEdit) edits.push([{ add: add ?? [], remove: tagEdit.remove }, TT_TAG_BLOCK]);
          if (offEdit) edits.push([{ add: offAdd ?? [], remove: offEdit.remove }, TT_TAG_BLOCK_OFF]);
          for (const [edit, type] of edits) {
            try {
              if (await applyBlockTagEdit(tagRepo, blockId, edit, type)) blockTagsWritten = true;
            } catch (e) {
              blockTagsWritten = true;
              console.warn("時刻表：運行中那班的荷札沒改好（時間資料已經寫好）", e);
              tagErr = e;
            }
          }
          return r;
        },
        () => {
          if (tagErr) failToast(tagErr);
          else if (catChanged) toast(TT_TEXT.editRunning(catName(categoryId), Math.min(start, Date.now() - MIN)));
          else if (startChanged) toast(TT_TEXT.restart(Math.min(start, Date.now() - MIN)));
          else toast(TT_TEXT.editRunningOther(catName(categoryId)));
        },
      );
    },

    async split(blockId, at, categoryId2) {
      await write(
        () => timetableRepo.split(blockId, isoOf(at), categoryId2),
        (r) => {
          if (r) toast(TT_TEXT.split(at));
          else toast("切開的位置要在這段時間之內");
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

    /* ── ⑤ 方眼（⑤ 契約 0-5、§3.3） ── */
    async paint(categoryId, start, end, mode) {
      const now = Date.now();
      const r0 = get().running;
      const a = Math.min(start, now);
      const b = Math.min(end, now);
      await write(
        () => timetableRepo.paint(categoryId, isoOf(a), isoOf(Math.max(a, b)), mode),
        ({ block, summary, undo }) => {
          const kind = paintKindOf({
            mode,
            blockInserted: undo.inserted.some((x) => x.id === block.id),
            blockEnded: block.ended_at !== null,
            wrote: undo.inserted.length > 0 || undo.touched.length > 0,
          });
          if (kind === "same") {
            toast(TT_TEXT.paintSame(catName(categoryId)));
            return;
          }
          // 副標跟塗色列的讀數同一口徑（沙盒 F2）：live 換車不算運行中那班（到站＝換車本身、整班收掉另一行講過）
          const sum = paintCoverOf(kind, summary, r0 ? msOf(r0.started_at) : null, a);
          let msg: string;
          if (kind === "restart") {
            msg = TT_TEXT.restart(msOf(block.started_at));
          } else if (kind === "fillToNow") {
            // store 還以為有班在跑、資料庫裡已經到站（另一台剛按到站）⇒ repository 補到現在（D-時-99），照補上講
            msg = TT_TEXT.paint(catName(categoryId), msOf(block.ended_at!) - msOf(block.started_at));
          } else if (kind === "live") {
            msg = TT_TEXT.paintLive(catName(categoryId), a);
          } else {
            msg = TT_TEXT.paint(catName(categoryId), b - a);
          }
          const undoable = paintUndoable(kind);
          const sub = TT_TEXT.paintCoverSub(sum, undoable);
          // 提早出發不給復原（沙盒 F3；＝RestartPanel 改出發時間沒有復原）
          if (!undoable) {
            toast(msg, undefined, undefined, sub || undefined);
            return;
          }
          toast(msg, TT_TEXT.undo, () => {
            void (async () => {
              try {
                const ok = await serial(() => timetableRepo.undoPaint(undo));
                toast(ok ? TT_TEXT.paintUndone : TT_TEXT.paintUndoFailed);
                await get().refresh();
              } catch (e) {
                failToast(e);
              }
            })();
          }, sub || undefined);
        },
      );
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
 * 這一班的門檻與長時間運行記號（兩殼、notice、NavBadge 共用）：門檻＝這一班的預估 → 任務的預計時間（②）→ 分類預設長度 → 全域上限；
 * 已結束的塊不看分類預設長度（磨光⑦ D-時-151，`blockThresholdOf`）。
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
    blockThresholdOf(block.ended_at !== null, block.estimate_min, catById[block.category_id] ?? null, globalMaxMin, liveTaskEstimate(block, links)),
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
    blockThresholdOf(block.ended_at !== null, block.estimate_min, catById[block.category_id] ?? null, globalMaxMin, liveTaskEstimate(block, links))?.min ?? null,
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
