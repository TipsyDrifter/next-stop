/**
 * DeferPopover——推遲小卡（M3 ③ WP3；決策 D-③-6 乙、種子動線 M3-6）。
 *
 * 入口：今日列的乘車日 chip（`.chip.chip-btn`）→ useTodayController.openDefer(id, anchor) → TodayView 渲染本元件。
 * 四項（拍板逐字）：**明天／下週一／選日期…／清除乘車日**；票的乘車日存在且不是今天（誤點，或在未來）時，
 * 最前面多一項**今天**（D-主-45；誤點票一步排回今天、未來的票提前到今天；繰越規則由 reschedule 判）。
 *
 * **資料來源＝props 注入的 `row`（M3 ⑤ WP1 解耦，草案 §4-3）**：本元件不查 `today.byId`——
 * 日曆當日清單浮層的列不在今日切片裡。行為零改動；形狀見 `DeferRow`。
 *
 * **定期券版（M3 ④ D-④-3；⑥ D-主-295）**：同一枚 chip、同一張卡，內容整個換掉——定期券沒有「乘車日」可以推或清，
 * 四項改期換成講「這一班」的三項：
 *   〔本班運休／取消運休（依 `row.occurrence.status` 二擇一）〕＋〔這一班改到…（開日期挑選，走 `moveRunFlow`；已交代的班停用）〕
 *   ＋〔編輯重複規則…（＝開側板，與 `.` 同一個去處）〕。
 * 運休直接呼 `nodeStore.skipOccurrence`（與 `U`、側板検印區同一個入口，不經 controller）——
 * 運休的是哪一班由 `row.railDate` 決定（呼叫端明講；沒講才回到 store 的「今天那一班」口徑），
 * 三個入口才會**同語義**（拍板 D-⑤-2 修訂：`U`／浮層鈕／小卡同一句話）。
 * 是不是定期券只認 `parseRule(row.repeat_rule)`——欄位裡是 legacy 自由文字的票走一般版。
 *   改期一律走 `nodeStore.reschedule`（唯一入口：寫 carried_from 繰越章、清 today_position）——
 *   本元件不碰 repository、不自己算繰越。
 *   「清除乘車日」＝票離開今日流入收件匣資料態（M4 開張），toast 與 Shift+Enter 那條種子動線同一句，
 *   並帶「復原」把原乘車日放回去（拍板：清除後 toast 同上、可 undo）。
 *
 * 視覺（**沒有原型**——① 比稿與 C1／C2 都沒畫過 popover）：
 *   照移植規格 §0 鐵律，只拼 techo.css 既有語彙、不自創新視覺元素——
 *   .techo-card 紙卡 ＋ .techo-overline 眉標 ＋ .techo-foot 腳註 ＋ --color-dash 虛線撕線 ＋
 *   「清除乘車日」用赭（--color-late，與誤點／締切同色階）。位置與間距在 common/defer.css。
 *
 * 鍵盤（本卡開著時整張今日鍵盤表停用，見 useTodayKeyboard 的 disabled 分支）：
 *   ↑↓ 在項目間移動・Enter／Space 由按鈕自己啟動・Tab 在卡內循環・Esc 關閉（自己攔並 stopPropagation，
 *   免得冒泡上去被 useTodayKeyboard 的 Esc 護欄再關一次）。點卡外＝關閉；點回原本那枚 chip 讓 chip 自己 toggle。
 *
 * ── UI 丙-2 搬家（契約 §1 #18；2026-10-22）──
 * 用途：推遲小卡（今日列、行程表串流、日曆當日浮層共用）。
 * 規範：視覺規範 §2.4（錨定 popover＝.techo-card＋眉標）、§2.5（日期：挑一天＝共用 DatePicker）、§2.8（看不見結果的改期出 toast＋復原）。
 * ARIA：根 role=dialog＋aria-label（「推遲／定期券」＋票名）；「選日期…」「這一班改到…」aria-expanded；「清除乘車日」沒有乘車日、「這一班改到…」已交代時 disabled＋title 寫原因。
 * 鍵盤：見上（↑↓ 項目間移動、Tab 卡內循環、Esc 自己收不冒泡、? 與 Ctrl+/ 不外漏）。
 * 樣式：common/defer.css（src/index.css 集中 @import；原 today/defer.css 整份搬來，字級改 --fs-*）。
 *   原路徑 today/DeferPopover.tsx 只剩 re-export（呼叫端 import 不動，丙-3～6 再改）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { describeRule, parseRule, type NodeRow, type RepeatRule } from "../../domain";
import { formatDateRangeBadge, isMultiDayTicket } from "../../domain/dateRange";
import type { CurrentOccurrence } from "../../data";
import { scheduleSnapshot, useNodeStore } from "../../store/nodeStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import { isGuideKey } from "../shell/hotkeys";
import { scheduledQuickSet } from "./datePickRules";
import { DatePicker } from "./DatePicker";
import { INBOX_TOAST, showRescheduleToast } from "../today/useTodayController";
import { SETTLED_DEFER_MSG } from "../mobile/useMobileToday";
import { moveRunFlow } from "../outline/nodeFlows";

/**
 * 小卡要的那一列（M3 ⑤ WP1 解耦）——節點欄位＋「這一列在講的那一班」。
 * 今日頁傳 `today.byId[id]`（`TodayRow` 本來就是這個形狀）；
 * 日曆浮層傳 `calendar.nodes[id]` ＋ 由該天的 `ScheduleEntry` 組出來的 occurrence
 * （`{ id, status: occurrence_status, due_on: entry.date }`，沒有結局就 null）。
 */
