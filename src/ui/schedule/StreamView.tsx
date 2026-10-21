/**
 * StreamView——行程表「串流」排列（主線車次①，桌機；契約 §4.1–4.3）。
 *
 * 只負責把 `useStream` 吐出的 `sections` 畫出來、把容器的 ref／onScroll／onKeyDown 接上；
 * 「串流長什麼樣」（day／gap／edge、邊界、視窗）是 streamModel／useStream 的事，這裡不再判一次。
 *
 * 版面（契約 §4.1）：
 *   div.ns-sch > div.ns-sch-scroll[tabIndex=0]（唯一捲動容器；overflow-anchor 關掉、補償由 useStream 做）
 *     ├─ edge before   div.ns-sch-edge.sec.is-past（不可點）
 *     ├─ day 段        section.ns-sch-day[data-day][data-sec-key]
 *     │    （今日段才有）button.ns-sch-latejump → div.sec 日期標題列 → .ns-sch-rows DayRow×n
 *     │    → （有 dues）.ns-sch-subhead「締切」＋DueRow×n → （draftDay）ul.ticket-list.ns-sch-draft > TicketDraftRow
 *     │    → （今日且全交代）.ns-sch-cheer
 *     ├─ gap／after 邊界  section.ns-sch-run(.is-open)[data-sec-key] > button.sec.ns-sch-run-head ＋（open）逐日 day 段**巢狀**在裡面
 *     └─ footer.page-foot（頁尾畫在捲動內容最後；CalendarView 在串流時不畫自己的）
 *   每一段的根元素都掛 `data-sec-key`、day 段另掛 `data-day`（useStream 的 DOM 契約：spy／補償／goTo 靠它找元素）。
 *   攤開的逐日段巢狀在 run 段裡（原型 runSection 同構）：`.ns-sch-run.is-open > .ns-sch-day .sec` 才縮得進去。
 *
 * 列＝日曆同一把尺：`dayRowModel`／`canStampRow`（DayRow.tsx），動作全部走 `makeScheduleActions("desktop")`
 * （済／運休／T／Shift+T／`.`／建票；守門與收據沿 DayPopover）。推遲鈕／rep 圖示開 `DeferPopover`，
 * 小卡掛在 `.ns-sch-scroll` **之外**（DayPopover.tsx:443-448 的理由：backdrop-filter 會變成 fixed 子元素的包含塊）；捲動即關。
 *
 * 鍵盤（契約 §4.2；在 `.ns-sch-scroll` 上，格層表在串流時只剩 Esc）：IME 三道護欄 → 輸入框自理 → 小卡開著停用 →
 * Ctrl／Cmd／Alt 一律放行。`↑↓`／`Space`／`T`／`Shift+T`／`U`／`.`／`Esc` 查 `resolveHotkey("daylist", e)`
 * （那張表 wired:false，與 DayPopover 同一做法）；`Home` 查 `matches(e, "calendar.today")`；`Enter`（開草稿／攤開區間）
 * 不在登記表裡，本地處理。可選項＝每個 day 段的標題列、該段 DayRow／DueRow、gap／after 的 run-head（before 邊界不可選）；
 * roving tabIndex，焦點跟選取走（DayPopover.tsx:151-161 的 setTimeout(0) 寫法）。
 *
 * 建票（D-主-8／P10）：今天與未來的日期標題列可點（含空白單日、攤開的逐日行）⇒ `setDraftDay(date)` 在該段最後開草稿列；
 * 一次只有一張草稿；過去的標題列不可點（title 講明）。草稿送出成功後清空輸入、草稿列留著（連打）；空白 Enter／Esc 關。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { NodeRow } from "../../domain";
import { dayCount, dayCountParts } from "../../domain/dayCount";
import type { CurrentOccurrence, DueEntry } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { formatChord, isEditableTarget, matches, resolveHotkey } from "../shell/hotkeys";
import { DayRow, DueRow, dayRowModel, mmdd, type DayRowModel } from "../calendar/DayRow";
import { useCalendar } from "../calendar/useCalendarController";
import { DeferPopover, type DeferRow } from "../today/DeferPopover";
import { TicketDraftRow } from "../today/TicketDraftRow";
import { makeScheduleActions } from "./scheduleActions";
import { useScheduleUiStore } from "./scheduleUiStore";
import {
  mdw,
  type StreamDaySection,
  type StreamEdgeSection,
  type StreamGapSection,
  type StreamSection,
} from "./streamModel";
import { useMinuteTick } from "./useMinuteTick";
import { useStream } from "./useStream";
import "./schedule.css";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const MONTH_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/* ───────── 選取鍵（roving tabIndex 的落點；都寫進元素的 data-row-key） ─────────
 *   日期標題列 `h:${date}`　班次列 `${date}-${nodeId}`（＝dayRowModel.key，DayRow 自帶 data-row-key；唯一以數字開頭的鍵）
 *   締切列 `due-${date}-${nodeId}`（DueRow 自帶）　區間列 `run:${section.key}` */
