/**
 * MobileWheel——手機時刻 sheet 的滾輪（主線②；D-主-14、契約 §4.5-4）。
 *
 * 兩欄 scroll-snap 滾輪＋中間的冒號：
 *   小時欄＝營業日表記 `dayStartHour … dayStartHour+23`（日界線 06 ⇒ 06…29）；≥ 24 的項下方小字「隔天N時」。
 *     原生時間輸入框（input 的 time 型）只有 00–23，打不出 25:00——這就是 D-主-14 選滾輪的理由，欄位直接排營業日的 24 個小時。
 *   分鐘欄＝00,05,…,55；**打開那一刻的值若不是 5 的倍數，把那個分插進它的位置**（桌機打的 07:43 打開不會被滾成 07:45）。
 *     插入的分只在掛載時決定一次：使用者捲動中清單不能變形（項目位移會讓 snap 落點跳格）。
 *
 * 值的唯一真相在父層（`value`＝自 00:00 起的牆鐘分鐘，可 ≥ 1440）：
 *   捲停（`scrollend`；不支援的 WebView 退回 120ms 去抖）⇒ 讀兩欄 snap 到的項 ⇒ `onChange(h*60+m)`；
 *   父層的值變了（chip、初值）而欄位停的不是那一格 ⇒ 程式捲過去（掛載時瞬移、之後平滑）。
 *   捲停只回報「這一欄」的新值，另一欄沿用父層的值——兩欄同時在程式捲動（按 chip）時不會互相讀到半路的位置。
 * 鍵盤／讀屏：每欄 `role="listbox"`、可 Tab 進入，↑↓ 換一格、Home／End 到頭尾；項 `role="option"`＋`aria-selected`；點項＝選它。
 * 樣式在 schedule-mobile.css（`.wheel`／`.wcol`／`.wi`）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

/** 一格高（px）；CSS `.wcol .wi` 同值，選取帶 `.wheel::before` 在第 3 格（80–120px） */
const ITEM_H = 40;
/** 不支援 scrollend 時的捲停判定 */
const SETTLE_MS = 120;

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

interface WheelItem {
  value: number;
  label: string;
  sub?: string;
}

function WheelCol({
  items,
  selected,
  onSelect,
  ariaLabel,
}: {
  items: WheelItem[];
  /** 目前選中的項的 index（父層的值換算來的） */
  selected: number;
  onSelect(index: number): void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  const timer = useRef(0);
  /** 程式捲動（平滑）還在路上時的目標 scrollTop；null＝沒有在途的程式捲動（或使用者已接手） */
  const target = useRef<number | null>(null);
  // onSelect 每次 render 都是新的函式；事件監聽只綁一次，經 ref 取最新的
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const countRef = useRef(items.length);
  countRef.current = items.length;

  // 父層的值 → 欄位位置（掛載時瞬移；之後只在「停的不是那一格」時平滑捲過去）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const at = Math.round(el.scrollTop / ITEM_H);
    if (!mounted.current) {
      mounted.current = true;
      el.scrollTop = selected * ITEM_H;
      return;
    }
    // 先前的程式捲動還在路上（target 還在）時，就算此刻四捨五入剛好停在新值上也要重捲：
    // 否則舊捲動稍後捲停，會把剛選的新值蓋掉（點 chip 時另一欄還在平滑捲向舊值）
    if (at !== selected || target.current !== null) {
      const top = selected * ITEM_H;
      if (Math.abs(el.scrollTop - top) < 1) {
        // 剛好經過目標位置：用瞬間捲動把在途的舊捲動收掉；沒有後續 scroll／scrollend 來清 target，這裡直接放掉
        el.scrollTo({ top, behavior: "auto" });
        target.current = null;
      } else {
        target.current = top;
        el.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
      }
    }
  }, [selected]);

  // 捲停 ⇒ 回報 snap 到的那一格
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const settle = () => {
      window.clearTimeout(timer.current);
      // 程式捲動還沒到目標：這次「捲停」不是使用者選的（例：被別的捲動打斷、去抖提早到）⇒ 不回報，免得舊位置蓋掉新值
      if (target.current !== null) {
        if (Math.abs(el.scrollTop - target.current) > ITEM_H / 2) return;
        target.current = null;
      }
      const i = Math.max(0, Math.min(countRef.current - 1, Math.round(el.scrollTop / ITEM_H)));
      onSelectRef.current(i);
    };
    const onScroll = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(settle, SETTLE_MS);
    };
    // 使用者接手（手指、滾輪）⇒ 放掉程式捲動的目標，之後的捲停照常回報
    const takeOver = () => {
      target.current = null;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", settle);
    el.addEventListener("touchstart", takeOver, { passive: true });
    el.addEventListener("pointerdown", takeOver, { passive: true });
    el.addEventListener("wheel", takeOver, { passive: true });
    return () => {
      window.clearTimeout(timer.current);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", settle);
      el.removeEventListener("touchstart", takeOver);
      el.removeEventListener("pointerdown", takeOver);
      el.removeEventListener("wheel", takeOver);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    let next: number | null = null;
    if (e.key === "ArrowUp") next = selected - 1;
    else if (e.key === "ArrowDown") next = selected + 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next === null) return;
    e.preventDefault();
    onSelect(Math.max(0, Math.min(items.length - 1, next)));
  };

  return (
    <div
      ref={ref}
      className="wcol"
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      <div className="pad" aria-hidden />
      {items.map((it, i) => (
        <div
          key={it.value}
          role="option"
          aria-selected={i === selected}
          aria-label={it.sub ? `${it.label}（${it.sub}）` : it.label}
          className={"wi" + (i === selected ? " on" : "")}
          onClick={() => onSelect(i)}
        >
          {it.label}
          {it.sub && <small>{it.sub}</small>}
        </div>
      ))}
      <div className="pad" aria-hidden />
    </div>
  );
}

