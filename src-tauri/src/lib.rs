// v1.1.0 D-1.1-1 甲：Android 不做備份。backup.rs 用 sqlx 直連＋`VACUUM INTO`＋app_config_dir，
// 這些在 Android 上要嘛沒意義（沒有「另一顆磁碟」的第二備份位置）、要嘛靠 dialog 選資料夾（Android 不支援）。
// 整支 mod 在 mobile target 直接不編——少一組依賴、少一組會 reject 的 invoke。
// `mobile` cfg 由 tauri-build 在 Android／iOS target 自動設定（與下面 `#[cfg_attr(mobile, …)]` 同一個旗標）。
#[cfg(not(mobile))]
mod backup;

// v1.1.1 同步地基（契約席 2026-09-18 立骨架、WP7 2026-09-18 填實作）：兩端都編（手機是 replica、桌機是 primary）。
// plugin 只 manage 一顆狀態（不碰 DB），八支 command 兩端都註冊——單向是 engine 內部的判斷，
// 不是「手機沒有 push 這支」；v1.1.2 開雙向時 TS 一行都不必改。
mod sync;

// 並行地基 甲1（契約 2026-09-29 §4）：migration 清單的唯一來源（含 `lf()` 與守門測試）。
// pub：清單與 `version_of` 是給 sync（`SCHEMA_VERSION`、同步表 spec 的 `since`）與 probe 讀的介面。
pub mod migrations;

// G0 金樣（`sync/foundation_golden.rs`，凍結）以 `crate::lf` 呼叫——`lf()` 搬家後在原位置留一個別名。
#[cfg(test)]
use migrations::lf;

