//! 復原碼——「第二把包裝」（v1.1.5；契約席 2026-09-25 立骨架與純函式、WP-A 填桶內動作）。
//!
//! 拍板依據：決策記錄〈v1.1.5 Plan 拍板〉（復原碼照小紗設計：1Password 形狀）＋
//!   《2026-09-25-v1.1.5-實施計畫草案.md》§1 技術自決（格式／RECOVERY 物件／重生／救援入口／不存本機）＋
//!   《2026-09-25-v1.1.5-同步告警與復原碼契約.md》§4。
//!
//! 為什麼要有它：E2EE 下忘了密語＝資料鑰匙不可復原（所有裝置都遺失時）。復原碼是**第二把包裝鑰匙**——
//!   與密語走同一條路（`crypto::wrap_data_key`），只是把資料鑰匙另外包成 `<root>/RECOVERY` 一顆物件。
//!   它不是新規則：用碼加入＝「加入同步」表單的另一種密語輸入（三條規則不增加）。
//!
//! 格式（§1 技術自決）：`random 128 bits → Base32（RFC 4648 字集、無 padding、26 字元）＋ 1 字元校驗碼
//!   （SHA-256(原始 16B) 的前 5 bits 映射到同一個 Base32 字集）＝ 27 字元`。
//!   顯示：每 5 字一組加連字號、全大寫（`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX`）；輸入：忽略連字號／空白／大小寫。
//!   Base32 字集沒有 0、1、8、9，所以 `0/O`、`1/I` 的抄錯**不需要**互換，直接當「這個字不對」擋掉。
//!
//! 物件：`<root>/RECOVERY`＝`wrap_data_key(derive_key(code, kdf_salt), aad="<root>/RECOVERY", data_key, kdf_salt)`
//!   ——與 `<root>/KEY` 同一個 `WrappedKey` v1 格式（自帶 kdf 鹽），argon2 參數沿用（碼的熵夠高，不特化）。
//!   `derive_key` 一律走 `engine::derive_blocking`（spawn_blocking；工程鐵則）。
//!
//! 鐵則：復原碼**只顯示一次、不存本機**；log 與回報絕不印碼值（本檔的 `eprintln!` 只印物件鍵與計數）。
//!   契約 §4.4：這台鑰匙圈只存「碼派生出來的包裝鑰匙 W＋它的鹽」（`credstore::SyncCredentials::recovery_*`），
//!   讓**產生它的這一台**換鑰匙時能不靠碼就重包 RECOVERY；W 從不上桶（否則拿舊資料鑰匙的人就能解出新鑰匙）。
//!
//! **WP-A（2026-09-25）填的桶內動作**——全部拆成「不吃 AppHandle」的零件＋薄殼，整合測（`#[ignore]`）才打得到：
//!   * `issue_recovery`（產碼→封→PUT，S-10 式補救）＋殼 `set_recovery`（守門、鑰匙圈存 W＋鹽、`recovery_set='1'`）
//!   * `clear_recovery`（DELETE、鑰匙圈清兩欄、`recovery_set='0'`）
//!   * `rewrap_after_rotation`（輪替步驟 3.5：有 W 且鹽對得上 ⇒ 重包成 K2；否則 DELETE＝作廢）
//!   * `rescue_data_key`＋`ensure_rescue_current`（join 的用碼路：拆 RECOVERY、再確認拆出來的是**現役**鑰匙）
//!
//!   為什麼「用碼加入的那一台」**不存 W**（契約 §4.4 的延伸，WP-A 自決）：W 住得越多台，「某台遺失 → 在另一台換鑰匙」
//!   時重包好的 RECOVERY 就越可能被遺失那台的鑰匙圈（W＋R2 憑證都在裡面）解開——真撤銷破功。W 只留產碼那一台。

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use super::credstore;
use super::crypto;
use super::r2::R2Client;

/// 原始亂數長度（128 bits）
pub const CODE_BYTES: usize = 16;
/// Base32 主體長度（128 bits → 26 字元，最後一字帶 2 個零填充位）
pub const CODE_BODY_LEN: usize = 26;
/// 含校驗碼的總長
pub const CODE_LEN: usize = CODE_BODY_LEN + 1;
/// 顯示時每組幾字
pub const DISPLAY_GROUP: usize = 5;

/// RFC 4648 Base32 字集（無 0、1、8、9）
const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// ── 用碼加入的人話（任務單的三句＋契約 §4.6／§7 甲6 的對帳關鍵字「校驗碼」「復原碼不對」都保留）──

