//! 加密層——E2EE 的實體（P2「E2EE 一定要」；雲端只存密文）。
//!
//! 契約 §4：
//!   * 金鑰 ＝ argon2id(密語 UTF-8（trim）, salt 16B)，參數固定 **m=19456 KiB, t=2, p=1, 輸出 32B**
//!     （OWASP 2024/2025 第一組建議；手機上 <1 秒）。參數寫死在程式、由配對碼的 `v:1` 隱含——改參數＝`v:2`。
//!     派生只做一次（配對／啟用時），派生金鑰與 R2 憑證一起存 credstore；密語本身不存。
//!   * 物件明文 ＝ JSON（`engine::OplogObject`）→ zstd（level 3）
//!   * 物件密文 ＝ `nonce(24B 隨機) || XChaCha20-Poly1305(key, nonce, aad = 物件 key 字串, 明文)`
//!     AAD 綁 key：把 A 物件的密文搬到 B 的 key 底下會拆封失敗（防重放／錯位）。
//!
//! 依賴（WP7 實際採用）：`chacha20poly1305 = "0.11"`、`argon2 = "0.6"`、`zstd = "0.14"`、`base64 = "0.22"`、
//!   `getrandom = "0.3"`。**不用 `rand`**：`rand` 0.9／0.10 與 `rand_core` 正在換代，而 chacha20poly1305 0.11
//!   綁的是另一個 `rand_core` 版本，混起來會出現「兩份 OsRng 互不相容」的型別錯；我們只需要「填滿一段位元組」，
//!   直接用 `getrandom` 反而穩。
//!   zstd 帶 C 原始碼（zstd-sys）：**實測 `cargo check --target aarch64-linux-android` 用 NDK 28 的 clang 一次編過**，
//!   所以維持契約的 zstd＋`v1/` 前綴，不啟用 flate2 退路。

/// 派生金鑰長度（XChaCha20-Poly1305 用 32B）
pub const KEY_LEN: usize = 32;
/// XChaCha20 nonce 長度
pub const NONCE_LEN: usize = 24;
/// salt 長度（配對碼與 sync_meta 都以 base64url 攜帶）
pub const SALT_LEN: usize = 16;

/// argon2id 參數（契約固定；改了就是新配對碼版本）
pub const ARGON2_M_KIB: u32 = 19_456;
pub const ARGON2_T: u32 = 2;
pub const ARGON2_P: u32 = 1;

/// zstd 壓縮等級（契約 §4.2）
pub const ZSTD_LEVEL: i32 = 3;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

/// 建 cipher。`KeyInit::new_from_slice` 走 `Result`，比 `Array::from_slice` 少一次 panic 風險
/// （chacha20poly1305 0.11 的 Key 是 `hybrid-array` 的 `Array`，不再有 `from_slice`）。
fn cipher_of(key: &[u8; KEY_LEN]) -> Result<XChaCha20Poly1305, String> {
    XChaCha20Poly1305::new_from_slice(key).map_err(|_| "同步金鑰長度不對。".to_string())
}

fn nonce_of(bytes: &[u8]) -> Result<XNonce, String> {
    XNonce::try_from(bytes).map_err(|_| "同步資料的 nonce 長度不對。".to_string())
}

/// 密語 → 32B 金鑰。`salt` 必須正好 16B。
///
/// 為什麼參數寫死：配對碼的 `v:1` 就代表這組參數，兩台機器不必協商；要調參＝發 `v:2` 配對碼。
pub fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    if salt.len() != SALT_LEN {
        return Err("同步金鑰的鹽長度不對（設定可能損壞，請重設同步後重新配對）。".into());
    }
    let pass = passphrase.trim();
    if pass.is_empty() {
        return Err("密語不能是空的。".into());
    }
    let params = argon2::Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(KEY_LEN))
        .map_err(|_| "同步金鑰參數不合法。".to_string())?;
    let a2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    a2.hash_password_into(pass.as_bytes(), salt, &mut key)
        .map_err(|_| "推導同步金鑰失敗。".to_string())?;
    Ok(key)
}

