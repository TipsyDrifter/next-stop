/**
 * MobileSchedule——手機今日 tab 內的「行程表」子頁（主線車次①；D-主-2／5，契約 §4.4）。
 *
 * 版面（由上而下；根 `div.m-sch` 取代 .m-page 的位置、不加 .m-page）：
 *   WeekStrip                 週條（月份鈕＝開合月曆覆蓋層；點日＝requestScroll）
 *   .m-sch-main               ├ .m-sch-stream  唯一捲動容器（useStream 的 scrollRef；overflow-anchor:none）
 *                             └ MonthOverlay   月曆覆蓋層（absolute 蓋在串流上）
 *   MobileTicketSheet         ⋯ 開著時（兩子頁共用那一支）
 *
 * 串流長什麼樣由 `useStream`／`streamModel` 決定（唯一真相），這裡只把 sections 畫出來：
 *   day 段   ＝ 日期標題列（今天／未來可點＝在那天底下開草稿，D-主-8；過去不可點，P10）＋ MobileTicket × rows
 *              ＋（有 dues）「締切」小段：沒執行日的票畫完整卡（可蓋済／⋯）、有執行日的畫一行 .m-sch-due（點＝捲到執行日；§0-1 第 14 條）
 *              ＋（draftDay＝這天）草稿列 ＋（今日且全交代）「今天的班次都到站了」；今日段上方另有「誤點 N 件」一列（P8）
 *   gap 段   ＝ 連續空白日一行（點＝攤開逐日／收起，D-主-7）；before／after 邊界行（P5）
 * 列的身分走日曆同一把尺 `dayRowModel`，卡的欄位由 `cardFromDayRow`／`cardFromDue` 摺好；動作走 `makeScheduleActions("mobile")`
 *   （守門與收據全在那裡；本檔不碰 repository、不自己判口徑）。
 *
 * 週條與月曆的點／〆從 `nodeStore.calendar`（串流視窗）自己算，不登記 calendarDayMarks（契約 §5.3）；
 *   停週／開月曆／翻月 ⇒ `ensureLoaded`（視窗補到那一週／月，點才畫得出來；不捲動）。
 * 票號：`nodeStore.serials` 在手機多半是空的 ⇒ serial 為 null、卡上不畫票號（§0-1 第 12 條，已接受）。
 *
 * **主線②（D-主-11、契約 §4.8）**：週條頂列「清單｜時段」（`scheduleUiStore.mobileLayout`，session 記憶）。
 *   時段＝`MobileTimeDays`（3 天一頁、從今天對齊、左右換頁）**疊在**串流上面（`.m-sch-tg` absolute 蓋住 `.m-sch-stream`）；
 *   串流不卸載、只 `visibility:hidden`＋`inert`——useStream 的捲動監聽、錨點、ResizeObserver 都綁在那個容器上，卸掉再掛回來
 *   會綁在死掉的節點上；藏著它也保住清單的捲動位置。（契約寫「取代」，這是等價且不拆 useStream 的做法。）
 *   時段排法下，週條的選中日／月份字／月曆的 focus 改吃「時段那一頁的第一天」（`tgPage`），不吃 store 的 focusDay——
 *   藏著的串流在資料刷新時仍會 spy 寫 focusDay，跟著它會讓週條跳週。週條點日、月曆點日、「今日」在時段排法下改走
 *   MobileTimeDays 的 goToDay／goToday；切回「清單」時，若在時段裡換過頁，才把串流瞬移到那一頁的第一天。
 *   卡上的時刻與赭色吃 `useMinuteTick()`（一頁一個節拍，傳進每張卡）。⋯ sheet 的時刻項接 scheduleActions 的三個動作。
 *
 * **磨光①（契約 §1.5、§9.5）**：⋯ sheet 與月曆覆蓋層各登記一層 sheet 返回層（返回＝同按 ×／收起）；
 *   ⋯ sheet 加改名…／記一句…／刪除（useMobileToday 的模組函式，同今日子頁）——串流不是手排清單，不出上移下移。
 *   草稿列是行內、不登記（返回先收鍵盤，再按就回今日段，草稿列跟著卸載）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { NodeRow } from "../../domain";
import type { DueEntry } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays } from "../../lib/date";
import { dayRowModel, mmdd } from "../calendar/DayRow";
import { addMonths, monthEnd, monthStart } from "../calendar/useCalendarController";
import { useStream } from "../schedule/useStream";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";
import { mdw, type StreamDaySection, type StreamEdgeSection, type StreamGapSection } from "../schedule/streamModel";
import { cardFromDayRow, cardFromDue, type TicketCardModel } from "../schedule/ticketCard";
import { makeScheduleActions, type ScheduleTarget } from "../schedule/scheduleActions";
import { WeekStrip, type DayMark } from "../schedule/WeekStrip";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { MobileTimeDays, pageStartOf, type MobileTimeDaysHandle } from "./MobileTimeDays";
import { MonthOverlay } from "../schedule/MonthOverlay";
import { MobileTicket } from "./MobileTicket";
import { MobileTicketSheet } from "./MobileTicketSheet";
import { useSubSwipe } from "./MobileSegmentedBar";
import { useBackLayer } from "./backStack";
import { deleteTicket, liveChildCount, logTicket, renameTicket } from "./useMobileToday";
import "../schedule/schedule-mobile.css";

/** ⋯ 開在哪一張（存座標不存快照：資料變了用最新的 calendar 切片重算卡；找不到＝票搬走了，sheet 自己關） */
interface SheetRef {
  kind: "entry" | "due";
  nodeId: string;
  date: string;
}

