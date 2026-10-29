/**
 * MobileBackup——手機「更多 › 備份與還原」子頁（收官磨光 Q2-a；使用者 10-28：「已經明訂雙端對等了，
 * 不該有電腦有手機卻沒有的功能」）。桌機〈備份與還原〉籤（settings/BackupTab.tsx）的手機版，逐項對齊：
 *
 *   桌機                         手機
 *   ① 上次成功備份＋領収章        ＝ 同（失敗轉赭字、不蓋章）
 *   ② 保留份數 3／7／14／30       ＝ 同（原生 select，同「一天的開始時間」那顆）
 *   ③ 第二備份位置（選資料夾）     → 「另存一份…」：Android 的系統存檔畫面給的是單一檔案、給不了資料夾路徑，
 *                                    改成先拍一份手動備份、再讓主人存到下載或雲端硬碟（畫面上寫明替代做法）
 *   ③ʹ 還原方式（加入同步才問）    ＝ 同（`.m2-choice` 兩格＋後果句）
 *   ④ 備份清單＋還原到這份         ＝ 同；手機沒有 hover，「還原到這份」常駐（同雲端清單的手機版）
 *   ⑤ 立即備份／從檔案還原…       ＝ 同；「開啟備份資料夾」手機打不開 App 私有目錄 → 由「另存一份…」代替
 *   ④ʹ 雲端備份                   ＝ 同一個 CloudSnapshots（加入同步才有；還原方式與上面共用）
 *   ⑥ 危險區                      手機照舊在「更多」頁尾（關於之後），這頁不重複放
 *
 * 狀態與動作全走 `backupStore`（確認窗、toast 都在 store，兩殼同一份）；形狀零發明：`.m2-block`／`.m2-note`／
 * `.m2-choice`／`.ns-btn.m2-sy-go`、清單沿雲端清單手機版的 `.m2-cl-list`。這頁自己的幾條排版在 mobileBackup.css。
 */
import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBackupStore } from "../../store/backupStore";
import { useSyncStore } from "../../store/syncStore";
import { BACKUP_KEEP_OPTIONS, BACKUP_SAFETY_KEEP, type BackupKind, type RestoreChoice } from "../../data";
import { SealReceipt } from "../stamps/Stamps";
import { CloudSnapshots, CLOUD_TEXT, RESTORE_CHOICES, RESTORE_CONSEQUENCE, fmtBytes } from "../common/CloudSnapshots";
import "./mobileBackup.css";

const KIND_LABEL: Record<BackupKind, string> = { auto: "自動", manual: "手動", safety: "保險" };

/** 顯示用時刻（同 BackupTab 的 fmtStamp：同年 `9/14 03:12`、跨年補年份；備份照本地時間，不套日界線） */
function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}

/** 這頁的字（只有手機用得到的幾句；跟桌機共用的字直接從 BackupTab 那一套來源取） */
export const MOBILE_BACKUP_TEXT = {
  title: "備份與還原",
  saveCopy: "另存一份…",
  /** ③ 的替代做法要寫在畫面上（雙端同等：平台做不到的要寫明替代） */
  saveCopyNote: "手機不能指定第二備份位置：要把備份帶離這支手機，按「另存一份…」存到下載或雲端硬碟；換手機時，在新手機按「從檔案還原…」選那份檔。",
} as const;