/// 私鐵手帳 · Next Stop — Tauri 入口
/// DB：sqlite:next-stop-v2.db（v2 彈性樹 schema；v0.1 的 next-stop.db 原地保留不讀）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // sqlx Migrator：只跑 _sqlx_migrations 裡沒有的版本，已跑過的只驗 checksum
    // → 既有版本的 SQL 一個字都不能改（改了舊 DB 會啟動失敗），新東西一律新開一支。
    // 清單本體在 `migrations.rs`（唯一來源；新增＝尾端加一行）。
    let migrations = migrations::plugin_migrations();

    // 為什麼拆成 let 重綁而不是一路 `.plugin(...)` 串下去：`#[cfg]` 是「項目／陳述式」層級的屬性，
    // 貼不到鏈式呼叫的中間那一段（`.plugin(x)` 不是一個項目）。重綁同名 `builder` 是 Rust 裡
    // 做條件式 builder 的標準寫法，桌機編出來的鏈與 v1.0 逐字相同——桌機行為零改變。
    let builder = tauri::Builder::default();

    // M3 ⑥：備份 plugin 必須排在 sql plugin **之前**——PluginStore 是 Vec、依註冊順序
    // initialize_all，所以只有排在前面才能在 migration 跑之前拍到前一版 schema 的快照。
    #[cfg(not(mobile))]
    let builder = builder.plugin(backup::init());

    let builder = builder.plugin(
        tauri_plugin_sql::Builder::default()
            .add_migrations("sqlite:next-stop-v2.db", migrations)
            .build(),
    );

    // v1.1.1：同步 plugin。排在 sql **之後**——它的 setup 只 app.manage() 一顆狀態，
    // 但 engine 取 pool 走的是 sql plugin 的 `DbInstances`，順序排後面語意才對（實際不依賴初始化順序）。
    let builder = builder.plugin(sync::init());

    // v1.1.4（契約 §6；WP-B）：檔案系統 plugin，**兩殼都掛**。
    // 唯一的用途是 Rust 端的 `FsExt::open`——手機「匯出到手機」拿到 SAF 的 `content://` URI 之後，
    // 只有這個 plugin 的 Android 實作能把它換成一個可寫的 fd（`std::fs` 打不開 content URI）。
    // JS 那十幾支 fs command 沒有給權限（capabilities 不含 `fs:*`），所以前端還是碰不到檔案系統。
    let builder = builder.plugin(tauri_plugin_fs::init());

    // v1.1.4：dialog plugin 從「只有桌機」改成**兩殼都掛**——手機要用它的 `save()`（Android 走 SAF 的
    // CreateDocument，主人自己挑「下載」之類看得到的位置）。查證：`download_dir()` 在 Android 回的是
    // app 專屬目錄，主人在檔案管理員看不到（docs/research/2026-09-22-v1.1.4-Android下載目錄寫入查證.md）。
    // 桌機這一行原本在下面的 `#[cfg(not(mobile))]` 區塊裡，搬上來兩殼共用；桌機的用法（選資料夾、選 .db）不變。
    let builder = builder.plugin(tauri_plugin_dialog::init());

    // v1.1.5（契約 §3；WP-B）：OS 通知，**兩殼都掛**。capabilities/default.json 只給 notify／is-permission-granted／
    // request-permission 三條、mobile.json 另加 create-channel（外掛 init 腳本覆寫 `window.Notification` 時會叫前兩支，
    // 所以一定要給）。只有 JS 端 `src/lib/notify.ts` 用它，Rust 端不叫；橫幅才是主力，通知失敗靜默。
    // 桌機零改變：沒加入同步就不會有告警，`notify.ts` 的外掛 import 是動態的、永不載入（init 腳本照常注入，無副作用）。
    let builder = builder.plugin(tauri_plugin_notification::init());

    #[cfg(not(mobile))]
    let builder = builder
        // 順序實證＋回歸護欄：這支空 plugin 排在 sql 之後，setup 時 `DbInstances` 必已就緒；
        // 與 backup::init() 那一行 log 對照，就能證明 plugin 是照註冊順序初始化的（不憑「應該是這樣」）。
        .plugin(backup::order_probe())
        // （v1.1.4 起 `tauri_plugin_dialog::init()` 搬到上面兩殼共用：桌機用它選資料夾／選 .db，
        //   手機用它的 `save()` 走 SAF 匯出。桌機這邊的行為一個字都沒變。）
        // `generate_handler!` 吃不下 `#[cfg]`（它要在編譯期把整份清單展開成一個 match），
        // 所以桌機／手機只能整句各寫一份；`invoke_handler` 又只能叫一次、後叫的會蓋掉先叫的。
        .invoke_handler(tauri::generate_handler![
            backup::backup_startup_report,
            backup::backup_now,
            backup::backup_apply_policy,
            backup::backup_list,
            backup::backup_validate_file,
            backup::backup_restore,
            backup::reset_database_keep_settings,
            // v1.1.3 契約 §4.1：configure／apply_pairing_code／begin_new_epoch 退場，
            // 換成 join／decode_pairing_code／finish_restore，另加 change_passphrase／restore_choice。
            sync::commands::sync_status,
            sync::commands::sync_join,
            sync::commands::sync_rejoin,
            sync::commands::sync_change_passphrase,
            sync::commands::sync_restore_choice,
            sync::commands::sync_finish_restore,
            sync::commands::sync_set_enabled,
            sync::commands::sync_push,
            sync::commands::sync_pull,
            sync::commands::sync_reset_local,
            sync::commands::sync_make_pairing_code,
            sync::commands::sync_decode_pairing_code,
            sync::commands::sync_adopt_epoch,
            sync::commands::sync_read_wizard_env,
            // v1.1.4 契約 §4：雲端備份四支＋SAF 匯出＋換鑰匙續跑（兩殼都掛）
            sync::commands::sync_cloud_snapshot_now,
            sync::commands::sync_cloud_snapshot_auto,
            sync::commands::sync_cloud_snapshot_list,
            sync::commands::sync_cloud_restore,
            sync::commands::sync_export_to_file,
            sync::commands::sync_finish_rotation,
            // v1.1.5 契約 §5：復原碼兩支（WP-A 填 recovery.rs；殼與註冊由契約席先立好）
            sync::commands::sync_recovery_generate,
            sync::commands::sync_recovery_clear,
            // v1.1.6 重新開始契約 §3.1：危險區「重新開始」（桌機沒加入也要能「只清這台」）
            sync::commands::sync_start_over,
            // ── 旅客筆記線插槽（只有旅客筆記線在這一行下面加；桌機與手機兩份都要加）──
            // ── 時刻表線插槽 ──
            // ── 售票口線插槽 ──
        ]);

    // 手機沒有 backup 那七支（D-1.1-1 甲），只掛同步二十三支（清單與桌機那份逐字相同）。
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        sync::commands::sync_status,
        sync::commands::sync_join,
        sync::commands::sync_rejoin,
        sync::commands::sync_change_passphrase,
        sync::commands::sync_restore_choice,
        sync::commands::sync_finish_restore,
        sync::commands::sync_set_enabled,
        sync::commands::sync_push,
        sync::commands::sync_pull,
        sync::commands::sync_reset_local,
        sync::commands::sync_make_pairing_code,
        sync::commands::sync_decode_pairing_code,
        sync::commands::sync_adopt_epoch,
        sync::commands::sync_read_wizard_env,
        sync::commands::sync_cloud_snapshot_now,
        sync::commands::sync_cloud_snapshot_auto,
        sync::commands::sync_cloud_snapshot_list,
        sync::commands::sync_cloud_restore,
        sync::commands::sync_export_to_file,
        sync::commands::sync_finish_rotation,
        sync::commands::sync_recovery_generate,
        sync::commands::sync_recovery_clear,
        sync::commands::sync_start_over,
        // ── 旅客筆記線插槽（只有旅客筆記線在這一行下面加；桌機與手機兩份都要加）──
        // ── 時刻表線插槽 ──
        // ── 售票口線插槽 ──
    ]);

    // v1.1.2 D-1.1-6 甲：手機掃桌機的 QR（配對碼）。plugin 只在手機 target 有（Cargo 的 target 段），
    // 桌機沒相機也不掃碼。權限在 capabilities/mobile.json（barcode-scanner:allow-*），CAMERA 在 gen/android 的 Manifest。
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    // opener 兩端都留（v1.1.1 同步分頁可能要開外部連結）；capabilities 兩邊都給 `opener:default`。
    let builder = builder.plugin(tauri_plugin_opener::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
