/**
 * AutostartRow——設定〈一般〉的「開機時啟動（縮在系統匣）」一列（階段⑤ 契約 §5.4；SettingsPanel 的 GeneralTab 最後一段）。
 *
 * 開關＝兩枚 `.ns-choice`「開／關」（同步分頁「同步總開關」同一個寫法，新形狀零發明）；說明＝`.ns-note`；
 * 熱鍵沒註冊成功時多一行朱紅字（`--color-seal`；App 沒有獨立的 error 色票，朱印是最紅的那一個，深淺主題各有提亮版）。
 * 鍵帽一律 `capsOf`（probe 牙齒 5）。
 * 掛上時問 `autostart_get()`：`available=false`（瀏覽器預覽、外掛沒掛成功、不是桌機）⇒ 整列不畫。
 * 熱鍵狀態：先用主視窗啟動時問到的那一份（`lastCaptureStatus`），掛上再問一次；之後視窗取得焦點／重新可見時也再問
 * （設定面板開著的時候不會重掛）——主視窗取得焦點時 Rust 會重試註冊，但那是 Rust 側的視窗事件，不保證比 JS 的 `focus`
 * 先到，所以立刻問一次、400ms 後再問一次。「關掉佔鍵的程式、點回這個視窗」之後紅字就會消失，不必關掉設定再開。
 * 切換失敗：toast「開機自啟沒有設定成功：{error}」，開關停在原值（讀回的值為準）。
 */
import { useEffect, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { capsOf } from "./notesBits";
import { HOTKEY_ID, autostartGet, autostartSet, captureStatus, type AutostartInfo, type CaptureStatus } from "./capture-window/shell";
import { lastCaptureStatus, rememberCaptureStatus } from "./capture-window/useCaptureShellBridge";

/** 熱鍵警示字的顏色：朱（深色主題有提亮版）。不用同步／備份分頁那條偏橘的 `--ns-warn-text` */
const ERROR_TEXT = "var(--color-seal)";

/** 主視窗取得焦點後，Rust 側重試註冊熱鍵要一點時間：JS 的 focus 事件之後再補問一次的延遲 */
const RECHECK_MS = 400;
/** 警示顯示中的定時重問間隔 */
const POLL_MS = 3000;

export function AutostartRow() {
  const [info, setInfo] = useState<AutostartInfo | null>(null);
  const [status, setStatus] = useState<CaptureStatus | null>(() => lastCaptureStatus());
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let alive = true;
    autostartGet()
      .then((i) => alive && setInfo(i))
      .catch((e) => console.warn("[capture] autostart_get 失敗", e));
    const refreshStatus = () =>
      captureStatus()
        .then((s) => {
          rememberCaptureStatus(s);
          if (alive) setStatus(s);
        })
        .catch((e) => console.warn("[capture] capture_status 失敗", e));
    void refreshStatus();
    // 設定面板開著時重新取得焦點／重新可見：再問一次（立刻＋稍後各一次）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onShown = () => {
      if (document.visibilityState !== "visible") return;
      void refreshStatus();
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void refreshStatus(), RECHECK_MS);
    };
    window.addEventListener("focus", onShown);
    document.addEventListener("visibilitychange", onShown);
    // 警示顯示中、使用者一直停在這個視窗：定時問（capture_status 在沒拿到鍵時會順便重註冊一次）
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && lastCaptureStatus()?.hotkeyRegistered === false) void refreshStatus();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(poll);
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", onShown);
      document.removeEventListener("visibilitychange", onShown);
    };
  }, []);

  if (!info?.available) return null;
  const caps = capsOf(HOTKEY_ID);

  const set = async (enabled: boolean) => {
    if (working || enabled === info.enabled) return;
    setWorking(true);
    try {
      setInfo(await autostartSet(enabled));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? "");
      useUiStore.getState().showToast({ message: `設定開機時啟動失敗：${msg || "原因不明"}` });
      // 開關回到實際的值（可能切了一半）
      autostartGet()
        .then(setInfo)
        .catch(() => {});
    } finally {
      setWorking(false);
    }
  };

  return (
    <div>
      <span className="techo-label block mb-2.5">開機時啟動（縮在右下角）</span>
      <div role="radiogroup" aria-label="開機時啟動" className="flex flex-wrap items-center gap-2">
        {[true, false].map((v) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={info.enabled === v}
            disabled={working}
            onClick={() => void set(v)}
            className={`ns-choice${info.enabled === v ? " is-on" : ""}`}
          >
            {v ? "開" : "關"}
          </button>
        ))}
      </div>
      <p className="ns-note mt-2">登入 Windows 後私鐵手帳會在背景待命，隨時按 {caps} 記一句；主視窗不會自己跳出來。</p>
      {status && !status.hotkeyRegistered && (
        <p className="ns-note mt-1" role="status" style={{ color: ERROR_TEXT }}>
          快捷鍵 {caps}被別的程式佔走了{status.hotkeyError ? `（${status.hotkeyError}）` : ""}，關掉它再回來就會生效。</p>
      )}
    </div>
  );
}
