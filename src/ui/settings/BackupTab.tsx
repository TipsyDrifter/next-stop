/**
 * BackupTab——設定頁「備份與還原」分頁（M3 ⑥ WP3）。
 *
 * 拍板依據：`docs/決策記錄.md`〈⑥ 備份三件套實施計畫拍板〉D-⑥-2／4／5／7／8
 *           ＋`docs/research/2026-09-14-M3⑥備份三件套-實施計畫草案.md` §3「WP3 設定頁 UI 席」。
 *
 * 版面（由上而下）：
 *   ① 狀態列   ＝「上次成功備份 9/14 03:12」＋領収章（朱、-5°、小號圓印）；
 *               失敗＝時刻轉赭字＋下一行寫原因，**不蓋章**（D-⑥-7）。
 *   ② 保留份數 ＝ 3／7／14／30（`BACKUP_KEEP_OPTIONS`）；保險份另計 3 份不佔配額（D-⑥-2）。
 *   ③ 第二位置 ＝ 路徑一行＋「選擇資料夾…」「清除」＋鏡射狀態小字（D-⑥-4：鏡射失敗不算主備份失敗）。
 *   ③ʹ 還原方式 ＝（v1.1.3，加入了同步才問）「回到過去」／「接上現在」二選一＋後果句；
 *               沒加入同步＝不問，只留一行「還原不會影響其他裝置」。下面兩個還原入口都吃這個選擇。
 *   ④ 清單     ＝ 時間・大小・來源 chip（自動／手動／保險 ＋ 主位置／第二位置）；
 *               「還原到此份」照「原型沒有的元素 hover／聚焦才現身」（c13）。
 *   ⑤ 動作列   ＝「立即備份」「開啟備份資料夾」「從檔案還原…」（D-⑥-5）。
 *   ⑥ 危險區   ＝ `import.meta.env.DEV` 才渲染的「重置空庫（保留設定）」（D-⑥-8，正式版無此入口）。
 *
 * 視覺紀律（c13：無原型，一個新形狀都不發明）：
 *   紙卡／籤／按鈕／select／小字標籤全借既有語彙（DialogShell、`.ns-choice`、`.btn-seal`／`.btn-ghost`、
 *   `.ns-select-wrap`、techo.css 的 `.status` 當來源 chip）；顏色一律 token，不寫死色值。
 *
 * 資料流：本檔**不碰 repository**，狀態與動作全走 `backupStore`（WP2）——
 *   確認窗（askConfirm danger）、失敗 toast、成功 toast 都在 store 裡，UI 只負責呈現與觸發。
 *   型別與常數來自 `data/backupRepository`（WP0 契約）。
 */
import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBackupStore } from "../../store/backupStore";
import { useSyncStore } from "../../store/syncStore";
import { useUiStore } from "../../store/uiStore";
import { BACKUP_KEEP_OPTIONS, BACKUP_SAFETY_KEEP } from "../../data";
import type { BackupKind, BackupLocation, RestoreChoice } from "../../data";
import { SealReceipt } from "../stamps/Stamps";
import "./settings.css";

const KIND_LABEL: Record<BackupKind, string> = { auto: "自動", manual: "手動", safety: "保險" };
const LOCATION_LABEL: Record<BackupLocation, string> = { primary: "主位置", secondary: "第二位置" };

/**
 * 還原方式二選一（v1.1.3 契約 §8.3；提案規則②）——**後果要在按下去之前講**。
 * 同一句話也會再出現在確認窗的 body（`backupStore.restore` 依主人選的那枚組），兩處一字不差是刻意的：
 * 頁上這句是「我等一下要做什麼」，窗裡那句是「我現在就要做了」，講法一變主人就會以為是兩件事。
 * 沒選到的那一句掛在 `title`（桌機有 hover）——兩句都常駐會把這一籤塞成字牆，
 * 沿本籤「保留份數」那顆 select 的慣例：長句版走 title。
 */
