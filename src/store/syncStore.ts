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
 * 節奏（`boot(shell)` 掛、`stop()` 拆；兩端對稱）：
 *   * 一趟＝**先 push 再 pull**；`SYNC_WRITE_EVENT` 去抖 2 秒、每 60 秒（僅前景）、`visibilitychange`、window focus、手動。
 *   * in-flight 去重；未加入／總開關關著／改正待ち／鍵違い時什麼都不跑。
 */
import { create } from "zustand";
import { syncRepo } from "../data";
import type {
  JoinInput,
  JoinMode,
  JoinOutcome,
  JoinReport,
  PairingFields,
  PullReport,
  PushReport,
  RestoreChoice,
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
} as const;

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

  /** 啟動鉤子（App.tsx 在 loadSettings 之後叫；可重入）。shell 決定重載哪個畫面與「改用」前拍不拍備份。 */
  boot: (shell: SyncShell) => Promise<void>;
  /** 拆節奏（App 卸載／殼切換時） */
  stop: () => void;
  refreshStatus: () => Promise<void>;
  /** 單一入口「加入同步」：回 needs_choice 就存起來等 `joinWith`；其餘依報告收尾（push／重載／toast） */
  join: (input: JoinInput) => Promise<void>;
  /** 頁面問完「兩邊都保留」／「改用另一台的」再帶 mode 回來；桌機選改用前先拍 manual 備份 */
  joinWith: (mode: JoinMode) => Promise<void>;
  /** 收起二選一，什麼都沒動 */
  cancelChoice: () => void;
  /** 改密語：成功回 true（toast）、失敗回 false（人話在 formError） */
  changePassphrase: (current: string, next: string) => Promise<boolean>;
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
/** StrictMode 雙掛載／重複 boot 共用同一趟首次狀態查詢（沿 backupStore.boot） */
let bootInflight: Promise<void> | null = null;
/**
 * 加入時回了 needs_choice 的那份輸入（含密語與 secret）——只活在記憶體、等 `joinWith` 帶 mode 重送；
 * `joinWith`／`cancelChoice` 一定清掉。不進 zustand state（devtools／log 都不該看到它）。
 */
let pendingJoinInput: JoinInput | null = null;

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

  async joinWith(mode) {
    const base = pendingJoinInput;
    if (!base || get().working) return;
    set({ working: true, formError: null });
    try {
      if (mode === "adopt_remote" && !(await backupBeforeAdopt())) return;
      const report = await syncRepo.join({ ...base, mode });
      pendingJoinInput = null;
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
    set({ pendingChoice: null, formError: null });
  },

  async changePassphrase(current, next) {
    if (get().working) return false;
    set({ working: true, formError: null });
    try {
      const report = await syncRepo.changePassphrase(current, next);
      await refreshStatusInner();
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

/** 鍵違い的說明句（契約 §8.5） */
export function describeLocked(status: SyncStatus): string {
  if (status.locked === "salt") {
    return "雲端上的這份資料已用別的密語重新建立，這台的密語打不開它。請「重新加入同步」並輸入新密語（這台的資料不會被動，加入時會問要不要合併）。";
  }
  // 產品評審 N4：這一態是「雲端多了一個這台打不開的紀元目錄」，實務上只由殘留或竄改造成。
  // 舊文案寫「重新加入並輸入新密語」走不通——join 會回到自己那個拆得開的紀元，下一趟又鎖回來。
  return "雲端上多了一個這台打不開的紀元（多半是別的密語留下的殘留）。同步先停在這裡；要清掉它得到 Cloudflare 後台把那個目錄刪掉，或用建立它的那組密語「重新加入同步」。";
}