/// 填充位或校驗碼對不上＝抄錯一個字（**不打網路**就擋下來；沙盒 甲6(a)）
pub(crate) const TYPO: &str = "復原碼好像抄錯了一個字（校驗碼對不上），請再對一次。";
/// 桶裡沒有 `<root>/RECOVERY`
pub(crate) const NOT_SET: &str = "這份資料還沒設定復原碼——請用密語加入，或先在已加入的裝置產生一組。";
/// 格式對、桶裡也有，但拆不開（重生過＝舊碼作廢），或拆得開卻是已經換掉的舊鑰匙（換過鑰匙）。
/// v1.1.5 修正席（產品評審 S1／工程評審 S-4）：校驗碼只有 5 bits，單字抄錯約 1/32 會漏網走到這裡——
/// 所以先講「可能抄錯了一個字」，免得主人明明只是抄錯、卻跑去重生一組碼。對帳關鍵字「復原碼不對」「已作廢」都保留。
pub(crate) const REVOKED: &str =
    "復原碼不對——可能抄錯了一個字，或這組已作廢（重新產生過或換過鑰匙）。請再對一次，或用最新的那一組。";
/// 桶是空的：沒有任何資料可以救
pub(crate) const CLOUD_EMPTY: &str = "雲端是空的，沒有復原碼可用——第一台請用密語加入。";
/// 帶了碼又打了密語
pub(crate) const BOTH_GIVEN: &str = "密語與復原碼只能填一種。";
/// 用碼加入成功後 toast 尾巴的下一步（`JoinReport.message`；與橫幅 `needs_passphrase` 同一個出路）
pub(crate) const RESCUE_NEXT_STEP: &str = "這台是用復原碼加入的——請接著到〈密語〉設一個新密語（現密語留白）。";
/// 產碼時發現這台的鑰匙已被別台換掉（與 `change_passphrase` 的 rotated_note 同一條出路）
pub(crate) const ROTATED_ELSEWHERE: &str =
    "這份資料已在另一台換過鑰匙——這台的鑰匙已經不算數了，現在產生的復原碼會是廢的。請先用新密語「重新加入同步」，再產生復原碼。";

/// `sync_recovery_generate` 的回傳（契約 §5）。**只回一次**：之後 `SyncStatus.recovery_set` 只說「設過」。
#[derive(Debug, Clone, Serialize)]
pub struct RecoveryReport {
    /// 顯示用（含連字號、全大寫）
    pub code_display: String,
}

/// `<root>/RECOVERY`（契約 §4.2；AAD＝這把鍵）
pub(crate) fn recovery_object_key(root: &str) -> String {
    format!("{root}/RECOVERY")
}

fn alphabet_index(c: u8) -> Option<u8> {
    ALPHABET.iter().position(|&a| a == c).map(|i| i as u8)
}

