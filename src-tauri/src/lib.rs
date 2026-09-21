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

use tauri_plugin_sql::{Migration, MigrationKind};

/// 私鐵手帳 · Next Stop — Tauri 入口
/// DB：sqlite:next-stop-v2.db（v2 彈性樹 schema；v0.1 的 next-stop.db 原地保留不讀）
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // sqlx Migrator：只跑 _sqlx_migrations 裡沒有的版本，已跑過的只驗 checksum
    // → 既有版本的 SQL 一個字都不能改（改了舊 DB 會啟動失敗），新東西一律新開一支。
    let migrations = vec![
        Migration {
            version: 1,
            description: "v2 baseline: flexible rail tree (nodes) + work_logs + settings",
            sql: include_str!("../migrations/0001_baseline.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "today view: nodes.today_position/carried_from + work_logs.event (backfill issued)",
            sql: include_str!("../migrations/0002_today.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "repeat engine: occurrences table + legacy free-text repeat_rule migration",
            sql: include_str!("../migrations/0003_repeat.sql"),
            kind: MigrationKind::Up,
        },
        // v1.1.1：純 DDL 三張表（sync_meta／sync_outbox／sync_cells），不生資料列（U8）。
        // 同步總開關沒開之前三張表全空、既有路徑零改變；backup plugin 排在 sql 之前，升級前照樣先有快照。
        Migration {
            version: 4,
            description: "sync foundation: sync_meta + sync_outbox + sync_cells (no data rows)",
            sql: include_str!("../migrations/0004_sync.sql"),
            kind: MigrationKind::Up,
        },
    ];

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

    #[cfg(not(mobile))]
    let builder = builder
        // 順序實證＋回歸護欄：這支空 plugin 排在 sql 之後，setup 時 `DbInstances` 必已就緒；
        // 與 backup::init() 那一行 log 對照，就能證明 plugin 是照註冊順序初始化的（不憑「應該是這樣」）。
        .plugin(backup::order_probe())
        // dialog 只有備份在用（第二位置選資料夾／「從檔案還原…」選 .db）；Android 沒有 folder picker，
        // v1.1.0 手機零使用 → 不掛。配套：capabilities/default.json 要限 platforms 到桌機三家，
        // 否則 Android build 會因 `dialog:allow-open` 指到未註冊的 plugin 而報錯。
        .plugin(tauri_plugin_dialog::init())
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
            sync::commands::sync_status,
            sync::commands::sync_configure,
            sync::commands::sync_set_enabled,
            sync::commands::sync_push,
            sync::commands::sync_pull,
            sync::commands::sync_reset_local,
            sync::commands::sync_make_pairing_code,
            sync::commands::sync_apply_pairing_code,
            sync::commands::sync_begin_new_epoch,
            sync::commands::sync_adopt_epoch,
            sync::commands::sync_read_wizard_env,
        ]);

    // 手機沒有 backup 那七支（D-1.1-1 甲），只掛同步八支＋v1.1.2 三支。
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        sync::commands::sync_status,
        sync::commands::sync_configure,
        sync::commands::sync_set_enabled,
        sync::commands::sync_push,
        sync::commands::sync_pull,
        sync::commands::sync_reset_local,
        sync::commands::sync_make_pairing_code,
        sync::commands::sync_apply_pairing_code,
        sync::commands::sync_begin_new_epoch,
        sync::commands::sync_adopt_epoch,
        sync::commands::sync_read_wizard_env,
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
