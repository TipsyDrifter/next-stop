/**
 * CloudSnapshots——雲端備份區塊（v1.1.4 **WP-C**；契約席 2026-09-22 立骨架、WP-C 落版面；兩殼共用同一個元件）。
 *
 * 拍板依據：決策記錄〈v1.1.4 開工拍板〉D-1（階梯稀釋，列表最多約 35 條）／D-2（兩殼同一套：桌機「備份與還原」
 *   籤的「雲端」區塊＝手機「更多›同步」頁的「雲端備份」區，同一個列表元件、同一個確認窗、同一套字）；
 *   《2026-09-22-v1.1.4-雲端備份與真撤銷契約.md》§7（文案）。
 *
 * 版面（由上而下）：
 *   ① 「上次上傳 9/22 14:03」／「還沒上傳過」＋「立即備份到雲端」（手機多一顆「匯出到手機」）
 *   ② 還原方式二選一（`RESTORE_CHOICES`，與桌機本機還原**同一份字**）
 *   ③ 列表一列＝「9/22 14:03　這台　自動　38 KB」＋「還原到這份」（點了走 store 的確認窗）
 *
 * 為什麼「還原方式」在桌機是一句話而不是第二組 radio（WP-C 自決，記回報）：
 *   桌機這塊住在〈備份與還原〉籤裡，那一籤上頭已經有一組「回到過去／接上現在」（③ʹ），
 *   本機還原與雲端還原本來就該是同一個選擇（D-2「兩殼同一套」）。同一頁擺兩組同名 radio ＝
 *   兩份真相：主人在上面選了「接上現在」、在下面按雲端還原卻跑「回到過去」。
 *   所以桌機由 BackupTab 把那顆 state 傳進來（`choice`／`onChoiceChange`），這裡只寫一行「現在選的是…」；
 *   手機沒有本機還原三件套、這塊是唯一的還原入口，才自己長一組（`.m2-choice`，含後果句與 44px 觸控目標）。
 *
 * 視覺紀律（c13：一個新形狀都不發明）：桌機借〈備份與還原〉的語彙（`.techo-label`／`.ns-note`／
 *   `.ns-bk-list`／`.ns-bk-time`／`.ns-bk-size`／`.status` chip／hover 才現身的 `.ns-bk-restore`），
 *   手機借 MobileSync 的 `.m2-block`／`.m2-note`／`.m2-choice`／`.m2-sy-go`。排版規則分別在
 *   `ui/settings/settings.css` 檔尾與 `styles/mobile.css` 檔尾（沿契約的分家慣例）。
 *
 * 資料流：不碰 repository，全走 `syncStore`（`cloudSnapshots`／`refreshCloudSnapshots`／`cloudSnapshotNow`／
 *   `cloudRestore`／`exportToFile`）。沒加入同步（`status.configured=false`）整個不渲染——沒鑰匙就沒快照。
 *
 * 裝置欄的字：鍵名只有 device_id、沒有殼別，所以寫「這台」／「另一台 A1B2」（前 4 碼大寫），不寫「桌機／手機」
 *   ——契約 §7 的例句「桌機 A1B2」在鍵名裡拿不到殼別，要顯示殼別得另外存（本輪不做；契約 §11.1③）。
 */
import { useEffect, useState } from "react";
import type { RestoreChoice, SnapshotEntry, SnapshotKind } from "../../data/syncRepository";
import { useSyncStore, fmtSyncStamp, type SyncShell } from "../../store/syncStore";

/**
 * 還原方式二選一（v1.1.3 契約 §8.3；提案規則②）——**後果要在按下去之前講**。
 * 同一句話也會再出現在確認窗的 body（`backupStore.restore`／`syncStore.cloudRestore` 依主人選的那枚組），
 * 兩處一字不差是刻意的：頁上這句是「我等一下要做什麼」，窗裡那句是「我現在就要做了」，講法一變主人就會以為是兩件事。
 * v1.1.4 從 BackupTab 搬到這裡：雲端還原與本機還原要同一套字（D-2）。
 */
export const RESTORE_CONSEQUENCE: Record<RestoreChoice, string> = {
  past: "所有裝置都改用這份備份：備份之後的修改（含其他裝置已送出的）都會消失；其他裝置還沒送出的修改會另存成檔，不會自動併回。",
  // 產品評審 S3：舊句「等於只找回沒人動過的部分」會被讀成「沒人編輯過的部分」，
  // 但**刪除也算動過**——誤刪的票只要那筆刪除已經送上雲，這條路一張都救不回來。
  present: "只有這台換成備份；其他裝置比備份新的修改會再蓋回來。刪除也算一種修改——已經同步出去的誤刪不會被找回來。",
};
export const RESTORE_CHOICES: { value: RestoreChoice; label: string; consequence: string }[] = [
  { value: "past", label: "回到過去", consequence: RESTORE_CONSEQUENCE.past },
  { value: "present", label: "接上現在", consequence: RESTORE_CONSEQUENCE.present },
];

