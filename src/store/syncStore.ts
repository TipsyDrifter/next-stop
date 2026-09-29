/**
 * syncStore——同步的前端狀態層（契約席立骨架；v1.1.3 由 WP-B 填流程、WP-C 用）。
 *
 * 拍板依據：決策記錄〈v1.1 開工訪談拍板〉P4「開啟即拉＋前景每 60 秒＋手動」＋〈同步與備份規則重整拍板〉
 *           （三條規則：①加入 ②還原 ③重新加入；密語可改）＋《2026-09-21-v1.1.3-同步規則重整契約.md》§4／§6／§8。
 *
 * 紀律（沿 backupStore）：元件不碰 repository、不 invoke，一律經 store；確認窗與 toast 都在 store 裡。
 * 狀態來源＝`syncRepo.status()` 的 `SyncStatus` 原封鏡射（**不自己推導 phase**——phase 是 Rust 算的，
 *   前端再算一次就會有兩份真相）。UI 只多幾顆本地旗標：`working`（有動作在飛）、`formError`／`bridgeError`
 *   （錯誤要留在表單旁邊或整頁頂端，不是 10 秒就消失的 toast）、`pendingChoice`（加入時回了「兩邊都有資料」）。
 *
 * v1.1.3 改了什麼：
 *   * `enablePrimary`／`pairReplica` 退場 → **`join(input)`**（單一入口；兩殼同一個動作）＋`joinWith(mode)`
 *     （頁面問完「兩邊都保留／改用另一台的」再帶 mode 回來）＋`cancelChoice()`。
 *   * `beginNewEpoch` → **`finishRestore()`**（boot 看到 `restore_pending` 就叫；Rust 依標記檔的 choice 做事）；
 *     `prepareRestore(choice, label)` 給 backupStore 在換檔前把選擇落檔。
 *   * 新增 `changePassphrase`、`decodePairingCode`（只填表）。
 *   * 「改用另一台的」／「改用那份」在**桌機**先拍一份 manual 備份，拍不成就不做（提案第三節）。
 *   * `role` 沒了：所有判斷改看 `status.configured`（＝鑰匙圈有資料鑰匙）。
 *
 * v1.1.4 改了什麼（契約席 2026-09-22 立骨架、WP-B 填；契約 §4／§6／§7）：
 *   * 雲端備份：`cloudSnapshots` 列表＋`refreshCloudSnapshots()`／`cloudSnapshotNow()`／`cloudRestore(entry, choice)`
 *     （確認窗在 store，字與桌機本機還原同一套＋一句「來源：雲端快照 <時刻>」）；`runCycle` 成功後順手
 *     `cloudSnapshotAuto()`（引擎判當日；不另起 timer）。
 *   * `changePassphrase(current, next, rotate)`：勾了「同時換掉資料鑰匙」就帶 `rotate=true`。
 *   * `finishRotation()`：boot 看到 `status.rotation_stage` 就叫；`runCycle` 在 `rotating` 時每 60 秒補一次。
 *   * `exportToFile()`：手機先 `plugin-dialog` `save()`（SAF）拿位置，再交給 Rust 寫；桌機／退路不帶 target。
 *   * `describeLocked` 分「換過鑰匙」（`locked_reason='rotated'`）與「殘留」；`SYNC_PHASE_LABEL.rotating`＝「換鑰匙中」。
 *
 * v1.1.6 改了什麼（WP-B；《2026-09-28-v1.1.6-重新開始契約.md》§4／§7；拍板〈回饋兩題拍板〉重新開始＝清空資料庫）：
 *   * `startOver(scope)`：〈備份與還原〉危險區（手機＝「更多」頁尾）兩顆鈕共用的 action。三層保護＝
 *     ①留底（桌機 TS 先拍 manual 本機備份；雲端 Safety 快照／手機匯出由 Rust 拍）→ ②打字確認「清空」
 *     （`ConfirmState.typeToConfirm`）→ ③確認窗講白後果（`START_OVER_TEXT.confirm` 三段拼）。成功不會回來（重啟）。
 *   * `backupBeforeAdopt` 改名 `backupBeforeWipe`：「改用另一台的／改用那份」與「重新開始」三處共用同一道留底。
 *   * 「所有裝置一起」**不新增第四種同步流程**：重啟後走既有 `finishRestore`，`report.reason==="reset"` 只換 toast 與事件
 *     （`reset_done`）；別台走既有改正待ち，`pending_epoch_info.reason==="reset"` 只換字（`describeEpochChange`／`JOIN_CHOICE_TEXT`）。
 *   * `JOIN_FIELDS_HINT`：加入表單四欄上方一句（點子簿 2026-09-28；四欄＝桶的門牌與鑰匙、密語＝打不打得開資料）。
 *
 * 節奏（`boot(shell)` 掛、`stop()` 拆；兩端對稱）：
 *   * 一趟＝**先 push 再 pull**；`SYNC_WRITE_EVENT` 去抖 2 秒、每 60 秒（僅前景）、`visibilitychange`、window focus、手動。
 *   * in-flight 去重；未加入／總開關關著／改正待ち／鍵違い時什麼都不跑。
 */
import { create } from "zustand";
import { syncRepo } from "../data";
import type {
  ExportReport,
  JoinInput,
  JoinMode,
  JoinOutcome,
  JoinReport,
  PairingFields,
  PullReport,
  PushReport,
  RestoreChoice,
  SnapshotEntry,
  StartOverScope,
  SyncStatus,
  WizardEnv,
} from "../data/syncRepository";
import { SYNC_WRITE_EVENT, resetSyncTablesProbe } from "../data/syncRepository";
import { todayKey } from "../lib/date";
import { askNotificationPermissionOnce, notifyOnce, rearmNotify } from "../lib/notify";
import { useBackupStore } from "./backupStore";
import { useNodeStore } from "./nodeStore";
import { useUiStore } from "./uiStore";

/** 拉取／推送節奏（P4）；去抖秒數見 Plan §6 */
export const SYNC_INTERVAL_MS = 60_000;
export const SYNC_PUSH_DEBOUNCE_MS = 2_000;
/**
 * v1.1.5 修正席（產品評審 B2）：一趟失敗之後，自動觸發的冷卻時間。比 60 秒那一拍短一點——
 * 失敗後的下一拍（≥45 秒後）照跑；只擋「改動後 2 秒／focus／visibilitychange」這類密集觸發。
 * ⇒ 連三趟失敗至少要兩個多分鐘（通常三分鐘），「停車中」才會叫。「立即同步」不受限。
 */
export const SYNC_FAIL_BACKOFF_MS = 45_000;
/** 離線時按「立即同步」的字（自動趟離線不打擾） */
export const SYNC_OFFLINE_TOAST = "目前沒有網路——修改先在這台排隊，連上之後會自動補一趟。";

/** 狀態文案（契約 §8；桌機分頁與手機頁共用同一份字） */
export const SYNC_PHASE_LABEL = {
  off: "未加入",
  /** 加入了、總開關關著：關著只停網路，變更照記、開回來補送 */
  paused: "已關閉",
  running: "運行中",
  stopped: "停車中",
  /** 另一台從備份「回到過去」開了新紀元，這台等主人確認「改用那份」——ダイヤ改正＝整本時刻表換新 */
  epoch_changed: "改正待ち",
  gated: "信号待ち",
  /** v1.1.3：雲端血統被別的密語重建，這台的密語打不開——出路是重新加入 */
  locked: "鍵違い",
  /** v1.1.4：這台正在換資料鑰匙（七步；boot 會續跑），push／pull 都停 */
  rotating: "換鑰匙中",
} as const;

/**
 * v1.1.4 改密語表單的勾選（契約 §7；D-3 Bitwarden 式）——兩殼同一份字。
 * 預設不勾＝現行「只重包 KEY」（毫秒級、其他裝置不受影響）；勾了＝換資料鑰匙開新紀元＝真撤銷。
 */
export const PASSPHRASE_ROTATE = {
  label: "同時換掉資料鑰匙（讓舊密語真的失效）",
  // v1.1.4 修正席（產品評審 B1(c)／S-6）：多兩句。
  //   ① 「四欄不用重填」——別台的出路是狀態列那顆「用新密語重新加入」，它用的是那台鑰匙圈裡現成的憑證；
  //      不講的話主人會以為要回桌機開配對碼重掃一次（舊版真的要）。
  //   ② 「在不會離手的那台做」——換鑰匙做到一半的裝置若從此不回來，舊鑰匙的密文要等它回來才刪得掉，
  //      「真撤銷」就沒做完。拿手機做這件事再把手機弄丟，正好是最該避免的組合。
  warning:
    "其他裝置會停在「鍵違い」，要用新密語「重新加入同步」——它們還沒送出的修改會在加入時一起併進來（選「兩邊都保留」）。" +
    "那些裝置只要打新密語，雲端的四個欄位不用重填。換鑰匙前請先讓所有裝置同步完，並且在不會離手的那一台做。",
  /** 勾了卻沒打現密語（自決 4：換鑰匙必須證明你有現密語）。
   *  2026-09-25 主人真機驗收問「忘了密語怎麼辦」：舊文案叫人走「重新加入」是錯的（重新加入也要密語）。
   *  正確的救援＝兩步：先不勾、現密語留白設一個新密語（這台鑰匙圈有資料鑰匙，用不到舊密語），
   *  再用新密語當現密語回來勾換鑰匙。 */
  needCurrent:
    "要換鑰匙得先打現在的密語。忘了？先把這格勾掉、現密語留白設一個新密語，再用新密語回來勾「換鑰匙」。",
  /** 換鑰匙中的狀態列下一行 */
  inProgress: "正在換資料鑰匙——這段期間不推不拉，做完會自動接回。中途關掉 App 也沒關係，下次打開會接著做完。",
} as const;

/**
 * v1.1.4 修正席（產品評審 B1）：鍵違い（`locked_reason='rotated'`）那一塊的字——**兩殼同一份**。
 *
 * 為什麼要獨立一塊而不是叫主人去按頁尾的「重新加入同步」：那顆按下去是 `reset_local`，
 * 會把憑證與身分一起清掉（四欄空白、要回另一台開配對碼重掃）；而旁邊那顆「更新憑證…」的表單
 * 寫著「密語打**現在這一句**……資料、身分與紀元都不會動」——照字打舊密語只會得到「密語不對」。
 * 這一塊給的是第三條、也是唯一對的路：四欄沿用、只換密語，走的仍是既有的 ③ 加入（不是新規則）。
 */
export const REJOIN_ROTATED = {
  title: "用新密語重新加入",
  note: "四個欄位不用改（用的是這台已經存好的那組）——只要打另一台換好的新密語。接著會問要不要合併，選「兩邊都保留」，這台還沒送出的修改會一起併進來。忘了新密語？按下面的「重新加入同步」（四欄要重填），在加入表單改用復原碼。",
  placeholder: "新密語",
  submit: "用新密語重新加入",
  /** 鍵違い時「更新憑證…」那顆改的字（它的表單是「四欄換新、密語打現在這一句」，在這一態會把人帶錯路） */
  credsHint: "只是換 Cloudflare 的 API token 才用「更新憑證…」；現在該走上面那一條。",
} as const;

/**
 * v1.1.4 修正席（產品評審 S4）：「兩邊都有資料」二選一與「改用那份」確認窗的字——**兩殼同一份**。
 *
 * v1.1.3 各自寫了一份，於是分岔成三處：桌機「N 個裝置目錄」／手機「N 台裝置在用」（產品評審 N2 只修了桌機）；
 * 「改用」的留底小字桌機講「會先自動備份一份」、手機沒講；改正待ち的確認窗也只有桌機講留底。
 * 兩殼真的各走各的留底（桌機＝本機 manual 備份／手機＝雲端 manual 快照），所以字要**分殼但同源**。
 */
