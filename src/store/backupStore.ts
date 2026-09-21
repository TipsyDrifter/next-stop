/**
 * backupStore——M3 ⑥ 備份三件套的前端狀態層（WP2）。
 *
 * 三件套的第三件（狀態與通知）都收在這裡：
 *   ①還原  → `restore(path)`（askConfirm danger → repo.restore，成功不會回來、App 重啟）
 *   ②位置  → `keep`／`secondaryDir` 兩個設定（即選即存，沿 `uiStore.setCalendarView` 模式）
 *   ③通知  → `boot()` 依 `startupReport` 發 toast、寫 `backup_last_ok_at`／`backup_last_error`／
 *            `backup_fail_streak`；連敗 ≥3 由 `App.tsx` 讀 `failStreak` 出啟動橫幅。
 *
 * 紀律：元件不碰 repository，一律經 store（產品規格書 §157、§44）；
 *       settings 一律走 `settingsRepo`，鍵名來自 WP0 契約 `BACKUP_SETTING_KEYS`。
 * 契約：型別／介面／鍵名／檔名規則都在 `src/data/backupRepository.ts`（WP0，commit 7e9d8e6），本檔不改那些。
 */
import { create } from "zustand";
import {
  backupRepo,
  settingsRepo,
  parseKeep,
  BACKUP_SETTING_KEYS,
  BACKUP_KEEP_DEFAULT,
  DEV_FLAGS,
  type BackupEntry,
  type BackupReport,
  type PolicyReport,
} from "../data";
import { useSyncStore } from "./syncStore";
import { useUiStore } from "./uiStore";

/**
 * 目前正在飛的動作（給 WP3 禁用按鈕／顯示「…中」用）。
 * `booting` 是另一顆旗標（首次 boot 尚未跑完），兩者語義不同：
 * status 講「現在在做什麼」，booting 講「清單與狀態還沒到齊」。
 */
export type BackupStatus = "idle" | "booting" | "backing-up" | "restoring" | "refreshing";

/** 連敗到這個次數就在 App 頂端出啟動橫幅（決策 9 三層通知的第三層） */
export const BACKUP_FAIL_BANNER_STREAK = 3;

/** toast 三句（成功不吵，所以只有兩句失敗的）——WP3 若要在分頁內重用，從這裡取，別各寫一份 */
export const BACKUP_TOAST = {
  failed: "今天的自動備份失敗",
  secondaryFailed: "第二備份位置寫不進去",
  action: "看原因",
} as const;

/**
 * `?mock=1&backup=streak3` 端點：boot 時 `failStreak` 從 2 起跳，這次 report 再失敗一次＝3，
 * 剛好踩到橫幅門檻（`MemoryBackupRepository` 在 fail／streak3 兩個 mode 都回 error）。
 * 只在 mock／dev 生效（`DEV_FLAGS` 正式打包恆 null），且 settings 已有值時以 settings 為準。
 */
const MOCK_STREAK_BASE = DEV_FLAGS.backup === "streak3" ? 2 : 0;

/** 第二位置失敗的 toast「每個 session 一次」——吵一次就夠，不要每次 applyPolicy 都彈 */
let secondaryToastShown = false;

/** StrictMode 雙掛載／重複呼叫時共用同一趟 boot（沿 nodeStore 的 inflight 去重手法） */
let bootInflight: Promise<void> | null = null;

/**
 * Rust 在「pool 已經關掉」之後才失敗時，錯誤訊息一定帶這句尾巴（`backup.rs` 的 `POST_CLOSE_HINT`）。
 * 這種失敗 DB 檔沒被動過、但這個進程已經沒有資料庫連線——再讓主人按鈕只會一路撞 plugin-sql 的
 * 「database not loaded」。前端據此把整個備份分頁鎖成「請重新啟動」，並在主畫面出常駐橫幅。
 * （要改成「失敗也一律 app.restart()＋重啟後回報」得新增事件／旗標檔，屬接口變更，見回報。）
 */
const RESTART_MARKER = "請重新啟動私鐵手帳";

/** 「最舊到哪一天」：給改份數的確認窗用，只要日期不要時刻 */
function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 改成新配額後，主位置會被輪替刪掉哪幾份。
 * 與 Rust `rotate(dir, keep, PRIMARY_KINDS)` 同一條規則：只算 auto＋manual（保險份另有 3 份配額），
 * 清單本身已由 repository 由新到舊排好，所以超出配額的就是尾巴那幾份。
 */
