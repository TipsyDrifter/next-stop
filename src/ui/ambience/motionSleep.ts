/**
 * motionSleep.ts — 全 App 一個「現在有沒有人在看」的訊號（⑪ 效能守則）
 *
 * 教訓來源（ClaudeUsageMonitor D105／D107）：WebView2 不知道自己被縮小，頁面的 visibilityState 一直是 visible，
 * 沒人看的視窗照樣每秒畫 60 張；螢幕保護蓋著也一樣。所以不靠瀏覽器自己停：
 *   hidden ＝真的看不到：頁面隱藏（手機切背景、關螢幕）、或後端回報主視窗被縮小／藏到系統匣、螢幕保護、鎖屏
 *            → <html data-motion-asleep="hidden">：全 App 的 CSS 動畫一律暫停（規則在 styles/ambience.css）
 *   idle   ＝看得到但大概沒人在看：切到別的程式滿 1 分鐘、或滿 5 分鐘沒碰它
 *            → data-motion-asleep="idle"：只停裝飾層。不動全域，免得沒人碰時跳出的提示卡在進場動畫第一格
 * 滑鼠移進來、按鍵、拿回焦點就醒。
 *
 * 沒有用 Webview::hide()（SetIsVisible）：頁面一變 hidden，同步的每分鐘輪詢和提醒的計時都會跟著停或被節流，
 * 而這支 App 常駐系統匣時還要繼續收同步與跳提醒。
 */
import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SleepLevel = "hidden" | "idle" | null;

export const BLUR_SLEEP_MS = 60_000;
export const IDLE_SLEEP_MS = 5 * 60_000;

/** 跟後端 `motion_watch.rs` 同一個名字 */
const HIDDEN_EVENT = "motion://hidden";

export interface SleepInput {
  docHidden: boolean;
  backendHidden: boolean;
  focused: boolean;
  sinceActivityMs: number;
}

export function sleepLevel(s: SleepInput): SleepLevel {
  if (s.docHidden || s.backendHidden) return "hidden";
  return s.sinceActivityMs >= (s.focused ? IDLE_SLEEP_MS : BLUR_SLEEP_MS) ? "idle" : null;
}

let level: SleepLevel = null;
let backendHidden = false;
let lastActivity = 0;
let focused = true;
let timer: number | undefined;
let started = false;
const subs = new Set<() => void>();

function evaluate(): void {
  window.clearTimeout(timer);
  const since = performance.now() - lastActivity;
  const next = sleepLevel({ docHidden: document.hidden, backendHidden, focused, sinceActivityMs: since });
  if (next !== level) {
    level = next;
    if (next) document.documentElement.setAttribute("data-motion-asleep", next);
    else document.documentElement.removeAttribute("data-motion-asleep");
    for (const f of subs) f();
  }
  // 醒著才需要倒數；睡著之後等事件叫醒，手上沒有任何計時器
  if (next === null) timer = window.setTimeout(evaluate, (focused ? IDLE_SLEEP_MS : BLUR_SLEEP_MS) - since);
}

function onActivity(): void {
  lastActivity = performance.now();
  if (level !== null) evaluate();
}

function onFocusChange(e: Event): void {
  if (e.type === "focus") focused = true;
  if (e.type === "blur") focused = false;
  lastActivity = performance.now();
  evaluate();
}

function start(): void {
  if (started) return;
  started = true;
  lastActivity = performance.now();
  focused = document.hasFocus();
  for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const) {
    window.addEventListener(ev, onActivity, { passive: true, capture: true });
  }
  window.addEventListener("focus", onFocusChange);
  window.addEventListener("blur", onFocusChange);
  document.addEventListener("visibilitychange", onFocusChange);
  if (isTauri()) {
    const set = (v: boolean) => {
      backendHidden = v;
      if (!v) lastActivity = performance.now(); // 回來了＝有人要看
      evaluate();
    };
    void listen<boolean>(HIDDEN_EVENT, (e) => set(e.payload)).catch(() => undefined);
    // 開機直接藏在系統匣時，事件比這裡的監聽還早發，開場問一次；手機沒有這個指令，問不到就算了
    void invoke<boolean>("motion_watch_state").then(set, () => undefined);
  }
  evaluate();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  start();
  return () => subs.delete(cb);
}

/** 現在睡到哪一級；SkyLayer 一直掛著，所以開 App 就開始算 */
export function useMotionSleep(): SleepLevel {
  return useSyncExternalStore(subscribe, () => level, () => null);
}
