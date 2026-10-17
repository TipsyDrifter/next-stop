//! 售票口線的 Rust 端（車次①契約 §3.6）。只有一支 command：唯讀讀出財務管家備份 → `MmbakReadResult`。
//! 比對、合併計畫、寫入全部在 TS（`src/domain/ticket.ts` 的 planImport＋repository 的 WriteBatch），這裡不碰主 DB。
pub mod mmbak;

use tauri::Manager;

/// 讀財務管家備份（`.mmbak`＝裸 SQLite）。兩殼同一條路：FsExt 讀 bytes → 驗檔頭 → 暫存 → 唯讀開 → 讀 → 刪暫存。
/// schema 不符 ⇒ Ok({ missing: [...], dump: None })；讀不到／不是 SQLite／開不起來 ⇒ Err(人話)。
/// JS 參數：`{ path }`（桌機一般路徑；Android SAF 的 content:// URI）
#[tauri::command]
pub async fn ticket_import_read(app: tauri::AppHandle, path: String) -> Result<mmbak::MmbakReadResult, String> {
    // 預覽卡的檔名：Android content URI 的最後一段是文件編號，真檔名由 tauri 的 path().file_name 問 ContentResolver
    let name = mmbak::pick_display_name(app.path().file_name(&path), &path);
    let tmp = mmbak::copy_to_cache(&app, &path)?;
    let out = mmbak::read_dump(&tmp, &name).await;
    let _ = std::fs::remove_file(&tmp); // 成功失敗都刪
    out
}
