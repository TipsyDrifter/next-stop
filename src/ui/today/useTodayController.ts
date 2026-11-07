/**
 * useTodayController——今日視圖的狀態機（M3 ③ WP2）：選取、覆蓋層（草稿列／行內日誌／推遲小卡）、
 * 完成流、臨時車票、誤點區摺疊、跨日界線重載，以及鍵盤／滑鼠兩張動作表。TodayView.tsx 只負責畫。
 *
 * 這個檔是 **Wave C 三席（WP3 臨時車票／WP4 行內日誌／WP5 拖曳）的插槽契約**：
 *   draft / openDraft / closeDraft / dismissDraft     → 建票列（common/quickadd/QuickAddRow；建票自己做，這裡只管開關）
 *   logTarget / openLog / closeLog                    → LogInlineInput
 *   deferTarget / openDefer / closeDefer              → DeferPopover
 *   moveTo(id, index)                                 → 拖曳（useDragReorder）
 * 三席只填自己的檔，不要改這裡的簽名。
 *
 * 資料唯一入口一律走 nodeStore（元件不碰 repository）：
 *   改執行日 → reschedule（會寫 carried_from 繰越、清 today_position；T／Shift+T／推遲小卡共用）
 *   今日手動序 → moveToday（拖曳與 Alt+↑↓ 的唯一入口，誤點列會被擋下並回 reason）
 *   完成 → setCompleted（順帶寫 work_logs 系統事件「済」，WP1 已接）
 *   運休 → skipOccurrence（`U`／推遲小卡定期券版／側板検印區共用；不動 nodes.status、不寫済事件）
 *
 * **定期券口徑（M3 ④，與 TodayRow 同一把尺）**：是不是定期券只看 `parseRule(repeat_rule)`；
 *   「済了沒」活著的定期券看 `row.occurrence.status`、其餘看 `row.status`；
 *   「已交代」＝ occurrence 非 null（済或運休）或 status done——頁首統計與 1.0d 慶祝吃的是這個。
 *   單次改期（`T`／`Shift+T`／推遲小卡）對定期券＝只改這一列那一班（⑥ D-主-295，走 moveRunFlow）；講不出哪一班才吐 REPEAT_RESCHEDULE_MSG。
 *
 * 取捨：
 * - 新增走「本地草稿列 → 提交才 createNode」（空白／Esc 不產生垃圾節點），鏡射 useOutlineController。
 * - 完成流的「連同子項」判斷只看**直屬**子項數（今日列不在 tree 裡，repository 只帶 child_total／child_done）；
 *   確認窗的內文因此不報全子孫數，只說「底下未完成的子項會一併蓋章」。
 * - 跨日界線（a3／D9）：每分鐘重算 todayKey，變了就 loadToday(newKey)。timer 在 effect 內建立與清除，
 *   StrictMode 雙掛載可重入（雷區 5，照 ambience 的 clear 模式）。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { capsOfHotkey } from "../shell/hotkeys";
import { isTaskKind, parseRule, type NodeRow } from "../../domain";
import { TIME_FIXED_ORDER_MSG, manualOrderIds, timeOfRow } from "../../domain/scheduledTime";
import { dayCount, type DayCountItem } from "../../domain/dayCount";
import { RETIRED_RUN_MSG, isRetiredRunRow } from "../../domain/retiredRun";
import { REPEAT_ONLY_MSG, REPEAT_RESCHEDULE_MSG, type TodayRow } from "../../data";
import { scheduleSnapshot, useNodeStore, type ScheduleSnapshot } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { confirmAndDeleteNode } from "../common/deleteNodeFlow";
import { addDays, todayKey } from "../../lib/date";
import { lineTodayHotkey } from "../../lines/runtime";
import { requestMoveTo } from "../common/moveTo";
import { moveRunFlow } from "../outline/nodeFlows";
import { rowsOf, type PopMenuItem } from "../common/PopMenu";
import type { TodayKeyActions } from "./useTodayKeyboard";
import type { TodayRowActions } from "./TodayRow";
import { useSelectionStore } from "../../store/selectionStore";
import { clearIfAny, extendBy, pickClick, selectAll } from "../common/selection/desktopSelection";
import { armOpenOnClick } from "../common/selection/openOnClick";
import { copyTicketLink } from "../external/externalBridge";

/** 建票列的開關狀態；kind＝today（Enter 排今天）／inbox（Shift+Enter 無日期票），TodayView 拿它挑建票列的預設 */
export interface TodayDraft {
  kind: "today" | "inbox";
}

