/**
 * useMobileToday——今日視圖手機版的狀態機（v1.1.0；WP1）。MobileToday.tsx 只負責畫。
 *
 * 為什麼不直接用桌機的 useTodayController：那支扛的是鍵盤流（選取、Alt+↑↓ 排序、九張動作表）、
 *   三個桌機覆蓋層（草稿列／行內日誌／推遲小卡）與完成卡，手機一個都不要（契約 §2.7 的「不呼叫」清單）。
 *   共用它會把「拖曳排序／側板／完成卡」這些手機沒有的路徑一起帶進來，反而更難讀。
 *   **判準函式不重寫**：isDoneRow／isSettledRow／showRescheduleToast／INBOX_TOAST 一律 import 桌機那一份，
 *   兩殼吃同一把尺（M3 ④ 定期券口徑：活著的定期券看班次結局、其餘看 nodes.status）。
 *
 * 資料唯一入口仍是 nodeStore（元件不碰 repository），四個動作逐條對應契約 §2.7 的表：
 *   蓋済／取消済／取消運休 → setCompleted／skipOccurrence（含「連同 N 個未完成子項」確認窗）
 *   推遲到明天            → reschedule(addDays(dateKey,1)) ＋ showRescheduleToast（帶「復原」）
 *   臨時車票／無日期票     → createNode({ scheduledOn: dateKey | null })，後者附 INBOX_TOAST 的「取消建立」
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
import { addDays, todayKey } from "../../lib/date";
import { isDoneRow, isSettledRow, showRescheduleToast, INBOX_TOAST } from "../today/useTodayController";

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
  /** 推遲到明天（定期券擋下並吐 REPEAT_RESCHEDULE_MSG） */
  deferTomorrow(id: string): void;
  /** 建票；inbox=true＝無日期票（收件匣）。回傳有沒有建成功（成功才清輸入框） */
  createTicket(name: string, inbox: boolean): Promise<boolean>;

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

  /* ───────── 推遲到明天（桌機 Shift+T 同一條路；誤點區的票也能推）───────── */

  const deferTomorrow = useCallback(
    (id: string) => {
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
      const prev = { scheduled_on: row.scheduled_on, carried_from: row.carried_from };
      const next = addDays(ns().today.dateKey ?? todayKey(useUiStore.getState().dayStartHour), 1);
      void ns().reschedule(id, next);
      // 票一改期就離開今日清單，今天唯一的回饋是這張可反悔的收據（與桌機同款）
      showRescheduleToast(id, prev, next);
    },
    [],
  );

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
    deferTomorrow,
    createTicket,
    freshId,
  };
}