/// 明文 → zstd → 密文（含前置 nonce）。`aad`＝物件 key 字串。
pub fn seal(key: &[u8; KEY_LEN], aad: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let packed = zstd::stream::encode_all(plaintext, ZSTD_LEVEL)
        .map_err(|_| "壓縮同步資料失敗。".to_string())?;
    let cipher = cipher_of(key)?;
    let mut nonce = [0u8; NONCE_LEN];
    fill_random(&mut nonce)?;
    let ct = cipher
        .encrypt(
            &nonce_of(&nonce)?,
            Payload { msg: &packed, aad: aad.as_bytes() },
        )
        .map_err(|_| "加密同步資料失敗。".to_string())?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 密文（含前置 nonce）→ 拆封 → 解 zstd → 明文。
///
/// 任何失敗都回同一句人話：拆封失敗的原因（密語錯／被改過／搬錯 key）對主人是同一件事，
/// 分得太細反而變成攻擊者的提示。
pub fn open(key: &[u8; KEY_LEN], aad: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    const BAD: &str = "密語不對或同步資料損壞。";
    if blob.len() <= NONCE_LEN {
        return Err(BAD.into());
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let cipher = cipher_of(key)?;
    let packed = cipher
        .decrypt(
            &nonce_of(nonce)?,
            Payload { msg: ct, aad: aad.as_bytes() },
        )
        .map_err(|_| BAD.to_string())?;
    zstd::stream::decode_all(packed.as_slice()).map_err(|_| BAD.to_string())
}

/// 隨機 16B salt（配對／啟用時各產一次）
pub fn random_salt() -> Result<[u8; SALT_LEN], String> {
    let mut salt = [0u8; SALT_LEN];
    fill_random(&mut salt)?;
    Ok(salt)
}

/// 作業系統亂數（不用 `rand`：`rand` 0.9／0.10 的 API 與 `rand_core` 版本正在換代，
/// 而我們只需要「填滿一段位元組」這一件事，直接用 `getrandom` 最穩）。
pub fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buf).map_err(|_| "取得系統亂數失敗。".to_string())
}

/// base64url（無 padding）── 金鑰／鹽在 credstore 與配對碼裡的攜帶形式
pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    B64.decode(s.trim()).map_err(|_| "同步設定的編碼損壞。".to_string())
}

/// base64url 的金鑰字串 → 32B 陣列
pub fn key_from_b64(s: &str) -> Result<[u8; KEY_LEN], String> {
    let v = b64_decode(s)?;
    if v.len() != KEY_LEN {
        return Err("同步金鑰長度不對（請重設同步後重新配對）。".into());
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&v);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 派生是確定的_而且換鹽就換金鑰() {
        let salt = [7u8; SALT_LEN];
        let a = derive_key("  月見坂 3 番線  ", &salt).unwrap();
        let b = derive_key("月見坂 3 番線", &salt).unwrap();
        assert_eq!(a, b, "密語前後空白要 trim 掉");
        let c = derive_key("月見坂 3 番線", &[8u8; SALT_LEN]).unwrap();
        assert_ne!(a, c);
        assert!(derive_key("   ", &salt).is_err());
        assert!(derive_key("x", &[0u8; 8]).is_err());
    }

    #[test]
    fn 封裝往返() {
        let key = derive_key("ひかり号", &[1u8; SALT_LEN]).unwrap();
        let aad = "v1/1758153600000/dev-a/17581536001230000-3f9c2b1e.bin";
        let plain = br#"{"version":1,"ops":[]}"#;
        let blob = seal(&key, aad, plain).unwrap();
        assert!(blob.len() > NONCE_LEN);
        assert_ne!(&blob[NONCE_LEN..], &plain[..], "雲端只能看到密文");
        assert_eq!(open(&key, aad, &blob).unwrap(), plain);
    }

    #[test]
    fn 換_key_或換密語都拆不開() {
        let key = derive_key("ひかり号", &[1u8; SALT_LEN]).unwrap();
        let other = derive_key("こだま号", &[1u8; SALT_LEN]).unwrap();
        let aad = "v1/e/d/a.bin";
        let blob = seal(&key, aad, b"hello").unwrap();
        assert!(open(&other, aad, &blob).is_err(), "密語不對要失敗");
        assert!(open(&key, "v1/e/d/b.bin", &blob).is_err(), "AAD 綁 key：搬到別的 key 底下要失敗");
        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(open(&key, aad, &tampered).is_err(), "被改過要失敗");
    }

    #[test]
    fn 壓縮確實有壓到() {
        let key = derive_key("ひかり号", &[1u8; SALT_LEN]).unwrap();
        let plain = "あ".repeat(4000).into_bytes();
        let blob = seal(&key, "v1/e/d/a.bin", &plain).unwrap();
        assert!(blob.len() < plain.len() / 4);
        assert_eq!(open(&key, "v1/e/d/a.bin", &blob).unwrap(), plain);
    }

    #[test]
    fn nonce_每次不同() {
        let key = [3u8; KEY_LEN];
        let a = seal(&key, "k", b"same").unwrap();
        let b = seal(&key, "k", b"same").unwrap();
        assert_ne!(a[..NONCE_LEN], b[..NONCE_LEN]);
    }
}
