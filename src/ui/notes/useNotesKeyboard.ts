/**
 * useNotesKeyboard——旅客筆記頁的「導航模式」按鍵表（車次①契約 §5.6；scope `notes`）。
 *
 * 鍵位本身由 registry 決定（`src/lines/notes.manifest.ts` 的 hotkeys → `resolveHotkey("notes", e)`）；
 * 這裡只做「id → 動作」的接線，動作由 NotesView 依子畫面（收件匣／筆記）分派。
 * `pnpm probe:hotkeys` 牙齒 3／4 要求每個 wired 的 `notes.*` id 以字串字面值出現在本檔、且本檔沒有 registry
 * 沒登錄的 id（本檔任何引號字串都不要以那個前綴加點開頭，否則會被當成 id 對帳）。
 *
 * 鐵則（與 useTodayKeyboard 同）：
 *   1. 組字中（IME，isComposing／keyCode 229）一律不攔
 *   2. target 是 input／textarea／select／contentEditable 時整張表停用（輸入框自理：內文 Esc 回閱讀、小浮層 Esc 收起）
 *   3. 聚焦中的 <button> 上的 Enter／Space 讓按鈕自己啟動
 *   4. Ctrl／Alt 組合鍵不在本表（registry 沒有不放寬 Ctrl 的 notes 鍵）⇒ resolveHotkey 回 null 放行給全域
 *
 * `disabled`＝小浮層（排某天／掛進列車／掛上路線／換掛／改日期）開著：整張表停用，只留 Esc 收起浮層
 * （浮層裡的 chip 是 button，按 T 不能被當成「排今天」）。
 */
import type { KeyboardEvent } from "react";
import { isEditableTarget, resolveHotkey } from "../shell/hotkeys";

export interface NotesKeyActions {
  /** ↑↓：收件匣／筆記列表移動選取 */
  move(delta: 1 | -1): void;
  /** Enter：收件匣＝焦點移到去處列第一顆；筆記＝內文進編輯（D-筆-24） */
  open(): void;
  /** T：筆記＝變待辦（開預覽）；車票＝排今天 */
  todo(): void;
  /** Shift+T：車票＝排明天 */
  tomorrow(): void;
  /** N：收件匣筆記＝留作筆記 */
  keep(): void;
  /** L：收件匣車票＝開「掛進列車」浮層 */
  attach(): void;
  /** R：收件匣車票＝開「掛上路線」浮層 */
  route(): void;
  /** Delete：刪除選中的那一則／張（可復原） */
  del(): void;
  /** /：筆記＝焦點到搜尋框 */
  search(): void;
  /** Esc：收起小浮層／編輯回閱讀；回傳有沒有處理（沒處理就不吃掉這顆鍵） */
  escape(): boolean;
  /* ── 車次②（契約 §5.6）：選填；沒給＝這顆鍵放行不吃（NotesView 依子畫面給：D 只在收件匣、其餘只在日記頁） ── */
  /** D：收件匣筆記＝記成日記 */
  toDiary?(): void;
  /** ←／→：日記頁翻日 */
  stepDay?(dir: 1 | -1): void;
  /** Shift+←／Shift+→：足跡欄獨立翻日 */
  stepFp?(dir: 1 | -1): void;
  /** Home：日記回到今天 */
  today?(): void;
  /** B：足跡回到本文那天 */
  fpBack?(): void;
  /** G：開大日期的挑選器 */
  pick?(): void;
  /** W：寫日記／補記／再寫一篇（草稿已開＝焦點到內文框） */
  write?(): void;
}

/** 選填動作：有給才吃掉這顆鍵 */
function run(e: KeyboardEvent<HTMLElement>, fn: (() => void) | undefined): void {
  if (!fn) return;
  e.preventDefault();
  fn();
}

export function useNotesKeyboard(a: NotesKeyActions, disabled = false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (isEditableTarget(e.target)) return;
    const hk = resolveHotkey("notes", e);
    if (disabled) {
      if (hk?.id === "notes.escape" && a.escape()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
    if (onButton && (e.key === "Enter" || e.key === " ")) return;
    if (!hk) return;
    switch (hk.id) {
      case "notes.move.up":
        e.preventDefault();
        a.move(-1);
        break;
      case "notes.move.down":
        e.preventDefault();
        a.move(1);
        break;
      case "notes.open":
        e.preventDefault();
        a.open();
        break;
      case "notes.inbox.todo":
        e.preventDefault();
        a.todo();
        break;
      case "notes.inbox.tomorrow":
        e.preventDefault();
        a.tomorrow();
        break;
      case "notes.inbox.keep":
        e.preventDefault();
        a.keep();
        break;
      case "notes.inbox.attach":
        e.preventDefault();
        a.attach();
        break;
      case "notes.inbox.route":
        e.preventDefault();
        a.route();
        break;
      case "notes.delete":
        e.preventDefault();
        a.del();
        break;
      case "notes.search":
        e.preventDefault();
        a.search();
        break;
      case "notes.escape":
        if (a.escape()) {
          e.preventDefault();
          e.stopPropagation();
        }
        break;
      case "notes.inbox.diary":
        run(e, a.toDiary);
        break;
      case "notes.diary.prev":
        run(e, a.stepDay && (() => a.stepDay!(-1)));
        break;
      case "notes.diary.next":
        run(e, a.stepDay && (() => a.stepDay!(1)));
        break;
      case "notes.diary.fp.prev":
        run(e, a.stepFp && (() => a.stepFp!(-1)));
        break;
      case "notes.diary.fp.next":
        run(e, a.stepFp && (() => a.stepFp!(1)));
        break;
      case "notes.diary.today":
        run(e, a.today);
        break;
      case "notes.diary.fp.back":
        run(e, a.fpBack);
        break;
      case "notes.diary.pick":
        run(e, a.pick);
        break;
      case "notes.diary.write":
        run(e, a.write);
        break;
    }
  };
}
