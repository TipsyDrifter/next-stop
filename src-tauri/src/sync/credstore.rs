//! 憑證存放——R2 token 與派生金鑰，**一個介面、兩種後端**（契約 §5.3）。
//!
//! 為什麼兩種：桌機有 OS 憑證庫（Windows Credential Manager／macOS Keychain），`keyring` crate 直接用；
//!   Android 沒有 `keyring` 後端，改存 app 私有目錄（`app_data_dir()/sync/credstore.json`，其他 app 讀不到、
//!   解除安裝即消失；Android Keystore 包一層留 v1.1.x）。兩邊對 engine 都是同一組 load／save／clear。
//!
//! 桌機：`keyring::Entry::new("app.shitetsu.nextstop", "sync")`，value＝`SyncCredentials` 的 JSON 字串
//!   （Windows blob 上限 2560B，本 JSON 約 400B）。
//!   Cargo（WP7）：`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
//!   keyring = { version = "3", features = ["windows-native", "apple-native"] }`。
//! Android：`serde_json` 寫檔，`std::os::unix::fs::PermissionsExt` 設 0o600。
//!
//! 鐵則：本檔任何型別**不 derive Debug**（避免 `{:?}` 把 secret 印進 log）；錯誤訊息不夾帶欄位值。
//!
//! **v1.1.3（契約 §3.1，契約席 2026-09-21）**：鑰匙圈多存三樣——`root`（桶內根前綴）、`salt_b64`（血統識別）、
//!   `device_id`（**身分從 sync_meta 搬到這裡**：複製資料夾＝沒鑰匙圈＝新的一台；還原不換身分）。
//!   `key_b64` 改名 `data_key_b64`（兩層鑰匙：它是「資料鑰匙」，密語只負責把它包成桶裡的 `KEY`）。
//!   舊 JSON 以 serde alias／default 照讀，主人升級不重配（契約 §7 ①②）。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// 桶內根前綴的預設值（契約 §2）；沙盒用 `v1-sb-<run>`
pub const DEFAULT_ROOT: &str = "v1";

fn default_root() -> String {
    DEFAULT_ROOT.to_string()
}

/// keyring 的 service 名的預設值（＝正本 app identifier）。
///
/// 實際使用的是 `app.config().identifier`（見 `service_of`）——沙盒 exe 用不同 identifier 起，
/// 憑證才真的隔離（契約 §0 鐵則 2）。這個常數只是拿不到 identifier 時的退路。
pub const SERVICE: &str = "app.shitetsu.nextstop";
/// keyring 的 user／檔名
pub const ENTRY: &str = "sync";

/// 存在憑證庫裡的一整包（R2 四樣＋資料鑰匙＋血統鹽＋身分）。**不 derive Debug**。
#[derive(Clone, Serialize, Deserialize)]
pub struct SyncCredentials {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// 桶內根前綴（契約 §2）；v1.1.2 的鑰匙圈沒有這欄 ⇒ `v1`
    #[serde(default = "default_root")]
    pub root: String,
    /// **資料鑰匙** 32B，base64url（無 padding）。v1.1.2 存的是 argon2id 派生金鑰（欄名 `key_b64`）——
    /// 它加密了雲端所有既有物件，所以升級後它就是舊血統的資料鑰匙（契約 §7 ①），只是換個名字。
    ///
    /// 工程評審 S-6：**JSON 欄名寫回 `key_b64`**，遷移才不是單行道。舊碼序列化出去的是 `data_key_b64`，
    /// 於是「裝過 1.1.3 再退回 1.1.2」時 1.1.2 讀不回鑰匙圈＝同步整個停掉（主人桌機 09-21 就這樣半殘了一天）。
    /// 欄名對主人不可見，兩版都讀得到才是對的。`alias` 要**留著**：主人桌機那份已經被寫成 `data_key_b64` 了。
    #[serde(rename = "key_b64", alias = "data_key_b64")]
    pub data_key_b64: String,
    /// `<root>/SALT` 的值（血統識別；舊血統也是資料鑰匙的鹽）。缺＝`status()` 從 `sync_meta.salt` 搬。
    #[serde(default)]
    pub salt_b64: Option<String>,
    /// 這台的身分（uuid v4）。缺＝`status()` 從 `sync_meta.device_id` 搬；搬完存回鑰匙圈。
    #[serde(default)]
    pub device_id: Option<String>,
}