/// 16B → 26 字 Base32（無 padding；最後一字的低 2 位是零填充）
pub(crate) fn encode_body(bytes: &[u8; CODE_BYTES]) -> String {
    let mut out = String::with_capacity(CODE_BODY_LEN);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &b in bytes {
        buffer = (buffer << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    debug_assert_eq!(out.len(), CODE_BODY_LEN);
    out
}

/// 26 字 Base32 → 16B；填充位不是零＝抄錯（回人話）
pub(crate) fn decode_body(body: &str) -> Result<[u8; CODE_BYTES], String> {
    if body.len() != CODE_BODY_LEN {
        return Err(format!("復原碼的主體要 {CODE_BODY_LEN} 個字。"));
    }
    let mut out = [0u8; CODE_BYTES];
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    let mut i = 0usize;
    for (pos, c) in body.bytes().enumerate() {
        let v = alphabet_index(c).ok_or_else(|| bad_char(pos, c as char))?;
        buffer = (buffer << 5) | u32::from(v);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if i < CODE_BYTES {
                out[i] = ((buffer >> bits) & 0xff) as u8;
                i += 1;
            }
        }
    }
    // 130 bits 進來、128 bits 出去：剩下 2 bits 必須是零，否則最後一字被抄錯
    if bits != 2 || (buffer & ((1 << bits) - 1)) != 0 {
        return Err(TYPO.into());
    }
    Ok(out)
}

/// 校驗碼＝SHA-256(原始 16B) 的前 5 bits → Base32 字
pub(crate) fn checksum_char(bytes: &[u8; CODE_BYTES]) -> char {
    let digest = Sha256::digest(bytes);
    ALPHABET[(digest[0] >> 3) as usize] as char
}

fn bad_char(pos: usize, c: char) -> String {
    format!(
        "復原碼只會有英文字母與 2～7 的數字（沒有 0、1、8、9）——第 {} 個字「{}」不對。",
        pos + 1,
        c
    )
}

/// 產一組新碼（**正規形**：27 字、全大寫、無連字號）。顯示前請過 `format_for_display`。
pub fn generate_code() -> Result<String, String> {
    let mut raw = [0u8; CODE_BYTES];
    crypto::fill_random(&mut raw)?;
    Ok(encode_from_bytes(&raw))
}

/// 16B → 正規形 27 字（主體＋校驗碼）；測試與 `generate_code` 共用
pub(crate) fn encode_from_bytes(raw: &[u8; CODE_BYTES]) -> String {
    let mut code = encode_body(raw);
    code.push(checksum_char(raw));
    code
}

/// 正規形 → 顯示形：每 5 字一組加連字號（`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX`）
pub fn format_for_display(code: &str) -> String {
    code.as_bytes()
        .chunks(DISPLAY_GROUP)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// 手機 IME 與複製貼上常帶進來的字先折回 ASCII（v1.1.5 修正席／工程評審 S-3）：
/// 全形英數（Ａ、２，U+FF01–FF5E）→ 半形；全形空白 → 空白；零寬字元（U+200B–200D、U+2060、U+FEFF）直接丟掉——
/// 不丟的話錯誤訊息會是「第 N 個字「」不對」，主人看不到是什麼。回 None＝丟掉。
fn fold_char(c: char) -> Option<char> {
    match c {
        '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}' => None,
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0),
        '\u{3000}' => Some(' '),
        _ => Some(c),
    }
}

/// 當成分隔符（跟連字號一樣忽略）的字：各種連字號／破折號／減號、日文長音符與中點（IME 打「-」常變成它們）、底線
fn is_separator(c: char) -> bool {
    matches!(
        c,
        '-' | '_'
            | '\u{2010}'..='\u{2015}' // ‐ ‑ ‒ – — ―
            | '\u{2212}' // −（減號）
            | '\u{30FC}' | '\u{FF70}' // ー ｰ（長音符）
            | '\u{30FB}' | '\u{FF65}' | '\u{00B7}' // ・ ･ ·（中點）
    )
}

/// 主人打的任何寫法 → 正規形。折全形／去零寬字元、去連字號類分隔符與空白、轉大寫、驗長度、驗字集、驗填充位、驗校驗碼；
/// 每一種失敗都回一句人話（契約 §6.5 的錯誤文案）。**不打網路**——這是「加入」路上第一道門（沙盒 甲6）。
pub fn normalize(input: &str) -> Result<String, String> {
    let cleaned: String = input
        .chars()
        .filter_map(fold_char)
        .filter(|c| !c.is_whitespace() && !is_separator(*c))
        .flat_map(char::to_uppercase)
        .collect();
    if cleaned.is_empty() {
        return Err("請輸入復原碼。".into());
    }
    let n = cleaned.chars().count();
    if n != CODE_LEN {
        return Err(format!("復原碼要 {CODE_LEN} 個字（不含連字號），現在是 {n} 個。"));
    }
    if let Some((pos, c)) = cleaned.chars().enumerate().find(|(_, c)| !c.is_ascii() || alphabet_index(*c as u8).is_none()) {
        return Err(bad_char(pos, c));
    }
    let (body, check) = cleaned.split_at(CODE_BODY_LEN);
    let raw = decode_body(body)?;
    if check.chars().next() != Some(checksum_char(&raw)) {
        return Err(TYPO.into());
    }
    Ok(cleaned)
}

/// 把資料鑰匙用「碼派生的包裝鑰匙」封成 `<root>/RECOVERY` 的位元組（新的 kdf 鹽、新的 nonce）。
/// 回 `(物件鍵, 位元組, 包裝鑰匙 W, kdf 鹽)`——W 與鹽要存進鑰匙圈（契約 §4.4），碼本身丟掉。
pub(crate) async fn wrapped_recovery_bytes(
    root: &str,
    code: &str,
    data_key: &[u8; crypto::KEY_LEN],
) -> Result<(String, Vec<u8>, [u8; crypto::KEY_LEN], [u8; crypto::SALT_LEN]), String> {
    let kdf_salt = crypto::random_salt()?;
    let wrap = super::engine::derive_blocking(code, &kdf_salt).await?;
    let obj = recovery_object_key(root);
    let bytes = crypto::wrap_data_key(&wrap, &obj, data_key, &kdf_salt)?;
    Ok((obj, bytes, wrap, kdf_salt))
}

/// 用**已知的包裝鑰匙 W 與鹽**重包（換鑰匙步驟 3 之後；契約 §4.5）——不需要碼。鹽照舊、nonce 新。
pub(crate) fn rewrap_recovery_bytes(
    root: &str,
    wrap: &[u8; crypto::KEY_LEN],
    kdf_salt: &[u8],
    data_key: &[u8; crypto::KEY_LEN],
) -> Result<Vec<u8>, String> {
    crypto::wrap_data_key(wrap, &recovery_object_key(root), data_key, kdf_salt)
}

/// 用碼拆 `<root>/RECOVERY` → 資料鑰匙（碼不對／物件被改過都回同一句人話 `REVOKED`）
pub(crate) async fn unseal_recovery_object(
    root: &str,
    code: &str,
    bytes: &[u8],
) -> Result<[u8; crypto::KEY_LEN], String> {
    let wk = crypto::parse_wrapped_key(bytes)?;
    let kdf_salt = crypto::b64_decode(&wk.salt)?;
    let wrap = super::engine::derive_blocking(code, &kdf_salt).await?;
    crypto::unwrap_data_key(&wrap, &recovery_object_key(root), bytes).map_err(|_| REVOKED.to_string())
}

/// 桶裡有沒有 `<root>/RECOVERY`（一次 Class B GET；`ensure_bucket_meta` 每進程對一次，契約 §4.7）
pub(crate) async fn has_recovery(client: &R2Client, root: &str) -> Result<bool, String> {
    Ok(client.get_opt(&recovery_object_key(root)).await?.is_some())
}

/// `issue_recovery` 的結果。**不 derive Debug**（碼與 W 都在裡面，不准被 `{:?}` 印出來）。
pub(crate) struct Issued {
    /// 正規形 27 字——呼叫端轉成顯示形回給 UI 一次，之後丟掉
    pub code: String,
    /// 碼派生的包裝鑰匙 W（存鑰匙圈，契約 §4.4）
    pub wrap: [u8; crypto::KEY_LEN],
    /// W 的 kdf 鹽＝桶裡 RECOVERY 的 `salt`
    pub salt: [u8; crypto::SALT_LEN],
}

/// 產一組新碼、把 `data_key` 封成 `<root>/RECOVERY` 並 **無條件 PUT**（覆蓋＝重生＝舊碼作廢）。
///
/// S-10 式補救：PUT 回 Err 但其實寫成功了（回應掉了）⇒ GET 回來用**這組碼**試拆，拆得出同一把資料鑰匙就當成功。
/// 不這樣做的話主人看到「失敗」、桶裡卻已經是新碼——手上沒有任何一組有效的碼。log 只印物件鍵（鐵則）。
pub(crate) async fn issue_recovery(
    client: &R2Client,
    root: &str,
    data_key: &[u8; crypto::KEY_LEN],
) -> Result<Issued, String> {
    let code = generate_code()?;
    let (obj, bytes, wrap, salt) = wrapped_recovery_bytes(root, &code, data_key).await?;
    eprintln!("[sync:recovery] put {obj}");
    if let Err(e) = client.put(&obj, bytes).await {
        let recovered = match client.get_opt(&obj).await {
            Ok(Some(b)) => matches!(unseal_recovery_object(root, &code, &b).await, Ok(k) if &k == data_key),
            _ => false,
        };
        if !recovered {
            return Err(e);
        }
    }
    Ok(Issued { code, wrap, salt })
}

/// 輪替步驟 3.5 的結果（`RotationReport.recovery`；TS 型別 `"rewrapped" | "invalidated" | "none"`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryRewrap {
    /// 這台握有 W、鹽對得上 ⇒ RECOVERY 已改包 K2（**同一組碼照樣有效**）
    Rewrapped,
    /// 這台沒有 W（或 W 已過期）⇒ RECOVERY 已刪除，主人要重新產生
    Invalidated,
    /// 桶裡本來就沒有 RECOVERY（或這趟不是走到 3.5 的那一趟）
    None,
}

