/**
 * SyncTab——設定頁第四籤「同步」（v1.1.1 WP8）。
 *
 * 拍板依據：決策記錄〈v1.1 開工訪談拍板〉快問「設定頁『同步』分頁＋側欄狀態點＋總開關」、
 *           〈v1.1 Plan 草案拍板〉D-1.1-6（桌機 QR＋配對碼、手機親手輸密語）＋契約 §9.1。
 *
 * 版面（由上而下）：
 *   ① 狀態列 ＝ 未啟用／已關閉／運行中／停車中／信号待ち（`SYNC_PHASE_LABEL`）＋「上次同步 9/18 03:12」；
 *              停車中把原因寫在下一行（赭字）、信号待ち寫「請先更新較舊的那一台」；右側待上傳筆數 chip。
 *   ② 未啟用 ＝ R2 四欄＋密語兩次 → 「啟用同步（這台是正本）」
 *              （store 先拍 manual 備份，再 configure＋push，再顯示配對碼）
 *   ③ 已啟用 ＝ 總開關（開／關兩枚 `.ns-choice`）、「立即同步」、「顯示配對碼」（可複製文字）、
 *              「重設」（danger 確認在 store）
 *
 * 視覺紀律（c13：無原型，一個新形狀都不發明）：語彙全借 BackupTab 與覆蓋層——狀態列 `.ns-bk-status`／
 *   `.ns-bk-when`／`.ns-bk-err`、小標 `.techo-label`、說明 `.ns-note`、按鈕 `.btn-seal`／`.btn-ghost`＋`.ns-btn`、
 *   輸入 `.techo-input`、chip `.status`、兩枚選擇 `.ns-choice`。本籤自己的排版在 settings.css 檔尾的 WP8 區塊。
 *
 * 資料流：本檔不碰 repository，全走 `syncStore`；密語只活在這支的 local state，送出後即清空（不存、不上傳）。
 *
 * v1.1.2（契約 §6／§7／§9.1）補三件：
 *   ⑴ **QR 放回來**——手機端有掃描器了（barcode-scanner），配對碼不再是掃不了的密碼牆（v1.1.1 評審 S6 的解除條件）。
 *   ⑵ **表單的四欄說明＋「從精靈匯入」**（留置線二節 R2 表單體驗）：主人第一次填這四欄時看著四個
 *      英文標籤不知道去哪拿；精靈 `scripts/setup-r2.sh` 已經把值寫在 `%LOCALAPPDATA%/NextStop/r2.env`，
 *      一顆鈕讀進來就好（密語不在裡面，照樣要親手打兩次）。反灰鈕旁固定寫出「什麼填齊了才能按」。
 *   ⑶ **改正待ち**（桌機 replica 才會遇到；理論上只有沙盒）：狀態列下多一塊提示＋「改用桌機的版本」。
 */
import { useEffect, useId, useState } from "react";
import type { WizardEnv } from "../../data/syncRepository";
import { useSyncStore, SYNC_PHASE_LABEL, fmtSyncStamp } from "../../store/syncStore";
import { useUiStore } from "../../store/uiStore";
import "./settings.css";

