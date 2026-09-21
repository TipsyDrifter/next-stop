/**
 * syncStore——v1.1.1 同步的前端狀態層（契約席立骨架、**WP8 填**）。
 *
 * 拍板依據：決策記錄〈v1.1 開工訪談拍板〉P4「開啟即拉＋前景每 60 秒＋手動」、快問「設定『同步』分頁＋側欄狀態點＋
 *           總開關」「桌機首次上雲前自動 manual 備份」；《2026-09-18-v1.1.1-同步地基契約.md》§9。
 *
 * 紀律（沿 backupStore）：元件不碰 repository、不 invoke，一律經 store；確認窗與 toast 都在 store 裡。
 * 狀態來源＝`syncRepo.status()` 的 `SyncStatus` 原封鏡射（**不自己推導 phase**——phase 是 Rust 算的，
 *   前端再算一次就會有兩份真相）。UI 只多兩顆本地旗標：`working`（有動作在飛）與 `formError`／`bridgeError`
 *   （錯誤要留在表單旁邊或整頁頂端，不是 10 秒就消失的 toast）。
 *
 * 節奏（`boot(shell)` 掛、`stop()` 拆；v1.1.1 契約 §9.4 → **v1.1.2 契約 §2.3 改成兩端對稱**）：
 *   * 一趟＝**先 push 再 pull**（自己的先出去、對方的再進來；兩者各自有 Rust 端的 in-flight 守衛，同一趟串行）。
 *   * 兩端（桌機 primary／手機 replica）都掛：`SYNC_WRITE_EVENT`（資料層寫入後丟）去抖 2 秒、
 *     每 60 秒（僅前景）、`visibilitychange`→visible、手動「立即同步」。
 *     手機從「只收不發」變成「寫完 2 秒就送」——D-1.1-7 的雙向，去抖秒數與桌機同一個（自決 2）。
 *   * 兩端都：in-flight 去重（同時只跑一趟）；`enabled=false`／未 configured 時什麼都不跑；
 *     `phase='epoch_changed'`（改正待ち）時不推不拉，停在原地等主人確認。
 * 拉完有變更（`changed_tables` 非空）→ `refreshAfterPull()`：`uiStore.loadSettings()`（只在 settings 真的被改到時
 *   才叫——它每次都會多掛一顆 matchMedia listener，見該函式；日界線以外的設定不同步，所以這個收斂是安全的）
 *   → 手機 `nodeStore.loadSidebar()`＋`loadToday(todayKey(dayStartHour))`／桌機 `nodeStore.refresh()`。
 *
 * 為什麼有 `bridgeError`：WP7 之前（或 command 還沒註冊的 build）`invoke` 會直接拋——這時整個同步分頁
 *   顯示一句人話就好，不能讓 UI 崩或空白（`?mock=1` 走記憶體 repository，不會走到這條）。
 */
import { create } from "zustand";
import { syncRepo } from "../data";
import type { PullReport, PushReport, SyncStatus, WizardEnv } from "../data/syncRepository";
import { NEEDS_WIPE_MARK, SYNC_WRITE_EVENT, resetSyncTablesProbe } from "../data/syncRepository";
import { todayKey } from "../lib/date";
import { useBackupStore } from "./backupStore";
import { useNodeStore } from "./nodeStore";
import { useUiStore } from "./uiStore";

/** 拉取／推送節奏（P4）；去抖秒數見 Plan §6 */
export const SYNC_INTERVAL_MS = 60_000;
export const SYNC_PUSH_DEBOUNCE_MS = 2_000;

/** 狀態文案（契約 §9.1；桌機分頁與手機頁共用同一份字） */
export const SYNC_PHASE_LABEL = {
  off: "未啟用",
  /** 設定好了、總開關關著（評審 S1：與「從沒設定」分開；關著只停網路，變更照記、開回來補送） */
  paused: "已關閉",
  running: "運行中",
  stopped: "停車中",
  /** v1.1.2：桌機還原並開了新紀元，這台等主人確認「以桌機版本重置」——ダイヤ改正＝整本時刻表換新 */
  epoch_changed: "改正待ち",
  gated: "信号待ち",
} as const;

export type SyncShell = "desktop" | "mobile";