/// 這台實際使用的 keyring service 名＝app identifier（沙盒 exe 天然隔離）
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn service_of(app: &AppHandle) -> String {
    let id = app.config().identifier.trim().to_string();
    if id.is_empty() {
        SERVICE.to_string()
    } else {
        id
    }
}

// ─────────────────────────────────────────────────────────────
// 桌機：OS 憑證庫（Windows Credential Manager／macOS Keychain）
// ─────────────────────────────────────────────────────────────
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod backend {
    use super::*;

    fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&service_of(app), ENTRY)
            .map_err(|_| "打不開系統憑證庫（Windows 認證管理員）。".to_string())
    }

    pub fn load(app: &AppHandle) -> Result<Option<SyncCredentials>, String> {
        match entry(app)?.get_password() {
            // 主人真機 2026-09-22：舊那顆 exe 報「損壞」卻查不出為什麼——serde 的錯誤只講欄位名與型別、
            // 不含值，帶出來才好診斷（不會洩漏憑證）。
            Ok(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|e| format!("系統憑證庫裡的同步設定讀不懂（{e}），請在設定裡「重設」後重新啟用。")),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("讀取系統憑證庫失敗。".into()),
        }
    }

    pub fn save(app: &AppHandle, creds: &SyncCredentials) -> Result<(), String> {
        let json = serde_json::to_string(creds).map_err(|_| "同步設定序列化失敗。".to_string())?;
        entry(app)?
            .set_password(&json)
            .map_err(|_| "寫入系統憑證庫失敗。".to_string())
    }

    pub fn clear(app: &AppHandle) -> Result<(), String> {
        match entry(app)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("清除系統憑證庫失敗。".into()),
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Android：app 私有目錄的一個 0o600 檔（沒有 keyring 後端）
// ─────────────────────────────────────────────────────────────
#[cfg(any(target_os = "android", target_os = "ios"))]
mod backend {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use tauri::Manager;

    fn path_of(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "找不到 app 私有目錄。".to_string())?
            .join("sync");
        fs::create_dir_all(&dir).map_err(|_| "建立同步設定目錄失敗。".to_string())?;
        Ok(dir.join("credstore.json"))
    }

    pub fn load(app: &AppHandle) -> Result<Option<SyncCredentials>, String> {
        let p = path_of(app)?;
        if !p.exists() {
            return Ok(None);
        }
        let json = fs::read_to_string(&p).map_err(|_| "讀取同步設定失敗。".to_string())?;
        serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| format!("同步設定讀不懂（{e}），請在「同步」裡重設後重新加入。"))
    }

    /// 工程評審 S-11：**先寫 `.tmp` 再 rename**（同 `backup.rs` 換檔的手法）。
    /// 直接 `fs::write` 中途斷電＝半個檔，下次 `load` 回「損壞，請重設」——主人得重設重加，
    /// 而「重加」＝新身分＝雲端多一個裝置目錄、整包資料再推一次。rename 在同一個檔案系統上是原子的。
    pub fn save(app: &AppHandle, creds: &SyncCredentials) -> Result<(), String> {
        let p = path_of(app)?;
        let tmp = p.with_extension("json.tmp");
        let json = serde_json::to_string(creds).map_err(|_| "同步設定序列化失敗。".to_string())?;
        fs::write(&tmp, json).map_err(|_| "寫入同步設定失敗。".to_string())?;
        // app 私有目錄本來就只有自己讀得到；再收一次權限當保險（其他 app 的 uid 不同）。
        // 在 rename **之前**收，正式檔才不會有一瞬間是寬權限的。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &p).map_err(|_| {
            let _ = fs::remove_file(&tmp);
            "寫入同步設定失敗。".to_string()
        })
    }

    pub fn clear(app: &AppHandle) -> Result<(), String> {
        let p = path_of(app)?;
        if p.exists() {
            fs::remove_file(&p).map_err(|_| "清除同步設定失敗。".to_string())?;
        }
        Ok(())
    }
}

/// 讀出；沒有＝Ok(None)；讀得到但壞掉＝Err（UI 顯示「停車中」並建議重設）。
pub fn load(app: &AppHandle) -> Result<Option<SyncCredentials>, String> {
    backend::load(app)
}

pub fn save(app: &AppHandle, creds: &SyncCredentials) -> Result<(), String> {
    backend::save(app, creds)
}

/// 清除（`sync_reset_local` 用）；本來就沒有也回 Ok。
pub fn clear(app: &AppHandle) -> Result<(), String> {
    backend::clear(app)
}