export type DeferRow = NodeRow & {
  occurrence: CurrentOccurrence | null;
  /**
   * 這一列在講的那一班的**班次日**（M3 ⑤ 修正席 must 2）。給了就原封送進 `skipOccurrence` 當 `dueOn`、「這一班改到…」也改這一班——
   * 日曆浮層一列講的是「那一天那一班」，跟 store 認定的「今天那一班」不一定同一班
   * （今天蓋済後 `scheduled_on` 已指向明天，明天那列的 `occurrence` 又還沒有結局＝null），
   * 沒有這個欄位小卡會運休到別班、或吐「本班已済」。
   * **今日頁不傳**（undefined）＝沿用 store 的班次日口徑（`pickTodayOccurrence`），行為零改動。
   */
  railDate?: string | null;
};

export interface DeferPopoverProps {
  /**
   * 目標列。**由呼叫端注入**，本元件不再自己查 `today.byId`——日曆的列不在今日切片裡（草案 §4-3）。
   */
  row: DeferRow;
  /** 被點的日期 chip（定位錨；鍵盤觸發時為 null） */
  anchor: HTMLElement | null;
  onClose(): void;
}

/** YYYY-MM-DD → 本地 Date（不經 Date.parse，避免 date-only 被當 UTC 而跨日；與 TodayView 同一份做法） */
function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];

function isSaneDateKey(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  return y >= 1900 && y <= 2999;
}

/** 「M/D 週X」——改期收據與定期券本班小卡右側的日期字 */
function whenLabel(key: string): string {
  const d = dateOf(key);
  return `${d.getMonth() + 1}/${d.getDate()} 週${WEEK_ZH[d.getDay()]}`;
}

