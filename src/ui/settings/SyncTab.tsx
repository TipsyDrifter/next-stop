/**
 * SyncTab——設定頁第四籤「同步」（v1.1.1 WP8 立；v1.1.3 契約席起骨架、**WP-C 落文案與版面**）。
 *
 * 拍板依據：決策記錄〈同步與備份規則重整拍板〉三條規則（①加入 ②還原 ③重新加入）＋密語可改；
 *           《2026-09-21-v1.1.3-同步規則重整契約.md》§8（文案）／§4（store 動作）。
 *
 * 版面（由上而下）：
 *   ① 狀態列 ＝ 未加入／已關閉／運行中／停車中／信号待ち／改正待ち／鍵違い（`SYNC_PHASE_LABEL`）＋「上次同步」；
 *              停車中把原因寫在下一行、鍵違い寫出路（重新加入同步）；右側待上傳筆數 chip。
 *   ①ʹ 改正待ち ＝ 另一台從備份「回到過去」——說明（誰、何時、哪份備份、這台未送出幾筆與時間跨度）＋「改用那份」。
 *   ①″ 兩邊都有資料（`pendingChoice`）＝ 頁內二選一「兩邊都保留」／「改用另一台的」（**不擴充確認窗**，契約 §1）。
 *   ② 未加入 ＝ 加入表單：四欄（＋從精靈匯入、貼上配對碼填欄）＋密語兩次＋（DEV 才露出的）root → 「加入同步」。
 *   ③ 已加入 ＝ 總開關、「立即同步」、「顯示配對碼」、密語（改密語／升級後第一次封存）、「重新加入同步」。
 *
 * v1.1.4（WP-C；契約 §7）加了三處，都掛在既有的形狀上、沒有新版面：
 *   ① 狀態列多兩行——「換鑰匙中」的說明（`PASSPHRASE_ROTATE.inProgress`，金色左緣＝這台自己在忙，
 *      不是等人處理）與「跳過筆數」（`describeSkipped`；`skipped_missing_total > 0` 才出現）；
 *      鍵違い那一行由 `describeLocked` 分流成「另一台換過鑰匙」／「殘留」兩種字。
 *   ③ 密語多一格勾選「同時換掉資料鑰匙」（D-3）：勾了＝真撤銷，現密語從「可留白」變必填、
 *      鈕字改「改密語並換鑰匙」、警告文長出來；換鑰匙進行中（phase=rotating）整段鎖住。
 *   雲端備份區不在本籤——它住〈備份與還原〉籤的「④ʹ 雲端」（D-2 兩殼同一個 `CloudSnapshots`）。
 *
 * 為什麼問二選一時表單只是 `hidden` 而不是不渲染（WP-C）：主人按「取消」要回到剛才那張填好的表——
 *   元件被拆掉的話四欄與密語全部清空，等於逼他重打一次憑證。`hidden` 讓 React 保住 local state。
 *
 * 退場的字（契約 §8.7）：「啟用同步（這台是正本）」「要改用桌機的版本嗎？」「桌機已還原並重設同步」「手機要重新配對」。
 * 視覺紀律（c13）：語彙全借 BackupTab 與覆蓋層，本籤自己的排版在 settings.css 檔尾的 WP8 區塊。
 * 資料流：本檔不碰 repository，全走 `syncStore`；密語只活在這支的 local state，送出後即清空（不存、不上傳）。
 */
import { useEffect, useId, useState } from "react";
import type { JoinInput, JoinReport, PairingFields, SyncStatus, WizardEnv } from "../../data/syncRepository";
import {
  useSyncStore,
  SYNC_PHASE_LABEL,
  PASSPHRASE_ROTATE,
  REJOIN_ROTATED,
  JOIN_CHOICE_TEXT,
  fmtSyncStamp,
  describeEpochChange,
  describeLocked,
  describeSkipped,
} from "../../store/syncStore";
import { useUiStore } from "../../store/uiStore";
import "./settings.css";

