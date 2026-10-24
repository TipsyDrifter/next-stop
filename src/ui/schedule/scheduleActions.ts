/**
 * scheduleActions——行程表串流對一列／一張卡的動作（主線車次①；契約 §3.6）。
 *
 * 核心是 `makeScheduleActions(shell)`：純物件、不是 hook——桌機鍵盤在容器層對「選中的那一列」動作，
 * 不能每列掛一個 hook。讀 store 一律 `getState()`（最新值，不吃舊 closure）。
 * `useScheduleActions(nodeId, date)` 是 Plan 原名、包一張卡的 hook（手機串流卡用）：從 calendar 切片取
 * entry／node、算 `dayRowModel`（日曆同一把尺），回綁好的動作。
 *
 * 守門與收據全部沿既有：
 *   済／取消済／取消運休 ＝ DayPopover.tsx:198-225 同款（`canStampRow` 守門、擋下時同一句 toast）
 *   運休             ＝ DayPopover.tsx:228-240（非定期券 REPEAT_ONLY_MSG）
 *   T／Shift+T        ＝ DayPopover.tsx:243-258（定期券 REPEAT_RESCHEDULE_MSG；離開這天出 showRescheduleToast）
 *   改期／清除執行日   ＝ DeferPopover.tsx:174-191（INBOX_TOAST＋復原）；已交代 SETTLED_DEFER_MSG（useMobileToday.ts:31）
 *   建票             ＝ useMobileToday.createTicket 同款（busy 重入鎖、失敗 toast）
 *   時刻（主線② §3.10）＝ setTime：updateNode(id, { scheduled_time, estimate_min? })；setRunTime／clearRunTime：nodeStore 同名入口
 *                       （非定期券 ⇒ TIME_REPEAT_ONLY_MSG）；成功出收據 toast（文案見 timeReceipt），失敗由 store 吐 reason
 * 資料一律經 nodeStore（元件不碰 repository）。今天＝`todayKey(dayStartHour)`，每次呼叫當下算。
 *
 * ── UI 丙-3 ──
 *   F5（E20 手機補記）：`defer` 的分流改用 `mobile/pickDay.ts` 的 planPickDay（與手機今日同一支、有單測）——
 *     挑到今天以前＝補記 `updateNode(id, { scheduled_on }, { backfill: true })`（「已補記到 M/D」＋復原由 nodeStore 出）；
 *     已済／運休與定期券沿用原本兩句守門；今天以後照舊 reschedule＋收據。建票 `createOn` 的過去日守門不動（手機建票補記不在範圍）。
 *   D5（每列 ⋯）：`remove`＝刪除＋toast「復原」（今日 deleteRow 同款；≥5 個子項先問）；`rowMenu`＝串流與日浮層每列 ⋯ 的項目
 *     （推遲／選日期…／移動到…／運休／詳情／刪除，刪除赭字最後）。
 */
import { useMemo } from "react";
import { isTaskKind, parseRule, type NodeRow } from "../../domain";
import { nodeRepo, REPEAT_ONLY_MSG, REPEAT_RESCHEDULE_MSG } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import { canStampRow, dayRowModel, mmdd, type DayRowModel } from "../calendar/DayRow";
import { INBOX_TOAST, showRescheduleToast } from "../today/useTodayController";
import { SETTLED_DEFER_MSG } from "../mobile/useMobileToday";
import { TIME_REPEAT_ONLY_MSG } from "../../domain/scheduledTime";
import { timeReceipt } from "../mobile/MobileTimeSheet";
import { planPickDay } from "../mobile/pickDay";
import { requestMoveTo } from "../common/moveTo";
import type { PopMenuItem } from "../common/PopMenu";

/** 一個動作目標：班次列（日曆同一把尺）或「只在締切日浮出來」的票（手機卡用，§0-1 第 14 條） */
export type ScheduleTarget = { kind: "entry"; row: DayRowModel } | { kind: "due"; node: NodeRow };