export function DeferPopover({ row, anchor, onClose }: DeferPopoverProps) {
  const nodeId = row.id;
  const storedKey = useNodeStore((s) => s.today.dateKey);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);
  const dateKey = storedKey ?? todayKey(dayStartHour);

  // 操作 3（互斥）：開啟單張推遲面板時自動退出多選
  useEffect(() => {
    if (useSelectionStore.getState().ids.length) useSelectionStore.getState().clear();
  }, []);

  const rule = parseRule(row.repeat_rule);
  if (rule) {
    return <TeikiDeferCard row={row} rule={rule} dateKey={dateKey} weekStart={weekStart} anchor={anchor} onClose={onClose} />;
  }

  const ns = () => useNodeStore.getState();
  const ui = () => useUiStore.getState();
  const showToday = row.scheduled_on !== null && row.scheduled_on !== dateKey;

  const applyDate = (next: string) => {
    const prev = scheduleSnapshot(row);
    const prevEnd = row.scheduled_end ?? null;
    const prevMulti = row.is_multi_day ?? null;
    void ns().reschedule(nodeId, next, { scheduledEnd: null, isMultiDay: false });
    onClose();
    if (next !== dateKey || showToday || prevEnd !== null) {
      if (prevEnd !== null) {
        ui().showToast({
          message: next === dateKey ? "已排到今天" : `已移至 ${whenLabel(next)}`,
          actionLabel: "復原",
          onAction: () => void ns().updateNode(nodeId, { ...prev, scheduled_end: prevEnd, is_multi_day: prevMulti }),
        });
      } else {
        showRescheduleToast(nodeId, prev, next);
      }
    }
  };

  const applyRange = (start: string, end: string | null, isMultiDay = false) => {
    if (!end || end <= start) {
      applyDate(start);
      return;
    }
    const prev = scheduleSnapshot(row);
    const prevEnd = row.scheduled_end ?? null;
    const prevMulti = row.is_multi_day ?? null;
    void ns().reschedule(nodeId, start, { scheduledEnd: end, isMultiDay });
    onClose();
    ui().showToast({
      message: isMultiDay
        ? `已排入多日 ${formatDateRangeBadge(start, end)}`
        : `已排入期間 ${formatDateRangeBadge(start, end)}`,
      actionLabel: "復原",
      onAction: () => void ns().updateNode(nodeId, { ...prev, scheduled_end: prevEnd, is_multi_day: prevMulti }),
    });
  };

  const clearDate = () => {
    const prev = scheduleSnapshot(row);
    const prevEnd = row.scheduled_end ?? null;
    const prevMulti = row.is_multi_day ?? null;
    void ns().reschedule(nodeId, null);
    onClose();
    ui().showToast({
      message: INBOX_TOAST,
      actionLabel: "復原",
      onAction: () => void ns().updateNode(nodeId, { ...prev, scheduled_end: prevEnd, is_multi_day: prevMulti }),
    });
  };

  // v1.37 2A-1：一般車票／列車淘汰舊版純文字推遲清單，直接渲染統一的 DatePicker（快選膠囊＋乘車日｜期間自由券＋直攤月曆＋清除）
  return (
    <DatePicker
      anchor={anchor}
      centered={!anchor}
      className="ns-qa-pop"
      label="乘車日"
      value={row.scheduled_on}
      endValue={row.scheduled_end}
      isMultiDay={isMultiDayTicket(row)}
      allowRange
      markValue
      min={dateKey}
      today={dateKey}
      quick={scheduledQuickSet(dateKey, weekStart)}
      onPick={(v) => {
        if (!isSaneDateKey(v)) return;
        applyDate(v);
      }}
      onPickRange={(s, e, multi) => {
        if (!isSaneDateKey(s) || (e && !isSaneDateKey(e))) return;
        applyRange(s, e, Boolean(multi));
      }}
      onClear={row.scheduled_on ? clearDate : undefined}
      clearLabel="清除乘車日"
      onClose={onClose}
    />
  );
}

