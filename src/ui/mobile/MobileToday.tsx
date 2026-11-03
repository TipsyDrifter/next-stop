/**
 * MobileToday——今日 tab 的手機頁（v1.1.0；WP1）＝副平台的落地頁。
 *
 * 拍板依據：D-1.1-2「副平台最小操作＝看今日、蓋済、推遲到明天、開臨時車票」＋契約 §2.7 的呼叫表。
 * 狀態機在 `useMobileToday.ts`（載入／蓋済／改期／建票），本檔只負責畫與覆蓋層以外的本地互動：
 *   ⋯ 開的底部 sheet（本地 useState；不進 uiStore——它只活在這一頁，關頁就該消失）。
 *
 * **主線車次①（D-主-5、契約 §2.3-1）**：今日 tab 內分成「今日｜行程表」兩個子頁——根 Fragment 變成
 *   （UI 丙-3 起分頁籤搬到頂帶下一列 MobileTopBand 的 tabsRow）＋（子頁）`<TodaySub/>` 或 `<MobileSchedule/>`；子頁在 `scheduleUiStore.mobileSub`
 *   （P4：同一次開啟期間記住、冷啟動回「今日」）。`useMobileToday()` 在**根**呼叫一次：今日切片兩個子頁都要
 *   （行程表的「誤點 N 件」沿今日切片算，§3.4），結果以參數傳給 TodaySub。
 *   `TodaySub` ＝ v1.1.0 的整段版面原封搬進來、結構不動，只有三處改：MobileTicket 改吃票卡模型（§3.7）、
 *   ⋯ sheet 換成兩子頁共用的 MobileTicketSheet（四項＋定期券運休，P11）、全済文案「到路線圖」→「到行程表」（P6）。
 *
 * 版面（由上而下，單欄滿版）：
 *   （頂帶下一列 .ns-tabrow「今日｜行程表」分頁籤＝MobileTopBand 畫；UI 丙-3 F2 前是本頁第一個子節點 .m-sch-seg）
 *   .m-page.m-today  統計一行 → 誤點區（**置頂**＝r1 拍板）→「今天的列車」清單／空狀態
 *   .m-newticket  固定在 tab bar 之上的建票輸入列（不在 .m-page 內＝不跟著捲走；只有今日子頁有，D-主-8）
 *                 回饋甲（D-主-127、128）起＝共用的手機建票列 MobileQuickAdd（common/quickadd）：聚焦後輸入框上方冒一排 chips
 *                 ［掛到］［執行日］［幾點］［締切］［優先］［#荷札］＋快速語法；舊的「無日期」切換併進執行日 chip（清除＝無日期，進收件匣＋復原）。
 *                 IME 三重守門、連打、收據規則都在共用元件裡；chips 在輸入列裡面，軟鍵盤 inset（useViewportHeight）一起推上來。
 *   回饋甲 D-主-131：「今天的列車」區段標右側「済 N・隱藏／顯示」（uiStore.todayHideDone，跟桌機同一個記住的狀態）；
 *                 隱藏時藏的只是済票（拖曳、多選、指出這張票都只看畫面上有的），頁首「完成 d/t」照舊算全部。
 *
 * 與桌機今日視圖刻意不同的四處（都在契約的「不做」清單裡，記在這裡免得日後被當成遺漏）：
 *   1. 沒有頁首日期與日付印——日付印在頂帶（MobileTopBand），同一個畫面不蓋兩枚。
 *   2. 沒有紀念章（StationStamp 122px）、沒有頁尾 Day N/365：單欄 375px 放不下又不是每日操作。
 *   3. 誤點區**可摺疊、但不共用 `uiStore.lateCollapsed`**（2026-09-16 評審 S2 改）：
 *      共用會讓手機收起來的狀態跟著回桌機（那是桌機鍵盤流的記憶），所以用本頁的 useState，
 *      與 WP2 路線圖 zoom／收合的作法同一套。原本「不摺」的理由（誤點本來就該被看見）只對了一半——
 *      誤點 5 件時「今天的列車」第一張票要到 615dp 才出現，394×853 的首屏只剩一張半，
 *      主任務被推出畫面。折衷＝預設展開（一開啟仍看得見）、計數常駐、可收起。
 *   4. 不開詳情側板（契約 §2.7 的「不呼叫」清單；手機殼班改由 ⋯「詳情…」開全螢幕子頁）。
 *      拖曳排序與完成卡在手機殼班補上（D-主-73／74），見檔尾〈手機殼班〉。
 *
 * **主線②（契約 §4.5-2、D-主-10）**：「今天的列車」有時刻的照幾點排在前（排序在 compareTodayRows，本檔只畫）——
 *   兩群之間插小標 `li.subgrp`「未定時・照手排」（兩群都有才畫）；有時刻那群插現在線 `li.nowline`「現在 15:10」
 *   （在最後一張「時刻 ≤ 現在」的列之後；全在未來＝畫在第一張之前；今天沒有有時刻的列＝不畫）；
 *   統計列追加「　下一班 16:30」（today 分區第一張沒交代、時刻還沒到的）。`now` 由 `useMinuteTick()` 一頁一個，傳進每張卡（赭色）。
 *
 * **磨光①（契約 §1.5、§2.4、§9.4、§9.5）**：
 *   返回層——行程表段＝子頁（返回＝切回今日段）；⋯ sheet（含子面板）＝一層 sheet（返回＝同按 ×）。
 *   ⋯ sheet 加改名…／記乘務記錄…／上移・下移／刪除（動作在 useMobileToday；上移下移只給 today 分區、沒時刻的票）。
 *   指出某張票（routeMapReveal 的 target "today"；打開車票、荷札頁、手機搜尋都走這裡）——找到票卡
 *   （`li[data-node-id]`；在收合的誤點區就先展開）→ 捲到畫面中間 → 閃一下底色約 1 秒 → consume。
 *
 * **手機殼班（契約 §一C、§一D）**：
 *   長按拖曳排序（D-主-74）——回饋乙起換成共用元件 useDragReorder（契約 §2；舊的 useLongPressReorder 已刪）：
 *   只有手排座標（today 分區、沒時刻）的票拖得動，有時刻的票、誤點區的票長按後手指一動抖一下＋toast 說為什麼（D-主-80）；
 *   放下走 useMobileToday.moveTo（同 ⋯ 上移／下移的 moveToday）＋「已調整順序」toast＋復原。
 *
 * **回饋乙（D-主-152／153；契約 §0 ☎2、☎3④、§4）**：
 *   - 長按原地放開＝進多選（這張已勾）；多選中點卡片＝加選／取消；選了就在 tab bar 之上浮出 MobileSelectionBar（建票列收起）。
 *     選中的那張被拖＝整批一起走（保持相對順序）。多選範圍＝誤點區＋今天的列車（scope "today"）。
 *   - 滑動手勢：右滑＝蓋済（同検印的 complete）、左滑＝明天（同 ⋯ 第一格 sheetDeferItems；定期券＝本班運休，同 ⋯ 定期券那一格）；
 *     已交代、唯讀、多選中＝滑不開。字跟著那一列變（mobileSelect.usePressedSwipe）。
 *   ⋯ 刪除的子項數走 liveChildCount（同行程表、詳情頁；第二輪——child_total 只數直屬，列車、車廂底下有車廂會少算）。
 *   完成卡（D-主-73）不在本檔畫（MobileShell 掛 MobileCompleteCard）；它開著時建票列由 complete-card.css 收起，
 *   本檔只是照常畫建票列（收的是 display，打到一半的字不丟）。
 *
 * 空狀態文案沿桌機（TodayView 的 1.0c／1.0d 兩塊逐字）；只有操作提示那一句改寫成觸控說法
 *   （桌機原句是「按 Enter 開一張臨時車票；或到路線圖（Ctrl+2）…按 T 排上今天」——手機沒有這些鍵）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { clockText, isClockPast, nowClockMinutes } from "../../lib/date";
import { TIME_FIXED_ORDER_MSG, manualOrderIds, timeOfRow } from "../../domain/scheduledTime";
import { dayCountParts, lateCountText } from "../../domain/dayCount";
import type { TodayRow } from "../../data";
import { MobileTicket } from "./MobileTicket";
import { MobileTicketSheet } from "./MobileTicketSheet";
import { moveNodeTo } from "../common/moveTo";
import { EmptyState } from "../common/EmptyState";
import { useSubSwipe } from "./MobileSegmentedBar";
import { MobileSchedule } from "./MobileSchedule";
import { deleteTicket, liveChildCount, logTicket, renameTicket, useMobileToday, type MobileTodayApi } from "./useMobileToday";
import { useBackLayer } from "./backStack";
import { useRevealStore } from "./routeMapReveal";
import "./mobile-polish.css";
import { isDoneRow, isSettledRow } from "../today/useTodayController";
import { DoneToggleChip, MobileQuickAdd, NO_DEST, type QuickDefaults, type QuickHere } from "../common/quickadd";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";
import { cardFromTodayRow } from "../schedule/ticketCard";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { lineTodayStats } from "../../lines/runtime";
import { useDragReorder } from "../common/dragReorder";
import { batchDragIds, isSelecting, pressSelect, tapSelect, usePressedSwipe, usePruneSelection, useScopeSelection, type SwipePair } from "./mobileSelect";
import { MobileSelectionBar } from "./MobileSelectionBar";
import { sheetDeferItems } from "../schedule/streamModel";
import { TodayBrief } from "../report/TodayBrief";

/** 「指出這張票」的閃底色停多久（D-主-48；CSS 動畫 1s，計時器兜底 reduced-motion 的靜態底色） */
const REVEAL_FLASH_MS = 1000;
/** 要指的票不在今天的清單（或清單一直沒載好）時，等多久就放掉請求 */
const REVEAL_GIVE_UP_MS = 1500;
/** ⋯ sheet 整個流程的返回層 id（本頁登記、MobileTicketSheet 的每張 MSheet 用同一個 id 合併） */
const TODAY_SHEET_LAYER = "core.todaySheet";
/** 誤點區的票長按後一動：抖一下說為什麼（桌機那句提到 T 鍵，手機改指 ⋯ 與左滑） */
const LATE_NO_DRAG_MSG = "誤點的票不能拖曳排序——改日期用 ⋯ 或往左滑";

