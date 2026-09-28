/**
 * RecoveryCodeDialog——復原碼的一次性顯示對話框（v1.1.5；契約席立骨架、WP-C 落版面；兩殼共用、掛在 App 層一份）。
 *
 * 拍板依據：決策記錄〈v1.1.5 Plan 拍板〉（復原碼：只顯示一次、不存本機、可重生）＋
 *   《2026-09-25-v1.1.5-同步告警與復原碼契約.md》§6.3。
 *
 * 規矩：
 *   * 碼只從 `syncStore.recoveryDisplay` 來（Rust 只回一次）；關掉就 `closeRecoveryDialog()` 清掉，之後再也拿不到。
 *   * **勾了「我已抄下」才能關**；Esc 與點暗幕一律不關。
 * 為什麼不套 DialogShell（WP-C）：DialogShell 恆有 ×、Esc 與點暗幕都會叫 onClose——在這裡那三條路都得是死路，
 *   留一顆按了沒反應的 × 只會讓人以為壞了。所以殼的**樣式**照借（`.techo-veil`＋`.ns-card.ns-dialog`＋`.ns-tear`
 *   ＋燙金 overline＋襯線標題，視覺與設定卡同一張票），行為自己寫：沒有 ×、暗幕不收點擊。
 * 為什麼要在 window 的**捕獲階段**吞掉 Esc：桌機是在設定卡（DialogShell）裡按「產生」的，設定卡的 Esc 監聽掛在
 *   window 冒泡階段——不先吞掉，主人在看碼時順手按 Esc 會把底下的設定卡關掉，畫面剩一張浮在主欄上的碼。
 * 層級：`z-50`（設定卡是 z-40；確認窗 z-50 但掛在本元件之後，萬一同開仍在最上）。
 * 碼的樣子：等寬大字、每 5 字一組（Rust `format_for_display` 已經分好），可整段選取；手機寬度下自動折行但不拆組。
 * 「複製」走 `navigator.clipboard.writeText`（Tauri WebView 兩殼都有）；失敗就提示手抄（碼仍在畫面上）。
 * 碼不進 toast、不進 console、不進 aria-live（讀屏念到的是 aria-label「復原碼」＋內文本身，主人自己的畫面）。
 */
import { useEffect, useId, useRef, useState } from "react";
import { useSyncStore, RECOVERY_TEXT } from "../../store/syncStore";
import "./overlay.css";
import "../../styles/sync.css";

export function RecoveryCodeDialog() {
  const code = useSyncStore((s) => s.recoveryDisplay);
  if (!code) return null;
  // 每組新碼都是一次新的掛載：勾選與「已複製」不會從上一組殘留下來
  return <RecoveryCodeDialogInner key={code} code={code} />;
}

function RecoveryCodeDialogInner({ code }: { code: string }) {
  const close = useSyncStore((s) => s.closeRecoveryDialog);
  const titleId = useId();
  const leadId = useId();
  const [acked, setAcked] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const ackRef = useRef<HTMLInputElement>(null);

  // 開啟時把焦點放在「我已抄下」那一格（下一個該做的動作），關掉後還給原本的焦點
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ackRef.current?.focus();
    return () => {
      if (prev && prev.isConnected) prev.focus();
    };
  }, []);

  // Esc 一律吞掉（捕獲階段，見檔頭）：這是唯一一次看到碼的機會，不給任何「不小心」的關法
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // stopImmediate：事件若直接派在 window 上（目標階段），同一目標上的其他監聽也要一起擋掉
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };

  const onClose = () => {
    if (!acked) return; // 沒勾就不關——這是唯一一次看到它的機會
    close();
  };

  return (
    <div className="techo-veil fixed inset-0 z-50 flex items-start justify-center pt-[12vh] ns-recovery-veil">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={leadId}
        className="ns-card ns-dialog ns-recovery-dialog max-w-[92vw] transition duration-150 ease-out starting:opacity-0 starting:translate-y-1"
        style={{ width: 520 }}
      >
        <div className="ns-tear px-6 pt-5 pb-3.5">
          <p className="techo-overline mb-1.5">{RECOVERY_TEXT.dialogOverline}</p>
          <h2 id={titleId} className="techo-title text-[19px]">
            {RECOVERY_TEXT.dialogTitle}
          </h2>
        </div>
        <div className="ns-dialog-body px-6 pt-4 pb-5">
          <p id={leadId} className="ns-note">
            {RECOVERY_TEXT.dialogLead}
          </p>

          <p className="ns-recovery-code" aria-label="復原碼">
            {code.split("-").map((g, i, all) => (
              // 每組一個 inline-block、連字號黏在組尾：窄螢幕折行時只在「-」之後斷，不會把一組拆成兩半、也不會讓下一行以「-」開頭
              <span key={i} className="ns-recovery-group">
                {g}
                {i < all.length - 1 && <span className="ns-recovery-dash">-</span>}
              </span>
            ))}
          </p>

          <div className="ns-recovery-copy">
            <button type="button" className="btn-ghost ns-btn ns-btn--sm" onClick={() => void copy()}>
              {copied === "ok" ? RECOVERY_TEXT.copied : RECOVERY_TEXT.copy}
            </button>
            {copied === "fail" && <span className="ns-note is-fail">複製不了——請照著上面手抄。</span>}
          </div>

          <ul className="ns-recovery-notes">
            {RECOVERY_TEXT.notes.map((n) => (
              <li key={n} className="ns-note">
                {n}
              </li>
            ))}
          </ul>

          <label className="ns-recovery-ack">
            <input ref={ackRef} type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
            <span>{RECOVERY_TEXT.ack}</span>
          </label>

          <div className="ns-recovery-foot">
            <button type="button" className="btn-seal ns-btn ns-recovery-close" disabled={!acked} onClick={onClose}>
              {RECOVERY_TEXT.close}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   加入表單「用復原碼」那一欄的輸入整形（兩殼共用；契約 §6.4）
   ═══════════════════════════════════════════════════════════════════════ */

/** 正規形長度（Base32 26 字＋校驗 1 字；Rust `recovery::CODE_LEN`） */
export const RECOVERY_CODE_LEN = 27;

/**
 * 主人打字／貼上時即時整形：去掉空白與連字號、轉大寫、每 5 字補一個連字號（與對話框的顯示形同一個樣子）。
 * **只整形、不驗證**——字集與校驗碼由 Rust `recovery::normalize` 在打網路之前擋，錯誤的人話也從那裡來（兩殼同一句）。
 * 回傳 `length`＝去掉連字號之後的字數，給「還差幾個字」與送出鈕的門檻用。
 */
export function formatRecoveryInput(raw: string): { display: string; length: number } {
  // v1.1.5 修正席（工程評審 S-3 配套）：全形英數折回半形、IME 的長音符／中點／各種破折號與零寬字元當分隔符丟掉——
  // 與 Rust `recovery::normalize` 同一套（驗證仍以 Rust 為準；這裡只管顯示與字數）
  const body = raw
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\-_\u2010-\u2015\u2212\u30FC\uFF70\u30FB\uFF65\u00B7\u200B-\u200D\u2060\uFEFF]/g, "")
    .toUpperCase();
  return { display: (body.match(/.{1,5}/g) ?? []).join("-"), length: body.length };
}