export interface MobileWheelProps {
  /** 自 00:00 起的牆鐘分鐘（營業日表記；落在 clockRange(dayStartHour) 內） */
  value: number;
  dayStartHour: number;
  onChange(min: number): void;
}

export function MobileWheel({ value, dayStartHour, onChange }: MobileWheelProps) {
  // 掛載那一刻的分不是 5 的倍數 ⇒ 插進分鐘欄（只決定一次，理由見檔頭）
  const [extraMinute] = useState<number | null>(() => (value % 60) % 5 !== 0 ? value % 60 : null);

  const hours = useMemo<WheelItem[]>(
    () =>
      Array.from({ length: 24 }, (_, k) => {
        const h = dayStartHour + k;
        return { value: h, label: pad2(h), sub: h >= 24 ? `隔天${h - 24}時` : undefined };
      }),
    [dayStartHour],
  );
  const minutes = useMemo<WheelItem[]>(() => {
    const ms = Array.from({ length: 12 }, (_, k) => k * 5);
    if (extraMinute !== null && !ms.includes(extraMinute)) {
      ms.push(extraMinute);
      ms.sort((a, b) => a - b);
    }
    return ms.map((m) => ({ value: m, label: pad2(m) }));
  }, [extraMinute]);

  const h = Math.floor(value / 60);
  const m = value % 60;
  const hIdx = Math.max(0, hours.findIndex((x) => x.value === h));
  // 值的分不在清單裡（例：chip 只會給整點，不會發生；保險起見取最近的一格）
  const mExact = minutes.findIndex((x) => x.value === m);
  const mIdx =
    mExact >= 0
      ? mExact
      : minutes.reduce((best, x, i) => (Math.abs(x.value - m) < Math.abs(minutes[best].value - m) ? i : best), 0);

  const pickHour = useCallback(
    (i: number) => {
      const next = hours[i].value * 60 + (value % 60);
      if (next !== value) onChange(next);
    },
    [hours, value, onChange],
  );
  const pickMinute = useCallback(
    (i: number) => {
      const next = Math.floor(value / 60) * 60 + minutes[i].value;
      if (next !== value) onChange(next);
    },
    [minutes, value, onChange],
  );

  return (
    <div className="wheel">
      <WheelCol items={hours} selected={hIdx} onSelect={pickHour} ariaLabel="時" />
      <span className="colon" aria-hidden>
        :
      </span>
      <WheelCol items={minutes} selected={mIdx} onSelect={pickMinute} ariaLabel="分" />
    </div>
  );
}
