/**
 * TimeGrid——時段畫布（主線階段②；契約 §4.7）。桌機「週・時段」（乙 `WeekTimeGrid`）與手機「3 天時段」
 * （丙 `MobileTimeDays`）共用同一份 DOM；手機差異只靠 `[data-shell="mobile"]` 覆寫 CSS 變數與少數樣式
 * （寫在 `schedule-mobile.css`，丙）。桌機值在 `./timegrid.css`。視覺依據＝原型 `prototypes/主線-預定時刻.html`
 * 場景 3、5（`:454-540` 樣式、`:1073-1150` 版面）。
 *
 * DOM／class／data-* 契約（兩端共用，改這裡＝改契約）：
 *
 *   div.ns-tg[data-shell][.is-fixed][style=--n:N;--cw]
 *   └─ div.ns-tg-scroll                                   唯一捲動容器
 *      └─ div.ns-tg-grid
 *         ├─ div.ns-tg-row.ns-tg-head                     sticky top:0
 *         │    div.ns-tg-corner ＋ div.ns-tg-dh[data-day][.is-today|.is-past|.is-sel] × N
 *         │      （span.wd ＋ span.dn ＋ span.cnt「N 班」（桌機）＋ span.sime「〆」(span.n)）
 *         ├─ div.ns-tg-row.ns-tg-band                     sticky top:var(--headH)
 *         │    div.ns-tg-corner「未定時」＋ div.ns-tg-bc[data-day][.is-today|.is-sel] × N
 *         │      （button.ns-tg-chip[data-row-key][.done|.skipped|.late|.oob] × ≤3 桌機／≤2 手機 ＋ span.ns-tg-more「＋N」）
 *         └─ div.ns-tg-row.ns-tg-body
 *              div.ns-tg-gut（sticky left:0）  span.hl[.nite] × 刻度（small＝「深夜 0 時」「N 時」）＋ span.nowpill
 *              div.ns-tg-col[data-day][.is-today|.is-past|.is-sel|.is-snap] × N
 *                （.is-snap：只有 colWidth（固定欄寬）時，每 snapEvery 欄的第一欄＝scroll-snap 錨；捲動容器的
 *                  scroll-padding-left＝--gw，停點＝欄起點 − 刻度欄寬，與 scrollToDay 同一把尺）
 *                div.ns-tg-night ＋ div.ns-tg-midnight ＋ div.ns-tg-now[.ghost]
 *                ＋ button.ns-tg-blk[data-row-key][.short|.done|.skipped|.past|.doing|.noest|.late-day|.over|.is-sel] × blocks
 *                    （span.bt 時刻（span.nx 隔天…，桌機）＋ span.bn 票名 ＋ span.mini-seal「済」）
 *
 * 幾何：塊與現在線的 top／height 用**實量的每小時高**（`.ns-tg-gut` 高 ÷ 24）算成 px——`--H` 由 CSS 決定
 * （桌機 44、手機 54），元件不寫死；`.short`／`--lc` 也由實量值判。最小高與 `.short` 門檻照契約（桌機 18／30、
 * 手機 26／40）。
 *
 * 點擊（契約 §1-11、§4.7-5）：
 *   桌機｜點塊／籤 ⇒ onPick；點欄頭、欄內空白、籤帶空白、「＋N」⇒ onHead
 *   手機｜塊與籤本身照樣 onPick；欄內空白 ⇒ 換算成牆鐘分鐘，命中塊（含最小高與 .noest 的 45 分）⇒ 那塊，
 *        沒命中 ⇒ 同欄 |startMin − 點到分| ≤ 20 最近的塊，還沒有 ⇒ onHead；籤帶空白同理（只有一個籤＝整格都算它，
 *        否則取垂直距離 ≤ 22px 的最近籤）。觸控目標因此不必每顆都撐到 44px。
 *
 * 不做（契約 §4.8 末）：拖塊改時刻、拉長改預計、點空白建票。
 */
import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type Ref } from "react";
import { parseRule, WEEKDAY_LABEL, type NodeRow } from "../../domain";
import { clockText, isClockPast, nextDayNote, nowClockMinutes } from "../../lib/date";
import { hourTicks, NO_ESTIMATE_MIN, type TimeGridBlock, type TimeGridDay, type TimeGridUntimed } from "./timeGridModel";
import "./timegrid.css";

