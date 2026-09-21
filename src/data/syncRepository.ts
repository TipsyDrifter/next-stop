/**
 * syncRepository——v1.1.1 同步地基的 TS 端契約層（契約席立；**WP5 填 outbox 接線、WP8 只認這裡的型別**）。
 *
 * 拍板依據：`docs/決策記錄.md`〈v1.1 Plan 草案拍板〉D-1.1-3（只搬主人資料）／D-1.1-5（欄位級 LWW＋HLC）／
 *           D-1.1-6（配對碼）＋《2026-09-18-v1.1.1-同步地基契約.md》§2–§6。
 *
 * 本檔三件事：
 *   ① 型別與 invoke 名稱（與 Rust `src-tauri/src/sync/{engine,commands}.rs` 的 serde 型別同名同形，snake_case）。
 *   ② `TauriSyncRepository`／`MemorySyncRepository`（`?mock=1`）——UI／store 一律經 `syncRepo`，不直接 invoke。
 *   ③ 寫入層的純函式：`nextHlc()`（HLC 字串）、`occurrenceId()`（uuid v5）、`syncSideStatements()`（一筆 op →
 *      outbox＋cells 兩句 INSERT）、`runWriteBatch()`（把「資料語句＋同步語句」包成 **一次 execute** 的
 *      `BEGIN IMMEDIATE … COMMIT`）。WP5 在 `SqliteNodeRepository`／`SqliteSettingsRepository` 的每個寫入點
 *      改呼叫 `runWriteBatch`，不再各自 `db.execute`。
 *
 * 為什麼「一次 execute」：tauri-plugin-sql 的 pool 預設 10 條連線，分開呼叫 `execute("BEGIN")`／`execute(...)`
 *   會落在不同連線上——交易根本不成立。sqlx-sqlite 允許一個 query 字串含多句、逐句執行在**同一條**連線
 *   （已讀原始碼確認：`connection/execute.rs` 的 `ExecuteIter` 逐句 `prepare_next`），且 `$N` 是**整批絕對編號**
 *   （`arguments.rs` 直接用 N 索引 values），所以本檔負責把各句的 `$1..$k` 重新編成全域號。
 *   代價（契約 §2.6）：批次中途失敗時那條連線會留著未收的交易——`runWriteBatch` 失敗後執行
 *   `recoverOpenTransaction()`：連續 `ROLLBACK` 最多 10 次（pool 上限），idle 佇列是 FIFO、逐次輪到每一條，
 *   直到某次 ROLLBACK 成功（＝找到那條）為止。
 *
 * 閘門（`CONFIGURED_GATE`）：outbox／cells 兩句都是 `INSERT … SELECT … WHERE EXISTS(...)`，SQL 層自己判斷、
 *   TS 不留狀態。**看的是 `sync_meta.role`（＝這台設定過同步沒有），不是總開關 `enabled`**（評審 B1 改判）：
 *   總開關關著只該停網路，不該讓那段時間的變更永遠傳不過去。沒設定過同步的桌機＝一列都不會多寫，
 *   既有路徑除了多包一層交易之外行為不變。
 */

import type Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

/* ═══════════════════════════════════════════════════════════════════════
   型別（與 Rust serde 同名同形）
   ═══════════════════════════════════════════════════════════════════════ */

export type SyncRole = "primary" | "replica";

/**
 * off＝從沒設定過／paused＝設定好但總開關關著／running＝運行中／
 * stopped＝停車中（憑證缺或上次失敗）／gated＝信号待ち（對方版本較新）／
 * epoch_changed＝改正待ち（v1.1.2：桌機還原並開了新紀元，這台等主人確認「以桌機版本重置」；只有 replica 會有）
 *
 * 評審 S1：`off` 以前同時代表「從沒設定」與「開關關著」，主人在畫面上分不出來
 * （顯示「未啟用」，下面卻同時有總開關與「立即同步」）。四態擴成五態。
 */
export type SyncPhase = "off" | "paused" | "running" | "stopped" | "gated" | "epoch_changed";

