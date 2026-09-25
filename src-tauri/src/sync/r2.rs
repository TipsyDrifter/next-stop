//! Cloudflare R2 客戶端（S3 相容 API；P6 改判）。
//!
//! 後端＝`object_store`（Plan 草案 §2 技術自決「S3 後端，SigV4 內建」）：
//!   Cargo（WP7 實際採用）：`object_store = { version = "0.12", features = ["aws", "tls-webpki-roots"] }`
//!   **為什麼不是 0.14**：0.14 的 `aws` feature 硬綁 `aws-lc-rs`，而 `aws-lc-sys` 在本機（無 cmake／無 nasm）
//!   與 Android NDK 都編不起來（實測 build.rs panic「NASM command not found」）。0.12 的 `cloud` feature 用 `ring`，
//!   桌機與 aarch64-linux-android 都一次編過。`tls-webpki-roots` 則是為了 Android：不依賴系統憑證庫
//!   （Android 的根憑證在 Java 那側，rustls-native-certs 讀不到），把 webpki 根憑證編進去最穩。
//!   建法：`AmazonS3Builder::new().with_endpoint(endpoint).with_bucket_name(bucket).with_region("auto")
//!         .with_access_key_id(ak).with_secret_access_key(sk).with_virtual_hosted_style_request(false).build()`
//!   endpoint ＝ `https://<account_id>.r2.cloudflarestorage.com`（r2.env 的 R2_ENDPOINT，path-style）。
//!   Plan §5 風險：開頭 30 分鐘 spike——R2 對條件寫入（If-None-Match）支援度未驗；本設計**不依賴**條件寫，
//!   靠「物件名含 hlc_from 唯一」避免覆寫。若 0.12 編不過（reqwest 版本撞 tauri 的 0.13）可升 0.14，介面同形。
//!
//! 只有四個動作，全部走 `v1/<epoch>/<device_id>/<hlc_from>.bin` 這種 key（契約 §4.1）：
//!   * put(key, bytes)                 ─ push 一個 oplog 物件
//!   * get(key) -> bytes               ─ pull 一個
//!   * list_after(prefix, after) -> Vec<key>（字典序、只回 key）─ 增量拉取的游標；`after`＝`sync_meta.last_pull_key`
//!   * delete(key)                     ─ 只給沙盒測試收工用（`sandbox/` 前綴）與 v1.1.2 舊 epoch 清理
//!
//! 鐵則：憑證只活在 `R2Client` 內部（不 derive Debug、不進 log、不進錯誤訊息）；
//!       測試物件一律 `sandbox/` 前綴並在收工時刪除；憑證從 `%LOCALAPPDATA%/NextStop/r2.env` 讀進環境變數，絕不寫進 repo。

/// R2 連線設定（建 client 用；**不 derive Debug**）
#[derive(Clone)]
pub struct R2Config {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

use futures_util::StreamExt;
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};

/// 客戶端（**不 derive Debug**：`AmazonS3` 的 Debug 會印出 endpoint／bucket，憑證雖不印但沒必要冒險）
pub struct R2Client {
    cfg: R2Config,
    store: AmazonS3,
}

impl R2Client {
    /// 建 client（不連線；第一次 put／list 才會）
    pub fn new(cfg: R2Config) -> Result<Self, String> {
        let store = AmazonS3Builder::new()
            .with_endpoint(cfg.endpoint.trim_end_matches('/').to_string())
            .with_bucket_name(cfg.bucket.clone())
            // R2 不分區；S3 SigV4 仍要求簽名帶 region，官方指定字面值 "auto"
            .with_region("auto")
            .with_access_key_id(cfg.access_key_id.clone())
            .with_secret_access_key(cfg.secret_access_key.clone())
            // R2 的 endpoint 是 `https://<account>.r2.cloudflarestorage.com`，bucket 走路徑段
            .with_virtual_hosted_style_request(false)
            // 只准 https：憑證與密文都不該裸奔
            .with_allow_http(false)
            .build()
            .map_err(|e| friendly(&e, "連線設定不正確"))?;
        Ok(Self { cfg, store })
    }

    /// 憑證是否能用：對 `prefix` 做一次 list（Class B、免費層內），失敗回人話。
    pub async fn probe(&self, prefix: &str) -> Result<(), String> {
        let p = ObjPath::from(prefix.trim_end_matches('/'));
        let mut stream = self.store.list(Some(&p));
        // 只要拿到「第一個結果或串流結束」就代表請求本身成功了；空 bucket 是正常狀況。
        match stream.next().await {
            None => Ok(()),
            Some(Ok(_)) => Ok(()),
            Some(Err(e)) => Err(friendly(&e, "連不上雲端置物櫃")),
        }
    }

