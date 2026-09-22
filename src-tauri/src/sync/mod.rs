//! 同步地基——Rust 端（v1.1.1 單向桌機→手機；**v1.1.2 起雙向＋衝突＋還原紀元**）。
//!
//! 拍板：`docs/決策記錄.md`〈v1.1 開工訪談拍板〉P2（E2EE）／P4（拉取節奏）／P6 改判（R2）＋
//!       〈v1.1 Plan 草案拍板〉D-1.1-3～D-1.1-6；設計＝
//!       `docs/research/2026-09-18-v1.1.1-同步地基契約.md`（§4 物件格式、§5 command、§7 套用規則）；
//!       v1.1.2 ＝ `docs/research/2026-09-19-v1.1.2-雙向同步契約.md`（§2 雙向協定、§3 衝突、§4 還原紀元、§7 精靈匯入）。
//!
//! 模組分工（一支一件事，方便 v1.1.2 只換 engine 不動其餘）：
//!   * `hlc`       ─ HLC 字串的產生／驗證／比較（與 TS `src/data/syncRepository.ts` 同一格式）
//!   * `crypto`    ─ argon2id 派生金鑰、XChaCha20-Poly1305 封裝／拆封（AAD＝物件 key）、zstd；
//!                   v1.1.3 另含**兩層鑰匙**（`random_data_key`／`wrap_data_key`／`unwrap_data_key`）
//!   * `credstore` ─ 憑證＋**資料鑰匙**＋血統鹽＋**身分**的存放：桌機 keyring（Windows Credential Manager）／
//!                   Android app 私有檔。沒鑰匙圈＝新的一台（v1.1.3 §3.1）
//!   * `r2`        ─ Cloudflare R2（S3 API）的 put／get／list-after／delete，`object_store` 後端
//!   * `engine`    ─ 補戳格子→快照→outbox、outbox→物件→push、list→拆封→apply（逐欄 LWW＋衝突留痕）→重算快取；
//!                   v1.1.3 另含單一入口 `join`、改密語 `change_passphrase`、還原二選一 `finish_restore`、
//!                   換紀元 `adopt_epoch` 與精靈匯入（`read_wizard_env`）
//!   * `commands`  ─ 十三支 `#[tauri::command]`（invoke 名稱與 JSON 形狀是契約，TS 照著編譯）
//!
//! 掛載（在 `lib.rs`）：`.plugin(sync::init())`（排在 sql plugin 之後）＋兩份 `generate_handler!`
//!   （桌機那份＝backup 七支＋sync 十三支，手機那份＝sync 十三支——`generate_handler!` 不吃 `#[cfg]`，
//!   只能整句用 `#[cfg]` 分兩份；`invoke_handler` 又只能叫一次）。
//!   command 是**應用層**的（跟 backup 一樣註冊在 app 的 invoke_handler，不是 plugin 的），
//!   所以 `capabilities/*.json` 一個字都不必動。
//!
//! 鐵則：憑證絕不印進 log（`Debug` 一律自訂或不 derive）；絕不碰主人正本（驗證走沙盒 identifier
//!   ＋沙盒**桶內根** `v1-sb-<run>/`，與正本的 `v1/` 平級、互相 list 不到）。
#![allow(dead_code)]

pub mod commands;
pub mod credstore;
pub mod crypto;
pub mod engine;
pub mod hlc;
pub mod r2;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Wry,
};

/// 本機引擎支援的 schema 版本＝migration 版本數（0001–0004）。oplog 物件的 `schema` 與此不等＝信号待ち。
pub const SCHEMA_VERSION: u32 = 4;

/// 前端 `src/lib/db.ts` 用的連線字串＝`DbInstances` map 的鍵（與 backup.rs 同值；不共用是為了 mobile 不編 backup）
pub const DB_URL: &str = "sqlite:next-stop-v2.db";

/// 同步 plugin：setup 只 manage 一顆 `engine::SyncState`（不碰 DB——前端 `Database.load()` 之後 pool 才存在）。
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("sync")
        .setup(|app, _api| {
            use tauri::Manager;
            app.manage(engine::SyncState::default());
            Ok(())
        })
        .build()
}
