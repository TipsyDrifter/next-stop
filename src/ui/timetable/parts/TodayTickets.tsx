/**
 * TodayTickets——發車台「今日車票」一排（車次② 契約 §5.4、0-10；乙席；長相＝原型 `v-f.js` stripHtml、`v-f.css` .vf-strip／.vf-sk）。
 * DepartBoard 兩殼共用（桌機 split 左欄、手機發車台檢視；軸檢視不出）。
 *
 *   div.ns-tt-sec.ns-tt-todaytix-sec（h3「今日車票」＋虛線＋「N 張・點一下就発車」）
 *   div.ns-tt-todaytix[.is-end] > button.ns-tt-todaytix-k[.is-live]（路線圓牌＋標題＋小字：上次的分類／「先選分類」／運行中）
 *
 * - 資料（0-10）：`nodeStore.today.rows` 的 today／late／due，**還沒交代的**（`!settledRow`，〈原型拍板〉2）；順序照今日頁。
 *   今日切片不是今天 ⇒ 掛載時 `loadToday()` 一次（直接進時刻表頁、沒去過今日頁）。沒有車票 ⇒ 整段不畫。
 * - 點一張＝`departFromTask(id)`（正在跑那張由 store 吐「已經在跑」）。
 * - 卡片寬跟著那一排算（container query，約 2.35 張），第三張探頭；捲到底才收掉右緣漸隱（.is-end）。
 *   桌機在那一排上滾滾輪＝左右捲（捲到頭就放行給外層）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TodayRow } from "../../../data";
import { todayKey } from "../../../lib/date";
import { useNodeStore } from "../../../store/nodeStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { CategoryBadge } from "../CategoryBadge";
import { RouteRoundel, useLastCategories, useRouteById } from "./LinkPicker";

/**
 * 「這一列今天交代過了沒」＝済或運休（＝`useTodayController.ts` 的 isSettledRow；時刻表不 import today 的檔，自己寫一份同義的）
 */
export function settledRow(row: TodayRow): boolean {
  return row.occurrence !== null || row.status === "done";
}

/**
 * 今日車票的列（0-10）：today／late／due，順序照今日頁；`includeSettled` false ⇒ 拿掉已交代的（發車台）、
 * true ⇒ 留著（「連到…」選擇器：是改連結，不是發車）。今日切片不是今天 ⇒ 掛載時 loadToday 一次。
 */
export function useTodayTicketRows(includeSettled: boolean): TodayRow[] {
  const today = useNodeStore((s) => s.today);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  useEffect(() => {
    const key = todayKey(dayStartHour);
    if (useNodeStore.getState().today.dateKey !== key) void useNodeStore.getState().loadToday(key);
  }, [dayStartHour]);
  return useMemo(
    () => today.rows.filter((r) => (r.bucket === "today" || r.bucket === "late" || r.bucket === "due") && (includeSettled || !settledRow(r))),
    [today, includeSettled],
  );
}

export function TodayTickets() {
  const rows = useTodayTicketRows(false);
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const departFromTask = useTimetableStore((s) => s.departFromTask);
  const routeById = useRouteById();
  const targets = useMemo(() => rows.map((r) => ({ nodeId: r.id, routeId: r.route_id })), [rows]);
  const mem = useLastCategories(targets);

  const ref = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  // 捲到底才收掉右緣漸隱；內容與寬度變了要重算
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = (): void => setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    ro?.observe(el);
    // 滾輪＝左右捲（只在還捲得動的方向吃掉事件，捲到頭就放行給外層）
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", check);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, [rows.length]);

  if (rows.length === 0) return null;

  return (
    <>
      <div className="ns-tt-sec ns-tt-todaytix-sec">
        <h3>{TT_TEXT.TODAY_TICKETS}</h3>
        <span className="ns-tt-sec-rule" />
        <span className="ns-tt-sec-note">
          <b className="ns-tt-num">{rows.length}</b> 張・點一下就発車
        </span>
      </div>
      <div ref={ref} className={"ns-tt-todaytix" + (atEnd ? " is-end" : "")} role="list" aria-label={TT_TEXT.TODAY_TICKETS}>
        {rows.map((r) => {
          const live = running?.node_id === r.id;
          const m = mem[`${r.id}|${r.route_id ?? ""}`];
          const cat = m ? (catById[m.categoryId] ?? null) : null;
          const title = live
            ? "運行中"
            : m && cat
              ? `用「${cat.name}」発車（${m.from === "node" ? "這張票上次的" : "這條路線上次的"}）`
              : m === null
                ? r.route_id
                  ? "這條路線還沒記過時間，請先選分類"
                  : "這張車票還沒記過時間，請先選分類"
                : "発車";
          return (
            <button
              type="button"
              role="listitem"
              key={r.id}
              className={"ns-tt-todaytix-k" + (live ? " is-live" : "")}
              title={title}
              onClick={() => void departFromTask(r.id)}
            >
              <RouteRoundel route={r.route_id ? (routeById[r.route_id] ?? null) : null} />
              <span className="ns-tt-todaytix-main">
                <span className="ns-tt-todaytix-t">{r.name}</span>
                <span className="ns-tt-todaytix-s">
                  {live ? (
                    <>
                      <span className="ns-tt-live-dot" aria-hidden="true" />
                      <span>運行中</span>
                    </>
                  ) : m && cat ? (
                    <>
                      <CategoryBadge cat={cat} size="sm" />
                      <span>{cat.name}</span>
                    </>
                  ) : m === null ? (
                    <>
                      <span className="ns-tt-q" aria-hidden="true">
                        ?
                      </span>
                      <span>先選分類</span>
                    </>
                  ) : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
