/**
 * MobileToday——今日 tab 的手機頁（v1.1.0；WP1）＝副平台的落地頁。
 *
 * 拍板依據：D-1.1-2「副平台最小操作＝看今日、蓋済、推遲到明天、開臨時車票」＋契約 §2.7 的呼叫表。
 * 狀態機在 `useMobileToday.ts`（載入／蓋済／改期／建票），本檔只負責畫與覆蓋層以外的本地互動：
 *   ⋯ 開的底部 sheet（本地 useState；不進 uiStore——它只活在這一頁，關頁就該消失）。
 *
 * **主線車次①（D-主-5、契約 §2.3-1）**：今日 tab 內分成「今日｜行程表」兩個子頁——根 Fragment 變成
 *   `<MobileSegmentedBar/>` ＋（子頁）`<TodaySub/>` 或 `<MobileSchedule/>`；子頁在 `scheduleUiStore.mobileSub`
 *   （P4：同一次開啟期間記住、冷啟動回「今日」）。`useMobileToday()` 在**根**呼叫一次：今日切片兩個子頁都要
 *   （行程表的「誤點 N 件」沿今日切片算，§3.4），結果以參數傳給 TodaySub。
 *   `TodaySub` ＝ v1.1.0 的整段版面原封搬進來、結構不動，只有三處改：MobileTicket 改吃票卡模型（§3.7）、
 *   ⋯ sheet 換成兩子頁共用的 MobileTicketSheet（四項＋定期券運休，P11）、全済文案「到路線圖」→「到行程表」（P6）。
 *
 * 版面（由上而下，單欄滿版）：
 *   .m-sch-seg  兩段切換
 *   .m-page.m-today  統計一行 → 誤點區（**置頂**＝r1 拍板）→「今天的列車」清單／空狀態
 *   .m-newticket  固定在 tab bar 之上的建票輸入列（不在 .m-page 內＝不跟著捲走；只有今日子頁有，D-主-8）
 *
 * 與桌機今日視圖刻意不同的四處（都在契約的「不做」清單裡，記在這裡免得日後被當成遺漏）：
 *   1. 沒有頁首日期與日付印——日付印在頂帶（MobileTopBand），同一個畫面不蓋兩枚。
 *   2. 沒有紀念章（StationStamp 122px）、沒有頁尾 Day N/365：單欄 375px 放不下又不是每日操作。
 *   3. 誤點區**可摺疊、但不共用 `uiStore.lateCollapsed`**（2026-09-16 評審 S2 改）：
 *      共用會讓手機收起來的狀態跟著回桌機（那是桌機鍵盤流的記憶），所以用本頁的 useState，
 *      與 WP2 路線圖 zoom／收合的作法同一套。原本「不摺」的理由（誤點本來就該被看見）只對了一半——
 *      誤點 5 件時「今天的列車」第一張票要到 615dp 才出現，394×853 的首屏只剩一張半，
 *      主任務被推出畫面。折衷＝預設展開（一開啟仍看得見）、計數常駐、可收起。
 *   4. 不做拖曳排序、不開詳情側板、不開完成卡（契約 §2.7 的「不呼叫」清單）。
 *
 * **主線②（契約 §4.5-2、D-主-10）**：「今天的列車」有時刻的照幾點排在前（排序在 compareTodayRows，本檔只畫）——
 *   兩群之間插小標 `li.subgrp`「未定時・照手排」（兩群都有才畫）；有時刻那群插現在線 `li.nowline`「現在 15:10」
 *   （在最後一張「時刻 ≤ 現在」的列之後；全在未來＝畫在第一張之前；今天沒有有時刻的列＝不畫）；
 *   統計列追加「　下一班 16:30」（today 分區第一張沒交代、時刻還沒到的）。`now` 由 `useMinuteTick()` 一頁一個，傳進每張卡（赭色）。
 *
 * 空狀態文案沿桌機（TodayView 的 1.0c／1.0d 兩塊逐字）；只有操作提示那一句改寫成觸控說法
 *   （桌機原句是「按 Enter 開一張臨時車票；或到路線圖（Ctrl+2）…按 T 排上今天」——手機沒有這些鍵）。
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { clockText, isClockPast, nowClockMinutes } from "../../lib/date";
import { timeOfRow } from "../../domain/scheduledTime";
import type { TodayRow } from "../../data";
import { MobileTicket } from "./MobileTicket";
import { MobileTicketSheet } from "./MobileTicketSheet";
import { MobileSegmentedBar, useSubSwipe } from "./MobileSegmentedBar";
import { MobileSchedule } from "./MobileSchedule";
import { useMobileToday, type MobileTodayApi } from "./useMobileToday";
import { isSettledRow } from "../today/useTodayController";
import { useScheduleUiStore } from "../schedule/scheduleUiStore";
import { cardFromTodayRow } from "../schedule/ticketCard";
import { useMinuteTick } from "../schedule/useMinuteTick";
import { lineTodayStats } from "../../lines/runtime";

export default function MobileToday() {
  const c = useMobileToday();
  const sub = useScheduleUiStore((s) => s.mobileSub);
  return (
    <>
      <MobileSegmentedBar />
      {sub === "today" ? <TodaySub c={c} /> : <MobileSchedule />}
    </>
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
  const now = useMinuteTick();
  const dayStartHour = useUiStore((s) => s.dayStartHour);

  const { total, done, left } = c.stats;
  /** 別線的統計段（插槽 todayStats，接縫 #66）；沒有線填＝空陣列，兩條路都與之前逐字相同 */
  const stats = lineTodayStats("mobile");
  const allSettled = !c.empty && left === 0 && c.lateRows.every((r) => r.occurrence !== null || r.status === "done");

  /* ───────── 時刻（主線②）：分群、現在線、下一班 ───────── */
  const railOf = (r: TodayRow) => r.occurrence?.due_on ?? r.scheduled_on ?? c.dateKey;
  const timed = c.todayRows.filter((r) => timeOfRow(r) !== null);
  const hasUntimed = timed.length < c.todayRows.length;
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
      now={now}
      onComplete={(card) => c.complete(card.nodeId)}
      onMore={(card) => setSheetId(card.nodeId)}
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
          未定時・照手排
        </li>,
      );
    }
    for (const r of c.todayRows) if (timeOfRow(r) === null) todayItems.push(ticket(r));
  }

  return (
    <>
      <div className="m-page m-today" ref={pageRef}>
        {total > 0 ? (
          <p className="m-today-stats">
            完成 <b>{done}</b>/<b>{total}</b>
            {left > 0 && <span className="m-today-left">・還有 {left} 張</span>}
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
                aria-label={`誤點 ${c.lateRows.length} 件，${lateOpen ? "收起" : "展開"}`}
                onClick={() => setLateOpen((v) => !v)}
                className="note fold"
              >
                {c.lateRows.length} 件
                <span className="caret" aria-hidden>
                  ▾
                </span>
              </button>
            </div>
            {lateOpen && (
              <ul className="m-tk-list" aria-label="誤點">
                {c.lateRows.map(ticket)}
              </ul>
            )}
          </>
        )}

        {/* ═══ 今天的列車 ═══ */}
        {c.empty ? (
          <div className="m-empty">
            <div className="sec">
              <h3>今天還沒有班次</h3>
              <span className="rule" />
            </div>
            <p className="m-empty-body">在下面的輸入列打一件事，按「発券」就開一張臨時車票。</p>
          </div>
        ) : (
          <>
            {c.todayRows.length > 0 && (
              <>
                <div className="sec">
                  <h3>今天的列車</h3>
                  <span className="rule" />
                  <span className="note">{total} 張</span>
                </div>
                <ul className="m-tk-list" aria-label="今天的列車">
                  {todayItems}
                </ul>
              </>
            )}

            {/* 1.0d 全完成慶祝（語氣與 1.0c 分開：這裡是收工，不是招募）——文案逐字同桌機 */}
            {allSettled && (
              <div className="m-empty is-cheer">
                <div className="sec">
                  <h3>今天的班次都到站了</h3>
                  <span className="rule" />
                </div>
                <p className="m-empty-body">剩下的時間是你的。明天要跑的，可以到行程表先排好。</p>
              </div>
            )}
          </>
        )}
      </div>

      <MobileNewTicket onCreate={c.createTicket} />

      {sheetRow && (
        <MobileTicketSheet
          card={cardFromTodayRow(sheetRow, c.dateKey)}
          today={c.dateKey}
          onDefer={(d) => c.defer(sheetRow.id, d)}
          onSkip={(s) => c.skip(sheetRow.id, s)}
          onSetTime={(t, est) => c.setTime(sheetRow.id, t, est)}
          onSetRunTime={(t) => c.setRunTime(sheetRow.id, t)}
          onClearRunTime={() => c.clearRunTime(sheetRow.id)}
          onClose={() => setSheetId(null)}
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════
 * 建票輸入列——固定在 tab bar 之上（不在 .m-page 內，捲動時不會跑掉）
 * ═══════════════════════════════════════════════════════ */

/**
 * 兩種票共用一條輸入列，靠「無日期」切換選目的地（沿桌機 Enter／Shift+Enter 的兩條種子動線）：
 *   關＝臨時車票排今天（票留在眼前，看得見＝不出收據）
 *   開＝無日期票進收件匣（票立刻離開今日，toast 是唯一收據、帶「取消建立」）
 * 切換是 `role="switch"` 的常駐鈕而不是「長按送出」：長按在觸控上沒有可見的前置提示，
 *   主人按下去之前不知道會發生什麼；一顆亮著的「無日期」把狀態攤在檯面上。
 *
 * IME 守門（鐵則 5）：`isComposing‖keyCode===229` 之外再加一支 composition 旗標——
 *   Android 部分 IME 送出的 keydown 既不帶 isComposing 也不是 229（Plan 草案 §5 的已知雷）。
 *   `enterKeyHint="done"` 讓 Android 軟鍵盤右下角顯示「完成」而不是換行。
 */
function MobileNewTicket({ onCreate }: { onCreate(name: string, inbox: boolean): Promise<boolean> }) {
  const [text, setText] = useState("");
  const [inbox, setInbox] = useState(false);
  const composing = useRef(false);

  const submit = async () => {
    if (!text.trim()) return;
    const ok = await onCreate(text, inbox);
    // 成功才清空＝失敗時主人打的字還在（createNode 回 null 已經吐過 toast）。
    // 不主動 blur：連打是預期用法（桌機 Enter 之後草稿列會續開一張），鍵盤收掉反而礙事。
    if (ok) setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="m-newticket">
      <button
        type="button"
        role="switch"
        aria-checked={inbox}
        aria-label="無日期——建好直接放進收件匣"
        onClick={() => setInbox((v) => !v)}
        className={"m-nt-toggle" + (inbox ? " is-on" : "")}
      >
        無日期
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        placeholder={inbox ? "放進收件匣的一件事…" : "臨時想到的一件事…"}
        aria-label={inbox ? "輸入收件匣車票的名稱" : "輸入臨時車票的名稱"}
        enterKeyHint="done"
        spellCheck={false}
        autoComplete="off"
        className="m-nt-input"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!text.trim()}
        className="m-nt-go ns-btn btn-seal"
      >
        発券
      </button>
    </div>
  );
}
