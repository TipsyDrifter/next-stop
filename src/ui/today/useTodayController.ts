/**
 * useTodayController——今日視圖的狀態機（M3 ③ WP2）：選取、覆蓋層（草稿列／行內日誌／推遲小卡）、
 * 完成流、臨時車票、誤點區摺疊、跨日界線重載，以及鍵盤／滑鼠兩張動作表。TodayView.tsx 只負責畫。
 *
 * 這個檔是 **Wave C 三席（WP3 臨時車票／WP4 行內日誌／WP5 拖曳）的插槽契約**：
 *   draft / openDraft / closeDraft / commitDraft      → TicketDraftRow
 *   logTarget / openLog / closeLog                    → LogInlineInput
 *   deferTarget / openDefer / closeDefer              → DeferPopover
 *   moveTo(id, index)                                 → useTodayDnd
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
 *   單次改期（`T`／`Shift+T`／推遲小卡的日期三項）對定期券一律擋下並吐 REPEAT_RESCHEDULE_MSG。
 *
 * 取捨：
 * - 新增走「本地草稿列 → 提交才 createNode」（空白／Esc 不產生垃圾節點），鏡射 useOutlineController。
 * - 完成流的「連同子項」判斷只看**直屬**子項數（今日列不在 tree 裡，repository 只帶 child_total／child_done）；
 *   確認窗的內文因此不報全子孫數，只說「底下未完成的子項會一併蓋章」。
 * - 跨日界線（a3／D9）：每分鐘重算 todayKey，變了就 loadToday(newKey)。timer 在 effect 內建立與清除，
 *   StrictMode 雙掛載可重入（雷區 5，照 ambience 的 clear 模式）。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isTaskKind, parseRule, type NodeRow } from "../../domain";
import { REPEAT_ONLY_MSG, REPEAT_RESCHEDULE_MSG, type TodayRow } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import type { TodayKeyActions } from "./useTodayKeyboard";
import type { TodayRowActions } from "./TodayRow";

/** 建票草稿列的狀態；kind 是 WP2 追加的旗標（today＝Enter 排今天／inbox＝Shift+Enter 無日期票） */
export interface TodayDraft {
  /** 插在這張票之後；null＝清單末尾 */
  afterId: string | null;
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
export const INBOX_TOAST = "已放進收件匣（M4 開張）——Ctrl+P 找得到";

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
 * 「這一列今天交代過了沒」＝済 **或** 運休（運休也是一種交代，只是結局不是済）。
 * 頁首「還有 N 張」的母數與 1.0d 慶祝吃這一條（D-④-2）。
 */
export function isSettledRow(row: TodayRow): boolean {
  return row.occurrence !== null || row.status === "done";
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
 * （否則反悔完票上會留一枚剛長出來的繰越章）。today_position 不還原——回到今天就是新聚合、尾插。
 * `T` 排今天不出收據：票還在眼前，看得見。
 */
export function showRescheduleToast(
  id: string,
  prev: { scheduled_on: string | null; carried_from: string | null },
  next: string,
): void {
  useUiStore.getState().showToast({
    message: `已推到 ${whenText(next)}`,
    actionLabel: "復原",
    onAction: () =>
      void useNodeStore
        .getState()
        .updateNode(id, { scheduled_on: prev.scheduled_on, carried_from: prev.carried_from }),
  });
}

export interface TodayControllerApi {
  /** 畫面順序（late → due → today）的今日列；誤點區摺疊時仍是完整清單 */
  rows: TodayRow[];
  /** 實際看得見的列（誤點摺疊起來時不含 late／due） */
  visibleRows: TodayRow[];
  /** 這份資料算的是哪一天（依日界線） */
  dateKey: string;
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
  commitDraft(title: string): Promise<void>;

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
  const busyRef = useRef(false);
  const draftRef = useRef<TodayDraft | null>(null);
  const setDraft = useCallback((d: TodayDraft | null) => {
    draftRef.current = d;
    setDraftState(d);
  }, []);

  const dateKey = today.dateKey ?? todayKey(dayStartHour);
  const rows = today.rows;
  const visibleRows = lateCollapsed ? rows.filter((r) => r.bucket === "today") : rows;
  const todayRows = rows.filter((r) => r.bucket === "today");
  const lateRows = rows.filter((r) => r.bucket !== "today");

  // 最新值放 ref，動作函式不吃舊 closure
  const st = useRef({ visibleRows, dateKey });
  st.current = { visibleRows, dateKey };

  /* ───────── 載入與跨日界線 ───────── */

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

  const openDraft = useCallback(() => {
    setLogTarget(null);
    setDeferTarget(null);
    setDraft({ afterId: null, kind: "today" });
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

  /* ───────── 臨時車票（a18–a21／決策 6／M3-6） ───────── */
  const commitDraft = async (text: string) => {
    const d = draftRef.current;
    if (!d || busyRef.current) return;
    const name = text.trim();
    if (!name) {
      closeDraft();
      return;
    }
    busyRef.current = true;
    try {
      const row = await ns().createNode({
        kind: "ticket",
        name,
        parentId: null,
        scheduledOn: d.kind === "inbox" ? null : st.current.dateKey,
      });
      if (!row) {
        setDraft(null);
        toast("新增失敗——請再試一次");
        return;
      }
      if (d.kind === "inbox") {
        setDraft(null);
        focusContainer();
        // 票立刻離開今日（沒有執行日就不在聚合裡），畫面上什麼都不會發生 →
        // toast 是唯一的收據，並且要能反悔（WP3：拍板「可 undo」）。這裡的 undo＝把剛建的票收回去。
        ui().showToast({
          message: INBOX_TOAST,
          actionLabel: "取消建立",
          onAction: () => void ns().deleteNode(row.id),
        });
        return;
      }
      ui().select(row.id);
      setDraft({ afterId: row.id, kind: "today" }); // 連打
    } finally {
      busyRef.current = false;
    }
  };

  /**
   * Shift+Enter＝建一張無日期票（立刻離開今日、流入收件匣資料態；種子動線 M3-6 之一）。
   * 走的是「同款草稿列、只換提示語與提交規則」——沒有標題就沒有票可建，所以不是「按下去直接生一筆」，
   * 而是「打完 Enter 就進收件匣」（WP3 覆核維持這個形狀：無名票只會變成 Ctrl+P 裡找不到的垃圾）。
   * 建成後只有 toast 這一張收據，故 commitDraft 的 inbox 分支帶「取消建立」undo。
   */
  const createInboxTicket = useCallback(() => {
    setLogTarget(null);
    setDeferTarget(null);
    setDraft({ afterId: null, kind: "inbox" });
  }, [setDraft]);

  /* ───────── 刪除流（a11／D3：soft delete＋undo） ───────── */
  const deleteRow = (id: string) => {
    const row = ns().today.byId[id];
    if (!row) return;
    const run = async () => {
      const ids = visibleIds();
      const i = ids.indexOf(id);
      const next = ids[i + 1] ?? (i > 0 ? ids[i - 1] : null) ?? null;
      const removed = await ns().deleteNode(id);
      ui().select(next);
      ui().showToast({
        message: `已刪除『${row.name}』${removed.length > 1 ? `（含 ${removed.length - 1} 個子項）` : ""}`,
        actionLabel: "復原",
        onAction: () => void ns().undoDelete(),
      });
    };
    if (row.child_total >= 5) {
      ui().askConfirm({
        title: `連同底下 ${row.child_total} 個子項一起刪除？`,
        body: `『${row.name}』底下的節點會一起移除；10 秒內可從底部提示復原。`,
        confirmLabel: "刪除",
        danger: true,
        onConfirm: () => void run(),
      });
      return;
    }
    void run();
  };

  /* ───────── 今日手動序（r7；拖曳與 Alt+↑↓ 共用 moveToday） ───────── */
  const moveTo = (id: string, index: number) => {
    void ns()
      .moveToday(id, index)
      .then((r) => {
        if (!r.ok) toast(r.reason);
      });
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
      if (row.bucket !== "today") {
        toast("誤點區的票不能排序——要排上今天請按 T");
        return;
      }
      const ids = ns().today.rows.filter((r) => r.bucket === "today").map((r) => r.id);
      const i = ids.indexOf(row.id);
      const j = i + delta;
      if (i < 0) return;
      if (j < 0 || j >= ids.length) {
        toast(delta < 0 ? "已經在最上面" : "已經在最下面");
        return;
      }
      moveTo(row.id, j);
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
      // 定期券的班次由規則排定（D-④-3）——`T`／`Shift+T` 擋在 UI 這一層，不讓 store throw
      if (parseRule(row.repeat_rule)) {
        toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      const key = st.current.dateKey;
      const next = offset ? addDays(key, 1) : key;
      const prev = { scheduled_on: row.scheduled_on, carried_from: row.carried_from };
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
      ui().setPanelOpen(false);
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
  };

  return {
    rows,
    visibleRows,
    dateKey,
    todayRows,
    lateRows,
    routeOf,

    selectedId,
    select: (id) => ui().select(id),
    moveSel: (dir) => keys.moveSelection(dir),

    draft,
    openDraft,
    closeDraft,
    commitDraft,

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

    stats: {
      total: todayRows.length,
      done: todayRows.filter(isDoneRow).length,
      left: todayRows.length - todayRows.filter(isSettledRow).length,
      allDone: rows.length > 0 && rows.every(isSettledRow),
    },

    freshId,
    clearFresh: () => setFreshId(null),
    blocked: draft !== null || logTarget !== null || deferTarget !== null,
    keys,
    row,
    focusContainer,
  };
}
