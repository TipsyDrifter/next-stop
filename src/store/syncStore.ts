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
  SyncStatus,
  WizardEnv,
} from "../data/syncRepository";
import { SYNC_WRITE_EVENT, resetSyncTablesProbe } from "../data/syncRepository";
import { todayKey } from "../lib/date";
import { useBackupStore } from "./backupStore";
import { useNodeStore } from "./nodeStore";
import { useUiStore } from "./uiStore";

/** 拉取／推送節奏（P4）；去抖秒數見 Plan §6 */
export const SYNC_INTERVAL_MS = 60_000;
export const SYNC_PUSH_DEBOUNCE_MS = 2_000;

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
  note: "四個欄位不用改（用的是這台已經存好的那組）——只要打另一台換好的新密語。接著會問要不要合併，選「兩邊都保留」，這台還沒送出的修改會一起併進來。",
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
  lead: (devices: number, alive: number) =>
    `雲端上已有一份（${devices} 個裝置目錄），這台也有 ${alive} 張活著的票。要怎麼做？`,
  merge: "兩邊都保留",
  mergeNote: "兩邊的資料合併，同一格以後改的為準。",
  adopt: "改用另一台的",
  /** 留底講法分殼：桌機拍本機備份、手機拍雲端快照（v1.1.4 契約 §6-6） */
  adoptNote: (shell: SyncShell) =>
    shell === "mobile"
      ? "這台現有的會先拍一份到雲端，再換成雲端那份。"
      : "會先自動備份一份到這台的備份資料夾，再換成雲端那份。",
  /** 改正待ち的確認窗 body（「改用那份」）；留底那半同樣分殼 */
  adoptEpochBody: (shell: SyncShell) =>
    "這台現有的車票與記錄會被那份取代；" +
    (shell === "mobile" ? "會先拍一份到雲端，" : "會先自動備份一份，") +
    "還沒送出的修改另存成檔、不會自動併回。",
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
  if (inflight) {
    rerun = true;
    return null;
  }

  inflight = true;
  useSyncStore.setState({ working: true });
  try {
    const pushed = await syncRepo.push();
    const pulled = await syncRepo.pull();
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
    // pull 是「一個物件一個交易」，中途 Err 時前幾顆的遠端 hlc 已經戳進 sync_cells，但 `seedHlc(max_hlc)`
    // 拿不到回報——忘掉探測快取，下一次寫入會重新 `seedHlc(MAX(hlc))`（v1.1.2 評審 S6）。
    resetSyncTablesProbe();
    useSyncStore.setState((s) => ({
      status: s.status ? { ...s.status, last_error: message, phase: "stopped" } : s.status,
    }));
    if (manual) useUiStore.getState().showToast({ message: `同步沒有完成：${message}` });
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
    return status;
  } catch (e) {
    useSyncStore.setState({ status: null, bridgeError: messageOf(e) });
    return null;
  }
}

/**
 * 拉到東西之後重載畫面。`loadSettings()` 只在 settings 真的被改到時才叫（它每次都會多掛一顆 matchMedia
 * listener，而白名單只有 `day_start_hour`）。
 */
async function refreshAfterPull(report: PullReport): Promise<void> {
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
 * 桌機「改用另一台的」／「改用那份」之前先拍一份 manual 備份（提案第三節：任何非空裝置選改用另一台之前）。
 * 拍不成就回 false（人話放 formError）——拍不成不做，沿 v1.1.1 評審 S3「備份沒拍成就不啟用」的硬度。
 * 手機沒有備份三件套：由 Rust 匯出全量 JSON（契約 §4.7），這裡直接放行。
 */
async function backupBeforeAdopt(): Promise<boolean> {
  if (shell !== "desktop") return true;
  await useBackupStore.getState().backupNow().catch(() => undefined);
  const backup = useBackupStore.getState();
  if (backup.lastError) {
    useSyncStore.setState({ formError: `備份沒拍成（${backup.lastError}）——先到〈備份與還原〉修好再試。` });
    return false;
  }
  return true;
}

/** join 成功後的收尾（first／pulled／merged／adopted／reconnected 共用） */
async function settleJoin(report: JoinReport): Promise<void> {
  // 快照與 join 內部拉下來的 hlc 都是 Rust 產的，TS 這邊的記憶體計數看不到——忘掉探測快取，下次寫入重吃種子
  resetSyncTablesProbe();
  await refreshStatusInner();
  attachSchedule();
  if (report.pull && report.pull.changed_tables.length > 0) await refreshAfterPull(report.pull);
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
      if (mode === "adopt_remote" && !(await backupBeforeAdopt())) return;
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
      if (report.message) useUiStore.getState().showToast({ message: report.message });
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
    set({ working: true, formError: null });
    try {
      if (!(await backupBeforeAdopt())) return;
      const report = await syncRepo.adoptEpoch();
      resetSyncTablesProbe(); // 表清空、cells 清空：下一次寫入重新吃 hlc 種子
      await refreshStatusInner();
      attachSchedule();
      const pulled = await syncRepo.pull();
      await refreshStatusInner();
      if (pulled.changed_tables.length > 0) await refreshAfterPull(pulled);
      // 產品評審 S2：手機沒有備份三件套，改用那份之前 Rust 會先匯出整顆庫——路徑要講出來，
      // 不然「我的東西去哪了」在手機上完全無跡可循（桌機是 TS 拍的 manual 備份，列在備份籤裡）。
      const saved = [
        report.export_path ? `這台原本的全部資料另存在 ${report.export_path}` : null,
        report.orphan_ops
          ? `還沒送出的 ${report.orphan_ops} 筆修改另存在 ${report.orphans_path ?? "本機"}`
          : null,
      ].filter(Boolean);
      useUiStore.getState().showToast({
        message: saved.length ? `已改用那份；${saved.join("；")}` : "已改用那份",
      });
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
        try {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
          const picked = await save({
            title: "匯出到手機",
            defaultPath: `nextstop-export-${stamp}.json`,
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
          if (picked === null) return null; // 主人取消＝零動作、不吵
          target = picked;
        } catch (e) {
          console.warn("[next-stop] 檔案選擇器開不了，改用 App 私有目錄：", messageOf(e));
        }
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
      if (report.message) useUiStore.getState().showToast({ message: report.message });
      if (report.outcome === "finished") void get().refreshCloudSnapshots();
    } catch (e) {
      // 多半是網路：標記檔留著，`runCycle` 每 60 秒補一次
      useUiStore.getState().showToast({ message: `換鑰匙沒做完：${messageOf(e)}` });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
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
  const head = `${when ? `${when}，` : ""}${what}。這台要改用那份`;
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
