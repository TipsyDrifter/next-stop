/**
 * 「第一次執行就把開機自啟打開」——只做一次（契約 0-15；主視窗的 `useCaptureShellBridge` 啟動時呼叫）。
 *
 * 判斷與流程是 `domain/notes.ts` 的 `autostartDefaultOnce`（node 可測）；這裡只接真的外部動作：
 * - identifier：直接用 `autostart_get` 回的 `name`（Rust 端＝`run_value_name(identifier)`＝identifier 原文），
 *   不走 `@tauri-apps/api/app` 的 `getIdentifier()`——省掉「`core:app:allow-identifier` 在不在 `core:default`」那一題（契約 §8-14）。
 * - 旗標：`settings` 表的本機鍵 `notes_autostart_default`（不進同步白名單；從別台備份還原會帶過來——接受）。
 * - 三道閘：`import.meta.env.PROD`、正式 identifier、非 debug 建置（`autostart_get` 的 `debugBuild`）；dev（vite）與沙盒 exe 都是 DEV，永遠不會去動真實的開機項目。
 * 失敗只 toast 一次「開機自啟沒有設定成功：{error}」，開關仍在設定〈一般〉。
 */
import { settingsRepo } from "../../../data";
import { autostartDefaultOnce } from "../../../domain/notes";
import { useUiStore } from "../../../store/uiStore";
import { AUTOSTART_FLAG_KEY, autostartGet, autostartSet, isTauri } from "./shell";

let started = false;

export async function bootAutostartDefault(): Promise<void> {
  // 一次啟動只跑一趟（StrictMode 的雙掛載、bridge 重掛都不重跑）
  if (started || !isTauri()) return;
  started = true;
  const res = await autostartDefaultOnce({
    isProd: import.meta.env.PROD,
    get: autostartGet,
    enable: () => autostartSet(true),
    readFlag: () => settingsRepo.get(AUTOSTART_FLAG_KEY),
    writeFlag: () => settingsRepo.set(AUTOSTART_FLAG_KEY, "1"),
  });
  if (res.kind === "failed") {
    useUiStore.getState().showToast({ message: `開機自啟沒有設定成功：${res.error || "原因不明"}` });
  }
}