export interface SyncStatus {
  enabled: boolean;
  role: SyncRole | null;
  device_id: string;
  epoch: string | null;
  /** credstore 有憑證 */
  configured: boolean;
  phase: SyncPhase;
  busy: boolean;
  /** UTC ISO；null＝還沒成功過 */
  last_sync_at: string | null;
  last_error: string | null;
  /** outbox 待上傳筆數（primary）；replica 恆 0 */
  pending_ops: number;
  schema: number;
  remote_schema: number | null;
  /** v1.1.2：還原剛完成、尚未開新紀元（Rust 看 app 資料目錄的標記檔）；primary 端 boot 看到就 `beginNewEpoch()` */
  restore_pending: boolean;
  /** v1.1.2：replica 偵測到的新紀元號；非 null ⇒ phase='epoch_changed' */
  pending_epoch: string | null;
  /**
   * v1.1.2 產品評審 B1：上一次「改用桌機的版本」另存了幾筆未送出的修改、存在哪、什麼時候。
   * 同步頁常駐一行——這件事以前只在一聲 10 秒的 toast 裡講過，錯過就再也查不到。
   */
  last_orphans: { count: number; path: string; at: string } | null;
}

export interface SyncConfigureInput {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
  passphrase: string;
  /** base64url 16B；primary 省略＝新生 */
  salt?: string;
  /** 13 位毫秒字串；primary 省略＝新生 */
  epoch?: string;
  role: SyncRole;
  /** replica 必填（配對碼帶來） */
  primary_device_id?: string;
}

export interface PushReport {
  pushed_ops: number;
  object_key: string | null;
  /** 另一趟 push／pull 正在飛、這趟什麼都沒做（UI 說「另一趟進行中」，不是「沒東西」） */
  busy: boolean;
}

export interface PullReport {
  objects: number;
  applied_ops: number;
  skipped_ops: number;
  gated: boolean;
  /** 有被改到的表：nodes／work_logs／occurrences／settings（UI 據此決定重載什麼） */
  changed_tables: string[];
  /** 另一趟正在飛、這趟什麼都沒做 */
  busy: boolean;
  /** v1.1.2：這趟記了幾筆 conflict 事件（乘務記錄） */
  conflicts: number;
  /** v1.1.2：這趟收到的最大 hlc（餵 `seedHlc`；null＝沒收到東西） */
  max_hlc: string | null;
}

/** v1.1.2 `sync_begin_new_epoch`（primary）：renewed＝開了新紀元、快照已進 outbox；reenable＝還原的備份早於啟用同步，已清本機設定 */
export interface EpochReport {
  outcome: "renewed" | "reenable";
  epoch: string | null;
  snapshot_ops: number;
  message: string;
}

/** v1.1.2 `sync_adopt_epoch`（replica）：未推的 op 匯出到 `orphans_path`（0 筆＝null） */
export interface AdoptReport {
  orphan_ops: number;
  orphans_path: string | null;
  epoch: string;
}

/** v1.1.2 `sync_read_wizard_env`：精靈寫的四欄（只用來填表，不存、不 log） */
export interface WizardEnv {
  endpoint: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string;
}

/** 配對碼解 base64url 後的 JSON（契約 §6）；TS 只在 mock 用得到，真機由 Rust 解 */
export interface PairingPayload {
  v: 1;
  endpoint: string;
  bucket: string;
  ak: string;
  sk: string;
  salt: string;
  epoch: string;
  primary_device_id: string;
}

/** invoke 名稱（Rust `#[tauri::command]` 函式名）——store／UI 不得手抄字串 */
/** 與 Rust engine.rs 的 NEEDS_WIPE_MARK 同值：非空庫配對被擋、要主人確認 */
export const NEEDS_WIPE_MARK = "NEEDS_WIPE:";

export const SYNC_COMMANDS = {
  status: "sync_status",
  configure: "sync_configure",
  setEnabled: "sync_set_enabled",
  push: "sync_push",
  pull: "sync_pull",
  resetLocal: "sync_reset_local",
  makePairingCode: "sync_make_pairing_code",
  applyPairingCode: "sync_apply_pairing_code",
  // v1.1.2
  beginNewEpoch: "sync_begin_new_epoch",
  adoptEpoch: "sync_adopt_epoch",
  readWizardEnv: "sync_read_wizard_env",
} as const;

