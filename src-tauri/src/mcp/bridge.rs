//! Rust → WebView 的轉接（契約 §3；D-主-90）。
//!
//! `tools/call` 通過開關之後：記一筆等待（id → oneshot）、`emit_to("main", "mcp:call", {id, tool, args, access})`，
//! 等 WebView 的 `mcp_reply`（30 秒逾時）。WebView 重新載入時（`mcp_register_tools` 再來一次）把還在等的全部放掉。
//! 本檔不碰 Tauri：送事件的那一步由呼叫端傳進來（`server.rs` 給真的 emit，測試給假的）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::config::AccessMap;
use super::lock;

pub const CALL_EVENT: &str = "mcp:call";
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// 送給 WebView 的那一包
#[derive(Serialize, Clone, Debug)]
pub struct CallEvent {
    pub id: String,
    pub tool: String,
    pub args: serde_json::Value,
    /// 這次呼叫當下的五個開關（TS `McpCtx.access`）
    pub access: AccessMap,
}

/// WebView 回來的那一包（`mcp_reply` 的參數）
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub id: String,
    /// false＝App 內部錯誤（handler 丟了非 McpUserError 的例外）
    pub ok: bool,
    /// 給模型讀的全文（摘要＋JSON）
    pub text: String,
    /// true＝助理可以自己修正的錯（參數不對、找不到、規則不允許）
    #[serde(default)]
    pub is_error: bool,
    /// 這次有寫入（成功時記進最近紀錄）
    #[serde(default)]
    pub write: bool,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum BridgeError {
    /// 事件送不出去（主視窗不在？）
    Emit(String),
    /// 30 秒內沒回
    Timeout,
    /// WebView 重新載入，等待被放掉
    Dropped,
}

#[derive(Default)]
pub struct Bridge {
    seq: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}

impl Bridge {
    /// `send(id)` 負責把事件送出去；送成功才開始等
    pub async fn call<F>(&self, timeout: Duration, send: F) -> Result<Reply, BridgeError>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        let id = format!("c{}", self.seq.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(id.clone(), tx);
        // 不論怎麼離開（回覆、逾時、送不出去、呼叫被取消而 future 被丟掉）都清掉這一筆
        let _slot = Slot {
            bridge: self,
            id: &id,
        };
        send(&id).map_err(BridgeError::Emit)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(BridgeError::Dropped),
            Err(_) => Err(BridgeError::Timeout),
        }
    }

    /// `mcp_reply`：交回給等的那一個。false＝沒人在等（逾時過了、或 id 不認得）
    pub fn resolve(&self, reply: Reply) -> bool {
        let Some(tx) = lock(&self.pending).remove(&reply.id) else {
            return false;
        };
        tx.send(reply).is_ok()
    }

    /// WebView 重新載入：還在等的全部放掉（各自回 Dropped）
    pub fn fail_all(&self) -> usize {
        let mut map = lock(&self.pending);
        let n = map.len();
        map.clear();
        n
    }
}

/// 等待表裡的一筆；drop 時移除（已被 resolve／fail_all 拿走就是 no-op，id 不重複）
struct Slot<'a> {
    bridge: &'a Bridge,
    id: &'a str,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        lock(&self.bridge.pending).remove(self.id);
    }
}

#[cfg(test)]
impl Bridge {
    fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn reply(id: &str) -> Reply {
        Reply {
            id: id.to_string(),
            ok: true,
            text: "ok".into(),
            is_error: false,
            write: false,
            summary: None,
        }
    }

    #[tokio::test]
    async fn 回覆送到等的那一個() {
        let b = Arc::new(Bridge::default());
        let b2 = b.clone();
        let r = b
            .call(Duration::from_secs(5), move |id| {
                let id = id.to_string();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    assert!(b2.resolve(reply(&id)));
                });
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(r.text, "ok");
        assert_eq!(b.pending_count(), 0);
    }

    #[tokio::test]
    async fn 逾時回錯且清掉等待() {
        let b = Bridge::default();
        let mut seen = String::new();
        let r = b
            .call(Duration::from_millis(50), |id| {
                seen = id.to_string();
                Ok(())
            })
            .await;
        assert_eq!(r, Err(BridgeError::Timeout));
        assert_eq!(b.pending_count(), 0);
        // 逾時之後才回的，沒人收
        assert!(!b.resolve(reply(&seen)));
    }

    /// 助理取消／斷線時 rmcp 可能把 handler 的 future 丟掉：等待也要清掉
    #[tokio::test]
    async fn 呼叫被丟掉也清掉等待() {
        let b = Bridge::default();
        let r = tokio::time::timeout(
            Duration::from_millis(20),
            b.call(Duration::from_secs(5), |_| Ok(())),
        )
        .await;
        assert!(r.is_err());
        assert_eq!(b.pending_count(), 0);
    }

    #[tokio::test]
    async fn 送不出去不留等待() {
        let b = Bridge::default();
        let r = b
            .call(Duration::from_secs(5), |_| Err("no window".into()))
            .await;
        assert_eq!(r, Err(BridgeError::Emit("no window".into())));
        assert_eq!(b.pending_count(), 0);
    }

    #[tokio::test]
    async fn 重新載入放掉等待() {
        let b = Arc::new(Bridge::default());
        let b2 = b.clone();
        let r = b
            .call(Duration::from_secs(5), move |_| {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    assert_eq!(b2.fail_all(), 1);
                });
                Ok(())
            })
            .await;
        assert_eq!(r, Err(BridgeError::Dropped));
    }

    #[test]
    fn reply_的_json_形狀() {
        let r: Reply = serde_json::from_str(
            r#"{"id":"c1","ok":true,"text":"建了 3 張","isError":false,"write":true,"summary":"建立 3 張車票"}"#,
        )
        .unwrap();
        assert!(r.write && r.ok && !r.is_error);
        assert_eq!(r.summary.as_deref(), Some("建立 3 張車票"));
        // 省略的欄位有預設
        let r: Reply = serde_json::from_str(r#"{"id":"c2","ok":false,"text":"boom"}"#).unwrap();
        assert!(!r.write && !r.is_error && r.summary.is_none());
    }
}