export const JOIN_CHOICE_TEXT = {
  // `remote_devices` 數的是雲端的裝置目錄，每次「重新加入」都留下一個死身分 ⇒ 不講「N 台裝置在用」（N2）
  // v1.1.6 修正席（工程評審 S-1）：雲端目前那份是另一台「所有裝置一起重新開始」開的空紀元時，Rust 也會問二選一
  //（不再另開第三個紀元）——此時裝置目錄恆為 0（有目錄＝有資料＝一般那句），用它挑字，不為此多加回報欄位。
  lead: (devices: number, alive: number) =>
    devices === 0
      ? `雲端上是另一台「重新開始」之後的空的一份，這台還有 ${alive} 張活著的票。要怎麼做？（「改用另一台的」＝這台也一起清空；「兩邊都保留」＝把這台的票送上去給所有裝置）`
      : `雲端上已有一份（${devices} 個裝置目錄），這台也有 ${alive} 張活著的票。要怎麼做？`,
  merge: "兩邊都保留",
  mergeNote: "兩邊的資料合併，同一格以後改的為準。",
  adopt: "改用另一台的",
  /** 留底講法分殼：桌機拍本機備份、手機拍雲端快照（v1.1.4 契約 §6-6） */
  adoptNote: (shell: SyncShell) =>
    shell === "mobile"
      ? "這台現有的會先拍一份到雲端，再換成雲端那份。"
      : "會先自動備份一份到這台的備份資料夾，再換成雲端那份。",
  /**
   * 改正待ち的確認窗 body（「改用那份」）；留底那半同樣分殼。
   * v1.1.6（重新開始契約 §6.4／§7）：`reason==="reset"`（另一台按了「所有裝置一起重新開始」）換成「一起清空」的講法；
   * 其餘 reason 一字不改（省略 reason＝v1.1.5 的呼叫法，同樣走原句）。
   */
  adoptEpochBody: (shell: SyncShell, reason?: string) =>
    reason === "reset"
      ? "這台的車票與記錄會全部清空；" +
        (shell === "mobile" ? "會先拍一份到雲端，" : "會先自動備份一份，") +
        "還沒送出的修改另存成檔、不會自動併回。"
      : "這台現有的車票與記錄會被那份取代；" +
        (shell === "mobile" ? "會先拍一份到雲端，" : "會先自動備份一份，") +
        "還沒送出的修改另存成檔、不會自動併回。",
  /** v1.1.6：改正待ち主鈕（與確認窗的確認鈕）的字——reset＝「一起清空」，其餘照舊「改用那份」 */
  adoptLabel: (reason?: string) => (reason === "reset" ? "一起清空" : "改用那份"),
  /**
   * v1.1.6（WP-B 自決：契約 §6.4 只定了區塊標題與鈕字，確認窗標題沒寫）：改正待ち那一塊的標題與確認窗標題。
   * reset 的確認窗若照舊問「要改用那份嗎？」，按鈕卻寫「一起清空」＝同一個窗兩種講法。
   */
  epochHeading: (reason?: string) => (reason === "reset" ? "另一台重新開始了" : "另一台裝置從備份還原了"),
  adoptEpochTitle: (reason?: string) => (reason === "reset" ? "要一起清空嗎？" : "要改用那份嗎？"),
} as const;

/**
 * v1.1.6（重新開始契約 §7，**逐字**）：危險區「重新開始」的字——兩殼同一份。
 * 確認窗 body＝留底句（分殼、分加入與否）＋動作句＋收尾句，由 `startOver` 拼（`startOverBody`）。
 */
export const START_OVER_TEXT = {
  sectionTitle: "危險區",
  lead: "重新開始＝把這台的車票、班次與乘務記錄全部清掉，只留主題等設定。清掉之前會先留一份備份。",
  thisDevice: {
    label: "只清這台",
    noteJoined: "先拿掉這台的同步設定，再清資料——其他裝置與雲端上的資料都不動；之後想再同步就按「加入同步」，會把雲端那份拉回來。",
    noteAlone: "只清這台的資料，設定保留。",
  },
  allDevices: {
    label: "所有裝置一起重新開始",
    note: "雲端換上一份空的；其他裝置下次同步會被問要不要一起清空（各自會先留一份）。同步身分與密語都保留。",
    disabledTitle: "這台還沒加入同步，只能清這台。",
  },
  confirm: {
    typeWord: "清空",
    typeHint: "輸入「清空」兩個字才能按下去",
    confirmLabel: "清空",
    titleThis: "把這台清空？",
    titleAll: "所有裝置一起重新開始？",
    // body 由三段拼：留底句（分殼、分加入與否）＋動作句＋收尾句
    keepDesktopAlone: "會先在這台備份一份，",
    keepDesktopJoined: "會先在這台備份一份、再上傳一份到雲端保險用，",
    keepMobileJoined: "會先拍一份到雲端保險用，",
    // 修正席（工程評審 S-5）：手機未加入時先走 SAF 讓主人自己選位置（例如「下載」）——Rust 的預設落點
    // `download_dir()` 在 Android 是 App 私有目錄，主人看不到、移除 App 就消失。
    keepMobileAlone: "會先請你選一個位置（例如「下載」）把整份資料匯出成一個檔，",
    // 修正席（產品評審 #2）：已加入版補一句「雲端與別台都還在」——主人想「整個清乾淨」時會先按這顆較溫和的鈕，
    // 清完再加入又全拉回來；桌機這句原本只在 hover 的 title 裡。
    actThisJoined: "然後拿掉這台的同步設定、清空所有車票與記錄。設定會留下。雲端與其他裝置的資料都還在，之後加入同步會拉回來。",
    actThisAlone: "然後清空所有車票與記錄。設定會留下。",
    actAll: "然後清空這台、讓雲端換上空的一份。其他裝置下次同步會被問要不要一起清空。",
    // 修正席（工程評審 S-4）：留底會過期，講白。本機 manual 與每日 auto 共用保留份數（重新開始後每天拍的是空庫）；
    // 雲端階梯清理 14 天內全留、之後每週只留最新一份（那週之後的每日空庫快照會取代那顆保險）。
    regretDesktopAlone: "後悔要趁早：這台那份會隨之後每天的自動備份輪替掉（保留幾份就約幾天）。",
    regretDesktopJoined: "後悔要趁早：這台那份會隨之後每天的自動備份輪替掉（保留幾份就約幾天），雲端那份兩週內一定救得回。",
    regretMobileJoined: "後悔要趁早：雲端那份兩週內一定救得回。",
    regretMobileAlone: "那個檔只能人工翻閱（App 目前不能匯入）。",
    endDesktop: "完成後 App 會重新啟動。",
    endMobile: "完成後 App 會關閉，請重新打開。",
  },
  /**
   * 修正席（產品評審 #3／工程評審 S-7）：開窗前就擋得下的情況，**逐字**用 Rust `START_OVER_ERR_*` 那幾句
   *（Rust 仍是最後一道；TS 先擋只是為了不讓主人打完「清空」、桌機白拍一份 manual 才被擋）。
   */
  blockedRestorePending: "先讓上一次的還原收尾完成（重新啟動 App 就會自動做）。",
  blockedUnsettledThis:
    "這台的同步狀態還沒處理完（改正待ち／鍵違い／換鑰匙中）——先到同步頁處理，或先「重新加入同步」拿掉這台的同步，再重新開始。",
  blockedUnsettledAll: "這台的同步狀態還沒處理完（改正待ち／鍵違い／換鑰匙中）——先到同步頁處理，再重新開始。",
  /** 修正席（工程評審 S-6）：按下「清空」時背景那一趟還在飛、等了一陣仍沒完（與 Rust BusyGuard 的句子同） */
  busy: "同步正在進行中，請稍候再試。",
  /** 修正席（工程評審 S-5）：手機未加入、SAF 選位置時按了取消／寫不進去 */
  exportCancelled: "沒有選匯出的位置（這台一個字都沒動）。",
  exportFellBack: (path: string) =>
    `寫不進你選的位置（這台一個字都沒動；另存了一份在 ${path}，你選的位置可能留下一個空檔，可以刪掉）。`,
  failed: (e: string) => `重新開始沒有執行：${e}`,
} as const;

/**
 * 修正席（產品評審 #3／工程評審 S-7）：目前狀態下「重新開始」會不會被 Rust 擋——會就回那一句（null＝放行）。
 * 條件與 Rust `start_over` 同：還原沒收尾；已加入且改正待ち（`pending_epoch`）／鍵違い（`locked`）／換鑰匙中（`phase==="rotating"`）。
 * 未加入按「所有裝置一起」由呼叫端另擋（沿 WP-B 那句）。純函式，方便沙盒與 mock 對字。
 */
export function startOverBlockedBy(scope: StartOverScope, status: SyncStatus | null): string | null {
  if (!status) return null;
  if (status.restore_pending) return START_OVER_TEXT.blockedRestorePending;
  if (status.configured && (!!status.locked || !!status.pending_epoch || status.phase === "rotating")) {
    return scope === "all_devices" ? START_OVER_TEXT.blockedUnsettledAll : START_OVER_TEXT.blockedUnsettledThis;
  }
  return null;
}

/** v1.1.6：「只清這台」鈕的說明（title／手機攤在鈕下）——已加入與否兩種講法 */
export function startOverThisNote(joined: boolean): string {
  return joined ? START_OVER_TEXT.thisDevice.noteJoined : START_OVER_TEXT.thisDevice.noteAlone;
}

/** v1.1.6：確認窗 body＝留底句＋動作句＋收尾句（契約 §7 的拼法；「所有裝置一起」必然已加入） */
export function startOverBody(scope: StartOverScope, shellName: SyncShell, joined: boolean): string {
  const c = START_OVER_TEXT.confirm;
  const j = scope === "all_devices" || joined;
  const keep =
    shellName === "desktop" ? (j ? c.keepDesktopJoined : c.keepDesktopAlone) : j ? c.keepMobileJoined : c.keepMobileAlone;
  const act = scope === "all_devices" ? c.actAll : j ? c.actThisJoined : c.actThisAlone;
  const regret =
    shellName === "desktop" ? (j ? c.regretDesktopJoined : c.regretDesktopAlone) : j ? c.regretMobileJoined : c.regretMobileAlone;
  return keep + act + regret + (shellName === "desktop" ? c.endDesktop : c.endMobile);
}

/**
 * v1.1.6（點子簿 2026-09-28「加入表單四欄說明」；契約 §6.3／§7 逐字）：加入表單四欄上方一句。
 * 主人真機驗收時分不清「四欄」與「密語」各管什麼——一個是去哪個桶找，一個是打不打得開。
 */
export const JOIN_FIELDS_HINT =
  "這四行是 R2 桶的門牌與鑰匙（去哪個桶找資料）；密語是另一回事（打不打得開資料）。用另一台的配對碼或精靈就會自動填好。";

/**
 * 修正席（產品評審 #5）：手機版——手機沒有精靈，而「配對碼（省手打）」那段正上方已經講了「配對碼只含雲端憑證，
 * 密語要親手打」，這裡只留「四欄與密語各管什麼」那半句，不重疊。
 */
export const JOIN_FIELDS_HINT_MOBILE = "這四行是 R2 桶的門牌與鑰匙（去哪個桶找資料）；密語是另一回事（打不打得開資料）。";

/* ═══════════════════════════════════════════════════════════════════════
   v1.1.5 告警模型（契約 §2；契約席立、WP-B 填偵測、WP-C 讀文案）
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * 橫幅／通知的六種告警（拍板 D-1.1.5-1：轉入改正待ち／鍵違い／停車中（連續 3 趟）／信号待ち 四態告警；
 * `needs_passphrase` 是復原碼救援後的「請設新密語」，沿用同一套機制）。**paused（主人自己關）不告警。**
 * `locked` 依 `locked_reason` 分兩種字：`rotated`＝另一台換過鑰匙（出路：用新密語重新加入）；
 * 其餘（`stale`／`locked='salt'`）＝雲端有這台打不開的東西（出路：看同步頁）。
 */
