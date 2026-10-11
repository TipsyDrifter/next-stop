/**
 * mobileDiaryBits——手機日記（車次②丙席）幾個元件共用的小工具。
 *
 * 為什麼另開一檔：手機這邊刻意不 import 桌機 `notesBits.tsx`（乙席同時在改；車次①丙席的同一條紀律，
 * 見 notes-mobile.css 檔頭第 2 條），而 MobileDiary／MobileDiaryEntry／MobileFootprints／MobileDiaryStrip 都要用。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";

/** 本地時刻 HH:MM */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 字數：去掉空白後的字元數（與筆記整頁同一把尺） */
export function charCount(s: string): number {
  return s.replace(/\s/g, "").length;
}

/** 系統要求減量動態 */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 把 text 裡的 q（不分大小寫）包成 <mark>（前端純標示，不影響查詢） */
export function highlight(text: string, q: string): ReactNode {
  const k = q.trim();
  if (!k) return text;
  const low = text.toLowerCase();
  const kl = k.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let j: number;
  let key = 0;
  while ((j = low.indexOf(kl, i)) >= 0) {
    if (j > i) out.push(text.slice(i, j));
    out.push(<mark key={key++}>{text.slice(j, j + k.length)}</mark>);
    i = j + k.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/**
 * 「今天」的日 key，跟著日界線走（車次②契約 0-6；同 useCalendarController 的做法）：
 * 設定的日界線一變就重算、每分鐘看一次、App 回到前景時看一次；key 沒變就不 setState。
 * 跨過日界線只更新「今天」，不替主人換掉正在看的那一天（那是 store 的事，這裡只回值）。
 */
export function useTodayKey(): string {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [today, setToday] = useState(() => todayKey(dayStartHour));
  useEffect(() => {
    const tick = () => {
      const k = todayKey(dayStartHour);
      setToday((prev) => (prev === k ? prev : k));
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [dayStartHour]);
  return today;
}

/* 16×16 線稿圖示（與 notesBits 同寫法；手機各自一份，不跨席 import） */

export function IconLeft({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M10 3.5L5.5 8l4.5 4.5" />
    </svg>
  );
}

export function IconRight({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  );
}

export function IconCaret({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function IconPen({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M3 13l1-3.5L10.5 3l2.5 2.5L6.5 12z" />
      <path d="M9.2 4.3l2.5 2.5" />
    </svg>
  );
}

export function IconPlus({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconSearch({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.4 10.4l3.4 3.4" />
    </svg>
  );
}

export function IconX({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
