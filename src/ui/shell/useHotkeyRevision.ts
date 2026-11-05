/**
 * 掛著畫鍵帽字的元件（title、`<kbd>`、提示小字）呼叫一下：使用者改了鍵就重畫。
 * 回傳值沒有用處；有用的是訂閱。開了才畫的東西（選單、對話框）打開時本來就現查，不必掛。
 */
import { useSyncExternalStore } from "react";
import { hotkeysRevision, subscribeHotkeys } from "./hotkeys";

export function useHotkeyRevision(): number {
  return useSyncExternalStore(subscribeHotkeys, hotkeysRevision);
}