export interface SyncRepository {
  status(): Promise<SyncStatus>;
  configure(input: SyncConfigureInput): Promise<SyncStatus>;
  setEnabled(enabled: boolean): Promise<SyncStatus>;
  push(): Promise<PushReport>;
  pull(): Promise<PullReport>;
  resetLocal(): Promise<SyncStatus>;
  makePairingCode(): Promise<string>;
  /** wipe＝主人已確認非空庫改用桌機版本（Rust 回 NEEDS_WIPE: 前綴的錯時才帶 true） */
  applyPairingCode(code: string, passphrase: string, wipe?: boolean): Promise<SyncStatus>;
  /** v1.1.2 primary：還原後開新紀元（不 push；呼叫端接著 push） */
  beginNewEpoch(): Promise<EpochReport>;
  /** v1.1.2 replica：以桌機版本重置（不 pull；呼叫端接著 pull） */
  adoptEpoch(): Promise<AdoptReport>;
  /** v1.1.2 桌機：讀精靈的 r2.env 填表 */
  readWizardEnv(): Promise<WizardEnv>;
}

/* ═══════════════════════════════════════════════════════════════════════
   實作一：真機（每支一次 invoke；參數名＝Rust 端同名參數）
   ═══════════════════════════════════════════════════════════════════════ */