/// 步驟 3.5 的判準（純函式，單測直接餵位元組）：這台鑰匙圈的 W＋鹽能不能用來重包桶裡這顆 RECOVERY？
/// 三條都要成立：鹽＝物件的 `salt`（不同＝別台重生過）、W 拆得開、拆出來的是 K1 或 K2（不是別份資料的鑰匙）。
pub(crate) fn usable_wrap(
    root: &str,
    bytes: &[u8],
    wrap_b64: Option<&str>,
    salt_b64: Option<&str>,
    old_key: &[u8; crypto::KEY_LEN],
    new_key: &[u8; crypto::KEY_LEN],
) -> Option<([u8; crypto::KEY_LEN], Vec<u8>)> {
    let wk = crypto::parse_wrapped_key(bytes).ok()?;
    let (w, s) = (wrap_b64?, salt_b64?);
    if wk.salt != s {
        return None;
    }
    let wrap = crypto::key_from_b64(w).ok()?;
    let opened = crypto::unwrap_data_key(&wrap, &recovery_object_key(root), bytes).ok()?;
    if &opened != old_key && &opened != new_key {
        return None;
    }
    Some((wrap, crypto::b64_decode(s).ok()?))
}

/// 換鑰匙步驟 3.5（契約 §4.5）：KEY 已換成 K2（提交點之後）、切紀元之前，處理 `<root>/RECOVERY`。
///
/// * 桶裡沒有 ⇒ `None`（跳過）。
/// * 這台鑰匙圈有 W、鹽＝物件的 `salt`、而且 W 真的拆得開這顆（拆出 K1 或 K2——續跑時可能已經是 K2）
///   ⇒ 用 W 重包 K2、PUT（鹽照舊、nonce 新；再做一次無害＝冪等）⇒ `Rewrapped`。
/// * 其餘（沒有 W、鹽不同＝別台重生過、W 拆不開、物件壞了）⇒ DELETE（冪等）⇒ `Invalidated`。
///   **不能留著**：它包的是 K1，而 K1 這一步之後就作廢了——留著等於讓舊碼繼續解出一把舊鑰匙
///   （`ensure_rescue_current` 會擋，但物件本身就該消失，`recovery_set` 也才說得準）。
///
/// 鑰匙圈／`sync_meta.recovery_set` 由呼叫端依回傳值更新（這支不吃 AppHandle，整合測打得到）。
pub(crate) async fn rewrap_after_rotation(
    client: &R2Client,
    root: &str,
    wrap_b64: Option<&str>,
    salt_b64: Option<&str>,
    old_key: &[u8; crypto::KEY_LEN],
    new_key: &[u8; crypto::KEY_LEN],
) -> Result<RecoveryRewrap, String> {
    let obj = recovery_object_key(root);
    let Some(bytes) = client.get_opt(&obj).await? else {
        return Ok(RecoveryRewrap::None);
    };
    match usable_wrap(root, &bytes, wrap_b64, salt_b64, old_key, new_key) {
        Some((wrap, salt)) => {
            let fresh = rewrap_recovery_bytes(root, &wrap, &salt, new_key)?;
            eprintln!("[sync:rotate] rewrap {obj}");
            client.put(&obj, fresh).await?;
            Ok(RecoveryRewrap::Rewrapped)
        }
        None => {
            eprintln!("[sync:rotate] delete {obj} (no recovery wrap key on this device)");
            client.delete(&obj).await?;
            Ok(RecoveryRewrap::Invalidated)
        }
    }
}