const headKey = (date: string) => `h:${date}`;
const rowKey = (date: string, nodeId: string) => `${date}-${nodeId}`;
const isRowKey = (key: string) => /^\d{4}-\d{2}-\d{2}-/.test(key);
const dueKey = (d: DueEntry) => `due-${d.date}-${d.node_id}`;
const runKey = (s: StreamGapSection | StreamEdgeSection) => `run:${s.key}`;

/** 選取鍵 → 它講的是哪一天（頭／列／締切列；區間列回 null） */
function dateOfKey(key: string): string | null {
  if (key.startsWith("h:")) return key.slice(2);
  if (isRowKey(key)) return key.slice(0, 10);
  if (key.startsWith("due-")) return key.slice(4, 14);
  return null;
}

/** 一段「擁有」的選取鍵（給 memo 用：只把落在這一段裡的 selKey／freshKey 傳進去） */
function keyInDay(key: string | null, s: StreamDaySection): string | null {
  if (!key) return null;
  return dateOfKey(key) === s.date ? key : null;
}

type RunSection = StreamGapSection | StreamEdgeSection;

/** 畫面上的區塊：day／before 邊界／run（gap 或 after 邊界，攤開時把其後的 inRun 逐日段收進來巢狀） */
type Block =
  | { kind: "day"; s: StreamDaySection }
  | { kind: "before"; s: StreamEdgeSection }
  | { kind: "run"; s: RunSection; days: StreamDaySection[] };

function toBlocks(sections: readonly StreamSection[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.kind === "day") {
      out.push({ kind: "day", s });
      continue;
    }
    if (s.kind === "edge" && s.side === "before") {
      out.push({ kind: "before", s });
      continue;
    }
    const days: StreamDaySection[] = [];
    while (i + 1 < sections.length) {
      const n = sections[i + 1];
      if (n.kind !== "day" || !n.inRun) break;
      days.push(n);
      i++;
    }
    out.push({ kind: "run", s, days });
  }
  return out;
}

/* ═══════════════════ 元件 ═══════════════════ */