export class TauriSyncRepository implements SyncRepository {
  status(): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.status, {});
  }
  configure(input: SyncConfigureInput): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.configure, { input });
  }
  setEnabled(enabled: boolean): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.setEnabled, { enabled });
  }
  push(): Promise<PushReport> {
    return invoke<PushReport>(SYNC_COMMANDS.push, {});
  }
  async pull(): Promise<PullReport> {
    const report = await invoke<PullReport>(SYNC_COMMANDS.pull, {});
    // v1.1.2 契約 §5：拉回來的 hlc 已戳進 sync_cells，但 TS 這邊的記憶體計數看不到它——
    // 不餵種子的話，下一次本機寫入會產出比遠端還小的 hlc，LWW 用「嚴格大於」判勝 ⇒ 剛改的東西
    // 被對方的舊值壓過去。餵在 repository 層（而不是各個呼叫端）：只要走 pull 就一定餵到。
    seedHlc(report.max_hlc);
    return report;
  }
  resetLocal(): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.resetLocal, {});
  }
  makePairingCode(): Promise<string> {
    return invoke<string>(SYNC_COMMANDS.makePairingCode, {});
  }
  applyPairingCode(code: string, passphrase: string, wipe = false): Promise<SyncStatus> {
    return invoke<SyncStatus>(SYNC_COMMANDS.applyPairingCode, { code, passphrase, wipe });
  }
  beginNewEpoch(): Promise<EpochReport> {
    return invoke<EpochReport>(SYNC_COMMANDS.beginNewEpoch, {});
  }
  adoptEpoch(): Promise<AdoptReport> {
    return invoke<AdoptReport>(SYNC_COMMANDS.adoptEpoch, {});
  }
  readWizardEnv(): Promise<WizardEnv> {
    return invoke<WizardEnv>(SYNC_COMMANDS.readWizardEnv, {});
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   實作二：記憶體（`?mock=1`；WP8 靠這個跑 UI 與截圖——狀態機在記憶體裡走一遍，不碰網路）
   ═══════════════════════════════════════════════════════════════════════ */

const MOCK_DEVICE_ID = "3f9c2b1e-0000-4000-8000-000000000000";

/**
 * `?mock=1&sync=primary|replica|gated|stopped`（WP8 加在 mock 區塊）——示範狀態端點，只給評審／截圖用。
 * 不帶參數＝未啟用（`off`），也就是主人第一次打開「同步」分頁看到的樣子。
 *   primary → 桌機已啟用（運行中，有待上傳筆數）
 *   replica → 手機已配對（運行中）
 *   gated   → 信号待ち（對方版本較新）
 *   stopped → 停車中＋一句人話的錯誤
 *   paused  → 已設定、總開關關著（評審 S1 的新狀態；待上傳筆數會繼續長，那是正確回饋）
 *   epoch_changed → v1.1.2：手機偵測到桌機開了新紀元（改正待ち），拍「以桌機版本重置」的提示
 */
type SyncMockMode = "primary" | "replica" | "gated" | "stopped" | "paused" | "epoch_changed" | null;

const SYNC_MOCK_MODES = ["primary", "replica", "gated", "stopped", "paused", "epoch_changed"] as const;

function detectSyncMock(): SyncMockMode {
  if (typeof window === "undefined") return null;
  try {
    const v = new URLSearchParams(window.location.search).get("sync");
    return (SYNC_MOCK_MODES as readonly string[]).includes(v ?? "") ? (v as SyncMockMode) : null;
  } catch {
    return null;
  }
}

const OFF_STATE: SyncStatus = {
  enabled: false,
  role: null,
  device_id: MOCK_DEVICE_ID,
  epoch: null,
  configured: false,
  phase: "off",
  busy: false,
  last_sync_at: null,
  last_error: null,
  pending_ops: 0,
  schema: 4,
  remote_schema: null,
  restore_pending: false,
  pending_epoch: null,
  last_orphans: null,
};

/** 示範狀態（同一顆 SyncStatus 的幾個切片；真機的 phase 一律由 Rust 算） */
function seedState(mode: SyncMockMode): SyncStatus {
  if (!mode) return { ...OFF_STATE };
  const base: SyncStatus = {
    ...OFF_STATE,
    enabled: true,
    configured: true,
    role: mode === "replica" ? "replica" : "primary",
    epoch: "1758153600000",
    phase: "running",
    last_sync_at: new Date(Date.now() - 7 * 60_000).toISOString(),
    pending_ops: mode === "primary" ? 3 : 0,
  };
  if (mode === "gated") return { ...base, phase: "gated", remote_schema: 5 };
  if (mode === "epoch_changed") {
    return { ...base, role: "replica", phase: "epoch_changed", pending_epoch: "1758240000000", pending_ops: 2 };
  }
  if (mode === "paused") return { ...base, enabled: false, phase: "paused", pending_ops: 12 };
  if (mode === "stopped") {
    return { ...base, phase: "stopped", last_error: "連不上 R2（網路不通或憑證過期）", pending_ops: 8 };
  }
  return base;
}

export class MemorySyncRepository implements SyncRepository {
  private state: SyncStatus = seedState(detectSyncMock());

  async status(): Promise<SyncStatus> {
    return { ...this.state };
  }
  async configure(input: SyncConfigureInput): Promise<SyncStatus> {
    this.state = {
      ...this.state,
      enabled: true,
      role: input.role,
      epoch: input.epoch ?? String(Date.now()),
      configured: true,
      phase: "running",
      pending_ops: input.role === "primary" ? 12 : 0,
    };
    return this.status();
  }
  async setEnabled(enabled: boolean): Promise<SyncStatus> {
    // 關掉＝paused（設定還在），不是 off（從沒設定）——評審 S1
    this.state = { ...this.state, enabled, phase: enabled ? "running" : "paused" };
    return this.status();
  }
  async push(): Promise<PushReport> {
    const n = this.state.pending_ops;
    this.state = { ...this.state, pending_ops: 0, last_sync_at: new Date().toISOString() };
    return { pushed_ops: n, object_key: n ? `v1/${this.state.epoch}/${MOCK_DEVICE_ID}/mock.bin` : null, busy: false };
  }
  async pull(): Promise<PullReport> {
    this.state = { ...this.state, last_sync_at: new Date().toISOString() };
    const report: PullReport = { objects: 0, applied_ops: 0, skipped_ops: 0, gated: false, changed_tables: [], busy: false, conflicts: 0, max_hlc: null };
    seedHlc(report.max_hlc); // 與真機同一條路徑（mock 也不該有第二種行為）
    return report;
  }
  async resetLocal(): Promise<SyncStatus> {
    this.state = { ...this.state, enabled: false, role: null, epoch: null, configured: false, phase: "off", pending_ops: 0, last_error: null };
    return this.status();
  }
  async makePairingCode(): Promise<string> {
    const payload: PairingPayload = {
      v: 1, endpoint: "https://example.r2.cloudflarestorage.com", bucket: "mock", ak: "AK", sk: "SK",
      salt: "AAAAAAAAAAAAAAAAAAAAAA", epoch: this.state.epoch ?? "0", primary_device_id: MOCK_DEVICE_ID,
    };
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  }
  async applyPairingCode(code: string, _passphrase: string, _wipe = false): Promise<SyncStatus> {
    if (!code.trim()) throw new Error("配對碼是空的");
    return this.configure({ endpoint: "", bucket: "", access_key_id: "", secret_access_key: "", passphrase: "", role: "replica" });
  }
  // ── v1.1.2（mock：狀態機走一遍，不碰網路）──
  async beginNewEpoch(): Promise<EpochReport> {
    if (this.state.role !== "primary") throw new Error("只有正本（桌機）能開新紀元");
    const epoch = String(Date.now());
    this.state = { ...this.state, epoch, restore_pending: false, pending_ops: 12 };
    return { outcome: "renewed", epoch, snapshot_ops: 12, message: "還原完成——同步已重設為新紀元，正在重新上傳" };
  }
  async adoptEpoch(): Promise<AdoptReport> {
    const epoch = this.state.pending_epoch;
    if (!epoch) throw new Error("沒有待換的紀元");
    const orphans = this.state.pending_ops;
    const path = orphans ? "<app-data>/sync-orphans-mock.json" : null;
    this.state = {
      ...this.state,
      epoch,
      pending_epoch: null,
      phase: "running",
      pending_ops: 0,
      last_orphans: orphans && path ? { count: orphans, path, at: new Date().toISOString() } : null,
    };
    return { orphan_ops: orphans, orphans_path: path, epoch };
  }
  async readWizardEnv(): Promise<WizardEnv> {
    return { endpoint: "https://example.r2.cloudflarestorage.com", bucket: "mock-bucket", access_key_id: "AK-mock", secret_access_key: "SK-mock" };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   寫入層純函式（WP5 用）
   ═══════════════════════════════════════════════════════════════════════ */

/** 會進 oplog 的四張表（settings 只有白名單 key） */
export type SyncTable = "nodes" | "work_logs" | "occurrences" | "settings";

/** settings 白名單（D-1.1-3：只同步日界線；其餘 10 key 是裝置本地） */
export const SYNC_SETTINGS_KEYS: readonly string[] = ["day_start_hour"];

/**
 * 一筆待寫的 op（＝sync_outbox 一列）。cols 只放「主人資料」欄（契約 §7.4 白名單），
 * 快取（line_id／route_id 非根票）與推導（定期券的 scheduled_on、lazy today_position）**不放**。
 */
export interface OutboxOp {
  tbl: SyncTable;
  row_id: string;
  op: "upsert" | "delete";
  cols: Record<string, unknown>;
}

/** 一句 SQL＋它自己的 `$1..$k` 參數（局部編號；`runWriteBatch` 會重編成全域號） */
export interface WriteStmt {
  sql: string;
  args: unknown[];
}

/**
 * 一次公開 mutation 的累加器（WP5）：資料語句與 op 一路收集，最後 `runWriteBatch(db, b.stmts, b.ops)` 一次落。
 * 私有 helper（writeLog／stampOccurrence／dropOccurrence／…）收這個而不是自己 execute——
 * 「一次使用者手勢連動 3–4 張表」才有辦法落在同一個交易裡（寫入路徑盤點 §3(c)）。
 */
export interface WriteBatch {
  stmts: WriteStmt[];
  ops: OutboxOp[];
}

export function newWriteBatch(): WriteBatch {
  return { stmts: [], ops: [] };
}

/**
 * 寫入後通知（primary 端 syncStore 去抖 2 秒 push；Plan §6）。
 * `window.dispatchEvent(new CustomEvent(SYNC_WRITE_EVENT))`——資料層不知道 store 存在，只丟事件。
 */
export const SYNC_WRITE_EVENT = "ns:sync-write";

/* ── HLC ── */

let hlcLastMs = 0;
let hlcLastCount = 0;

/**
 * 產生 HLC 的**前 17 碼**（`<13位毫秒><4位hex計數>`）；device 尾碼由 SQL 端補
 * （`printf('%s-%s', $hlc, substr((SELECT value FROM sync_meta WHERE key='device_id'),1,8))`），
 * 這樣 TS 不必快取 device_id、啟用同步的瞬間就對。程序內單調：同毫秒計數 +1；跨程序靠物理時鐘。
 * 啟動後第一次寫入前，WP5 應以 `seedHlc(MAX(hlc) FROM sync_outbox)` 餵一次種子（沒有列＝不餵）。
 */
export function nextHlc(nowMs: number = Date.now()): string {
  if (nowMs > hlcLastMs) {
    hlcLastMs = nowMs;
    hlcLastCount = 0;
  } else {
    hlcLastCount += 1;
    if (hlcLastCount > 0xffff) {
      hlcLastMs += 1;
      hlcLastCount = 0;
    }
  }
  return `${String(hlcLastMs).padStart(13, "0")}${hlcLastCount.toString(16).padStart(4, "0")}`;
}

/** 以本機已知最大 hlc（完整 26 碼或前 17 碼皆可）餵種子，保證之後產生的都比它大 */
export function seedHlc(maxHlc: string | null | undefined): void {
  if (!maxHlc || maxHlc.length < 17) return;
  const ms = Number(maxHlc.slice(0, 13));
  const count = parseInt(maxHlc.slice(13, 17), 16);
  if (!Number.isFinite(ms) || !Number.isFinite(count)) return;
  if (ms > hlcLastMs || (ms === hlcLastMs && count > hlcLastCount)) {
    hlcLastMs = ms;
    hlcLastCount = count;
  }
}

/** 完整 hlc 字串（含 device 尾碼）的比較：字典序即時序 */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ── occurrences 確定性 id（uuid v5）── */

/** uuid v5 的 namespace（固定常數；兩台裝置對同一班算出同一個 id 的前提） */
export const OCCURRENCE_ID_NAMESPACE = "8d3a2b1e-6f4c-5a7b-9c8d-0e1f2a3b4c5d";

/**
 * `occurrences.id` ＝ uuid v5(namespace, `${nodeId}|${dueOn}`)。用 Web Crypto 的 SHA-1（Tauri WebView 是
 * secure context，`crypto.subtle` 可用；`?mock=1` 在 http://localhost 也可用）。
 */
export async function occurrenceId(nodeId: string, dueOn: string): Promise<string> {
  const ns = hexToBytes(OCCURRENCE_ID_NAMESPACE.replace(/-/g, ""));
  const name = new TextEncoder().encode(`${nodeId}|${dueOn}`);
  const buf = new Uint8Array(ns.length + name.length);
  buf.set(ns, 0);
  buf.set(name, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buf));
  const b = hash.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ── 一筆 op → outbox＋cells 兩句 ── */

/**
 * 只在「這台已經設定過同步」時才真的插列（SQL 端判斷；TS 不留狀態）。
 *
 * 為什麼看 `role` 而不是 `enabled`（評審 B1 改判）：舊版看總開關，於是主人把開關關一下、
 * 改了十張票、再打開——那十張票在手機上永遠是舊的（狀態列卻寫「運行中」），而且副本會收到
 * 「父列從未建立」的子列 op，FK 在 COMMIT 時爆掉、游標卡死，之後什麼都拉不到。
 * 改看 `role` 之後：關著＝只停網路，變更照記、開回來補送；`sync_reset_local` 清掉 meta（含 role）
 * 之後閘門自然關上，從沒設定過同步的桌機一列都不會多寫（鐵則「桌機既有行為零改變」照舊成立）。
 */
const CONFIGURED_GATE = `EXISTS (SELECT 1 FROM sync_meta WHERE key = 'role' AND value IN ('primary','replica'))`;
const DEVICE_SUFFIX = `substr((SELECT value FROM sync_meta WHERE key = 'device_id'), 1, 8)`;

/**
 * 把一筆 op 展成兩句（局部編號 `$1..`）：
 *   ① `INSERT INTO sync_outbox(hlc, tbl, row_id, op, payload) SELECT … WHERE <gate>`
 *   ② `INSERT INTO sync_cells(tbl, row_id, col, hlc, device_id) SELECT … FROM (VALUES …) WHERE <gate>
 *       ON CONFLICT(tbl,row_id,col) DO UPDATE SET hlc=excluded.hlc, device_id=excluded.device_id WHERE excluded.hlc > sync_cells.hlc`
 * `hlc17`＝`nextHlc()` 的結果（同一批次裡多筆 op 可共用同一個 hlc17——同一次手勢＝同一時刻）。
 */
export function syncSideStatements(op: OutboxOp, hlc17: string): WriteStmt[] {
  const hlcExpr = (n: number) => `printf('%s-%s', $${n}, ${DEVICE_SUFFIX})`;
  const outbox: WriteStmt = {
    sql:
      `INSERT INTO sync_outbox (hlc, tbl, row_id, op, payload) ` +
      `SELECT ${hlcExpr(1)}, $2, $3, $4, $5 WHERE ${CONFIGURED_GATE}`,
    args: [hlc17, op.tbl, op.row_id, op.op, JSON.stringify(op.cols)],
  };
  const cols = Object.keys(op.cols);
  if (!cols.length) return [outbox];
  // VALUES 每列：(tbl, row_id, col, hlc17)；device 尾碼由 SELECT 端一次補
  const rows = cols.map((_, i) => `($1, $2, $${i + 4}, $3)`).join(",");
  const cells: WriteStmt = {
    sql:
      `INSERT INTO sync_cells (tbl, row_id, col, hlc, device_id) ` +
      `SELECT column1, column2, column3, printf('%s-%s', column4, ${DEVICE_SUFFIX}), (SELECT value FROM sync_meta WHERE key = 'device_id') ` +
      `FROM (VALUES ${rows}) WHERE ${CONFIGURED_GATE} ` +
      `ON CONFLICT(tbl, row_id, col) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id WHERE excluded.hlc > sync_cells.hlc`,
    args: [op.tbl, op.row_id, hlc17, ...cols],
  };
  return [outbox, cells];
}

/* ── 同步表的存在檢查＋HLC 種子（每個 session 一次）── */

/** 三張同步表的名字（0004 建；缺任一張＝這顆 DB 還沒升到 schema 4） */
const SYNC_TABLES = ["sync_meta", "sync_outbox", "sync_cells"] as const;

let syncTablesReady: Promise<boolean> | null = null;

/**
 * 第一次寫入前做兩件事，之後整個 session 快取結果：
 *   ① 確認 0004 的三張表都在。**缺表就一律不產同步語句**——否則整批（含資料語句）會一起失敗，
 *      等於「同步沒開卻把既有功能弄壞」。理論上 plugin-sql 載入時一定跑過 migration，
 *      但備份還原／手動換 DB 檔這類路徑不在我們手上，這一道是保命閥（任務書「或表不存在」）。
 *   ② `seedHlc(MAX(hlc))`（outbox 與 cells 各取一次最大值）——重開 App 後產生的 hlc 仍比上次大，
 *      即使系統時鐘被往回調（契約 §2.3）。
 */
async function probeSyncTables(db: Database): Promise<boolean> {
  try {
    const found = await db.select<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ($1, $2, $3)`,
      [...SYNC_TABLES],
    );
    if ((found[0]?.n ?? 0) < SYNC_TABLES.length) return false;
    const max = await db.select<{ m: string | null }[]>(
      `SELECT MAX(h) AS m FROM (SELECT MAX(hlc) AS h FROM sync_outbox UNION ALL SELECT MAX(hlc) AS h FROM sync_cells)`,
    );
    seedHlc(max[0]?.m);
    return true;
  } catch {
    // 讀 sqlite_master 都失敗＝DB 本身有問題，讓資料語句自己去撞真正的錯誤，同步語句不添亂
    return false;
  }
}

/** 同步表在不在（快取；第一次呼叫順便餵 HLC 種子） */
export function ensureSyncTables(db: Database): Promise<boolean> {
  if (!syncTablesReady) syncTablesReady = probeSyncTables(db);
  return syncTablesReady;
}

/** 測試／probe 用：忘掉快取，下次寫入重新探一次 */
export function resetSyncTablesProbe(): void {
  syncTablesReady = null;
}

/* ── sync_meta／sync_outbox 的 TS 端讀寫（診斷與 probe 用）── */
/* 正式的 push 由 Rust 直接讀這兩張表（契約 §7.4）；這裡這幾支是給 scripts/probes 與未來
   UI 診斷用的同形介面，語義與 Rust 端逐點對齊，不是第二條生產路徑。 */

/** 讀一個 sync_meta 值；沒有列＝null */
export async function readSyncMeta(db: Database, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }[]>(`SELECT value FROM sync_meta WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

/** 寫一個 sync_meta 值（upsert） */
export async function writeSyncMeta(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    `INSERT INTO sync_meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** 同步總開關（`enabled='1'` 才算開；無列＝關） */
export async function isSyncEnabled(db: Database): Promise<boolean> {
  return (await readSyncMeta(db, "enabled")) === "1";
}

/** sync_outbox 一列（payload 仍是 JSON 字串，與 Rust 端同形） */
export interface OutboxRow {
  seq: number;
  hlc: string;
  tbl: string;
  row_id: string;
  op: "upsert" | "delete";
  payload: string;
  created_at: string;
}

/** 取一批待上傳 op（seq 遞增＝hlc 遞增；LIMIT 與 Rust push 同為 2000） */
export function takeOutbox(db: Database, limit = 2000): Promise<OutboxRow[]> {
  return db.select<OutboxRow[]>(
    `SELECT seq, hlc, tbl, row_id, op, payload, created_at FROM sync_outbox ORDER BY seq ASC LIMIT $1`,
    [limit],
  );
}

/** push 成功後清掉已上傳的部分（含 maxSeq） */
export async function clearOutboxThrough(db: Database, maxSeq: number): Promise<void> {
  await db.execute(`DELETE FROM sync_outbox WHERE seq <= $1`, [maxSeq]);
}

/** 待上傳筆數（UI 的 pending_ops 同義） */
export async function countOutbox(db: Database): Promise<number> {
  const rows = await db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM sync_outbox`);
  return rows[0]?.n ?? 0;
}

/* ── 一次 execute 的交易批次 ── */

/** 把一句的 `$k` 全部加上 offset（`$1`→`$(1+offset)`）；只動 `$數字`，不碰字串字面值（本專案 SQL 沒有 `$` 字面值） */
export function renumber(sql: string, offset: number): string {
  return offset === 0 ? sql : sql.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`);
}

/** 組成單一 query 字串：`BEGIN IMMEDIATE; s1; s2; …; COMMIT;`＋合併後的 args（供測試與 runWriteBatch 共用） */
export function composeBatch(stmts: WriteStmt[]): WriteStmt {
  const parts: string[] = ["BEGIN IMMEDIATE"];
  const args: unknown[] = [];
  for (const s of stmts) {
    parts.push(renumber(s.sql, args.length));
    args.push(...s.args);
  }
  parts.push("COMMIT");
  return { sql: parts.join(";\n") + ";", args };
}

/**
 * 資料語句＋（每筆 op 的）同步語句，一次 execute、同一交易。
 * 失敗：先 `recoverOpenTransaction(db)`，再把原錯誤丟回去（呼叫端的錯誤處理與現在一樣）。
 * 成功：丟 `SYNC_WRITE_EVENT`（有 op 才丟；純快取寫入不吵 syncStore）。
 */
export async function runWriteBatch(db: Database, stmts: WriteStmt[], ops: OutboxOp[]): Promise<void> {
  if (!stmts.length && !ops.length) return;
  // 缺表（舊 DB／還原中途）＝當作沒有 op；有表才產同步語句，總開關由 SQL 端的 WHERE EXISTS 再判一次
  const withSync = ops.length ? await ensureSyncTables(db) : false;
  if (!stmts.length && !withSync) return;
  const hlc17 = withSync ? nextHlc() : "";
  const all = [...stmts];
  if (withSync) for (const op of ops) all.push(...syncSideStatements(op, hlc17));
  const batch = composeBatch(all);
  try {
    await db.execute(batch.sql, batch.args);
  } catch (e) {
    await recoverOpenTransaction(db);
    throw e;
  }
  if (withSync && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SYNC_WRITE_EVENT));
  }
}

/**
 * 批次中途失敗後，那條連線會留著未收的交易（sqlx 歸還 pool 時不會替我們 ROLLBACK；已讀 `pool/connection.rs`）。
 * 連續 ROLLBACK 最多 10 次（pool 上限 10 條、idle 佇列 FIFO ⇒ 逐次輪到每一條）；成功一次＝找到了，停。
 * 其餘的 ROLLBACK 會回「cannot rollback - no transaction is active」，吞掉。
 */
export async function recoverOpenTransaction(db: Database): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      await db.execute("ROLLBACK");
      return;
    } catch {
      /* 這條連線沒有開著的交易，換下一條 */
    }
  }
}

/* ── 小工 ── */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