export type TimeGridShell = "desktop" | "mobile";

/** 命令式出口（手機 3 天頁要自己捲橫向、回「今日」；桌機通常用不到） */
export interface TimeGridHandle {
  /** 唯一捲動容器 `.ns-tg-scroll`（手機掛 scrollend、平移視窗補 scrollLeft 用） */
  scroller(): HTMLDivElement | null;
  /** 縱向捲到「現在線 − 2 小時」（今天在 days 內）或 08:00 相對位置；smooth 在 prefers-reduced-motion 下自動關 */
  scrollToNow(smooth?: boolean): void;
  /** 縱向捲到某個牆鐘分鐘（自 00:00 起，可 ≥ 1440）出現在籤帶正下方 */
  scrollToClock(min: number, smooth?: boolean): void;
  /** 橫向捲到某一天那欄貼齊刻度欄右緣（手機翻頁）；不在 days 內 ⇒ 不動 */
  scrollToDay(date: string, smooth?: boolean): void;
  /**
   * 橫向（某一天貼齊刻度欄）與縱向（某牆鐘分鐘）**同一次** scrollTo。
   * 兩個軸分兩次各發平滑捲動會互相中止（同一個捲動容器上新的捲動取消進行中的平滑捲動），手機「今日」鈕要用這支。
   * date 不在 days 內 ⇒ 只捲縱向。
   */
  scrollToDayClock(date: string, min: number, smooth?: boolean): void;
}

export interface TimeGridProps {
  /** timeGridModel() 的輸出；欄序＝陣列序 */
  days: TimeGridDay[];
  dayStartHour: number;
  /** useMinuteTick() 的現在（現在線、赭色） */
  now: number;
  /** 日界線今天（todayKey(dayStartHour)）：今天欄、過去欄、現在線畫在哪 */
  today: string;
  /** 桌機鍵盤落點那一天（欄頭／籤帶／欄加 .is-sel） */
  selectedDay?: string | null;
  /** 路線表（塊左邊條與籤的點取 routes[].color） */
  routes: NodeRow[];
  /** entries 提到的節點表（票名、狀態、預計） */
  nodes: Record<string, NodeRow>;
  shell: TimeGridShell;
  /** 點塊／籤（手機含「點附近」）：nodeId＋那一班的日子；el＝被點的塊或籤（桌機當錨） */
  onPick(date: string, nodeId: string, el: HTMLElement): void;
  /** 點欄頭／欄內空白（手機：附近沒有塊）；el＝欄頭或那一欄 */
  onHead(date: string, el: HTMLElement): void;

  // ── 以下是契約 §4.7 props 之外「只加不改」的選填項 ──
  /** 選中的塊（`${date}-${node_id}`＝TimeGridBlock.key／籤的 data-row-key）⇒ .is-sel */
  selectedKey?: string | null;
  /** 固定欄寬（px）⇒ 根加 .is-fixed、`--cw`，欄不再平分容器寬（手機 3 天頁：(容器寬 − 刻度欄) / 3） */
  colWidth?: number;
  /** 固定欄寬時每幾欄放一個 scroll-snap 錨（預設 3） */
  snapEvery?: number;
  /** 手機點籤帶的「＋N」（第三張起的未定時票在畫布裡點不到）⇒ 叫這個，不走「最近的籤」；沒給就照 onHead */
  onMore?(date: string): void;
  /** 命令式出口 */
  handleRef?: Ref<TimeGridHandle>;
}

/** 契約 §4.7 的兩組固定值（--H 只是量不到時的退路；真正的每小時高以 CSS 為準） */
const METRICS: Record<TimeGridShell, { fallbackH: number; minH: number; shortH: number; maxChips: number }> = {
  desktop: { fallbackH: 44, minH: 18, shortH: 30, maxChips: 3 },
  mobile: { fallbackH: 54, minH: 26, shortH: 40, maxChips: 2 },
};
/** 手機「點附近」：塊的容許距離（分）與籤的容許距離（px） */
const NEAR_BLOCK_MIN = 20;
const NEAR_CHIP_PX = 22;
/** 刻度字與現在時刻牌互讓的距離（分；原型 :1121） */
const PILL_GAP_MIN = 14;

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 一塊畫在畫布上的樣子（px；由實量的每小時高算） */
interface BlockLayout {
  b: TimeGridBlock;
  node: NodeRow | undefined;
  top: number;
  height: number;
  short: boolean;
  lc: number;
}