/// join 的用碼路（契約 §4.6 ④⑤）：從 `<root>/RECOVERY` 拆出資料鑰匙。`code` 已過 `normalize`。
///
/// 順序：桶空 ⇒ `CLOUD_EMPTY`；沒有 RECOVERY ⇒ `NOT_SET`；拆不開 ⇒ `REVOKED`。
/// 拆得開**還不夠**——呼叫端解出紀元之後要再過 `ensure_rescue_current`（換鑰匙的那台若是 v1.1.4、或步驟 3.5 還沒跑到，
/// RECOVERY 可能還包著已作廢的 K1）。
pub(crate) async fn rescue_data_key(
    root: &str,
    code: &str,
    cloud_empty: bool,
    recovery_object: Option<&[u8]>,
) -> Result<[u8; crypto::KEY_LEN], String> {
    if cloud_empty {
        return Err(CLOUD_EMPTY.into());
    }
    let Some(bytes) = recovery_object else {
        return Err(NOT_SET.into());
    };
    unseal_recovery_object(root, code, bytes).await
}

/// 用碼拆出來的鑰匙是不是**現役**的（WP-A 自決；契約 §4.6 沒寫，但少了會分裂血統）：
///   * 桶裡有數字紀元、這把鑰匙卻一個都拆不開 ⇒ 舊鑰匙（換過鑰匙、舊紀元已掃掉）；
///   * 有比目前紀元新、帶 `ROTATED` 旗標、這把拆不開的紀元 ⇒ 別台換過鑰匙（掃地工還沒掃到）。
///
/// 兩種都回 `REVOKED`。不擋的話 join 會判成「雲端沒資料」而用 K1 **開第三個紀元**，或拉一個已經作廢的舊紀元。
/// 正規（密語）路不需要這道：KEY 永遠包著現役鑰匙；RECOVERY 則可能被 v1.1.4 的輪替遺忘。
pub(crate) async fn ensure_rescue_current(
    client: &R2Client,
    root: &str,
    key: &[u8; crypto::KEY_LEN],
    current_epoch: Option<&str>,
    has_epochs: bool,
) -> Result<(), String> {
    if current_epoch.is_none() && has_epochs {
        return Err(REVOKED.into());
    }
    if super::engine::rotated_elsewhere(client, root, key, current_epoch)
        .await?
        .is_some()
    {
        return Err(REVOKED.into());
    }
    Ok(())
}