export interface SyncStore {
  /** 最近一次 `status()` 的鏡射；null＝還沒問過，或橋接不通（看 `bridgeError`） */
  status: SyncStatus | null;
  /** 首次 boot 尚未跑完 */
  booting: boolean;
  /** 桌機「啟用同步」流程產出的配對碼（顯示 QR 與可複製文字）；null＝沒有或已收起 */
  pairingCode: string | null;
  /** 有動作在飛（configure／push／pull／reset）——鈕鎖起來、狀態點呼吸 */
  working: boolean;
  /** `sync_status()` 自己都叫不動（command 尚未註冊／非 Tauri 環境）；非 null＝整頁改顯示一句人話 */
  bridgeError: string | null;
  /** 表單旁邊的錯誤（啟用失敗、手機不是空庫…）；要留在原地給人讀，不用 toast */
  formError: string | null;

  /** 啟動鉤子（App.tsx 在 loadSettings 之後叫；可重入）。shell 決定 push 或 pull 節奏。 */
  boot: (shell: SyncShell) => Promise<void>;
  /** 拆節奏（App 卸載／殼切換時） */
  stop: () => void;
  refreshStatus: () => Promise<void>;
  /**
   * 桌機「啟用同步（這台是正本）」：先 `backupStore.backupNow()`（快問：首次上雲前自動 manual 備份）→
   * `syncRepo.configure({role:'primary', …})` → `push()` → `makePairingCode()` 存進 `pairingCode`。
   */
  enablePrimary: (input: {
    endpoint: string;
    bucket: string;
    access_key_id: string;
    secret_access_key: string;
    passphrase: string;
  }) => Promise<void>;
  /** 手機「貼上配對碼＋密語」：`applyPairingCode` → 立刻 `pull()`（全量） */
  /** wipe＝主人已在確認框同意「改用桌機的版本」（非空庫配對） */
  pairReplica: (code: string, passphrase: string, wipe?: boolean) => Promise<void>;
  /** 「立即同步」：依 role 走 push 或 pull */
  syncNow: () => Promise<PushReport | PullReport | null>;
  /** 總開關 */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** 「重設」：askConfirm(danger) → `resetLocal()`；不碰資料列、不碰雲端 */
  reset: () => void;
  /** 重新產出配對碼（primary） */
  showPairingCode: () => Promise<void>;
  hidePairingCode: () => void;
  /** 清掉表單旁的錯誤（使用者重打時） */
  clearFormError: () => void;

  // ── v1.1.2（契約席立 stub；WP10b 填確認窗與文案，流程骨架已在）──
  /** replica：主人確認「以桌機版本重置」→ `adoptEpoch()` → 立刻 `pull()` 全量（未推的修改由 Rust 先存 JSON） */
  adoptEpoch: () => Promise<void>;
  /** primary：還原後開新紀元（boot 看到 `restore_pending` 自動叫）→ 快照已進 outbox → 立刻 `push()` */
  beginNewEpoch: () => Promise<void>;
  /** 桌機「從精靈匯入」：回四欄給表單填；null＝讀不到（人話已放 formError） */
  importWizardEnv: () => Promise<WizardEnv | null>;
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
/** 同時只跑一趟（契約 §5.2 Rust 端也有一道；前端先擋一次，省掉來回） */
let inflight = false;
/**
 * 評審 S5：撞到 in-flight 的那一趟以前直接丟掉。手機蓋完章切走的情境正好會踩到——
 * 去抖 2 秒觸發時若剛好有一趟在飛，那次寫入就要等 60 秒（或下一次寫入）才出得去，
 * 與拍板「手機 push 節奏＝寫入後 2 秒去抖」不符。改成記一個旗標，當前這趟收尾時補跑一趟。
 */
let rerun = false;
/** 評審 S1：還原後補開新紀元的重試時刻（至多每 `SYNC_INTERVAL_MS` 一次） */
let lastEpochRetryAt = 0;
/** StrictMode 雙掛載／重複 boot 共用同一趟首次狀態查詢（沿 backupStore.boot） */
let bootInflight: Promise<void> | null = null;

function detachSchedule(): void {
  rerun = false; // 拆節奏之後不該再補跑一趟（評審 S5）
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
 * 依目前的 role 掛節奏（可重入：自己先 detach）。
 * 未 configured／橋接不通＝一顆計時器都不掛（桌機零改變的一部分：關著的同步不該有背景動作）。
 */
function attachSchedule(): void {
  detachSchedule();
  if (typeof window === "undefined") return;
  const status = useSyncStore.getState().status;
  if (!status || !status.configured || !status.role) return;

  // 前景才動（背景分頁不必每分鐘吵雲端；回到前景那一刻 replica 另有 visibilitychange 補一趟）
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void runCycle();
  }, SYNC_INTERVAL_MS);