function layoutBlock(b: TimeGridBlock, node: NodeRow | undefined, axisMin: number, H: number, minH: number, shortH: number): BlockLayout {
  const top = ((b.startMin - axisMin) / 60) * H;
  const dur = b.noEstimate ? NO_ESTIMATE_MIN : b.endMin - b.startMin;
  let height = Math.max((dur / 60) * H, minH);
  const bottom = 24 * H;
  if (top + height > bottom) height = Math.max(bottom - top, 0);
  return { b, node, top, height, short: height < shortH, lc: Math.max(1, Math.floor((height - 19) / 14.3)) };
}

export function TimeGrid({
  days,
  dayStartHour,
  now,
  today,
  selectedDay = null,
  routes,
  nodes,
  shell,
  onPick,
  onHead,
  onMore,
  selectedKey = null,
  colWidth,
  snapEvery = 3,
  handleRef,
}: TimeGridProps) {
  const m = METRICS[shell];
  const mobile = shell === "mobile";
  const axisMin = dayStartHour * 60;
  const scrollRef = useRef<HTMLDivElement>(null);
  const gutRef = useRef<HTMLDivElement>(null);
  const [H, setH] = useState(m.fallbackH);

  // 每小時高以 CSS（--H）為準：量 .ns-tg-gut（高 = 24 × --H）。版面前量，不閃
  useLayoutEffect(() => {
    const g = gutRef.current;
    if (!g) return;
    const measured = g.getBoundingClientRect().height / 24;
    if (measured > 0 && Math.abs(measured - H) > 0.01) setH(measured);
  });

  const routeColor = (node: NodeRow | undefined): string => {
    const rid = node?.route_id;
    const r = rid ? routes.find((x) => x.id === rid) : undefined;
    return r?.color ?? "var(--route-none)";
  };

  // 現在線：只在今天落在 days 內時畫（今天實線、其他天淡虛線、刻度欄時刻牌）；別週不畫
  const nowMin = useMemo(() => {
    if (!days.some((d) => d.date === today)) return null;
    return nowClockMinutes(today, dayStartHour, now);
  }, [days, today, dayStartHour, now]);
  const nowTop = nowMin === null ? null : ((nowMin - axisMin) / 60) * H;

  const ticks = useMemo(() => hourTicks(dayStartHour), [dayStartHour]);
  const nightHours = Math.max(0, Math.min(24, dayStartHour)); // 24:00 之後到軸尾（日界線 06 ⇒ 6 小時）

  const laid = useMemo(
    () =>
      days.map((d) => d.blocks.map((b) => layoutBlock(b, nodes[b.entry.node_id], axisMin, H, m.minH, m.shortH))),
    [days, nodes, axisMin, H, m.minH, m.shortH],
  );

  // ── 捲動 ──
  const scrollTopFor = (min: number) => Math.max(((min - axisMin) / 60) * H, 0);
  const scrollToClock = (min: number, smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: scrollTopFor(min), behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  };
  const initialClock = (): number => (nowMin !== null ? nowMin - 120 : 8 * 60);
  const scrollToNow = (smooth = false) => scrollToClock(initialClock(), smooth);
  const scrollToDay = (date: string, smooth = false) => {
    const el = scrollRef.current;
    const col = el?.querySelector<HTMLElement>(`.ns-tg-col[data-day="${date}"]`);
    const gut = gutRef.current;
    if (!el || !col || !gut) return;
    el.scrollTo({ left: col.offsetLeft - gut.offsetWidth, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  };

  const scrollToDayClock = (date: string, min: number, smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const col = el.querySelector<HTMLElement>(`.ns-tg-col[data-day="${date}"]`);
    const gut = gutRef.current;
    const left = col && gut ? col.offsetLeft - gut.offsetWidth : el.scrollLeft;
    el.scrollTo({ left, top: scrollTopFor(min), behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  };

  useImperativeHandle(handleRef, () => ({
    scroller: () => scrollRef.current,
    scrollToNow,
    scrollToClock,
    scrollToDay,
    scrollToDayClock,
  }));

  // 掛載時捲到「現在 − 2 小時」或 08:00（只做一次；之後的位置歸使用者）
  const mountedScroll = useRef(false);
  useLayoutEffect(() => {
    if (mountedScroll.current) return;
    const g = gutRef.current;
    if (!g || g.getBoundingClientRect().height === 0) return;
    mountedScroll.current = true;
    scrollToNow(false);
  });

  // ── 點擊 ──
  const pickBlock = (date: string, x: BlockLayout, el: HTMLElement) => onPick(date, x.b.entry.node_id, el);

  const onColClick = (e: MouseEvent<HTMLDivElement>, dayIdx: number) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ns-tg-blk")) return; // 塊自己處理
    const col = e.currentTarget;
    const date = days[dayIdx].date;
    if (!mobile) {
      onHead(date, col);
      return;
    }
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const xFrac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const items = laid[dayIdx];
    // ① 命中：落在塊的畫面範圍內（同一高度有多個 lane ⇒ 取 x 落在的那個 lane，沒有就取最近的 lane）
    const hits = items.filter((x) => y >= x.top && y <= x.top + x.height);
    if (hits.length) {
      const exact = hits.find((x) => xFrac >= x.b.lane / x.b.lanes && xFrac < (x.b.lane + 1) / x.b.lanes);
      const best =
        exact ??
        hits.reduce((a, b) =>
          Math.abs((a.b.lane + 0.5) / a.b.lanes - xFrac) <= Math.abs((b.b.lane + 0.5) / b.b.lanes - xFrac) ? a : b,
        );
      const el = col.querySelector<HTMLElement>(`.ns-tg-blk[data-row-key="${best.b.key}"]`) ?? col;
      pickBlock(date, best, el);
      return;
    }
    // ② 附近：同欄 |startMin − 點到分| ≤ 20 的最近塊
    const at = axisMin + (y / H) * 60;
    let near: BlockLayout | null = null;
    let nearD = Infinity;
    for (const x of items) {
      const d = Math.abs(x.b.startMin - at);
      if (d <= NEAR_BLOCK_MIN && d < nearD) {
        near = x;
        nearD = d;
      }
    }
    if (near) {
      const el = col.querySelector<HTMLElement>(`.ns-tg-blk[data-row-key="${near.b.key}"]`) ?? col;
      pickBlock(date, near, el);
      return;
    }
    // ③ 當作點欄頭
    onHead(date, col);
  };

  const onBandClick = (e: MouseEvent<HTMLDivElement>, date: string) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ns-tg-chip")) return; // 籤自己處理
    const cell = e.currentTarget;
    if (mobile && onMore && target.closest(".ns-tg-more")) {
      onMore(date);
      return;
    }
    if (mobile) {
      const chips = Array.from(cell.querySelectorAll<HTMLButtonElement>(".ns-tg-chip"));
      let chip: HTMLButtonElement | null = chips.length === 1 ? chips[0] : null;
      if (!chip && chips.length > 1) {
        let best = Infinity;
        for (const c of chips) {
          const r = c.getBoundingClientRect();
          const d = Math.abs(e.clientY - (r.top + r.height / 2));
          if (d <= NEAR_CHIP_PX && d < best) {
            best = d;
            chip = c;
          }
        }
      }
      if (chip) {
        const nodeId = chip.dataset.node;
        if (nodeId) {
          onPick(date, nodeId, chip);
          return;
        }
      }
    }
    onHead(date, cell);
  };

  // ── 畫 ──
  const n = days.length;
  const fixed = typeof colWidth === "number" && colWidth > 0;
  const rootStyle = { "--n": n, ...(fixed ? { "--cw": `${colWidth}px` } : {}) } as CSSProperties;
  // scroll-snap 錨放在欄本身（全高、縱向永遠和捲動視口相交），不另放錨元素：Chromium 單軸 snap 只認
  // 「另一軸看得到」的 snap area，舊的 1px 錨釘在 top:0，縱向一捲離頂端就全部失效、橫向變自由捲
  const snapCol = (k: number) => fixed && snapEvery > 0 && k % snapEvery === 0;

  const headCells = days.map((d) => {
    const dt = dateOf(d.date);
    const wd = WEEKDAY_LABEL[dt.getDay()];
    const total = d.blocks.length + d.untimed.length;
    const isToday = d.date === today;
    const label =
      `${dt.getMonth() + 1}月${dt.getDate()}日 週${wd}` +
      (isToday ? "（今天）" : "") +
      (total ? `，${total} 班` : "") +
      (d.dues.length ? `，締切 ${d.dues.length} 件` : "");
    return (
      <div
        key={d.date}
        className={cx("ns-tg-dh", isToday && "is-today", d.date < today && "is-past", d.date === selectedDay && "is-sel")}
        data-day={d.date}
        aria-label={label}
        title={label}
        onClick={(e) => onHead(d.date, e.currentTarget)}
      >
        <span className="wd">{mobile ? wd : `週${wd}`}</span>
        <span className="dn">{mobile ? `${dt.getMonth() + 1}/${dt.getDate()}` : dt.getDate()}</span>
        {!mobile && <span className="cnt">{total ? `${total} 班` : " "}</span>}
        {d.dues.length > 0 && (
          <span className={cx("sime", dt.getDate() % 2 === 0 && "alt")} aria-hidden title={`締切 ${d.dues.length} 件`}>
            〆{d.dues.length > 1 && <span className="n">{d.dues.length}</span>}
          </span>
        )}
      </div>
    );
  });

  const chipOf = (date: string, u: TimeGridUntimed) => {
    const e = u.entry;
    const node = nodes[e.node_id];
    const name = node?.name ?? "";
    const key = `${date}-${e.node_id}`;
    const skipped = e.occurrence_status === "skipped";
    const tone = e.is_done ? "done" : skipped ? "skipped" : e.is_late ? "late" : null;
    const title = u.outOfAxis && e.time ? `${name}（軸外 ${e.time}：比日界線早或晚，時段軸放不下）` : name;
    return (
      <button
        key={key}
        type="button"
        className={cx("ns-tg-chip", tone, u.outOfAxis && "oob", key === selectedKey && "is-sel")}
        data-row-key={key}
        data-node={e.node_id}
        title={title}
        onClick={(ev) => onPick(date, e.node_id, ev.currentTarget)}
      >
        <i className="dot" style={{ background: routeColor(node) }} />
        <span className="nm">{name}</span>
        {u.outOfAxis && e.time && <span className="oob-t">軸外 {e.time}</span>}
      </button>
    );
  };

  const bandCells = days.map((d) => {
    // 軸外的票最特別（標「軸外 03:30」、主人要知道它被擠出軸了）⇒ 排在籤帶最前面；模型的 untimed 順序不動（契約 §3.8）
    const band = [...d.untimed.filter((u) => u.outOfAxis), ...d.untimed.filter((u) => !u.outOfAxis)];
    const shown = band.slice(0, m.maxChips);
    const rest = band.length - shown.length;
    return (
      <div
        key={d.date}
        className={cx("ns-tg-bc", d.date === today && "is-today", d.date === selectedDay && "is-sel")}
        data-day={d.date}
        onClick={(e) => onBandClick(e, d.date)}
      >
        {shown.map((u) => chipOf(d.date, u))}
        {rest > 0 && (
          <span className="ns-tg-more" title={`還有 ${rest} 張未定時的票`}>
            ＋{rest}
          </span>
        )}
      </div>
    );
  });

  const gutter = (
    <div className="ns-tg-gut" ref={gutRef}>
      {ticks.map((t, i) => {
        // 第一個（日界線）不印、最後一個是底線；與現在時刻牌太近的整點字讓位
        if (i === 0 || i === ticks.length - 1) return null;
        if (nowMin !== null && Math.abs(t.min - nowMin) < PILL_GAP_MIN) return null;
        const top = ((t.min - axisMin) / 60) * H;
        const sub = mobile ? (t.h === 24 ? t.sub : null) : t.sub;
        return (
          <span key={t.h} className={cx("hl", t.night && "nite")} style={{ top }}>
            {mobile ? pad2(t.h) : t.label}
            {sub && <small>{sub}</small>}
          </span>
        );
      })}
      {nowMin !== null && nowTop !== null && (
        <span className="nowpill" style={{ top: nowTop }} aria-label={`現在 ${clockText(nowMin) ?? ""}`}>
          {clockText(nowMin)}
        </span>
      )}
    </div>
  );

  const blockOf = (date: string, x: BlockLayout) => {
    const { b, node } = x;
    const e = b.entry;
    const time = e.time ?? "";
    const done = e.is_done;
    const skipped = e.occurrence_status === "skipped";
    const settled = done || skipped;
    const isRepeat = e.kind === "repeat" || (node ? parseRule(node.repeat_rule) !== null : false);
    // 入鋏是節點層的狀態：定期券只算目前那一班（scheduled_on），別天的塊不跟著「進行中」
    const doing = !settled && node?.status === "doing" && (!isRepeat || node.scheduled_on === date);
    const past = !settled && !doing && isClockPast(date, e.time, now);
    const nx = e.time ? nextDayNote(e.time) : null;
    // 預計照節點原值寫（塊被軸尾裁短時，title 仍講使用者填的長度）
    const estFull = b.noEstimate ? null : (node?.estimate_min ?? null);
    const name = node?.name ?? "";
    const title =
      `${time}${nx ? `（${nx}）` : ""}${estFull ? `・${estFull} 分` : "・長度未定"}　${name}` +
      (past ? "　＊已過發車時刻" : "") +
      (b.contToNext ? "　＊超過這一天的軸尾" : "");
    const style = {
      "--rc": routeColor(node),
      "--lc": x.lc,
      top: x.top,
      height: x.height,
      left: `calc(${(b.lane / b.lanes) * 100}% + 2px)`,
      width: `calc(${100 / b.lanes}% - 4px)`,
    } as CSSProperties;
    return (
      <button
        key={b.key}
        type="button"
        className={cx(
          "ns-tg-blk",
          x.short && "short",
          done && "done",
          skipped && "skipped",
          past && "past",
          doing && "doing",
          b.noEstimate && "noest",
          e.is_late && !settled && "late-day",
          b.contToNext && "over",
          b.key === selectedKey && "is-sel",
        )}
        data-row-key={b.key}
        style={style}
        title={title}
        aria-label={title}
        onClick={(ev) => pickBlock(date, x, ev.currentTarget)}
      >
        <span className="bt">
          {time}
          {nx && !x.short && !mobile && <span className="nx">{nx}</span>}
        </span>
        <span className="bn">{name}</span>
        {done && (
          <span className="mini-seal" aria-hidden>
            済
          </span>
        )}
      </button>
    );
  };

  const cols = days.map((d, k) => {
    const isToday = d.date === today;
    return (
      <div
        key={d.date}
        className={cx(
          "ns-tg-col",
          isToday && "is-today",
          d.date < today && "is-past",
          d.date === selectedDay && "is-sel",
          snapCol(k) && "is-snap",
        )}
        data-day={d.date}
        onClick={(e) => onColClick(e, k)}
      >
        {nightHours > 0 && (
          <>
            <div className="ns-tg-night" style={{ top: (24 - nightHours) * H, height: nightHours * H }} />
            <div className="ns-tg-midnight" style={{ top: (24 - nightHours) * H }} />
          </>
        )}
        {nowTop !== null && <div className={cx("ns-tg-now", !isToday && "ghost")} style={{ top: nowTop }} />}
        {laid[k].map((x) => blockOf(d.date, x))}
      </div>
    );
  });

  return (
    <div className={cx("ns-tg", fixed && "is-fixed")} data-shell={shell} style={rootStyle}>
      <div className="ns-tg-scroll" ref={scrollRef}>
        <div className="ns-tg-grid">
          <div className="ns-tg-row ns-tg-head">
            <div className="ns-tg-corner" />
            {headCells}
          </div>
          <div className="ns-tg-row ns-tg-band">
            <div className="ns-tg-corner">未定時</div>
            {bandCells}
          </div>
          <div className="ns-tg-row ns-tg-body">
            {gutter}
            {cols}
          </div>
        </div>
      </div>
    </div>
  );
}