/// 產生（或重新產生）復原碼：契約 §4.3 的順序——守門 → 產碼 → 封 RECOVERY（PUT 覆蓋＝舊碼作廢）→
/// 鑰匙圈存 W＋鹽 → `sync_meta.recovery_set='1'` → 回顯示形（**只回這一次**）。
///
/// 守門（任何一條不過＝Err、本機與桶零改變）：沒在換鑰匙；`BusyGuard`；鑰匙圈在＋`guard_sandbox_root`（`keyed_client`）；
/// 已加入；沒有任何鍵違い（`locked` 非空——`rotated` 講出路、`stale`／`salt` 請先處理狀態；WP-A 比契約多擋兩種：
/// `salt` 是別的血統、`stale` 是雲端有這台拆不開的東西，兩種都不該把這台的鑰匙封上桶）；
/// `rotated_elsewhere(...) == None`（否則會把已作廢的 K1 包進 RECOVERY、還把別台剛重包好的那顆蓋掉）。
pub async fn set_recovery(app: &AppHandle) -> Result<RecoveryReport, String> {
    use super::engine::{self, BusyGuard, SyncState};
    engine::guard_not_rotating(app)?;
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = engine::pool(app).await?;
    let kc = engine::keyed_client(app, &pool).await?;
    let meta = engine::meta_all(&pool).await?;
    if meta.get("joined").map(String::as_str) != Some("1") {
        return Err("這台還沒加入同步。".into());
    }
    if meta.get("locked").is_some_and(|v| !v.is_empty()) {
        if meta.get("locked_reason").map(String::as_str) == Some("rotated") {
            return Err(ROTATED_ELSEWHERE.into());
        }
        return Err("先處理同步頁上的狀態再產生復原碼。".into());
    }
    if engine::rotated_elsewhere(&kc.client, &kc.root, &kc.data_key, kc.epoch.as_deref())
        .await?
        .is_some()
    {
        return Err(ROTATED_ELSEWHERE.into());
    }

    let issued = issue_recovery(&kc.client, &kc.root, &kc.data_key).await?;

    // 碼已經可用了；鑰匙圈存不進去只代表「這台換鑰匙時不能重包」（會改成作廢），不該讓主人以為沒產成
    let mut creds = kc.creds.clone();
    creds.recovery_wrap_b64 = Some(crypto::b64_encode(&issued.wrap));
    creds.recovery_salt_b64 = Some(crypto::b64_encode(&issued.salt));
    if let Err(e) = credstore::save(app, &creds) {
        eprintln!("[sync:recovery] keychain save failed: {e}");
    }
    engine::meta_set(&pool, "recovery_set", "1").await?;
    Ok(RecoveryReport {
        code_display: format_for_display(&issued.code),
    })
}

