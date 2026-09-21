/**
 * DayPopover——當日清單浮層「班次／締切」兩段（M3 ⑤ WP3）。
 *
 * 視覺真相＝prototypes/m3-ext-calendar.html :577-698（`.pop／.pop-head／.pop-sec／.prow／.roundel-s／
 * .defer／.stamp-s／.seal-s／.sime-g／.noexec／.due-tag／.empty-note`）＋ :1054-1143
 * （popHTML／placePop／bindPop）。DOM 與 class 逐字，只換資料與事件；一列怎麼畫在 ./DayRow.tsx。
 *
 * 段名依日子換前綴：今天＝「今日班次／今日締切」，其餘＝「當日…」（原型 :1058）。
 * 締切段只在有締切時出現；班次段永遠在，空的時候出「— 無班次」（:1070）。
 *
 * 可操作邊界（拍板 D-⑤-2 ⚡修訂，唯一一處判斷在 `dayRowModel`）：
 *   - 済：**只蓋目前班次**（`scheduled_on`／`currentOccurrences[id].due_on`，見 dayRowModel）。未來班次的検印欄是不可點的空欄，
 *     hover 講明「這班要到 M/D 才能蓋」；歷史班次唯讀（D-⑤-3）。
 *   - 運休：**目前與未來班次都可以**（提前請假）＝`skipOccurrence(id, skip, entry.date)`；
 *     歷史班次由 store 擋下並吐原句（REPEAT_FUTURE_ONLY_MSG）。
 *   - 改期：定期券一律擋在 UI 這一層（REPEAT_RESCHEDULE_MSG），不讓 repository throw。
 *
 * 鍵盤（D-⑤-4；IME 三道護欄照 useTodayKeyboard.ts:50-62）：
 *   ↑↓ 移動（班次段→締切段連成一圈）・Space 済・T／Shift+T 排今天／明天（單發票）・
 *   U 運休／取消運休・`.` 開側板・Esc 關閉。小卡開著時整張表停用（小卡自己吃鍵，含 Esc）。
 *
 * 定位（:1097-1108）：格下方 10px、放不下翻到格上方、左右夾在視窗內 8px；`position:fixed`，
 *   捲動即關（CalendarView 的 onScroll）。列多到超出視窗時浮層自己捲（daypop.css 的 max-height；
 *   React 17+ 的 onScroll 不冒泡，卡內捲不會觸發外層那條「捲動即關」）。點外關閉——但三處放過：
 *   `.cell.in`（讓格自己換日，:1141）、推遲小卡開著時（小卡自己會先收）、toast（收據的「復原」要按得到）。
 *   側板一開就收浮層（`.`／小卡的編輯規則）——覆蓋層不跟著版面重排，見 openPanel 的註。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { isTaskKind } from "../../domain";
import { WEEKDAY_LABEL } from "../../domain";
import { REPEAT_ONLY_MSG, REPEAT_RESCHEDULE_MSG } from "../../data";
import { addDays } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { isEditableTarget } from "../shell/hotkeys";
import { DeferPopover, type DeferRow } from "../today/DeferPopover";
import { showRescheduleToast } from "../today/useTodayController";
import { DayRow, DueRow, canStampRow, dayRowModel, mmdd, type DayRowModel } from "./DayRow";
import { dateOf, useCalendar } from "./useCalendarController";
import "./daypop.css";

export interface DayPopoverProps {
  /** YYYY-MM-DD */
  day: string;
  /** 定位錨＝被點的那一格（或格角〆） */
  anchor: HTMLElement | null;
  onClose(): void;
}

/** 浮層寬（原型 :580 與 :1100 同值）／與格的間距／與視窗邊的留白 */
const POP_W = 332;
const GAP = 10;
const EDGE = 8;

/** 歷史班次唯讀（D-⑤-3）——鍵盤按在那種列上時的一句 */
const HISTORY_MSG = "歷史班次唯讀——只能交代目前班次";

const ns = () => useNodeStore.getState();
const ui = () => useUiStore.getState();
const toast = (message: string) => ui().showToast({ message }, 3600);

/** 快捷鍵指引的兩條路：`?`（導航模式限定）／Ctrl+/（連輸入框裡都算）——浮層開著時要一起擋 */
function isGuideKey(e: KeyboardEvent<HTMLElement>): boolean {
  if (e.key === "?") return !isEditableTarget(e.target);
  return e.key === "/" && (e.ctrlKey || e.metaKey);
}