interface YearMonth {
  y: number;
  /** 0 起 */
  m: number;
}

function ymOf(day: string): YearMonth {
  return { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)) - 1 };
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 印章動畫 .4s；0.8s 後清旗標（reduced-motion 不發 animationend，故一律用計時器兜底；useMobileToday 同款） */
const FRESH_MS = 800;
/** 月曆點日：等覆蓋層開始收起再捲，視線不會被兩個動作同時拉走（原型 :1620） */
const CAL_PICK_DELAY_MS = 120;
/** 草稿列 autoFocus 後等軟鍵盤再捲到中間（評審 S6） */
const DRAFT_REVEAL_MS = 250;

export function MobileSchedule() {
  const streamRef = useRef<HTMLDivElement | null>(null);
  const api = useStream({ shell: "mobile", scrollRef: streamRef });
  const { today, focusDay, sections, late, ensureLoaded, goTo, goToday, toggleRun, onScroll } = api;
  useSubSwipe(streamRef, "schedule");

  // 進頁起點＝今日段在頂端（D-主-6）：由 useStream 負責——初始捲動等 calendar 切片第一次涵蓋今天才做、字型晚到重排會擺回錨點
  // （修正席 2026-10-12：原本這裡的兩段繞法搬進 useStream，桌機 StreamView 冷開同病一起好）。
  // 誤點列畫在今日段 <section> 裡面，今日切片晚到只把段內標題往下推，今日段本身的頂端不動，不必另等。
  const calFrom = useNodeStore((s) => s.calendar.from);
  const calTo = useNodeStore((s) => s.calendar.to);

  const calendar = useNodeStore((s) => s.calendar);
  const routes = useNodeStore((s) => s.routes);
  const serials = useNodeStore((s) => s.serials);
  const currentOccurrences = useNodeStore((s) => s.currentOccurrences);
  const firstDow = useUiStore((s) => s.weekStart);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const draftDay = useScheduleUiStore((s) => s.draftDay);
  const layout = useScheduleUiStore((s) => s.mobileLayout);
  const now = useMinuteTick();

  /* ───────── 時段排法（主線②）：頁、切換、對齊串流 ───────── */
  const timeRef = useRef<MobileTimeDaysHandle | null>(null);
  /** 時段那一頁的第一天（從今天對齊）；切進時段時由串流的 focusDay 換算 */
  const [tgPage, setTgPage] = useState(() => pageStartOf(useScheduleUiStore.getState().focusDay ?? today, today));
  /** 在時段裡換過頁 ⇒ 切回清單時要把串流對齊過去 */
  const tgMovedRef = useRef(false);
  const isTime = layout === "time";
  /** 週條／月曆的「目前這天」：時段排法吃頁首、清單吃 scroll-spy */
  const shownFocus = isTime ? tgPage : focusDay;

  const actions = useMemo(() => makeScheduleActions("mobile"), []);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetRef | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [label, setLabel] = useState<YearMonth>(() => ymOf(today));

  // 跳到「還沒載進來」的日子（誤點列、週條、月曆都可能）：useStream.goTo 會先擴視窗、在空白區間裡攤開並捲過去，
  // 但那一天的資料隨後才到——sections 再換一次身分，錨點補償把畫面拉回原位、剛才的捲動等於沒發生（?mock=1 實測）。
  // 這裡記住目標，等 calendar 切片涵蓋它之後再 goTo 一次（第二次是對著真資料捲，不會再被補償吃掉）。
  // 目標早於 bounds.earliest 的先夾到 earliest（useStream 也是這樣落在 before 邊界行）。
  const pendingJumpRef = useRef<string | null>(null);
  const jump = useCallback(
    (raw: string, smooth = true) => {
      const b = api.bounds;
      const day = b && b.earliest !== null && raw < b.earliest ? b.earliest : raw;
      const cal = useNodeStore.getState().calendar;
      const loaded = cal.from !== null && cal.to !== null && day >= cal.from && day <= cal.to;
      pendingJumpRef.current = loaded ? null : day;
      goTo(day, { smooth });
    },
    [api.bounds, goTo],
  );
  useEffect(() => {
    const day = pendingJumpRef.current;
    if (!day || calFrom === null || calTo === null || day < calFrom || day > calTo) return;
    pendingJumpRef.current = null;
    goTo(day, { smooth: true });
  }, [calFrom, calTo, goTo]);

  const routeById = useMemo(() => new Map(routes.map((r) => [r.id, r] as const)), [routes]);
  const routeOf = useCallback(
    (node: NodeRow | undefined): NodeRow | undefined => (node?.route_id ? routeById.get(node.route_id) : undefined),
    [routeById],
  );

  /* ───────── 週條／月曆的點與〆（從串流視窗的切片算） ───────── */
  const marks = useMemo(() => {
    const m = new Map<string, DayMark>();
    const at = (d: string) => {
      let mk = m.get(d);
      if (!mk) {
        mk = { dots: [], due: false };
        m.set(d, mk);
      }
      return mk;
    };
    for (const e of calendar.entries) {
      const mk = at(e.date);
      if (mk.dots.length >= 3) continue;
      const route = routeOf(calendar.nodes[e.node_id]);
      mk.dots.push({ color: route?.color ?? "var(--route-none)", done: e.is_done || e.occurrence_status === "skipped" });
    }
    for (const d of calendar.dues) at(d.date).due = true;
    return m;
  }, [calendar.entries, calendar.dues, calendar.nodes, routeOf]);

  /* ───────── 月份字：月曆關著跟串流（focusDay）走、停到別週時用那週；開著跟月曆走 ───────── */
  useEffect(() => {
    if (!calOpen) setLabel(ymOf(shownFocus));
  }, [shownFocus, calOpen]);

  const onWeekSettle = useCallback(
    (first: string) => {
      const last = addDays(first, 6);
      const focus = isTime ? tgPage : (useScheduleUiStore.getState().focusDay ?? today);
      if (!calOpen && (focus < first || focus > last)) setLabel(ymOf(addDays(first, 3)));
      ensureLoaded(first, last);
    },
    [calOpen, ensureLoaded, today, isTime, tgPage],
  );

  const showMonth = useCallback(
    (ym: YearMonth) => {
      setLabel(ym);
      const first = `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-01`;
      ensureLoaded(monthStart(first), monthEnd(first));
    },
    [ensureLoaded],
  );
  const openCal = useCallback(() => {
    setCalOpen(true);
    showMonth(ymOf(isTime ? tgPage : (useScheduleUiStore.getState().focusDay ?? today)));
  }, [showMonth, today, isTime, tgPage]);
  const closeCal = useCallback(() => {
    setCalOpen(false);
    setLabel(ymOf(isTime ? tgPage : (useScheduleUiStore.getState().focusDay ?? today)));
  }, [today, isTime, tgPage]);
  const toggleCal = useCallback(() => (calOpen ? closeCal() : openCal()), [calOpen, closeCal, openCal]);
  const shiftMonth = useCallback(
    (n: 1 | -1) => {
      const first = `${label.y}-${String(label.m + 1).padStart(2, "0")}-01`;
      showMonth(ymOf(addMonths(first, n)));
    },
    [label, showMonth],
  );
  /** 跳到某天：清單＝串流 goTo；時段＝捲到含那天的頁 */
  const goDay = useCallback(
    (day: string) => {
      if (useScheduleUiStore.getState().mobileLayout === "time") {
        // 時段排法也夾到資料下界（同 jump）：週條往回捲很遠時不落在沒有資料的空白頁，兩種排法落點一致
        const b = api.bounds;
        tgMovedRef.current = true;
        timeRef.current?.goToDay(b && b.earliest !== null && day < b.earliest ? b.earliest : day);
      } else jump(day);
    },
    [jump, api.bounds],
  );
  const pickFromCal = useCallback(
    (day: string) => {
      closeCal();
      window.setTimeout(() => goDay(day), CAL_PICK_DELAY_MS);
    },
    [closeCal, goDay],
  );
  const onToday = useCallback(() => {
    if (calOpen) closeCal();
    if (useScheduleUiStore.getState().mobileLayout === "time") {
      tgMovedRef.current = true;
      timeRef.current?.goToday();
    } else goToday();
  }, [calOpen, closeCal, goToday]);

  /** 切回清單時要把串流對齊到的那一天（null＝不動） */
  const streamAlignRef = useRef<string | null>(null);
  const onLayout = useCallback(
    (v: "stream" | "time") => {
      const ui = useScheduleUiStore.getState();
      if (v === ui.mobileLayout) return;
      if (v === "time") {
        // 進時段：落在含串流目前那天的頁（從今天對齊）
        tgMovedRef.current = false;
        setTgPage(pageStartOf(ui.focusDay ?? today, today));
      } else if (tgMovedRef.current) {
        // 回清單：在時段裡換過頁才把串流對齊過去（沒動就留在原本的位置）；等串流露出來（下面的 effect）再捲
        streamAlignRef.current = tgPage;
      }
      ui.setMobileLayout(v);
    },
    [today, tgPage],
  );
  useEffect(() => {
    if (layout !== "stream" || !streamAlignRef.current) return;
    const day = streamAlignRef.current;
    streamAlignRef.current = null;
    jump(day, false);
  }, [layout, jump]);
  /** 時段畫布籤帶的「＋N」：切回清單並把串流對齊到那一天（未定時的票只有清單看得全） */
  const onTgMore = useCallback((day: string) => {
    streamAlignRef.current = day;
    useScheduleUiStore.getState().setMobileLayout("stream");
  }, []);
  const onTgPage = useCallback((first: string) => {
    tgMovedRef.current = true;
    setTgPage(first);
    useScheduleUiStore.getState().setFocusDay(first);
  }, []);
  const tgVisible = useMemo(() => [tgPage, addDays(tgPage, 1), addDays(tgPage, 2)], [tgPage]);

  /* ───────── 卡的動作（守門在 scheduleActions） ───────── */
  const stamp = useCallback(
    (target: ScheduleTarget, card: TicketCardModel) => {
      if (!actions.stamp(target)) return;
      setFreshKey(card.key);
      window.setTimeout(() => setFreshKey((cur) => (cur === card.key ? null : cur)), FRESH_MS);
    },
    [actions],
  );
  const openSheet = useCallback((ref: SheetRef) => setSheet(ref), []);
  const pickBlock = useCallback(
    (date: string, nodeId: string) => {
      // 定期券的歷史班次唯讀（§6.1 #11）：不開 ⋯ sheet（單發票那組推遲／幾點…對它不成立），吐一句 toast 就好
      const { calendar: cal, currentOccurrences: occ } = useNodeStore.getState();
      const node = cal.nodes[nodeId];
      const entry = cal.entries.find((e) => e.date === date && e.node_id === nodeId);
      if (node && entry) {
        const row = dayRowModel(entry, node, routeOf(node), occ[nodeId]?.due_on ?? null, today);
        if (row.isHistory) {
          const hint = cardFromDayRow(row, null, today).stampHint ?? "歷史班次唯讀";
          useUiStore.getState().showToast({ message: hint }, 3000);
          return;
        }
      }
      setSheet({ kind: "entry", nodeId, date });
    },
    [routeOf, today],
  );
  const closeSheet = useCallback(() => setSheet(null), []);

  // sheet 指的那張票，用最新切片重算（票搬走／改期後找不到 ⇒ 關）
  const sheetView = useMemo(() => {
    if (!sheet) return null;
    const node = calendar.nodes[sheet.nodeId];
    if (!node) return null;
    const serial = serials[sheet.nodeId] ?? null;
    if (sheet.kind === "due") {
      return { card: cardFromDue(node, sheet.date, serial, today), target: { kind: "due", node } as ScheduleTarget };
    }
    const entry = calendar.entries.find((e) => e.date === sheet.date && e.node_id === sheet.nodeId);
    if (!entry) return null;
    const row = dayRowModel(entry, node, routeOf(node), currentOccurrences[sheet.nodeId]?.due_on ?? null, today);
    return { card: cardFromDayRow(row, serial, today), target: { kind: "entry", row } as ScheduleTarget };
  }, [sheet, calendar, serials, currentOccurrences, routeOf, today]);
  useEffect(() => {
    if (sheet && !sheetView) setSheet(null);
  }, [sheet, sheetView]);

  // 返回層（磨光① §1.5）：⋯ sheet（含子面板）＝返回同按 ×；月曆覆蓋層＝返回同收起。行程表段本身的子頁層登記在 MobileToday
  useBackLayer("core.scheduleSheet", sheetView !== null, closeSheet);
  useBackLayer("core.scheduleCal", calOpen, closeCal);

  const createOn = useCallback((day: string, name: string) => actions.createOn(day, name), [actions]);
  const closeDraft = useCallback(() => useScheduleUiStore.getState().setDraftDay(null), []);

  // sheet 放在 .m-sch **之外**（Fragment 的第二個子節點＝根 flex column 的直接子節點）：.m-sch 是 z-index:1 的疊放脈絡，
  // fixed 的 .m-sheet-veil（z 45）困在裡面會被 tab bar（z 3）蓋住——今日子頁的 sheet 本來就是 .m-page 的兄弟，這裡同款。
  return (
    <>
    <div className="m-sch">
      <WeekStrip
        today={today}
        focusDay={shownFocus}
        firstDow={firstDow}
        marks={marks}
        label={label}
        calOpen={calOpen}
        onToggleCal={toggleCal}
        onShiftMonth={shiftMonth}
        onPickDay={goDay}
        onToday={onToday}
        onWeekSettle={onWeekSettle}
        layout={layout}
        onLayout={onLayout}
        visibleDays={isTime ? tgVisible : null}
      />
      <div className="m-sch-main">
        <div
          className={"m-sch-stream" + (isTime ? " is-under" : "")}
          ref={streamRef}
          onScroll={onScroll}
          tabIndex={-1}
          aria-label="行程表串流"
          aria-hidden={isTime || undefined}
          inert={isTime || undefined}
        >
          {sections.map((sec) => {
            if (sec.kind === "edge" && sec.side === "before") {
              return (
                <div key={sec.key} className="m-sch-edge sec is-past" data-sec-key={sec.key}>
                  <h3>
                    <span className="dt">{mdw(sec.to)} 以前</span>
                  </h3>
                  <span className="rule" />
                  <span className="note">— 無班次</span>
                </div>
              );
            }
            if (sec.kind !== "day") {
              return <RunHead key={sec.key} section={sec} today={today} onToggle={toggleRun} />;
            }
            return (
              <DaySection
                key={sec.key}
                section={sec}
                today={today}
                nodes={calendar.nodes}
                serials={serials}
                currentOccurrences={currentOccurrences}
                routeOf={routeOf}
                freshKey={freshKey}
                now={now}
                draft={draftDay === sec.date}
                lateCount={sec.rel === "today" ? late.count : 0}
                lateEarliest={late.earliest}
                onStamp={stamp}
                onMore={openSheet}
                onGoTo={jump}
                onCreate={createOn}
                onCloseDraft={closeDraft}
                isProgramScrolling={api.isProgramScrolling}
              />
            );
          })}
          <div className="m-sch-foot" aria-hidden>
            ・・・
          </div>
        </div>
        {isTime && (
          <MobileTimeDays
            handleRef={timeRef}
            today={today}
            dayStartHour={dayStartHour}
            now={now}
            entries={calendar.entries}
            dues={calendar.dues}
            nodes={calendar.nodes}
            routes={routes}
            initialDay={tgPage}
            selectedKey={sheet && sheet.kind === "entry" ? `${sheet.date}-${sheet.nodeId}` : null}
            ensureLoaded={ensureLoaded}
            onPage={onTgPage}
            onPick={pickBlock}
            onMore={onTgMore}
          />
        )}
        <MonthOverlay
          open={calOpen}
          year={label.y}
          month={label.m}
          today={today}
          focusDay={shownFocus}
          firstDow={firstDow}
          marks={marks}
          onPick={pickFromCal}
          onClose={closeCal}
        />
      </div>
    </div>

      {sheetView && (
        <MobileTicketSheet
          card={sheetView.card}
          today={today}
          onDefer={(d) => actions.defer(sheetView.target, d)}
          onSkip={() => {
            if (sheetView.target.kind === "entry") actions.suspend(sheetView.target.row);
          }}
          onSetTime={(t, est) => actions.setTime(sheetView.card.nodeId, t, est)}
          onSetRunTime={(t) => {
            if (sheetView.card.railDate) actions.setRunTime(sheetView.card.nodeId, sheetView.card.railDate, t);
          }}
          onClearRunTime={() => {
            if (sheetView.card.railDate) actions.clearRunTime(sheetView.card.nodeId, sheetView.card.railDate);
          }}
          // 磨光① 加工單：改名／記一句／刪除同今日子頁；串流不是手排清單，不給上移下移
          onRename={(name) => renameTicket(sheetView.card.nodeId, name, sheetView.card.name)}
          onLog={(body) => logTicket(sheetView.card.nodeId, body)}
          onDelete={() => deleteTicket(sheetView.card.nodeId, sheetView.card.name, liveChildCount(sheetView.card.nodeId))}
          onClose={closeSheet}
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════
 * 區間列／「以後」邊界（一行按鈕：點了攤開逐日、再點收起）
 * ═══════════════════════════════════════════════════════ */

const RunHead = memo(function RunHead({
  section,
  today,
  onToggle,
}: {
  section: StreamGapSection | StreamEdgeSection;
  today: string;
  onToggle(section: StreamGapSection | StreamEdgeSection): void;
}) {
  const isAfter = section.kind === "edge";
  const label = isAfter ? `${mdw(section.from)} 以後` : `${mdw(section.from)} – ${mdw(section.to)}`;
  const past = section.kind === "gap" ? section.past : section.to < today;
  const note = section.open ? "收起" : isAfter ? "— 尚無班次" : "— 無班次";
  return (
    <section className={"m-sch-run" + (section.open ? " is-open" : "") + (isAfter ? " is-edge" : "")} data-sec-key={section.key}>
      <button
        type="button"
        className={"sec m-sch-run-head" + (past ? " is-past" : "")}
        aria-expanded={section.open}
        aria-label={`${label}${isAfter ? "尚無班次" : "無班次"}，${section.open ? "收起" : "逐日攤開"}`}
        onClick={() => onToggle(section)}
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
    </section>
  );
});

/* ═══════════════════════════════════════════════════════
 * 一天的段落
 * ═══════════════════════════════════════════════════════ */

interface DaySectionProps {
  section: StreamDaySection;
  today: string;
  nodes: Record<string, NodeRow>;
  serials: Record<string, string>;
  currentOccurrences: Record<string, { due_on: string }>;
  routeOf(node: NodeRow | undefined): NodeRow | undefined;
  freshKey: string | null;
  /** useMinuteTick() 的現在（卡上時刻轉赭） */
  now: number;
  /** 草稿列開在這天 */
  draft: boolean;
  /** 只有今日段非 0：誤點列（P8） */
  lateCount: number;
  lateEarliest: string | null;
  onStamp(target: ScheduleTarget, card: TicketCardModel): void;
  onMore(ref: SheetRef): void;
  onGoTo(day: string): void;
  onCreate(day: string, name: string): Promise<boolean>;
  onCloseDraft(): void;
  isProgramScrolling(): boolean;
}

/** 日期標題（今日／明日帶 .rel；其餘只有 .dt） */
function dayLabel(section: StreamDaySection) {
  const dt = <span className="dt">{mdw(section.date)}</span>;
  if (section.rel === "today")
    return (
      <>
        <span className="rel">今日</span>
        {dt}
      </>
    );
  if (section.rel === "tomorrow")
    return (
      <>
        <span className="rel">明日</span>
        {dt}
      </>
    );
  return dt;
}

const DaySection = memo(function DaySection({
  section,
  today,
  nodes,
  serials,
  currentOccurrences,
  routeOf,
  freshKey,
  now,
  draft,
  lateCount,
  lateEarliest,
  onStamp,
  onMore,
  onGoTo,
  onCreate,
  onCloseDraft,
  isProgramScrolling,
}: DaySectionProps) {
  const { date, rows, dues, past, empty, inRun } = section;
  const isToday = section.rel === "today";

  // 列的身分＝日曆同一把尺（dayRowModel）；卡的欄位由 cardFromDayRow 摺好
  const models = useMemo(
    () =>
      rows.map((r) => {
        const node = nodes[r.entry.node_id];
        const route = routeOf(node);
        const row = dayRowModel(r.entry, node, route, currentOccurrences[r.entry.node_id]?.due_on ?? null, today);
        return { row, route, card: cardFromDayRow(row, serials[r.entry.node_id] ?? null, today) };
      }),
    [rows, nodes, routeOf, currentOccurrences, serials, today],
  );
  // 締切層：沒執行日的票畫完整卡；有執行日的畫一行（點＝捲到執行日）
  const dueItems = useMemo(
    () =>
      dues
        .map((d: DueEntry) => {
          const node = nodes[d.node_id];
          if (!node) return null;
          return node.scheduled_on === null
            ? { kind: "card" as const, node, route: routeOf(node), card: cardFromDue(node, d.date, serials[d.node_id] ?? null, today) }
            : { kind: "line" as const, node, route: routeOf(node), when: node.scheduled_on };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [dues, nodes, routeOf, serials, today],
  );

  // 標題右側的 note（契約 §4.3）：済＋運休算交代；只數 rows（班次），不數 dues
  const total = rows.length;
  const done = rows.filter((r) => r.entry.is_done).length;
  const settled = rows.filter((r) => r.entry.is_done || r.entry.occurrence_status === "skipped").length;
  const left = total - settled;
  let note;
  if (empty || (isToday && total === 0)) note = "— 無班次";
  else if (isToday)
    note = (
      <>
        完成 <b>{done}</b>/<b>{total}</b>
        {left > 0 && <span className="left">・還有 {left} 張</span>}
      </>
    );
  else if (past) note = left > 0 ? <span className="late-n">誤點 {left} 件</span> : "已交代";
  else note = `${total} 張`;

  const clickable = !past;
  const openDraft = () => useScheduleUiStore.getState().setDraftDay(date);
  const onHeadKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDraft();
    }
  };

  return (
    <section
      className={"m-sch-day" + (empty ? " is-empty" : "") + (inRun ? " is-run" : "") + (past ? " is-past" : "")}
      data-day={date}
      data-sec-key={section.key}
    >
      {isToday && lateCount > 0 && lateEarliest && (
        <button
          type="button"
          className="m-sch-latejump"
          aria-label={`誤點 ${lateCount} 件——捲到最早的誤點日 ${mmdd(lateEarliest)}`}
          onClick={() => onGoTo(lateEarliest)}
        >
          <span className="lj-t">誤點</span>
          <span className="rule" />
          <span className="lj-n">
            {lateCount} 件
            <span className="caret" aria-hidden>
              ▴
            </span>
          </span>
        </button>
      )}

      {clickable ? (
        <div
          className={"sec is-clickable" + (isToday ? " is-today" : "")}
          role="button"
          tabIndex={0}
          aria-label={`在 ${mdw(date)} 開一張臨時車票`}
          onClick={openDraft}
          onKeyDown={onHeadKey}
        >
          <h3>{dayLabel(section)}</h3>
          <span className="rule" />
          <span className="note">{note}</span>
        </div>
      ) : (
        <div className="sec is-past" title="過去的日子不能建票">
          <h3>{dayLabel(section)}</h3>
          <span className="rule" />
          <span className="note">{note}</span>
        </div>
      )}

      {models.length > 0 && (
        <ul className="m-tk-list" aria-label={`${mdw(date)} 的班次`}>
          {models.map(({ row, route, card }) => (
            <MobileTicket
              key={card.key}
              card={card}
              route={route}
              today={today}
              fresh={freshKey === card.key}
              now={now}
              onComplete={() => onStamp({ kind: "entry", row }, card)}
              onMore={() => onMore({ kind: "entry", nodeId: card.nodeId, date })}
            />
          ))}
        </ul>
      )}

      {dueItems.length > 0 && (
        <>
          <div className="m-sch-subhead">締切</div>
          {dueItems.some((x) => x.kind === "card") && (
            <ul className="m-tk-list" aria-label={`${mdw(date)} 的締切`}>
              {dueItems.map((x) =>
                x.kind === "card" ? (
                  <MobileTicket
                    key={x.card.key}
                    card={x.card}
                    route={x.route}
                    today={today}
                    fresh={freshKey === x.card.key}
                    now={now}
                    onComplete={() => onStamp({ kind: "due", node: x.node }, x.card)}
                    onMore={() => onMore({ kind: "due", nodeId: x.node.id, date })}
                  />
                ) : null,
              )}
            </ul>
          )}
          {dueItems.map((x) =>
            x.kind === "line" ? (
              <button
                key={`dl-${x.node.id}`}
                type="button"
                className="m-sch-due"
                aria-label={`${x.node.name}，締切 ${mmdd(date)}，執行 ${mmdd(x.when)}——捲到執行日`}
                onClick={() => onGoTo(x.when)}
              >
                <i className="m-sch-shime" aria-hidden>
                  〆
                </i>
                <span className="m-sch-due-badge" style={{ color: x.route?.color ?? "var(--route-none)" }} aria-hidden>
                  <span className={x.route ? "m-tk-badge" : "m-tk-badge is-dashed"}>
                    {x.route?.code ?? (x.route ? x.route.name.slice(0, 1) : "臨")}
                  </span>
                </span>
                <span className="m-sch-due-name">{x.node.name}</span>
                <span className="m-sch-due-when">執行 {mmdd(x.when)}</span>
              </button>
            ) : null,
          )}
        </>
      )}

      {draft && <DraftRow day={date} onCreate={onCreate} onClose={onCloseDraft} isProgramScrolling={isProgramScrolling} />}

      {isToday && total > 0 && left === 0 && <div className="m-sch-cheer">今天的班次都到站了</div>}
    </section>
  );
});

/* ═══════════════════════════════════════════════════════
 * 草稿列（D-主-8：點日期標題列在那天底下開；一次一張，點別天就換過去）
 *   送出成功 ⇒ 清空、草稿列留著（連打）；空白 Enter 或 Esc ⇒ 關；捲走不關。
 *   IME 三道護欄（鐵則 6）：isComposing／keyCode 229／composition 旗標（MobileToday.MobileNewTicket 同款）。
 * ═══════════════════════════════════════════════════════ */

function DraftRow({
  day,
  onCreate,
  onClose,
  isProgramScrolling,
}: {
  day: string;
  onCreate(day: string, name: string): Promise<boolean>;
  onClose(): void;
  /** useStream 的守門：程式捲動飛行中不 scrollIntoView（串流 scrollTop 的寫入者全走同一個門） */
  isProgramScrolling(): boolean;
}) {
  const [text, setText] = useState("");
  const composing = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // autoFocus，focus 後等軟鍵盤再把自己捲到中間（評審 S6）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const t = window.setTimeout(() => {
      if (isProgramScrolling()) return; // goTo 還在飛：不截斷它，落點由 land 收尾
      el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }, DRAFT_REVEAL_MS);
    return () => window.clearTimeout(t);
  }, []);

  const submit = async () => {
    if (!text.trim()) {
      onClose();
      return;
    }
    const ok = await onCreate(day, text);
    // 成功才清空＝失敗時主人打的字還在（createOn 已經吐過 toast）；不關草稿列＝連打
    if (ok) setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="m-sch-draft">
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        placeholder={`在 ${mmdd(day)} 開一張臨時車票…`}
        aria-label={`輸入 ${mdw(day)} 臨時車票的名稱`}
        enterKeyHint="done"
        spellCheck={false}
        autoComplete="off"
        className="m-nt-input"
      />
      <button type="button" onClick={() => void submit()} disabled={!text.trim()} className="m-nt-go ns-btn btn-seal">
        発券
      </button>
    </div>
  );
}
