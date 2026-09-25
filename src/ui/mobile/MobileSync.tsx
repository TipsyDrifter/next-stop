/**
 * MobileSync——手機「更多 → 同步」頁（v1.1.1 WP8 立；v1.1.3 契約席起骨架、**WP-C 落文案與版面**）。
 *
 * 拍板依據：決策記錄〈同步與備份規則重整拍板〉三條規則＋密語可改；
 *           《2026-09-21-v1.1.3-同步規則重整契約.md》§8（文案；兩殼同一份字）。
 *
 * 版面（由上而下）：
 *   ⓪ 「← 更多」一列（本頁是「更多」的子頁，不進 uiStore）
 *   ① 狀態列（`SYNC_PHASE_LABEL`＋上次同步時刻；停車中／信号待ち／鍵違い把原因寫在下一行）＋「待上傳 N 筆」
 *      ＋常駐一句（雙向、同格後改的算數）
 *   ①ʹ 改正待ち（另一台「回到過去」）＝說明＋「改用那份」
 *   ①″ 兩邊都有資料（`pendingChoice`）＝頁內二選一「兩邊都保留」／「改用另一台的」（手機：先匯出全量 JSON）
 *   ② 未加入 ＝ 掃描另一台的配對碼（主路）／貼上（退路）→ 四欄自動填好（可展開改）＋密語兩次 → 「加入同步」
 *   ③ 已加入 ＝ 總開關、「立即同步」、「顯示配對碼」、密語（改密語）；「重新加入」獨立成頁尾一塊
 *
 * 手機也放「顯示配對碼」（契約 §8.7 允許，WP-C 決定放）：正本／副本退場之後，
 *   「誰能把另一台拉進來」不該還分桌機手機——手機可能是第一台（雲端空＋手機有料），
 *   那時要加入的桌機手上沒有 r2.env，只剩這張碼。qrcode 走動態 import，沒按就不下載那段 chunk。
 * v1.1.4（WP-C；契約 §7）：手機**有還原了**——「雲端備份」區（`CloudSnapshots`，與桌機備份籤同一個元件、
 *   同一個確認窗、同一套字；D-2）掛在已加入區、密語之前，含「立即備份到雲端」「匯出到手機」與快照列表；
 *   密語多一格「同時換掉資料鑰匙」（D-3，44px 觸控列）；狀態列多「換鑰匙中」與「跳過筆數」兩行。
 *   「改用另一台的」小字從「匯出 JSON 到下載／NextStop」改成「先拍一份到雲端」（§7.6）。
 *   §7.6 另寫「常駐句 `last_export` 那行改讀 `last_cloud_snapshot_at`」——WP-C 的落法是：
 *   `last_export` 那行**留著只當退路**（Rust 拍雲端快照失敗才會有值、那時主人真的需要那個路徑），
 *   「上次上傳 …」則由正下方「雲端備份」區的第一行講。同一件事在同一頁寫兩遍只會互相打架。
 * 手機沒有備份三件套（本機檔案那一套仍是桌機的事），其餘與桌機同一套字。
 * 觸控與輸入（鐵則）：可點目標 ≥44px（mobile.css 的 WP8 區塊）；輸入框 font-size 16px。
 * 資料流：不碰 repository，全走 `syncStore`；密語只活在本檔的 local state，送出後即清空。
 * 掃描：barcode-scanner 把相機畫在 WebView **後面**，掃描中整頁背景要透明（`html[data-scanning]`）。
 */
import { useEffect, useRef, useState } from "react";
import type { JoinReport, PairingFields, SyncStatus } from "../../data/syncRepository";
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
import { CLOUD_TEXT } from "../common/CloudSnapshots";
import { useUiStore } from "../../store/uiStore";
import { CloudSnapshots } from "../common/CloudSnapshots";