/** 雲端備份區的字（契約 §7；兩殼同一份） */
export const CLOUD_TEXT = {
  title: "雲端備份",
  intro: "每天第一次同步後自動上傳一份加密快照；最近 14 天每份都留，之後每週留一份（3 個月）、每月留一份（1 年）。",
  lastUpload: (iso: string | null) => (iso ? `上次上傳 ${fmtSyncStamp(iso)}` : "還沒上傳過"),
  now: "立即備份到雲端",
  listEmpty: "雲端上還沒有快照——按「立即備份到雲端」拍第一份。",
  loading: "讀取中…",
  restore: "還原到這份",
  restoreHow: "還原方式",
  /** 桌機：選擇與上面本機還原共用同一顆，這裡只複述現在選的是哪一枚（不另長一組 radio） */
  restoreHowShared: (label: string) => `還原方式沿用上面選的「${label}」——雲端還原與從備份還原是同一個選擇。`,
  exportMobile: "匯出到手機",
  // 產品評審 S5：誠實講它目前只能人工翻閱（沒有匯入工具），與改正待ち那邊對孤兒 JSON 的講法一致
  exportNote: "把整份資料存成一個 JSON 檔到你選的位置（例如「下載」）——那個檔目前只能人工翻閱，沒有匯入工具。",
  /** 產品評審 B2：沒加入同步的手機唯一的存底出口（app 私有目錄；路徑會在 toast 裡講出來） */
  exportNotJoined: "加入同步之後，這裡還會多一份「雲端備份」——每天自動拍一份加密快照，任何裝置都還原得回來。",
  /** 產品評審（Nice）：沒加入的桌機在〈備份與還原〉只看得到本機那一套，要講一句它們去哪了 */
  notJoined: "加入同步之後，這裡會列出雲端快照（每天第一次同步後自動拍一份，任何裝置都還原得回來）。",
  /** 產品評審 S3：預設只展最近 14 天（階梯本來就是「14 天內全留」），更舊的收起來 */
  showOlder: (n: number) => `更早的…（還有 ${n} 份）`,
  showFewer: "只看最近 14 天",
  thisDevice: "這台",
  otherDevice: (deviceId: string) => `另一台 ${deviceId.slice(0, 4).toUpperCase()}`,
} as const;

/**
 * 種類：自動／手動／保險（v1.1.4 修正席・產品評審 S2）。
 * 「保險」＝還原前、改用另一台之前、換鑰匙之前那三份程式自己拍的留底——與桌機本機備份清單的
 * 「保險」chip 同一個字。沒有它的話，主人還原完回來看列表會多一顆「這台・手動」卻不知道那是什麼。
 */
const KIND_LABEL: Record<SnapshotKind, string> = { auto: "自動", manual: "手動", safety: "保險" };

/** 產品評審 S3：預設展開的天數（＝階梯「最近 N 天每份都留」那一層，兩者同一把尺） */
const RECENT_DAYS = 14;

/** 逐字沿 BackupTab 的 fmtSize（WP-C 若要合併成一份，放 store 或 lib） */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** 「這台」／「另一台 A1B2」——鍵名沒有殼別，只有 device_id（見檔頭） */
export function snapshotWho(entry: SnapshotEntry, myDeviceId: string | undefined): string {
  return entry.device_id === myDeviceId ? CLOUD_TEXT.thisDevice : CLOUD_TEXT.otherDevice(entry.device_id);
}

/** 列表一列的字：「9/22 14:03・這台・自動・38 KB」（版面拆成四格，這份給 title 與讀屏用） */
export function describeSnapshot(entry: SnapshotEntry, myDeviceId: string | undefined): string {
  return `${fmtSyncStamp(entry.at)}・${snapshotWho(entry, myDeviceId)}・${KIND_LABEL[entry.kind]}・${fmtBytes(entry.size)}`;
}