export type SyncAlertKind =
  | "epoch_changed"
  /** v1.1.6 修正席（產品評審 #1／工程評審 S-2）：改正待ち、而那個新紀元是另一台按「所有裝置一起重新開始」開的 */
  | "epoch_reset"
  | "locked_rotated"
  | "locked_stale"
  | "stopped"
  | "gated"
  | "needs_passphrase";

/**
 * 一次性事件（toast＋一則通知）：換鑰匙完成／還原完成（回到過去或接上現在）。
 * v1.1.5 修正席（產品評審 S4）：拿掉 `adopt_done`——「改用那份」是主人自己按、毫秒完成、toast 已講，再彈一則系統通知是噪音。
 * 換鑰匙（耗時、人可能走開）與還原（重啟之後）才有理由多一則。
 */
export type SyncEventKind = "rotation_done" | "restore_done" | "reset_done";

/** 停車中的告警門檻：`fail_streak ≥ 3` 才叫（網路抖一下不叫；契約 §2.3） */
export const SYNC_STOPPED_ALERT_STREAK = 3;

/**
 * 六種告警的字——**兩殼同一份、不含票名**（Plan 技術自決：通知只講狀態＋一句出路）。
 * `banner`＝主畫面橫幅一行；`cta`＝主鈕字（一律「前往同步」，出路的細節寫在同步頁）；`notifTitle`／`notifBody`＝OS 通知。
 */
export const SYNC_ALERT_TEXT: Record<SyncAlertKind, { banner: string; cta: string; notifTitle: string; notifBody: string }> = {
  epoch_changed: {
    banner: "改正待ち：另一台裝置換上了一份新的資料，這台要改用那份才會繼續同步。",
    cta: "前往同步",
    notifTitle: "私鐵手帳・同步停在改正待ち",
    notifBody: "另一台裝置換上了一份新的資料。打開同步頁按「改用那份」。",
  },
  // v1.1.6 修正席：reset 版——同步頁的鈕叫「一起清空」，通知與橫幅不能叫主人去按一顆不存在的「改用那份」
  epoch_reset: {
    banner: "改正待ち：另一台按了重新開始，這台要一起清空才會繼續同步。",
    cta: "前往同步",
    notifTitle: "私鐵手帳・同步停在改正待ち",
    notifBody: "另一台按了重新開始。打開同步頁按「一起清空」。",
  },
  locked_rotated: {
    banner: "鍵違い：這份資料已在另一台換過鑰匙，這台要用新密語重新加入。",
    cta: "前往同步",
    notifTitle: "私鐵手帳・同步停在鍵違い",
    notifBody: "另一台換過鑰匙了。打開同步頁，用新密語重新加入。",
  },
  locked_stale: {
    banner: "鍵違い：雲端上有這台的密語打不開的東西，同步先停在這裡。",
    cta: "前往同步",
    notifTitle: "私鐵手帳・同步停在鍵違い",
    notifBody: "雲端上有這台打不開的東西。打開同步頁看出路。",
  },
  stopped: {
    banner: "停車中：同步已經連續三趟沒成功，修改先在這台排隊。",
    cta: "前往同步",
    notifTitle: "私鐵手帳・同步連續失敗",
    notifBody: "已經連續三趟沒同步成功。打開同步頁看原因。",
  },
  gated: {
    banner: "信号待ち：兩台的版本不一致，請先更新較舊的那一台。",
    cta: "前往同步",
    notifTitle: "私鐵手帳・同步停在信号待ち",
    notifBody: "兩台的版本不一致。更新較舊的那一台後會自動接回。",
  },
  needs_passphrase: {
    banner: "這台是用復原碼加入的，請設一個新密語（其他裝置之後要用它加入）。",
    cta: "前往同步",
    notifTitle: "私鐵手帳・請設一個新密語",
    notifBody: "這台是用復原碼加入的。到同步頁的〈密語〉設一個新密語。",
  },
};

/** 橫幅「先收起」鈕的字（D-1.1.5-2：可關、下次啟動再出） */
export const SYNC_BANNER_DISMISS = "先收起";

/** 一次性事件的字（toast 沿用 Rust 回的 `message`，這裡只放通知；`toast` 是 Rust 沒給字時的退路） */
export const SYNC_EVENT_TEXT: Record<SyncEventKind, { toast: string; notifTitle: string; notifBody: string }> = {
  rotation_done: {
    toast: "換鑰匙完成——其他裝置要用新密語重新加入。",
    notifTitle: "私鐵手帳・換鑰匙完成",
    notifBody: "資料鑰匙已換新。其他裝置要用新密語重新加入。",
  },
  restore_done: {
    toast: "還原後的同步收尾完成。",
    notifTitle: "私鐵手帳・還原完成",
    notifBody: "還原後的同步已接回。",
  },
  /** v1.1.6（重新開始契約 §7 逐字）：「所有裝置一起重新開始」重啟後的收尾（`finishRestore` 的 `reason==="reset"`） */
  reset_done: {
    toast: "已重新開始——雲端換上了空的一份；其他裝置下次同步會被問要不要一起清空。",
    notifTitle: "私鐵手帳・重新開始完成",
    notifBody: "雲端已換上空的一份，其他裝置下次同步會被問要不要一起清空。",
  },
};

/**
 * 狀態 → 該出哪一種告警（null＝沒有）。**純函式**，phase 仍是 Rust 算的，這裡只做映射不推導。
 * 順序＝phase 的優先序（改正待ち＞鍵違い＞信号待ち＞停車中）；四態都沒有時才看 `needs_passphrase`。
 * `stopped` 要 `fail_streak ≥ 3`；`paused`／`rotating`／`off`／`running` 一律 null。
 * `stoppedArmed=false`（v1.1.5 修正席／產品評審 B2 ②）：本進程還沒自己跑完一趟 ⇒ 持久化的 `fail_streak` 可能是昨晚斷網留下的，
 * 先不算停車中（其餘告警照算）。預設 true，純函式的語意不變。
 */
export function alertKindOf(status: SyncStatus | null, stoppedArmed = true): SyncAlertKind | null {
  if (!status || !status.configured) return null;
  switch (status.phase) {
    case "epoch_changed":
      return status.pending_epoch_info?.reason === "reset" ? "epoch_reset" : "epoch_changed";
    case "locked":
      return status.locked_reason === "rotated" ? "locked_rotated" : "locked_stale";
    case "gated":
      return "gated";
    case "stopped":
      return stoppedArmed && status.fail_streak >= SYNC_STOPPED_ALERT_STREAK
        ? "stopped"
        : status.needs_passphrase
          ? "needs_passphrase"
          : null;
    case "running":
      return status.needs_passphrase ? "needs_passphrase" : null;
    default:
      return null;
  }
}

/**
 * 上一次算出來的告警種類（模組層；只活在本次啟動）。boot 的第一趟 status 也算「轉入」——
 * 拍板 D-1.1.5-2 說橫幅「下次啟動再出」，通知跟著同一條規則：狀態未解除，每次啟動一則（不是每 60 秒一則）。
 */
let lastAlertKind: SyncAlertKind | null = null;

/**
 * 轉變偵測（契約 §2.4）：每次拿到新狀態就比對——轉入告警態 ⇒ 橫幅＋一則通知；離開 ⇒ 橫幅消失；同態不重發。
 * 呼叫點＝所有「拿到一份新 status」的地方：`refreshStatusInner`（runCycle 成敗／boot／join／rejoin／adoptEpoch／
 * finishRestore／finishRotation／changePassphrase 之後都經過它），加上直接收 Rust 回傳 status 的 `setEnabled`／`reset`
 * （不補這兩處，關總開關後橫幅要等下一個 60 秒才消失——而關著時根本不會有下一趟）。
 *
 * 離開某種告警時 `rearmNotify(舊 kind)`：下一次**再轉入**同一種是新的一次、該再響一則（拍板「轉入時一則」；
 * 契約 §7 甲4「關總開關再開回改正待ち ⇒ 再一筆」靠這個）。停留在同一態＝`kind === lastAlertKind` 直接 return，不會重發。
 */
function evaluateAlerts(status: SyncStatus | null): void {
  const kind = alertKindOf(status, cycleRanThisProcess);
  if (kind === lastAlertKind) return;
  if (lastAlertKind) rearmNotify(lastAlertKind);
  lastAlertKind = kind;
  useUiStore.getState().setSyncBanner(kind);
  if (kind) {
    const t = SYNC_ALERT_TEXT[kind];
    void notifyOnce(kind, { title: t.notifTitle, body: t.notifBody }, false, shell);
  }
}

/** 一次性事件：一則通知（toast 由各 action 自己出，沿用 Rust 的 message） */
function fireSyncEvent(kind: SyncEventKind): void {
  const t = SYNC_EVENT_TEXT[kind];
  void notifyOnce(kind, { title: t.notifTitle, body: t.notifBody }, true, shell);
}

/**
 * v1.1.5 復原碼的字（契約 §6.3；兩殼同一份）。
 * 設定頁一區「復原碼」：未設＝一句說明＋「產生復原碼」；已設＝「已設定」＋「重新產生（舊碼作廢）」。
 * 一次性對話框：碼＋「複製」＋勾選「我已抄下」才能關；三句提醒。
 */
export const RECOVERY_TEXT = {
  title: "復原碼",
  intro: "忘了密語時的最後一條路：任何一台還沒加入同步的裝置都能用這組碼加入、拿回資料，然後設一個新密語。",
  unset: "未設定",
  set: "已設定",
  generate: "產生復原碼",
  regenerate: "重新產生（舊碼作廢）",
  clear: "作廢復原碼",
  /** 重新產生前的確認窗 */
  regenerateConfirmTitle: "要重新產生復原碼嗎？",
  regenerateConfirmBody: "現在這組碼會立刻作廢，之後只有新的那組能用。新碼一樣只顯示一次。",
  regenerateConfirmLabel: "重新產生",
  clearConfirmTitle: "要作廢復原碼嗎？",
  clearConfirmBody: "作廢之後忘了密語就沒有這條路了（隨時可以再產生一組新的）。",
  clearConfirmLabel: "作廢",
  /** 一次性顯示對話框 */
  dialogTitle: "你的復原碼",
  dialogOverline: "只顯示這一次",
  dialogLead: "抄下來、收在密語以外的地方（紙上、密碼管理器）。關掉這個視窗之後就再也看不到它了。",
  copy: "複製",
  copied: "已複製",
  ack: "我已抄下這組碼",
  close: "我已抄下，關閉",
  notes: [
    "換鑰匙時在這一台做，這組碼仍有效；在別台換鑰匙或重新產生，舊碼就作廢（App 會提醒）。",
    "它只在還沒加入同步的裝置「加入同步」時使用（這台本來有資料也行，會問要不要合併）；已加入的裝置改密語不需要它（現密語留白即可）。",
    "任何拿到這組碼、又拿得到你雲端置物櫃的人都能讀你的資料——請當成密語一樣保管。",
  ],
  /** 加入表單的切換（契約 §6.4） */
  joinToggle: "忘記密語？用復原碼",
  joinToggleBack: "改回用密語",
  joinLabel: "復原碼",
  joinPlaceholder: "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX",
  joinNote: "27 個字，連字號與大小寫都可以不管。加入成功後會請你設一個新密語。",
  joinSubmit: "用復原碼加入",
  /** 換鑰匙後這台沒有 W、RECOVERY 被作廢時的 toast 尾句（Rust `RotationReport.message` 已含；這裡是退路） */
  invalidatedByRotation: "復原碼已作廢，請到〈同步〉重新產生一組。",
} as const;

