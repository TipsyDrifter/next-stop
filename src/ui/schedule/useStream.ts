/**
 * useStream——行程表串流的狀態機（主線車次①；契約 §3.3）。兩端（桌機 StreamView／手機 MobileSchedule）共用，
 * 元件只負責把 `sections` 畫出來、把容器的 onScroll／ref 接上。
 *
 * 行為（契約 §3.3 的 11 條）：
 *   1. 視窗住本地 state：每次掛載從 `initialWindow(today)` 起（D-主-6 進頁起點永遠是今天）；calendar 切片第一次涵蓋今天
 *      （第一批資料到了）的那次 layout 才把今日段捲到頂（auto）——在那之前不記錨點、不補償；內建字型晚到重排 ⇒ 擺回錨點
 *   2. 視窗變了 ⇒ `loadCalendar(from, to)`；之後的 `nodeStore.refresh()` 會用 calendar.from／to 重撈——那就是串流視窗
 *   3. 誤點列吃 `nodeStore.today.rows`；掛載時今日切片不是今天 ⇒ `loadToday(today)`
 *   4. calendar 切片身分變了就重查 `nodeRepo.scheduleBounds()`（200ms 去抖、只留最後一次）；查到之前 bounds=null
 *   5. 三條重載時機：掛載＋dayStartHour 變／每 60s 比對 todayKey／visibilitychange→visible 無條件重載
 *   6. 補載：scrollTop < 240 往上補、距底 < 420 往下補（各 14 天）；程式捲動進行中不補。補進來的日子併進收合區間、
 *      高度不變就不會再有 scroll 事件 ⇒ 新視窗的資料到了之後再看一次觸發線、仍在線內就接著補（連鎖，上限 6 次）
 *   7. 捲動補償：overflow-anchor 關掉，自己記「頂端第一個可見段」的 key＋位移，sections 變了之後把它擺回原位；容器寬變也擺回
 *   8. goTo(day)：ensureWindow → 在收著的 gap／after 邊界裡就先攤開 → 等 commit 後捲到 [data-day]；早於 earliest ⇒ 捲到 before 邊界
 *   9. 訂閱 scheduleUiStore.scrollReq（nonce 變了就 goTo）
 *  10. spy：頂端段＝最後一個 top − containerTop <= 1 的段；寫回 scheduleUiStore.setFocusDay（值不變不寫）
 *  11. 段落元件 memo、key＝section.key——那是元件的事；這裡保證 sections 只在輸入變時換身分
 *
 * DOM 契約（元件要掛的屬性）：每一段的根元素 `data-sec-key={section.key}`；day 段另加 `data-day={section.date}`。
 * 唯一碰 repository 的地方＝`nodeRepo.scheduleBounds()`（唯讀、無狀態；nodeStore 不在本班可改清單，契約 §1-10）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { nodeRepo } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import { useScheduleUiStore } from "./scheduleUiStore";
import {
  canLoadNewer,
  canLoadOlder,
  ensureWindow,
  extendWindow,
  initialWindow,
  lateSummary,
  sectionOf,
  streamModel,
  type ScheduleBounds,
  type StreamEdgeSection,
  type StreamGapSection,
  type StreamSection,
  type StreamWindow,
} from "./streamModel";

export interface UseStreamOptions {
  shell: "desktop" | "mobile";
  /** 捲動容器（桌機＝StreamView 自己的 .ns-sch-scroll；手機＝.m-sch-stream） */
  scrollRef: RefObject<HTMLElement | null>;
}

