/**
 * notesBits——旅客筆記桌機 UI 的共用小件（乙席；車次①契約 §5.1／§5.2；車次③加荷札牌形、⋯、展開箭頭三枚圖示）。
 *
 * 只放「好幾個桌機元件都要用、又不屬於任何一個元件」的東西：線稿圖示、路線圓牌／色點、鍵帽字、
 * 日期換算、「掛到哪」的節點名快取、小浮層的點外面關閉。手機（丙席）不依賴本檔。
 *
 * 鍵帽字一律查 registry（契約 §1-6：顯示端不手抄鍵位字面）。
 */
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import type { NodeRow } from "../../domain";
import type { AttachTarget } from "../../domain/notes";
import { dayKeyOf, todayKey } from "../../lib/date";
import { useUiStore } from "../../store/uiStore";
import { formatChord, hotkeyById } from "../shell/hotkeys";
import { roundelStyle } from "../common/roundel";
import { svgProps } from "../sidebar/gnavIcons";

/* ───────── 圖示（16×16 線稿，筆觸 1.3px；原型 app.js 的 I.pen／search／plus／x） ───────── */

export function IconPen({ size = 13 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3.2 12.8l.9-3.1 6.6-6.6a1.4 1.4 0 0 1 2 2l-6.6 6.6z" />
      <path d="M9.5 4.3l2.2 2.2" />
    </svg>
  );
}
export function IconSearch({ size = 12 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.6 10.6 14 14" />
    </svg>
  );
}
export function IconPlus({ size = 11 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}
export function IconX({ size = 12 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** 左／右箭頭（翻日、翻月；原型 app.js I.left／I.right） */
export function IconLeft({ size = 15 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}
export function IconRight({ size = 15 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/* 車次③荷札：牌形小圖示（真的荷札＝實線牌、虛資料夾＝虛線空心牌；原型 app.js I.tag／I.tagHollow）、⋯、展開箭頭 */
export function IconTag({ size = 14, hollow = false }: { size?: number; hollow?: boolean }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M5.6 3.6h7.2a.9.9 0 0 1 .9.9v7a.9.9 0 0 1-.9.9H5.6L2.3 8z" strokeDasharray={hollow ? "1.6 1.5" : undefined} />
      {!hollow && <circle cx="5.6" cy="8" r="1" />}
    </svg>
  );
}
export function IconDots({ size = 16 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="3.2" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
export function IconCaret({ size = 10 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/* ───────── 路線圓牌／色點 ───────── */

/** 路線圓牌（亮盤深字；換算見 ui/common/roundel.ts）。route=null ⇒ 虛線空圓（無路線） */
export function Roundel({ route, xs = false }: { route: NodeRow | null | undefined; xs?: boolean }) {
  const cls = `roundel ns-notes-rd${xs ? " xs" : ""}`;
  if (!route) return <span aria-hidden className={`${cls} empty`} />;
  return (
    <span aria-hidden className={cls} style={roundelStyle(route.color)}>
      {route.code ?? ""}
    </span>
  );
}

/** 路線色點（飽和本色；捕捉框落點與路線票根用） */
export function RouteDot({ route }: { route: NodeRow | null | undefined }) {
  if (!route) return <span aria-hidden className="ns-notes-dot none" />;
  return <span aria-hidden className="ns-notes-dot" style={{ background: route.color ?? "var(--route-none)" }} />;
}

/* ───────── 鍵帽字（registry 單一來源） ───────── */

/** 某個 id 的第一組鍵位，鍵帽以「+」相連（如 Shift+T）；查不到回空字串 */
export function capsOf(id: string): string {
  const hk = hotkeyById(id);
  return hk ? formatChord(hk.chords[0]).join("+") : "";
}

/** `<kbd>` 一枚（鍵位查 registry） */
export function Kbd({ id }: { id: string }) {
  const caps = capsOf(id);
  return caps ? <kbd className="ns-notes-kbd">{caps}</kbd> : null;
}

/* ───────── 日期 ───────── */

/** 時刻戳的「日界線日」YYYY-MM-DD（受付章、列表日期、月份分隔都用這個口徑，與今日頁一致） */
export function dayOf(iso: string, dayStartHour: number): string {
  return dayKeyOf(iso, dayStartHour);
}

/**
 * 「今天」的日界線日 key（車次②契約 0-6：與今日頁、日曆頁同一把尺）。
 * 設定的 dayStartHour 一變立刻重算；每分鐘看一次，key 沒變就不 setState（跨過日界線時「今天」鈕亮起、→ 可按）。
 */
export function useTodayKey(): string {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [key, setKey] = useState(() => todayKey(dayStartHour));
  useEffect(() => {
    const tick = () => {
      const k = todayKey(dayStartHour);
      setKey((cur) => (cur === k ? cur : k));
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [dayStartHour]);
  return key;
}

/** YYYY-MM-DD → 本地 Date（不經 Date.parse，免得 date-only 被當 UTC；給 DateSeal 用，契約 §8-13） */
export function dateOfKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** "2026-10-05" → "10/5" */
export function fmtShort(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${m}/${d}`;
}

/** 時刻戳 → 本地 "HH:MM" */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 改日期但保留原本的時刻（補記：只換年月日；原型 app.js isoKeepTime） */
export function isoWithDay(iso: string, day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(iso);
  const base = Number.isNaN(t.getTime()) ? new Date() : t;
  const out = new Date(base);
  out.setFullYear(y, m - 1, d);
  return out.toISOString();
}

/** 今天起的下一個週一（排某天的快選） */
export function nextMonday(today: string, addDays: (k: string, n: number) => string): string {
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return addDays(today, (8 - dow) % 7 || 7);
}

/* ───────── 關鍵字高亮 ───────── */

export function highlight(text: string, q: string | undefined): ReactNode {
  const k = (q ?? "").trim();
  if (!k) return text;
  const low = text.toLowerCase();
  const kl = k.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let j: number;
  let n = 0;
  while ((j = low.indexOf(kl, i)) >= 0) {
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark key={n++} className="ns-notes-mark">
        {text.slice(j, j + k.length)}
      </mark>,
    );
    i = j + k.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/* ───────── 「掛到哪」的節點名快取 ─────────
 * AttachTarget 只有 id 沒有名字；AttachPicker 載樹時把名字記在這裡，預覽框的欄位鈕才能顯示「路線 › 列車」。
 * 只做顯示用、不是資料來源（名字以 nodeStore／列表 JOIN 為準）。 */
const NODE_NAMES = new Map<string, string>();

export function rememberNodeName(id: string, name: string): void {
  NODE_NAMES.set(id, name);
}

export function nodeNameOf(id: string | null | undefined): string | null {
  return id ? (NODE_NAMES.get(id) ?? null) : null;
}

/** 「掛到哪」的顯示：route＋（非路線本身時）節點名 */
export function attachParts(
  t: AttachTarget,
  routes: readonly NodeRow[],
): { route: NodeRow | null; nodeName: string | null } {
  const route = t.routeId ? (routes.find((r) => r.id === t.routeId) ?? null) : null;
  const nodeName = t.nodeId && t.nodeKind !== "route" ? (nodeNameOf(t.nodeId) ?? "（節點）") : null;
  return { route, nodeName };
}

/* ───────── 小浮層：點外面關閉 ───────── */

/**
 * 在浮層外按下滑鼠就關（capture 階段，與 DeferPopover 同法）。
 * 帶 `data-pop-toggle` 的元素（開關鈕本身）不算外面——由開關鈕自己切換，否則會關了又立刻開。
 */
export function usePopDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      const t = e.target;
      if (!el || !(t instanceof Node)) return;
      if (el.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle]")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [ref, onClose]);
}

/* ───────── 浮層的焦點交接 ─────────
 * 捕捉框（多行待辦）直接換成預覽框時，捕捉框卸載的那一刻不能把焦點還回去（會搶走預覽框「建立」鈕的焦點）；
 * 改把「開框前的元素」交給預覽框，由預覽框關掉時還。 */
let returnFocus: HTMLElement | null = null;

export function handOffReturnFocus(el: HTMLElement | null): void {
  returnFocus = el;
}

export function takeReturnFocus(): HTMLElement | null {
  const el = returnFocus;
  returnFocus = null;
  return el;
}

/** 焦點還給 el；它已經不在畫面上（跟著被整理走了）就交給旅客筆記頁的清單，不在本頁就交給頁根（例：今日頁） */
export function restoreFocus(el: HTMLElement | null): void {
  if (el && el.isConnected && el !== document.body) el.focus({ preventScroll: true });
  else document.querySelector<HTMLElement>(".ns-notes-ilist, .ns-notes-list, .page[tabindex]")?.focus({ preventScroll: true });
}

/** prefers-reduced-motion（離場動畫要不要等） */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