    pub async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        self.store
            .put(&ObjPath::from(key), PutPayload::from(bytes))
            .await
            .map(|_| ())
            .map_err(|e| friendly(&e, "上傳同步資料失敗"))
    }

    /// 條件寫：**只有這顆 key 還不存在時才寫**（S3 的 `If-None-Match: *`）。
    /// 回 `Ok(true)`＝這次真的寫進去了；`Ok(false)`＝已經有人先寫了（一個位元都沒覆蓋）。
    ///
    /// 為什麼需要（v1.1.3 工程評審 S-3）：`<root>/SALT` 是一整份資料的血統來源，兩台同時當「第一台」時
    /// 無條件 PUT 會讓後寫者贏——先寫的那台鑰匙圈裡留著另一個鹽，下一趟就 `locked='salt'`（鍵違い）。
    /// 條件寫讓「誰先誰就是這份資料」變成原子的，輸的那台當場知道自己該走「加入既有的那份」。
    ///
    /// `object_store` 0.12 的 `S3ConditionalPut` 預設就是 `ETagMatch`（文件明寫支援 Cloudflare R2）。
    /// R2 對既有物件回 412 ⇒ `Error::Precondition`；有些實作回 409 ⇒ `Error::AlreadyExists`，兩個都當「已存在」。
    /// 萬一某天端點不支援（`NotSupported`）就退回無條件 PUT——退化回舊行為，不會讓加入同步整個壞掉。
    pub async fn put_if_absent(&self, key: &str, bytes: Vec<u8>) -> Result<bool, String> {
        use object_store::{Error as OsError, PutMode, PutOptions};
        let path = ObjPath::from(key);
        match self
            .store
            .put_opts(&path, PutPayload::from(bytes.clone()), PutOptions::from(PutMode::Create))
            .await
        {
            Ok(_) => Ok(true),
            Err(OsError::AlreadyExists { .. }) | Err(OsError::Precondition { .. }) => Ok(false),
            Err(OsError::NotSupported { .. }) => {
                self.put(key, bytes).await?;
                Ok(true)
            }
            Err(e) => Err(friendly(&e, "上傳同步資料失敗")),
        }
    }

    pub async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        let got = self
            .store
            .get(&ObjPath::from(key))
            .await
            .map_err(|e| friendly(&e, "下載同步資料失敗"))?;
        let bytes = got
            .bytes()
            .await
            .map_err(|e| friendly(&e, "下載同步資料失敗"))?;
        Ok(bytes.to_vec())
    }

    /// 回 `prefix` 底下、字典序 > `after` 的 key（`after` 為空字串＝從頭）；已排序。
    ///
    /// `list_with_offset` 的語義就是「嚴格大於 offset」，正好等於我們的游標語義
    /// （`sync_meta.last_pull_key` ＝最後一個 apply 成功的 key）。S3／R2 的 list 本來就是字典序，
    /// 但分頁邊界不保證跨頁全域有序，所以收完再排一次（量小，成本可忽略）。
    pub async fn list_after(&self, prefix: &str, after: &str) -> Result<Vec<String>, String> {
        let p = ObjPath::from(prefix.trim_end_matches('/'));
        let mut keys: Vec<String> = Vec::new();
        if after.is_empty() {
            let mut stream = self.store.list(Some(&p));
            while let Some(item) = stream.next().await {
                keys.push(item.map_err(|e| friendly(&e, "列出同步資料失敗"))?.location.to_string());
            }
        } else {
            let offset = ObjPath::from(after);
            let mut stream = self.store.list_with_offset(Some(&p), &offset);
            while let Some(item) = stream.next().await {
                keys.push(item.map_err(|e| friendly(&e, "列出同步資料失敗"))?.location.to_string());
            }
        }
        keys.sort();
        Ok(keys)
    }

    /// 回 `prefix` 底下第一層的「目錄」（S3 的 common prefixes，無尾斜線）。
    ///
    /// 為什麼 v1.1.2 需要它（契約 §2.2）：雙向之後每台各自產物件，游標必須是
    /// **per-device**（`last_pull_key:<device_id>`）——S3 的 list 是全域字典序，
    /// `v1/<epoch>/<devA>/…` 永遠排在 `v1/<epoch>/<devB>/…` 前面，單一游標一旦推到 devB
    /// 就再也看不到 devA 後來新增的物件。要 per-device 游標就得先知道「有哪些 device」，
    /// 而 `list_with_delimiter` 正好一次 Class B 就把第一層目錄全撈回來
    /// （`v1/<epoch>/EPOCH.bin` 這種**直接放在該層的物件**不會出現在 common prefixes，
    ///  所以拿到的一定是 device 目錄，不必再過濾副檔名）。
    ///
    /// 例：`list_prefixes("v1/1758…/")` → `["v1/1758…/<devA>", "v1/1758…/<devB>"]`（已排序）。
    pub async fn list_prefixes(&self, prefix: &str) -> Result<Vec<String>, String> {
        let p = ObjPath::from(prefix.trim_end_matches('/'));
        let res = self
            .store
            .list_with_delimiter(Some(&p))
            .await
            .map_err(|e| friendly(&e, "列出同步資料失敗"))?;
        let mut v: Vec<String> = res.common_prefixes.iter().map(|x| x.to_string()).collect();
        v.sort();
        Ok(v)
    }

    /// v1.1.4（契約 §4 `sync_cloud_snapshot_list`）：`prefix` 底下全部物件的 (key, size)，已依 key 排序。
    /// 為什麼不沿用 `list_after`：快照列表要顯示大小（「38 KB」），而 `ObjectMeta.size` 本來就在 list 回應裡——
    /// 多一支回大小的版本，就不必為了一個數字逐顆 HEAD。
    pub async fn list_objects(&self, prefix: &str) -> Result<Vec<(String, u64)>, String> {
        let p = ObjPath::from(prefix.trim_end_matches('/'));
        let mut out: Vec<(String, u64)> = Vec::new();
        let mut stream = self.store.list(Some(&p));
        while let Some(item) = stream.next().await {
            let meta = item.map_err(|e| friendly(&e, "列出同步資料失敗"))?;
            out.push((meta.location.to_string(), meta.size as u64));
        }
        out.sort();
        Ok(out)
    }

    /// `get`，但「雲端沒有這個 key」回 `Ok(None)` 而不是 Err。
    ///
    /// 為什麼：`v1/<epoch>/EPOCH.bin`（紀元標記，契約 §4.2）本來就可能不存在——
    /// v1.1.1 建立的第一個紀元沒有它，正本剛開新紀元時也可能還沒寫上去。
    /// 「沒有」是正常狀況，不該讓整趟 pull 變成「停車中」。
    pub async fn get_opt(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self.store.get(&ObjPath::from(key)).await {
            Ok(got) => Ok(Some(
                got.bytes()
                    .await
                    .map_err(|e| friendly(&e, "下載同步資料失敗"))?
                    .to_vec(),
            )),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(friendly(&e, "下載同步資料失敗")),
        }
    }

    pub async fn delete(&self, key: &str) -> Result<(), String> {
        self.store
            .delete(&ObjPath::from(key))
            .await
            .map_err(|e| friendly(&e, "刪除同步資料失敗"))
    }

    pub fn bucket(&self) -> &str {
        &self.cfg.bucket
    }
}