export interface UseStreamApi {
  /** 日界線今天（設定改了立刻重算，每 60s 看一次） */
  today: string;
  window: StreamWindow;
  bounds: ScheduleBounds | null;
  /** streamModel 輸出（memo） */
  sections: StreamSection[];
  /** lateSummary(nodeStore.today.rows) */
  late: { count: number; earliest: string | null };
  /** scroll-spy：頂端那一段的日子（gap／edge 用其 to／from） */
  focusDay: string;
  /** 掛容器 onScroll：rAF 節流 spy＋loadMore */
  onScroll(): void;
  goTo(day: string, opts?: { smooth?: boolean }): void;
  goToday(): void;
  toggleRun(section: StreamGapSection | StreamEdgeSection): void;
  /** 保證 [from,to] 已載（月曆覆蓋層翻月、週條換週時叫；不捲動） */
  ensureLoaded(from: string, to: string): void;
  /**
   * 程式捲動（goTo／goToday 的 smooth）是否還在飛。同一個守門給所有「會動 scrollTop 的旁路」用：
   * 本 hook 的錨點補償、StreamView 焦點跟選取走的 scrollIntoView（代驗 F2：Home 捲到一半被它截斷）。
   */
  isProgramScrolling(): boolean;
}

/** 往上補載的觸發線（px）／往下補載的觸發線（距底 px） */
const LOAD_OLDER_PX = 240;
const LOAD_NEWER_PX = 420;
/** 程式捲動的保護期（ms）：期間不補載；`scrollend` 提前解除（原型 :1394-1415） */
const PROG_SCROLL_MS = 900;
/** scheduleBounds 的去抖（ms） */
const BOUNDS_DEBOUNCE_MS = 200;
/** 連鎖補載的上限（一次捲動觸發之後最多再自動補幾次；6×14 天≈三個月） */
const CHAIN_MAX = 6;

/** 段落元素相對容器可視區頂端的位移（不依賴 offsetParent；容器不必 position:relative） */
function topOf(el: Element, host: HTMLElement): number {
  return el.getBoundingClientRect().top - host.getBoundingClientRect().top;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 一段在 spy 裡代表的日子：day＝date、gap＝from、before 邊界＝to（label 日）、after 邊界＝from（label 日） */
function focusDayOf(s: StreamSection): string {
  if (s.kind === "day") return s.date;
  if (s.kind === "gap") return s.from;
  return s.side === "before" ? s.to : s.from;
}

/** gap／after 邊界涵蓋的日子（攤開／收起要動的 key）；to < from（0 天的邊界）⇒ 空 */
function runDays(s: StreamGapSection | StreamEdgeSection): string[] {
  const out: string[] = [];
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) out.push(d);
  return out;
}

interface Anchor {
  key: string;
  top: number;
  /** 錨段代表的日子（focusDayOf）；key 在新 sections 裡消失時靠它找替身（沙盒回報二 N1）。查不到段＝"" */
  day: string;
}

/** 一段涵蓋的日子區間（找錨點替身用）：before 邊界往前無界、after 邊界往後無界（0 天的邊界也算數） */
function spanOf(s: StreamSection): [string, string] {
  if (s.kind === "day") return [s.date, s.date];
  if (s.kind === "gap") return [s.from, s.to];
  return s.side === "before" ? ["", s.to] : [s.from, "9999-12-31"];
}

interface PendingGoTo {
  day: string;
  smooth: boolean;
}