/** v1.1.4 契約 §7：跳過筆數那一行（`skipped_missing_total > 0` 才顯示） */
export function describeSkipped(n: number): string {
  return `有 ${n} 筆從其他裝置來的資料因欄位不齊而略過（多半是較舊版本或損壞的同步資料）；重新加入時選「兩邊都保留」可以補回。`;
}

/** 加入成功的 toast（Rust 的 `message` 為空時退回這份；契約 §8.1） */
const JOIN_TOAST: Record<Exclude<JoinOutcome, "needs_choice">, string> = {
  first: "已加入——這台是第一台，資料正在上傳",
  pulled: "已加入——雲端的資料已拉下來",
  merged: "已加入——兩邊的資料已合併，較晚改的為準",
  adopted: "已改用另一台的資料",
  reconnected: "憑證已更新，資料照舊",
};

export type SyncShell = "desktop" | "mobile";

/**
 * `prepareRestore` 的結果（backupStore 據此決定要不要繼續還原）：
 *   ok         → 選擇已落檔，Rust 換檔時會把它併進標記檔
 *   not-joined → 這台沒加入同步（鑰匙圈在上次 status 之後被清掉也算）＝還原不牽動任何裝置，照常還原
 *   failed     → 真的寫不進去。標記檔會退回預設的「回到過去」——選「接上現在」的人不能就這樣還原下去
 */
export type RestorePrep = "ok" | "not-joined" | "failed";

export interface SyncStore {
  /** 最近一次 `status()` 的鏡射；null＝還沒問過，或橋接不通（看 `bridgeError`） */
  status: SyncStatus | null;
  /** 首次 boot 尚未跑完 */
  booting: boolean;
  /** 「顯示配對碼」產出的配對碼（顯示 QR 與可複製文字）；null＝沒有或已收起 */
  pairingCode: string | null;
  /** 有動作在飛（join／push／pull／reset／改密語）——鈕鎖起來、狀態點呼吸 */
  working: boolean;
  /** `sync_status()` 自己都叫不動（command 尚未註冊／非 Tauri 環境）；非 null＝整頁改顯示一句人話 */
  bridgeError: string | null;
  /** 表單旁邊的錯誤（加入失敗、密語不對…）；要留在原地給人讀，不用 toast */
  formError: string | null;
  /** 加入時回了「兩邊都有資料」：頁面據此顯示二選一區塊（契約 §8.2）；null＝沒有待答 */
  pendingChoice: JoinReport | null;
  /** v1.1.4：雲端快照列表（新到舊）；null＝還沒讀過或沒加入 */
  cloudSnapshots: SnapshotEntry[] | null;
  /** v1.1.4：列表讀取失敗的人話（留在雲端備份區塊旁） */
  cloudError: string | null;
  /**
   * v1.1.5：剛產生的復原碼（顯示形）——**只活在這個對話框開著的期間**；`closeRecoveryDialog` 一定清掉。
   * 它不在 Rust 的任何回傳裡第二次出現，也不寫 log／settings。
   */
  recoveryDisplay: string | null;

  /** 啟動鉤子（App.tsx 在 loadSettings 之後叫；可重入）。shell 決定重載哪個畫面與「改用」前拍不拍備份。 */
  boot: (shell: SyncShell) => Promise<void>;
  /** 拆節奏（App 卸載／殼切換時） */
  stop: () => void;
  refreshStatus: () => Promise<void>;
  /** 單一入口「加入同步」：回 needs_choice 就存起來等 `joinWith`；其餘依報告收尾（push／重載／toast） */
  join: (input: JoinInput) => Promise<void>;
  /** 頁面問完「兩邊都保留」／「改用另一台的」再帶 mode 回來；桌機選改用前先拍 manual 備份 */
  joinWith: (mode: JoinMode) => Promise<void>;
  /**
   * v1.1.4 修正席（產品評審 B1）：**用新密語重新加入**——四欄沿用這台鑰匙圈現成那組，只問密語。
   * 鍵違い（`locked_reason='rotated'`）唯一走得通的那條路；回 `needs_choice` 時同樣交給 `joinWith`。
   */
  rejoin: (passphrase: string) => Promise<void>;
  /** 收起二選一，什麼都沒動 */
  cancelChoice: () => void;
  /** 改密語：成功回 true（toast）、失敗回 false（人話在 formError）。v1.1.4：`rotate=true`＝連資料鑰匙一起換 */
  changePassphrase: (current: string, next: string, rotate?: boolean) => Promise<boolean>;
  /** 還原對話框的選擇先落檔（backupStore 在換檔前叫）；回傳三態見 `RestorePrep` */
  prepareRestore: (choice: RestoreChoice, label?: string) => Promise<RestorePrep>;
  /** 還原沒做成時把選擇檔收掉（工程評審 S-5）；失敗不吭聲——它只是個殘留檔 */
  clearRestoreChoice: () => Promise<void>;
  /** 重啟後的還原收尾（boot 看到 `restore_pending` 自動叫）：renewed ⇒ push；resumed ⇒ 跑一趟 */
  finishRestore: () => Promise<void>;
  /** 改正待ち→「改用那份」：桌機先拍備份 → `adoptEpoch()` → 立刻 `pull()` 全量 */
  adoptEpoch: () => Promise<void>;
  /** 「立即同步」 */
  syncNow: () => Promise<PushReport | PullReport | null>;
  /** 總開關 */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** 「重設」＝③重新加入的「拿掉」：askConfirm(danger) → `resetLocal()`；不碰資料列、不碰雲端 */
  reset: () => void;
  /** 產出配對碼（任何已加入裝置） */
  showPairingCode: () => Promise<void>;
  hidePairingCode: () => void;
  /** 解配對碼回四欄填表；null＝解不開（人話已放 formError） */
  decodePairingCode: (code: string) => Promise<PairingFields | null>;
  /** 桌機「從精靈匯入」：回四欄給表單填；null＝讀不到（人話已放 formError） */
  importWizardEnv: () => Promise<WizardEnv | null>;
  /** 清掉表單旁的錯誤（使用者重打時） */
  clearFormError: () => void;
  /* ── v1.1.4 雲端備份（契約 §4／§6）── */
  /** 重讀雲端快照列表（開雲端備份區塊時叫；沒加入＝清成 null） */
  refreshCloudSnapshots: () => Promise<void>;
  /** 「立即備份到雲端」：拍一份 manual → 重讀列表 → toast */
  cloudSnapshotNow: () => Promise<void>;
  /** 點列表一份 → 確認窗（二選一的後果句＋「來源：雲端快照 <時刻>」）→ `cloudRestore`（成功不會回來） */
  cloudRestore: (entry: SnapshotEntry, choice: RestoreChoice) => void;
  /** 手機「匯出到手機」：SAF 選位置 → Rust 寫；桌機／退路不帶 target。null＝主人取消 */
  exportToFile: () => Promise<ExportReport | null>;
  /** 換鑰匙續跑（boot／runCycle 看到 `rotation_stage` 就叫） */
  finishRotation: () => Promise<void>;
  /* ── v1.1.5 復原碼（契約 §4／§6）── */
  /** 「產生復原碼」／「重新產生」：成功 ⇒ `recoveryDisplay` 有值、UI 開一次性對話框；失敗 ⇒ formError */
  generateRecoveryCode: () => Promise<void>;
  /** 對話框關閉（勾了「我已抄下」才能按）：清 `recoveryDisplay` */
  closeRecoveryDialog: () => void;
  /** 「作廢復原碼」：askConfirm → `recoveryClear()` → 重讀狀態 */
  clearRecoveryCode: () => void;
  /* ── v1.1.6 重新開始（契約 §4.2）── */
  /**
   * 危險區兩顆鈕：開確認窗（打字「清空」）→ onConfirm 才跑：桌機先拍 manual 本機備份（拍不成就停）→
   * `syncRepo.startOver(scope)`（成功不會回來）→ 失敗 toast `重新開始沒有執行：…`。桌機未加入也走這條。
   */
  startOver: (scope: StartOverScope) => void;
}

/* ═══════════════════════════════════════════════════════════════════════
   節奏（模組層；store 之外，因為它們是「這個分頁掛了幾顆計時器」而不是狀態）
   ═══════════════════════════════════════════════════════════════════════ */

let shell: SyncShell = "desktop";
let timer: number | null = null;
let debounceTimer: number | null = null;
let writeHandler: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
let focusHandler: (() => void) | null = null;
let focusTimer: number | null = null;
/** v1.1.5 修正席（產品評審 B2）：網路回來那一刻補一趟（離線時 runCycle 整趟不跑，見 runCycle 開頭） */
let onlineHandler: (() => void) | null = null;
/**
 * v1.1.5 修正席（產品評審 B2）：上一趟**失敗**的時刻。失敗之後，自動觸發（改動後 2 秒／focus／visibilitychange／
 * 網路回來／rerun）在 `SYNC_FAIL_BACKOFF_MS` 內一律不跑，只剩 60 秒那一拍與「立即同步」——
 * 否則離線改三張票就是三趟失敗、`fail_streak` 兩分鐘內到 3 叫出「停車中」，違反「網路斷一下不該叫」。
 * 成功一趟就歸零。
 */
let lastFailAt = 0;
/**
 * v1.1.5 修正席（產品評審 B2 ②）：這個進程有沒有**真的跑完過一趟** push／pull（成敗不論）。
 * `fail_streak` 是持久化的——闔上筆電前 Wi-Fi 先斷、累到 3，隔天開機第一份 status 就會叫「停車中」、一分鐘後自己解。
 * 所以 `stopped` 要等本進程自己跑過一趟之後才評估：真的還壞（憑證過期）⇒ 開機那一趟跑完就叫；只是昨晚斷網 ⇒ 不叫。
 */
let cycleRanThisProcess = false;
/** 通知權限詢問進行中（boot 與 settleJoin 可能撞在一起；只問一次） */
let notifAskInflight = false;
/** 同時只跑一趟（Rust 端也有一道；前端先擋一次，省掉來回） */
let inflight = false;
/** 撞到 in-flight 的那一趟不丟掉：記旗標，當前那趟收尾時補跑（v1.1.2 評審 S5） */
let rerun = false;
/** 還原收尾失敗後的重試時刻（至多每 `SYNC_INTERVAL_MS` 一次；v1.1.2 評審 S1） */
let lastRestoreRetryAt = 0;
/** v1.1.4：換鑰匙續跑失敗後的重試時刻（同上的節流） */
let lastRotationRetryAt = 0;
/** StrictMode 雙掛載／重複 boot 共用同一趟首次狀態查詢（沿 backupStore.boot） */
let bootInflight: Promise<void> | null = null;
/**
 * 加入時回了 needs_choice 的那份輸入（含密語與 secret）——只活在記憶體、等 `joinWith` 帶 mode 重送；
 * `joinWith`／`cancelChoice` 一定清掉。不進 zustand state（devtools／log 都不該看到它）。
 */
let pendingJoinInput: JoinInput | null = null;
/**
 * v1.1.4 修正席（產品評審 B1）：`rejoin` 回了 needs_choice 的那句密語——同 `pendingJoinInput` 的規矩
 *（只活在記憶體、不進 zustand state、`joinWith`／`cancelChoice` 一定清掉）。
 * 非 null ⇒ `joinWith` 要走 `rejoin(pass, mode)` 而不是 `join({...})`。
 */
let pendingRejoinPass: string | null = null;