  // v1.1.2：兩端都掛（以前只有 replica）。桌機也會最小化，回到前景那一刻補一趟最划算。
  visibilityHandler = () => {
    if (document.visibilityState === "visible") void runCycle();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
  // 主人真機驗收（2026-09-20）：桌機從別的視窗切回來不會發 visibilitychange（視窗本來就沒被隱藏），
  // 只剩 60 秒計時器在動——「手機蓋章、桌機切回前景要等一分鐘」。補 window focus 這一趟
  //（去抖 1.5 秒，免得 alt-tab 來回連打）。
  focusHandler = () => {
    if (focusTimer !== null) clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      focusTimer = null;
      if (document.visibilityState === "visible") void runCycle();
    }, 1500);
  };
  window.addEventListener("focus", focusHandler);

  // 資料層每次「有 op 的寫入」丟一顆 SYNC_WRITE_EVENT，去抖 2 秒合成一趟。
  // v1.1.2：**手機也掛**——replica 從「只收不發」變成雙向，在手機蓋的章要在 2 秒後自己飛回桌機
  // （自決 2：手機同桌機的 2 秒。手機多半是短暫使用，再長就會在切走 App 前都沒送出去）。
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
 * 跑一趟同步＝**先 push 再 pull**（v1.1.2 契約 §2.3；v1.1.1 是 primary 只推、replica 只拉）。
 * 先推的理由：本機剛改的東西先出去，接著拉回來的遠端物件裡才帶得到「對方看過我哪一版」（`seen`），
 * 衝突判定才不會把單純的落後誤判成併發。
 * `manual`＝主人按了「立即同步」（失敗會 toast；自動節奏失敗只落在狀態列，不打擾）。
 */