/// object_store 的錯誤 → 人話。
///
/// 鐵則：**不把 source 的原文整串倒出來**——SigV4 的錯誤訊息有時會回帶 access key id。
/// 只認幾種常見狀況給明確建議，其餘一律含糊帶過並請主人看網路。
fn friendly(e: &object_store::Error, what: &str) -> String {
    use object_store::Error as E;
    match e {
        E::NotFound { .. } => format!("{what}：雲端找不到這份資料（可能已被清掉）。"),
        E::NotModified { .. } => format!("{what}：雲端資料沒有變化。"),
        E::PermissionDenied { .. } | E::Unauthenticated { .. } => {
            format!("{what}：雲端拒絕了這組金鑰（請確認 Access Key／Secret 與 bucket 權限）。")
        }
        _ => {
            let raw = e.to_string();
            let hint = if raw.contains("401") || raw.contains("403") || raw.contains("SignatureDoesNotMatch") {
                "雲端拒絕了這組金鑰（請確認 Access Key／Secret 與 bucket 權限）。"
            } else if raw.contains("404") || raw.contains("NoSuchBucket") {
                "找不到這個 bucket（請確認 bucket 名稱）。"
            } else if raw.contains("dns") || raw.contains("Dns") || raw.contains("resolve") {
                "連不上雲端位址（請確認 endpoint 與網路）。"
            } else {
                "請確認網路與雲端設定後再試一次。"
            };
            format!("{what}：{hint}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::crypto;

    /// 對**真的** R2 bucket 跑一趟 put → list_after → get → 拆封 → delete。
    ///
    /// 預設 `#[ignore]`：要憑證才跑，CI／一般 `cargo test` 不該碰網路。跑法（Git Bash）：
    /// ```text
    /// set -a && source "$LOCALAPPDATA/NextStop/r2.env" && set +a
    /// cargo test --lib sync::r2::tests::真bucket -- --ignored --nocapture
    /// ```
    /// 鐵則：
    ///   * 物件一律放 `sandbox/` 前綴，測完**一定刪掉**（收工不留垃圾）。
    ///   * 憑證只從環境變數讀，**一個字都不印**（連 bucket 名都不印——assert 失敗訊息也只講形狀）。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 真bucket往返() {
        let Ok(endpoint) = std::env::var("R2_ENDPOINT") else {
            panic!("缺 R2_ENDPOINT（請先 source r2.env）");
        };
        let bucket = std::env::var("R2_BUCKET").expect("缺 R2_BUCKET");
        let ak = std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID");
        let sk = std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY");

        let client = R2Client::new(R2Config {
            endpoint,
            bucket,
            access_key_id: ak,
            secret_access_key: sk,
        })
        .expect("建 client 失敗");

        // 每次跑用不重複的前綴，避免兩次測試互相看到對方的物件
        let mut stamp = [0u8; 8];
        crypto::fill_random(&mut stamp).unwrap();
        let run = crypto::b64_encode(&stamp);
        let prefix = format!("sandbox/{run}/");
        let key_a = format!("{prefix}00000000000000000-aaaaaaaa.bin");
        let key_b = format!("{prefix}00000000000000001-aaaaaaaa.bin");

        let cryptokey = crypto::derive_key("sandbox-passphrase", &[42u8; crypto::SALT_LEN]).unwrap();
        let plain_a = br#"{"version":1,"ops":[{"tbl":"nodes"}]}"#.to_vec();
        let plain_b = br#"{"version":1,"ops":[{"tbl":"work_logs"}]}"#.to_vec();

        let result = tauri::async_runtime::block_on(async {
            // ① 憑證能用？
            client.probe(&prefix).await?;

            // ② put 兩個
            client.put(&key_a, crypto::seal(&cryptokey, &key_a, &plain_a)?).await?;
            client.put(&key_b, crypto::seal(&cryptokey, &key_b, &plain_b)?).await?;

            // ③ list：從頭應該看到兩個、從 key_a 之後應該只看到 key_b（游標語義）
            let all = client.list_after(&prefix, "").await?;
            let after_a = client.list_after(&prefix, &key_a).await?;

            // ④ get＋拆封
            let got_a = crypto::open(&cryptokey, &key_a, &client.get(&key_a).await?)?;
            // ⑤ AAD 綁 key：把 A 的密文當成 B 來拆一定要失敗
            let blob_a = client.get(&key_a).await?;
            let wrong_aad = crypto::open(&cryptokey, &key_b, &blob_a).is_err();

            // ⑥ 收工：刪掉（不管前面 assert 會不會過，刪除在 assert 之前跑）
            client.delete(&key_a).await?;
            client.delete(&key_b).await?;
            let left = client.list_after(&prefix, "").await?;

            Ok::<_, String>((all, after_a, got_a, wrong_aad, left))
        })
        .expect("R2 往返失敗");

        let (all, after_a, got_a, wrong_aad, left) = result;
        assert_eq!(all.len(), 2, "list 應該看到兩個物件");
        assert_eq!(all[0], key_a);
        assert_eq!(all[1], key_b);
        assert_eq!(after_a, vec![key_b.clone()], "list_after 應該只回游標之後的");
        assert_eq!(got_a, plain_a, "拆封後要等於原文");
        assert!(wrong_aad, "AAD 綁 key：換 key 拆封必須失敗");
        assert!(left.is_empty(), "收工要把沙盒物件刪乾淨");
    }

    /// v1.1.3 工程評審 S-3：`put_if_absent` 對**真的** R2 要真的是條件寫。
    ///
    /// 驗三件事：① 不存在時寫得進去（回 true）；② 已存在時回 false；
    /// ③ **內容一個位元都沒被覆蓋**（這是整個 S-3 的重點——輸的那台不該把贏家的 SALT 蓋掉）。
    /// 跑法同上；物件一律 `sandbox/` 前綴、測完刪除。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 條件寫只有第一次寫得進去() {
        let client = R2Client::new(R2Config {
            endpoint: std::env::var("R2_ENDPOINT").expect("缺 R2_ENDPOINT（請先 source r2.env）"),
            bucket: std::env::var("R2_BUCKET").expect("缺 R2_BUCKET"),
            access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID"),
            secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY"),
        })
        .expect("建 client 失敗");

        let mut stamp = [0u8; 8];
        crypto::fill_random(&mut stamp).unwrap();
        let run = crypto::b64_encode(&stamp);
        let key = format!("sandbox/{run}/SALT");

        let result = tauri::async_runtime::block_on(async {
            let first = client.put_if_absent(&key, b"first-writer".to_vec()).await?;
            let second = client.put_if_absent(&key, b"second-writer".to_vec()).await?;
            let body = client.get(&key).await?;
            client.delete(&key).await?; // 收工在 assert 之前
            let left = client.list_after(&format!("sandbox/{run}/"), "").await?;
            Ok::<_, String>((first, second, body, left))
        })
        .expect("條件寫測試失敗");

        let (first, second, body, left) = result;
        assert!(first, "不存在時條件寫要成功");
        assert!(!second, "已存在時條件寫要回 false（不是 Err、也不是覆蓋）");
        assert_eq!(body, b"first-writer".to_vec(), "內容必須還是第一個寫進去的");
        assert!(left.is_empty(), "收工要把沙盒物件刪乾淨");
    }

    /// v1.1.2 §2.5：`list_prefixes` 要看得到「兩台各自的目錄」，`get_opt` 對不存在的 key 回 None。
    ///
    /// 跑法同上；物件一律 `sandbox/` 前綴、測完刪除。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 裝置目錄與可選取得() {
        let client = R2Client::new(R2Config {
            endpoint: std::env::var("R2_ENDPOINT").expect("缺 R2_ENDPOINT（請先 source r2.env）"),
            bucket: std::env::var("R2_BUCKET").expect("缺 R2_BUCKET"),
            access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID"),
            secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY"),
        })
        .expect("建 client 失敗");

        let mut stamp = [0u8; 8];
        crypto::fill_random(&mut stamp).unwrap();
        let run = crypto::b64_encode(&stamp);
        let root = format!("sandbox/{run}/");
        let key_a = format!("{root}dev-a/00000000000000000-aaaaaaaa.bin");
        let key_b = format!("{root}dev-b/00000000000000000-bbbbbbbb.bin");
        let marker = format!("{root}EPOCH.bin");

        let (dirs, missing, present, left) = tauri::async_runtime::block_on(async {
            client.put(&key_a, b"a".to_vec()).await?;
            client.put(&key_b, b"b".to_vec()).await?;
            // EPOCH.bin 放在同一層：它是**物件**不是目錄，不該混進 list_prefixes 的結果
            client.put(&marker, b"m".to_vec()).await?;

            let dirs = client.list_prefixes(&root).await?;
            let missing = client.get_opt(&format!("{root}nope.bin")).await?;
            let present = client.get_opt(&marker).await?;

            for k in [&key_a, &key_b, &marker] {
                client.delete(k).await?;
            }
            let left = client.list_after(&root, "").await?;
            Ok::<_, String>((dirs, missing, present, left))
        })
        .expect("R2 往返失敗");

        assert_eq!(dirs.len(), 2, "應該只看到兩個 device 目錄（EPOCH.bin 是物件不是目錄）");
        assert!(dirs[0].ends_with("/dev-a"), "目錄名應該是 device_id");
        assert!(dirs[1].ends_with("/dev-b"));
        assert!(missing.is_none(), "不存在的 key 要回 None，不是 Err");
        assert_eq!(present.as_deref(), Some(&b"m"[..]));
        assert!(left.is_empty(), "收工要把沙盒物件刪乾淨");
    }

    /// 收工：把 `v1/` 底下**非數字紀元**（＝沙盒的 `v1/sandbox-…/`）的物件全刪掉，並確認清乾淨。
    ///
    /// 為什麼安全：判準是「目錄名 parse 成 u64 失敗」——主人正本的紀元一定是 13 位毫秒數字，
    /// 這支**碰不到**它，連看都只看目錄名。測試中途 panic 會跳過測試自己的收工步驟，
    /// 所以留一支專門的掃地工（契約 §10.3 收工清單）。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 沙盒紀元已清空() {
        let client = R2Client::new(R2Config {
            endpoint: std::env::var("R2_ENDPOINT").expect("缺 R2_ENDPOINT"),
            bucket: std::env::var("R2_BUCKET").expect("缺 R2_BUCKET"),
            access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID"),
            secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY"),
        })
        .expect("建 client 失敗");

        let left = tauri::async_runtime::block_on(async {
            let mut removed = 0usize;
            let mut left = 0usize;
            for dir in client.list_prefixes("v1/").await? {
                let seg = dir.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                if seg.parse::<u64>().is_ok() {
                    continue; // 數字紀元＝主人正本的，一律不碰
                }
                for k in client.list_after(&format!("{dir}/"), "").await? {
                    client.delete(&k).await?;
                    removed += 1;
                }
                left += client.list_after(&format!("{dir}/"), "").await?.len();
            }
            println!("沙盒紀元：刪掉 {removed} 個物件");
            Ok::<_, String>(left)
        })
        .expect("清理沙盒紀元失敗");
        assert_eq!(left, 0, "沙盒紀元底下還留著 {left} 個物件");
    }

    /// 收工：把**沙盒根**（`v1-sb-…/`，v1.1.3 契約 §0 鐵則 4）底下的物件全刪掉，並確認清乾淨。
    ///
    /// 為什麼安全：判準是「頂層目錄名以 `v1-sb-` 開頭」——主人正本的根是 `v1/`，
    /// 這支連看都看不到它；`v1/SALT` 與 `v1/KEY` 是**物件**不是目錄，更不會出現在 common prefixes 裡。
    /// 測試中途 panic 會跳過測試自己的收工步驟，所以留一支專門的掃地工。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 沙盒根已清空() {
        let client = R2Client::new(R2Config {
            endpoint: std::env::var("R2_ENDPOINT").expect("缺 R2_ENDPOINT"),
            bucket: std::env::var("R2_BUCKET").expect("缺 R2_BUCKET"),
            access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID"),
            secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY"),
        })
        .expect("建 client 失敗");

        let left = tauri::async_runtime::block_on(async {
            let mut removed = 0usize;
            let mut left = 0usize;
            let tops = client.list_prefixes("").await?;
            // 掃到 0 個頂層目錄＝`list_prefixes("")` 沒回東西＝這支其實什麼都沒掃（假的綠燈）
            assert!(!tops.is_empty(), "頂層一個目錄都看不到，掃地工等於沒跑");
            let mut sandbox_roots = 0usize;
            for dir in tops {
                let seg = dir.trim_end_matches('/').rsplit('/').next().unwrap_or("");
                if !seg.starts_with("v1-sb-") {
                    continue; // 只認沙盒根；主人正本的 `v1/` 一律不碰
                }
                sandbox_roots += 1;
                for k in client.list_after(&format!("{dir}/"), "").await? {
                    client.delete(&k).await?;
                    removed += 1;
                }
                left += client.list_after(&format!("{dir}/"), "").await?.len();
            }
            println!("沙盒根：掃到 {sandbox_roots} 個沙盒根、刪掉 {removed} 個物件");
            Ok::<_, String>(left)
        })
        .expect("清理沙盒根失敗");
        assert_eq!(left, 0, "沙盒根底下還留著 {left} 個物件");
    }

    /// 收工檢查：整個 `sandbox/` 前綴是空的（測試沒留垃圾在主人的 bucket 裡）。
    ///
    /// 跟上面同樣要憑證，所以一樣 `#[ignore]`；每次跑完 R2 測試順手跑這支。
    #[test]
    #[ignore = "需要 R2 憑證：source %LOCALAPPDATA%/NextStop/r2.env 後加 --ignored"]
    fn 沙盒前綴已清空() {
        let client = R2Client::new(R2Config {
            endpoint: std::env::var("R2_ENDPOINT").expect("缺 R2_ENDPOINT"),
            bucket: std::env::var("R2_BUCKET").expect("缺 R2_BUCKET"),
            access_key_id: std::env::var("R2_ACCESS_KEY_ID").expect("缺 R2_ACCESS_KEY_ID"),
            secret_access_key: std::env::var("R2_SECRET_ACCESS_KEY").expect("缺 R2_SECRET_ACCESS_KEY"),
        })
        .expect("建 client 失敗");
        let left = tauri::async_runtime::block_on(client.list_after("sandbox/", ""))
            .expect("列出 sandbox/ 失敗");
        assert!(left.is_empty(), "sandbox/ 底下還留著 {} 個物件，請清乾淨", left.len());
    }
}