function detachSchedule(): void {
  rerun = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (writeHandler) {
    window.removeEventListener(SYNC_WRITE_EVENT, writeHandler);
    writeHandler = null;
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (focusHandler) {
    window.removeEventListener("focus", focusHandler);
    focusHandler = null;
  }
  if (onlineHandler) {
    window.removeEventListener("online", onlineHandler);
    onlineHandler = null;
  }
  if (focusTimer !== null) {
    clearTimeout(focusTimer);
    focusTimer = null;
  }
}

/**
 * 掛節奏（可重入：自己先 detach）。
 * 未加入／橋接不通＝一顆計時器都不掛（桌機零改變的一部分：關著的同步不該有背景動作）。
 */
function attachSchedule(): void {
  detachSchedule();
  if (typeof window === "undefined") return;
  const status = useSyncStore.getState().status;
  if (!status || !status.configured) return;

  // 前景才動（背景分頁不必每分鐘吵雲端；回到前景那一刻另有 visibilitychange 補一趟）
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void runCycle();
  }, SYNC_INTERVAL_MS);

  visibilityHandler = () => {
    if (document.visibilityState === "visible") void runCycle();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
  // 桌機從別的視窗切回來不會發 visibilitychange（視窗本來就沒被隱藏）——補 window focus 這一趟（去抖 1.5 秒）
  focusHandler = () => {
    if (focusTimer !== null) clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      focusTimer = null;
      if (document.visibilityState === "visible") void runCycle();
    }, 1500);
  };
  window.addEventListener("focus", focusHandler);

  // v1.1.5 修正席（產品評審 B2）：離線那段一趟都不跑；網路回來那一刻補一趟（不必等下一個 60 秒）
  onlineHandler = () => {
    if (document.visibilityState === "visible") void runCycle();
  };
  window.addEventListener("online", onlineHandler);

  // 資料層每次「有 op 的寫入」丟一顆 SYNC_WRITE_EVENT，去抖 2 秒合成一趟（兩端都掛）
  writeHandler = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void runCycle();
    }, SYNC_PUSH_DEBOUNCE_MS);
  };
  window.addEventListener(SYNC_WRITE_EVENT, writeHandler);
}

/** repository 丟出來的例外 → 人話（Rust 端已回人話，這裡只做保底；同 backupStore.messageOf） */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

/**
 * 跑一趟同步＝**先 push 再 pull**。先推的理由：本機剛改的東西先出去，接著拉回來的遠端物件裡才帶得到
 * 「對方看過我哪一版」（`seen`），衝突判定才不會把單純的落後誤判成併發。
 * `manual`＝主人按了「立即同步」（失敗會 toast；自動節奏失敗只落在狀態列，不打擾）。
 */
async function runCycle(manual = false): Promise<PushReport | PullReport | null> {
  const status = useSyncStore.getState().status;
  if (!status || !status.configured) return null;
  // v1.1.5 修正席（產品評審 B2 ①）：作業系統說沒網路＝整趟不跑（不推不拉、不補收尾、`fail_streak` 不加）。
  // 捷運裡改票不該累積失敗；修改照樣在 outbox 排隊，網路回來由 `online` 事件補一趟。
  // 只擋 `onLine === false`（確定離線）；true 不代表真的連得上，那種情況交給下面的失敗退避。
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (manual) useUiStore.getState().showToast({ message: SYNC_OFFLINE_TOAST });
    return null;
  }
  // 還原收尾（契約 §6 步驟 4）：網路失敗時標記留著，這裡每 60 秒補一次；成功了下一趟就走正常路
  if (status.restore_pending) {
    if (!inflight && !useSyncStore.getState().working && Date.now() - lastRestoreRetryAt >= SYNC_INTERVAL_MS) {
      await useSyncStore.getState().finishRestore();
    }
    return null;
  }
  // v1.1.4（契約 §5）：換鑰匙到一半（多半是中途關掉 App）——不推不拉，每 60 秒補一次續跑
  if (status.phase === "rotating") {
    if (!inflight && !useSyncStore.getState().working && Date.now() - lastRotationRetryAt >= SYNC_INTERVAL_MS) {
      await useSyncStore.getState().finishRotation();
    }
    return null;
  }
  if (!status.enabled) return null; // 總開關關著＝什麼都不跑（手動鈕在 UI 也是 disabled）
  // 改正待ち／鍵違い＝停在原地等主人處理，不推不拉
  if (status.phase === "epoch_changed" || status.phase === "locked") return null;
  // v1.1.5 修正席（產品評審 B2）：上一趟失敗後，自動觸發在退避期內不跑——讓「三趟失敗」回到約三分鐘的意思
  if (!manual && lastFailAt > 0 && Date.now() - lastFailAt < SYNC_FAIL_BACKOFF_MS) return null;
  if (inflight) {
    rerun = true;
    return null;
  }

  inflight = true;
  useSyncStore.setState({ working: true });
  try {
    const pushed = await syncRepo.push();
    const pulled = await syncRepo.pull();
    cycleRanThisProcess = true;
    lastFailAt = 0;
    await refreshStatusInner();
    if (pulled.changed_tables.length > 0) await refreshAfterPull(pulled);
    // 同時改到同一格＝敗方已被 Rust 記進那張票的乘務記錄。自動趟也講（衝突本來就罕見，不會變成噪音）。
    if (pulled.conflicts > 0) {
      useUiStore.getState().showToast({
        message: `有 ${pulled.conflicts} 處兩台同時改到——詳情在該車票的乘務記錄`,
      });
    }
    if (manual) {
      if (pushed.busy || pulled.busy) {
        useUiStore.getState().showToast({ message: "另一趟同步正在進行，請稍候" });
      } else if (pulled.gated) {
        useUiStore.getState().showToast({ message: "兩台的版本不一致，同步先停在這裡" });
      }
    }
    // v1.1.4（契約 §6 排程）：一趟成功之後順手問引擎「今天拍過雲端快照沒」——引擎判當日、這裡不另起 timer。
    // 失敗不打擾（背景動作；狀態列的「上次上傳」會停在舊時刻，主人翻雲端備份區就看得到）。
    if (!pushed.busy && !pulled.busy && !pulled.gated) void autoCloudSnapshot();
    return pulled;
  } catch (e) {
    const message = messageOf(e);
    cycleRanThisProcess = true;
    lastFailAt = Date.now();
    // pull 是「一個物件一個交易」，中途 Err 時前幾顆的遠端 hlc 已經戳進 sync_cells，但 `seedHlc(max_hlc)`
    // 拿不到回報——忘掉探測快取，下一次寫入會重新 `seedHlc(MAX(hlc))`（v1.1.2 評審 S6）。
    resetSyncTablesProbe();
    useSyncStore.setState((s) => ({
      status: s.status ? { ...s.status, last_error: message, phase: "stopped" } : s.status,
    }));
    if (manual) useUiStore.getState().showToast({ message: `同步沒有完成：${message}` });
    // v1.1.5（契約 §2.3）：`fail_streak` 是 Rust 記的（`record_error` +1），本機那份 status 沒有它——
    // 失敗這趟也要重問一次，第 3 趟的橫幅與通知才會準時出現（不等下一個 60 秒）。
    await refreshStatusInner();
    return null;
  } finally {
    inflight = false;
    useSyncStore.setState({ working: false });
    if (rerun) {
      rerun = false;
      void runCycle();
    }
  }
}

/** v1.1.4：每日一份雲端快照（引擎判當日；拍了就更新狀態列與列表，沒拍＝零動作） */
async function autoCloudSnapshot(): Promise<void> {
  try {
    const entry = await syncRepo.cloudSnapshotAuto();
    if (!entry) return;
    await refreshStatusInner();
    const list = useSyncStore.getState().cloudSnapshots;
    if (list) useSyncStore.setState({ cloudSnapshots: [entry, ...list] });
  } catch (e) {
    console.warn("[next-stop] 今日雲端快照沒拍成：", messageOf(e));
  }
}

/**
 * 內部版 refreshStatus（runCycle 與 store action 共用）。
 * 回傳剛拿到的狀態（null＝橋接不通）——回傳型別寫死是**刻意**的：store 的 action 若直接讀
 * `useSyncStore.getState()` 當回傳值，TS 會判成「型別參照自己的初始化式」而把整個 store 推成 any
 * （TS7022／TS7023，連帶所有 `useSyncStore((s) => …)` 的 `s` 變 any）。經過這個標了型別的出口就不會。
 */
async function refreshStatusInner(): Promise<SyncStatus | null> {
  try {
    const status = await syncRepo.status();
    useSyncStore.setState({ status, bridgeError: null });
    evaluateAlerts(status); // v1.1.5 契約 §2.4：所有 status 都經過這裡 ⇒ 轉變偵測只寫一次
    return status;
  } catch (e) {
    useSyncStore.setState({ status: null, bridgeError: messageOf(e) });
    // 刻意**不**評估：橋接一時不通＝不知道狀態，不是「告警解除」。若在這裡當成 null，
    // 橋接抖一下就會「解除→再轉入」＝同一個告警多響一則；橫幅維持上一個已知狀態，等下一份 status 再說。
    return null;
  }
}

/**
 * 拉到東西之後重載畫面。`loadSettings()` 只在 settings 真的被改到時才叫（它每次都會多掛一顆 matchMedia
 * listener，而白名單只有 `day_start_hour`）。
 */
async function refreshAfterPull(report: Pick<PullReport, "changed_tables">): Promise<void> {
  const ui = useUiStore.getState();
  if (report.changed_tables.includes("settings")) {
    await ui.loadSettings().catch(() => undefined);
  }
  const node = useNodeStore.getState();
  try {
    if (shell === "mobile") {
      await node.loadSidebar();
      await node.loadToday(todayKey(useUiStore.getState().dayStartHour));
      if (node.routeId) await node.reloadRoute();
    } else {
      await node.refresh();
    }
    // 衝突列是 Rust 直寫 work_logs 的，節點的 updated_at 不會變——側板開著時要補一刀才看得到那一行競合
    if (report.changed_tables.includes("work_logs")) {
      for (const id of Object.keys(useNodeStore.getState().workLogs)) {
        await node.loadWorkLogs(id).catch(() => undefined);
      }
    }
  } catch (e) {
    console.warn("[next-stop] 同步後重載失敗：", messageOf(e));
  }
  // 遠端 hlc 已戳進 sync_cells，忘掉探測快取 ⇒ 下一次寫入重讀 MAX(hlc) 當種子（契約 §5 的雙保險）
  resetSyncTablesProbe();
}

/**
 * v1.1.6 修正席（工程評審 B-1）：本機資料被**整批換掉**之後（改正待ち「改用那份／一起清空」、加入時「改用另一台的」）的重載。
 * `refreshAfterPull` 只看 pull 回報的 `changed_tables`——「一起清空」拉到 0 顆 ⇒ 空陣列 ⇒ 什麼都不重載，
 * DB 已空、畫面上的票卻還在（桌機要重啟才消失、手機側欄一直是舊的），主人再對舊票蓋章就會產生殘缺的 upsert op。
 * v1.1.5 以前空紀元一律被跳過走不到這裡；整合席放行 reset 空紀元之後才第一次走得到。
 * 所以：三張資料表無條件重載，再把指著已不存在節點的畫面狀態收掉（沿 RouteDialog 刪路線的收法：
 * 換到剩下的第一條路線、zoom 與選取清空）。
 */
async function refreshAfterWipe(pulled: Pick<PullReport, "changed_tables"> | null): Promise<void> {
  const tables = new Set([...(pulled?.changed_tables ?? []), "nodes", "occurrences", "work_logs"]);
  await refreshAfterPull({ changed_tables: [...tables] });
  const node = useNodeStore.getState();
  const ui = useUiStore.getState();
  ui.select(null);
  ui.setZoom(null);
  if (node.routeId && !node.routes.some((r) => r.id === node.routeId)) {
    await node.openRoute(node.routes[0]?.id ?? null).catch(() => undefined);
  }
}