export function SyncTab() {
  const status = useSyncStore((s) => s.status);
  const working = useSyncStore((s) => s.working);
  const bridgeError = useSyncStore((s) => s.bridgeError);
  const formError = useSyncStore((s) => s.formError);
  const pairingCode = useSyncStore((s) => s.pairingCode);
  const pendingChoice = useSyncStore((s) => s.pendingChoice);
  const join = useSyncStore((s) => s.join);
  const joinWith = useSyncStore((s) => s.joinWith);
  const cancelChoice = useSyncStore((s) => s.cancelChoice);
  const changePassphrase = useSyncStore((s) => s.changePassphrase);
  const syncNow = useSyncStore((s) => s.syncNow);
  const setEnabled = useSyncStore((s) => s.setEnabled);
  const reset = useSyncStore((s) => s.reset);
  const rejoin = useSyncStore((s) => s.rejoin);
  const showPairingCode = useSyncStore((s) => s.showPairingCode);
  const hidePairingCode = useSyncStore((s) => s.hidePairingCode);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const adoptEpoch = useSyncStore((s) => s.adoptEpoch);
  const importWizardEnv = useSyncStore((s) => s.importWizardEnv);
  const decodePairingCode = useSyncStore((s) => s.decodePairingCode);
  const askConfirm = useUiStore((s) => s.askConfirm);

  // 開籤就問一次狀態（純讀、可重入；沿 BackupTab 的 refreshList）
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const phase = status?.phase ?? "off";
  const configured = !!status?.configured;
  /**
   * 工程評審 B-1：這顆 DB 記得自己加入過、卻讀不到鑰匙圈（Windows 認證管理員一時打不開）。
   * 此時**不准**露出「加入同步」表單——主人按下去就會生一個新身分、把整包資料再推一份上雲。
   */
  const keyringUnreadable = !configured && !!status?.joined && !!status?.last_error;
  /**
   * 產品評審 B1：已加入狀態下重填四欄。換 R2 token（或把外流的 token 撤銷）之後，
   * 舊碼唯一的路是「重新加入同步」——那會連身分一起清掉、重接判定永遠不成立、
   * 於是每一台都被逼進「兩邊都有資料」＋全庫重推。這顆鈕走的是同一支 `join`，
   * 但因為鑰匙圈與 `joined`／`epoch` 都還在，Rust 會判成「重接」：只更新憑證，資料一個字不動。
   */
  const [updatingCreds, setUpdatingCreds] = useState(false);
  const credsRejected = phase === "stopped" && !!status?.last_error?.includes("拒絕了這組金鑰");

  return (
    <div className="ns-sync">
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
              兩台的版本不一致
              {status?.remote_schema != null ? `（對方 schema ${status.remote_schema}）` : ""}
              ，請先更新較舊的那一台。
            </p>
          )}
          {phase === "locked" && status && <p className="ns-bk-err">{describeLocked(status)}</p>}
          {/* v1.1.4 契約 §7：換鑰匙中（boot／每 60 秒續跑）與跳過筆數那一行（>0 才出現）。
              換鑰匙不是故障也不是等人處理（狀態點是金的慢閃，不是朱），所以這行是 `.ns-note` 不是 `.ns-bk-err`；
              只多一道金色左緣把「這台正在忙」與旁邊的常駐小字分開。 */}
          {phase === "rotating" && <p className="ns-note ns-sy-rotating">{PASSPHRASE_ROTATE.inProgress}</p>}
          {!!status?.skipped_missing_total && <p className="ns-note ns-sy-orphans">{describeSkipped(status.skipped_missing_total)}</p>}
          {status?.last_orphans && (
            <p className="ns-note ns-sy-orphans">
              上次改用另一份時另存 {status.last_orphans.count} 筆未送出的修改
              {status.last_orphans.at ? `（${fmtSyncStamp(status.last_orphans.at)}）` : ""}
              ：{status.last_orphans.path}
            </p>
          )}
          {status?.last_export && (
            <p className="ns-note ns-sy-orphans">
              上次改用另一台之前，這台的全部資料另存於 {status.last_export.path}
              {status.last_export.at ? `（${fmtSyncStamp(status.last_export.at)}）` : ""}
            </p>
          )}
        </div>
        {!!status?.pending_ops && (
          <span className="status ns-sy-pending" title="還沒推上雲端的變更筆數">
            待上傳 {status.pending_ops}
          </span>
        )}
      </section>

      {/* ①ᵃ v1.1.4 修正席（產品評審 B1）：鍵違い（rotated）唯一走得通的那條路，就放在講那句話的正下方。
          形狀沿改正待ち那一塊（說明＋一顆主鈕），差別只在多一格密語。 */}
      {phase === "locked" && status?.locked_reason === "rotated" && !pendingChoice && (
        <RejoinRotatedSection working={working} error={formError} onSubmit={rejoin} />
      )}

      {/* ①ʹ 改正待ち（契約 §8.4）：另一台「回到過去」，這台停在原地等主人點頭 */}
      {phase === "epoch_changed" && status && (
        <section className="ns-sy-epoch">
          <span className="techo-label block mb-1">另一台裝置從備份還原了</span>
          <p className="ns-note mb-2">{describeEpochChange(status)}</p>
          <div className="ns-bk-actions">
            <button
              type="button"
              className="btn-seal ns-btn"
              disabled={working}
              onClick={() =>
                askConfirm({
                  title: "要改用那份嗎？",
                  body: JOIN_CHOICE_TEXT.adoptEpochBody("desktop"),
                  confirmLabel: "改用那份",
                  danger: true,
                  onConfirm: () => void adoptEpoch(),
                })
              }
            >
              改用那份
            </button>
          </div>
        </section>
      )}

      {/* ①″ 兩邊都有資料（契約 §8.2）：頁內二選一，不是確認窗 */}
      {pendingChoice && (
        <ChoiceBlock
          report={pendingChoice}
          working={working}
          error={formError}
          onMerge={() => void joinWith("merge")}
          onAdopt={() => void joinWith("adopt_remote")}
          onCancel={cancelChoice}
        />
      )}

      {configured ? (
        updatingCreds ? (
          <JoinForm
            purpose="credentials"
            hidden={!!pendingChoice}
            working={working}
            disabled={!!bridgeError}
            error={pendingChoice ? null : formError}
            onSubmit={async (input) => {
              await join(input);
              // 成功（含重接）就把表單收起來；失敗時 formError 有字，留在原地讓主人改
              if (!useSyncStore.getState().formError) setUpdatingCreds(false);
            }}
            onImport={importWizardEnv}
            onDecode={decodePairingCode}
            onCancel={() => setUpdatingCreds(false)}
          />
        ) : (
          <EnabledSection
            status={status}
            working={working}
            pairingCode={pairingCode}
            formError={formError}
            credsRejected={credsRejected}
            onSetEnabled={(v) => void setEnabled(v)}
            onSyncNow={() => void syncNow()}
            onShowCode={() => void showPairingCode()}
            onHideCode={hidePairingCode}
            onChangePassphrase={changePassphrase}
            onUpdateCredentials={() => setUpdatingCreds(true)}
            onReset={reset}
          />
        )
      ) : keyringUnreadable ? (
        /* 工程評審 B-1：讀不到鑰匙圈 ≠ 沒加入。這裡不給表單，只給一句人話與「再看一次」 */
        <section className="ns-sy-epoch">
          <span className="techo-label block mb-1">讀不到這台的同步身分</span>
          <p className="ns-note mb-2">
            這台加入過同步，但這次打不開系統憑證庫，所以暫時停在這裡。<b>先不要重新加入</b>——
            重新加入會把這台當成新的一台、整份資料再上傳一次。多半重新啟動私鐵手帳就好了。
          </p>
          <div className="ns-bk-actions">
            <button type="button" className="btn-seal ns-btn" disabled={working} onClick={() => void refreshStatus()}>
              再看一次
            </button>
          </div>
        </section>
      ) : (
        <JoinForm
          hidden={!!pendingChoice}
          working={working}
          disabled={!!bridgeError}
          error={pendingChoice ? null : formError}
          onSubmit={join}
          onImport={importWizardEnv}
          onDecode={decodePairingCode}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ② 未加入：加入表單（契約 §8.1）
   ═══════════════════════════════════════════════════════════════════════ */

function JoinForm({
  purpose = "join",
  hidden,
  working,
  disabled,
  error,
  onSubmit,
  onImport,
  onDecode,
  onCancel,
}: {
  /**
   * `join`＝還沒加入，這是「加入同步」；`credentials`＝已加入，只是換一組 R2 token（產品評審 B1）。
   * 兩者走的是同一支 `sync_join`：鑰匙圈與紀元都還在時 Rust 判成「重接」，只更新憑證、不動資料。
   * 差別只在字與「新密語要打兩次／現有密語打一次」。
   */
  purpose?: "join" | "credentials";
  /** 問「兩邊都有資料」時把整張表藏起來但**不拆掉**：按「取消」要回到剛才填好的那一張 */
  hidden: boolean;
  working: boolean;
  disabled: boolean;
  error: string | null;
  onSubmit: (input: JoinInput) => Promise<void>;
  /** 「從精靈匯入」：讀 `%LOCALAPPDATA%/NextStop/r2.env`；null＝讀不到（人話已在 formError） */
  onImport: () => Promise<WizardEnv | null>;
  /** 「貼上配對碼」→ 四欄；null＝解不開（人話已在 formError） */
  onDecode: (code: string) => Promise<PairingFields | null>;
  /** `credentials` 才有：收起表單回到已加入的樣子 */
  onCancel?: () => void;
}) {
  const updating = purpose === "credentials";
  const id = useId();
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [root, setRoot] = useState("");
  const [code, setCode] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  /** 四欄是從哪來的（契約 §8.1 的「已從配對碼填入…」摘要）；主人一動欄位就撤掉那句 */
  const [filledFrom, setFilledFrom] = useState<"code" | "wizard" | null>(null);

  // 更新憑證時那句密語是**現有的**（不是新設的）：只打一次、不套 8 字下限（它早就存在了）
  const passOk = updating ? pass1.length > 0 : pass1.length >= 8;
  const filled = endpoint.trim() && bucket.trim() && ak.trim() && sk.trim() && passOk;
  const matched = updating || (pass1.length > 0 && pass1 === pass2);
  const ready = !!filled && matched && !working && !disabled;

  const submit = async () => {
    if (!ready) return;
    await onSubmit({
      endpoint: endpoint.trim(),
      bucket: bucket.trim(),
      access_key_id: ak.trim(),
      secret_access_key: sk,
      passphrase: pass1,
      root: root.trim() || undefined,
    });
    // 密語不留在記憶體裡（憑證欄留著——加入失敗時主人才不必重打一次）
    setPass1("");
    setPass2("");
  };

  const fill = (
    f: { endpoint: string; bucket: string; access_key_id: string; secret_access_key: string; root?: string },
    from: "code" | "wizard",
  ) => {
    setEndpoint(f.endpoint);
    setBucket(f.bucket);
    setAk(f.access_key_id);
    setSk(f.secret_access_key);
    if (f.root && f.root !== "v1") setRoot(f.root);
    setFilledFrom(from);
  };

  /** 手打就把「已從…填入」那句撤掉（它講的是來源，改過之後就不再為真） */
  const typed = (set: (v: string) => void) => (v: string) => {
    setFilledFrom(null);
    set(v);
  };

  const importFromWizard = async () => {
    const env = await onImport();
    if (env) fill(env, "wizard");
  };

  const fillFromCode = async () => {
    const f = await onDecode(code);
    if (f) {
      fill(f, "code");
      setCode("");
    }
  };

  return (
    <section hidden={hidden}>
      <div className="ns-sy-head">
        <span className="techo-label">{updating ? "更新憑證" : "加入同步"}</span>
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
      {updating ? (
        <p className="ns-note ns-sy-wizard">
          在 Cloudflare 換了一把新的 API token（或把舊的撤銷了）就填這裡：四欄換新、密語打<b>現在這一句</b>。
          資料、身分與紀元都不會動，其他裝置不受影響——它們各自也要來這裡更新一次。
        </p>
      ) : (
        <p className="ns-note ns-sy-wizard">
          還沒有這些值？在專案目錄跑 <code>bash scripts/setup-r2.sh</code>，精靈會帶你在 Cloudflare
          建好 bucket 與 token 並存到本機；之後按「從精靈匯入」。已經有另一台在同步？把它的配對碼貼在下面，四欄就填好了。
        </p>
      )}

      {/* 貼上配對碼＝省手打的便利（契約 §4.6）：只填欄，密語照樣要打 */}
      <div className="ns-sy-form">
        <label className="ns-sy-field ns-sy-field--wide">
          <span className="ns-sy-field-label">貼上配對碼（可略）</span>
          <textarea
            className="techo-input ns-sy-code"
            rows={2}
            value={code}
            spellCheck={false}
            placeholder="另一台〔設定 → 同步 → 顯示配對碼〕複製過來"
            onChange={(e) => setCode(e.target.value)}
          />
          <span className="ns-bk-actions mt-1">
            <button
              type="button"
              className="btn-ghost ns-btn ns-btn--sm"
              disabled={!code.trim() || working || disabled}
              onClick={() => void fillFromCode()}
            >
              填入四欄
            </button>
          </span>
        </label>
      </div>

      {/* 來源摘要（契約 §8.1）：四欄照樣攤在下面可以直接改——桌機有位子，不必再多一顆「展開」 */}
      {filledFrom && (
        <p className="ns-note ns-sy-filled">
          已從{filledFrom === "code" ? "配對碼" : "精靈"}填入（{bucket || "—"}／{endpoint || "—"}）——下面四欄可以直接改；
          密語不在裡面，要親手打。
        </p>
      )}

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
            onChange={(e) => typed(setEndpoint)(e.target.value)}
          />
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
            onChange={(e) => typed(setBucket)(e.target.value)}
          />
          <span className="ns-note ns-sy-hint">精靈建的 bucket 名（R2 › Overview 清單）</span>
        </label>
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">access key id</span>
          <input
            id={`${id}-ak`}
            className="techo-input ns-sy-input"
            type="text"
            value={ak}
            autoComplete="off"
            onChange={(e) => typed(setAk)(e.target.value)}
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
            onChange={(e) => typed(setSk)(e.target.value)}
          />
          <span className="ns-note ns-sy-hint">只在建 token 那一頁顯示一次；不見了就重建一把 token</span>
        </label>
        {/* 沙盒用的桶內根前綴（契約 §2）：正式版不露出 */}
        {import.meta.env.DEV && (
          <label className="ns-sy-field">
            <span className="ns-sy-field-label">root（沙盒；可略）</span>
            <input
              id={`${id}-root`}
              className="techo-input ns-sy-input"
              value={root}
              autoComplete="off"
              spellCheck={false}
              placeholder="v1"
              onChange={(e) => setRoot(e.target.value)}
            />
          </label>
        )}
      </div>

      <span className="techo-label block mb-1 mt-4">密語</span>
      <div className="ns-sy-form">
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">{updating ? "現在的密語" : "密語"}</span>
          <input
            id={`${id}-p1`}
            className="techo-input ns-sy-input"
            type="password"
            value={pass1}
            autoComplete={updating ? "current-password" : "new-password"}
            onChange={(e) => setPass1(e.target.value)}
          />
        </label>
        {!updating && (
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
        )}
      </div>
      <p className="ns-note mt-2">
        {updating
          ? "密語沒有換、也不會上雲——這裡打它只是用來打開雲端上那把鑰匙。"
          : "第一台加入時這句就是密語；其他裝置加入要打同一句。密語不會上雲，之後可以改，改了也不用重傳資料。"}
      </p>
      {!updating && pass1.length > 0 && pass1.length < 8 && <p className="ns-note is-fail">密語至少 8 個字。</p>}
      {!updating && pass2.length > 0 && !matched && <p className="ns-note is-fail">兩次打的密語不一樣。</p>}
      {error && (
        <p className="ns-bk-err" role="alert">
          {error}
        </p>
      )}

      <div className="ns-bk-actions mt-3">
        <button type="button" className="btn-seal ns-btn" disabled={!ready} onClick={() => void submit()}>
          {working ? (updating ? "更新中…" : "加入中…") : updating ? "更新憑證" : "加入同步"}
        </button>
        {updating && onCancel && (
          <button type="button" className="btn-ghost ns-btn ns-btn--sm" disabled={working} onClick={onCancel}>
            取消
          </button>
        )}
        {!ready && !working && (
          <span className="ns-note">
            {updating ? "四欄與現在的密語都填好才能更新。" : "四欄與密語（兩次相同、至少 8 字）都填好才能加入。"}
          </span>
        )}
      </div>
      {!updating && (
        <p className="ns-note mt-2">
          雲端是空的→這台成為第一台；雲端有資料而這台是空的→直接拉下來；兩邊都有資料→會問你一次。
        </p>
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ①″ 兩邊都有資料：頁內二選一（契約 §8.2）
   ═══════════════════════════════════════════════════════════════════════ */

function ChoiceBlock({
  report,
  working,
  error,
  onMerge,
  onAdopt,
  onCancel,
}: {
  report: JoinReport;
  working: boolean;
  error: string | null;
  onMerge: () => void;
  onAdopt: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="ns-sy-epoch">
      <span className="techo-label block mb-1">兩邊都有資料</span>
      {/* v1.1.4 修正席（產品評審 S4）：這三句與手機同源（`JOIN_CHOICE_TEXT`），不再各寫一份 */}
      <p className="ns-note mb-2">{JOIN_CHOICE_TEXT.lead(report.remote_devices, report.local_alive)}</p>
      {error && (
        <p className="ns-bk-err" role="alert">
          {error}
        </p>
      )}
      <div className="ns-bk-actions">
        <button type="button" className="btn-seal ns-btn" disabled={working} onClick={onMerge}>
          {working ? "處理中…" : JOIN_CHOICE_TEXT.merge}
        </button>
        <span className="ns-note">同一張票以較晚改的為準，被蓋掉的值記進該車票的乘務記錄。</span>
      </div>
      <div className="ns-bk-actions mt-2">
        <button type="button" className="btn-ghost ns-btn ns-btn-danger" disabled={working} onClick={onAdopt}>
          {JOIN_CHOICE_TEXT.adopt}
        </button>
        <span className="ns-note">{JOIN_CHOICE_TEXT.adoptNote("desktop")}</span>
      </div>
      <div className="ns-bk-actions mt-2">
        <button type="button" className="btn-ghost ns-btn ns-btn--sm" disabled={working} onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ①ᵃ 鍵違い（rotated）：用新密語重新加入（v1.1.4 修正席／產品評審 B1；字在 `REJOIN_ROTATED`，兩殼同一份）
   ═══════════════════════════════════════════════════════════════════════ */

function RejoinRotatedSection({
  working,
  error,
  onSubmit,
}: {
  working: boolean;
  error: string | null;
  onSubmit: (passphrase: string) => Promise<void>;
}) {
  const [pass, setPass] = useState("");
  const ready = pass.trim().length > 0 && !working;
  return (
    <section className="ns-sy-epoch">
      <span className="techo-label block mb-1">{REJOIN_ROTATED.title}</span>
      <p className="ns-note mb-2">{REJOIN_ROTATED.note}</p>
      <input
        type="password"
        className="techo-input ns-sy-input mb-2"
        autoComplete="off"
        placeholder={REJOIN_ROTATED.placeholder}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ready) {
            const p = pass;
            setPass("");
            void onSubmit(p);
          }
        }}
      />
      {error && (
        <p className="ns-bk-err" role="alert">
          {error}
        </p>
      )}
      <div className="ns-bk-actions">
        <button
          type="button"
          className="btn-seal ns-btn"
          disabled={!ready}
          onClick={() => {
            const p = pass;
            setPass("");
            void onSubmit(p);
          }}
        >
          {working ? "處理中…" : REJOIN_ROTATED.submit}
        </button>
        <span className="ns-note">{REJOIN_ROTATED.credsHint}</span>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ③ 已加入：總開關／立即同步／配對碼／密語／重設
   ═══════════════════════════════════════════════════════════════════════ */

function EnabledSection({
  status,
  working,
  pairingCode,
  formError,
  credsRejected,
  onSetEnabled,
  onSyncNow,
  onShowCode,
  onHideCode,
  onChangePassphrase,
  onUpdateCredentials,
  onReset,
}: {
  status: SyncStatus | null;
  working: boolean;
  pairingCode: string | null;
  formError: string | null;
  /** 停車中且原因是「雲端拒絕了這組金鑰」＝多半換過 token ⇒「更新憑證…」升為主鈕 */
  credsRejected: boolean;
  onSetEnabled: (v: boolean) => void;
  onSyncNow: () => void;
  onShowCode: () => void;
  onHideCode: () => void;
  onChangePassphrase: (current: string, next: string, rotate?: boolean) => Promise<boolean>;
  onUpdateCredentials: () => void;
  onReset: () => void;
}) {
  const enabled = !!status?.enabled;
  const phase = status?.phase ?? "off";
  const blocked = phase === "epoch_changed" || phase === "locked" || phase === "rotating";
  const rotatedLocked = phase === "locked" && status?.locked_reason === "rotated";
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
        <p className="ns-note mt-2">
          關著的時候這台不推也不拉，本機的操作照舊；這段期間的修改會先排隊，開回來再一起送上去。
        </p>
      </section>

      <section className="ns-bk-actions">
        <button
          type="button"
          className="btn-seal ns-btn"
          disabled={working || !enabled || blocked}
          title={phase === "epoch_changed" ? "先處理上面的改正待ち" : phase === "locked" ? "先重新加入同步" : undefined}
          onClick={onSyncNow}
        >
          {working ? "同步中…" : "立即同步"}
        </button>
        <button type="button" className="btn-ghost ns-btn" onClick={() => (pairingCode ? onHideCode() : onShowCode())}>
          {pairingCode ? "收起配對碼" : "顯示配對碼"}
        </button>
        {/* 產品評審 B1：換 token／撤銷 token 之後唯一到得了的路。原因是金鑰被拒時升為主鈕。
            v1.1.4 修正席：**鍵違い（rotated）時收起來**——它的表單寫「密語打現在這一句、資料身分紀元
            都不會動」，在那一態打舊密語會「密語不對」、打新密語卻跳出「兩邊都有資料」問合併，自相矛盾。
            那一態該走的是狀態列下面那一塊「用新密語重新加入」。 */}
        {!rotatedLocked && (
          <button
            type="button"
            className={`${credsRejected ? "btn-seal" : "btn-ghost"} ns-btn`}
            disabled={working}
            title="在 Cloudflare 換了新 token 就用這個換掉四欄；資料與身分不動，不必重新加入"
            onClick={onUpdateCredentials}
          >
            更新憑證…
          </button>
        )}
      </section>

      {pairingCode && <PairingCodeBlock code={pairingCode} />}

      <PassphraseSection
        keySealed={status?.key_sealed ?? null}
        working={working}
        /** 換鑰匙中＝七步還沒走完（boot／每 60 秒續跑）：這時再送一次改密語只會被 Rust 擋，先在這裡就鎖住 */
        rotating={phase === "rotating"}
        error={formError}
        onSubmit={onChangePassphrase}
      />

      {/* ③ 重新加入（提案規則③）＝把這台拿掉再放回去。按下去只做「拿掉」那一半，
          表單當場長回來、主人填完就是「放回去」——所以鈕上的字寫整件事，不寫半件。 */}
      <section className="ns-bk-danger">
        <span className="techo-label block mb-1">重新加入</span>
        <p className="ns-note mb-2">
          清掉這台的同步設定、憑證與身分——資料與雲端上的東西都不動。清掉之後這一籤會回到「加入同步」，
          重問一次（兩邊都有資料時會問要不要合併）。
        </p>
        <div className="ns-bk-actions">
          <button type="button" className="btn-ghost ns-btn ns-btn-danger" disabled={working} onClick={onReset}>
            重新加入同步
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * 密語（契約 §8.6；v1.1.4 契約 §7.3 加「同時換掉資料鑰匙」）。
 * 不勾＝現行「只重包雲端上那顆鑰匙」（毫秒級、其他裝置不受影響）；
 * 勾了＝換一把資料鑰匙、開新紀元、重加密雲端快照、刪掉舊紀元＝**舊密語真的失效**（D-3）。
 */
function PassphraseSection({
  keySealed,
  working,
  rotating,
  error,
  onSubmit,
}: {
  keySealed: boolean | null;
  working: boolean;
  /** phase='rotating'：上一次換鑰匙還沒走完，整段鎖住（Rust 也會擋，這裡先擋是為了不讓主人白打一次密語） */
  rotating: boolean;
  error: string | null;
  onSubmit: (current: string, next: string, rotate?: boolean) => Promise<boolean>;
}) {
  const id = useId();
  const [current, setCurrent] = useState("");
  const [next1, setNext1] = useState("");
  const [next2, setNext2] = useState("");
  // v1.1.4 D-3（Bitwarden 式）：預設不勾＝現行只重包 KEY；勾了＝換資料鑰匙開新紀元（真撤銷），現密語變必填
  const [rotate, setRotate] = useState(false);
  /** 「現在的密語」那一格碰過了沒（產品評審 Nice：紅字等 blur 再出現） */
  const [curTouched, setCurTouched] = useState(false);
  const matched = next1.length >= 8 && next1 === next2;
  // 產品評審 B4：**現密語可留白**。資料鑰匙本來就在這台的鑰匙圈裡，重包雲端那顆 KEY 用不到舊密語；
  // 舊碼那道檢查擋不住任何能解鎖這台桌機的人（他早就能匯出整顆 DB），卻讓「忘了密語」在 App 內零出口。
  // 勾了換鑰匙就不一樣了：那是把舊密語作廢，得先證明你手上有它（自決 4；忘了就走「重新加入同步」）。
  const ready = matched && !working && !rotating && (!rotate || current.trim().length > 0);

  const submit = async () => {
    setCurTouched(true);
    if (!ready) return;
    const ok = await onSubmit(current, next1, rotate);
    if (ok) {
      setCurrent("");
      setNext1("");
      setNext2("");
      setRotate(false);
      setCurTouched(false);
    }
  };

  return (
    <section className="ns-sy-pair">
      <span className="techo-label block mb-1">密語</span>
      <p className="ns-note mb-2">
        不勾下面那格時，改密語<b>只重包</b>雲端上的鑰匙：資料不重傳，其他已加入的裝置不受影響，之後新加入的裝置要用新密語。
      </p>
      {keySealed === false && (
        <p className="ns-note mb-2">升級後第一次：這次會把鑰匙封存到雲端（新密語可以與現在相同）。</p>
      )}
      {/* 產品評審 N1：這一段已經是字牆了，這句只補「留白也行」那一件事，不重複上面講過的後果。
          v1.1.4：勾了換鑰匙就不能留白（那是作廢舊密語，得先證明你有它），所以這句只在沒勾時說。 */}
      {!rotate && (
        <p className="ns-note mb-2">
          忘了現在的密語也沒關係——這台的鑰匙還在，<b>現在的密語可以留白</b>，直接設一個新的。
        </p>
      )}
      {rotating && <p className="ns-note is-fail mb-2">{PASSPHRASE_ROTATE.inProgress}</p>}
      <div className="ns-sy-form">
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">{rotate ? "現在的密語（必填）" : "現在的密語（可留白）"}</span>
          <input id={`${id}-cur`} className="techo-input ns-sy-input" type="password" value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} onBlur={() => setCurTouched(true)} />
        </label>
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">新密語</span>
          <input id={`${id}-n1`} className="techo-input ns-sy-input" type="password" value={next1} autoComplete="new-password" onChange={(e) => setNext1(e.target.value)} />
        </label>
        <label className="ns-sy-field">
          <span className="ns-sy-field-label">再打一次</span>
          <input id={`${id}-n2`} className="techo-input ns-sy-input" type="password" value={next2} autoComplete="new-password" onChange={(e) => setNext2(e.target.value)} />
        </label>
      </div>
      {next1.length > 0 && next1.length < 8 && <p className="ns-note is-fail">新密語至少 8 個字。</p>}
      {next2.length > 0 && next1 !== next2 && <p className="ns-note is-fail">兩次打的新密語不一樣。</p>}
      {/* v1.1.4 契約 §7.3：勾選＋警告文（字在 PASSPHRASE_ROTATE，兩殼同一份）。
          警告只在勾了才長出來（D-3 預設不勾）——沒要換鑰匙的人不該先讀一段「其他裝置會停在鍵違い」。 */}
      <label className="ns-note ns-sy-rotate" htmlFor={`${id}-rot`}>
        <input
          id={`${id}-rot`}
          type="checkbox"
          checked={rotate}
          disabled={working || rotating}
          onChange={(e) => setRotate(e.target.checked)}
        />
        <span>{PASSPHRASE_ROTATE.label}</span>
      </label>
      {rotate && (
        <p className="ns-note is-fail ns-sy-rotate-warn" role="status">
          {PASSPHRASE_ROTATE.warning}
        </p>
      )}
      {/* 產品評審（Nice）：勾完還沒動手就先亮紅字，會與上面那段警告疊成兩段紅。
          欄位標籤已經寫「必填」了，這句等主人真的碰過那一格（blur）再說。 */}
      {rotate && curTouched && current.trim().length === 0 && (
        <p className="ns-note is-fail">{PASSPHRASE_ROTATE.needCurrent}</p>
      )}
      {error && (
        <p className="ns-bk-err" role="alert">
          {error}
        </p>
      )}
      <div className="ns-bk-actions mt-2">
        <button type="button" className="btn-ghost ns-btn ns-btn--sm" disabled={!ready} onClick={() => void submit()}>
          {working ? "處理中…" : rotate ? "改密語並換鑰匙" : keySealed === false ? "封存密語" : "改密語"}
        </button>
      </div>
    </section>
  );
}

/**
 * 配對碼：QR ＋可複製文字（契約 §8.7）。任何已加入裝置都能出示；只含憑證與根前綴，不含密語、鹽與身分。
 * `qrcode` 用動態 import：沒按「顯示配對碼」的人不必下載那段 chunk。畫不出來就只留文字（掃不到本來就有退路）。
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
        if (alive) setQr(null);
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
        在另一台的「加入同步」按「貼上配對碼」或掃這格，四欄就填好了；密語不在裡面，要親手打。
        這段含雲端憑證——用信得過的管道送、送完刪掉。萬一外流：到 Cloudflare 後台撤銷 token 並建一把新的，
        然後每一台到〈同步〉按「更新憑證…」換上（資料不會動，不必重新加入）。
      </p>
      <div className="ns-sy-pair-body">
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