export default function MobileBackup({ onBack }: { onBack: () => void }) {
  const s = useBackupStore(
    // zustand 5 的物件 selector 一定要 useShallow，否則每次 render 都是新物件＝無限重繪
    useShallow((st) => ({
      entries: st.entries,
      status: st.status,
      keep: st.keep,
      lastOkAt: st.lastOkAt,
      lastError: st.lastError,
      failStreak: st.failStreak,
      booting: st.booting,
      needsRestart: st.needsRestart,
      backupNow: st.backupNow,
      restore: st.restore,
      setKeep: st.setKeep,
      refreshList: st.refreshList,
      restoreFromFile: st.restoreFromFile,
      saveCopy: st.saveCopy,
    })),
  );
  const syncJoined = useSyncStore((st) => !!st.status?.configured);
  const refreshSyncStatus = useSyncStore((st) => st.refreshStatus);
  const [restoreChoice, setRestoreChoice] = useState<RestoreChoice>("past");
  const keepId = useId();

  // 進頁重讀清單＋同步狀態（同桌機籤：「還原方式」要看這台加入了沒，快取可能還是 null）
  const { refreshList } = s;
  useEffect(() => {
    void refreshList();
    void refreshSyncStatus();
  }, [refreshList, refreshSyncStatus]);

  // 領収章：備份成功「當下」才跑回彈；進頁時既有的那枚是靜的（同 BackupTab）
  const [freshSeal, setFreshSeal] = useState(false);
  const seenOkAt = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = seenOkAt.current;
    seenOkAt.current = s.lastOkAt;
    if (prev === undefined || prev === s.lastOkAt || !s.lastOkAt) return;
    setFreshSeal(true);
    const t = setTimeout(() => setFreshSeal(false), 600);
    return () => clearTimeout(t);
  }, [s.lastOkAt]);

  const busy = s.booting || s.status !== "idle" || s.needsRestart;
  const okText = fmtStamp(s.lastOkAt);
  const failed = !!s.lastError;

  return (
    <div className="m-page m2-page" aria-label={MOBILE_BACKUP_TEXT.title}>
      <button type="button" className="m2-back" onClick={onBack}>
        ← 更多
      </button>

      <section className="m2-sec" aria-labelledby="m2-sec-backup">
        <h2 id="m2-sec-backup" className="m2-sec-title">
          {MOBILE_BACKUP_TEXT.title}
        </h2>

        {/* ⓪ 還原在「連線已關」之後失敗——常駐到重新啟動為止（同桌機籤） */}
        {s.needsRestart && (
          <p className="m2-note is-fail m2-bk-alert" role="alert">
            還原未完成——請重開私鐵手帳再試一次，原有資料沒有變動。
          </p>
        )}

        {/* ① 上次成功備份 */}
        <div className="m2-block m2-bk-status">
          <div className="m2-bk-status-text">
            <span className="m2-block-label">上次成功備份</span>
            {okText ? (
              <p className={"m2-bk-when" + (failed ? " is-fail" : "")}>{okText}</p>
            ) : (
              <p className="m2-note">{failed ? "還沒有成功的備份" : "還沒有備份紀錄"}</p>
            )}
            {failed && (
              <p className="m2-note is-fail">
                {s.lastError}
                {s.failStreak >= 2 ? `（已連續失敗 ${s.failStreak} 次）` : ""}
              </p>
            )}
            <p className="m2-note">每天第一次打開 App 會自動備份一份。</p>
          </div>
          {/* 失敗時不蓋章——章是回執，沒收到就不該有 */}
          {!failed && okText && (
            <SealReceipt className="m2-bk-seal" fresh={freshSeal} title={`領収——備份回執 ${okText}`} />
          )}
        </div>

        {/* ② 保留份數（原生 select：手機跳系統選單；同「一天的開始時間」那顆） */}
        <div className="m2-block">
          <label className="m2-block-label" htmlFor={keepId}>
            保留份數
          </label>
          <span className="ns-select-wrap m2-select-wrap">
            <select
              id={keepId}
              className="m2-input m2-select"
              value={s.keep}
              disabled={busy}
              onChange={(e) => void s.setKeep(Number(e.target.value))}
            >
              {BACKUP_KEEP_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} 份
                </option>
              ))}
            </select>
          </span>
          <p className="m2-note m2-bk-keep-note">自動與手動合計；還原前的保險備份另留 {BACKUP_SAFETY_KEEP} 份。</p>
        </div>

        {/* ③ʹ 還原方式（加入同步才問；下面「還原到這份」「從檔案還原…」與雲端還原都吃這個選擇） */}
        {syncJoined ? (
          <div className="m2-block">
            <span className="m2-block-label">還原方式</span>
            <div role="radiogroup" aria-label="還原方式" className="m2-choices">
              {RESTORE_CHOICES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={restoreChoice === c.value}
                  disabled={busy}
                  onClick={() => setRestoreChoice(c.value)}
                  className={"m2-choice" + (restoreChoice === c.value ? " is-on" : "")}
                >
                  <span className="m2-choice-label">{c.label}</span>
                  <span className="m2-choice-note">{RESTORE_CONSEQUENCE[c.value]}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="m2-block">
            <p className="m2-note">
              還原只會改這支手機。若想把這份備份併入其他裝置，就<b>先還原、再加入同步</b>，加入時選「兩邊都保留」。
            </p>
          </div>
        )}

        {/* ④ 備份清單（主位置；手機沒有第二位置）——「還原到這份」常駐 */}
        <div className="m2-block">
          <span className="m2-block-label">備份清單</span>
          {s.booting ? (
            <p className="m2-note">讀取中…</p>
          ) : s.entries.length === 0 ? (
            <p className="m2-note">還沒有備份——按下方「立即備份」先存一份。</p>
          ) : (
            <ul className="m2-cl-list m2-bk-list">
              {s.entries.map((e) => (
                <li key={`${e.location}:${e.path}`}>
                  <div className="m2-cl-meta">
                    <span className="m2-cl-when">
                      {fmtStamp(e.created_at)}
                      {/* 檔名只到分鐘：同一分鐘兩份要標「第 N 份」才分得出（同桌機） */}
                      {(e.seq ?? 1) > 1 && <span className="m2-bk-seq">第 {e.seq} 份</span>}
                    </span>
                    <span className="m2-cl-who">
                      {KIND_LABEL[e.kind]}・{fmtBytes(e.size_bytes)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ns-btn btn-ghost m2-sy-go m2-cl-restore"
                    disabled={busy}
                    onClick={() => s.restore(e.path, e.file_name, restoreChoice)}
                  >
                    {CLOUD_TEXT.restore}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ⑤ 動作列：立即備份（主鈕）／另存一份…（代替第二位置與開資料夾）／從檔案還原… */}
        <div className="m2-block">
          <div className="m2-sy-actions">
            <button type="button" className="ns-btn btn-seal m2-sy-go" disabled={busy} onClick={() => void s.backupNow()}>
              立即備份
            </button>
            <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={busy} onClick={() => void s.saveCopy()}>
              {MOBILE_BACKUP_TEXT.saveCopy}
            </button>
            <button
              type="button"
              className="ns-btn btn-ghost m2-sy-go"
              disabled={busy}
              onClick={() => void s.restoreFromFile(restoreChoice)}
            >
              從檔案還原…
            </button>
          </div>
          <p className="m2-note m2-bk-save-note">{MOBILE_BACKUP_TEXT.saveCopyNote}</p>
        </div>

        {/* ④ʹ 雲端（加入同步才有；還原方式與上面共用一顆，同桌機籤）——沒加入留一句，免得以為雲端快照沒了 */}
        {syncJoined ? (
          <CloudSnapshots shell="mobile" choice={restoreChoice} onChoiceChange={setRestoreChoice} />
        ) : (
          <div className="m2-block">
            <span className="m2-block-label">{CLOUD_TEXT.title}</span>
            <p className="m2-note">{CLOUD_TEXT.notJoined}</p>
          </div>
        )}
      </section>
    </div>
  );
}