export function DayPopover({ day, anchor, onClose }: DayPopoverProps) {
  const { byDate, nodes, routeOf, today } = useCalendar();
  // 「這一列在講的是不是這一班」＝ store 的目前班次表（大綱／側板／今日列同一把尺；
  // 日曆頁由 loadCalendar 一起載，直接開 ?page=calendar 也有）
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [deferTarget, setDeferTarget] = useState<{ key: string; anchor: HTMLElement | null } | null>(null);

  const entries = byDate.entries[day];
  const dueList = byDate.dues[day];

  /* ───────── 兩段的列 ───────── */
  const rows = useMemo<DayRowModel[]>(
    () =>
      (entries ?? []).map((e) =>
        dayRowModel(e, nodes[e.node_id], routeOf(e.node_id), currentOccurrences[e.node_id]?.due_on ?? null, today),
      ),
    [entries, nodes, routeOf, currentOccurrences, today],
  );
  const dues = useMemo(() => dueList ?? [], [dueList]);

  /** 鍵盤走訪的順序：班次段在前、締切段在後（締切列唯讀，只有 `.` 有作用） */
  const keys = useMemo(
    () => [...rows.map((r) => r.key), ...dues.map((d) => `due-${d.date}-${d.node_id}`)],
    [rows, dues],
  );

  const [selKey, setSelKey] = useState<string | null>(() => keys[0] ?? null);
  const lastIndex = useRef(0);
  const deferRef = useRef<typeof deferTarget>(null);
  deferRef.current = deferTarget;
  const keysRef = useRef(keys);
  keysRef.current = keys;

  // 換一天＝落點回到第一列（同一個元件實例會被 React 重用，useState 的初始值不會重算）
  useEffect(() => {
    lastIndex.current = 0;
    setSelKey(keysRef.current[0] ?? null);
  }, [day]);

  // 列被交代掉／推遲走了就會從清單消失——落點退到「原本那一格附近」，不要跳回第一列
  useEffect(() => {
    if (selKey && keys.includes(selKey)) {
      lastIndex.current = keys.indexOf(selKey);
      return;
    }
    setSelKey(keys[Math.min(lastIndex.current, keys.length - 1)] ?? null);
  }, [keys, selKey]);

  /* ───────── 定位：量完自身高度再落座（原型 placePop :1097-1108） ───────── */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const h = el.offsetHeight;
    if (!anchor) {
      setPos({ top: Math.round(vh * 0.2), left: Math.round((vw - POP_W) / 2) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + GAP;
    if (top + h > vh - EDGE) top = r.top - h - GAP; // 放不下＝翻到格上方
    if (top < EDGE) top = EDGE;
    // 先右邊界後左邊界：視窗比浮層還窄時（極小視窗／面板收起時量到 0）也不會被推到負座標
    const left = Math.max(EDGE, Math.min(r.left, vw - POP_W - EDGE));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [anchor, day, rows.length, dues.length]);

  /* ───────── 焦點：落在選取的那一列（roving tabIndex；沒有列就落在浮層本身） ─────────
   * 排進 macrotask 而不是直接 focus：開浮層的那一個 commit 裡，控制器的「焦點跟著 selectedDay 走」
   * effect（useCalendarController，父層 effect 跑在子層之後）會把焦點搶回格上；等這一輪 effect
   * 全跑完才輪到我們。**不用 rAF**——分頁在背景時 rAF 不發（焦點就永遠不會落到列上）。 */
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (deferRef.current) return; // 小卡開著＝焦點歸它
      const host = ref.current;
      if (!host) return;
      const el = selKey ? host.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(selKey)}"]`) : null;
      const target = el ?? host;
      if (document.activeElement !== target) target.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [selKey, day]);

  /* ───────── 點外關閉（原型 :1140-1142） ───────── */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (deferRef.current) return; // 推遲小卡開著：這一下是小卡的（它自己會收）
      if (t instanceof Element && t.closest(".cell.in")) return; // 點格＝換日，交給格
      // toast 是浮層自己吐出來的收據（推遲／T 的「已推到 M/D｜復原」）——mousedown 先關浮層的話，
      // 等 click 打到「復原」時票是回來了、浮層已不在，動線斷掉。與 `.cell.in` 同一條例外。
      if (t instanceof Element && t.closest('[role="status"]')) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  /* ───────── 側板一開就收浮層（同上；小卡的「編輯重複規則…」也走這條） ───────── */
  const panelOpen = useUiStore((s) => s.panelOpen);
  const hadPanel = useRef(panelOpen);
  useEffect(() => {
    // 只認「關→開」那一次：開浮層前側板就開著的話不能自動收（不然那種版面根本開不了浮層）
    if (panelOpen && !hadPanel.current) onClose();
    hadPanel.current = panelOpen;
  }, [panelOpen, onClose]);

  /* ───────── 動作 ───────── */

  /** 剛蓋的章播 stampIn；reduced-motion 不發 animationend，用計時器兜底（同 useTodayController） */
  const markFresh = (key: string) => {
    setFreshKey(key);
    setTimeout(() => setFreshKey((cur) => (cur === key ? null : cur)), 800);
  };

  /** 検印欄：運休中＝取消運休；其餘＝済／取消済（定期券只蓋目前班次） */
  const stamp = useCallback((row: DayRowModel) => {
    const node = row.node;
    if (!node) return;
    // 鍵盤的 Space 走同一支 `canStampRow`，不繞過鈕上那把鎖（歷史班次的運休也不能在這裡撤）
    if (!canStampRow(row)) {
      toast(
        row.isRepeat && (row.ahead || row.isFuture)
          ? `這班要到 ${mmdd(row.entry.date)} 才能蓋——済只蓋目前班次`
          : HISTORY_MSG,
      );
      return;
    }
    if (row.skipped) {
      // 運休中點在章上＝取消運休（A 原型 :60-62 的検印輪替「…→運休→空欄」最後一步）
      void ns()
        .skipOccurrence(node.id, false, row.entry.date)
        .then((r) => {
          if (!r.ok && r.reason) toast(r.reason);
        });
      return;
    }
    // 走到這裡必是目前班次（canStampRow 放行、又不是運休中）
    const next = !row.done;
    if (next) markFresh(row.key);
    void ns().setCompleted(node.id, next);
    // 車票純蓋章；列車／車廂走完成卡（a6／D4，與今日頁同一條）
    if (next && isTaskKind(node.kind)) ui().setCompleteCardFor(node.id);
  }, []);

  /** U：本班運休／取消運休（目前與未來班次都可以；歷史班次由 store 擋下並吐原句） */
  const suspend = useCallback((row: DayRowModel) => {
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
  }, []);

  /** T／Shift+T：排今天／明天（單發票；定期券的班次由規則排定） */
  const schedule = useCallback(
    (row: DayRowModel, offset: 0 | 1) => {
      const node = row.node;
      if (!node) return;
      if (row.isRepeat) {
        toast(REPEAT_RESCHEDULE_MSG);
        return;
      }
      const next = offset ? addDays(today, 1) : today;
      const prev = { scheduled_on: node.scheduled_on, carried_from: node.carried_from };
      void ns().reschedule(node.id, next);
      // 票離開這一天＝畫面上這一列當場消失 → 補一張可反悔的收據（同推遲小卡）
      if (next !== day) showRescheduleToast(node.id, prev, next);
    },
    [today, day],
  );

  /**
   * `.` 開側板＝**順手收掉浮層**：浮層是暫態覆蓋層、座標是開的那一刻量的，側板一開主欄收窄、
   * 格子整排移位，留著就會與錨格錯開，六／日欄那幾格還會壓在側板左緣上（浮層 z 60 > 側板 z 2）。
   * 按 `.` 的當下注意力已經移到側板了（今日頁的列表留著，是因為列表不是覆蓋層）。
   */
  const openPanel = useCallback(
    (nodeId: string) => {
      ui().select(nodeId);
      ui().setPanelOpen(true);
      onClose();
    },
    [onClose],
  );

  const openDefer = useCallback((row: DayRowModel, el: HTMLElement) => {
    setSelKey(row.key);
    // 再點同一顆＝收起來（與今日列的 chip 同一個 toggle 語義）
    setDeferTarget((cur) => (cur?.key === row.key ? null : { key: row.key, anchor: el }));
  }, []);

  const closeDefer = useCallback(() => {
    setDeferTarget(null);
    const host = ref.current;
    const el = selKey ? host?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(selKey)}"]`) : null;
    (el ?? host)?.focus();
  }, [selKey]);

  /** 小卡要的那一列（NodeRow ＋ 這一列在講的那一班；契約見 DeferPopover 的 DeferRow） */
  const deferRow = useMemo<DeferRow | null>(() => {
    if (!deferTarget) return null;
    const row = rows.find((r) => r.key === deferTarget.key);
    if (!row?.node) return null;
    const st = row.entry.occurrence_status;
    return {
      ...row.node,
      occurrence: st ? { id: `${row.node.id}:${row.entry.date}`, status: st, due_on: row.entry.date } : null,
      // 這一列講的是「那一天那一班」，一定要明講——沒有結局時 occurrence 是 null，
      // 小卡沒有別的地方看得出班次日，會退回 store 的「今天那一班」而運休到別班（must 2）
      railDate: row.entry.date,
    };
  }, [deferTarget, rows]);

  /* ───────── 鍵盤（護欄照 useTodayKeyboard.ts:50-62） ───────── */
  const move = (delta: 1 | -1) => {
    if (!keys.length) return;
    const i = selKey ? keys.indexOf(selKey) : -1;
    const j = i < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.min(Math.max(i + delta, 0), keys.length - 1);
    setSelKey(keys[j]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // M3 ⑦：浮層開著時 `?`／Ctrl+/ 都不叫快捷鍵指引——這張浮層的開關是本地 state，useGlobalHotkeys 的全域表
    // 看不到它，不擋就會在浮層上再疊一張卡（Esc 互搶）。`?` 只擋導航模式那一下（輸入框裡仍是打字）；
    // Ctrl+/ 連輸入框裡都擋（備援鍵的「輸入框」指視圖裡的行內輸入框，不是浮層裡的）。
    // React 的 stopPropagation 會一路擋到 window（mock 頁實測）。
    if (isGuideKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (isEditableTarget(e.target)) return;
    if (deferTarget) return; // 小卡開著：整張表停用（Esc 也歸它，它自己攔）
    const mod = e.ctrlKey || e.metaKey;
    const alt = e.altKey;
    if (mod || alt) return; // Ctrl+. 等全域鍵一律放行

    const row = selKey ? rows.find((r) => r.key === selKey) : undefined;
    const due = selKey?.startsWith("due-") ? dues.find((d) => `due-${d.date}-${d.node_id}` === selKey) : undefined;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case " ":
        if (row) stamp(row);
        else handled = false;
        break;
      case "t":
      case "T":
        if (row) schedule(row, e.shiftKey ? 1 : 0);
        else handled = false;
        break;
      case "u":
      case "U":
        if (row) suspend(row);
        else handled = false;
        break;
      case ".":
        if (row?.node) openPanel(row.node.id);
        else if (due) openPanel(due.node_id);
        else handled = false;
        break;
      case "Escape":
        onClose();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /* ───────── 畫 ───────── */
  const d = dateOf(day);
  const isToday = day === today;
  const pre = isToday ? "今日" : "當日";
  const headline = `${d.getMonth() + 1}月${d.getDate()}日`;

  return (
    <>
      <div
        ref={ref}
        className="pop on ns-daypop"
        role="dialog"
        aria-label={`${headline}的${pre}清單`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        <div className="pop-head">
          <span className={isToday ? "pd today" : "pd"}>{headline}</span>
          <span className="pw">週{WEEKDAY_LABEL[d.getDay()]}</span>
          <button type="button" className="pop-x" title="關閉（Esc）" aria-label="關閉" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* ═══ 班次段 ═══ */}
        <div className="pop-sec">
          <h4>
            {pre}班次<span className="rule" />
          </h4>
          {rows.length === 0 ? (
            <p className="empty-note">— 無班次</p>
          ) : (
            rows.map((row) => (
              <DayRow
                key={row.key}
                row={row}
                selected={selKey === row.key}
                fresh={freshKey === row.key}
                onFreshEnd={() => setFreshKey((cur) => (cur === row.key ? null : cur))}
                onSelect={() => setSelKey(row.key)}
                onStamp={() => stamp(row)}
                onDefer={(el) => openDefer(row, el)}
              />
            ))
          )}
        </div>

        {/* ═══ 締切段（有締切才出；原型 :1085） ═══ */}
        {dues.length > 0 && (
          <div className="pop-sec due">
            <h4>
              {pre}締切<span className="rule" />
            </h4>
            {dues.map((x) => {
              const key = `due-${x.date}-${x.node_id}`;
              return (
                <DueRow
                  key={key}
                  due={x}
                  node={nodes[x.node_id]}
                  route={routeOf(x.node_id)}
                  selected={selKey === key}
                  onSelect={() => setSelKey(key)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* 推遲小卡（單發票四項／定期券兩項，DeferPopover 內建）。
          刻意放在 `.pop` **之外**：粉彩版 `.pop` 有 backdrop-filter，會變成 fixed 子元素的包含塊，
          小卡量的視窗座標就會錯位。 */}
      {deferTarget && deferRow && (
        <DeferPopover row={deferRow} anchor={deferTarget.anchor} onClose={closeDefer} />
      )}
    </>
  );
}