/**
 * v1.1.6 修正席（工程評審 S-6）：等背景那一趟（`working`）跑完，最多 `ms` 毫秒；等到回 true。
 * 回來之後呼叫端要**同步地**（不 await）接著設 `working=true`——promise 的續行是 microtask，排在下一個計時器之前，
 * 中間不會再插進新的一趟。Rust 的 BusyGuard 仍是最後一道。
 */
function waitSyncIdle(ms: number): Promise<boolean> {
  if (!useSyncStore.getState().working) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(!useSyncStore.getState().working);
    }, ms);
    const unsub = useSyncStore.subscribe((s) => {
      if (!s.working) {
        clearTimeout(timer);
        unsub();
        resolve(true);
      }
    });
  });
}

/** 按下「清空」時最多等背景那一趟多久（一趟 push＋pull 通常數秒；網路很差時寧可明講「稍候再試」） */
const START_OVER_WAIT_MS = 30_000;

/**
 * 手機匯出的 SAF 選位置（v1.1.4 查證：`download_dir()` 在 Android 是 app 專屬目錄、主人看不到）。
 * 回 `content://` URI＝選好了；`null`＝主人取消；`undefined`＝選擇器開不了（沒有檔案 provider）⇒ 呼叫端退回 Rust 預設落點。
 * v1.1.6 修正席由 `exportToFile` 抽出，讓「重新開始」手機未加入的留底共用同一條（工程評審 S-5）。
 */