function doomedByKeep(entries: BackupEntry[], keep: number): { count: number; oldest: string | null } {
  const rotatable = entries.filter((e) => e.location === "primary" && e.kind !== "safety");
  const count = Math.max(0, rotatable.length - Math.max(1, keep));
  return { count, oldest: count > 0 ? (rotatable[rotatable.length - 1]?.created_at ?? null) : null };
}

const nowIso = () => new Date().toISOString();

/** settings 讀回來的字串 → 連敗次數（非數字／負數一律當 0） */
function parseStreak(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 空字串在 settings 裡代表「沒有」（沿 `backup_dir_secondary` 的約定），統一收斂成 null */
function emptyToNull(raw: string | null): string | null {
  return raw && raw.trim() !== "" ? raw : null;
}

/** repository 丟出來的例外 → 給主人看的人話（Rust 端已經回人話，這裡只做保底） */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

interface BackupStore {
  /** 備份清單（主位置＋第二位置合併；順序由 repository 決定，UI 不再排） */
  entries: BackupEntry[];
  status: BackupStatus;
  /** 保留份數（自動＋手動合計；保險份不佔配額） */
  keep: number;
  /** 第二備份位置絕對路徑；null＝未設 */
  secondaryDir: string | null;
  /** 上次成功備份（UTC ISO）；null＝還沒成功過 */
  lastOkAt: string | null;
  /** 上次失敗原因；null＝目前沒有待處理的失敗 */
  lastError: string | null;
  /** 連續失敗次數（成功歸零）；≥ BACKUP_FAIL_BANNER_STREAK 出啟動橫幅 */
  failStreak: number;
  secondaryLastOkAt: string | null;
  secondaryLastError: string | null;
  /** 首次 boot 是否還沒跑完（清單與狀態尚未到齊） */
  booting: boolean;
  /**
   * 還原在「pool 已關、檔還沒換成功」之後失敗＝這個進程已經沒有資料庫連線。
   * DB 檔本身沒被動過，但任何寫入都會在 plugin-sql 撞牆，所以整頁鎖住並常駐要求重新啟動。
   */
  needsRestart: boolean;

  /** 啟動鉤子：讀設定 → 讀 Rust 啟動快照結果 → 記錄成敗 → 輪替鏡射 → 列清單 → 該吵才吵。可重入。 */
  boot: () => Promise<void>;
  /** 設定頁「立即備份」：備一份 manual＋輪替鏡射，然後重列清單。 */
  backupNow: () => Promise<void>;
  /** 還原到某一份：danger 確認 → repo.restore（成功不會回來，App 重啟）。 */
  restore: (path: string, fileName?: string) => void;
  /** 改保留份數；會刪到現有備份時先走 askConfirm(danger)，取消＝連設定都不動。 */
  setKeep: (keep: number) => Promise<void>;
  /** 選第二備份位置（dialog）；取消＝不動。 */
  pickSecondary: () => Promise<void>;
  clearSecondary: () => Promise<void>;
  refreshList: () => Promise<void>;
  /** 在檔案總管開啟備份資料夾。 */
  revealBackupsDir: () => Promise<void>;
  /** 「從檔案還原…」：選任意 `.db` → 驗檔 → 走同一條 restore 確認流程。 */
  restoreFromFile: () => Promise<void>;
  /** ⑧ 清場步驟二（DEV 限定）：清空資料但保留 settings。 */
  resetDatabaseKeepSettings: () => Promise<void>;
}

export const useBackupStore = create<BackupStore>((set, get) => ({
  entries: [],
  status: "idle",
  keep: BACKUP_KEEP_DEFAULT,
  secondaryDir: null,
  lastOkAt: null,
  lastError: null,
  failStreak: 0,
  secondaryLastOkAt: null,
  secondaryLastError: null,
  booting: true,
  needsRestart: false,

  async boot() {
    if (bootInflight) return bootInflight;
    bootInflight = (async () => {
      set({ booting: true, status: "booting" });
      try {
        // ── 1. 設定（uiStore.loadSettings 之後才叫得動；讀不到就吃預設，不讓啟動卡住）
        const [keepRaw, secondaryRaw, lastOkRaw, lastErrRaw, streakRaw, secOkRaw, secErrRaw] =
          await Promise.all([
            settingsRepo.get(BACKUP_SETTING_KEYS.keep),
            settingsRepo.get(BACKUP_SETTING_KEYS.secondaryDir),
            settingsRepo.get(BACKUP_SETTING_KEYS.lastOkAt),
            settingsRepo.get(BACKUP_SETTING_KEYS.lastError),
            settingsRepo.get(BACKUP_SETTING_KEYS.failStreak),
            settingsRepo.get(BACKUP_SETTING_KEYS.secondaryLastOkAt),
            settingsRepo.get(BACKUP_SETTING_KEYS.secondaryLastError),
          ]).catch(() => [null, null, null, null, null, null, null] as (string | null)[]);

        const keep = parseKeep(keepRaw);
        const secondaryDir = emptyToNull(secondaryRaw);
        set({
          keep,
          secondaryDir,
          lastOkAt: emptyToNull(lastOkRaw),
          lastError: emptyToNull(lastErrRaw),
          failStreak: streakRaw === null ? MOCK_STREAK_BASE : parseStreak(streakRaw),
          secondaryLastOkAt: emptyToNull(secOkRaw),
          secondaryLastError: emptyToNull(secErrRaw),
        });

        // ── 2. Rust 在 migration 之前那一次快照的結果（純讀 managed state，不會再備一次）
        let report: BackupReport;
        try {
          report = await backupRepo.startupReport();
        } catch (e) {
          report = { status: "error", message: messageOf(e) };
        }
        const failed = await recordReport(report, set, get);

        // ── 3. 清單（先讓分頁可用：第二位置指到離線 NAS 時鏡射會卡秒級到分鐘級，
        //        不能讓「立即備份」「還原」在最慌張的時候被鏡射擋在 disabled）
        await loadList(secondaryDir, set);

        // ── 4. 該吵才吵：主備份失敗最大聲（成功一律不吵）
        if (failed) toastBackupFailed();

        // ── 5. 輪替＋鏡射丟背景（Rust 不讀 settings，keep／secondary 由前端補上）；
        //        跑完再列一次清單，鏡射出來的那幾份晚幾秒進清單沒關係。
        void runPolicy(keep, secondaryDir, set, failed).then(() => loadList(secondaryDir, set));
      } finally {
        set({ booting: false, status: "idle" });
        bootInflight = null;
      }
    })();
    return bootInflight;
  },

  async backupNow() {
    const { keep, secondaryDir } = get();
    set({ status: "backing-up" });
    try {
      let report: BackupReport;
      try {
        report = await backupRepo.backupNow(keep, secondaryDir);
      } catch (e) {
        report = { status: "error", message: messageOf(e) };
      }
      const failed = await recordReport(report, set, get);
      await loadList(secondaryDir, set);
      if (failed) toastBackupFailed();
      else if (report.status === "ok") useUiStore.getState().showToast({ message: "備份完成" });
      // backupNow 的 Rust 實作自帶 policy，這裡只補鏡射狀態的回寫（applyPolicy 是冪等的）；
      // 同 boot：鏡射丟背景，不讓離線的第二位置把按鈕鎖在 disabled（結束後再列一次清單）
      void runPolicy(keep, secondaryDir, set, failed).then(() => loadList(secondaryDir, set));
    } finally {
      set({ status: "idle" });
    }
  },

  restore(path, fileName) {
    const label = fileName ?? path.split(/[\\/]/).pop() ?? path;
    /**
     * v1.1.2（D-1.1-4 甲「還原＝新紀元」；契約 §4.1）：這台設定過同步的話，還原不只換回舊資料——
     * 重啟後會自動開一個新紀元、把整庫重新上傳，手機下次同步時會被要求改用桌機的版本。
     * 這是還原最貴的一個副作用，**要在按下去之前講**，不能只在事後補一聲 toast。
     * （動作本身不在這裡：`backup_restore` 換檔後 App 立刻重啟，這個進程回不來——Rust 在換檔成功時
     *   留一個標記檔，重啟後由 `syncStore.boot()` 接手開紀元。）
     */
    const syncing = !!useSyncStore.getState().status?.configured;
    useUiStore.getState().askConfirm({
      title: "要還原到這一份備份嗎？",
      body:
        `${label}：會先把現在的資料另存保險備份，然後重新啟動。` +
        // 產品評審 S2：原句寫「同步會重設為新紀元」——「紀元」是內部語彙，主人讀不出會發生什麼。
        // 改成講具體後果（重新上傳、手機要改用桌機版、手機未送出的修改會先存檔）。
        (syncing
          ? "還原後這台會把整份資料重新上傳；手機下次同步會被要求改用桌機的版本，手機上還沒送出的修改會先存檔。"
          : ""),
      confirmLabel: "還原並重新啟動",
      danger: true,
      onConfirm: () => {
        set({ status: "restoring" });
        // 成功不會回來（App 重啟）；只有失敗才走到 catch
        void backupRepo.restore(path).catch((e: unknown) => {
          const message = messageOf(e);
          // pool 已關之後才失敗＝這個進程沒有資料庫連線了：10 秒的 toast 撐不住這種狀態，
          // 改成整頁鎖住＋主畫面常駐橫幅，別讓主人繼續操作一個寫不進去的 App（DB 檔沒被動過）。
          const needsRestart = message.includes(RESTART_MARKER);
          set({ status: "idle", needsRestart });
          useUiStore.getState().showToast({ message: `還原沒有完成：${message}` });
        });
      },
    });
  },

  async setKeep(keep) {
    if (keep === get().keep) return;

    // 改份數＝立刻輪替＝立刻刪檔，而 select 在 Windows 上 ↑↓ 就即改即發（從 30 掉到 3 一下少 27 份）。
    // 這是備份功能裡唯一一顆「不確認就毀資料」的動作——先問，再改（確認前 state 不動，select 自己彈回舊值）。
    const doomed = doomedByKeep(get().entries, keep);
    if (doomed.count > 0) {
      const oldest = fmtDay(doomed.oldest);
      useUiStore.getState().askConfirm({
        title: `保留份數改成 ${keep} 份？`,
        body:
          `會立刻刪掉最舊的 ${doomed.count} 份備份${oldest ? `（最舊的那份是 ${oldest}）` : ""}，刪掉就找不回來了。` +
          (get().secondaryDir ? "第二備份位置也會照新配額一起刪。" : ""),
        confirmLabel: `刪除並改成 ${keep} 份`,
        danger: true,
        onConfirm: () => void applyKeep(keep, set, get),
      });
      return;
    }
    await applyKeep(keep, set, get);
  },

  async pickSecondary() {
    const dir = await backupRepo.pickDirectory().catch((e: unknown) => {
      useUiStore.getState().showToast({ message: `選不到資料夾：${messageOf(e)}` });
      return null;
    });
    if (!dir) return; // 取消＝不動
    set({ secondaryDir: dir, secondaryLastError: null });
    await settingsRepo.set(BACKUP_SETTING_KEYS.secondaryDir, dir);
    await settingsRepo.set(BACKUP_SETTING_KEYS.secondaryLastError, "");
    // 新指的位置馬上鏡射一次，成不成當場就知道
    secondaryToastShown = false;
    set({ status: "refreshing" });
    try {
      await runPolicy(get().keep, dir, set, false);
      await loadList(dir, set);
    } finally {
      set({ status: "idle" });
    }
  },

  async clearSecondary() {
    set({ secondaryDir: null, secondaryLastOkAt: null, secondaryLastError: null });
    await Promise.all([
      settingsRepo.set(BACKUP_SETTING_KEYS.secondaryDir, ""),
      settingsRepo.set(BACKUP_SETTING_KEYS.secondaryLastOkAt, ""),
      settingsRepo.set(BACKUP_SETTING_KEYS.secondaryLastError, ""),
    ]);
    await loadList(null, set);
  },

  async refreshList() {
    set({ status: "refreshing" });
    try {
      await loadList(get().secondaryDir, set);
    } finally {
      set({ status: "idle" });
    }
  },

  async revealBackupsDir() {
    try {
      await backupRepo.revealBackupsDir();
    } catch (e) {
      useUiStore.getState().showToast({ message: `開不了備份資料夾：${messageOf(e)}` });
    }
  },

  async restoreFromFile() {
    const path = await backupRepo.pickDbFile().catch((e: unknown) => {
      useUiStore.getState().showToast({ message: `選不到檔案：${messageOf(e)}` });
      return null;
    });
    if (!path) return;
    try {
      await backupRepo.validateFile(path);
    } catch (e) {
      useUiStore.getState().showToast({ message: `這個檔不能用來還原：${messageOf(e)}` });
      return;
    }
    get().restore(path);
  },

  async resetDatabaseKeepSettings() {
    const fn = backupRepo.resetDatabaseKeepSettings;
    if (!fn) {
      useUiStore.getState().showToast({ message: "這個版本沒有重置功能" });
      return;
    }
    try {
      await fn.call(backupRepo);
      useUiStore.getState().showToast({ message: "已清空資料（設定保留）——請重新啟動 App" });
    } catch (e) {
      useUiStore.getState().showToast({ message: `重置失敗：${messageOf(e)}` });
    }
  },
}));

/* ═══════════════════════════════════════════════════════════════════════
   內部小工（不匯出——只有 store 自己用）
   ═══════════════════════════════════════════════════════════════════════ */

type SetState = (partial: Partial<BackupStore>) => void;
type GetState = () => BackupStore;

/** 真的改份數：落設定 → 照新配額輪替一次（主人才看得到清單縮短）→ 重列清單 */
async function applyKeep(keep: number, set: SetState, get: GetState): Promise<void> {
  set({ keep });
  await settingsRepo.set(BACKUP_SETTING_KEYS.keep, String(keep));
  const { secondaryDir } = get();
  set({ status: "refreshing" });
  try {
    await runPolicy(keep, secondaryDir, set, false);
    await loadList(secondaryDir, set);
  } finally {
    set({ status: "idle" });
  }
}

/**
 * 把一次 report 的結果落到 state＋settings，回傳「這次算不算失敗」。
 *   ok            → lastOkAt＝現在、lastError 清掉、連敗歸零
 *   error         → lastError＝訊息、連敗 +1
 *   skipped_today → 今天已經備過，什麼都不動（不是成功也不是失敗）
 *   no_db         → DB 還沒建（首次啟動），不算失敗、不動計數
 */
async function recordReport(report: BackupReport, set: SetState, get: GetState): Promise<boolean> {
  if (report.status === "ok") {
    const at = nowIso();
    set({ lastOkAt: at, lastError: null, failStreak: 0 });
    await Promise.all([
      settingsRepo.set(BACKUP_SETTING_KEYS.lastOkAt, at),
      settingsRepo.set(BACKUP_SETTING_KEYS.lastError, ""),
      settingsRepo.set(BACKUP_SETTING_KEYS.failStreak, "0"),
    ]).catch(() => undefined);
    return false;
  }
  if (report.status === "error") {
    const streak = get().failStreak + 1;
    set({ lastError: report.message, failStreak: streak });
    await Promise.all([
      settingsRepo.set(BACKUP_SETTING_KEYS.lastError, report.message),
      settingsRepo.set(BACKUP_SETTING_KEYS.failStreak, String(streak)),
    ]).catch(() => undefined);
    return true;
  }
  return false; // skipped_today／no_db
}

/**
 * 輪替＋鏡射，並把第二位置的成敗落到 state＋settings。
 * 第二位置失敗**不算主備份失敗**、不進連敗計數（D-⑥-4）；只在本 session 首次失敗吵一次，
 * 而且主備份自己也失敗的時候讓位（`mainFailed`＝true 就不搶 toast）。
 */
async function runPolicy(
  keep: number,
  secondaryDir: string | null,
  set: SetState,
  mainFailed: boolean,
): Promise<void> {
  let policy: PolicyReport;
  try {
    policy = await backupRepo.applyPolicy(keep, secondaryDir);
  } catch (e) {
    // 輪替本身失敗只記一筆，不動主備份的連敗計數（檔案都還在，沒有資料風險）
    console.warn("[next-stop] 備份輪替失敗：", messageOf(e));
    return;
  }
  const secondary = policy.secondary;
  if (!secondary) return; // 沒設第二位置，這次沒鏡射

  if (secondary.ok) {
    const at = nowIso();
    set({ secondaryLastOkAt: at, secondaryLastError: null });
    await Promise.all([
      settingsRepo.set(BACKUP_SETTING_KEYS.secondaryLastOkAt, at),
      settingsRepo.set(BACKUP_SETTING_KEYS.secondaryLastError, ""),
    ]).catch(() => undefined);
    return;
  }

  set({ secondaryLastError: secondary.message });
  await settingsRepo
    .set(BACKUP_SETTING_KEYS.secondaryLastError, secondary.message)
    .catch(() => undefined);
  if (!mainFailed && !secondaryToastShown) {
    secondaryToastShown = true;
    useUiStore.getState().showToast({
      message: BACKUP_TOAST.secondaryFailed,
      actionLabel: BACKUP_TOAST.action,
      onAction: () => useUiStore.getState().openSettings("backup"),
    });
  }
}

/** 列清單；失敗不致命（清單空著，狀態列照樣顯示上次成功時間） */
async function loadList(secondaryDir: string | null, set: SetState): Promise<void> {
  try {
    set({ entries: await backupRepo.list(secondaryDir) });
  } catch (e) {
    console.warn("[next-stop] 備份清單讀取失敗：", messageOf(e));
    set({ entries: [] });
  }
}

/** 失敗 toast：帶「看原因」動作鈕，直接開設定的備份分頁 */
function toastBackupFailed(): void {
  useUiStore.getState().showToast({
    message: BACKUP_TOAST.failed,
    actionLabel: BACKUP_TOAST.action,
    onAction: () => useUiStore.getState().openSettings("backup"),
  });
}