export function CloudSnapshots({
  shell,
  choice: sharedChoice,
  onChoiceChange,
}: {
  shell: SyncShell;
  /** 桌機：與〈備份與還原〉上面那組「還原方式」共用同一顆 state（見檔頭）；不給＝自己長一組 */
  choice?: RestoreChoice;
  onChoiceChange?: (choice: RestoreChoice) => void;
}) {
  const status = useSyncStore((s) => s.status);
  const working = useSyncStore((s) => s.working);
  const list = useSyncStore((s) => s.cloudSnapshots);
  const cloudError = useSyncStore((s) => s.cloudError);
  const refresh = useSyncStore((s) => s.refreshCloudSnapshots);
  const snapshotNow = useSyncStore((s) => s.cloudSnapshotNow);
  const restore = useSyncStore((s) => s.cloudRestore);
  const exportToFile = useSyncStore((s) => s.exportToFile);
  const [ownChoice, setOwnChoice] = useState<RestoreChoice>("past");
  /** 產品評審 S3：列表預設只展最近 14 天（兩台 ≈ 28 列＋階梯 21 列＋留底 ≈ 50 列，手機得捲 4000px） */
  const [showAll, setShowAll] = useState(false);
  const configured = !!status?.configured;

  // 開區塊就讀一次列表（純讀、可重入；沿 BackupTab 的 refreshList）
  useEffect(() => {
    if (configured) void refresh();
  }, [configured, refresh]);

  const mobile = shell === "mobile";
  // 沒加入同步＝沒有資料鑰匙＝看不到也拍不了快照。手機的「匯出到手機」已經由 MobileSync 另外放一塊
  //（產品評審 B2），所以這裡整塊收起來；桌機留一句話，免得「舊裝置壞了只剩雲端快照」的主人
  // 在〈備份與還原〉裡看不到雲端區、以為快照沒了（產品評審 Nice）。
  if (!configured) {
    return mobile ? null : (
      <section className="ns-bk-cloud" aria-label={CLOUD_TEXT.title}>
        <span className="techo-label block mb-1">{CLOUD_TEXT.title}</span>
        <p className="ns-note">{CLOUD_TEXT.notJoined}</p>
      </section>
    );
  }

  const shared = sharedChoice !== undefined && !!onChoiceChange;
  const choice = sharedChoice ?? ownChoice;
  const setChoice = onChoiceChange ?? setOwnChoice;
  const chosen = RESTORE_CHOICES.find((c) => c.value === choice) ?? RESTORE_CHOICES[0];
  const noteCls = mobile ? "m2-note" : "ns-note";
  /** 換鑰匙中／改正待ち／鍵違い時雲端這塊只讀（拍快照與還原都會動到紀元與鑰匙） */
  const phase = status?.phase ?? "off";
  const busy = working || phase === "rotating" || phase === "epoch_changed" || phase === "locked";

  /* ── 還原方式：桌機一句話（共用上面那組）／手機自己一組 `.m2-choice` ── */
  const choiceBlock = shared ? (
    <p className={`${noteCls} ns-cl-how`}>{CLOUD_TEXT.restoreHowShared(chosen.label)}</p>
  ) : mobile ? (
    <>
      <span className="m2-block-label m2-cl-sub">{CLOUD_TEXT.restoreHow}</span>
      <div role="radiogroup" aria-label={CLOUD_TEXT.restoreHow} className="m2-choices">
        {RESTORE_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={choice === c.value}
            disabled={busy}
            onClick={() => setChoice(c.value)}
            className={"m2-choice" + (choice === c.value ? " is-on" : "")}
          >
            <span className="m2-choice-label">{c.label}</span>
            <span className="m2-choice-note">{c.consequence}</span>
          </button>
        ))}
      </div>
    </>
  ) : (
    <div className="ns-cl-how">
      <span className="techo-label block mb-2.5">{CLOUD_TEXT.restoreHow}</span>
      <div role="radiogroup" aria-label={CLOUD_TEXT.restoreHow} className="ns-bk-restore-choice">
        {RESTORE_CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={choice === c.value}
            disabled={busy}
            title={c.consequence}
            onClick={() => setChoice(c.value)}
            className={`ns-choice${choice === c.value ? " is-on" : ""}`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="ns-note mt-2">{chosen.consequence}</p>
    </div>
  );

  /* ── 列表（產品評審 S3：預設只展最近 14 天，更舊的收在「更早的…」後面）── */
  //
  // 為什麼是 14 天而不是「最近 N 筆」：階梯的第一層就是「最近 14 天每份都留」，兩者同一把尺，
  // 主人看到的「展開的那一段」與說明文的第一句永遠對得起來；而且裝置多一台時展開的段落自然變長，
  // 不會像固定筆數那樣把今天的兩份擠掉。
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
  const recent = list?.filter((e) => Date.parse(e.at) >= cutoff) ?? [];
  // 一份都沒落在 14 天內（很久沒開 App）＝不能真的什麼都不顯示，退回「最新那一份」
  const head = recent.length > 0 ? recent : list?.slice(0, 1) ?? [];
  const shown = list === null ? [] : showAll ? list : head;
  const hidden = (list?.length ?? 0) - shown.length;

  const moreBtn =
    hidden > 0 || showAll ? (
      <div className={mobile ? "m2-sy-actions" : "ns-bk-actions mt-2"}>
        <button
          type="button"
          className={mobile ? "ns-btn btn-ghost m2-sy-go" : "btn-ghost ns-btn ns-btn--sm"}
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? CLOUD_TEXT.showFewer : CLOUD_TEXT.showOlder(hidden)}
        </button>
      </div>
    ) : null;

  const listBlock =
    list === null ? (
      <p className={noteCls}>{CLOUD_TEXT.loading}</p>
    ) : list.length === 0 ? (
      <p className={noteCls}>{CLOUD_TEXT.listEmpty}</p>
    ) : mobile ? (
      <ul className="m2-cl-list">
        {shown.map((e) => (
          <li key={e.key}>
            <div className="m2-cl-meta">
              <span className="m2-cl-when">{fmtSyncStamp(e.at)}</span>
              <span className="m2-cl-who">
                {snapshotWho(e, status?.device_id)}・{KIND_LABEL[e.kind]}・{fmtBytes(e.size)}
              </span>
            </div>
            <button
              type="button"
              className="ns-btn btn-ghost m2-sy-go m2-cl-restore"
              disabled={busy}
              onClick={() => restore(e, choice)}
            >
              {CLOUD_TEXT.restore}
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <ul className="ns-bk-list">
        {shown.map((e) => (
          <li key={e.key} title={describeSnapshot(e, status?.device_id)}>
            <span className="ns-bk-time">{fmtSyncStamp(e.at)}</span>
            <span className="ns-cl-who">{snapshotWho(e, status?.device_id)}</span>
            <span className="ns-bk-size">{fmtBytes(e.size)}</span>
            <span className="ns-bk-chips">
              <span className="status">{KIND_LABEL[e.kind]}</span>
            </span>
            {/* 確認窗在 store（askConfirm danger）；這裡只把那一顆快照與選擇遞過去 */}
            <button
              type="button"
              className="btn-ghost ns-btn ns-btn--sm ns-bk-restore"
              disabled={busy}
              onClick={() => restore(e, choice)}
            >
              {CLOUD_TEXT.restore}
            </button>
          </li>
        ))}
      </ul>
    );

  /* ── 手機：`.m2-block` 一塊；桌機：備份籤裡一道撕線隔出來的一段 ── */
  if (mobile) {
    return (
      <div className="m2-block m2-cl" aria-label={CLOUD_TEXT.title}>
        <span className="m2-block-label">{CLOUD_TEXT.title}</span>
        <p className="m2-note">{CLOUD_TEXT.intro}</p>
        <p className="m2-note m2-cl-last">{CLOUD_TEXT.lastUpload(status?.last_cloud_snapshot_at ?? null)}</p>
        <div className="m2-sy-actions">
          <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={busy} onClick={() => void snapshotNow()}>
            {CLOUD_TEXT.now}
          </button>
          {/* 手機限定（契約 §7.6）：SAF 讓主人自己選位置；選擇器開不了時退回 App 私有目錄並把路徑講出來 */}
          <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={busy} onClick={() => void exportToFile()}>
            {CLOUD_TEXT.exportMobile}
          </button>
        </div>
        <p className="m2-note">{CLOUD_TEXT.exportNote}</p>
        {cloudError && (
          <p className="m2-note is-fail" role="alert">
            {cloudError}
          </p>
        )}
        {choiceBlock}
        {listBlock}
        {moreBtn}
      </div>
    );
  }

  return (
    <section className="ns-bk-cloud" aria-label={CLOUD_TEXT.title}>
      <span className="techo-label block mb-1">{CLOUD_TEXT.title}</span>
      <p className="ns-note">{CLOUD_TEXT.intro}</p>
      <p className="ns-note ns-cl-last">{CLOUD_TEXT.lastUpload(status?.last_cloud_snapshot_at ?? null)}</p>
      <div className="ns-bk-actions mt-2">
        <button type="button" className="btn-ghost ns-btn ns-btn--sm" disabled={busy} onClick={() => void snapshotNow()}>
          {CLOUD_TEXT.now}
        </button>
      </div>
      {cloudError && (
        <p className="ns-note is-fail ns-cl-err" role="alert">
          {cloudError}
        </p>
      )}
      {choiceBlock}
      {listBlock}
      {moreBtn}
    </section>
  );
}
