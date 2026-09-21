/**
 * DueTip——格角〆 的 hover 明細（M3 ⑤ WP5）。
 *
 * 事件由 WP2 接好：`DayCell` 的 `.sime` mouseenter／mouseleave 推 `tipTarget`，非 null 時由
 * `CalendarView` 掛載本檔；點〆＝冒泡到格開當日清單（原型 :1145-1147），tip 自己不吃點擊
 * （`pointer-events:none`，duetip.css）。
 *
 * 視覺真相＝prototypes/m3-ext-calendar.html :700-729（`.tip`）＋ :1161-1181（內容與定位）：
 *
 *   <div class="tip on">
 *     <h5>締切・9月14日</h5>
 *     <div class="trow"><span class="rl">J</span><span class="tt">JLPT 12月場・報名</span>
 *       <span class="noexec">未排執行日</span></div>
 *   </div>
 *
 * 三件照原型、只換資料的事：
 *   - 路線碼＝`route.code`，無 code 取名字首字、無路線＝「臨」（同 TodayRow.tsx:180 的慣例）；
 *     顏色吃 `routes[].color`（原型的 `.r-e1／--route-e1` 假 token 不搬，雷區 9）。
 *   - 「未排執行日」＝`nodes[id].scheduled_on === null`——這種票只在締切層浮出，格內清單沒有它，
 *     不講明就會讓人以為忘了排（決策 11）。
 *   - 定位（:1173-1176）：右緣對齊〆、往下 7px，左右夾在視窗內 8px；寬度上限 252px。
 *     用 `useLayoutEffect` 在 paint 前寫死 left／top，避免先畫在左上角再跳過去。
 */
import { useLayoutEffect, useRef } from "react";
import { useCalendar } from "./useCalendarController";
import "./duetip.css";

export interface DueTipProps {
  /** YYYY-MM-DD */
  day: string;
  /** 定位錨＝那一枚格角〆 */
  anchor: HTMLElement | null;
}

/** 小卡與視窗邊的留白／小卡與〆 的垂直間距／寬度上限（原型 :1174-1176、:702） */
const EDGE = 8;
const GAP = 7;
const MAX_W = 252;

export function DueTip({ day, anchor }: DueTipProps) {
  const { byDate, nodes, routeOf } = useCalendar();
  const ref = useRef<HTMLDivElement>(null);
  const dues = byDate.dues[day] ?? [];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(el.offsetWidth, MAX_W);
    // 右緣對齊〆，再夾進視窗（右界只在量得到視窗寬時才夾——背景分頁的 innerWidth 會回 0，
    // 照原型的 min→max 順序寫會把小卡推到畫面外）
    const vw = window.innerWidth || document.documentElement.clientWidth;
    let left = r.right - w;
    if (vw > 0) left = Math.min(left, vw - w - EDGE);
    el.style.left = `${Math.max(left, EDGE)}px`;
    el.style.top = `${r.bottom + GAP}px`;
  }, [anchor, day, dues.length]);

  if (!anchor || dues.length === 0) return null;

  const month = Number(day.slice(5, 7));
  const dnum = Number(day.slice(8, 10));

  return (
    <div className="tip on" role="tooltip" aria-hidden ref={ref}>
      <h5>
        締切・{month}月{dnum}日
      </h5>
      {dues.map((d) => {
        const node = nodes[d.node_id];
        const route = routeOf(d.node_id);
        const badge = route?.code ?? (route ? route.name.slice(0, 1) : "臨");
        return (
          <div className="trow" key={d.node_id}>
            <span className="rl" style={{ color: route?.color ?? "var(--route-none)" }}>
              {badge}
            </span>
            <span className="tt">{node?.name ?? ""}</span>
            {/* 無執行日＝只有締切、還沒排哪天做 */}
            {node && node.scheduled_on === null && <span className="noexec">未排執行日</span>}
          </div>
        );
      })}
    </div>
  );
}