export function StreamView() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const s = useStream({ shell: "desktop", scrollRef });
  const { nodes, routeOf } = useCalendar();
  const entries = useNodeStore((st) => st.calendar.entries);
  const currentOccurrences = useNodeStore((st) => st.currentOccurrences);
  const draftDay = useScheduleUiStore((st) => st.draftDay);
  const actions = useMemo(() => makeScheduleActions("desktop"), []);

  const [selKey, setSelKey] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [deferTarget, setDeferTarget] = useState<{ key: string; anchor: HTMLElement | null } | null>(null);
  /** 草稿列的 remount 鍵：建票成功就 +1，InlineInput 重掛＝清空並重新聚焦（連打） */
  const [draftSeq, setDraftSeq] = useState(0);

  const { sections, today, late } = s;
  const blocks = useMemo(() => toBlocks(sections), [sections]);

  /* ───────── 可選項（鍵盤走訪順序＝文件順序） ───────── */
  const selKeys = useMemo(() => {
    const out: string[] = [];
    for (const sec of sections) {
      if (sec.kind === "day") {
        out.push(headKey(sec.date));
        for (const r of sec.rows) out.push(rowKey(sec.date, r.entry.node_id));
        for (const d of sec.dues) out.push(dueKey(d));
      } else if (sec.kind === "gap" || sec.side === "after") {
        out.push(runKey(sec));
      }
    }
    return out;
  }, [sections]);

  // 最新值放 ref：鍵盤處理器與計時器不吃舊 closure
  const latest = useRef({ selKey, selKeys, sections, today, draftDay, deferTarget });
  latest.current = { selKey, selKeys, sections, today, draftDay, deferTarget };

  /** 從選取鍵還原那一列（日曆同一把尺；entry 不在切片裡＝null） */
  const rowOf = useCallback(
    (key: string): DayRowModel | null => {
      if (!isRowKey(key)) return null;
      const date = key.slice(0, 10);
      const nodeId = key.slice(11);
      const entry = entries.find((e) => e.date === date && e.node_id === nodeId);
      if (!entry) return null;
      return dayRowModel(entry, nodes[nodeId], routeOf(nodeId), currentOccurrences[nodeId]?.due_on ?? null, today);
    },
    [entries, nodes, routeOf, currentOccurrences, today],
  );

  /* ───────── 選取：列被交代掉／推遲走了就退到附近，不跳回第一列（DayPopover 同款） ───────── */
  const lastIndex = useRef(0);
  useEffect(() => {
    if (!selKey) return;
    const i = selKeys.indexOf(selKey);
    if (i >= 0) {
      lastIndex.current = i;
      return;
    }
    setSelKey(selKeys[Math.min(lastIndex.current, selKeys.length - 1)] ?? null);
  }, [selKeys, selKey]);

  /* ───────── 焦點跟著選取走（macrotask：等控制器那一輪 effect 跑完；不用 rAF——背景分頁不發） ───────── */
  useEffect(() => {
    if (!selKey) return;
    const id = window.setTimeout(() => {
      if (latest.current.deferTarget) return; // 小卡開著＝焦點歸它
      const host = scrollRef.current;
      if (!host) return;
      const el = host.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(selKey)}"]`);
      if (!el) return;
      if (document.activeElement !== el) el.focus({ preventScroll: true });
      // 代驗 F2：Home 把選取改成今日標題列、goToday 的 smooth 還在飛，這裡的 scrollIntoView 會把它截斷在半路。
      // 與 useStream 的錨點補償同一個守門（程式捲動進行中不動 scrollTop）；落點由 goToday 自己負責，選中列必在頂端
      if (streamRef.current.isProgramScrolling()) return;
      el.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(id);
  }, [selKey]);

  /* ───────── 草稿收掉後焦點會掉到 body（輸入框卸載）⇒ 接回選中的那一列／容器，鍵盤流不斷 ───────── */
  useEffect(() => {
    if (draftDay !== null) return;
    const host = scrollRef.current;
    if (!host || document.activeElement !== document.body) return;
    const k = latest.current.selKey;
    const el = k ? host.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(k)}"]`) : null;
    (el ?? host).focus({ preventScroll: true });
  }, [draftDay]);

  /* ───────── 掛載：焦點在 body 或還停在頁首鈕（剛點「串流」）⇒ 給捲動容器，鍵盤流立刻可用 ───────── */
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const active = document.activeElement;
    if (active === document.body || (host.closest(".ns-calendar")?.contains(active) && !host.contains(active))) {
      host.focus({ preventScroll: true });
    }
  }, []);

  /* ───────── 動作 ───────── */

  const markFresh = useCallback((key: string) => {
    setFreshKey(key);
    // reduced-motion 不發 animationend，用計時器兜底（同 DayPopover）
    window.setTimeout(() => setFreshKey((cur) => (cur === key ? null : cur)), 800);
  }, []);
  const onFreshEnd = useCallback((key: string) => setFreshKey((cur) => (cur === key ? null : cur)), []);

  const stamp = useCallback(
    (row: DayRowModel) => {
      if (actions.stamp({ kind: "entry", row })) markFresh(row.key);
    },
    [actions, markFresh],
  );

  const openDefer = useCallback((row: DayRowModel, el: HTMLElement) => {
    setSelKey(rowKey(row.entry.date, row.entry.node_id));
    // 再點同一顆＝收起來（與今日列的 chip 同一個 toggle 語義）
    setDeferTarget((cur) => (cur?.key === row.key ? null : { key: row.key, anchor: el }));
  }, []);

  const closeDefer = useCallback(() => {
    setDeferTarget(null);
    const host = scrollRef.current;
    const k = latest.current.selKey;
    const el = k ? host?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(k)}"]`) : null;
    (el ?? host)?.focus({ preventScroll: true });
  }, []);

  /** 小卡要的那一列（DayPopover.tsx:288-300 同款；railDate＝這一列講的那一天） */
  const deferRow = useMemo<DeferRow | null>(() => {
    if (!deferTarget) return null;
    const row = rowOf(deferTarget.key);
    if (!row?.node) return null;
    const st = row.entry.occurrence_status;
    const occ: CurrentOccurrence | null = st
      ? { id: `${row.node.id}:${row.entry.date}`, status: st, due_on: row.entry.date }
      : null;
    return { ...row.node, occurrence: occ, railDate: row.entry.date };
  }, [deferTarget, rowOf]);

  const select = useCallback((key: string) => setSelKey(key), []);

  /** 點日期標題列（今天與未來）＝在那天底下開草稿（D-主-8；過去由 setDraftDay 再擋一次） */
  const openDraft = useCallback((date: string) => {
    useScheduleUiStore.getState().setDraftDay(date);
  }, []);
  const closeDraft = useCallback(() => useScheduleUiStore.getState().setDraftDay(null), []);
  const commitDraft = useCallback(
    async (date: string, name: string) => {
      if (!name.trim()) {
        closeDraft(); // 空白 Enter＝收掉草稿（與今日頁同）
        return;
      }
      if (await actions.createOn(date, name)) setDraftSeq((n) => n + 1); // 成功：清空輸入、草稿列留著（連打）
    },
    [actions, closeDraft],
  );

  // useStream 的 api 物件每次 render 都是新的；放 ref 讓回呼穩定（DaySection 的 memo 才有效）
  const streamRef = useRef(s);
  streamRef.current = s;
  const onLateJump = useCallback(() => {
    const { late: l, goTo } = streamRef.current;
    if (l.earliest) goTo(l.earliest);
  }, []);

  /* ───────── 捲動：spy／補載交給 useStream；捲動即關小卡 ───────── */
  const onScroll = () => {
    s.onScroll();
    if (latest.current.deferTarget) setDeferTarget(null);
  };

  /* ───────── 鍵盤（契約 §4.2） ───────── */
  const move = (delta: 1 | -1) => {
    const { selKey: cur, selKeys: keys, today: t } = latest.current;
    if (!keys.length) return;
    let j: number;
    if (cur === null || keys.indexOf(cur) < 0) {
      // 沒有選取＝從今日標題列起步（沒有今日段就從頭）
      const t0 = keys.indexOf(headKey(t));
      j = t0 >= 0 ? t0 : delta > 0 ? 0 : keys.length - 1;
    } else {
      j = Math.min(Math.max(keys.indexOf(cur) + delta, 0), keys.length - 1);
    }
    setSelKey(keys[j]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isEditableTarget(e.target)) return; // 草稿列輸入框自理
    if (latest.current.deferTarget) return; // 小卡開著：整張表停用（Esc 也歸它）
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 全域鍵一律放行
    const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
    if (onButton && (e.key === "Enter" || e.key === " ")) return; // run-head／誤點列／章鈕自己啟動

    const { selKey: cur, sections: secs, today: t, draftDay: dd } = latest.current;
    const row = cur ? rowOf(cur) : null;
    let handled = true;

    if (matches(e, "calendar.today")) {
      s.goToday();
      setSelKey(headKey(t));
    } else if (e.key === "Enter") {
      if (cur?.startsWith("run:")) {
        const sec = secs.find((x) => x.key === cur.slice(4));
        if (sec && sec.kind !== "day") s.toggleRun(sec);
        else handled = false;
      } else {
        const date = cur ? dateOfKey(cur) : null;
        if (date && date >= t) openDraft(date);
        else handled = false; // 過去的日子不能建票（P10）
      }
    } else {
      const hit = resolveHotkey("daylist", e);
      switch (hit?.id) {
        case "daylist.move.up":
          move(-1);
          break;
        case "daylist.move.down":
          move(1);
          break;
        case "daylist.complete":
          if (row) stamp(row);
          else handled = false;
          break;
        case "daylist.schedule.today":
          if (row) actions.scheduleRelative(row, 0);
          else handled = false;
          break;
        case "daylist.schedule.tomorrow":
          if (row) actions.scheduleRelative(row, 1);
          else handled = false;
          break;
        case "daylist.suspend":
          if (row) actions.suspend(row);
          else handled = false;
          break;
        case "daylist.panel":
          if (row?.node) actions.openPanel(row.node.id);
          else if (cur?.startsWith("due-")) actions.openPanel(cur.slice(15));
          else handled = false;
          break;
        case "daylist.escape":
          if (dd !== null) closeDraft();
          else if (cur) {
            setSelKey(null);
            scrollRef.current?.focus({ preventScroll: true });
          } else handled = false; // 沒東西可收：讓格層表的 Esc 去收浮層／小卡
          break;
        default:
          handled = false;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /* ───────── 畫 ───────── */
  const foc = s.focusDay;
  const footMonth = `${MONTH_EN[Number(foc.slice(5, 7)) - 1]} ${foc.slice(0, 4)}`;

  const renderDay = (sec: StreamDaySection) => (
    <DaySection
      key={sec.key}
      section={sec}
      nodes={nodes}
      routeOf={routeOf}
      currentOccurrences={currentOccurrences}
      today={today}
      selKey={keyInDay(selKey, sec)}
      freshKey={freshKey && freshKey.slice(0, 10) === sec.date ? freshKey : null}
      draftOpen={draftDay === sec.date}
      draftSeq={draftSeq}
      late={sec.rel === "today" ? late : null}
      onSelect={select}
      onStamp={stamp}
      onDefer={openDefer}
      onFreshEnd={onFreshEnd}
      onHeadClick={openDraft}
      onDraftCommit={commitDraft}
      onDraftCancel={closeDraft}
      onLateJump={onLateJump}
    />
  );

  return (
    <div className="ns-sch">
      <div ref={scrollRef} className="ns-sch-scroll" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
        {blocks.map((b) => {
          if (b.kind === "day") return renderDay(b.s);
          if (b.kind === "before") {
            return (
              <div key={b.s.key} className="ns-sch-edge sec is-past" data-sec-key={b.s.key}>
                <h3>
                  <span className="dt">{mdw(b.s.to)} 以前</span>
                </h3>
                <span className="rule" />
                <span className="note">— 無班次</span>
              </div>
            );
          }
          return (
            <RunBlock
              key={b.s.key}
              section={b.s}
              selected={selKey === runKey(b.s)}
              onSelect={select}
              onToggle={s.toggleRun}
            >
              {b.days.map(renderDay)}
            </RunBlock>
          );
        })}

        <footer className="page-foot">
          <span>私鐵手帳・行程表</span>
          <span className="fr">{footMonth}</span>
        </footer>
      </div>

      {/* 推遲小卡：掛在捲動容器之外（粉彩的 backdrop-filter 會變成 fixed 子元素的包含塊，DayPopover 同一條） */}
      {deferTarget && deferRow && <DeferPopover row={deferRow} anchor={deferTarget.anchor} onClose={closeDefer} />}
    </div>
  );
}

/* ═══════════════════ 區間列（gap／after 邊界）：按鈕一行；攤開時逐日段巢狀在裡面 ═══════════════════ */

const RunBlock = memo(function RunBlock({
  section: sec,
  selected,
  onSelect,
  onToggle,
  children,
}: {
  section: RunSection;
  selected: boolean;
  onSelect(key: string): void;
  onToggle(section: RunSection): void;
  children?: ReactNode;
}) {
  const isEdge = sec.kind === "edge";
  const past = sec.kind === "gap" && sec.past;
  const label = isEdge ? `${mdw(sec.from)} 以後` : `${mdw(sec.from)} – ${mdw(sec.to)}`;
  const note = sec.open ? "收起" : isEdge ? "— 還沒有班次" : "— 無班次";
  const key = runKey(sec);
  return (
    <section
      className={cx("ns-sch-run", isEdge && "is-edge", sec.open && "is-open", past && "is-past")}
      data-sec-key={sec.key}
    >
      <button
        type="button"
        className={cx("sec", "ns-sch-run-head", past && "is-past")}
        data-row-key={key}
        tabIndex={selected ? 0 : -1}
        aria-expanded={sec.open}
        aria-label={`${label}${isEdge ? "尚無班次" : "無班次"}，${sec.open ? "收起" : "逐日攤開"}`}
        title={sec.open ? "收起" : "逐日攤開"}
        onMouseDown={() => onSelect(key)}
        onClick={() => onToggle(sec)}
      >
        <h3>
          <span className="dt">{label}</span>
        </h3>
        <span className="rule" />
        <span className="note">
          {note}
          <span className="caret" aria-hidden>
            ▸
          </span>
        </span>
      </button>
      {children}
    </section>
  );
});

/* ═══════════════════ 一天（memo：只在自己的資料／選取變時重畫） ═══════════════════ */

interface DaySectionProps {
  section: StreamDaySection;
  nodes: Record<string, NodeRow>;
  routeOf(nodeId: string): NodeRow | undefined;
  currentOccurrences: Record<string, CurrentOccurrence>;
  today: string;
  /** 落在這一段裡的選取鍵（不在就 null） */
  selKey: string | null;
  /** 剛蓋的那一列（dayRowModel.key；不在這一段就 null） */
  freshKey: string | null;
  draftOpen: boolean;
  draftSeq: number;
  /** 今日段才有：誤點列 */
  late: { count: number; earliest: string | null } | null;
  onSelect(key: string): void;
  onStamp(row: DayRowModel): void;
  onDefer(row: DayRowModel, anchor: HTMLElement): void;
  onFreshEnd(key: string): void;
  onHeadClick(date: string): void;
  onDraftCommit(date: string, name: string): Promise<void>;
  onDraftCancel(): void;
  onLateJump(): void;
}

const DaySection = memo(function DaySection(p: DaySectionProps) {
  const { section: sec, nodes, routeOf, currentOccurrences, today } = p;
  const rows = useMemo<DayRowModel[]>(
    () =>
      sec.rows.map((r) =>
        dayRowModel(
          r.entry,
          nodes[r.entry.node_id],
          routeOf(r.entry.node_id),
          currentOccurrences[r.entry.node_id]?.due_on ?? null,
          today,
        ),
      ),
    [sec.rows, nodes, routeOf, currentOccurrences, today],
  );

  const isToday = sec.rel === "today";
  const past = sec.past;
  const clickable = !past; // 今天與未來可點開草稿（含空白單日、攤開的逐日行）；過去不行（P10）
  const hKey = headKey(sec.date);

  // 統計口徑＝domain/dayCount（磨光⑤ N11）：済才算「完成」，済＋運休算結清；與桌機、手機今日同一把尺
  const count = dayCount(rows.map((r) => ({ done: r.done, settled: r.done || r.skipped })));
  const { total } = count;
  const open = count.left;
  const countParts = dayCountParts(count);

  let note: ReactNode;
  if (sec.empty || (isToday && !countParts)) note = "— 無班次";
  else if (isToday && countParts)
    note = (
      <>
        完成 <b>{countParts.done}</b>/<b>{countParts.total}</b>
        <span className="left">・{countParts.tail}</span>
      </>
    );
  else if (past) note = open > 0 ? <span className="late-n">誤點 {open} 件</span> : "已交代";
  else note = `${total} 張`;

  const enterCap = formatChord({ key: "Enter" }).join("+");
  const title = clickable ? `點一下（或按 ${enterCap}）在這天新增臨時車票` : "過去的日子不能建票";

  return (
    <section
      className={cx("ns-sch-day", sec.empty && "is-empty", sec.inRun && "is-unfold")}
      data-day={sec.date}
      data-sec-key={sec.key}
    >
      {isToday && p.late && p.late.count > 0 && (
        <button
          type="button"
          className="ns-sch-latejump"
          aria-label={`誤點 ${p.late.count} 件——跳到最早誤點的 ${p.late.earliest ? mmdd(p.late.earliest) : ""}`}
          onClick={p.onLateJump}
        >
          <span className="lj-t">誤點</span>
          <span className="rule" />
          <span className="lj-n">
            {p.late.count} 件
            <span className="caret" aria-hidden>
              ▴
            </span>
          </span>
        </button>
      )}

      {/* 日期標題列：今天／未來＝可點開草稿（role=button）；過去＝純標題（可選取、不可點） */}
      <div
        className={cx("sec", isToday && "is-today", past && "is-past", clickable && "is-clickable")}
        role={clickable ? "button" : undefined}
        data-row-key={hKey}
        tabIndex={p.selKey === hKey ? 0 : -1}
        title={title}
        onMouseDown={() => p.onSelect(hKey)}
        onClick={clickable ? () => p.onHeadClick(sec.date) : undefined}
      >
        <h3>
          {sec.rel && <span className="rel">{isToday ? "今日" : "明日"}</span>}
          <span className="dt">{mdw(sec.date)}</span>
        </h3>
        <span className="rule" />
        <span className="note">{note}</span>
      </div>

      {rows.length > 0 && (
        <div className="ns-sch-rows">
          {rows.map((row) => (
            <StreamRow
              key={row.key}
              row={row}
              selected={p.selKey === rowKey(row.entry.date, row.entry.node_id)}
              fresh={p.freshKey === row.key}
              onSelect={p.onSelect}
              onStamp={p.onStamp}
              onDefer={p.onDefer}
              onFreshEnd={p.onFreshEnd}
            />
          ))}
        </div>
      )}

      {sec.dues.length > 0 && (
        <>
          <div className="ns-sch-subhead">締切</div>
          <div className="ns-sch-rows">
            {sec.dues.map((d) => {
              const k = dueKey(d);
              return (
                <DueRow
                  key={k}
                  due={d}
                  node={nodes[d.node_id]}
                  route={routeOf(d.node_id)}
                  selected={p.selKey === k}
                  onSelect={() => p.onSelect(k)}
                />
              );
            })}
          </div>
        </>
      )}

      {p.draftOpen && (
        <ul className="ticket-list ns-sch-draft">
          <TicketDraftRow
            key={p.draftSeq}
            afterId={null}
            kind="today"
            onCommit={(name) => p.onDraftCommit(sec.date, name)}
            onCancel={p.onDraftCancel}
          />
        </ul>
      )}

      {isToday && total > 0 && open === 0 && <div className="ns-sch-cheer">今天的班次都到站了</div>}
    </section>
  );
});

/* ═══════════════════ 一列（memo；回呼吃 row，父層的處理器才穩定） ═══════════════════ */

const StreamRow = memo(function StreamRow({
  row,
  selected,
  fresh,
  onSelect,
  onStamp,
  onDefer,
  onFreshEnd,
}: {
  row: DayRowModel;
  selected: boolean;
  fresh: boolean;
  onSelect(key: string): void;
  onStamp(row: DayRowModel): void;
  onDefer(row: DayRowModel, anchor: HTMLElement): void;
  onFreshEnd(key: string): void;
}) {
  // 現在（主線②）：時刻已過的赭色要每分鐘自己變——節拍掛在列上，換分只重畫列、不動整條串流
  const now = useMinuteTick();
  return (
    <DayRow
      row={row}
      selected={selected}
      fresh={fresh}
      now={now}
      onFreshEnd={() => onFreshEnd(row.key)}
      onSelect={() => onSelect(rowKey(row.entry.date, row.entry.node_id))}
      onStamp={() => onStamp(row)}
      onDefer={(el) => onDefer(row, el)}
    />
  );
});