export interface ScheduleActions {
  /** 済／取消済／取消運休。entry：canStampRow 守門，擋下時 toast 與 DayPopover.tsx:202-208 同一句；
   *  定期券運休中＝skipOccurrence(id, false, entry.date)；其餘 setCompleted(id, !done)。
   *  桌機：蓋下去且 isTaskKind ⇒ setCompleteCardFor（DayPopover.tsx:224 同款）。
   *  手機：不開完成卡；目標在今日切片（today.byId[id]）且有未完成直屬子項 ⇒ 先 askConfirm（useMobileToday.ts:136-145 同一句）。
   *  回傳是否真的蓋下去（給呼叫端播 fresh 動畫）。 */
  stamp(t: ScheduleTarget): boolean;
  /** U／定期券版 sheet：skipOccurrence(id, !skipped, row.entry.date)；非定期券 ⇒ toast REPEAT_ONLY_MSG；失敗吐 reason */
  suspend(row: DayRowModel): void;
  /** T／Shift+T（桌機）：DayPopover.tsx:243-258 同款（定期券擋 REPEAT_RESCHEDULE_MSG；離開這天就出 showRescheduleToast） */
  scheduleRelative(row: DayRowModel, offset: 0 | 1): void;
  /** 改期（手機 sheet、桌機以外的入口）。分流＝planPickDay（mobile/pickDay.ts）：
   *  已交代 ⇒ SETTLED_DEFER_MSG；定期券 ⇒ REPEAT_RESCHEDULE_MSG；跟現值同一天 ⇒ 不動；
   *  null＝清除執行日：INBOX_TOAST＋復原（DeferPopover.tsx:182-191 同款）；
   *  day < today ⇒ 補記 updateNode(id, { scheduled_on: day }, { backfill: true })（UI 丙-3 F5；收據由 nodeStore 出）；
   *  其餘 reschedule(id, day)＋（day !== today）showRescheduleToast */
  defer(t: ScheduleTarget, day: string | null): void;
  /** 刪除（UI 丙-3 D5）：softDelete＋toast「已刪除『名稱』」＋「復原」（undoDelete）——今日 deleteRow 同款；
   *  列車／車廂底下 ≥5 個子項先 askConfirm（同一句） */
  remove(nodeId: string): void;
  /** 草稿列建票：day < today ⇒ false；busy 重入鎖；createNode({ kind:"ticket", name, parentId:null, scheduledOn: day })；
   *  失敗 toast「新增失敗——請再試一次」 */
  createOn(day: string, name: string): Promise<boolean>;
  /** 桌機 `.`：select(id)＋setPanelOpen(true) */
  openPanel(nodeId: string): void;
  /** 每班／單發票時刻（＋預計）：updateNode(id, { scheduled_time, estimate_min? })；estimateMin 為 undefined＝不送（主線② §3.10） */
  setTime(nodeId: string, time: string | null, estimateMin?: number | null): void;
  /** 定期券本班：setRunTime(nodeId, railDate, time)；非定期券 ⇒ toast TIME_REPEAT_ONLY_MSG */
  setRunTime(nodeId: string, railDate: string, time: string | null): void;
  /** 定期券本班改回每班時刻 */
  clearRunTime(nodeId: string, railDate: string): void;
}

/** DayPopover.tsx:64 的同一句（該檔沒 export；字面照抄） */
const HISTORY_MSG = "過去的班次不能改——只能處理目前的班次";

const nodeOf = (t: ScheduleTarget): NodeRow | undefined => (t.kind === "entry" ? t.row.node : t.node);

