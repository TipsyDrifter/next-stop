/**
 * useMobileToday——今日視圖手機版的狀態機（v1.1.0；WP1）。MobileToday.tsx 只負責畫。
 *
 * 為什麼不直接用桌機的 useTodayController：那支扛的是鍵盤流（選取、Alt+↑↓ 排序、九張動作表）、
 *   三個桌機覆蓋層（草稿列／行內日誌／推遲小卡）與完成卡，手機一個都不要（契約 §2.7 的「不呼叫」清單）。
 *   共用它會把「拖曳排序／側板／完成卡」這些手機沒有的路徑一起帶進來，反而更難讀。
 *   **判準函式不重寫**：isDoneRow／isSettledRow／showRescheduleToast／INBOX_TOAST 一律 import 桌機那一份，
 *   兩殼吃同一把尺（M3 ④ 定期券口徑：活著的定期券看班次結局、其餘看 nodes.status）。
 *
 * 資料唯一入口仍是 nodeStore（元件不碰 repository），動作逐條對應契約 §2.7 的表：
 *   蓋済／取消済／取消運休 → setCompleted／skipOccurrence（含「連同 N 個未完成子項」確認窗）
 *   改期（主線車次① P11）  → `defer(id, target)`：reschedule(target) ＋ showRescheduleToast（帶「復原」）；
 *                            target=null＝清除執行日：INBOX_TOAST＋「復原」放回原執行日（DeferPopover.tsx 同款）
 *   本班運休／取消運休     → `skip(id, skip)`：skipOccurrence(id, skip)（不帶 dueOn＝今日頁口徑）
 *   臨時車票／無日期票     → createNode({ scheduledOn: dateKey | null })，後者附 INBOX_TOAST 的「取消建立」
 *   v1.1.0 的 `deferTomorrow` 已併進 `defer`（⋯ sheet 從一項補成四項＋運休，P11）。
 *   時刻（主線② §3.10）    → `setTime(id, time, est?)`＝updateNode({ scheduled_time, estimate_min? })；
 *                            `setRunTime(id, time)`／`clearRunTime(id)`＝nodeStore 同名入口，班次日＝`occurrence?.due_on ?? scheduled_on`
 *                            （timeOfRow 的 railDate 同一把尺）；成功出收據（timeReceipt），失敗由 store 吐 reason
 *
 * 三條重載時機（手機比桌機多一條）：
 *   ① 進頁與日界線設定變動  → loadToday(todayKey(dayStartHour))
 *   ② 熬夜跨日界線          → 每 60s 比對 todayKey，變了才重載（照抄桌機 useTodayController）
 *   ③ **前景回來**          → visibilitychange→visible 重載。手機 App 會被系統凍在背景數小時甚至過夜，
 *      回來時 ② 的 timer 可能根本沒跑（WebView 背景節流），畫面會停在昨天的清單。
 *      loadToday 內部會先 syncRepeats 再聚合，重載一次就把定期券的班次也推到位。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseRule, type NodeRow } from "../../domain";
import { REPEAT_RESCHEDULE_MSG, type TodayRow } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { isDoneRow, isSettledRow, showRescheduleToast, INBOX_TOAST } from "../today/useTodayController";
import { TIME_REPEAT_ONLY_MSG } from "../../domain/scheduledTime";
import { timeReceipt } from "./MobileTimeSheet";

/** 已蓋済／運休的票按到推遲時的提示（正常情況 UI 不會出這個入口，只是最後一道守門） */
export const SETTLED_DEFER_MSG = "這張票已經蓋済了——先取消済章才能推遲";

export interface MobileTodayApi {
  /** 這份資料算的是哪一天（依日界線） */
  dateKey: string;
  /** 今天的列車（bucket==='today'） */
  todayRows: TodayRow[];
  /** 誤點區（late＝有執行日已過／due＝締切已到但沒排執行日） */
  lateRows: TodayRow[];
  /** 完全沒有任何一列（空狀態判斷） */
  empty: boolean;
  routeOf(row: TodayRow): NodeRow | undefined;
  /** 頁首統計（口徑同桌機 c.stats：運休也算「已交代」） */
  stats: { total: number; done: number; left: number };

