/**
 * 閱讀態的連結開法（旅客筆記車次④契約 0-6、§5.0；桌機 MdBody 與手機 MobileMdBody 共用）。
 *
 * Tauri 內＝`@tauri-apps/plugin-opener` 的 `openUrl`（兩份 capability 已給 `opener:default`，不用新權限）；
 * `?mock=1` 瀏覽器預覽沒有 Tauri ⇒ `window.open(url, "_blank", "noopener")`。
 * 只放行 http／https（`isSafeHref`；主對話安全條件）——呼叫端已過濾，這裡再擋一次。失敗 toast「打不開這個連結」（§5.8-31）。
 */
import { isSafeHref } from "../../domain/markdown";
import { useUiStore } from "../../store/uiStore";

export async function openLink(href: string): Promise<void> {
  const fail = () => useUiStore.getState().showToast({ message: "打不開這個連結" });
  if (!isSafeHref(href)) return fail();
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(href);
    } else {
      // 帶 noopener 的 window.open 依規格一律回 null，不能拿回傳值判斷失敗——只有丟例外才算
      window.open(href, "_blank", "noopener");
    }
  } catch (e) {
    console.warn("openLink 失敗", e);
    fail();
  }
}
