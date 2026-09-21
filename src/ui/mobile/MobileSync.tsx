/**
 * MobileSync——手機「更多 → 同步」頁（v1.1.1 WP8）。
 *
 * 拍板依據：D-1.1-6 備用入口「貼上配對碼」＋手機親手輸密語（QR 掃描留 v1.1.2）、快問「配對時手機須空庫」
 *           ＋契約 §9.2。
 *
 * 版面（由上而下）：
 *   ⓪ 「← 更多」一列（本頁是「更多」的子頁，不進 uiStore——同 tab 內的往返，不需要跨殼可達）
 *   ① 狀態列（`SYNC_PHASE_LABEL`＋上次同步時刻；停車中／信号待ち把原因寫在下一行）
 *      ＋**單向提示常駐一句**（評審 B2：這一版手機只收不發，UI 不說主人會以為同步壞了）
 *   ② 未配對 ＝ 貼上配對碼（textarea）＋密語（password）→ 「配對並拉取」；
 *              Rust 端空庫檢查失敗時把那句人話**原句**留在表單下面（toast 10 秒讀不完）
 *   ③ 已配對 ＝ 總開關、「立即同步」；「重設」獨立成頁尾一塊（評審 S5：不與「立即同步」同列同尺寸）
 *
 * 觸控與輸入（鐵則）：可點目標 ≥44px（樣式在 mobile.css 的 WP8 區塊）；輸入框 font-size 16px，
 *   行動瀏覽器聚焦時才不會自動放大整頁（沿 `.m-nt-input` 的教訓）。本頁沒有導航鍵，IME 不會被擋。
 * 資料流：不碰 repository，全走 `syncStore`；密語只活在本檔的 local state，送出後即清空。
 *
 * v1.1.2（契約 §6／§9.1）補三件：
 *   ⑴ **掃描配對碼**（D-1.1-6 甲）：barcode-scanner 把相機畫在 WebView **後面**，所以掃描中整頁背景要
 *      透明（`html[data-scanning]`），並疊一層取景框＋44px「取消」。掃不到一律退回下面的貼上——
 *      相機權限、光線、鏡頭髒都可能失敗，而配對是「只做一次」的事，卡在這裡最傷。
 *   ⑵ **改正待ち**：桌機還原後開了新紀元 ⇒ 這台停在原地，提示＋確認後 `adoptEpoch()`。
 *   ⑶ 常駐那句從「只收不發」改成雙向，並把「待上傳 N」露出來（v1.1.1 replica 恆 0，現在會真的動）。
 */
import { useEffect, useRef, useState } from "react";
import { useSyncStore, SYNC_PHASE_LABEL, fmtSyncStamp } from "../../store/syncStore";
import { useUiStore } from "../../store/uiStore";