export default function MobileToday() {
  const c = useMobileToday();
  const sub = useScheduleUiStore((s) => s.mobileSub);
  // 返回層（磨光① §1.5）：行程表段＝子頁，返回＝切回今日段（同段切換）
  useBackLayer("core.schedule", sub === "schedule", () => useScheduleUiStore.getState().setMobileSub("today"), "page");
  return (
    // UI 丙-3 F2：「今日｜行程表」分頁籤畫在頂帶下一列（MobileTopBand 讀 mobileSub 自己畫，不經 MobileShell）
    <>{sub === "today" ? <TodaySub c={c} /> : <MobileSchedule />}</>
  );
}

/* ═══════════════════════════════════════════════════════
 * 今日子頁（v1.1.0 的整段版面原封搬進來）
 * ═══════════════════════════════════════════════════════ */

function TodaySub({ c }: { c: MobileTodayApi }) {
  /** ⋯ 開的 sheet 指向哪一列（null＝關著） */
  const [sheetId, setSheetId] = useState<string | null>(null);
  /** 誤點區展開與否（本地 state，預設展開；不進 uiStore＝不污染桌機的 lateCollapsed，見檔頭 3） */
  const [lateOpen, setLateOpen] = useState(true);
  const sheetRow = useNodeStore((s) => (sheetId ? (s.today.byId[sheetId] ?? null) : null));
  const pageRef = useRef<HTMLDivElement | null>(null);
  useSubSwipe(pageRef, "today");
  /** 「今天的列車」與誤點區兩張清單（條件渲染，callback ref 拿元素——掛上來拖曳才綁得上事件） */
  const [todayList, setTodayList] = useState<HTMLUListElement | null>(null);
  const [lateList, setLateList] = useState<HTMLUListElement | null>(null);

  /* ───────── 已完成開關（回饋甲 D-主-131）：只藏「今天的列車」裡済的票，跟桌機同一個記住的狀態；頁首「完成 d/t」照舊算全部 ───────── */
  const todayHideDone = useUiStore((s) => s.todayHideDone);
  const toggleTodayHideDone = useUiStore((s) => s.toggleTodayHideDone);
  const doneToday = c.todayRows.filter(isDoneRow).length;
  const shownToday = todayHideDone ? c.todayRows.filter((r) => !isDoneRow(r)) : c.todayRows;

  /* ───────── 建票列（回饋甲 D-主-127、128）：掛到＝無路線、執行日＝今天；清掉執行日＝無日期進收件匣 ───────── */
  const qaDefaults = useMemo<QuickDefaults>(() => ({ dest: NO_DEST, scheduledOn: c.dateKey, noDateLabel: true }), [c.dateKey]);
  const qaHere = useMemo<QuickHere>(() => ({ kind: "today", dateKey: c.dateKey }), [c.dateKey]);

  /* ───────── 多選（回饋乙 D-主-152）：長按原地放開＝選起來，多選中點卡片＝加選／取消 ───────── */
  // 藏起來的済票不在畫面上：不進多選範圍（選了看不到的票，批量動作會碰到主人沒看見的東西）
  const order = [...c.lateRows.map((r) => r.id), ...shownToday.map((r) => r.id)];
  const picked = useScopeSelection("today");
  const selecting = picked.length > 0;
  usePruneSelection("today", order);
  const latestOrder = () => {
    const rows = useNodeStore.getState().today.rows;
    const hide = useUiStore.getState().todayHideDone;
    return [
      ...rows.filter((r) => r.bucket !== "today"),
      ...rows.filter((r) => r.bucket === "today" && !(hide && isDoneRow(r))),
    ].map((r) => r.id);
  };

  /* ───────── 滑動手勢（☎3④）：右滑＝蓋済（同検印）、左滑＝明天（同 ⋯ 第一格；定期券＝本班運休，同 ⋯ 的定期券那一格） ───────── */
  const swipeFor = (id: string): SwipePair => {
    const row = useNodeStore.getState().today.byId[id];
    if (!row || isSelecting("today")) return {};
    const card = cardFromTodayRow(row, c.dateKey);
    if (card.readOnly || card.done || card.suspended) return {};
    const out: SwipePair = { right: { label: "蓋済", tone: "seal", run: () => c.complete(id) } };
    if (card.isRepeat) out.left = { label: "運休", tone: "ink", run: () => c.skip(id, true) };
    else {
      const { first } = sheetDeferItems(card.railDate, card.scheduledOn, c.dateKey);
      out.left = { label: first.label === "往後推一天" ? "晚一天" : "明天", tone: "ink", run: () => c.defer(id, first.day) };
    }
    return out;
  };
  const todaySwipe = usePressedSwipe(todayList, swipeFor);
  const lateSwipe = usePressedSwipe(lateList, swipeFor);

  // 長按拖曳（手機殼班 D-主-74 → 回饋乙換成共用元件）：手排座標＝manualOrderIds（同 ⋯ 上移／下移、同 moveToday）；
  // 有時刻的票長按照樣選得起來、手指一動才抖一下＋toast 說為什麼（D-主-80）
  const manual = manualOrderIds(c.todayRows);
  const refuse = (_id: string, why: string) => useUiStore.getState().showToast({ message: why }, 3600);
  useDragReorder({
    root: todayList,
    scrollRef: pageRef,
    // 畫面上有的才給拖（藏起來的済票不在 DOM 裡；同桌機）；落點換算照舊對全部的手排順序（moveTo）
    items: manual.filter((id) => shownToday.some((r) => r.id === id)).map((id) => ({ id })),
    canDrag: (id) => (manual.includes(id) ? true : TIME_FIXED_ORDER_MSG),
    onRefuse: refuse,
    dragIds: (id) => batchDragIds("today", id, manualOrderIds(useNodeStore.getState().today.rows)),
    onDrop: (ids, place) => {
      if (place.kind === "slot") c.moveTo(ids, place);
    },
    onPressRelease: (id) => pressSelect("today", id, latestOrder()),
    swipe: todaySwipe,
  });
  // 誤點區：拖不動也要回話（理由同一句）；長按照樣選起來、照樣能滑
  useDragReorder({
    root: lateList,
    scrollRef: pageRef,
    items: c.lateRows.map((r) => ({ id: r.id })),
    slots: false,
    canDrag: () => LATE_NO_DRAG_MSG,
    onRefuse: refuse,
    onDrop: () => undefined,
    onPressRelease: (id) => pressSelect("today", id, latestOrder()),
    swipe: lateSwipe,
  });
  const now = useMinuteTick();
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  // 返回層（磨光① §1.5）：⋯ sheet 與它的子面板（選日期／幾點／改名／記乘務記錄）是同一層，返回＝整個流程結束（同按 ×）。
  // active 看 sheetRow 而不是 sheetId：票在 sheet 開著時被刪／搬走，畫面上已經沒有 sheet，就不該再擋返回鍵。
  // UI 丙-3 F3：sheet 換成 MSheet 後它也會自己登記——同一個 id 傳進去（backId），refcount 合併成一層、返回鍵按一次就關
  useBackLayer(TODAY_SHEET_LAYER, sheetRow !== null, () => setSheetId(null));

  /* ───────── 指出某張票（A7 今日半邊；routeMapReveal 的 target "today"）───────── */
  const reveal = useRevealStore((s) => (s.req?.target === "today" ? s.req : null));
  /** 正在閃的那張（約 1 秒） */
  const [flashId, setFlashId] = useState<string | null>(null);
  const revealId = reveal?.nodeId ?? null;
  const revealWhere =
    revealId === null
      ? null
      : shownToday.some((r) => r.id === revealId)
        ? "today"
        : c.lateRows.some((r) => r.id === revealId)
          ? "late"
          : null;
  useEffect(() => {
    if (!reveal) return;
    const { nonce, nodeId } = reveal;
    const consume = () => useRevealStore.getState().consume(nonce);
    if (nodeId === null) {
      consume();
      return;
    }
    if (revealWhere === null) {
      // 清單還沒載好（剛切回今日、剛重載）就等它；等不到（票不在今天的清單）就放掉，請求不卡在槽裡
      const t = window.setTimeout(consume, REVEAL_GIVE_UP_MS);
      return () => window.clearTimeout(t);
    }
    // 收合的誤點區先展開，下一輪 render 再捲
    if (revealWhere === "late" && !lateOpen) {
      setLateOpen(true);
      return;
    }
    const li = pageRef.current?.querySelector<HTMLElement>(`li[data-node-id="${CSS.escape(nodeId)}"]`);
    if (!li) {
      // 清單有它、DOM 還沒畫出來（極端時序）：同樣等一下就放掉，不讓請求卡在槽裡、下次重掛時重播
      const t = window.setTimeout(consume, REVEAL_GIVE_UP_MS);
      return () => window.clearTimeout(t);
    }
    const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    li.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    setFlashId(nodeId);
    consume();
  }, [reveal, revealWhere, lateOpen]);
  useEffect(() => {
    if (flashId === null) return;
    const t = window.setTimeout(() => setFlashId(null), REVEAL_FLASH_MS);
    return () => window.clearTimeout(t);
  }, [flashId]);

  const { total, left } = c.stats;
  // 磨光⑤ N11：完成數字樣走 domain/dayCount（與桌機今日、串流今日列同一句）
  const countParts = dayCountParts(c.stats);
  /** 別線的統計段（插槽 todayStats，接縫 #66）；沒有線填＝空陣列，兩條路都與之前逐字相同 */
  const stats = lineTodayStats("mobile");
  const allSettled = !c.empty && left === 0 && c.lateRows.every((r) => r.occurrence !== null || r.status === "done");

  /* ───────── 時刻（主線②）：分群、現在線、下一班 ───────── */
  const railOf = (r: TodayRow) => r.occurrence?.due_on ?? r.scheduled_on ?? c.dateKey;
  // 畫的是 shownToday（已完成開關隱藏時少了済票）；「下一班」只看沒交代的，藏不藏都一樣
  const timed = shownToday.filter((r) => timeOfRow(r) !== null);
  const hasUntimed = timed.length < shownToday.length;
  const nowMin = nowClockMinutes(c.dateKey, dayStartHour, now);
  /** 現在線插在 timed 的第幾張之前（timed.length＝最後一張之後）；null＝不畫 */
  let nowAt: number | null = null;
  if (timed.length > 0 && nowMin !== null) {
    let lastPast = -1;
    timed.forEach((r, i) => {
      if (isClockPast(railOf(r), timeOfRow(r), now)) lastPast = i;
    });
    nowAt = lastPast + 1;
  }
  const next = timed.find((r) => !isSettledRow(r) && !isClockPast(railOf(r), timeOfRow(r), now));

  const ticket = (r: TodayRow) => (
    <MobileTicket
      key={r.id}
      card={cardFromTodayRow(r, c.dateKey)}
      route={c.routeOf(r)}
      today={c.dateKey}
      fresh={c.freshId === r.id}
      flash={flashId === r.id}
      now={now}
      onComplete={(card) => c.complete(card.nodeId)}
      onMore={(card) => setSheetId(card.nodeId)}
      dragId={r.id}
      selecting={selecting}
      picked={picked.includes(r.id)}
      onPick={() => tapSelect("today", r.id, latestOrder())}
    />
  );
  const nowLine = (
    <li key="__now" className="nowline" aria-label={`現在 ${clockText(nowMin ?? 0) ?? ""}`}>
      <span>
        <small>現在</small> {clockText(nowMin ?? 0)}
      </span>
    </li>
  );
  const todayItems: ReactNode[] = [];
  timed.forEach((r, i) => {
    if (nowAt === i) todayItems.push(nowLine);
    todayItems.push(ticket(r));
  });
  if (nowAt === timed.length) todayItems.push(nowLine);
  if (hasUntimed) {
    if (timed.length > 0) {
      todayItems.push(
        <li key="__subgrp" className="subgrp">
          不排時間・手動排序</li>,
      );
    }
    for (const r of shownToday) if (timeOfRow(r) === null) todayItems.push(ticket(r));
  }

  return (
    <>
      <div className="m-page m-today" ref={pageRef}>
        {countParts ? (
          <p className="m-today-stats">
            完成 <b>{countParts.done}</b>/<b>{countParts.total}</b>
            <span className="m-today-left">・{countParts.tail}</span>
            {next && (
              <span className="m-today-next">
                {"　"}下一班 <b className="tmx">{timeOfRow(next)}</b>
              </span>
            )}
            {stats.map((S, i) => (
              <S key={i} shell="mobile" dateKey={c.dateKey} lead wrap={false} />
            ))}
          </p>
        ) : (
          // 今天沒有車票：核心不畫統計列；線的統計段有內容時自己包 `.m-today-stats`（wrap），沒內容回 null——不留空的 <p>
          stats.map((S, i) => <S key={i} shell="mobile" dateKey={c.dateKey} lead={false} wrap />)
        )}

        {/* ② 運行報告 D-主-184：「今日小結」一行（點了進運行報告）——統計列之後、清單之前（原型 scr=today&device=mob 的位置） */}
        <TodayBrief shell="mobile" />

        {/* ═══ 誤點區（置頂＝r1 拍板；含 D-③-7 浮上來的締切段）═══ */}
        {c.lateRows.length > 0 && (
          <>
            <div className="sec late">
              <h3>誤點</h3>
              <span className="rule" />
              {/* 摺疊鈕＝計數本身（語彙逐字同桌機 TodayView：「N 件」＋▾，收起時箭頭轉 -90°）。
                  觸控目標 44px 由 mobile.css 的負 margin 撐出來，段距視覺不變。 */}
              <button
                type="button"
                aria-expanded={lateOpen}
                aria-label={`誤點 ${lateCountText(c.late)}，${lateOpen ? "收起" : "展開"}`}
                onClick={() => setLateOpen((v) => !v)}
                className="note fold"
              >
                {/* 接縫 #104：數的是還沒交代的（今天補済、留在原位的那張不算），與行程表誤點列同一支 lateCount */}
                {lateCountText(c.late)}
                <span className="caret" aria-hidden>
                  ▾
                </span>
              </button>
            </div>
            {lateOpen && (
              <ul className="m-tk-list" aria-label="誤點" ref={setLateList}>
                {c.lateRows.map(ticket)}
              </ul>
            )}
          </>
        )}

        {/* ═══ 今天的列車 ═══ */}
        {/* 磨光⑤ S10：第一次 loadToday 回來前清單區留白（不放骨架、不畫空狀態與慶祝） */}
        {!c.loaded ? null : c.empty ? (
          <EmptyState tone="first" title="今天還沒有班次" desc="在下方寫一張車票，按「発券」。" />
        ) : (
          <>
            {c.todayRows.length > 0 && (
              <>
                <div className="sec">
                  <h3>今天的列車</h3>
                  <span className="rule" />
                  <span className="note">{total} 張</span>
                  {/* 已完成開關（回饋甲 D-主-131；原型 q4a-A；預設顯示＝済票留原位到日界線） */}
                  {doneToday > 0 && (
                    <DoneToggleChip count={doneToday} showing={!todayHideDone} onToggle={toggleTodayHideDone} />
                  )}
                </div>
                <ul className="m-tk-list" aria-label="今天的列車" ref={setTodayList}>
                  {todayItems}
                </ul>
              </>
            )}

            {/* 1.0d 全完成慶祝（語氣與 1.0c 分開：這裡是收工，不是招募）——文案逐字同桌機 */}
            {allSettled && (
              <EmptyState tone="done" title="今天的班次都到站了" desc="剩下的時間是你的。明天的事，可以先去行程表排好。" />
            )}
          </>
        )}
      </div>

      {/* 建票列（回饋甲：舊 MobileNewTicket 換共用的手機建票列；chips 聚焦後才出現，「無日期」併進執行日 chip） */}
      <MobileQuickAdd defaults={qaDefaults} here={qaHere} />
      <MobileSelectionBar scope="today" />

      {sheetRow && (
        <MobileTicketSheet
          card={cardFromTodayRow(sheetRow, c.dateKey)}
          today={c.dateKey}
          onDefer={(d) => c.defer(sheetRow.id, d)}
          onSkip={(s) => c.skip(sheetRow.id, s)}
          onSetTime={(t, est) => c.setTime(sheetRow.id, t, est)}
          onSetRunTime={(t) => c.setRunTime(sheetRow.id, t)}
          onClearRunTime={() => c.clearRunTime(sheetRow.id)}
          onRename={(name) => renameTicket(sheetRow.id, name, sheetRow.name)}
          onLog={(body) => logTicket(sheetRow.id, body)}
          onMove={(dest) => void moveNodeTo(sheetRow.id, dest)}
          onDelete={() => deleteTicket(sheetRow.id, sheetRow.name, liveChildCount(sheetRow.id))}
          reorder={(() => {
            const ro = c.reorderOf(sheetRow.id);
            return ro && { ...ro, onMove: (d: -1 | 1) => c.move(sheetRow.id, d) };
          })()}
          backId={TODAY_SHEET_LAYER}
          onClose={() => setSheetId(null)}
        />
      )}
    </>
  );
}