async function runCycle(manual = false): Promise<PushReport | PullReport | null> {
  const status = useSyncStore.getState().status;
  if (!status || !status.configured || !status.role) return null;
  // 評審 S1：`begin_new_epoch` 的 ④（PUT `EPOCH.bin`）失敗時，本機已經換成新紀元、雲端卻沒有標記物件——
  // 桌機的新編輯全推進沒人看的新目錄，手機也不會跟過來，兩台互相失明。以前只有下次 boot 會重試，
  // 桌機不重開就一直這樣。改成每一趟都先把它補完（成功了下一趟就走正常路）。
  if (status.restore_pending && status.role !== "replica") {
    // 至多每 60 秒試一次：失敗的那一次會把整庫重新快照進 outbox，綁在「寫入後兩秒」上會太吵。
    if (!inflight && !useSyncStore.getState().working && Date.now() - lastEpochRetryAt >= SYNC_INTERVAL_MS) {
      await useSyncStore.getState().beginNewEpoch();
    }
    return null;
  }
  if (!status.enabled) return null; // 總開關關著＝什麼都不跑（手動鈕在 UI 也是 disabled）
  // v1.1.2：改正待ち＝停在原地等主人確認，不推不拉（舊紀元的物件已不作數，推上去也沒人收）
  if (status.phase === "epoch_changed") return null;
  if (inflight) {
    rerun = true; // 評審 S5：這一趟不丟掉，等當前那趟收尾時補跑
    return null;
  }

  inflight = true;
  useSyncStore.setState({ working: true });
  try {
    const pushed = await syncRepo.push();
    const pulled = await syncRepo.pull();
    await refreshStatusInner();
    if (pulled.changed_tables.length > 0) await refreshAfterPull(pulled);
    // 同時改到同一格＝敗方已被 Rust 記進那張票的乘務記錄。這件事不講，主人只會看到值莫名其妙變了，
    // 卻不知道「另一個版本還留著、在乘務記錄裡」——所以自動趟也講（衝突本來就罕見，不會變成噪音）。
    if (pulled.conflicts > 0) {
      // 產品評審 S6：以前寫死「讓給了另一台」，但方向不只一種（這台刪過、對方改過＝收回刪除；
      // 這台是還沒推出去的贏家＝對方讓給這台）。toast 只報「有幾處」，方向留給乘務記錄那一行講。
      useUiStore.getState().showToast({
        message: `有 ${pulled.conflicts} 處兩台同時改到——詳情在該車票的乘務記錄`,
      });
    }
    if (manual) {
      // 留置線 §6 #1：以前撞到自動趟會回一份空報告，看起來像「沒東西可同步」
      if (pushed.busy || pulled.busy) {
        useUiStore.getState().showToast({ message: "另一趟同步正在進行，請稍候" });
      } else if (pulled.gated) {
        useUiStore.getState().showToast({ message: "兩台的版本不一致，同步先停在這裡" });
      }
    }
    return pulled;
  } catch (e) {
    const message = messageOf(e);
    // 評審 S6：pull 是「一個物件一個交易」，中途 Err 時前幾顆的遠端 hlc 已經戳進 sync_cells，
    // 但 `seedHlc(max_hlc)` 拿不到回報 ⇒ 下一筆本機寫入可能產出比 cells 還小的 hlc：
    // 資料 UPDATE 會過、cells 拒戳、outbox 帶著小 hlc 被對方判舊 ⇒ 兩台分歧而且不會自癒。
    // 忘掉探測快取，下一次寫入會重新 `seedHlc(MAX(hlc))`（outbox ∪ cells），吃到剛套進去的那些。
    resetSyncTablesProbe();
    // Rust 端會把 last_error 寫進 sync_meta；萬一連 status() 都叫不動，至少把這句留在畫面上
    useSyncStore.setState((s) => ({
      status: s.status ? { ...s.status, last_error: message, phase: "stopped" } : s.status,
    }));
    if (manual) useUiStore.getState().showToast({ message: `同步沒有完成：${message}` });
    return null;
  } finally {
    inflight = false;
    useSyncStore.setState({ working: false });
    // 評審 S5：飛行中被擋掉的那一趟，在這裡補跑（不 await——這一趟的呼叫端不該等下一趟）
    if (rerun) {
      rerun = false;
      void runCycle();
    }
  }
}

/** 內部版 refreshStatus（runCycle 與 store action 共用） */
async function refreshStatusInner(): Promise<void> {
  try {
    const status = await syncRepo.status();
    useSyncStore.setState({ status, bridgeError: null });
  } catch (e) {
    useSyncStore.setState({ status: null, bridgeError: messageOf(e) });
  }
}

