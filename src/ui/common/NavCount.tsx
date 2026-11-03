/**
 * NavCount——導航格右上的數字小標（回饋甲 D-主-130；契約 §一 F；原型 q4b-A）。
 *
 *   span.ns-navcount.is-{desktop|mobile}[.is-late]（aria-hidden）＋ span.ns-navcount-sr（讀屏同一句話）
 *
 * - 0（或負數）不畫。平常墨色；`late`＝有誤點未交代，轉赭。
 * - 膠囊 pointer-events:none，滑過的提示寫在宿主按鈕的 title（呼叫端組字，例「今日（Ctrl+1）・還有 3 張・誤點 1 件」）。
 *
 * `useTodayCount()`：今日格的數字＝今天還沒交代的張數（今日頁首「還有 N 張」同一把尺：domain/dayCount，
 *   只算 today 分區）＋誤點數（lateCount）。今日切片不是今天（剛開 App 停在別頁、或過了日界線）⇒ 自己 loadToday 一次，
 *   每分鐘再看一次換日（同今日頁 controller 的日界線 timer 做法）。
 * `todayCountHint()`：title 用的那句「還有 N 張・誤點 M 件」（誤點 0 不寫）。
 */
import { useEffect, useMemo } from "react";
import { dayCount, lateCount } from "../../domain/dayCount";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { dayCountItem } from "../today/useTodayController";
import "./navcount.css";

export function NavCount({ n, late = false, label, shell }: { n: number; late?: boolean; label: string; shell: "desktop" | "mobile" }) {
  if (n <= 0) return null;
  return (
    <>
      <span className={"ns-navcount is-" + shell + (late ? " is-late" : "")} aria-hidden="true">
        {n > 99 ? "99+" : n}
      </span>
      <span className="ns-navcount-sr">（{label}）</span>
    </>
  );
}

export interface TodayCount {
  /** 今天還沒交代的張數（today 分區；済與運休都扣掉） */
  left: number;
  /** 誤點未交代的件數 */
  late: number;
}

export function useTodayCount(): TodayCount {
  const today = useNodeStore((s) => s.today);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  useEffect(() => {
    const check = () => {
      const key = todayKey(useUiStore.getState().dayStartHour);
      const ns = useNodeStore.getState();
      if (ns.today.dateKey !== key) void ns.loadToday(key);
    };
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, [dayStartHour]);
  return useMemo(() => {
    if (!today.dateKey) return { left: 0, late: 0 };
    const todayRows = today.rows.filter((r) => r.bucket === "today");
    return { left: dayCount(todayRows.map(dayCountItem)).left, late: lateCount(today.rows, today.dateKey).count };
  }, [today]);
}

/**
 * 路線列尾的未完成數（回饋甲 D-主-130；手機路線清單第一層用——桌機側欄自己畫，因為 title 也要那個數）：
 * 只放淡色數字、不寫字；0 不畫。讀屏念「未完成 N 項」。數字＝nodeStore.routeOpenCounts（refresh／同步拉回時重算）。
 */
export function RouteOpenCount({ routeId }: { routeId: string }) {
  const n = useNodeStore((s) => s.routeOpenCounts[routeId] ?? 0);
  if (n <= 0) return null;
  return (
    <>
      <span className="ns-routecount" aria-hidden="true">
        {n}
      </span>
      <span className="ns-navcount-sr">未完成 {n} 項</span>
    </>
  );
}

/** 「還有 N 張・誤點 M 件」（誤點 0 不寫；N 為 0 時回 null＝不加提示） */
export function todayCountHint(c: TodayCount): string | null {
  if (c.left <= 0) return null;
  return c.late > 0 ? `還有 ${c.left} 張・誤點 ${c.late} 件` : `還有 ${c.left} 張`;
}