/// 作廢：DELETE `<root>/RECOVERY`、鑰匙圈清 W＋鹽、`sync_meta.recovery_set='0'`。桶裡本來就沒有＝成功（冪等）。
/// 守門同 `set_recovery`，但不看鍵違い、不需要 `rotated_elsewhere`——刪掉永遠安全。
pub async fn clear_recovery(app: &AppHandle) -> Result<(), String> {
    use super::engine::{self, BusyGuard, SyncState};
    engine::guard_not_rotating(app)?;
    let Some(st) = app.try_state::<SyncState>() else {
        return Err("同步模組還沒初始化。".into());
    };
    let Some(_busy) = BusyGuard::acquire(&st.busy) else {
        return Err("同步正在進行中，請稍候再試。".into());
    };
    let pool = engine::pool(app).await?;
    let kc = engine::keyed_client(app, &pool).await?;
    let obj = recovery_object_key(&kc.root);
    eprintln!("[sync:recovery] delete {obj}");
    kc.client.delete(&obj).await?;
    if kc.creds.recovery_wrap_b64.is_some() || kc.creds.recovery_salt_b64.is_some() {
        let mut creds = kc.creds.clone();
        creds.recovery_wrap_b64 = None;
        creds.recovery_salt_b64 = None;
        if let Err(e) = credstore::save(app, &creds) {
            eprintln!("[sync:recovery] keychain save failed: {e}");
        }
    }
    engine::meta_set(&pool, "recovery_set", "0").await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 碼往返_正規形_顯示形() {
        let code = generate_code().unwrap();
        assert_eq!(code.chars().count(), CODE_LEN);
        assert!(code.bytes().all(|b| alphabet_index(b).is_some()), "只有 Base32 字集");
        let shown = format_for_display(&code);
        assert_eq!(shown.len(), CODE_LEN + 5, "27 字＋5 個連字號");
        assert_eq!(shown.split('-').map(str::len).collect::<Vec<_>>(), vec![5, 5, 5, 5, 5, 2]);
        assert_eq!(normalize(&shown).unwrap(), code, "顯示形要能還原成正規形");
        assert_eq!(normalize(&shown.to_lowercase()).unwrap(), code, "大小寫不分");
        assert_eq!(normalize(&format!("  {} ", shown.replace('-', " "))).unwrap(), code, "空白當連字號");
        // 主體要能還原成原始位元組（碼的熵就在這 16B）
        let raw = decode_body(&code[..CODE_BODY_LEN]).unwrap();
        assert_eq!(encode_from_bytes(&raw), code);
    }

    #[test]
    fn 全形_零寬_日文分隔符都認得() {
        // 工程評審 S-3：手機日文／中文 IME 打出來的寫法
        let code = encode_from_bytes(&[0x5au8; CODE_BYTES]);
        let shown = format_for_display(&code);
        let fullwidth: String = shown
            .chars()
            .map(|c| if c.is_ascii_graphic() { char::from_u32(c as u32 + 0xFEE0).unwrap() } else { c })
            .collect();
        assert_eq!(normalize(&fullwidth).unwrap(), code, "全形英數＋全形連字號");
        assert_eq!(normalize(&shown.replace('-', "ー")).unwrap(), code, "長音符當連字號");
        assert_eq!(normalize(&shown.replace('-', "・")).unwrap(), code, "中點當連字號");
        assert_eq!(normalize(&shown.replace('-', "\u{2212}")).unwrap(), code, "減號當連字號");
        assert_eq!(
            normalize(&format!("\u{FEFF}{}\u{200B}", shown.replace('-', "\u{3000}"))).unwrap(),
            code,
            "零寬字元與全形空白"
        );
        // 真的不認得的字仍然講得出是哪一個
        let bad = format!("{}0", &code[..CODE_LEN - 1]);
        assert!(normalize(&bad).unwrap_err().contains('0'));
    }

    #[test]
    fn 已知向量_base32_無padding() {
        // RFC 4648 的字集；16 個 0x00 ⇒ 26 個 A；16 個 0xff ⇒ 25 個 7 加最後一字 "4"（3 個 1 位＋2 個零填充＝11100）
        assert_eq!(encode_body(&[0u8; 16]), "A".repeat(26));
        assert_eq!(encode_body(&[0xffu8; 16]), format!("{}4", "7".repeat(25)));
        assert_eq!(decode_body(&"A".repeat(26)).unwrap(), [0u8; 16]);
        assert_eq!(decode_body(&format!("{}4", "7".repeat(25))).unwrap(), [0xffu8; 16]);
    }

    #[test]
    fn 校驗碼抓得到抄錯一字() {
        // WP-A：原本用一組**隨機**碼、要求 27 種抄錯至少抓 24 種——主體 25 個位置各有 1/32 漏網，
        // 漏 ≥4 的機率約 1%（不是註解寫的 1e-4），實測閃紅過一次。改成**固定的 64 組碼**（確定性、不閃）、
        // 每組 27 個位置 × 3 種換字，合計 5184 種抄錯：期望漏網約 25×3×64/32 ≈ 150 種，門檻抓到 ≥ 95%。
        let mut total = 0;
        let mut caught = 0;
        for seed in 0u8..64 {
            let raw: [u8; CODE_BYTES] = std::array::from_fn(|i| seed.wrapping_mul(37).wrapping_add((i as u8).wrapping_mul(101)));
            let code = encode_from_bytes(&raw);
            for pos in 0..CODE_LEN {
                for delta in [1u8, 7, 16] {
                    let mut t = code.as_bytes().to_vec();
                    let cur = alphabet_index(t[pos]).unwrap();
                    t[pos] = ALPHABET[((cur + delta) % 32) as usize];
                    total += 1;
                    if normalize(&String::from_utf8(t).unwrap()).is_err() {
                        caught += 1;
                    }
                }
            }
        }
        assert!(caught * 100 >= total * 95, "{total} 種單字抄錯只抓到 {caught} 種");
        // 校驗碼本身被改一定抓到
        let code = generate_code().unwrap();
        let bytes = code.as_bytes();
        let mut t = bytes.to_vec();
        let last = CODE_LEN - 1;
        t[last] = ALPHABET[((alphabet_index(t[last]).unwrap() + 1) % 32) as usize];
        let e = normalize(&String::from_utf8(t).unwrap()).unwrap_err();
        assert!(e.contains("校驗碼"), "{e}");
    }

    #[test]
    fn 長度與字集的人話() {
        assert!(normalize("").unwrap_err().contains("請輸入"));
        let short = normalize("ABCDE-FGHIJ").unwrap_err();
        assert!(short.contains("27") && short.contains("10"), "{short}");
        let mut bad = "A".repeat(26);
        bad.push('0');
        let e = normalize(&bad).unwrap_err();
        assert!(e.contains("第 27 個字「0」"), "{e}");
        let e = normalize(&format!("{}1", "A".repeat(26))).unwrap_err();
        assert!(e.contains("「1」"), "{e}");
    }

    #[test]
    fn 校驗碼是確定的_且與主體綁定() {
        let a = encode_from_bytes(&[7u8; 16]);
        let b = encode_from_bytes(&[7u8; 16]);
        assert_eq!(a, b);
        let c = encode_from_bytes(&[8u8; 16]);
        assert_ne!(&a[..CODE_BODY_LEN], &c[..CODE_BODY_LEN]);
    }

    #[test]
    fn 重包不需要碼_同一把包裝鑰匙就拆得開() {
        // 純同步版：不經 spawn_blocking（那要 tauri runtime），直接用 crypto 層驗「W＋鹽固定、nonce 換、資料鑰匙換」
        let data_key_1 = [1u8; crypto::KEY_LEN];
        let data_key_2 = [2u8; crypto::KEY_LEN];
        let salt = [5u8; crypto::SALT_LEN];
        let wrap = crypto::derive_key("ABCDEFGHIJKLMNOPQRSTUVWXYZ2", &salt).unwrap();
        let obj = recovery_object_key("v1-sb-x");
        let first = crypto::wrap_data_key(&wrap, &obj, &data_key_1, &salt).unwrap();
        let again = rewrap_recovery_bytes("v1-sb-x", &wrap, &salt, &data_key_2).unwrap();
        assert_eq!(crypto::unwrap_data_key(&wrap, &obj, &first).unwrap(), data_key_1);
        assert_eq!(crypto::unwrap_data_key(&wrap, &obj, &again).unwrap(), data_key_2, "換鑰匙後同一組碼仍拆得出 K2");
        assert!(crypto::unwrap_data_key(&wrap, "v1-sb-x/KEY", &again).is_err(), "AAD 綁物件鍵");
    }

    #[test]
    fn 步驟35判準_鹽對包裝鑰匙對資料鑰匙對才重包_其餘作廢() {
        let root = "v1-sb-0925-unit";
        let (k1, k2, k_other) = ([1u8; 32], [2u8; 32], [9u8; 32]);
        let salt = [5u8; crypto::SALT_LEN];
        let code = encode_from_bytes(&[3u8; CODE_BYTES]);
        let wrap = crypto::derive_key(&code, &salt).unwrap();
        let (w_b64, s_b64) = (crypto::b64_encode(&wrap), crypto::b64_encode(&salt));
        let obj_k1 = crypto::wrap_data_key(&wrap, &recovery_object_key(root), &k1, &salt).unwrap();

        // 產碼那一台（W＋鹽都在、拆出 K1）⇒ 可重包；重包後同一組 W 拆出 K2
        let (w, s) = usable_wrap(root, &obj_k1, Some(&w_b64), Some(&s_b64), &k1, &k2).expect("產碼那台能重包");
        let obj_k2 = rewrap_recovery_bytes(root, &w, &s, &k2).unwrap();
        assert_eq!(crypto::unwrap_data_key(&wrap, &recovery_object_key(root), &obj_k2).unwrap(), k2);
        assert_eq!(crypto::parse_wrapped_key(&obj_k2).unwrap().salt, s_b64, "鹽照舊");
        assert_ne!(
            crypto::parse_wrapped_key(&obj_k2).unwrap().nonce,
            crypto::parse_wrapped_key(&obj_k1).unwrap().nonce,
            "nonce 換新"
        );
        // 續跑（桶裡已經是 K2）仍判得過＝冪等
        assert!(usable_wrap(root, &obj_k2, Some(&w_b64), Some(&s_b64), &k1, &k2).is_some());

        // 沒有 W（別台）⇒ 作廢
        assert!(usable_wrap(root, &obj_k1, None, None, &k1, &k2).is_none());
        // 鹽不同（別台重生過碼，這台的 W 是舊的）⇒ 作廢
        let other_salt = crypto::b64_encode(&[6u8; crypto::SALT_LEN]);
        assert!(usable_wrap(root, &obj_k1, Some(&w_b64), Some(&other_salt), &k1, &k2).is_none());
        // 鹽相同但 W 不對（理論上不會發生）⇒ 作廢
        let bad_w = crypto::b64_encode(&[7u8; 32]);
        assert!(usable_wrap(root, &obj_k1, Some(&bad_w), Some(&s_b64), &k1, &k2).is_none());
        // 拆得開、但包的是別份資料的鑰匙 ⇒ 作廢（不把陌生鑰匙換成 K2）
        let obj_other = crypto::wrap_data_key(&wrap, &recovery_object_key(root), &k_other, &salt).unwrap();
        assert!(usable_wrap(root, &obj_other, Some(&w_b64), Some(&s_b64), &k1, &k2).is_none());
        // 物件壞了 ⇒ 作廢
        assert!(usable_wrap(root, b"not json", Some(&w_b64), Some(&s_b64), &k1, &k2).is_none());
        // 別的根的物件（AAD 不同）⇒ 作廢
        assert!(usable_wrap("v1-sb-other", &obj_k1, Some(&w_b64), Some(&s_b64), &k1, &k2).is_none());
    }

    #[test]
    fn 人話_抄錯與填充位都是同一句_且不含碼值() {
        let code = encode_from_bytes(&[0x42u8; CODE_BYTES]);
        // 動第 26 個字（主體最後一字）的低 2 位＝填充位非零
        let mut t = code.clone().into_bytes();
        let cur = alphabet_index(t[CODE_BODY_LEN - 1]).unwrap();
        t[CODE_BODY_LEN - 1] = ALPHABET[(cur ^ 0b01) as usize];
        let e = normalize(&String::from_utf8(t).unwrap()).unwrap_err();
        assert_eq!(e, TYPO);
        assert!(!e.contains(&code[..5]), "錯誤訊息不帶碼值");
        // 小寫＋連字號＋前後空白都認得
        assert_eq!(normalize(&format!(" {} ", format_for_display(&code).to_lowercase())).unwrap(), code);
    }
}