export function makeScheduleActions(shell: "desktop" | "mobile"): ScheduleActions {
  const ns = () => useNodeStore.getState();
  const ui = () => useUiStore.getState();
  const today = () => todayKey(ui().dayStartHour);
  const toast = (message?: string) => {
    if (message) ui().showToast({ message }, 3600);
  };
  let busy = false;
  /** 時刻動作只拿到 id：從行程表切片或今日切片找節點（判定期券用；找不到就交給 store 驗） */
  const nodeOfId = (id: string): NodeRow | undefined => ns().calendar.nodes[id] ?? ns().today.byId[id];

  /**
   * 蓋済的共用尾段：手機對今日切片裡有未完成直屬子項的票先問（useMobileToday.ts:136-145 同一句）；
   * 桌機列車／車廂蓋章＋完成卡（a6／D4）。回傳是否「立刻」蓋下去（進確認窗＝還沒蓋，不播 fresh）。
   */
  const complete = (node: NodeRow): boolean => {
    const finish = (cascade: boolean) => {
      void ns().setCompleted(node.id, true, cascade ? true : undefined);
      if (shell === "desktop" && isTaskKind(node.kind)) ui().setCompleteCardFor(node.id);
    };
    if (shell === "mobile") {
      const tr = ns().today.byId[node.id];
      const open = tr ? tr.child_total - tr.child_done : 0;
      if (open > 0) {
        ui().askConfirm({
          title: `連同 ${open} 個未完成子項一起完成？`,
          body: `「${node.name}」底下未完成的子項會一併蓋上済章。`,
          confirmLabel: "一起完成",
          onConfirm: () => finish(true),
        });
        return false;
      }
    }
    finish(false);
    return true;
  };

  return {
    stamp(t) {
      const node = nodeOf(t);
      if (!node) return false;
      if (t.kind === "due") {
        // 締切浮出來的單發票：済蓋在票本身（status），沒有班次層的鎖
        if (node.status === "done") {
          void ns().setCompleted(node.id, false);
          return false;
        }
        return complete(node);
      }
      const row = t.row;
      // 鍵盤／手機卡都走同一支 canStampRow，不繞過視覺上的鎖（DayPopover.tsx:202-208 同一句）
      if (!canStampRow(row)) {
        toast(
          row.isRepeat && (row.ahead || row.isFuture)
            ? `這班要到 ${mmdd(row.entry.date)} 才能蓋——済只蓋目前班次`
            : HISTORY_MSG,
        );
        return false;
      }
      if (row.skipped) {
        // 運休中點在章上＝取消運休（検印輪替「…→運休→空欄」最後一步）
        void ns()
          .skipOccurrence(node.id, false, row.entry.date)
          .then((r) => {
            if (!r.ok && r.reason) toast(r.reason);
          });
        return false;
      }
      if (row.done) {
        void ns().setCompleted(node.id, false);
        return false;
      }
      return complete(node);
    },

    suspend(row) {
      const node = row.node;
      if (!node) return;
      if (!row.isRepeat) {
        toast(REPEAT_ONLY_MSG);
        return;
      }
      void ns()
        .skipOccurrence(node.id, !row.skipped, row.entry.date)
        .then((r) => {
          if (!r.ok && r.reason) toast(r.reason);
        });
    },

    scheduleRelative(row, offset) {
      const node = row.node;
      if (!node) return;
      if (row.isRepeat) {
        toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      const t = today();
      const next = offset ? addDays(t, 1) : t;
      const prev = { scheduled_on: node.scheduled_on, carried_from: node.carried_from };
      void ns().reschedule(node.id, next);
      // 票離開這一天＝這一列當場消失 → 補一張可反悔的收據（同推遲小卡）
      if (next !== row.entry.date) showRescheduleToast(node.id, prev, next);
    },

    defer(t, day) {
      const node = nodeOf(t);
      if (!node) return;
      // 分流與手機今日同一支（pickDay.ts，有單測）：済／運休→定期券兩道守門照舊；UI 丙-3 F5：過去日＝補記（磨光⑦ D-主-67）
      const plan = planPickDay({
        target: day,
        today: today(),
        current: node.scheduled_on,
        settled: t.kind === "entry" ? t.row.done || t.row.skipped : node.status === "done",
        repeat: t.kind === "entry" ? t.row.isRepeat : parseRule(node.repeat_rule) !== null,
      });
      switch (plan.kind) {
        case "blocked":
          toast(plan.why === "settled" ? SETTLED_DEFER_MSG : REPEAT_RESCHEDULE_MSG);
          return;
        case "noop":
          return;
        case "clear": {
          // 清除執行日＝流入收件匣資料態；toast 與 Shift+Enter 同一句，「復原」把原執行日放回去
          const prev = node.scheduled_on;
          void ns().reschedule(node.id, null);
          ui().showToast({
            message: INBOX_TOAST,
            actionLabel: "復原",
            onAction: () => void ns().reschedule(node.id, prev),
          });
          return;
        }
        case "backfill":
          // 補記：同一個交易裡済在那一天；收據「已補記到 M/D」＋復原由 nodeStore.showBackfillToast 出
          void ns().updateNode(node.id, { scheduled_on: plan.day }, { backfill: true });
          return;
        case "reschedule": {
          const prev = { scheduled_on: node.scheduled_on, carried_from: node.carried_from };
          void ns().reschedule(node.id, plan.day);
          if (plan.receipt) showRescheduleToast(node.id, prev, plan.day);
          return;
        }
      }
    },

    remove(nodeId) {
      const name = nodeOfId(nodeId)?.name ?? "";
      const run = async () => {
        const removed = await ns().deleteNode(nodeId);
        if (!removed.length) return; // 失敗：store 已寫 error
        ui().showToast({
          message: `已刪除「${name}」${removed.length > 1 ? `（含 ${removed.length - 1} 個子項）` : ""}`,
          actionLabel: "復原",
          onAction: () => void ns().undoDelete(),
        });
      };
      void (async () => {
        // 子項數（今日 deleteRow 用 child_total；行程表的列不在今日切片，改數路線樹裡的直屬子項——只讀，不寫）
        const node = nodeOfId(nodeId);
        let children = ns().today.byId[nodeId]?.child_total ?? 0;
        if (!children && node && isTaskKind(node.kind) && node.route_id) {
          try {
            const tree = await nodeRepo.listRouteTree(node.route_id);
            children = tree.filter((n) => n.parent_id === nodeId).length;
          } catch {
            children = 0;
          }
        }
        if (children >= 5) {
          ui().askConfirm({
            title: `連同 ${children} 個子項一起刪除？`,
            body: `「${name}」底下的項目也會一併刪除（6 秒內可復原）。`,
            confirmLabel: "刪除",
            danger: true,
            onConfirm: () => void run(),
          });
          return;
        }
        await run();
      })();
    },

    async createOn(day, raw) {
      const name = raw.trim();
      if (!name || busy) return false;
      if (day < today()) return false;
      busy = true;
      try {
        const row = await ns().createNode({ kind: "ticket", name, parentId: null, scheduledOn: day });
        if (!row) {
          toast("新增失敗——請再試一次");
          return false;
        }
        return true;
      } finally {
        busy = false;
      }
    },

    openPanel(nodeId) {
      ui().select(nodeId);
      ui().setPanelOpen(true);
    },

    setTime(nodeId, time, estimateMin) {
      const patch: { scheduled_time: string | null; estimate_min?: number | null } = { scheduled_time: time };
      if (estimateMin !== undefined) patch.estimate_min = estimateMin;
      void ns()
        .updateNode(nodeId, patch)
        .then((r) => {
          if (r.ok) toast(timeReceipt("rule", time));
        });
    },

    setRunTime(nodeId, railDate, time) {
      const node = nodeOfId(nodeId);
      if (node && !parseRule(node.repeat_rule)) {
        toast(TIME_REPEAT_ONLY_MSG);
        return;
      }
      // 失敗時 store 已 showToast(reason)；這裡只補成功的收據
      void ns()
        .setRunTime(nodeId, railDate, time)
        .then((r) => {
          if (r.ok) toast(timeReceipt("run", time));
        });
    },

    clearRunTime(nodeId, railDate) {
      const node = nodeOfId(nodeId);
      if (node && !parseRule(node.repeat_rule)) {
        toast(TIME_REPEAT_ONLY_MSG);
        return;
      }
      void ns()
        .clearRunTime(nodeId, railDate)
        .then((r) => {
          if (r.ok) toast(timeReceipt("reset", null));
        });
    },
  };
}

/**
 * 串流與日浮層每列 ⋯ 的項目（UI 丙-3 D5；視覺規範 §2.6、§3.1-1；今日列 ⋯ 的同一套字）。開卡那一刻才算。
 *   単發票・未交代｜推遲一項（誤點→「推遲到今天」T；今天→「推遲到明天」Shift+T；未來→「提前到今天」T）＋「選日期…」（推遲小卡）
 *   定期券　　　　｜「運休」／「取消運休」（U；歷史班次停用＋說明）——班次由規則排定，不給改期（D-④-3）
 *   一律　　　　　｜「移動到…」（選中＋開側板挑選器）・「詳情」（`.`）・「刪除」（赭字、虛線隔開、最後）
 * 已交代（済／運休）的單發票不給改期項（推遲小卡也會擋；不放一個點了只會吐守門句的項）。
 * `openDefer`＝開推遲小卡，錨在 ⋯ 鈕（呼叫端給；DayPopover／StreamView 各自管小卡的 state）。
 */
export function scheduleRowMenu(
  actions: ScheduleActions,
  row: DayRowModel,
  opts: { today: string; openDefer(): void },
): PopMenuItem[] {
  const node = row.node;
  if (!node) return [];
  const items: PopMenuItem[] = [];
  if (row.isRepeat) {
    const can = row.isCurrent || row.isFuture;
    items.push({
      key: "suspend",
      label: row.skipped ? "取消運休" : "運休",
      hotkeyId: "daylist.suspend",
      disabled: !can,
      why: HISTORY_MSG,
      onSelect: () => actions.suspend(row),
    });
  } else if (!row.done && !row.skipped) {
    const d = row.entry.date;
    items.push(
      d === opts.today
        ? { key: "tomorrow", label: "推遲到明天", hotkeyId: "daylist.schedule.tomorrow", onSelect: () => actions.scheduleRelative(row, 1) }
        : {
            key: "today",
            label: d < opts.today ? "推遲到今天" : "提前到今天",
            hotkeyId: "daylist.schedule.today",
            onSelect: () => actions.scheduleRelative(row, 0),
          },
      { key: "pick", label: "選日期…", onSelect: opts.openDefer },
    );
  }
  items.push(
    { key: "move", label: "移動到…", onSelect: () => requestMoveTo(node.id) },
    { key: "panel", label: "詳情", hotkeyId: "daylist.panel", onSelect: () => actions.openPanel(node.id) },
    { key: "del", label: "刪除", cut: true, danger: true, onSelect: () => actions.remove(node.id) },
  );
  return items;
}

/**
 * Plan 原名：一張卡用（手機串流卡）。從 calendar 切片取 entry／node、算 dayRowModel，回綁好的動作。
 * entry 不在切片裡（視窗剛換、資料還沒到）⇒ row 為 null，動作全部 no-op。
 */
export function useScheduleActions(
  nodeId: string,
  date: string,
): {
  row: DayRowModel | null;
  stamp(): boolean;
  suspend(): void;
  defer(day: string | null): void;
} {
  const calendar = useNodeStore((s) => s.calendar);
  const routes = useNodeStore((s) => s.routes);
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const row = useMemo<DayRowModel | null>(() => {
    const entry = calendar.entries.find((e) => e.date === date && e.node_id === nodeId);
    if (!entry) return null;
    const node = calendar.nodes[nodeId];
    const route = node?.route_id ? routes.find((r) => r.id === node.route_id) : undefined;
    return dayRowModel(entry, node, route, currentOccurrences[nodeId]?.due_on ?? null, todayKey(dayStartHour));
  }, [calendar, routes, currentOccurrences, dayStartHour, nodeId, date]);

  const actions = useMemo(() => makeScheduleActions("mobile"), []);

  return useMemo(
    () => ({
      row,
      stamp: () => (row ? actions.stamp({ kind: "entry", row }) : false),
      suspend: () => {
        if (row) actions.suspend(row);
      },
      defer: (day) => {
        if (row) actions.defer({ kind: "entry", row }, day);
      },
    }),
    [row, actions],
  );
}