export default function MobileSync({ onBack }: { onBack: () => void }) {
  const status = useSyncStore((s) => s.status);
  const working = useSyncStore((s) => s.working);
  const bridgeError = useSyncStore((s) => s.bridgeError);
  const formError = useSyncStore((s) => s.formError);
  const pairReplica = useSyncStore((s) => s.pairReplica);
  const syncNow = useSyncStore((s) => s.syncNow);
  const setEnabled = useSyncStore((s) => s.setEnabled);
  const reset = useSyncStore((s) => s.reset);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const adoptEpoch = useSyncStore((s) => s.adoptEpoch);
  const askConfirm = useUiStore((s) => s.askConfirm);

  // 進頁就問一次狀態（純讀、可重入；同桌機 SyncTab）
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  /** 掃描中＝疊取景框、整頁背景透明（相機畫在 WebView 後面）；掃不到的人話留在 `scanHint` */
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  /** 掃到配對碼之後把焦點送到密語欄（評審 S1） */
  const passRef = useRef<HTMLInputElement | null>(null);

  // 離開本頁（或元件被拆）時把透明旗標收回來——留著的話整個 App 會變成透明底
  useEffect(() => {
    return () => {
      document.documentElement.removeAttribute("data-scanning");
    };
  }, []);

  const phase = status?.phase ?? "off";
  const configured = !!status?.configured;
  const enabled = !!status?.enabled;
  const canPair = code.trim().length > 0 && passphrase.length > 0 && !working && !bridgeError;

  const pair = async () => {
    if (!canPair) return;
    await pairReplica(code, passphrase);
    setPassphrase("");
  };

  /**
   * 掃桌機畫面上的 QR（設定 → 同步 → 顯示配對碼）。
   * 動態 import：桌機殼永遠載不到這段 JS（plugin 只掛在 mobile target）。
   * 任何一步失敗都只是「換個方式」——把人話寫在鈕底下，讓他往下貼上，不擋路。
   */
  const scanQr = async () => {
    setScanHint(null);
    setScanning(true);
    document.documentElement.setAttribute("data-scanning", "1");
    try {
      const bs = await import("@tauri-apps/plugin-barcode-scanner");
      let perm = await bs.checkPermissions();
      if (perm !== "granted") perm = await bs.requestPermissions();
      if (perm !== "granted") {
        setScanHint("相機權限沒開——請改用下面的貼上，或到系統設定開啟相機。");
        return;
      }
      const r = await bs.scan({ windowed: true, formats: [bs.Format.QRCode] });
      setCode(r.content);
      // 掃到之後就只差密語了（配對碼裡沒有它，一定要親手打）——焦點直接送過去，少一次點擊
      window.setTimeout(() => passRef.current?.focus(), 0);
    } catch (e) {
      // 評審 S1：按「取消」時 plugin 會 reject("cancelled")，以前會落到這裡變成一句紅字錯誤——
      // 主人自己按的取消不是失敗，什麼都不該說。
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("cancel")) return;
      setScanHint(`掃不到（${msg}）——請改用下面的貼上。`);
    } finally {
      document.documentElement.removeAttribute("data-scanning");
      setScanning(false);
    }
  };

  const cancelScan = () => {
    void import("@tauri-apps/plugin-barcode-scanner").then((bs) => bs.cancel()).catch(() => undefined);
  };

  return (
    <div className="m-page m2-page" aria-label="同步">
      {/* 掃描疊層：相機畫在 WebView 後面，這一層只畫取景框與取消鈕，中央留空讓相機看得見 */}
      {scanning && (
        <div className="m2-scan-overlay" role="dialog" aria-label="掃描配對碼">
          <p className="m2-scan-tip">對準桌機畫面上的 QR</p>
          <div className="m2-scan-frame" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
          <button type="button" className="ns-btn btn-ghost m2-sy-go m2-scan-cancel" onClick={cancelScan}>
            取消
          </button>
        </div>
      )}
      <button type="button" className="m2-back" onClick={onBack}>
        ← 更多
      </button>

      <section className="m2-sec" aria-labelledby="m2-sec-sync">
        <h2 id="m2-sec-sync" className="m2-sec-title">
          同步
        </h2>

        {/* ① 狀態 */}
        <div className="m2-block">
          <p className={`m2-sy-phase${phase === "stopped" ? " is-fail" : ""}`}>
            {status || bridgeError ? SYNC_PHASE_LABEL[phase] : "讀取中…"}
          </p>
          <p className="m2-note">
            {status?.last_sync_at ? `上次同步 ${fmtSyncStamp(status.last_sync_at)}` : "還沒同步過"}
          </p>
          {phase === "stopped" && status?.last_error && <p className="m2-note is-fail">{status.last_error}</p>}
          {phase === "gated" && (
            <p className="m2-note is-fail">
              兩台的版本不一致
              {status?.remote_schema != null ? `（對方 schema ${status.remote_schema}）` : ""}
              ，請先更新較舊的那一台。
            </p>
          )}
          {bridgeError && <p className="m2-note is-fail">這個版本的手機端還沒接上同步（{bridgeError}）。</p>}
          {/* 還沒送出去的筆數（v1.1.1 的 replica 恆 0，v1.1.2 兩端照實回報）——
              「在手機改的東西到底出去了沒」以前只能猜，現在數字自己會講。 */}
          {!!status?.pending_ops && <p className="m2-note">待上傳 {status.pending_ops} 筆</p>}
          {/* 產品評審 B1：「改用桌機的版本」把未送出的修改另存成一份檔——以前這件事只在一聲
              10 秒的 toast 裡講過一次，路徑錯過就再也查不到（頁上也沒有任何痕跡，等於靜默丟）。
              改成常駐一行，筆數、時刻、路徑都在。 */}
          {status?.last_orphans && (
            <p className="m2-note m2-sy-orphans">
              上次重置另存 {status.last_orphans.count} 筆未送出的修改
              {status.last_orphans.at ? `（${fmtSyncStamp(status.last_orphans.at)}）` : ""}
              <br />
              <span className="m2-sy-orphans-path">{status.last_orphans.path}</span>
            </p>
          )}
          {/* v1.1.2：雙向了。這句從「只收不發」改成兩邊都會動，並把「同時改到同一格怎麼算」講明白——
              不講的話，主人看到自己打的字被換掉會以為資料掉了（其實舊值在乘務記錄裡）。 */}
          {configured && (
            <p className="m2-note m2-sy-oneway">
              這台蓋的章、開的票會送回桌機；兩台同時改同一格時後改的算數，另一方的值記進該車票的乘務記錄。
            </p>
          )}
        </div>

        {/* ①ʹ 改正待ち（契約 §9.1）：桌機還原後開了新紀元，這台停在原地等主人點頭 */}
        {phase === "epoch_changed" && (
          <div className="m2-block m2-sy-epoch">
            <span className="m2-block-label">桌機已還原並重設同步</span>
            <p className="m2-note">
              {/* 產品評審 B1：原句說「更多 → 同步會顯示路徑」，但頁上根本沒顯示——UI 不能說謊。
                  現在真的顯示了（狀態那一塊的「上次重置另存 N 筆」），文案也改成講那件事。 */}
              桌機從備份還原後，雲端上的同步資料重新開始了。這台要改用桌機的版本；
              這台還沒送出的修改會先存成一份檔案（筆數與路徑會留在上面的狀態裡），不會直接丟掉。
            </p>
            <div className="m2-sy-actions">
              <button
                type="button"
                className="ns-btn btn-seal m2-sy-go"
                disabled={working}
                onClick={() =>
                  askConfirm({
                    title: "要改用桌機的版本嗎？",
                    body: "這台現有的車票與記錄會被桌機的版本取代；還沒送出的修改會先存檔。",
                    confirmLabel: "改用桌機的版本",
                    danger: true,
                    onConfirm: () => void adoptEpoch(),
                  })
                }
              >
                改用桌機的版本
              </button>
            </div>
          </div>
        )}

        {configured ? (
          /* ③ 已配對 */
          <>
            <div className="m2-block">
              <span className="m2-block-label">同步總開關</span>
              <div role="radiogroup" aria-label="同步總開關" className="m2-choices">
                {[true, false].map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    role="radio"
                    aria-checked={enabled === v}
                    disabled={working}
                    onClick={() => void setEnabled(v)}
                    className={"m2-choice" + (enabled === v ? " is-on" : "")}
                  >
                    <span className="m2-choice-label">{v ? "開" : "關"}</span>
                    <span className="m2-choice-note">
                      {/* 產品評審 S4：v1.1.2 手機會推了，「待上傳 N」關著時會一直長。
                          不講「會補」，主人會以為關掉那段時間在手機蓋的章不會過去（桌機那句一直都有）。 */}
                      {v
                        ? "開啟時每分鐘、回到前景與改動後兩秒各同步一次"
                        : "關著時這台不收也不送，本機的操作照舊；這段期間的修改會先排隊，開回來再一起送上去"}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="m2-block m2-sy-actions">
              <button
                type="button"
                className="ns-btn btn-seal m2-sy-go"
                disabled={working || !enabled || phase === "epoch_changed"}
                title={phase === "epoch_changed" ? "先處理上面的改正待ち" : undefined}
                onClick={() => void syncNow()}
              >
                {working ? "同步中…" : "立即同步"}
              </button>
            </div>

            {/* 評審 S5：重設本來與「立即同步」同列同尺寸，拇指誤觸的代價與桌機不對等
                （桌機把它獨立放在最底的 `.ns-bk-danger`）。手機沿同一結構：自成一塊、說明在上、鈕在下。 */}
            <div className="m2-block m2-sy-danger">
              <span className="m2-block-label">重設</span>
              <p className="m2-note">
                清掉這台的同步設定與憑證；這台的資料與雲端上的東西都不動。重設後要再用桌機的配對碼重新配對。
              </p>
              <div className="m2-sy-actions">
                <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={working} onClick={reset}>
                  重設這台的同步
                </button>
              </div>
            </div>
          </>
        ) : (
          /* ② 未配對 */
          <>
            <div className="m2-block">
              <span className="m2-block-label">配對碼</span>
              {/* D-1.1-6 甲：掃描是主路，貼上是退路——兩個都留在畫面上，不用切換分頁 */}
              <div className="m2-sy-actions m2-sy-scan-row">
                <button
                  type="button"
                  className="ns-btn btn-ghost m2-sy-go"
                  disabled={working || scanning || !!bridgeError}
                  onClick={() => void scanQr()}
                >
                  {scanning ? "掃描中…" : "掃描桌機的配對碼"}
                </button>
              </div>
              {scanHint && <p className="m2-note is-fail">{scanHint}</p>}
              <textarea
                className="m2-input m2-sy-code"
                rows={4}
                value={code}
                autoComplete="off"
                spellCheck={false}
                placeholder="貼上桌機的配對碼"
                onChange={(e) => setCode(e.target.value)}
                aria-label="配對碼"
              />
              <p className="m2-note">桌機〔設定 → 同步 → 顯示配對碼〕，複製過來貼在這裡。</p>
            </div>
            <div className="m2-block">
              <span className="m2-block-label">密語</span>
              <input
                ref={passRef}
                className="m2-input"
                type="password"
                value={passphrase}
                autoComplete="off"
                onChange={(e) => setPassphrase(e.target.value)}
                aria-label="密語"
              />
              <p className="m2-note">與桌機設定的那一句相同；密語不在配對碼裡，要親手打。</p>
            </div>
            {formError && (
              <p className="m2-note is-fail" role="alert">
                {formError}
              </p>
            )}
            <div className="m2-block m2-sy-actions">
              <button
                type="button"
                className="ns-btn btn-seal m2-sy-go"
                disabled={!canPair}
                onClick={() => void pair()}
              >
                {working ? "配對中…" : "配對並拉取"}
              </button>
            </div>
            <p className="m2-note">這台要是空的才能配對——配對會把桌機那邊的資料整份拉下來。</p>
          </>
        )}
      </section>
    </div>
  );
}