  /** 済／取消済／取消運休——票右側印章區単擊 */
  complete(id: string): void;
  /** 改期；null＝清除執行日（已交代 ⇒ SETTLED_DEFER_MSG；定期券 ⇒ REPEAT_RESCHEDULE_MSG） */
  defer(id: string, target: string | null): void;
  /** 定期券：本班運休（true）／取消運休（false）——今日頁口徑：不帶 dueOn */
  skip(id: string, skip: boolean): void;
  /** 建票；inbox=true＝無日期票（收件匣）。回傳有沒有建成功（成功才清輸入框） */
  createTicket(name: string, inbox: boolean): Promise<boolean>;
  /** 每班／單發票時刻（＋預計；estimateMin 為 undefined＝不送）。null＝不排時刻（主線②） */
  setTime(id: string, time: string | null, estimateMin?: number | null): void;
  /** 定期券這一班（今日列的班次日）的時刻；null＝本班不排時刻 */
  setRunTime(id: string, time: string | null): void;
  /** 定期券這一班改回每班時刻 */
  clearRunTime(id: string): void;

  /** 剛蓋章的那一列（播 stampIn） */
  freshId: string | null;
}

export function useMobileToday(): MobileTodayApi {
  const today = useNodeStore((s) => s.today);
  const routes = useNodeStore((s) => s.routes);
  const loadToday = useNodeStore((s) => s.loadToday);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const [freshId, setFreshId] = useState<string | null>(null);
  // 建票重入鎖：Enter 連按／「発券」連點在 await 期間會進來兩次，第二次要被擋掉（契約 §2.7）
  const busyRef = useRef(false);

  const dateKey = today.dateKey ?? todayKey(dayStartHour);
  const rows = today.rows;
  const todayRows = rows.filter((r) => r.bucket === "today");
  const lateRows = rows.filter((r) => r.bucket !== "today");

  /* ───────── 載入（三條時機見檔頭）───────── */

  useEffect(() => {
    void loadToday(todayKey(dayStartHour));
  }, [loadToday, dayStartHour]);

  useEffect(() => {
    const timer = setInterval(() => {
      const ns = useNodeStore.getState();
      const key = todayKey(useUiStore.getState().dayStartHour);
      if (key !== ns.today.dateKey) void ns.loadToday(key);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // 無條件重載（不比 dateKey）：背景期間別台裝置／同步可能也動過資料，
      // 何況 loadToday 本身冪等、一次查詢的成本遠低於「畫面停在昨天」的代價。
      void useNodeStore.getState().loadToday(todayKey(useUiStore.getState().dayStartHour));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /* ───────── 小工具 ───────── */

  const ns = () => useNodeStore.getState();
  const ui = () => useUiStore.getState();
  const toast = (message?: string) => {
    if (message) ui().showToast({ message }, 3600);
  };

  const routeOf = useCallback(
    (row: TodayRow): NodeRow | undefined => (row.route_id ? routes.find((r) => r.id === row.route_id) : undefined),
    [routes],
  );

  /* ───────── 蓋済（契約 §2.7 的四個分支；桌機的第五個分支「開完成卡」手機不做）───────── */

  const complete = useCallback((id: string) => {
    const run = async () => {
      const row = ns().today.byId[id];
      if (!row) return;

      // ① 運休中的班次：点在運休章上＝取消運休（不能直接蓋済——引擎已把 scheduled_on 推到下一班）
      if (row.occurrence?.status === "skipped") {
        const r = await ns().skipOccurrence(id, false);
        if (!r.ok) toast(r.reason);
        return;
      }
      // ② 已済＝取消済
      if (isDoneRow(row)) {
        await ns().setCompleted(id, false);
        return;
      }
      // ③④ 蓋済（有未完成直屬子項先問）
      const finish = async (cascade: boolean) => {
        setFreshId(id);
        await ns().setCompleted(id, true, cascade ? true : undefined);
        // 印章動畫 .4s；0.8s 後清旗標（reduced-motion 不發 animationend，故一律用計時器兜底）
        setTimeout(() => setFreshId((cur) => (cur === id ? null : cur)), 800);
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
    void run();
  }, []);

  /* ───────── 改期（⋯ sheet 四項的共同出口；誤點區的票也能推）───────── */

  const defer = useCallback((id: string, target: string | null) => {
    const row = ns().today.byId[id];
    if (!row) return;
    // 已蓋済／運休的票不能推遲（與桌機同款：TodayRow 對 settled 列不出「＋執行日」）——
    // 2026-09-18 主人真機驗收抓到「蓋済章了還能推遲到明天」，UI 隱藏之外這裡再守一道
    if (isSettledRow(row)) {
      toast(SETTLED_DEFER_MSG);
      return;
    }
    // 定期券的班次由規則排定（D-④-3）——擋在 UI 這一層，不讓 store throw
    if (parseRule(row.repeat_rule)) {
      toast(REPEAT_RESCHEDULE_MSG);
      return;
    }
    if (target === null) {
      // 清除執行日＝流入收件匣資料態；toast 與 Shift+Enter 同一句，「復原」把原執行日放回去（DeferPopover.tsx 同款）
      const prevDay = row.scheduled_on;
      void ns().reschedule(id, null);
      ui().showToast({
        message: INBOX_TOAST,
        actionLabel: "復原",
        onAction: () => void ns().reschedule(id, prevDay),
      });
      return;
    }
    const prev = { scheduled_on: row.scheduled_on, carried_from: row.carried_from };
    void ns().reschedule(id, target);
    // 票一改期就離開今日清單，今天唯一的回饋是這張可反悔的收據（與桌機同款）；排回今天不出收據
    const key = ns().today.dateKey ?? todayKey(useUiStore.getState().dayStartHour);
    if (target !== key) showRescheduleToast(id, prev, target);
  }, []);

  /* ───────── 本班運休／取消運休（定期券版 sheet；今日頁口徑不帶 dueOn）───────── */

  const skip = useCallback((id: string, skipIt: boolean) => {
    void ns()
      .skipOccurrence(id, skipIt)
      .then((r) => {
        if (!r.ok) toast(r.reason);
      });
  }, []);

  /* ───────── 時刻（主線②；⋯ sheet → 時刻 sheet 的出口）───────── */

  const setTime = useCallback((id: string, time: string | null, estimateMin?: number | null) => {
    const patch: { scheduled_time: string | null; estimate_min?: number | null } = { scheduled_time: time };
    if (estimateMin !== undefined) patch.estimate_min = estimateMin;
    void ns()
      .updateNode(id, patch)
      .then((r) => {
        if (r.ok) toast(timeReceipt("rule", time));
      });
  }, []);

  /** 今日列的班次日（timeOfRow 同一把尺）；不是定期券 ⇒ toast 並回 null */
  const runDateOf = (id: string): string | null => {
    const row = ns().today.byId[id];
    if (!row) return null;
    if (!parseRule(row.repeat_rule)) {
      toast(TIME_REPEAT_ONLY_MSG);
      return null;
    }
    return row.occurrence?.due_on ?? row.scheduled_on;
  };

  const setRunTime = useCallback((id: string, time: string | null) => {
    const day = runDateOf(id);
    if (!day) return;
    void ns()
      .setRunTime(id, day, time)
      .then((r) => {
        if (r.ok) toast(timeReceipt("run", time));
      });
  }, []);

  const clearRunTime = useCallback((id: string) => {
    const day = runDateOf(id);
    if (!day) return;
    void ns()
      .clearRunTime(id, day)
      .then((r) => {
        if (r.ok) toast(timeReceipt("reset", null));
      });
  }, []);

  /* ───────── 建票（臨時券排今天／無日期票進收件匣）───────── */

  const createTicket = useCallback(async (raw: string, inbox: boolean): Promise<boolean> => {
    const name = raw.trim();
    if (!name || busyRef.current) return false;
    busyRef.current = true;
    try {
      const row = await ns().createNode({
        kind: "ticket",
        name,
        parentId: null,
        scheduledOn: inbox ? null : (ns().today.dateKey ?? todayKey(useUiStore.getState().dayStartHour)),
      });
      if (!row) {
        toast("新增失敗——請再試一次");
        return false;
      }
      if (inbox) {
        // 無日期票立刻離開今日（沒有執行日就不在聚合裡），畫面什麼都不會發生 →
        // toast 是唯一的收據，且要能反悔（沿桌機 Shift+Enter 契約）
        ui().showToast({
          message: INBOX_TOAST,
          actionLabel: "取消建立",
          onAction: () => void ns().deleteNode(row.id),
        });
      }
      return true;
    } finally {
      busyRef.current = false;
    }
  }, []);

  return {
    dateKey,
    todayRows,
    lateRows,
    empty: rows.length === 0,
    routeOf,
    stats: {
      total: todayRows.length,
      done: todayRows.filter(isDoneRow).length,
      left: todayRows.length - todayRows.filter(isSettledRow).length,
    },
    complete,
    defer,
    skip,
    createTicket,
    setTime,
    setRunTime,
    clearRunTime,
    freshId,
  };
}