/** 推遲小卡的目標（anchor＝被點的日期 chip，鍵盤觸發時為 null） */
export interface DeferTarget {
  id: string;
  anchor: HTMLElement | null;
}

/**
 * 種子動線兩條（M3-6）共用的同一句話：`Shift+Enter` 建無日期票、推遲小卡「清除執行日」。
 * DeferPopover 也 import 這一份，兩條路吐出來的字保證一模一樣。
 */
export const INBOX_TOAST = "已放進收件匣——到旅客筆記整理";

/** 時刻表線登記在今日 scope 的「発車」鍵（timetable.manifest；今日列 ⋯ 只透過 lineTodayHotkey 呼叫，不 import 別線） */
const DEPART_HOTKEY = "timetable.today.depart";

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 「這一列済了沒」的單一真相（M3 ④）——活著的定期券看班次結局，
 * 其餘（乘車券／臨時券／退役定期券，`occurrence` 恆 null）看 `nodes.status`。
 * TodayRow.tsx 的 `done` 與側板検印區都要吃同一條規則，別各判各的。
 */
export function isDoneRow(row: TodayRow): boolean {
  return row.occurrence ? row.occurrence.status === "done" : row.status === "done";
}

/**
 * 上移／下移要插到手排座標的第幾格（桌機 Alt+↑↓、⋯ 與手機 sheet 共用；回饋甲 D-主-131）：
 * 「済・隱藏」開著時跳過看不見的済票，跟畫面上相鄰的那張換位。null＝畫面上已經在頂／底（或不在手排座標）。
 * 格位照 moveToday（reorderIds：先拿掉自己再插）——往上往下都剛好是那位鄰居現在的座標。
 */
export function manualStepTarget(rows: readonly TodayRow[], id: string, delta: -1 | 1, hideDone: boolean): number | null {
  const ids = manualOrderIds(rows);
  const hidden = hideDone ? new Set(rows.filter((r) => r.id !== id && isDoneRow(r)).map((r) => r.id)) : null;
  const shown = hidden ? ids.filter((x) => !hidden.has(x)) : ids;
  const i = shown.indexOf(id);
  if (i < 0) return null;
  const nb = shown[i + delta];
  return nb === undefined ? null : ids.indexOf(nb);
}

/**
 * 「這一列今天交代過了沒」＝済 **或** 運休（運休也是一種交代，只是結局不是済）。
 * 頁首「還有 N 張」的母數與 1.0d 慶祝吃這一條（D-④-2）。
 */
export function isSettledRow(row: TodayRow): boolean {
  return row.occurrence !== null || row.status === "done";
}

/** 今日列 → 完成數的一格（磨光⑤ N11；桌機今日與手機今日共用，domain/dayCount 吃這個形狀） */
export function dayCountItem(row: TodayRow): DayCountItem {
  return { done: isDoneRow(row), settled: isSettledRow(row) };
}