export default function MobileSync({ onBack }: { onBack: () => void }) {
  const status = useSyncStore((s) => s.status);
  const working = useSyncStore((s) => s.working);
  const bridgeError = useSyncStore((s) => s.bridgeError);
  const formError = useSyncStore((s) => s.formError);
  const pendingChoice = useSyncStore((s) => s.pendingChoice);
  const join = useSyncStore((s) => s.join);
  const joinWith = useSyncStore((s) => s.joinWith);
  const cancelChoice = useSyncStore((s) => s.cancelChoice);
  const changePassphrase = useSyncStore((s) => s.changePassphrase);
  const decodePairingCode = useSyncStore((s) => s.decodePairingCode);
  const syncNow = useSyncStore((s) => s.syncNow);
  const setEnabled = useSyncStore((s) => s.setEnabled);
  const reset = useSyncStore((s) => s.reset);
  const rejoin = useSyncStore((s) => s.rejoin);
  const exportToFile = useSyncStore((s) => s.exportToFile);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const adoptEpoch = useSyncStore((s) => s.adoptEpoch);
  const pairingCode = useSyncStore((s) => s.pairingCode);
  const showPairingCode = useSyncStore((s) => s.showPairingCode);
  const hidePairingCode = useSyncStore((s) => s.hidePairingCode);
  const askConfirm = useUiStore((s) => s.askConfirm);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // 離開本頁（或元件被拆）時把透明旗標收回來——留著的話整個 App 會變成透明底
  useEffect(() => {
    return () => {
      document.documentElement.removeAttribute("data-scanning");
    };
  }, []);

  const phase = status?.phase ?? "off";
  const configured = !!status?.configured;
  const enabled = !!status?.enabled;
  const blocked = phase === "epoch_changed" || phase === "locked" || phase === "rotating";
  /** 工程評審 B-1：加入過、卻讀不到私有檔 ⇒ 不露出加入表單（按下去＝變成新的一台、整包重推） */
  const keyringUnreadable = !configured && !!status?.joined && !!status?.last_error;
  /** 產品評審 B1：已加入狀態下重填四欄（換 token／撤銷 token 之後唯一的路） */
  const [updatingCreds, setUpdatingCreds] = useState(false);
  const credsRejected = phase === "stopped" && !!status?.last_error?.includes("拒絕了這組金鑰");
  /** 產品評審 B1：鍵違い且原因是「另一台換過鑰匙」——出路只有一條，畫面就只給那一條 */
  const rotatedLocked = phase === "locked" && status?.locked_reason === "rotated";

  return (
    <div className="m-page m2-page" aria-label="同步">
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
          {phase === "locked" && status && <p className="m2-note is-fail">{describeLocked(status)}</p>}
          {/* v1.1.4 契約 §7：換鑰匙中與跳過筆數那一行（>0 才出現）。
              換鑰匙＝這台自己在忙（頂帶的點是金的慢閃），不是故障也不是等人處理 ⇒ 不吃 `.is-fail` 的赭，
              只用一道金色左緣把它與旁邊的常駐小字分開（同桌機 `.ns-sy-rotating`）。 */}
          {phase === "rotating" && <p className="m2-note m2-sy-rotating">{PASSPHRASE_ROTATE.inProgress}</p>}
          {!!status?.skipped_missing_total && <p className="m2-note">{describeSkipped(status.skipped_missing_total)}</p>}
          {bridgeError && <p className="m2-note is-fail">這個版本的手機端還沒接上同步（{bridgeError}）。</p>}
          {!!status?.pending_ops && <p className="m2-note">待上傳 {status.pending_ops} 筆</p>}
          {status?.last_orphans && (
            <p className="m2-note m2-sy-orphans">
              上次改用另一份時另存 {status.last_orphans.count} 筆未送出的修改
              {status.last_orphans.at ? `（${fmtSyncStamp(status.last_orphans.at)}）` : ""}
              <br />
              <span className="m2-sy-orphans-path">{status.last_orphans.path}</span>
            </p>
          )}
          {status?.last_export && (
            <p className="m2-note m2-sy-orphans">
              上次改用另一台之前，這台的全部資料另存於
              {status.last_export.at ? `（${fmtSyncStamp(status.last_export.at)}）` : ""}
              <br />
              <span className="m2-sy-orphans-path">{status.last_export.path}</span>
            </p>
          )}
          {configured && (
            <p className="m2-note m2-sy-oneway">
              這台蓋的章、開的票會送到其他裝置；兩台同時改同一格時後改的算數，另一方的值記進該車票的乘務記錄。
            </p>
          )}
        </div>

        {/* ①ᵃ v1.1.4 修正席（產品評審 B1）：鍵違い（rotated）唯一走得通的那條路，就放在講那句話的正下方。
            形狀沿改正待ち那一塊（說明＋一顆主鈕），差別只在多一格密語輸入。 */}
        {rotatedLocked && !pendingChoice && (
          <RejoinRotatedBlock working={working} error={formError} onSubmit={rejoin} />
        )}

        {/* ①ʹ 改正待ち（契約 §8.4） */}
        {phase === "epoch_changed" && status && (
          <div className="m2-block m2-sy-epoch">
            <span className="m2-block-label">另一台裝置從備份還原了</span>
            <p className="m2-note">{describeEpochChange(status)}</p>
            <div className="m2-sy-actions">
              <button
                type="button"
                className="ns-btn btn-seal m2-sy-go"
                disabled={working}
                onClick={() =>
                  askConfirm({
                    title: "要改用那份嗎？",
                    body: JOIN_CHOICE_TEXT.adoptEpochBody("mobile"),
                    confirmLabel: "改用那份",
                    danger: true,
                    onConfirm: () => void adoptEpoch(),
                  })
                }
              >
                改用那份
              </button>
            </div>
          </div>
        )}

        {/* ①″ 兩邊都有資料（契約 §8.2） */}
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

        {configured && updatingCreds ? (
          /* ③ʹ 已加入、換一組 token（產品評審 B1）：同一張表，Rust 會判成「重接」 */
          <JoinForm
            purpose="credentials"
            hidden={!!pendingChoice}
            working={working}
            disabled={!!bridgeError}
            error={pendingChoice ? null : formError}
            onSubmit={async (input) => {
              await join(input);
              if (!useSyncStore.getState().formError) setUpdatingCreds(false);
            }}
            onDecode={decodePairingCode}
            onCancel={() => setUpdatingCreds(false)}
          />
        ) : configured ? (
          /* ③ 已加入 */
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
                disabled={working || !enabled || blocked}
                title={phase === "epoch_changed" ? "先處理上面的改正待ち" : phase === "locked" ? "先重新加入同步" : undefined}
                onClick={() => void syncNow()}
              >
                {working ? "同步中…" : "立即同步"}
              </button>
              <button
                type="button"
                className="ns-btn btn-ghost m2-sy-go"
                onClick={() => (pairingCode ? hidePairingCode() : void showPairingCode())}
              >
                {pairingCode ? "收起配對碼" : "顯示配對碼"}
              </button>
              {/* 產品評審 B1：換 token／撤銷 token 之後唯一到得了的路；金鑰被拒時升為主鈕。
                  v1.1.4 修正席：**鍵違い（rotated）時收起來**——它的表單寫「密語打現在這一句、
                  資料身分紀元都不會動」，在那一態照字打舊密語只會得到「密語不對」，打新密語卻會跳出
                  「兩邊都有資料」問合併，與那句話自相矛盾。那一態該走的是上面那顆「用新密語重新加入」。 */}
              {!rotatedLocked && (
                <button
                  type="button"
                  className={`ns-btn ${credsRejected ? "btn-seal" : "btn-ghost"} m2-sy-go`}
                  disabled={working}
                  onClick={() => setUpdatingCreds(true)}
                >
                  更新憑證…
                </button>
              )}
            </div>

            {pairingCode && <PairingCodeBlock code={pairingCode} />}

            {/* v1.1.4 D-2：雲端備份（兩殼共用元件；含「匯出到手機」）——版面由 WP-C 落 */}
            <CloudSnapshots shell="mobile" />

            <PassphraseBlock
              status={status}
              working={working}
              rotating={phase === "rotating"}
              error={formError}
              onSubmit={changePassphrase}
            />

            {/* ③ 重新加入（提案規則③）＝拿掉再放回去；按下去只做「拿掉」，表單當場長回來 */}
            <div className="m2-block m2-sy-danger">
              <span className="m2-block-label">重新加入</span>
              <p className="m2-note">
                清掉這台的同步設定、憑證與身分；這台的資料與雲端上的東西都不動。清掉之後這一頁會回到「加入同步」，
                重問一次（兩邊都有資料時會問要不要合併）。
              </p>
              <div className="m2-sy-actions">
                <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={working} onClick={reset}>
                  重新加入同步
                </button>
              </div>
            </div>
          </>
        ) : keyringUnreadable ? (
          /* 工程評審 B-1：讀不到私有檔 ≠ 沒加入。不給表單，只給一句人話 */
          <div className="m2-block m2-sy-epoch">
            <span className="m2-block-label">讀不到這台的同步身分</span>
            <p className="m2-note">
              這台加入過同步，但這次打不開存身分的檔，所以暫時停在這裡。<b>先不要重新加入</b>——
              重新加入會把這台當成新的一台、整份資料再上傳一次。多半把 App 關掉重開就好了。
            </p>
            <div className="m2-sy-actions">
              <button type="button" className="ns-btn btn-seal m2-sy-go" disabled={working} onClick={() => void refreshStatus()}>
                再看一次
              </button>
            </div>
          </div>
        ) : (
          /* ② 未加入（問二選一時整張表只是 hidden——按「取消」要回到剛才掃好／填好的那一張） */
          <>
            {/* v1.1.4 修正席（產品評審 B2）：**還沒加入同步的手機，這是它唯一的存底出口。**
                `CloudSnapshots` 在 `configured=false` 時整塊不渲染（沒鑰匙就沒快照，對的），
                但「匯出到手機」被包在裡面一起消失了——而手機沒有備份三件套，於是一台沒加入的手機
                零備份出口。契約 §6-6 本來就寫「app 私有目錄的退路保留給還沒加入同步的手機」。 */}
            <div className="m2-block">
              <span className="m2-block-label">先存一份到手機</span>
              <p className="m2-note">{CLOUD_TEXT.exportNote}</p>
              <div className="m2-sy-actions">
                <button
                  type="button"
                  className="ns-btn btn-ghost m2-sy-go"
                  disabled={working}
                  onClick={() => void exportToFile()}
                >
                  {CLOUD_TEXT.exportMobile}
                </button>
              </div>
              <p className="m2-note">{CLOUD_TEXT.exportNotJoined}</p>
            </div>
            <JoinForm
              hidden={!!pendingChoice}
              working={working}
              disabled={!!bridgeError}
              error={pendingChoice ? null : formError}
              onSubmit={(input) => join(input)}
              onDecode={decodePairingCode}
            />
          </>
        )}
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ② 未加入：掃描／貼上配對碼填欄 ＋ 四欄 ＋ 密語兩次（契約 §8.1）
   ═══════════════════════════════════════════════════════════════════════ */

function JoinForm({
  purpose = "join",
  hidden,
  working,
  disabled,
  error,
  onSubmit,
  onDecode,
  onCancel,
}: {
  /**
   * `join`＝還沒加入；`credentials`＝已加入、只是換一組 R2 token（產品評審 B1）。
   * 兩者走同一支 `sync_join`：鑰匙圈與紀元都還在時 Rust 判成「重接」，只更新憑證、不動資料。
   */
  purpose?: "join" | "credentials";
  /** 問「兩邊都有資料」時藏起來但不拆掉（掃到的四欄要留著） */
  hidden: boolean;
  working: boolean;
  disabled: boolean;
  error: string | null;
  onSubmit: (input: {
    endpoint: string;
    bucket: string;
    access_key_id: string;
    secret_access_key: string;
    passphrase: string;
    root?: string;
  }) => Promise<void>;
  onDecode: (code: string) => Promise<PairingFields | null>;
  /** `credentials` 才有：收起表單回到已加入的樣子 */
  onCancel?: () => void;
}) {
  const updating = purpose === "credentials";
  const [code, setCode] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [root, setRoot] = useState("");
  /** 四欄由配對碼填好之後先收起來（只顯示摘要），主人要改再展開 */
  const [showFields, setShowFields] = useState(true);
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanHint, setScanHint] = useState<string | null>(null);
  const passRef = useRef<HTMLInputElement | null>(null);

  // 更新憑證時那句密語是**現有的**（不是新設的）：只打一次、不套 8 字下限
  const passOk = updating ? pass1.length > 0 : pass1.length >= 8;
  const filled = endpoint.trim() && bucket.trim() && ak.trim() && sk.trim() && passOk;
  const matched = updating || (pass1.length > 0 && pass1 === pass2);
  const ready = !!filled && matched && !working && !disabled;

  const applyFields = (f: PairingFields) => {
    setEndpoint(f.endpoint);
    setBucket(f.bucket);
    setAk(f.access_key_id);
    setSk(f.secret_access_key);
    setRoot(f.root !== "v1" ? f.root : "");
    setShowFields(false);
    setCode("");
    // 四欄填好就只差密語了——焦點直接送過去，少一次點擊
    window.setTimeout(() => passRef.current?.focus(), 0);
  };

  const fillFromCode = async (raw: string) => {
    const f = await onDecode(raw);
    if (f) applyFields(f);
  };

  /**
   * 掃另一台畫面上的 QR（任何已加入裝置的「顯示配對碼」）。
   * 動態 import：桌機殼永遠載不到這段 JS（plugin 只掛在 mobile target）。任何一步失敗都只是「換個方式」。
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
      await fillFromCode(r.content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("cancel")) return; // 主人自己按的取消不是失敗
      setScanHint(`掃不到（${msg}）——請改用下面的貼上。`);
    } finally {
      document.documentElement.removeAttribute("data-scanning");
      setScanning(false);
    }
  };

  const cancelScan = () => {
    void import("@tauri-apps/plugin-barcode-scanner").then((bs) => bs.cancel()).catch(() => undefined);
  };

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
    setPass1("");
    setPass2("");
  };

  return (
    <div className="m2-join" hidden={hidden}>
      {scanning && (
        <div className="m2-scan-overlay" role="dialog" aria-label="掃描配對碼">
          <p className="m2-scan-tip">對準另一台畫面上的 QR</p>
          <div className="m2-scan-frame" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          <button type="button" className="ns-btn btn-ghost m2-sy-go m2-scan-cancel" onClick={cancelScan}>
            取消
          </button>
        </div>
      )}

      {updating && (
        <div className="m2-block">
          <span className="m2-block-label">更新憑證</span>
          <p className="m2-note">
            在 Cloudflare 換了一把新的 API token（或把舊的撤銷了）就填這裡：四欄換新、密語打<b>現在這一句</b>。
            資料、身分與紀元都不會動，其他裝置不受影響——它們各自也要來這裡更新一次。
          </p>
        </div>
      )}
      <div className="m2-block">
        <span className="m2-block-label">配對碼（省手打）</span>
        <div className="m2-sy-actions m2-sy-scan-row">
          <button
            type="button"
            className="ns-btn btn-ghost m2-sy-go"
            disabled={working || scanning || disabled}
            onClick={() => void scanQr()}
          >
            {scanning ? "掃描中…" : "掃描另一台的配對碼"}
          </button>
        </div>
        {scanHint && <p className="m2-note is-fail">{scanHint}</p>}
        <textarea
          className="m2-input m2-sy-code"
          rows={3}
          value={code}
          autoComplete="off"
          spellCheck={false}
          placeholder="或把另一台的配對碼貼在這裡"
          onChange={(e) => setCode(e.target.value)}
          aria-label="配對碼"
        />
        <div className="m2-sy-actions">
          <button
            type="button"
            className="ns-btn btn-ghost m2-sy-go"
            disabled={!code.trim() || working || disabled}
            onClick={() => void fillFromCode(code)}
          >
            填入四欄
          </button>
        </div>
        <p className="m2-note">另一台〔設定 → 同步 → 顯示配對碼〕；配對碼只含雲端憑證，密語要親手打。</p>
      </div>

      <div className="m2-block">
        <span className="m2-block-label">雲端（Cloudflare R2）</span>
        {!showFields && endpoint ? (
          <>
            <p className="m2-note">已從配對碼填入：{bucket}（{endpoint}）</p>
            <div className="m2-sy-actions">
              <button type="button" className="ns-btn btn-ghost m2-sy-go" onClick={() => setShowFields(true)}>
                展開修改
              </button>
            </div>
          </>
        ) : (
          <>
            <input className="m2-input" value={endpoint} autoComplete="off" spellCheck={false} placeholder="endpoint（https://….r2.cloudflarestorage.com）" onChange={(e) => setEndpoint(e.target.value)} aria-label="endpoint" />
            <input className="m2-input" value={bucket} autoComplete="off" spellCheck={false} placeholder="bucket" onChange={(e) => setBucket(e.target.value)} aria-label="bucket" />
            <input className="m2-input" value={ak} autoComplete="off" spellCheck={false} placeholder="access key id" onChange={(e) => setAk(e.target.value)} aria-label="access key id" />
            <input className="m2-input" type="password" value={sk} autoComplete="off" placeholder="secret access key" onChange={(e) => setSk(e.target.value)} aria-label="secret access key" />
            {import.meta.env.DEV && (
              <input className="m2-input" value={root} autoComplete="off" spellCheck={false} placeholder="root（沙盒；可略，預設 v1）" onChange={(e) => setRoot(e.target.value)} aria-label="root" />
            )}
          </>
        )}
      </div>

      <div className="m2-block">
        <span className="m2-block-label">密語</span>
        <input
          ref={passRef}
          className="m2-input"
          type="password"
          value={pass1}
          autoComplete="new-password"
          placeholder={updating ? "現在的密語" : "密語（至少 8 字）"}
          onChange={(e) => setPass1(e.target.value)}
          aria-label={updating ? "現在的密語" : "密語"}
        />
        {!updating && (
          <input
            className="m2-input"
            type="password"
            value={pass2}
            autoComplete="new-password"
            placeholder="再打一次"
            onChange={(e) => setPass2(e.target.value)}
            aria-label="再打一次密語"
          />
        )}
        <p className="m2-note">
          {updating
            ? "密語沒有換、也不會上雲——這裡打它只是用來打開雲端上那把鑰匙。"
            : "第一台加入時這句就是密語；其他裝置加入要打同一句。密語不會上雲，之後可以改，改了也不用重傳資料。"}
        </p>
        {!updating && pass1.length > 0 && pass1.length < 8 && <p className="m2-note is-fail">密語至少 8 個字。</p>}
        {!updating && pass2.length > 0 && !matched && <p className="m2-note is-fail">兩次打的密語不一樣。</p>}
      </div>
      {error && (
        <p className="m2-note is-fail" role="alert">
          {error}
        </p>
      )}
      <div className="m2-block m2-sy-actions">
        <button type="button" className="ns-btn btn-seal m2-sy-go" disabled={!ready} onClick={() => void submit()}>
          {working ? (updating ? "更新中…" : "加入中…") : updating ? "更新憑證" : "加入同步"}
        </button>
        {updating && onCancel && (
          <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={working} onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      {!ready && !working && (
        <p className="m2-note">
          {updating ? "四欄與現在的密語都填好才能更新。" : "四欄與密語（兩次相同、至少 8 字）都填好才能加入。"}
        </p>
      )}
      {!updating && (
        <p className="m2-note">雲端是空的→這台成為第一台；雲端有資料而這台是空的→直接拉下來；兩邊都有資料→會問你一次。</p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ①ᵃ 鍵違い（rotated）：用新密語重新加入（v1.1.4 修正席／產品評審 B1；字在 `REJOIN_ROTATED`，兩殼同一份）
   ═══════════════════════════════════════════════════════════════════════ */

function RejoinRotatedBlock({
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
    <div className="m2-block m2-sy-epoch">
      <span className="m2-block-label">{REJOIN_ROTATED.title}</span>
      <p className="m2-note">{REJOIN_ROTATED.note}</p>
      <input
        type="password"
        className="m2-input"
        autoComplete="off"
        placeholder={REJOIN_ROTATED.placeholder}
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      {error && (
        <p className="m2-note is-fail" role="alert">
          {error}
        </p>
      )}
      <div className="m2-sy-actions">
        <button
          type="button"
          className="ns-btn btn-seal m2-sy-go"
          disabled={!ready}
          onClick={() => {
            const p = pass;
            setPass("");
            void onSubmit(p);
          }}
        >
          {working ? "處理中…" : REJOIN_ROTATED.submit}
        </button>
      </div>
      <p className="m2-note">{REJOIN_ROTATED.credsHint}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ①″ 兩邊都有資料：頁內二選一（契約 §8.2；手機版「改用另一台的」＝先匯出全量 JSON）
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
    <div className="m2-block m2-sy-epoch">
      <span className="m2-block-label">兩邊都有資料</span>
      <p className="m2-note">{JOIN_CHOICE_TEXT.lead(report.remote_devices, report.local_alive)}</p>
      {error && (
        <p className="m2-note is-fail" role="alert">
          {error}
        </p>
      )}
      <div className="m2-sy-actions">
        <button type="button" className="ns-btn btn-seal m2-sy-go" disabled={working} onClick={onMerge}>
          {working ? "處理中…" : JOIN_CHOICE_TEXT.merge}
        </button>
      </div>
      <p className="m2-note">同一張票以較晚改的為準，被蓋掉的值記進該車票的乘務記錄。</p>
      <div className="m2-sy-actions">
        <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={working} onClick={onAdopt}>
          {JOIN_CHOICE_TEXT.adopt}
        </button>
      </div>
      {/* v1.1.4 契約 §7.6：手機的自動留底從「匯出 JSON 到下載／NextStop」改成「先拍一份雲端快照」
          （查證確認 `download_dir()` 在 Android 回的是 App 專屬目錄，主人根本看不到那個檔）。
          拍不成才退回 App 私有目錄的 JSON，那條路的路徑由 Rust 回報、顯示在狀態列。 */}
      <p className="m2-note">{JOIN_CHOICE_TEXT.adoptNote("mobile")}</p>
      <div className="m2-sy-actions">
        <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={working} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ③ 配對碼（契約 §8.7）：任何已加入的裝置都能出示——手機也不例外
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * QR ＋可複製文字。`qrcode` 走動態 import（沒按「顯示配對碼」的人不必下載那段 chunk）；
 * 畫不出來就只留文字（另一台本來就有「貼上」這條退路）。逐字沿桌機 `SyncTab.PairingCodeBlock`。
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
      showToast({ message: "複製不了——請長按下面那段文字選取" });
    }
  };

  return (
    <div className="m2-block">
      <span className="m2-block-label">配對碼</span>
      <p className="m2-note">
        在另一台的「加入同步」按「貼上配對碼」或掃這格，四欄就填好了；密語不在裡面，要親手打。
        這段含雲端憑證——用信得過的管道送、送完刪掉；萬一外流，到 Cloudflare 後台撤銷 token 即可。
      </p>
      {qr && <div className="m2-sy-qr" aria-label="配對碼 QR" dangerouslySetInnerHTML={{ __html: qr }} />}
      <textarea className="m2-input m2-sy-code" readOnly rows={4} value={code} aria-label="配對碼" />
      <div className="m2-sy-actions">
        <button type="button" className="ns-btn btn-ghost m2-sy-go" onClick={() => void copy()}>
          {copied ? "已複製" : "複製"}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ③ 密語（契約 §8.6）
   ═══════════════════════════════════════════════════════════════════════ */

function PassphraseBlock({
  status,
  working,
  rotating,
  error,
  onSubmit,
}: {
  status: SyncStatus | null;
  working: boolean;
  /** phase='rotating'：上一次換鑰匙還沒走完，整段鎖住（Rust 也會擋，這裡先擋免得主人白打一次密語） */
  rotating: boolean;
  error: string | null;
  onSubmit: (current: string, next: string, rotate?: boolean) => Promise<boolean>;
}) {
  const [current, setCurrent] = useState("");
  const [next1, setNext1] = useState("");
  const [next2, setNext2] = useState("");
  // v1.1.4 D-3：勾了「同時換掉資料鑰匙」＝真撤銷；現密語變必填
  const [rotate, setRotate] = useState(false);
  /** 「現在的密語」那一格碰過了沒（產品評審 Nice：紅字等 blur 再出現） */
  const [curTouched, setCurTouched] = useState(false);
  const keySealed = status?.key_sealed ?? null;
  // 產品評審 B4：現密語可留白（資料鑰匙在這台的私有檔裡，重包雲端那顆 KEY 用不到舊密語）；
  // 勾了換鑰匙則必填——那是作廢舊密語，得先證明你手上有它（自決 4）。
  const ready = next1.length >= 8 && next1 === next2 && !working && !rotating && (!rotate || current.trim().length > 0);

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
    <div className="m2-block">
      <span className="m2-block-label">密語</span>
      <p className="m2-note">
        不勾下面那格時，改密語只重包雲端上的鑰匙：資料不重傳，其他已加入的裝置不受影響，之後新加入的裝置要用新密語。
      </p>
      {keySealed === false && <p className="m2-note">升級後第一次：這次會把鑰匙封存到雲端（新密語可以與現在相同）。</p>}
      {/* 勾了換鑰匙就不能留白（那是作廢舊密語，得先證明你有它）——所以這句只在沒勾時說，同桌機 */}
      {!rotate && <p className="m2-note">忘了現在的密語也沒關係——這台的鑰匙還在，現在的密語可以留白，直接設一個新的就好。</p>}
      {rotating && <p className="m2-note is-fail">{PASSPHRASE_ROTATE.inProgress}</p>}
      <input
        className="m2-input"
        type="password"
        value={current}
        autoComplete="current-password"
        placeholder={rotate ? "現在的密語（必填）" : "現在的密語（可留白）"}
        onChange={(e) => setCurrent(e.target.value)}
        onBlur={() => setCurTouched(true)}
        aria-label={rotate ? "現在的密語（必填）" : "現在的密語（可留白）"}
      />
      <input className="m2-input" type="password" value={next1} autoComplete="new-password" placeholder="新密語（至少 8 字）" onChange={(e) => setNext1(e.target.value)} aria-label="新密語" />
      <input className="m2-input" type="password" value={next2} autoComplete="new-password" placeholder="再打一次" onChange={(e) => setNext2(e.target.value)} aria-label="再打一次新密語" />
      {next1.length > 0 && next1.length < 8 && <p className="m2-note is-fail">新密語至少 8 個字。</p>}
      {next2.length > 0 && next1 !== next2 && <p className="m2-note is-fail">兩次打的新密語不一樣。</p>}
      {/* v1.1.4 契約 §7.3：勾選＋警告文（字在 PASSPHRASE_ROTATE，與桌機同一份）。
          整列 44px 觸控目標（鐵則）——手指點得到的是整行字，不是那顆 16px 的方框。 */}
      <label className="m2-note m2-sy-rotate">
        <input type="checkbox" checked={rotate} disabled={working || rotating} onChange={(e) => setRotate(e.target.checked)} />
        <span>{PASSPHRASE_ROTATE.label}</span>
      </label>
      {rotate && (
        <p className="m2-note is-fail" role="status">
          {PASSPHRASE_ROTATE.warning}
        </p>
      )}
      {/* 產品評審（Nice）：勾完還沒動手就先亮紅字，會與上面那段警告疊成兩段紅。
          欄位標籤已經寫「必填」了，這句等主人真的碰過那一格（blur）再說。 */}
      {rotate && curTouched && current.trim().length === 0 && (
        <p className="m2-note is-fail">{PASSPHRASE_ROTATE.needCurrent}</p>
      )}
      {error && (
        <p className="m2-note is-fail" role="alert">
          {error}
        </p>
      )}
      <div className="m2-sy-actions">
        <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={!ready} onClick={() => void submit()}>
          {working ? "處理中…" : rotate ? "改密語並換鑰匙" : keySealed === false ? "封存密語" : "改密語"}
        </button>
      </div>
    </div>
  );
}