export function useStream(opts: UseStreamOptions): UseStreamApi {
  const { scrollRef } = opts;

  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const calendar = useNodeStore((s) => s.calendar);
  const todayRows = useNodeStore((s) => s.today.rows);
  const expanded = useScheduleUiStore((s) => s.expanded);
  const scrollReq = useScheduleUiStore((s) => s.scrollReq);
  const storeFocusDay = useScheduleUiStore((s) => s.focusDay);

  const [today, setToday] = useState(() => todayKey(dayStartHour));
  const [win, setWin] = useState<StreamWindow>(() => initialWindow(todayKey(dayStartHour)));
  const [bounds, setBounds] = useState<ScheduleBounds | null>(null);

  // 模型只畫「視窗 ∩ 已載區間」（沙盒回報二 N2）：補載剛 setWin、新區間資料還沒到的那一下，新擴進來的日子在切片裡
  // 全是空白——bounds 又是舊的、from 已 <= earliest ⇒ 模型會把它們連同真正的票之前那段吃成一行假的「…以前」邊界
  // （約 100ms 後資料到才改對）。先只畫資料到了的那段，資料到了再展開；切片與視窗不相交（冷開、從別月切來）就照視窗畫
  const modelFrom =
    calendar.from !== null && calendar.to !== null && calendar.from > win.from && calendar.from <= win.to
      ? calendar.from
      : win.from;
  const modelTo =
    calendar.from !== null && calendar.to !== null && calendar.to < win.to && calendar.to >= modelFrom
      ? calendar.to
      : win.to;
  const sections = useMemo<StreamSection[]>(
    () =>
      streamModel({
        entries: calendar.entries,
        dues: calendar.dues,
        from: modelFrom,
        to: modelTo,
        today,
        bounds,
        expanded,
      }),
    [calendar.entries, calendar.dues, modelFrom, modelTo, today, bounds, expanded],
  );
  const late = useMemo(() => lateSummary(todayRows, today), [todayRows, today]);

  // 最新值放 ref，事件處理器與計時器不吃舊 closure
  const st = useRef({ sections, win, today, bounds });
  st.current = { sections, win, today, bounds };
  const byKey = useMemo(() => {
    const m = new Map<string, StreamSection>();
    for (const s of sections) m.set(s.key, s);
    return m;
  }, [sections]);

  const anchorRef = useRef<Anchor | null>(null);
  const progUntilRef = useRef(0);
  /** 程式捲動的目標（選擇器）：落點時重新瞄準一次——飛行中補載／攤開讓版面變了，起飛時算的 top 就過期了（短沙盒三 E3／δ） */
  const progTargetRef = useRef<string | null>(null);
  const rafRef = useRef(0);
  const extendLockRef = useRef(false);
  /** 連鎖補載（沙盒回報註 2）：頂端／底端是收合區間時，補進來的 14 天併進同一行、內容高度不變 ⇒ 不再有 scroll 事件，
   *  只從 onScroll 呼叫的 loadMore 就停住了。所以補載之後記著「這一串補了幾次」，等新視窗的資料到了（calendar 區間
   *  ＝視窗）那次 layout 再看一次觸發線；仍在線內就再補，直到高度變化把位置推出線外、邊界出現、或補滿 CHAIN_MAX 次 */
  const chainRef = useRef<number | null>(null);
  const didInitialScrollRef = useRef(false);
  /** 第一批資料到了沒：calendar 切片非空、且涵蓋今天。冷開（?view=stream 直開／calendar_view 記住 stream 重開）時
   *  第一次 layout 切片還是空的——今日段已畫出但內容比容器矮、捲不動；那時記的錨點是最上面那段，資料到了補償會把它
   *  留在頂端、今天卡在下面。所以初始捲動與錨點都等這個旗標（從月／週切過來時切片已涵蓋今天，第一次 layout 就成立） */
  const calReady =
    calendar.from !== null && calendar.to !== null && calendar.from <= today && today <= calendar.to;
  const pendingRef = useRef<PendingGoTo | null>(null);

  /* ───────── DOM 小工具 ───────── */

  const sectionEls = (host: HTMLElement): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>("[data-sec-key]"));

  /** 頂端第一個可見段＝最後一個 top <= 1 的段（原型 v2 判定線 :1369-1386）；沒有就第一段 */
  const topSection = (host: HTMLElement): HTMLElement | null => {
    const els = sectionEls(host);
    let hit: HTMLElement | null = null;
    for (const el of els) {
      if (topOf(el, host) <= 1) hit = el;
      else break;
    }
    return hit ?? els[0] ?? null;
  };

  const captureAnchor = useCallback(() => {
    const host = scrollRef.current;
    if (!host) return;
    const el = topSection(host);
    if (!el) {
      anchorRef.current = null;
      return;
    }
    const key = el.dataset.secKey ?? "";
    const sec = st.current.sections.find((s) => s.key === key);
    anchorRef.current = { key, top: topOf(el, host), day: sec ? focusDayOf(sec) : "" };
  }, [scrollRef]);

  /** 把錨點擺回原位；同一個 key 不在了（重載帶進更早的票、before 邊界被取代；gap 被拆開……）就找替身：
   *  涵蓋錨段日子的那一段（同時有 gap 標頭與攤開的逐日行時取後者），都不涵蓋就取緊鄰其後的第一段。
   *  舊版拿新 sections 的 byKey 查舊 key 必然落空，退回 `key.slice(2)`——對 `e:before` 得到字串 "before"，
   *  所有日期都 <= 它 ⇒ 選到最後一段，畫面被甩到底（沙盒回報二 N1） */
  const restoreAnchor = useCallback(() => {
    // 守門放在寫入者本身（短沙盒三：第三輪 F1 才發現 ResizeObserver 這條呼叫沒包到）——
    // 程式捲動飛行中任何人叫 restoreAnchor 都不動 scrollTop，落點由 land 重新瞄準
    if (Date.now() < progUntilRef.current) return;
    const host = scrollRef.current;
    const a = anchorRef.current;
    if (!host || !a || !a.key) return;
    let el = host.querySelector<HTMLElement>(`[data-sec-key="${CSS.escape(a.key)}"]`);
    if (!el) {
      if (!a.day) return; // 不知道錨段是哪天：寧可不動，也不要亂捲
      let best: HTMLElement | null = null;
      for (const cand of sectionEls(host)) {
        const sec = byKey.get(cand.dataset.secKey ?? "");
        if (!sec) continue;
        const [s, e] = spanOf(sec);
        if (s > a.day) {
          best ??= cand;
          break;
        }
        if (e >= a.day) best = cand;
      }
      el = best;
    }
    if (!el) return;
    const delta = topOf(el, host) - a.top;
    if (Math.abs(delta) >= 1) host.scrollTop += delta;
  }, [scrollRef, byKey]);

  const spy = useCallback(() => {
    const host = scrollRef.current;
    if (!host) return;
    // 整條串流放得下、捲不動（空庫只有兩條邊界＋今日段時）：頂端永遠是 before 邊界，照判定線會選到它的 label 日（昨天），
    // 週條就把昨天和今天同時框起來（沙盒回報註 4）。全部都在畫面裡時，焦點就是起點今天（D-主-6）
    if (host.scrollHeight - host.clientHeight <= 1) {
      useScheduleUiStore.getState().setFocusDay(st.current.today);
      return;
    }
    const el = topSection(host);
    const sec = el ? st.current.sections.find((s) => s.key === el.dataset.secKey) : undefined;
    if (sec) useScheduleUiStore.getState().setFocusDay(focusDayOf(sec));
  }, [scrollRef]);

  /**
   * 程式捲動的落點（scrollend 與 900ms 計時器都走這裡）：
   *   ① 目標還在 DOM 且不在頂端（飛行中版面變了：補載把內容插在上面、收合區間攤開）⇒ 瞬間補到位——
   *      這一補本身會再發一次 scrollend，那時 target 已清、只做 ②；
   *   ② 解除保護、記錨點、spy。
   * 一處收斂短沙盒三的 E3（起飛時算的 top 過期）、δ（補載中按 Home 差 35px）與 E19 冷視窗。
   */
  const land = useCallback(() => {
    const host = scrollRef.current;
    progUntilRef.current = 0;
    const sel = progTargetRef.current;
    progTargetRef.current = null;
    if (!host) return;
    if (sel) {
      const el = host.querySelector<HTMLElement>(sel);
      if (el) {
        const delta = topOf(el, host);
        if (Math.abs(delta) >= 1) host.scrollTop += delta;
      }
    }
    if (!didInitialScrollRef.current) return;
    captureAnchor();
    spy();
  }, [scrollRef, captureAnchor, spy]);

  const scrollToEl = useCallback(
    (el: HTMLElement, smooth: boolean) => {
      const host = scrollRef.current;
      if (!host) return;
      const behavior: ScrollBehavior = smooth && !reducedMotion() ? "smooth" : "auto";
      progUntilRef.current = Date.now() + PROG_SCROLL_MS;
      progTargetRef.current = el.dataset.day
        ? `[data-day="${CSS.escape(el.dataset.day)}"]`
        : el.dataset.secKey
          ? `[data-sec-key="${CSS.escape(el.dataset.secKey)}"]`
          : null;
      host.scrollTo({ top: host.scrollTop + topOf(el, host), behavior });
      // smooth 的落點要等 scrollend；沒有 scrollend 的環境用計時器兜底（先到的那個落地，後到的只剩 capture＋spy）
      window.setTimeout(land, behavior === "smooth" ? PROG_SCROLL_MS : 0);
    },
    [scrollRef, land],
  );

  /* ───────── 載入時機 ───────── */

  // 2. 視窗變了就載（refresh() 之後會用同一個區間重撈）
  useEffect(() => {
    void useNodeStore.getState().loadCalendar(win.from, win.to);
  }, [win.from, win.to]);

  // 3.＋5(a)：掛載與日界線設定變動——重算今天；今日切片不是今天就載（桌機直開 ?page=calendar 時沒載過）
  useEffect(() => {
    const key = todayKey(dayStartHour);
    setToday(key);
    const ns = useNodeStore.getState();
    if (ns.today.dateKey !== key) void ns.loadToday(key);
  }, [dayStartHour]);

  // 5(b)：每 60s 比對 todayKey，變了才動（不變就完全不碰 store）
  useEffect(() => {
    const timer = setInterval(() => {
      const key = todayKey(useUiStore.getState().dayStartHour);
      if (key === st.current.today) return;
      setToday(key);
      const ns = useNodeStore.getState();
      void ns.loadCalendar(st.current.win.from, st.current.win.to);
      void ns.loadToday(key);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  // 5(c)：前景回來無條件重載（背景期間同步／別台可能動過；loadCalendar 冪等）
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const key = todayKey(useUiStore.getState().dayStartHour);
      if (key !== st.current.today) setToday(key);
      const ns = useNodeStore.getState();
      void ns.loadCalendar(st.current.win.from, st.current.win.to);
      void ns.loadToday(key);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // 今天往後移時視窗不動（今日段自然移位）；新的今天落在視窗外才擴視窗
  useEffect(() => {
    setWin((w) => ensureWindow(w, today, today));
  }, [today]);

  // 4. 邊界：calendar 切片身分變了就重查（200ms 去抖、只留最後一次）
  const boundsSeq = useRef(0);
  useEffect(() => {
    const seq = ++boundsSeq.current;
    const timer = window.setTimeout(() => {
      void nodeRepo
        .scheduleBounds()
        .then((b) => {
          if (seq === boundsSeq.current) setBounds(b);
        })
        .catch(() => {
          /* 查不到就維持上一次的值（或 null）——邊界行晚一點出現，不壞串流本體 */
        });
    }, BOUNDS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [calendar]);

  /* ───────── 補載 ───────── */

  /** 在觸發線內就往那一側補 14 天。`chain`＝這是連鎖的第幾次（0＝捲動觸發的第一次）；沒補就結束連鎖 */
  const loadMore = useCallback(
    (chain = 0) => {
      const host = scrollRef.current;
      if (!host || extendLockRef.current) return;
      const secs = st.current.sections;
      let side: "older" | "newer" | null = null;
      if (host.scrollTop < LOAD_OLDER_PX && canLoadOlder(secs)) side = "older";
      else if (host.scrollTop + host.clientHeight > host.scrollHeight - LOAD_NEWER_PX && canLoadNewer(secs)) side = "newer";
      if (side === null) {
        chainRef.current = null;
        return;
      }
      extendLockRef.current = true;
      chainRef.current = chain;
      const s = side;
      setWin((w) => extendWindow(w, s));
    },
    [scrollRef],
  );

  /* ───────── 捲動：補償、初始落點、跳轉落點 ───────── */

  // 7.＋1.＋8.：每次 sections 換身分之後——先處理待跳轉，否則把錨點擺回；第一次把今日段捲到頂
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    extendLockRef.current = false;

    const pending = pendingRef.current;
    if (pending) {
      const target = sectionOf(sections, pending.day);
      if (target) {
        if (target.kind === "day") {
          pendingRef.current = null;
          const el = host.querySelector<HTMLElement>(`[data-day="${CSS.escape(pending.day)}"]`);
          if (el) scrollToEl(el, pending.smooth);
          return;
        }
        if (target.kind === "edge" && target.side === "before") {
          pendingRef.current = null;
          const el = host.querySelector<HTMLElement>('[data-sec-key="e:before"]');
          if (el) scrollToEl(el, pending.smooth);
          return;
        }
        // 收著的 gap／after 邊界：攤開，下一次 commit 再捲（expanded 變 ⇒ sections 變 ⇒ 回到這裡）
        if (!target.open) {
          useScheduleUiStore.getState().expandDays(runDays(target));
          return;
        }
      }
      // 不在視窗裡（視窗剛 setWin、還沒 commit）：等下一次
      if (!target) return;
    }

    if (!didInitialScrollRef.current) {
      // 第一批資料還沒到：不捲、不記錨點（記了就是錯的那段）
      if (!calReady) return;
      const el = host.querySelector<HTMLElement>(`[data-day="${CSS.escape(today)}"]`);
      if (!el) return;
      didInitialScrollRef.current = true;
      host.scrollTop += topOf(el, host);
      captureAnchor();
      spy();
      return;
    }

    // 程式捲動進行中（goTo／goToday 的 smooth 還在飛）：不擺錨、不記錨、不 spy——
    // 代驗 F1：goTo 剛發出 scrollTo，4–12ms 後資料到齊的那次 commit 跑 restoreAnchor 把平滑捲動截斷、畫面拉回原位，
    // 第一次點誤點列／月曆上月的日子看起來像沒反應。落點由 scrollToEl 的計時器與 scrollend 收尾（那裡才 capture＋spy）。
    if (Date.now() >= progUntilRef.current) {
      restoreAnchor();
      captureAnchor();
      // 段落合併／攤開後頂端的日子可能變了
      spy();
    }

    // 6. 連鎖補載：新視窗的資料到了才判（資料沒到前段落高度不準；也不讓視窗在資料前面一路衝）
    const chained = chainRef.current;
    if (chained !== null && calendar.from === win.from && calendar.to === win.to) {
      if (chained >= CHAIN_MAX || Date.now() < progUntilRef.current) chainRef.current = null;
      else loadMore(chained + 1);
    }
  }, [sections, today, calReady, calendar.from, calendar.to, win.from, win.to, scrollRef, scrollToEl, captureAnchor, restoreAnchor, spy, loadMore]);

  // 內建字型（Noto 變數字型）在第一次 paint 之後才換上，整條串流重排、scrollTop 不動 ⇒ 今日段被推走；
  // sections 身分沒變、上面的補償看不到。每批字型載完就把錨點擺回（主人已經捲過＝錨點就是他的位置，不搶）
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts) return;
    let alive = true;
    const realign = () => {
      if (!alive || !didInitialScrollRef.current || Date.now() < progUntilRef.current) return;
      restoreAnchor();
      captureAnchor();
    };
    if (fonts.status !== "loaded") void fonts.ready.then(realign);
    fonts.addEventListener?.("loadingdone", realign);
    return () => {
      alive = false;
      fonts.removeEventListener?.("loadingdone", realign);
    };
  }, [restoreAnchor, captureAnchor]);

  // 容器寬度變（側板開合、轉向）：用最後一次記錄的錨點擺回。
  // 程式捲動進行中不動（短沙盒三 E3：goTo 起飛 12ms 後視窗擴張觸發這裡，scrollTop 一寫就把 smooth 截斷）——落點由 land 收尾
  useEffect(() => {
    const host = scrollRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (Date.now() < progUntilRef.current) return;
      restoreAnchor();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [scrollRef, restoreAnchor]);

  // scrollend：程式捲動結束 ⇒ 落地（重新瞄準一次、解除保護、記錨、spy）；使用者手捲結束也走這裡（target 為空＝只記錨＋spy）
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    host.addEventListener("scrollend", land);
    return () => host.removeEventListener("scrollend", land);
  }, [scrollRef, land]);

  // 卸載：focusDay 回 null（＝串流沒掛）
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      useScheduleUiStore.getState().setFocusDay(null);
    };
  }, []);

  /* ───────── onScroll：rAF 節流 → 記錨點、spy、補載 ───────── */

  const onScroll = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (!didInitialScrollRef.current) return; // 初始落點之前的捲動事件不記錨點、不補載
      captureAnchor();
      spy();
      if (Date.now() < progUntilRef.current) return; // 程式捲動進行中不補載
      loadMore();
    });
  }, [captureAnchor, spy, loadMore]);

  /* ───────── 跳轉 ───────── */

  const goTo = useCallback(
    (day: string, o?: { smooth?: boolean }) => {
      const smooth = o?.smooth ?? true;
      const b = st.current.bounds;
      // 早於 earliest 的日子一律落在 before 邊界行（不攤開、不把視窗拉到幾年前）
      const target = b && b.earliest !== null && day < b.earliest ? b.earliest : day;
      pendingRef.current = { day: target, smooth };
      const cur = st.current.win;
      const next = ensureWindow(cur, target, target);
      if (next !== cur) {
        setWin(next);
        return; // 等 sections 更新，layout effect 會接手
      }
      // 視窗已含目標：直接在這一輪處理（與 layout effect 同一套判斷）
      const host = scrollRef.current;
      const sec = sectionOf(st.current.sections, target);
      if (!host || !sec) return;
      if (sec.kind === "day") {
        pendingRef.current = null;
        const el = host.querySelector<HTMLElement>(`[data-day="${CSS.escape(target)}"]`);
        if (el) scrollToEl(el, smooth);
        return;
      }
      if (sec.kind === "edge" && sec.side === "before") {
        pendingRef.current = null;
        const el = host.querySelector<HTMLElement>('[data-sec-key="e:before"]');
        if (el) scrollToEl(el, smooth);
        return;
      }
      if (!sec.open) useScheduleUiStore.getState().expandDays(runDays(sec));
      else {
        // 已攤開但 sectionOf 回了 gap（理論上不會：攤開時 day 段在前面被先找到）；保險
        pendingRef.current = null;
      }
    },
    [scrollRef, scrollToEl],
  );

  const goToday = useCallback(() => goTo(st.current.today), [goTo]);

  const toggleRun = useCallback((section: StreamGapSection | StreamEdgeSection) => {
    if (section.kind === "edge" && section.side === "before") return;
    const days = runDays(section);
    const ui = useScheduleUiStore.getState();
    if (section.open) ui.collapseDays(days);
    else ui.expandDays(days);
  }, []);

  const ensureLoaded = useCallback((from: string, to: string) => {
    setWin((w) => ensureWindow(w, from, to));
  }, []);

  const isProgramScrolling = useCallback(() => Date.now() < progUntilRef.current, []);

  // 9. 跳轉請求（桌機頁首鈕、月曆覆蓋層、週條都經這裡）。起始值＝掛載當下的 nonce：上一次掛載留下的舊請求不重跑
  const lastNonce = useRef(useScheduleUiStore.getState().scrollReq?.nonce ?? 0);
  useEffect(() => {
    if (!scrollReq || scrollReq.nonce === lastNonce.current) return;
    lastNonce.current = scrollReq.nonce;
    goTo(scrollReq.day, { smooth: scrollReq.smooth });
  }, [scrollReq, goTo]);

  return {
    today,
    window: win,
    bounds,
    sections,
    late,
    focusDay: storeFocusDay ?? today,
    onScroll,
    goTo,
    goToday,
    toggleRun,
    ensureLoaded,
    isProgramScrolling,
  };
}