/** 「M/D（週X）」——改期收據用；不經 Date.parse，避免 date-only 被當 UTC 而跨日 */
export function whenText(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${m}/${d}（週${WEEK_ZH[new Date(y, m - 1, d).getDay()]}）`;
}

/**
 * 改期收據（四條改期路裡「票會離開眼前」的三條共用：`Shift+T`、推遲小卡的明天／下週一／選日期…）。
 * 票一改期就離開今日清單，繰越章要到目標日才看得見——今天唯一的回饋就是這句 toast，
 * 且要能反悔（與同一張小卡的「清除執行日」／`Delete` 同款收據，不再是三項靜默一項有據）。
 * 復原走 updateNode：scheduled_on 會自動改道 reschedule，carried_from 一起放回去
 * （否則反悔完票上會留一枚剛長出來的繰越章），today_position 也放回去——反悔＝票回到原本的手排位置，不掉到清單最後（F-2）。
 * `T` 排今天不出收據：票還在眼前，看得見。
 */
export function showRescheduleToast(
  id: string,
  prev: ScheduleSnapshot,
  next: string,
): void {
  useUiStore.getState().showToast({
    message: `已推遲到 ${whenText(next)}`,
    actionLabel: "復原",
    onAction: () =>
      void useNodeStore
        .getState()
        .updateNode(id, prev),
  });
}

export interface TodayControllerApi {
  /** 畫面順序（late → due → today）的今日列；誤點區摺疊時仍是完整清單 */
  rows: TodayRow[];
  /** 實際看得見的列（誤點摺疊起來時不含 late／due） */
  visibleRows: TodayRow[];
  /** 這份資料算的是哪一天（依日界線） */
  dateKey: string;
  /**
   * 第一次 loadToday 回來了沒（磨光⑤ S10）：沒回來之前 rows 是空的，但那不是「今天沒有班次」——
   * 空狀態與慶祝都等它，免得開頁先閃一下「今天還沒有班次」。
   */
  loaded: boolean;
  /** 今日清單（today 分區）——空狀態判斷與統計用 */
  todayRows: TodayRow[];
  lateRows: TodayRow[];
  routeOf(row: TodayRow): NodeRow | undefined;

  selectedId: string | null;
  select(id: string | null): void;
  moveSel(dir: 1 | -1): void;

  draft: TodayDraft | null;
  openDraft(): void;
  closeDraft(): void;
  /** 收草稿但不搶焦點（建票列失焦＝使用者點去別處；回饋甲） */
  dismissDraft(): void;

  logTarget: string | null;
  openLog(id: string): void;
  closeLog(): void;

  deferTarget: DeferTarget | null;
  openDefer(id: string, anchor: HTMLElement | null): void;
  closeDefer(): void;

  complete(id: string): void;
  createInboxTicket(): void;

  lateCollapsed: boolean;
  toggleLate(): void;

  /** 拖曳落點（WP5）；與 Alt+↑↓ 同一個入口 */
  moveTo(id: string, index: number): void;

  /**
   * 頁首統計（M3 ④：母數扣掉已交代的班次）——TodayView 的「完成 n/N」「還有 N 張」「1.0d 慶祝」吃這一份。
   *   done ＝済的張數（運休不算「完成」）／left ＝還沒交代的張數（済與運休都扣掉）
   *   allDone ＝含誤點區在內、每一列都交代過了（運休視同已交代）
   */
  stats: { total: number; done: number; left: number; allDone: boolean };

  /** 剛蓋章的那一列（播 stampIn） */
  freshId: string | null;
  clearFresh(): void;
  /** 任一覆蓋層開著＝鍵盤表停用 */
  blocked: boolean;
  keys: TodayKeyActions;
  row: TodayRowActions;
  /**
   * 每列常駐 ⋯ 的選單項（UI 丙-3 A5；視覺規範 §2.6、§3.1-1）：開卡那一刻才算（停用狀態跟著當下的列）。
   * anchor＝⋯ 鈕本身（「選日期…」的推遲小卡錨在它上面）。每一項都是「選中這一列＋鍵盤表同一條路」，不另寫一份邏輯。
   */
  menuFor(row: TodayRow, anchor: HTMLElement | null): PopMenuItem[];
  focusContainer(): void;
}

export function useTodayController(containerRef: RefObject<HTMLDivElement | null>): TodayControllerApi {
  const today = useNodeStore((s) => s.today);
  const routes = useNodeStore((s) => s.routes);
  const loadToday = useNodeStore((s) => s.loadToday);
  const selectedId = useUiStore((s) => s.selectedId);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const lateCollapsed = useUiStore((s) => s.lateCollapsed);
  const setLateCollapsed = useUiStore((s) => s.setLateCollapsed);

  const [draft, setDraftState] = useState<TodayDraft | null>(null);
  const [logTarget, setLogTarget] = useState<string | null>(null);
  const [deferTarget, setDeferTarget] = useState<DeferTarget | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const draftRef = useRef<TodayDraft | null>(null);
  const setDraft = useCallback((d: TodayDraft | null) => {
    draftRef.current = d;
    setDraftState(d);
  }, []);

  const dateKey = today.dateKey ?? todayKey(dayStartHour);
  const rows = today.rows;
  // 回饋甲 D-主-131：「今天的列車」隱藏已完成時，鍵盤游標也跳過那些列（誤點區不受影響）
  const todayHideDone = useUiStore((s) => s.todayHideDone);
  const visibleRows = rows.filter(
    (r) =>
      (!lateCollapsed || r.bucket === "today") &&
      !(todayHideDone && r.bucket === "today" && (r.occurrence ? r.occurrence.status === "done" : r.status === "done")),
  );
  const todayRows = rows.filter((r) => r.bucket === "today");
  const lateRows = rows.filter((r) => r.bucket !== "today");

  // 最新值放 ref，動作函式不吃舊 closure
  const st = useRef({ visibleRows, dateKey });
  st.current = { visibleRows, dateKey };

  /* ───────── 載入與跨日界線 ───────── */

  // 多選只留畫面上還看得到的（蓋済後還在、刪掉、推走、誤點區收起；回饋乙）
  const visibleKey = visibleRows.map((r) => r.id).join("|");
  useEffect(() => {
    useSelectionStore.getState().prune("today", visibleKey ? visibleKey.split("|") : []);
  }, [visibleKey]);

  // 進頁（與日界線設定變動）就載一次今天
  useEffect(() => {
    void loadToday(todayKey(dayStartHour));
  }, [loadToday, dayStartHour]);

  // 熬夜跨 03:00：每分鐘重算 todayKey，變了就重載（不變就完全不動 store）
  useEffect(() => {
    const timer = setInterval(() => {
      const ns = useNodeStore.getState();
      const key = todayKey(useUiStore.getState().dayStartHour);
      if (key !== ns.today.dateKey) void ns.loadToday(key);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  // 沒人持有焦點時把焦點給今日頁，鍵盤流立刻可用
  useEffect(() => {
    if (document.activeElement === document.body) containerRef.current?.focus();
  }, [containerRef]);

  /* ───────── 小工具 ───────── */
  const ui = () => useUiStore.getState();
  const ns = () => useNodeStore.getState();
  const toast = (message?: string) => {
    if (message) ui().showToast({ message }, 3600);
  };
  const focusContainer = useCallback(() => containerRef.current?.focus(), [containerRef]);
  const visibleIds = () => st.current.visibleRows.map((r) => r.id);
  /** 目前「看得見」的選取列（摺疊起來的誤點列視同無選取） */
  const selRow = (): TodayRow | null => {
    const id = ui().selectedId;
    if (!id) return null;
    const row = ns().today.byId[id];
    return row && visibleIds().includes(id) ? row : null;
  };
  const routeOf = (row: TodayRow): NodeRow | undefined =>
    row.route_id ? routes.find((r) => r.id === row.route_id) : undefined;

  /* ───────── 覆蓋層 ───────── */
  const closeDraft = useCallback(() => {
    setDraft(null);
    focusContainer();
  }, [setDraft, focusContainer]);
  const dismissDraft = useCallback(() => setDraft(null), [setDraft]);

  const openDraft = useCallback(() => {
    setLogTarget(null);
    setDeferTarget(null);
    setDraft({ kind: "today" });
  }, [setDraft]);

  const closeLog = useCallback(() => {
    setLogTarget(null);
    focusContainer();
  }, [focusContainer]);

  const openLog = useCallback(
    (id: string) => {
      setDraft(null);
      setDeferTarget(null);
      setLogTarget(id);
    },
    [setDraft],
  );

  const closeDefer = useCallback(() => {
    setDeferTarget(null);
    focusContainer();
  }, [focusContainer]);

  const openDefer = useCallback(
    (id: string, anchor: HTMLElement | null) => {
      setDraft(null);
      setLogTarget(null);
      // 再點同一枚 chip＝收起來（DeferPopover 的 outside-mousedown 會刻意放過 anchor，把 toggle 留給這裡）
      setDeferTarget((cur) => (cur?.id === id ? null : { id, anchor }));
      useUiStore.getState().select(id);
    },
    [setDraft],
  );

  /* ───────── 完成流（a6／D4：車票純蓋章、列車／車廂蓋章＋完成卡） ───────── */
  const completeRow = async (id: string) => {
    const row = ns().today.byId[id];
    if (!row) return;
    // 運休中的班次：點在運休章上＝**取消運休**（A 原型 :60-62／:1061 的検印輪替「…→運休→空欄」最後一步）。
    // 不能直接蓋済——引擎已把 scheduled_on 推到下一班，這時蓋章會蓋到「下一班」頭上；
    // 要蓋済就再點一次（票面已回到空欄）。取消運休不留痕，故不出收據。
    if (row.occurrence?.status === "skipped") {
      suspendRow(row);
      return;
    }
    if (isRetiredRunRow(row)) {
      toast(RETIRED_RUN_MSG); // 磨光⑦ 評審 #1：不准悄悄解除退役
      return;
    }
    if (isDoneRow(row)) {
      await ns().setCompleted(id, false);
      return;
    }
    const finish = async (cascade: boolean) => {
      setFreshId(id);
      await ns().setCompleted(id, true, cascade ? true : undefined);
      // 動畫結束事件是主要清除點；reduced-motion（animation:none 不發 animationend）用計時器兜底
      setTimeout(() => setFreshId((cur) => (cur === id ? null : cur)), 800);
      if (isTaskKind(row.kind)) ui().setCompleteCardFor(id);
    };
    const open = row.child_total - row.child_done;
    if (open > 0) {
      ui().askConfirm({
        title: `連同 ${open} 個未完成子項一起完成？`,
        body: `「${row.name}」底下未完成的子項會一併蓋上済章。`,
        confirmLabel: "一起完成",
        onConfirm: () => void finish(true),
      });
      return;
    }
    await finish(false);
  };

  /* ───────── 運休（M3 ④ D-④-2；`U`／推遲小卡定期券版共用這一條） ───────── */
  /**
   * 本班運休／取消運休。**只有定期券能運休**（一般任務的「運休」＝清執行日移出今日，
   * 票走了章無處蓋——按在乘車券上只吐一句 REPEAT_ONLY_MSG，不做任何事）。
   * 是不是定期券只認 parseRule；退役的定期券（status='done'）由 store 那一層擋下、原句 toast。
   */
  const suspendRow = (row: TodayRow) => {
    if (!parseRule(row.repeat_rule)) {
      toast(REPEAT_ONLY_MSG);
      return;
    }
    const skip = row.occurrence?.status !== "skipped"; // 已運休＝取消運休，其餘＝運休
    void ns()
      .skipOccurrence(row.id, skip)
      .then((r) => {
        if (!r.ok) toast(r.reason);
      });
  };

  /**
   * Shift+Enter＝開無日期的建票列（建好立刻離開今日、流入收件匣資料態；種子動線 M3-6 之一）。
   * 同一條建票列（quickadd/QuickAddRow）、只換預設（無日期）——沒有標題就沒有票可建，
   * 所以不是「按下去直接生一筆」，而是「打完 Enter 就進收件匣」；建成後的「復原」收據由建票列自己出。
   */
  const createInboxTicket = useCallback(() => {
    setLogTarget(null);
    setDeferTarget(null);
    setDraft({ kind: "inbox" });
  }, [setDraft]);

  /* ───────── 刪除流（a11／D3：soft delete＋undo） ───────── */
  const deleteRow = (id: string) => {
    if (!ns().today.byId[id]) return;
    // 確認與 toast 在共用流程（失物招領 §5-6）；這裡只管刪後選哪一列
    void confirmAndDeleteNode(id, {
      around: async (del) => {
        const ids = visibleIds();
        const i = ids.indexOf(id);
        const next = ids[i + 1] ?? (i > 0 ? ids[i - 1] : null) ?? null;
        if (await del()) ui().select(next);
      },
    });
  };

  /* ───────── 今日手動序（r7；拖曳與 Alt+↑↓ 共用 moveToday） ───────── */
  const moveTo = (id: string, index: number) => {
    void ns()
      .moveToday(id, index)
      .then((r) => {
        if (!r.ok) toast(r.reason);
      });
  };

  /**
   * Alt+↑↓ 為什麼不能動（null＝能動）——鍵盤與 ⋯「上移／下移」共用（回饋甲 D-主-134）：
   * 誤點區不排序；主線②（D-主-10）有時刻的票照時刻排、不能手排（手排座標＝沒時刻的 today 列）；到頂／到底。
   */
  const reorderWhy = (row: TodayRow, delta: -1 | 1): string | null => {
    if (row.bucket !== "today") return `誤點區的車票不能排序——按 ${capsOfHotkey("today.schedule.today")} 可排進今天`;
    if (timeOfRow(row) !== null) return TIME_FIXED_ORDER_MSG;
    const rs = ns().today.rows;
    if (!manualOrderIds(rs).includes(row.id)) return null;
    if (manualStepTarget(rs, row.id, delta, ui().todayHideDone) === null) return delta < 0 ? "已經在最上面" : "已經在最下面";
    return null;
  };

  /* ───────── 鍵盤動作表 ───────── */
  const keys: TodayKeyActions = {
    moveSelection(delta) {
      const ids = visibleIds();
      if (!ids.length) return;
      const i = ids.indexOf(ui().selectedId ?? "");
      const j = i < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(Math.max(i + delta, 0), ids.length - 1);
      ui().select(ids[j]);
    },
    reorderSelected(delta) {
      const row = selRow();
      if (!row) return;
      const why = reorderWhy(row, delta);
      if (why) {
        toast(why);
        return;
      }
      const at = manualStepTarget(ns().today.rows, row.id, delta, ui().todayHideDone);
      if (at !== null) moveTo(row.id, at);
    },
    completeSelected() {
      const row = selRow();
      if (row) void completeRow(row.id);
    },
    openDraft,
    createInboxTicket,
    scheduleSelected(offset) {
      const row = selRow();
      if (!row) return;
      const key = st.current.dateKey;
      const next = offset ? addDays(key, 1) : key;
      // 定期券：這一列那一班改到今天／明天（⑥ D-主-295；班次日同 timeOfRow）；已交代的由 moveRunFlow 回原因
      if (parseRule(row.repeat_rule)) {
        const from = row.occurrence?.due_on ?? row.scheduled_on;
        if (from) void moveRunFlow(row.id, from, next);
        else toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      const prev = scheduleSnapshot(row);
      void ns().reschedule(row.id, next);
      // `T` 排今天＝票就在眼前，不需要收據；`Shift+T` 票當場消失 → 補一張可反悔的收據（與推遲小卡同款）
      if (next !== key) showRescheduleToast(row.id, prev, next);
    },
    openPanel() {
      if (!ui().selectedId) return;
      ui().setPanelOpen(true);
    },
    openLogForSelected() {
      const row = selRow();
      if (row) openLog(row.id);
    },
    suspendSelected() {
      const row = selRow();
      if (row) suspendRow(row);
    },
    deleteSelected() {
      const row = selRow();
      if (row) deleteRow(row.id);
    },
    escape() {
      if (draftRef.current) return closeDraft();
      if (deferTarget) return closeDefer();
      if (logTarget) return closeLog();
      if (clearIfAny("today")) return; // 回饋乙：覆蓋層之後、收側板之前先清多選
      ui().setPanelOpen(false);
    },
    selectAll() {
      selectAll("today", visibleIds());
    },
    extendSelection(delta) {
      const next = extendBy("today", delta, visibleIds(), ui().selectedId);
      if (next) ui().select(next);
    },
    // 別線的今日鍵（插槽 todayRowActions 的 hotkeys，接縫 #66）：沒有線處理或沒選中列 ⇒ false＝鍵照常放行
    lineHotkey(id) {
      const fn = lineTodayHotkey(id);
      const row = selRow();
      if (!fn || !row) return false;
      fn(row.id);
      return true;
    },
  };

  /* ───────── 滑鼠動作表 ───────── */
  const row: TodayRowActions = {
    select: (id) => ui().select(id),
    complete: (id) => void completeRow(id),
    openPanel: (id) => {
      ui().select(id);
      ui().setPanelOpen(true);
    },
    openDefer,
    focusContainer,
    pick: (id, e) => {
      if (pickClick("today", id, visibleIds(), e, ui().selectedId)) return true;
      // 回饋甲 D-主-132：單擊票面＝選中＋開詳情側板（章、⋯、chip 這些控件不開；拖曳不開——見 openOnClick）
      armOpenOnClick(e, () => {
        if (ui().selectedId === id) ui().setPanelOpen(true);
      });
      return false;
    },
  };

  /* ───────── 列的 ⋯ 選單（UI 丙-3 A5） ───────── */
  /**
   * 項目順序＝契約 A5：発車・推遲・選日期…・移動到…・記乘務記錄・運休・詳情・刪除（赭、最後、虛線隔開）。
   * 依列的情形增減，讓一張卡最多 7 項（規範 §2.4 PopMenu ≤7）：
   *   発車  ＝有線登記 `timetable.today.depart` 才有（時刻表沒通車＝沒有這項）；已交代（済／運休）停用。
   *   推遲  ＝誤點／締切段給「推遲到今天」（T），今天的票給「推遲到明天」（Shift+T）——同一張票只給一項，另一項在「選日期…」裡。
   *           已交代（済／運休）的推遲與「選日期…」都不給（要先取消）。
   *           定期券改的是這一班（⑥ D-主-295）：字換成「這一班改到今天／明天」「這一班改到…」，後面緊接「運休／取消運休」（U）。
   *   移動到…＝選中＋開側板＋側板開挑選器（requestMoveTo，挑選器只有側板一個家）。
   * 每一項先選中該列、焦點交回今日容器，再走鍵盤表同一條路（大綱 run() 模式）；會開覆蓋層的（記錄列、推遲小卡、側板）由覆蓋層自己搶焦點。
   */
  const menuFor = (r: TodayRow, anchor: HTMLElement | null): PopMenuItem[] => {
    const run = (fn: () => void) => () => {
      ui().select(r.id);
      focusContainer();
      fn();
    };
    const teiki = parseRule(r.repeat_rule) !== null;
    const items: PopMenuItem[] = [];
    const depart = lineTodayHotkey(DEPART_HOTKEY);
    if (depart) {
      items.push({
        key: "depart",
        label: "発車",
        hotkeyId: DEPART_HOTKEY,
        disabled: isSettledRow(r),
        why: "這張已經交代了",
        onSelect: run(() => depart(r.id)),
      });
    }
    // 已交代（済／運休）的不給改期項——跟手機 pickDay、行程表 ⋯ 同一把尺（主人真機抓過「蓋済章了還能推遲到明天」）
    if (!isSettledRow(r)) {
      const verb = teiki ? "這一班改到" : "推遲到";
      items.push(
        r.bucket === "today"
          ? { key: "tomorrow", label: `${verb}明天`, hotkeyId: "today.schedule.tomorrow", onSelect: run(() => keys.scheduleSelected(1)) }
          : { key: "today", label: `${verb}今天`, hotkeyId: "today.schedule.today", onSelect: run(() => keys.scheduleSelected(0)) },
        { key: "pick-date", label: teiki ? "這一班改到…" : "選日期…", onSelect: run(() => openDefer(r.id, anchor)) },
      );
    }
    if (teiki) {
      items.push({
        key: "suspend",
        label: r.occurrence?.status === "skipped" ? "取消運休" : "運休",
        hotkeyId: "today.suspend",
        onSelect: run(() => suspendRow(r)),
      });
    }
    // 回饋甲 D-主-134：補「上移／下移」（鏡射 Alt+↑↓；手機票卡 sheet 有，拖曳是加速）——
    // 跟「移動到…」收成「編排 ▾」（手機 sheet 同一組）；做不到時淡掉、滑過看理由（同 reorderWhy）
    const upWhy = reorderWhy(r, -1);
    const downWhy = reorderWhy(r, 1);
    items.push(
      { key: "move", label: "移動到…", group: "編排", onSelect: () => requestMoveTo(r.id) },
      {
        key: "up",
        label: "上移",
        hotkeyId: "today.reorder.up",
        group: "編排",
        disabled: upWhy !== null,
        why: upWhy ?? undefined,
        onSelect: run(() => keys.reorderSelected(-1)),
      },
      {
        key: "down",
        label: "下移",
        hotkeyId: "today.reorder.down",
        group: "編排",
        disabled: downWhy !== null,
        why: downWhy ?? undefined,
        onSelect: run(() => keys.reorderSelected(1)),
      },
      // ⑬ 外部入口：這張票的連結。頂層已經貼著 ≤7，放進「編排 ▾」不多佔一列
      { key: "copy-link", label: "複製連結", group: "編排", onSelect: () => void copyTicketLink(r.id) },
      { key: "log", label: "記乘務記錄", hotkeyId: "today.log", onSelect: run(() => openLog(r.id)) },
      // 回饋乙：多選的可點入口（Ctrl／Shift＋點是加速）；已在多選中＝把這張加進去
      {
        key: "pick",
        label: "選取",
        onSelect: run(() => {
          const sel = useSelectionStore.getState();
          if (sel.scope === "today" && sel.ids.length) {
            if (!sel.ids.includes(r.id)) sel.toggle("today", r.id, visibleIds());
          } else sel.start("today", r.id);
        }),
      },
      { key: "panel", label: "詳情", hotkeyId: "today.panel", onSelect: () => row.openPanel(r.id) },
      { key: "del", label: "刪除", hotkeyId: "today.delete", cut: true, danger: true, onSelect: run(() => deleteRow(r.id)) },
    );
    // 規範 §2.4 一層 ≤7：超過時（有発車又能推遲的票＝8 列）把改期的兩項收進「改期 ▾」群組（PopMenu group，同大綱「編排 ▾」）。
    // 算的是頂層列數（群組算一列）。定期券多一項運休：有発車時收完還超過，就跟著收進去（它緊接在改期兩項後面，群組連得起來）
    if (rowsOf(items).length > 7) {
      for (const it of items) if (it.key === "tomorrow" || it.key === "today" || it.key === "pick-date") it.group = "改期";
      if (rowsOf(items).length > 7) for (const it of items) if (it.key === "suspend") it.group = "改期";
    }
    return items;
  };

  return {
    rows,
    visibleRows,
    dateKey,
    loaded: today.dateKey !== null,
    todayRows,
    lateRows,
    routeOf,

    selectedId,
    select: (id) => ui().select(id),
    moveSel: (dir) => keys.moveSelection(dir),

    draft,
    openDraft,
    closeDraft,
    dismissDraft,

    logTarget,
    openLog,
    closeLog,

    deferTarget,
    openDefer,
    closeDefer,

    complete: (id) => void completeRow(id),
    createInboxTicket,

    lateCollapsed,
    toggleLate: () => void setLateCollapsed(!lateCollapsed),

    moveTo,

    // 磨光⑤ N11：數字走 domain/dayCount（桌機、手機今日、串流、手機行程表同一把尺）
    stats: {
      ...dayCount(todayRows.map(dayCountItem)),
      allDone: rows.length > 0 && rows.every(isSettledRow),
    },

    freshId,
    clearFresh: () => setFreshId(null),
    blocked: draft !== null || logTarget !== null || deferTarget !== null,
    keys,
    row,
    menuFor,
    focusContainer,
  };
}
