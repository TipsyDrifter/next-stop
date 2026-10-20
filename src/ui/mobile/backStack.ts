/**
 * backStack——手機返回鍵的 React 鉤子與原生橋接（磨光① A3；契約 §1、§9.1）。純邏輯在 backStackCore.ts。
 *
 * 各線用法（只在自己的檔裡呼叫，集中檔零改動）：
 *   useBackLayer("notes.capture", capture !== null, () => escapeCapture());            // 底部面板（預設 kind "sheet"）
 *   useBackLayer("core.routemap", openedId !== null, goUp, "page");                      // 子頁：返回＝上一層
 *   useBackLayer("ticket.form", panel !== null, close, "full");                          // 全螢幕面板
 *   useBackLayer("core.recovery", open, () => {}, "dialog");                             // 吞掉（不能用返回跳過）
 *   useBackLayer("ticket.form.pick", sheet !== null, () => setSheet(null), "dialog");    // 疊在 full 上的子面板一律 dialog
 * 返回＝那一層自己的取消會做的事（×、取消、麵包屑上一段），不發明新語意。
 * 疊在全螢幕面板（full）上的子面板（挑選器、日期／幣別 sheet）登記 "dialog"：權重才排得到 full 上面，
 * toast 也跟著到頂端（全螢幕面板已經蓋掉頂帶，頂端壓的是表單標題列——比壓在子面板上輕；契約 §9.3）。
 * 登記在「狀態的主人」那裡；行內狀態與同層的段切換不算層。
 *
 * 只在手機殼生效：桌機（`<html data-shell="desktop">`）整支 no-op，不推堆疊、不寫 `data-m-layer`（反駁 F-1）。
 * 最上層的種類（page 以外）寫到 `<html data-m-layer>`，給 toast 與浮鈕的 CSS 用（§9.3）。
 */
import { useEffect, useRef } from "react";
import { BackBridge, BackStack, type BackKind, type BackListener, type BackResult } from "./backStackCore";

export type { BackKind } from "./backStackCore";

/** 全 App 一份 */
export const backStack = new BackStack();

function isMobileShellNow(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.shell === "mobile";
}

/**
 * 登記一層。`active` 由 false 變 true 時推進、變回 false 或卸載時放掉；`onBack` 永遠叫最新的閉包。
 * 同 id 可以有好幾個實例（refcount，合併成一層）。
 */
export function useBackLayer(id: string, active: boolean, onBack: () => void, kind: BackKind = "sheet"): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!active || !isMobileShellNow()) return;
    return backStack.push(id, kind, () => ref.current());
  }, [id, active, kind]);
}

/* ───────────── 原生橋接（MobileShell 掛一次） ───────────── */

function isTauriAndroid(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    typeof navigator !== "undefined" &&
    /Android/i.test(navigator.userAgent)
  );
}

const NOOP_LISTENER: BackListener = { unregister() {} };

async function registerNative(handler: () => void): Promise<BackListener> {
  if (!isTauriAndroid()) return NOOP_LISTENER;
  const { onBackButtonPress } = await import("@tauri-apps/api/app");
  // 每次掛拿到自己的 PluginListener；拆只拆它（反駁 A-3）
  const l = await onBackButtonPress(() => handler());
  return { unregister: () => l.unregister() };
}

let bridge: BackBridge | null = null;
function getBridge(): BackBridge {
  if (!bridge) {
    bridge = new BackBridge(backStack, {
      register: registerNative,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
  }
  return bridge;
}

function writeLayerAttr() {
  if (typeof document === "undefined") return;
  const top = backStack.top();
  const root = document.documentElement;
  if (top && top.kind !== "page") root.dataset.mLayer = top.kind;
  else delete root.dataset.mLayer;
}

declare global {
  interface Window {
    /** 假資料模式（?mock=1）才有：模擬一下 Android 返回鍵，回這一下做了什麼（"exit"＝會退到背景） */
    __nsBack?: () => BackResult | "exit";
  }
}

/**
 * MobileShell 呼叫一次。`tabRule`：堆疊空時，不在今日 tab ⇒ 回傳「回去」的動作；在今日 ⇒ null。
 * 每次 render 都傳最新的規則（內部只存 ref）；tab 變了要叫 `reconcile`，所以依賴放 `tabKey`。
 */
export function useAndroidBack(tabRule: () => (() => void) | null, tabKey: string, mock: boolean): void {
  const ruleRef = useRef(tabRule);
  ruleRef.current = tabRule;

  useEffect(() => {
    const b = getBridge();
    b.setTabRule(() => ruleRef.current());
    writeLayerAttr();
    const off = backStack.subscribe(() => {
      writeLayerAttr();
      b.reconcile();
    });
    if (mock) {
      window.__nsBack = () => (b.listening ? b.handle() : "exit");
    }
    return () => {
      off();
      b.setTabRule(null);
      delete document.documentElement.dataset.mLayer;
      if (mock) delete window.__nsBack;
    };
  }, [mock]);

  useEffect(() => {
    getBridge().reconcile();
  }, [tabKey]);
}