const RESTORE_CONSEQUENCE: Record<RestoreChoice, string> = {
  past: "所有裝置都改用這份備份：備份之後的修改（含其他裝置已送出的）都會消失；其他裝置還沒送出的修改會另存成檔，不會自動併回。",
  // 產品評審 S3：舊句「等於只找回沒人動過的部分」會被讀成「沒人編輯過的部分」，
  // 但**刪除也算動過**——誤刪的票只要那筆刪除已經送上雲，這條路一張都救不回來。
  present: "只有這台換成備份；其他裝置比備份新的修改會再蓋回來。刪除也算一種修改——已經同步出去的誤刪不會被找回來。",
};
const RESTORE_CHOICES: { value: RestoreChoice; label: string; consequence: string }[] = [
  { value: "past", label: "回到過去", consequence: RESTORE_CONSEQUENCE.past },
  { value: "present", label: "接上現在", consequence: RESTORE_CONSEQUENCE.present },
];

/** 顯示用時刻：同年＝`9/14 03:12`，跨年補年份。備份照本地時間，**不套日界線**（草案 §5-11）。 */
function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

export function BackupTab() {
  const {
    entries,
    status,
    keep,
    secondaryDir,
    lastOkAt,
    lastError,
    failStreak,
    secondaryLastOkAt,
    secondaryLastError,
    booting,
    needsRestart,
    backupNow,
    restore,
    setKeep,
    pickSecondary,
    clearSecondary,
    refreshList,
    revealBackupsDir,
    restoreFromFile,
    resetDatabaseKeepSettings,
  } = useBackupStore(
    // zustand 5 的物件 selector 一定要 useShallow，否則每次 render 都是新物件＝無限重繪
    useShallow((s) => ({
      entries: s.entries,
      status: s.status,
      keep: s.keep,
      secondaryDir: s.secondaryDir,
      lastOkAt: s.lastOkAt,
      lastError: s.lastError,
      failStreak: s.failStreak,
      secondaryLastOkAt: s.secondaryLastOkAt,
      secondaryLastError: s.secondaryLastError,
      booting: s.booting,
      needsRestart: s.needsRestart,
      backupNow: s.backupNow,
      restore: s.restore,
      setKeep: s.setKeep,
      pickSecondary: s.pickSecondary,
      clearSecondary: s.clearSecondary,
      refreshList: s.refreshList,
      revealBackupsDir: s.revealBackupsDir,
      restoreFromFile: s.restoreFromFile,
      resetDatabaseKeepSettings: s.resetDatabaseKeepSettings,
    })),
  );

  // 還原的 danger 確認在 store；DEV 重置沒有，這裡自己攔一道（清空是不可逆的）
  const askConfirm = useUiStore((s) => s.askConfirm);
  const keepId = useId();
  /**
   * v1.1.3 契約 §8.3：這台加入了同步 ⇒ 還原前先在頁上選「回到過去」（預設）／「接上現在」，
   * 確認窗的後果句依選項而定；沒加入 ⇒ 不問（還原不牽動任何裝置）。
   */
  const syncJoined = useSyncStore((s) => !!s.status?.configured);
  const refreshSyncStatus = useSyncStore((s) => s.refreshStatus);
  const [restoreChoice, setRestoreChoice] = useState<RestoreChoice>("past");

  // 開分頁就重讀一次清單（純讀、可重入；StrictMode 雙掛載只是多列一次）。
  // 產品評審 S-4：**同步狀態也要重問一次**。這一籤讀的是快取的 `syncStore.status`；
  // 從沒開過〈同步〉籤的那次啟動它可能還是 null ⇒「還原方式」整段不出現 ⇒ 不落選擇檔 ⇒
  // 收尾時走預設值，而不是主人以為的那一個。
  useEffect(() => {
    void refreshList();
    void refreshSyncStatus();
  }, [refreshList, refreshSyncStatus]);

  // 領収章：備份成功「當下」才跑 stampIn 回彈；進畫面時既有的那枚是靜的
  const [freshSeal, setFreshSeal] = useState(false);
  const seenOkAt = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = seenOkAt.current;
    seenOkAt.current = lastOkAt;
    if (prev === undefined || prev === lastOkAt || !lastOkAt) return;
    setFreshSeal(true);
    const t = setTimeout(() => setFreshSeal(false), 600);
    return () => clearTimeout(t);
  }, [lastOkAt]);

  /**
   * 有動作在飛（備份／還原／列清單）就把會改狀態的鈕鎖起來；booting＝清單還沒到齊。
   * `needsRestart`＝還原在「連線已關」之後失敗：這個進程寫不進資料庫了，整頁鎖死到重新啟動為止
   * （toast 只活 10 秒，撐不住這種狀態；主畫面另有常駐橫幅）。
   */
  const busy = booting || status !== "idle" || needsRestart;

  const okText = fmtStamp(lastOkAt);
  const failed = !!lastError;

  const askReset = () =>
    askConfirm({
      title: "重置成空庫（保留設定）？",
      body: "清空所有幹線、路線、班次與乘務記錄，只留下設定。這是開發模式限定的清場步驟，正式版沒有這個入口——清空前請先按「立即備份」存一份。",
      confirmLabel: "清空",
      danger: true,
      onConfirm: () => void resetDatabaseKeepSettings(),
    });

  return (
    <div className="ns-bk">
      {/* ⓪ 還原失敗在「連線已關」之後——常駐到重新啟動為止（不是 toast 能扛的狀態） */}
      {needsRestart && (
        <p className="ns-note is-fail" role="alert">
          還原沒有完成，資料庫的連線已經關掉了——請關掉私鐵手帳再重新開一次。資料庫檔案本身沒有被改動。
        </p>
      )}

      {/* ① 狀態列——三件套之③的「常駐」那一層 */}
      <section className="ns-bk-status">
        <div className="min-w-0">
          <span className="techo-label block mb-1">上次成功備份</span>
          {okText ? (
            <p className={`ns-bk-when${failed ? " is-fail" : ""}`}>{okText}</p>
          ) : (
            <p className="ns-bk-when is-none">{failed ? "還沒有成功的備份" : "還沒有備份紀錄"}</p>
          )}
          {failed && (
            <p className="ns-bk-err">
              {lastError}
              {failStreak >= 2 ? `（已連續失敗 ${failStreak} 次）` : ""}
            </p>
          )}
        </div>
        {/* 失敗時不蓋章（D-⑥-7）——章是回執，沒收到就不該有 */}
        {!failed && okText && (
          <SealReceipt className="ns-bk-seal" fresh={freshSeal} title={`領収——備份回執 ${okText}`} />
        )}
      </section>

      {/* ② 保留份數 */}
      <section>
        <label className="techo-label block mb-1" htmlFor={keepId}>
          保留份數
        </label>
        <span className="ns-select-wrap">
          <select
            id={keepId}
            value={keep}
            disabled={busy}
            title={`自動與手動備份合計保留這麼多份，超出的自動刪最舊；還原前的保險備份另外保留 ${BACKUP_SAFETY_KEEP} 份，不佔配額。`}
            onChange={(e) => void setKeep(Number(e.target.value))}
            className="techo-input font-latin text-[14px]"
          >
            {BACKUP_KEEP_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} 份
              </option>
            ))}
          </select>
        </span>
        {/* 克制（修正席）：規則講一句就好，長句版改掛 select 的 title */}
        <p className="ns-note mt-2">自動與手動合計；還原前的保險份另計 {BACKUP_SAFETY_KEEP} 份。</p>
      </section>

      {/* ③ 第二備份位置（異地保險） */}
      <section>
        <span className="techo-label block mb-1">第二備份位置</span>
        <p className={`ns-bk-path${secondaryDir ? "" : " is-empty"}`} title={secondaryDir ?? undefined}>
          {secondaryDir ?? "尚未設定——只備份到預設位置"}
        </p>
        <div className="ns-bk-actions mt-2">
          <button
            type="button"
            onClick={() => void pickSecondary()}
            disabled={busy}
            title="設成雲端同步資料夾（例如 pCloud），這顆碟壞了也還有一份。"
            className="btn-ghost ns-btn ns-btn--sm"
          >
            選擇資料夾…
          </button>
          {secondaryDir && (
            <button
              type="button"
              onClick={() => void clearSecondary()}
              disabled={busy}
              className="btn-ghost ns-btn ns-btn--sm"
            >
              清除
            </button>
          )}
        </div>
        {/* 沒設第二位置時這一行整段不出現（招攬的話收進「選擇資料夾…」的 title）——有狀態才說話 */}
        {(secondaryLastError || secondaryLastOkAt) && (
          <p className={`ns-note mt-2${secondaryLastError ? " is-fail" : ""}`}>
            {secondaryLastError
              ? `上次鏡射失敗：${secondaryLastError}（第二位置寫不進去不影響主備份）`
              : `上次鏡射成功 ${fmtStamp(secondaryLastOkAt)}——每次備份成功後同步一份到這裡。`}
          </p>
        )}
      </section>

      {/* ③ʹ 還原方式（v1.1.3 契約 §8.3；加入了同步才問）——下面每一顆「還原到此份」與「從檔案還原…」都吃這個選擇 */}
      {syncJoined ? (
        <section>
          <span className="techo-label block mb-2.5">還原方式</span>
          <div role="radiogroup" aria-label="還原方式" className="ns-bk-restore-choice">
            {RESTORE_CHOICES.map(({ value, label, consequence }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={restoreChoice === value}
                disabled={busy}
                title={consequence}
                onClick={() => setRestoreChoice(value)}
                className={`ns-choice${restoreChoice === value ? " is-on" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="ns-note mt-2">{RESTORE_CONSEQUENCE[restoreChoice]}</p>
        </section>
      ) : (
        /* 產品評審 B3：舊句「想讓其他裝置也改用這份，先加入同步再還原」會把「舊電腦壞了、只剩備份」
           那位主人帶進最糟的一條路——先加入（拉下手機現況）再還原「回到過去」＝手機這週的修改全變孤兒。
           正解剛好相反：**先還原（這台還沒加入，零影響）再加入**，加入時選「兩邊都保留」就併起來了。 */
        <p className="ns-note">
          這台還沒加入同步，還原只動這一台。之後加入同步時若兩邊都有資料會問你要不要合併——
          舊電腦壞了、想把這份備份併進手機現況，就<b>先還原、再加入同步</b>，加入時選「兩邊都保留」。
        </p>
      )}

      {/* ④ 清單——主位置＋第二位置合併列（D-⑥-5 甲） */}
      <section>
        <span className="techo-label block mb-1">備份清單</span>
        {booting ? (
          <p className="ns-note">讀取中…</p>
        ) : entries.length === 0 ? (
          <p className="ns-note">還沒有備份——按下方「立即備份」先存一份。</p>
        ) : (
          <ul className="ns-bk-list">
            {entries.map((e) => (
              <li key={`${e.location}:${e.path}`}>
                <span className="ns-bk-time">{fmtStamp(e.created_at)}</span>
                {/* 檔名只到分鐘，同一分鐘兩份的時刻一模一樣——標出檔名裡的序號才分得出是哪一個檔
                    （⑥ 沙盒真機第 4 條；不改顯示到秒，理由見 BackupEntry.seq 的註解） */}
                {(e.seq ?? 1) > 1 && <span className="ns-bk-seq">第 {e.seq} 份</span>}
                <span className="ns-bk-size">{fmtSize(e.size_bytes)}</span>
                <span className="ns-bk-chips">
                  <span className="status">{KIND_LABEL[e.kind]}</span>
                  {/* 位置 chip 只在真的有兩個位置時才有資訊量——沒設第二位置時整欄都是「主位置」＝純噪音 */}
                  {secondaryDir && (
                    <span className={`status${e.location === "secondary" ? " is-secondary" : ""}`}>
                      {LOCATION_LABEL[e.location]}
                    </span>
                  )}
                </span>
                {/* 確認窗在 store（askConfirm danger）；這裡只把路徑遞過去 */}
                <button
                  type="button"
                  onClick={() => restore(e.path, e.file_name, restoreChoice)}
                  disabled={busy}
                  title={e.path}
                  className="btn-ghost ns-btn ns-btn--sm ns-bk-restore"
                >
                  還原到此份
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ⑤ 動作列 */}
      <section className="ns-bk-actions">
        <button type="button" onClick={() => void backupNow()} disabled={busy} className="btn-seal ns-btn">
          立即備份
        </button>
        <button type="button" onClick={() => void revealBackupsDir()} className="btn-ghost ns-btn">
          開啟備份資料夾
        </button>
        <button type="button" onClick={() => void restoreFromFile(restoreChoice)} disabled={busy} className="btn-ghost ns-btn">
          從檔案還原…
        </button>
      </section>

      {/* ⑥ 危險區——DEV 限定（D-⑥-8：正式版沒有這個入口） */}
      {import.meta.env.DEV && (
        <section className="ns-bk-danger">
          <span className="techo-label block mb-1">危險區（僅開發模式）</span>
          <div className="ns-bk-actions">
            <button
              type="button"
              onClick={askReset}
              disabled={busy}
              title="⑧ 清場步驟二：清空資料、保留主題與日界線等設定。清空前請先「立即備份」。"
              className="btn-ghost ns-btn ns-btn-danger"
            >
              重置空庫（保留設定）
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