/**
 * 拉到東西之後重載畫面（契約 §9.4）。
 * `loadSettings()` 只在 settings 真的被改到時才叫：它每次都會多掛一顆 matchMedia listener，
 * 而白名單只有 `day_start_hour`，多數 pull 根本沒碰 settings——不必每分鐘重掛一次。
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
      // 主人真機 2026-09-20：桌機新建的列車在手機路線圖按了好幾次「立即同步」都不出現，重開 App 才有——
      // 這裡以前只重載側欄與今日，路線圖第二層的樹（store.tree）留著舊的。開著的路線一併重載。
      if (node.routeId) await node.reloadRoute();
    } else {
      await node.refresh();
    }
    // v1.1.2：衝突列是 Rust 直寫 work_logs 的，節點的 updated_at 不會變——而 WorkLogList 的重載訊號
    // 只看 updated_at。側板／唯讀詳情開著時，不在這裡補一刀就要關掉重開才看得到那一行競合。
    if (report.changed_tables.includes("work_logs")) {
      for (const id of Object.keys(useNodeStore.getState().workLogs)) {
        await node.loadWorkLogs(id).catch(() => undefined);
      }
    }
  } catch (e) {
    console.warn("[next-stop] 同步後重載失敗：", messageOf(e));
  }
  // 契約 §5 的雙保險：遠端 hlc 已戳進 sync_cells，忘掉探測快取 ⇒ 下一次寫入重讀 MAX(hlc) 當種子。
  // （repository 的 `pull()` 已用 `max_hlc` 餵過一次；這一條擋的是「物件裡的 hlc 比 max_hlc 還大」之類的意外。）
  resetSyncTablesProbe();
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

  async boot(nextShell) {
    shell = nextShell;
    // 首次狀態查詢去重（StrictMode 會 boot→stop→boot）；節奏一律重掛，stop() 拆過就補回來
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
    // v1.1.2（契約 §4.1）：備份還原會換掉整顆 DB 再 `app.restart()`，所以「還原完要開新紀元」這件事
    // 不能寫在還原流程末尾（那個進程不會回來），改由 Rust 在換檔成功時寫一個標記檔，重啟後在這裡收。
    // 判準是 `role !== "replica"` 而**不是** `role === "primary"`：還原一份「啟用同步之前」的備份時，
    // 那顆 DB 裡根本沒有 role／salt／epoch，`role` 會是 undefined——用 `=== "primary"` 的話，
    // Rust 端專為這情況寫的 Reenable 分支（清掉對不上的憑證與設定、請主人重新啟用）永遠走不到。
    // replica 不必在這裡擋：Rust 的 `status()` 看到 replica 會順手清標記，`begin_new_epoch` 也會回 Err。
    const booted = get().status;
    if (booted?.restore_pending && booted.role !== "replica") {
      await get().beginNewEpoch();
    }
    attachSchedule();
    // 開啟即拉／開啟即推（P4）——沒啟用就什麼都不會發生（runCycle 自己擋）
    void runCycle();
  },

  stop() {
    detachSchedule();
  },

  async refreshStatus() {
    await refreshStatusInner();
  },

  async enablePrimary(input) {
    if (get().working) return;
    set({ working: true, formError: null });
    try {
      // 首次上雲前先拍一份 manual 備份（快問拍板）。
      // 評審 S3：以前備份失敗只出一聲 toast、照樣啟用，等於把「首次上雲前自動備份」降成盡力而為。
      // v1.1.1 是單向、正本不會被寫，但 v1.1.2 開雙向時這道保險就是 U6 的底線——地基期就硬起來：
      // 備份沒拍成（備份資料夾沒設、磁碟滿…）就不啟用，把人指回〈備份與還原〉。
      await useBackupStore.getState().backupNow().catch(() => undefined);
      const backup = useBackupStore.getState();
      if (backup.lastError) {
        set({ formError: `備份沒拍成（${backup.lastError}）——先到〈備份與還原〉修好再啟用同步。` });
        return;
      }

      const status = await syncRepo.configure({ ...input, role: "primary" });
      // 評審 S6：全量快照的 hlc 是 Rust 端產的，TS 這邊的記憶體計數看不到它——同毫秒就會撞出
      // 一模一樣的 hlc，而 LWW 用「嚴格大於」判勝，於是啟用後立刻做的那次修改會被快照吃掉。
      // 忘掉探測快取，下一次寫入會重新 `seedHlc(MAX(hlc))`，吃到快照留下的那個值。
      resetSyncTablesProbe();
      set({ status, bridgeError: null });
      attachSchedule();
      // 啟用當下把快照推上去（configure 已把快照寫進 outbox）
      await syncRepo.push();
      const code = await syncRepo.makePairingCode();
      set({ pairingCode: code });
      await refreshStatusInner();
      useUiStore.getState().showToast({ message: "同步已啟用——這台是正本" });
    } catch (e) {
      set({ formError: messageOf(e) });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  async pairReplica(code, passphrase, wipe = false) {
    if (get().working) return;
    set({ working: true, formError: null });
    try {
      const status = await syncRepo.applyPairingCode(code.trim(), passphrase, wipe);
      resetSyncTablesProbe(); // 同 enablePrimary：配對後重新吃一次 hlc 種子（評審 S6）
      set({ status, bridgeError: null });
      attachSchedule();
      const report = await syncRepo.pull();
      await refreshStatusInner();
      if (report.gated) {
        useUiStore.getState().showToast({ message: "兩台的版本不一致，同步先停在這裡" });
      } else {
        if (report.changed_tables.length > 0) await refreshAfterPull(report);
        // v1.1.2 起是雙向的（v1.1.1 這裡講的是「只收不發」）——第一時間就說清楚兩邊都會動
        useUiStore
          .getState()
          .showToast({ message: "配對完成——桌機的資料已拉下來，之後這台改的也會送回桌機" });
      }
    } catch (e) {
      const msg = messageOf(e);
      if (msg.startsWith(NEEDS_WIPE_MARK)) {
        // 非空庫（主人真機驗收 2026-09-20：重設後再配對被擋）——問一次，同意就帶 wipe 重來
        const body = msg.slice(NEEDS_WIPE_MARK.length);
        set({ formError: null, working: false });
        useUiStore.getState().askConfirm({
          title: "要改用桌機的版本嗎？",
          body,
          confirmLabel: "改用桌機的版本",
          danger: true,
          onConfirm: () => void get().pairReplica(code, passphrase, true),
        });
        return;
      }
      // 其他錯的那句人話由 Rust 給，原句留在表單下面（toast 10 秒讀不完）
      set({ formError: msg });
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
      if (enabled) void runCycle();
    } catch (e) {
      useUiStore.getState().showToast({ message: `總開關切不動：${messageOf(e)}` });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  reset() {
    useUiStore.getState().askConfirm({
      title: "要重設這台的同步嗎？",
      // 評審 S4：重設後再啟用會現生一個新 epoch，手機仍盯著舊前綴 ⇒ 靜默失聯（偵測留 v1.1.2），
      // 所以「手機要重新配對」這句現在就得寫在確認窗裡。
      body:
        "會清掉這台的同步設定與雲端憑證，之後要重新配對才會再同步。這台的資料與雲端上的資料都不會被動到。" +
        "之後若再啟用同步，手機也要重新配對一次。",
      confirmLabel: "重設",
      danger: true,
      onConfirm: () => {
        void (async () => {
          set({ working: true, formError: null });
          try {
            const status = await syncRepo.resetLocal();
            set({ status, pairingCode: null, bridgeError: null });
            detachSchedule();
            useUiStore.getState().showToast({ message: "已重設這台的同步設定" });
          } catch (e) {
            useUiStore.getState().showToast({ message: `重設沒有完成：${messageOf(e)}` });
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

  clearFormError() {
    if (get().formError) set({ formError: null });
  },

  // ── v1.1.2 ──

  async adoptEpoch() {
    if (get().working) return;
    set({ working: true, formError: null });
    try {
      const report = await syncRepo.adoptEpoch();
      resetSyncTablesProbe(); // 表清空、cells 清空：下一次寫入重新吃 hlc 種子
      await refreshStatusInner();
      attachSchedule();
      const pulled = await syncRepo.pull();
      await refreshStatusInner();
      if (pulled.changed_tables.length > 0) await refreshAfterPull(pulled);
      useUiStore.getState().showToast({
        message: report.orphan_ops
          ? `已改用桌機的版本；這台還沒送出的 ${report.orphan_ops} 筆修改另存在 ${report.orphans_path ?? "本機"}`
          : "已改用桌機的版本",
      });
    } catch (e) {
      set({ formError: messageOf(e) });
      await refreshStatusInner();
    } finally {
      set({ working: false });
    }
  },

  async beginNewEpoch() {
    if (get().working) return;
    lastEpochRetryAt = Date.now(); // 評審 S1：不論成敗都記一次，失敗的重試由 `runCycle` 每 60 秒補
    set({ working: true, formError: null });
    try {
      const report = await syncRepo.beginNewEpoch();
      resetSyncTablesProbe(); // 快照的 hlc 是 Rust 產的（同 enablePrimary 的評審 S6）
      await refreshStatusInner();
      if (report.outcome === "renewed") {
        attachSchedule();
        await syncRepo.push();
        await refreshStatusInner();
      } else {
        detachSchedule();
      }
      useUiStore.getState().showToast({ message: report.message });
    } catch (e) {
      useUiStore.getState().showToast({ message: `同步紀元沒有重設：${messageOf(e)}` });
      await refreshStatusInner();
    } finally {
      set({ working: false });
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