async function pickExportTarget(title: string): Promise<string | null | undefined> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const picked = await save({
      title,
      defaultPath: `nextstop-export-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    return picked ?? null;
  } catch (e) {
    console.warn("[next-stop] 檔案選擇器開不了，改用 App 私有目錄：", messageOf(e));
    return undefined;
  }
}

/**
 * 桌機「改用另一台的」／「改用那份」／（v1.1.6）「重新開始」之前先拍一份 manual 備份
 *（提案第三節：任何非空裝置選改用另一台之前；重新開始契約 §9-5：用 manual 不用 safety——主人在備份清單看得到「手動」那份、
 * 保留份數由自己的配額管，保險份只留 3 份，重新開始那份不該三次還原就被輪掉）。
 * 拍不成就回 false（人話放 formError）——拍不成不做，沿 v1.1.1 評審 S3「備份沒拍成就不啟用」的硬度。
 * 手機沒有備份三件套：由 Rust 匯出全量 JSON／拍雲端快照（契約 §4.7），這裡直接放行。
 * v1.1.6 由 `backupBeforeAdopt` 改名（三處共用，名字不該只講其中一處）。
 */
async function backupBeforeWipe(): Promise<boolean> {
  if (shell !== "desktop") return true;
  await useBackupStore.getState().backupNow().catch(() => undefined);
  const backup = useBackupStore.getState();
  if (backup.lastError) {
    useSyncStore.setState({ formError: `備份沒拍成（${backup.lastError}）——先到〈備份與還原〉修好再試。` });
    return false;
  }
  return true;
}

/**
 * 通知權限「一輩子問一次」（v1.1.5 契約 §3.4；D-1.1.5 技術自決）：已加入、`notif_asked` 沒設才問。
 * 問完（granted／denied）落 `notif_asked`，拒絕就只用橫幅、不再問。桌機 `request_permission` 恆 Granted（不會跳任何東西）。
 * `reset_local` 清整張 sync_meta ⇒ 重新加入後再問一次（那是「新的一台」）。失敗全吞：通知只是加分。
 *
 * 呼叫點兩個：
 *   ① `settleJoin`＝加入同步成功之後（原設計）；
 *   ② `boot`＝**已加入、但從沒問過**的裝置（v1.1.5 修正席／產品評審 B1：v1.1.4 原地升級上來的手機「已加入不重配」，
 *      `settleJoin` 永遠不會跑 ⇒ Android 13+ 永遠沒權限、通知全啞）。一台一輩子一次，之後旗標就擋住了。
 * 工程評審 S-2：外掛一時叫不動（回 `skipped`）**不記**「問過了」——下次啟動再問，不然一次瞬斷就永遠不送。
 */
async function askNotificationIfNeeded(status: SyncStatus | null): Promise<void> {
  if (!status?.configured || status.notif_asked || notifAskInflight) return;
  notifAskInflight = true;
  try {
    const answer = await askNotificationPermissionOnce();
    if (answer === "skipped") return;
    await syncRepo.markNotifAsked().catch((e) => console.warn("[sync:notify] notif_asked 寫不進去：", messageOf(e)));
    await refreshStatusInner();
  } finally {
    notifAskInflight = false;
  }
}

/** join 成功後的收尾（first／pulled／merged／adopted／reconnected 共用） */
async function settleJoin(report: JoinReport): Promise<void> {
  // 快照與 join 內部拉下來的 hlc 都是 Rust 產的，TS 這邊的記憶體計數看不到——忘掉探測快取，下次寫入重吃種子
  resetSyncTablesProbe();
  const joined = await refreshStatusInner();
  await askNotificationIfNeeded(joined);
  attachSchedule();
  // 修正席（工程評審 B-1）：「改用另一台的」＝本機整批換掉——不論拉到幾顆都全重載（雲端是 reset 空紀元時拉 0 顆）
  if (report.outcome === "adopted") await refreshAfterWipe(report.pull);
  else if (report.pull && report.pull.changed_tables.length > 0) await refreshAfterPull(report.pull);
  if (report.outcome === "first" || report.outcome === "merged") {
    // 快照已在 outbox 裡，當下就推上去
    await syncRepo.push();
    await refreshStatusInner();
  }
  const outcome = report.outcome as Exclude<JoinOutcome, "needs_choice">;
  useUiStore.getState().showToast({ message: report.message || JOIN_TOAST[outcome] });
}

/* ═══════════════════════════════════════════════════════════════════════
   store
   ═══════════════════════════════════════════════════════════════════════ */

export const useSyncStore = create<SyncStore>((set, get) => ({
  status: null,
  booting: true,
  pairingCode: null,
  working: false,
  bridgeError: null,
  formError: null,
  pendingChoice: null,
  cloudSnapshots: null,
  cloudError: null,
  recoveryDisplay: null,

  async boot(nextShell) {
    shell = nextShell;
    if (!bootInflight) {
      bootInflight = (async () => {
        try {
          await refreshStatusInner();
        } finally {
          set({ booting: false });
          bootInflight = null;
        }
      })();
    }
    await bootInflight;
    // 還原收尾（契約 §6 步驟 4）：備份還原會換掉整顆 DB 再 `app.restart()`，所以「還原完要做的事」寫不進
    // 還原流程末尾（那個進程不會回來）——Rust 在換檔成功時寫標記檔（含主人選的方式），重啟後在這裡收。
    // 沒鑰匙圈的機器 Rust 端就不會回 restore_pending（未加入＝還原不牽動任何裝置）。
    const finishing = get().status?.restore_pending === true;
    if (finishing) {
      await get().finishRestore();
    }
    // v1.1.4（契約 §5）：換鑰匙到一半重啟——先把七步走完（或提交點之前＝回滾），再掛節奏
    if (get().status?.rotation_stage) {
      await get().finishRotation();
    }
    attachSchedule();
    // 收尾那一趟已經自己推（renewed）或自己起跑一趟（resumed），這裡再 `runCycle()` 只會撞成 `rerun`＝
    // 白跑一次 push＋pull（冪等但多兩趟網路）。沒有還原要收時才由 boot 起跑開機那一趟。
    if (!finishing) void runCycle();
    // v1.1.5 修正席（產品評審 B1）：已加入但從沒問過通知權限（v1.1.4 原地升級）⇒ 開機問這一次。
    // 不 await：Android 的系統詢問要等主人答，不該擋住開機那一趟同步。
    void askNotificationIfNeeded(get().status);
  },

  stop() {
    detachSchedule();
  },

  async refreshStatus() {
    await refreshStatusInner();
  },

  async join(input) {
    if (get().working) return;
    set({ working: true, formError: null, pendingChoice: null });
    pendingJoinInput = null;
    pendingRejoinPass = null;
    try {
      const report = await syncRepo.join(input);
      if (report.outcome === "needs_choice") {
        // 本機零改變；把輸入留在記憶體，等頁面問完帶 mode 回來
        pendingJoinInput = input;
        set({ pendingChoice: report });
        return;
      }
      await settleJoin(report);
    } catch (e) {
      set({ formError: messageOf(e) });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  async rejoin(passphrase) {
    if (get().working) return;
    if (!passphrase.trim()) {
      set({ formError: "密語不能是空的。" });
      return;
    }
    set({ working: true, formError: null, pendingChoice: null });
    pendingJoinInput = null;
    pendingRejoinPass = null;
    try {
      const report = await syncRepo.rejoin(passphrase);
      if (report.outcome === "needs_choice") {
        // 本機零改變；密語留在記憶體，等頁面問完帶 mode 回來（同 `join` 的規矩）
        pendingRejoinPass = passphrase;
        set({ pendingChoice: report });
        return;
      }
      await settleJoin(report);
    } catch (e) {
      set({ formError: messageOf(e) });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  async joinWith(mode) {
    // v1.1.4 修正席（產品評審 B1）：二選一有兩個來源——正規 join（四欄都在手上）與
    // 「用新密語重新加入」（只有密語，四欄由 Rust 從鑰匙圈拿）。哪個 pending 非空就走哪條。
    const base = pendingJoinInput;
    const pass = pendingRejoinPass;
    if ((!base && !pass) || get().working) return;
    set({ working: true, formError: null });
    try {
      if (mode === "adopt_remote" && !(await backupBeforeWipe())) return;
      const report = pass ? await syncRepo.rejoin(pass, mode) : await syncRepo.join({ ...base!, mode });
      pendingJoinInput = null;
      pendingRejoinPass = null;
      set({ pendingChoice: null });
      await settleJoin(report);
    } catch (e) {
      set({ formError: messageOf(e) });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  cancelChoice() {
    pendingJoinInput = null;
    pendingRejoinPass = null;
    set({ pendingChoice: null, formError: null });
  },

  async changePassphrase(current, next, rotate = false) {
    if (get().working) return false;
    // v1.1.4 自決 4：換鑰匙必填現密語——Rust 也會擋，這裡先擋是為了把人話留在表單旁、不多跑一趟 argon2
    if (rotate && !current.trim()) {
      set({ formError: PASSPHRASE_ROTATE.needCurrent });
      return false;
    }
    set({ working: true, formError: null });
    try {
      const report = await syncRepo.changePassphrase(current, next, rotate);
      await refreshStatusInner();
      if (report.rotated) {
        resetSyncTablesProbe(); // 切了紀元、重拍了快照：下一次寫入重吃 hlc 種子
        attachSchedule();
        void get().refreshCloudSnapshots();
        fireSyncEvent("rotation_done"); // v1.1.5 契約 §2.6：一次性事件＝toast（下面那句）＋一則通知
      }
      useUiStore.getState().showToast({ message: report.message || (report.sealed_first_time ? "密語已封存到雲端" : "密語已更改") });
      return true;
    } catch (e) {
      set({ formError: messageOf(e) });
      return false;
    } finally {
      set({ working: false });
    }
  },

  async prepareRestore(choice, label) {
    try {
      await syncRepo.restoreChoice(choice, label);
      return "ok";
    } catch {
      // 失敗有三種、後果差很多，所以**再問一次狀態**而不是比對錯誤字串：
      //   ① 這台其實沒加入同步（複製資料夾、鑰匙圈在上次 status 之後被清掉）＝還原不牽動任何裝置 ⇒ 照常還原。
      //   ② 真的寫不進去（磁碟、權限）⇒ 標記檔會缺選擇 ⇒ 兩種選擇都不該照常還原（呼叫端擋）。
      //   ③ **鑰匙圈讀不到**（工程評審 B-1）：`configured` 一樣是 false，但這台其實加入過
      //      （`joined` 為真且有 `last_error`）。當成 ① 照常還原＝主人選的「回到過去」靜默消失。
      const fresh = await refreshStatusInner();
      const keyringUnreadable = !!fresh?.joined && !!fresh?.last_error;
      return fresh?.configured || keyringUnreadable ? "failed" : "not-joined";
    }
  },

  async clearRestoreChoice() {
    await syncRepo.restoreChoice(null).catch(() => undefined);
  },

  async finishRestore() {
    if (get().working) return;
    lastRestoreRetryAt = Date.now(); // 不論成敗都記一次，失敗的重試由 `runCycle` 每 60 秒補
    set({ working: true, formError: null });
    // 「接上現在」要接著跑一趟（下一趟 pull 從頭重列目前紀元，把雲端比備份新的修改蓋回來）——
    // 但那一趟要等 `working` 放掉之後再起跑，否則 finally 會把它的 working 一起關掉、鈕看起來是閒著的。
    let resume = false;
    try {
      const report = await syncRepo.finishRestore();
      resetSyncTablesProbe(); // 快照的 hlc 是 Rust 產的
      await refreshStatusInner();
      if (report.outcome === "renewed") {
        // 回到過去：快照已在 outbox 裡，當下就推上去（別台下一趟會看到新紀元 ⇒ 改正待ち）
        attachSchedule();
        await syncRepo.push();
        await refreshStatusInner();
      } else if (report.outcome === "resumed") {
        attachSchedule();
        resume = true;
      } else {
        detachSchedule(); // not_joined：Rust 已清掉標記，這台不該有背景動作
      }
      // v1.1.6（重新開始契約 §4.4）：「所有裝置一起重新開始」走的是同一條還原收尾，只換字與事件。
      // Rust 的 message 已是 reset 句；空的才退回常數（舊版 Rust 沒帶 reason ⇒ undefined ⇒ 照一般還原）。
      const isReset = report.reason === "reset";
      const toast = report.message || (isReset ? SYNC_EVENT_TEXT.reset_done.toast : "");
      if (toast) useUiStore.getState().showToast({ message: toast });
      if (report.outcome !== "not_joined") fireSyncEvent(isReset ? "reset_done" : "restore_done"); // v1.1.5 契約 §2.6
    } catch (e) {
      // 多半是網路：標記檔留著，`runCycle` 每 60 秒補一次（契約 §6 步驟 4）
      useUiStore.getState().showToast({ message: `還原後的同步收尾沒做完：${messageOf(e)}` });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
    if (resume) void runCycle();
  },

  async adoptEpoch() {
    if (get().working) return;
    // 修正席（產品評審 #4）：按之前先記下是哪一種——按完 status 就換成新紀元、`pending_epoch_info` 清掉了
    const isReset = get().status?.pending_epoch_info?.reason === "reset";
    set({ working: true, formError: null });
    try {
      if (!(await backupBeforeWipe())) return;
      const report = await syncRepo.adoptEpoch();
      resetSyncTablesProbe(); // 表清空、cells 清空：下一次寫入重新吃 hlc 種子
      await refreshStatusInner();
      attachSchedule();
      const pulled = await syncRepo.pull();
      await refreshStatusInner();
      // 修正席（工程評審 B-1）：本機已整批清掉——不論拉到幾顆都全重載（「一起清空」拉 0 顆，舊碼什麼都不重載）
      await refreshAfterWipe(pulled);
      // 產品評審 S2：手機沒有備份三件套，改用那份之前 Rust 會先匯出整顆庫——路徑要講出來，
      // 不然「我的東西去哪了」在手機上完全無跡可循（桌機是 TS 拍的 manual 備份，列在備份籤裡）。
      const saved = [
        report.export_path ? `這台原本的全部資料另存在 ${report.export_path}` : null,
        report.orphan_ops
          ? `還沒送出的 ${report.orphan_ops} 筆修改另存在 ${report.orphans_path ?? "本機"}`
          : null,
      ].filter(Boolean);
      const done = isReset ? "已一起清空——這台現在是空的" : "已改用那份";
      useUiStore.getState().showToast({
        message: saved.length ? `${done}；${saved.join("；")}` : done,
      });
      // v1.1.5 修正席（產品評審 S4）：只 toast、不發系統通知（主人就在畫面前按的）
    } catch (e) {
      set({ formError: messageOf(e) });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  async syncNow() {
    return runCycle(true);
  },

  async setEnabled(enabled) {
    if (get().working) return;
    set({ working: true });
    try {
      const status = await syncRepo.setEnabled(enabled);
      set({ status, bridgeError: null });
      evaluateAlerts(status); // v1.1.5：關總開關＝paused＝不告警，橫幅當場收掉（開回來若仍在告警態＝再轉入一次）
      attachSchedule();
    } catch (e) {
      useUiStore.getState().showToast({ message: `總開關切不動：${messageOf(e)}` });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
    // 開起來就補一趟（關著時一趟都不跑）。同 `finishRestore`：等 working 放掉之後再起跑，
    // 免得 finally 把這一趟的 working 一起關掉、狀態點不呼吸。
    if (enabled && get().status?.enabled) void runCycle();
  },

  reset() {
    useUiStore.getState().askConfirm({
      title: "要重新加入同步嗎？",
      body:
        "會清掉這台的同步設定、憑證與身分——這台的資料與雲端上的資料都不會被動到。" +
        "之後要再用就是「重新加入」：回到「加入同步」重問一次（兩邊都有資料時會問要不要合併）。",
      confirmLabel: "重新加入",
      danger: true,
      onConfirm: () => {
        void (async () => {
          set({ working: true, formError: null, pendingChoice: null });
          pendingJoinInput = null;
          pendingRejoinPass = null;
          try {
            const status = await syncRepo.resetLocal();
            set({ status, pairingCode: null, bridgeError: null });
            evaluateAlerts(status); // v1.1.5：拿掉同步＝沒鑰匙圈＝不告警，橫幅當場收掉
            detachSchedule();
            // 鈕上寫的是「重新加入同步」，但按下去只做「拿掉」那一半——表單當場長回來，
            // 主人接著自己填。toast 因此講「已拿掉」而不是「已重新加入」，免得看起來已經接回去了。
            useUiStore.getState().showToast({ message: "已拿掉這台的同步設定——下面可以重新加入" });
          } catch (e) {
            useUiStore.getState().showToast({ message: `這台的同步設定沒有拿掉：${messageOf(e)}` });
            await refreshStatusInner();
          } finally {
            set({ working: false });
          }
        })();
      },
    });
  },

  async showPairingCode() {
    try {
      set({ pairingCode: await syncRepo.makePairingCode() });
    } catch (e) {
      useUiStore.getState().showToast({ message: `配對碼產不出來：${messageOf(e)}` });
    }
  },

  hidePairingCode() {
    set({ pairingCode: null });
  },

  async decodePairingCode(code) {
    try {
      const fields = await syncRepo.decodePairingCode(code);
      set({ formError: null });
      return fields;
    } catch (e) {
      set({ formError: messageOf(e) });
      return null;
    }
  },

  async importWizardEnv() {
    try {
      const env = await syncRepo.readWizardEnv();
      set({ formError: null });
      return env;
    } catch (e) {
      set({ formError: messageOf(e) });
      return null;
    }
  },

  clearFormError() {
    if (get().formError) set({ formError: null });
  },

  /* ── v1.1.4 雲端備份（契約席骨架；WP-B 填細節、WP-C 用）── */

  async refreshCloudSnapshots() {
    if (!get().status?.configured) {
      set({ cloudSnapshots: null, cloudError: null });
      return;
    }
    try {
      set({ cloudSnapshots: await syncRepo.cloudSnapshotList(), cloudError: null });
    } catch (e) {
      set({ cloudError: messageOf(e) });
    }
  },

  async cloudSnapshotNow() {
    if (get().working) return;
    set({ working: true, cloudError: null });
    try {
      const entry = await syncRepo.cloudSnapshotNow("manual");
      await refreshStatusInner();
      set({ cloudSnapshots: [entry, ...(get().cloudSnapshots ?? []).filter((s) => s.key !== entry.key)] });
      useUiStore.getState().showToast({ message: "已備份到雲端" });
      // 上傳者順手做了階梯清理——列表要重讀才看得到被清掉的
      void get().refreshCloudSnapshots();
    } catch (e) {
      set({ cloudError: messageOf(e) });
      useUiStore.getState().showToast({ message: `雲端備份沒拍成：${messageOf(e)}` });
    } finally {
      set({ working: false });
    }
  },

  cloudRestore(entry, choice) {
    /**
     * 契約 §7：與桌機本機還原**同一個確認窗、同一套字**（title／後果句／confirmLabel 逐字沿 backupStore.restore），
     * 只多一句「來源：雲端快照 <時刻>」。留底（桌機 safety 備份／手機先拍一份 manual 雲端快照）在 Rust 裡做，
     * 這裡的 body 也要講出來。成功不會回來（Rust `app.restart()`）；重啟後 boot 走既有 `finishRestore()`。
     */
    const when = fmtSyncStamp(entry.at);
    const label = `雲端快照 ${when}`;
    const consequence =
      choice === "past"
        ? "所有裝置都會改用這份備份：備份之後的修改（含其他裝置已送出的）都會消失；其他裝置還沒送出的修改會另存成檔，不會自動併回。"
        : "只有這台換成備份；其他裝置比備份新的修改會再蓋回來。刪除也算一種修改——已經同步出去的誤刪不會被找回來。";
    const keepCopy = shell === "desktop" ? "會先把現在的資料另存保險備份" : "會先把現在的資料拍一份到雲端";
    // v1.1.4 修正席（工程評審 S-6）：**Android 的 `app.restart()` 實際上只是 `exit(0)`**
    //（tauri 2.11 `process.rs`：在 Android 拿不到自己的執行檔，spawn 必定失敗，只寫一行 log 就結束行程）。
    // 資料是安全的——還原標記已經落地，主人重開 App 時 boot 的 `finishRestore()` 會收尾——
    // 但他眼裡看到的是「App 閃退」。所以手機講「App 會關閉，請重新打開」，不講「會重新啟動」。
    const restartWord = shell === "desktop" ? "然後重新啟動" : "然後 App 會關閉，請重新打開它";
    useUiStore.getState().askConfirm({
      title: "要還原到這一份備份嗎？",
      body: `來源：${label}。${keepCopy}，${restartWord}。${consequence}`,
      confirmLabel: shell === "desktop" ? "還原並重新啟動" : "還原並關閉 App",
      danger: true,
      onConfirm: () => {
        set({ working: true, cloudError: null });
        void syncRepo.cloudRestore(entry.key, choice, label).catch((e: unknown) => {
          set({ working: false, cloudError: messageOf(e) });
          useUiStore.getState().showToast({ message: `還原沒有完成：${messageOf(e)}` });
        });
      },
    });
  },

  async exportToFile() {
    if (get().working) return null;
    set({ working: true });
    try {
      let target: string | null = null;
      if (shell === "mobile") {
        // 查證（…-Android下載目錄寫入查證.md）：`download_dir()` 在 Android 是 app 專屬目錄、主人看不到 ⇒
        // 走 SAF：`plugin-dialog` 的 `save()` 讓主人自己選位置（可選「下載」），回 `content://` URI 交給 Rust 寫。
        // 選擇器開不了（沒有檔案 provider）就退回 Rust 的預設落點，並把路徑講出來。
        const picked = await pickExportTarget("匯出到手機");
        if (picked === null) return null; // 主人取消＝零動作、不吵
        target = picked ?? null;
      }
      const report = await syncRepo.exportToFile(target);
      // 工程評審 S-9：SAF 已經先把文件建好了，寫入才失敗 ⇒ Rust 退回 app 私有目錄並回 `picked=false`。
      // 這時主人選的那個位置會留下一顆 0 byte 的空檔，得講出來，不然他會去開那個空檔。
      const fellBack = !!target && !report.picked;
      useUiStore.getState().showToast({
        message: report.picked
          ? "已匯出到你選的位置"
          : fellBack
            ? `寫不進你選的位置，已改存到 ${report.path}（App 私有目錄；你選的位置可能留下一個空檔，可以刪掉）`
            : `已匯出到 ${report.path}（App 私有目錄；移除 App 會一起消失）`,
      });
      return report;
    } catch (e) {
      useUiStore.getState().showToast({ message: `匯出沒有完成：${messageOf(e)}` });
      return null;
    } finally {
      set({ working: false });
    }
  },

  async finishRotation() {
    if (get().working) return;
    lastRotationRetryAt = Date.now();
    set({ working: true, formError: null });
    try {
      const report = await syncRepo.finishRotation();
      resetSyncTablesProbe();
      await refreshStatusInner();
      attachSchedule();
      // v1.1.5 整合席（WP-A 接縫）：續跑到步驟 3.5 時這台若沒有包裝鑰匙 W，RECOVERY 會被刪（作廢）。
      // Rust 的 message 尾巴已含那句；這裡只在它沒帶到時補上，免得主人不知道復原碼要重生。
      let rotationMsg = report.message;
      if (report.recovery === "invalidated" && !rotationMsg.includes("復原碼已作廢")) {
        rotationMsg = rotationMsg ? `${rotationMsg}${RECOVERY_TEXT.invalidatedByRotation}` : RECOVERY_TEXT.invalidatedByRotation;
      }
      if (rotationMsg) useUiStore.getState().showToast({ message: rotationMsg });
      if (report.outcome === "finished") {
        void get().refreshCloudSnapshots();
        fireSyncEvent("rotation_done"); // v1.1.5 契約 §2.6（續跑走完也算「換鑰匙完成」）
      }
    } catch (e) {
      // 多半是網路：標記檔留著，`runCycle` 每 60 秒補一次
      useUiStore.getState().showToast({ message: `換鑰匙沒做完：${messageOf(e)}` });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  /* ── v1.1.5 復原碼（契約席骨架；WP-B 校對、WP-C 用）── */

  async generateRecoveryCode() {
    if (get().working) return;
    set({ working: true, formError: null });
    try {
      const report = await syncRepo.recoveryGenerate();
      // 碼只進這一格 state（對話框讀），不進 toast、不進 log
      set({ recoveryDisplay: report.code_display });
      await refreshStatusInner();
    } catch (e) {
      set({ formError: messageOf(e) });
    } finally {
      set({ working: false });
    }
  },

  closeRecoveryDialog() {
    set({ recoveryDisplay: null });
  },

  clearRecoveryCode() {
    useUiStore.getState().askConfirm({
      title: RECOVERY_TEXT.clearConfirmTitle,
      body: RECOVERY_TEXT.clearConfirmBody,
      confirmLabel: RECOVERY_TEXT.clearConfirmLabel,
      danger: true,
      onConfirm: () => {
        void (async () => {
          set({ working: true, formError: null });
          try {
            await syncRepo.recoveryClear();
            await refreshStatusInner();
            useUiStore.getState().showToast({ message: "復原碼已作廢" });
          } catch (e) {
            set({ formError: messageOf(e) });
          } finally {
            set({ working: false });
          }
        })();
      },
    });
  },

  /* ── v1.1.6 重新開始（契約 §4.2；WP-B）── */

  startOver(scope) {
    const joined = !!get().status?.configured;
    // 「所有裝置一起」在未加入時鈕是 disabled 的；這裡再擋一次（直呼 store 的沙盒腳本也吃同一句人話）
    if (scope === "all_devices" && !joined) {
      useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(START_OVER_TEXT.allDevices.disabledTitle) });
      return;
    }
    // 修正席（產品評審 #3／工程評審 S-7）：開窗前先看狀態——擋得下的當場講、不開窗。以前要等主人打完「清空」
    // 才被 Rust 擋，桌機卻已先拍了一份 manual（每按一次多一份、擠掉配額內較舊的歷史點）。Rust 仍是最後一道。
    const blocked = startOverBlockedBy(scope, get().status);
    if (blocked) {
      useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(blocked) });
      return;
    }
    const c = START_OVER_TEXT.confirm;
    useUiStore.getState().askConfirm({
      title: scope === "all_devices" ? c.titleAll : c.titleThis,
      body: startOverBody(scope, shell, joined),
      confirmLabel: c.confirmLabel,
      danger: true,
      typeToConfirm: c.typeWord,
      typeHint: c.typeHint,
      onConfirm: () => {
        void (async () => {
          // 修正席（工程評審 S-6）：打字那幾秒背景那一趟可能起跑了（60 秒計時／focus／寫入事件）。以前這裡
          // `if (working) return` 靜默結束＝窗關了、沒清、也沒 toast。改成等它跑完（上限 30 秒），等不到就明講。
          if (!(await waitSyncIdle(START_OVER_WAIT_MS))) {
            useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(START_OVER_TEXT.busy) });
            return;
          }
          // 等到了再看一次（那一趟可能剛把這台推進改正待ち）——這段到 `set` 都是同步的，中間插不進新的一趟
          const again = startOverBlockedBy(scope, get().status);
          if (again) {
            useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(again) });
            return;
          }
          const joinedNow = !!get().status?.configured;
          set({ working: true, formError: null, pendingChoice: null });
          pendingJoinInput = null;
          pendingRejoinPass = null;
          // 清之前先把背景節奏拆掉：Rust 端有 BusyGuard，撞到在飛的那一趟會回「同步正在進行中」；
          // 拆掉之後這段期間不會再起跑新的一趟。失敗（這台一個字都沒動）時接回去。
          detachSchedule();
          try {
            // ① 留底（桌機）：manual 本機備份——**未加入的桌機這是唯一一份**；拍不成就停（人話在 formError）
            if (!(await backupBeforeWipe())) {
              const why = get().formError ?? "備份沒拍成";
              useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(why) });
              attachSchedule();
              return;
            }
            // ①' 留底（手機未加入；工程評審 S-5）：先讓主人用 SAF 選位置匯出一份看得到、帶得走的檔。
            // 取消或寫不進選的位置 ⇒ 停（零改變）；選擇器開不了 ⇒ 退回 Rust 那份（App 私有目錄）。
            if (shell === "mobile" && scope === "this_device" && !joinedNow) {
              const target = await pickExportTarget("重新開始前先匯出一份");
              if (target === null) {
                useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(START_OVER_TEXT.exportCancelled) });
                attachSchedule();
                return;
              }
              if (target !== undefined) {
                const rep = await syncRepo.exportToFile(target);
                if (!rep.picked) {
                  useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(START_OVER_TEXT.exportFellBack(rep.path)) });
                  attachSchedule();
                  return;
                }
              }
            }
            // ② Rust：雲端 Safety 快照（已加入）／手機匯出（未加入）→ 清 → 重啟。成功不會回來。
            await syncRepo.startOver(scope);
          } catch (e) {
            // Rust 的人話已含「這台一個字都沒動」，這裡不再包第二層解釋（契約 §7 末句）
            useUiStore.getState().showToast({ message: START_OVER_TEXT.failed(messageOf(e)) });
            await refreshStatusInner();
            attachSchedule();
          } finally {
            set({ working: false });
          }
        })();
      },
    });
  },
}));