export function SyncTab() {
  const status = useSyncStore((s) => s.status);
  const working = useSyncStore((s) => s.working);
  const bridgeError = useSyncStore((s) => s.bridgeError);
  const formError = useSyncStore((s) => s.formError);
  const pairingCode = useSyncStore((s) => s.pairingCode);
  const enablePrimary = useSyncStore((s) => s.enablePrimary);
  const syncNow = useSyncStore((s) => s.syncNow);
  const setEnabled = useSyncStore((s) => s.setEnabled);
  const reset = useSyncStore((s) => s.reset);
  const showPairingCode = useSyncStore((s) => s.showPairingCode);
  const hidePairingCode = useSyncStore((s) => s.hidePairingCode);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const adoptEpoch = useSyncStore((s) => s.adoptEpoch);
  const importWizardEnv = useSyncStore((s) => s.importWizardEnv);
  const askConfirm = useUiStore((s) => s.askConfirm);

  // 開籤就問一次狀態（純讀、可重入；沿 BackupTab 的 refreshList）——
  // 這樣即使 App.tsx 還沒接上 `boot()`（整合席的工），這一籤也讀得到現況。
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const phase = status?.phase ?? "off";
  const configured = !!status?.configured;

  return (
    <div className="ns-sync">
      {/* 橋接不通（command 尚未註冊／非 Tauri 環境）：整籤只說一句人話，不讓任何鈕假裝可以按 */}
      {bridgeError && (
        <p className="ns-note is-fail" role="alert">
          同步狀態讀不到——這個版本的桌機端還沒接上同步（{bridgeError}）。
        </p>
      )}

      {/* ① 狀態列 */}
      <section className="ns-bk-status">
        <div className="min-w-0">
          <span className="techo-label block mb-1">同步</span>
          <p className={`ns-bk-when${phase === "stopped" ? " is-fail" : ""}`}>
            {status || bridgeError ? SYNC_PHASE_LABEL[phase] : "讀取中…"}
          </p>
          <p className="ns-note ns-sy-when">
            {status?.last_sync_at ? `上次同步 ${fmtSyncStamp(status.last_sync_at)}` : "還沒同步過"}
          </p>
          {phase === "stopped" && status?.last_error && <p className="ns-bk-err">{status.last_error}</p>}
          {phase === "gated" && (
            <p className="ns-bk-err">
              桌機與手機的版本不一致
              {status?.remote_schema != null ? `（對方 schema ${status.remote_schema}）` : ""}
              ，請先更新較舊的那一台。
            </p>
          )}
          {/* 產品評審 S2／S5：這裡本來還有一句「桌機已還原並重設同步（新紀元 1789834555237）」。
              ⑴ 裸紀元號是內部識別碼，主人看了不知道要做什麼；⑵ 下面 ①ʹ 那一塊已經把同一件事
              講得更完整（還多了按鈕），同一個元件出現兩句、一處說「桌機」一處說「正本」更糟。
              手機版本來就只有一句——兩殼對齊，留下面那一塊。 */}
          {/* 產品評審 B1：上次重置另存了幾筆未送出的修改（常駐，不是一閃即逝的 toast） */}
          {status?.last_orphans && (
            <p className="ns-note ns-sy-orphans">
              上次重置另存 {status.last_orphans.count} 筆未送出的修改
              {status.last_orphans.at ? `（${fmtSyncStamp(status.last_orphans.at)}）` : ""}
              ：{status.last_orphans.path}
            </p>
          )}
        </div>
        {!!status?.pending_ops && (
          <span className="status ns-sy-pending" title="還沒推上雲端的變更筆數">
            待上傳 {status.pending_ops}
          </span>
        )}
      </section>

      {/* ①ʹ 改正待ち（v1.1.2 契約 §9.1）：停在原地等主人點頭，不推不拉。
          這台是副本才會遇到——桌機正本開紀元是自己開的，不會看到這一塊。 */}
      {phase === "epoch_changed" && (
        <section className="ns-sy-epoch">
          <span className="techo-label block mb-1">桌機已還原並重設同步</span>
          <p className="ns-note mb-2">
            正本從備份還原後，雲端上的同步資料重新開始了。這台要改用正本的版本；
            這台還沒送出的修改會先存成一份檔案（不會直接丟掉）。
          </p>
          <div className="ns-bk-actions">
            <button
              type="button"
              className="btn-seal ns-btn"
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
        </section>
      )}

      {configured ? (
        <EnabledSection
          enabled={!!status?.enabled}
          epochChanged={phase === "epoch_changed"}
          working={working}
          pairingCode={pairingCode}
          onSetEnabled={(v) => void setEnabled(v)}
          onSyncNow={() => void syncNow()}
          onShowCode={() => void showPairingCode()}
          onHideCode={hidePairingCode}
          onReset={reset}
        />
      ) : (
        <EnableForm
          working={working}
          disabled={!!bridgeError}
          error={formError}
          onSubmit={enablePrimary}
          onImport={importWizardEnv}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ② 未啟用：R2 四欄＋密語兩次
   ═══════════════════════════════════════════════════════════════════════ */

function EnableForm({
  working,
  disabled,
  error,
  onSubmit,
  onImport,
}: {
  working: boolean;
  disabled: boolean;
  error: string | null;
  onSubmit: (input: {
    endpoint: string;
    bucket: string;
    access_key_id: string;
    secret_access_key: string;
    passphrase: string;
  }) => Promise<void>;
  /** 「從精靈匯入」：讀 `%LOCALAPPDATA%/NextStop/r2.env`；null＝讀不到（人話已在 formError） */
  onImport: () => Promise<WizardEnv | null>;
}) {
  const id = useId();
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");

  const filled = endpoint.trim() && bucket.trim() && ak.trim() && sk.trim() && pass1.length >= 8;
  const matched = pass1.length > 0 && pass1 === pass2;
  const ready = !!filled && matched && !working && !disabled;

  const submit = async () => {
    if (!ready) return;
    await onSubmit({
      endpoint: endpoint.trim(),
      bucket: bucket.trim(),
      access_key_id: ak.trim(),
      secret_access_key: sk,
      passphrase: pass1,
    });
    // 密語不留在記憶體裡（憑證欄留著——啟用失敗時主人才不必重打一次）
    setPass1("");
    setPass2("");
  };

  const importFromWizard = async () => {
    const env = await onImport();
    if (!env) return; // 讀不到的人話由 store 放進 formError，就顯示在下面那行紅字
    setEndpoint(env.endpoint);
    setBucket(env.bucket);
    setAk(env.access_key_id);
    setSk(env.secret_access_key);
  };

  return (
    <section>
      <div className="ns-sy-head">
        <span className="techo-label">雲端（Cloudflare R2）</span>
        <button
          type="button"
          className="btn-ghost ns-btn ns-btn--sm"
          disabled={working || disabled}
          title="讀取 scripts/setup-r2.sh 存在本機的設定，填進下面四欄（密語不在裡面）"
          onClick={() => void importFromWizard()}
        >
          從精靈匯入
        </button>
      </div>
      {/* 留置線二節：主人第一次看到這四個英文標籤時，不知道值從哪來——先給一條路，再給四句說明 */}
      <p className="ns-note ns-sy-wizard">
        還沒有這些值？在專案目錄跑 <code>bash scripts/setup-r2.sh</code>，精靈會帶你在 Cloudflare
        建好 bucket 與 token 並存到本機；之後按「從精靈匯入」。
      </p>
      <div className="ns-sy-form">
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">endpoint</span>
          <input
            id={`${id}-endpoint`}
            className="techo-input ns-sy-input"
            value={endpoint}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://….r2.cloudflarestorage.com"
            onChange={(e) => setEndpoint(e.target.value)}
          />
          {/* 說明放在 label 內（`.ns-sy-field` 是 flex column）——放外面會各自變成格線的一格，跑到隔壁欄去 */}
          <span className="ns-note ns-sy-hint">
            <code>https://&lt;account_id&gt;.r2.cloudflarestorage.com</code>；account id 在 Cloudflare 後台 R2 › Overview 右側
          </span>
        </label>
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">bucket</span>
          <input
            id={`${id}-bucket`}
            className="techo-input ns-sy-input"
            value={bucket}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setBucket(e.target.value)}
          />
          <span className="ns-note ns-sy-hint">精靈建的 bucket 名（R2 › Overview 清單）</span>
        </label>
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">access key id</span>
          {/* 評審 N1：key id 不是機密（機密是下面那把 secret）。遮起來反而沒辦法確認有沒有貼對、
              有沒有多一個空白——這是手填四欄最容易出錯的一欄。 */}
          <input
            id={`${id}-ak`}
            className="techo-input ns-sy-input"
            type="text"
            value={ak}
            autoComplete="off"
            onChange={(e) => setAk(e.target.value)}
          />
          <span className="ns-note ns-sy-hint">R2 › Manage API tokens 建 token 時顯示</span>
        </label>
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">secret access key</span>
          <input
            id={`${id}-sk`}
            className="techo-input ns-sy-input"
            type="password"
            value={sk}
            autoComplete="off"
            onChange={(e) => setSk(e.target.value)}
          />
          <span className="ns-note ns-sy-hint">只在建 token 那一頁顯示一次；不見了就重建一把 token</span>
        </label>
      </div>

      <span className="techo-label block mb-1 mt-4">密語</span>
      <div className="ns-sy-form">
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">設定密語</span>
          <input
            id={`${id}-p1`}
            className="techo-input ns-sy-input"
            type="password"
            value={pass1}
            autoComplete="new-password"
            onChange={(e) => setPass1(e.target.value)}
          />
        </label>
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">再打一次</span>
          <input
            id={`${id}-p2`}
            className="techo-input ns-sy-input"
            type="password"
            value={pass2}
            autoComplete="new-password"
            onChange={(e) => setPass2(e.target.value)}
          />
        </label>
      </div>
      <p className="ns-note mt-2">
        {/* 評審 S2：密語本身確實不存，但由它派生出來的金鑰會進這台的鑰匙圈——別把話說得比實情更滿 */}
        密語不會上雲；這台只留下由它算出的金鑰，忘了密語就得重新配對。手機配對時要親手打同一句。
      </p>
      {pass1.length > 0 && pass1.length < 8 && <p className="ns-note is-fail">密語至少 8 個字。</p>}
      {pass2.length > 0 && !matched && <p className="ns-note is-fail">兩次打的密語不一樣。</p>}
      {error && (
        <p className="ns-bk-err" role="alert">
          {error}
        </p>
      )}

      <div className="ns-bk-actions mt-3">
        <button
          type="button"
          className="btn-seal ns-btn"
          disabled={!ready}
          title="會先自動備份一份，再把現在的資料加密上傳到 R2。"
          onClick={() => void submit()}
        >
          {working ? "啟用中…" : "啟用同步（這台是正本）"}
        </button>
        {/* 留置線二節：「按鈕反灰讓人以為壞了」——把條件寫在鈕旁邊，不讓人猜 */}
        {!ready && !working && <span className="ns-note">四欄與密語（兩次相同、至少 8 字）都填好才能啟用。</span>}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ③ 已啟用：總開關／立即同步／配對碼／重設
   ═══════════════════════════════════════════════════════════════════════ */

function EnabledSection({
  enabled,
  epochChanged,
  working,
  pairingCode,
  onSetEnabled,
  onSyncNow,
  onShowCode,
  onHideCode,
  onReset,
}: {
  enabled: boolean;
  /** 改正待ち：這台等主人確認「以桌機版本重置」，這段期間不推不拉（「立即同步」也按不動） */
  epochChanged: boolean;
  working: boolean;
  pairingCode: string | null;
  onSetEnabled: (v: boolean) => void;
  onSyncNow: () => void;
  onShowCode: () => void;
  onHideCode: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <section>
        <span className="techo-label block mb-2.5">同步總開關</span>
        <div role="radiogroup" aria-label="同步總開關" className="flex flex-wrap items-center gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={enabled === v}
              disabled={working}
              onClick={() => onSetEnabled(v)}
              className={`ns-choice${enabled === v ? " is-on" : ""}`}
            >
              {v ? "開" : "關"}
            </button>
          ))}
        </div>
        {/* 評審 B1：關著＝只停網路。變更照樣排隊（「待上傳 N」會繼續長），開回來就補送——
            文案要說出「會補」，不然主人會以為關掉那段時間的修改也會過去（或不會過去）。 */}
        <p className="ns-note mt-2">
          關著的時候這台不推也不拉，本機的操作照舊；這段期間的修改會先排隊，開回來再一起送上去。
        </p>
      </section>

      <section className="ns-bk-actions">
        <button
          type="button"
          className="btn-seal ns-btn"
          disabled={working || !enabled || epochChanged}
          title={epochChanged ? "先處理上面的改正待ち" : undefined}
          onClick={onSyncNow}
        >
          {working ? "同步中…" : "立即同步"}
        </button>
        <button
          type="button"
          className="btn-ghost ns-btn"
          onClick={() => (pairingCode ? onHideCode() : onShowCode())}
        >
          {pairingCode ? "收起配對碼" : "顯示配對碼"}
        </button>
      </section>

      {pairingCode && <PairingCodeBlock code={pairingCode} />}

      <section className="ns-bk-danger">
        <span className="techo-label block mb-1">重設</span>
        {/* 評審 S4：重設後再啟用＝新 epoch，手機還盯著舊前綴會靜默失聯（偵測留 v1.1.2） */}
        <p className="ns-note mb-2">
          清掉這台的同步設定與憑證——資料與雲端上的東西都不會動。之後若再啟用，手機要重新配對。
        </p>
        <div className="ns-bk-actions">
          <button type="button" className="btn-ghost ns-btn ns-btn-danger" disabled={working} onClick={onReset}>
            重設這台的同步
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * 配對碼：QR ＋可複製文字。
 *
 * QR 在 v1.1.1 被拿掉（評審 S6：手機端沒有掃描器，畫出來只是一面掃不了的密碼牆）；
 * v1.1.2 手機端接上 barcode-scanner（D-1.1-6 甲），解除條件成立 ⇒ 放回來。
 * `qrcode` 用動態 import：沒按「顯示配對碼」的人不必下載那段 chunk。畫不出來就只留文字（掃不到本來就有退路）。
 * 這段 base64 裡有 R2 的 access key／secret（沒有密語），所以文案要明白說「用信得過的管道送、送完刪掉」。
 */
function PairingCodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const showToast = useUiStore((s) => s.showToast);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const svg = await (await import("qrcode")).toString(code, { type: "svg", margin: 1 });
        if (alive) setQr(svg);
      } catch {
        if (alive) setQr(null); // 畫不出來就只留文字＋複製鈕
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast({ message: "複製不了——請手動選取下面那段文字" });
    }
  };

  return (
    <section className="ns-sy-pair">
      <span className="techo-label block mb-1">配對碼</span>
      <p className="ns-note mb-2">
        在手機的「更多 → 同步」按「掃描桌機的配對碼」對著左邊這格掃，或把這段貼過去；兩種都要再打一次密語。
        這段含雲端憑證、不含密語——
        複製後請用你信得過的管道送到手機，貼完把那則訊息刪掉；萬一外流，到 Cloudflare 後台撤銷 token 即可。
      </p>
      <div className="ns-sy-pair-body">
        {/* 手機「更多 → 同步 → 掃描桌機的配對碼」對著這一格掃 */}
        {qr && <div className="ns-sy-qr" aria-label="配對碼 QR" dangerouslySetInnerHTML={{ __html: qr }} />}
        <div className="ns-sy-pair-text">
          <textarea className="techo-input ns-sy-code" readOnly rows={4} value={code} aria-label="配對碼" />
          <div className="ns-bk-actions mt-2">
            <button type="button" className="btn-ghost ns-btn ns-btn--sm" onClick={() => void copy()}>
              {copied ? "已複製" : "複製"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