/** 定期券本班調度小卡：本班運休／取消運休、這一班改到…、編輯重複週期… */
function TeikiDeferCard({
  row,
  rule,
  dateKey,
  weekStart,
  anchor,
  onClose,
}: {
  row: DeferRow;
  rule: RepeatRule;
  dateKey: string;
  weekStart: 0 | 1;
  anchor: HTMLElement | null;
  onClose(): void;
}) {
  const nodeId = row.id;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [picking, setPicking] = useState(false);

  const closePicker = useCallback(() => {
    setPicking(false);
    const el = ref.current;
    if (el && el.contains(document.activeElement)) el.querySelector<HTMLElement>("button[aria-expanded]")?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const M = 12;
    if (!anchor) {
      setPos({ top: Math.round(vh * 0.24), left: Math.round((vw - w) / 2) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 8;
    if (top + h > vh - M) top = Math.max(M, r.top - h - 8);
    const left = Math.max(M, Math.min(r.left, vw - w - M));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [anchor, picking]);

  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    ref.current?.querySelector<HTMLButtonElement>("button[data-defer-item]")?.focus();
  }, [pos]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  const ns = () => useNodeStore.getState();
  const ui = () => useUiStore.getState();
  const suspended = row.occurrence?.status === "skipped";
  const railDate = row.railDate ?? row.occurrence?.due_on ?? row.scheduled_on;

  const toggleSuspend = () => {
    onClose();
    void ns()
      .skipOccurrence(nodeId, !suspended, row.railDate ?? undefined)
      .then((r) => {
        if (!r.ok && r.reason) ui().showToast({ message: r.reason }, 3600);
      });
  };

  const moveRun = (to: string) => {
    onClose();
    if (railDate) void moveRunFlow(nodeId, railDate, to);
  };

  const moveWhy = !railDate ? "目前沒有班次" : suspended ? "運休中——先取消運休才能改日期" : row.occurrence ? SETTLED_DEFER_MSG : null;

  const editRule = () => {
    onClose();
    ui().select(nodeId);
    ui().setPanelOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isGuideKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button[data-defer-item]") ?? []).filter(
      (b) => !(b as HTMLButtonElement).disabled,
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === "ArrowDown" ? 1 : -1;
      const j = i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length;
      items[j]?.focus();
    } else if (e.key === "Tab") {
      const focusables = Array.from(
        ref.current?.querySelectorAll<HTMLElement>("button, input") ?? [],
      ).filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);
      if (focusables.length < 2) return;
      const k = focusables.indexOf(document.activeElement as HTMLElement);
      const j = e.shiftKey ? (k <= 0 ? focusables.length - 1 : k - 1) : k >= focusables.length - 1 ? 0 : k + 1;
      e.preventDefault();
      e.stopPropagation();
      focusables[j]?.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`定期券「${row.name}」`}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className={"ns-defer techo-card" + (picking ? " is-picking" : "")}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <p className="techo-overline ns-defer-head">定期券 — TEIKI</p>

      <ul className="ns-defer-list">
        <li>
          <button type="button" data-defer-item className="ns-defer-item" onClick={toggleSuspend}>
            <span>{suspended ? "取消運休" : "本班運休"}</span>
            <span className="when">{railDate ? whenLabel(railDate) : "—"}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            data-defer-item
            aria-expanded={picking}
            disabled={moveWhy !== null}
            title={moveWhy ?? undefined}
            className="ns-defer-item"
            onClick={() => setPicking((o) => !o)}
          >
            <span>這一班改到…</span>
            <span className="when">{railDate ? whenLabel(railDate) : "—"}</span>
          </button>
        </li>
        <li className="cut">
          <button type="button" data-defer-item className="ns-defer-item" onClick={editRule}>
            <span>編輯重複週期…</span>
            <span className="when">{describeRule(rule)}</span>
          </button>
        </li>
      </ul>

      {picking && (
        <div className="ns-defer-pick">
          <DatePicker
            label="這一班改到"
            value={railDate ?? dateKey}
            min={dateKey}
            today={dateKey}
            quick={scheduledQuickSet(dateKey, weekStart)}
            onPick={(v) => {
              if (!isSaneDateKey(v)) return;
              moveRun(v);
            }}
            onClose={closePicker}
          />
        </div>
      )}

      <div className="techo-foot ns-defer-foot">↑↓ 移動・Enter 選・Esc 關閉</div>
    </div>
  );
}