/* ═══════════════════════════════════════════════════════════════════════
   顯示用小工（兩殼共用；UI 不各寫一份）
   ═══════════════════════════════════════════════════════════════════════ */

/** 顯示用時刻：同年＝`9/18 03:12`，跨年補年份（逐字沿 BackupTab 的 fmtStamp） */
export function fmtSyncStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}

/** 狀態點與狀態列共用的一句 title：「同步・運行中　上次 9/18 03:12」 */
export function syncTitle(status: SyncStatus | null): string {
  if (!status) return "同步";
  const when = fmtSyncStamp(status.last_sync_at);
  return `同步・${SYNC_PHASE_LABEL[status.phase]}${when ? `　上次 ${when}` : ""}`;
}

/**
 * 改正待ち的說明句（契約 §8.4；兩殼共用）：誰、何時、哪份備份；這台還沒送出的筆數與時間跨度。
 * `pending_ops` 為 0 時省略後半句。
 */
export function describeEpochChange(status: SyncStatus): string {
  const info = status.pending_epoch_info;
  const when = info ? fmtSyncStamp(info.created_at) : "";
  // 產品評審 N3：同一組文案也會蓋到 reason=first／backfill 的紀元（那不是「從備份還原」）
  const what =
    info && info.reason !== "restore"
      ? "另一台裝置換上了一份新的資料"
      : `另一台裝置回到了${info?.label ? `「${info.label}」` : "一份備份"}的狀態`;
  // v1.1.6（重新開始契約 §7 逐字）：reset＝另一台按了「所有裝置一起重新開始」；後半句（pending_ops）一字不改
  const head =
    info?.reason === "reset"
      ? `${when ? `${when}，` : ""}另一台裝置按了「所有裝置一起重新開始」，雲端現在是空的。這台一起清空之後會變成空的（這台現有的會先留一份）`
      : `${when ? `${when}，` : ""}${what}。這台要改用那份`;
  if (!status.pending_ops) return `${head}。`;
  const span = status.pending_span
    ? `（${fmtSyncStamp(status.pending_span.from)}～${fmtSyncStamp(status.pending_span.to)} 之間改的）`
    : "";
  // 產品評審 S3：孤兒 JSON 目前沒有匯入工具，所以「想保住這 N 筆」得講出第二條出路——
  // 重新加入 →「兩邊都保留」（引擎支援：重設後的 join 走合併，未送出的修改靠列的 updated_at 派生時間戳回來）。
  return (
    `${head}；這台還沒送出的 ${status.pending_ops} 筆修改${span}會另存成檔（目前只能人工翻閱，沒有匯入工具）。` +
    "想把這些修改併進那份：改按下面的「重新加入同步」，重新加入時選「兩邊都保留」。"
  );
}

/** 鍵違い的說明句（契約 §8.5；v1.1.4 契約 §7 加「換過鑰匙」那一種） */
export function describeLocked(status: SyncStatus): string {
  if (status.locked === "salt") {
    return "雲端上的這份資料已用別的密語重新建立，這台的密語打不開它。請「重新加入同步」並輸入新密語（這台的資料不會被動，加入時會問要不要合併）。";
  }
  // v1.1.4（D-3）：那個拆不開的新紀元帶著 `ROTATED` 旗標＝另一台勾了「同時換掉資料鑰匙」。出路是既有的 join：
  // 紀元不一致 → 解 KEY 得新鑰匙 → 找到新紀元 → 兩邊有料 →「兩邊都保留」把這台還沒送出的併進去。
  if (status.locked_reason === "rotated") {
    return (
      "這份資料已在另一台換過鑰匙。請用下面的「用新密語重新加入」——四欄不用改，只要打新密語；" +
      "加入時會問要不要合併，選「兩邊都保留」，這台還沒送出的修改就會一起併進來。"
    );
  }
  // 產品評審 N4：這一態是「雲端多了一個這台打不開的紀元目錄」，實務上只由殘留或竄改造成。
  // 舊文案寫「重新加入並輸入新密語」走不通——join 會回到自己那個拆得開的紀元，下一趟又鎖回來。
  return "雲端上多了一個這台打不開的紀元（多半是別的密語留下的殘留）。同步先停在這裡；要清掉它得到 Cloudflare 後台把那個目錄刪掉，或用建立它的那組密語「重新加入同步」。";
}
