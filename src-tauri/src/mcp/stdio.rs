//! `私鐵手帳.exe --mcp-stdio`：stdin 的 JSON-RPC（一行一則）轉 POST 到本機 HTTP，回應逐則寫回 stdout（D-主-91）。
//!
//! Claude 桌面版的一般聊天只吃 stdio（查證 `2026-10-25-MCP接口-ClaudeDesktop本機HTTP查證.md`），網址與金鑰照 MCP 規格
//! 從環境變數取：`NS_MCP_URL`（預設正式版 `http://127.0.0.1:18920/mcp`）、`NS_MCP_TOKEN`。`main.rs` 在進 Tauri 之前分流，
//! 不會碰單一執行個體外掛；GUI 子系統 exe 被管線啟動時 stdio 照常可用（spike 第 3 題）。
//!
//! 比 spike 多做的：
//!   * stdin 關掉（EOF）後等所有飛行中的請求做完才退出，最後 DELETE 掉 session
//!   * 同時處理 JSON 與 SSE（rmcp 預設 legacy session 模式走 SSE），SSE 邊收邊寫
//!   * 記 `mcp-session-id`／`mcp-protocol-version`；App 重開過（舊 session 404）就用記下的 initialize 自己重連一次
//!   * 連不上、金鑰錯：對有 id 的請求回 JSON-RPC error（模型看得到原因），通知則靜默

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::task::JoinSet;

use super::lock;

pub const DEFAULT_URL: &str = "http://127.0.0.1:18920/mcp";
const UNREACHABLE: &str = "連不上私鐵手帳：App 沒開？";

/// 回傳行程結束碼（`main.rs` 直接 `std::process::exit`）
pub fn run_stdio_bridge() -> i32 {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[mcp-stdio] 建不起 runtime：{e}");
            return 2;
        }
    };
    let code = rt.block_on(bridge_main());
    // stdin 的讀取跑在 blocking 執行緒；EOF 後已結束，這裡只是保險不讓收尾卡住
    rt.shutdown_timeout(Duration::from_secs(1));
    code
}

async fn bridge_main() -> i32 {
    let url = std::env::var("NS_MCP_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.to_string());
    let token = std::env::var("NS_MCP_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string();
    let client = match reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(90))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[mcp-stdio] 建不起 HTTP 客戶端：{e}");
            return 2;
        }
    };
    let link = Arc::new(Link {
        client,
        url,
        token,
        session: Mutex::new(Session::default()),
        reinit: tokio::sync::Mutex::new(()),
        out: tokio::sync::Mutex::new(tokio::io::stdout()),
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut tasks = JoinSet::new();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let l = link.clone();
                // initialize 要先拿到 session 才能送後面的請求（沙盒 F3：一次灌三行，tools/call 回 400「Session ID is required」）：
                // 它就地等完、讀下一行之前 session 已經記下；其他請求照舊併發
                if is_initialize(&line) {
                    while tasks.join_next().await.is_some() {}
                    l.handle(line).await;
                } else {
                    tasks.spawn(async move { l.handle(line).await });
                }
                while tasks.try_join_next().is_some() {}
            }
            Ok(None) => break,
            Err(e) => {
                eprintln!("[mcp-stdio] 讀 stdin 失敗：{e}");
                break;
            }
        }
    }
    // EOF：飛行中的請求做完、回應寫出去才走
    while tasks.join_next().await.is_some() {}
    link.close().await;
    0
}

#[derive(Default, Clone)]
struct Session {
    sid: Option<String>,
    version: Option<String>,
    /// 客戶端送的 initialize 原文（App 重開過要重連時重送）
    init: Option<String>,
}

struct Link {
    client: reqwest::Client,
    url: String,
    token: String,
    session: Mutex<Session>,
    /// 重連只做一次（多個請求同時撞到 404 時排隊）
    reinit: tokio::sync::Mutex<()>,
    out: tokio::sync::Mutex<tokio::io::Stdout>,
}

enum Outcome {
    /// 收到回應（可能是空的 202）
    Done,
    /// 帶著的 session 已經不在（App 重開過）；附當時帶的 id
    SessionGone(Option<String>),
    Http(u16, String),
    Net(reqwest::Error),
}

impl Link {
    async fn handle(self: Arc<Self>, line: String) {
        let msg: Option<Value> = serde_json::from_str(&line).ok();
        let id = msg
            .as_ref()
            .and_then(|v| v.get("id"))
            .filter(|v| !v.is_null())
            .cloned();
        let method = msg
            .as_ref()
            .and_then(|v| v.get("method"))
            .and_then(|m| m.as_str())
            .map(str::to_string);
        let is_init = method.as_deref() == Some("initialize");
        if is_init {
            let mut s = lock(&self.session);
            s.sid = None;
            s.version = None;
            s.init = Some(line.clone());
        }

        let mut outcome = self.post(line.clone(), true).await;
        let gone = match &outcome {
            Outcome::SessionGone(old) if !is_init => Some(old.clone()),
            _ => None,
        };
        if let Some(old) = gone {
            if self.reinit(old).await {
                outcome = self.post(line, true).await;
            }
        }
        let err = match outcome {
            Outcome::Done => return,
            Outcome::SessionGone(_) => {
                "私鐵手帳重新開過，連線沒能自動接回：請重新啟動 Claude。".to_string()
            }
            Outcome::Http(401, _) => {
                "連線金鑰不對：請到私鐵手帳 設定 › 外部助理 重新複製設定。".to_string()
            }
            Outcome::Http(code, body) => format!(
                "私鐵手帳回應錯誤（HTTP {code}）：{}",
                clip(body.trim(), 200)
            ),
            Outcome::Net(e) if e.is_connect() => UNREACHABLE.to_string(),
            Outcome::Net(e) if e.is_timeout() => "私鐵手帳太久沒有回應。".to_string(),
            Outcome::Net(e) => format!("跟私鐵手帳的連線中斷了（{e}）。"),
        };
        // 只有「請求」要回錯（通知沒有 id；客戶端回給伺服器的 response 沒有 method）
        if let (Some(id), Some(_)) = (id, method) {
            self.write(
                &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": err } }),
            )
            .await;
        }
    }

    /// POST 一則；`emit`＝回應要不要寫到 stdout（重連時的 initialize 不寫）
    async fn post(&self, body: String, emit: bool) -> Outcome {
        let snap = lock(&self.session).clone();
        let mut req = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("authorization", format!("Bearer {}", self.token))
            .body(body);
        if let Some(s) = &snap.sid {
            req = req.header("mcp-session-id", s);
        }
        if let Some(v) = &snap.version {
            req = req.header("mcp-protocol-version", v);
        }
        let mut resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return Outcome::Net(e),
        };
        let status = resp.status();
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            lock(&self.session).sid = Some(sid.to_string());
        }
        let is_sse = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim_start().starts_with("text/event-stream"))
            .unwrap_or(false);

        if is_sse {
            let mut parser = SseParser::default();
            let mut got = false;
            loop {
                match resp.chunk().await {
                    Ok(Some(chunk)) => {
                        for data in parser.push(&chunk) {
                            got |= self.forward(&data, emit).await;
                        }
                    }
                    Ok(None) => break,
                    // 已經轉出東西就算數（串流尾巴斷掉）；什麼都沒收到才當連線錯
                    Err(e) if !got => return Outcome::Net(e),
                    Err(_) => break,
                }
            }
            for data in parser.finish() {
                self.forward(&data, emit).await;
            }
            return Outcome::Done;
        }

        let text = match resp.text().await {
            Ok(t) => t,
            Err(e) => return Outcome::Net(e),
        };
        let trimmed = text.trim();
        // 錯誤狀態碼但本體是 JSON-RPC（例如參數錯；新版協定的 method not found 也是 404＋JSON-RPC）：照轉，模型看得到
        let rpc = is_rpc(trimmed);
        // 帶著 session 卻 404、本體又不是 JSON-RPC＝session 不在了（App 重開過）
        if status == reqwest::StatusCode::NOT_FOUND && snap.sid.is_some() && !rpc {
            return Outcome::SessionGone(snap.sid);
        }
        if trimmed.is_empty() {
            return if status.is_success() {
                Outcome::Done
            } else {
                Outcome::Http(status.as_u16(), String::new())
            };
        }
        if status.is_success() || rpc {
            self.forward(trimmed, emit).await;
            Outcome::Done
        } else {
            Outcome::Http(status.as_u16(), text)
        }
    }

    /// 一則訊息：記下協定版本、（需要時）寫 stdout。回 false＝不是 JSON（丟掉）
    async fn forward(&self, raw: &str, emit: bool) -> bool {
        let Ok(v) = serde_json::from_str::<Value>(raw) else {
            eprintln!("[mcp-stdio] 收到不是 JSON 的回應，略過");
            return false;
        };
        if let Some(ver) = v
            .pointer("/result/protocolVersion")
            .and_then(|x| x.as_str())
        {
            if v.pointer("/result/serverInfo").is_some() {
                lock(&self.session).version = Some(ver.to_string());
            }
        }
        if emit {
            self.write(&v).await;
        }
        true
    }

    /// App 重開過：用記下的 initialize 換一個新 session。別人已經換好了就直接用
    async fn reinit(&self, failed: Option<String>) -> bool {
        let _turn = self.reinit.lock().await;
        let (cur, init) = {
            let s = lock(&self.session);
            (s.sid.clone(), s.init.clone())
        };
        if cur != failed {
            return cur.is_some();
        }
        let Some(init) = init else {
            return false;
        };
        {
            let mut s = lock(&self.session);
            s.sid = None;
            s.version = None;
        }
        let ok = matches!(self.post(init, false).await, Outcome::Done);
        if !ok || lock(&self.session).sid.is_none() {
            return false;
        }
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
        matches!(self.post(note, false).await, Outcome::Done)
    }

    async fn write(&self, v: &Value) {
        let mut line = v.to_string();
        line.push('\n');
        let mut o = self.out.lock().await;
        let _ = o.write_all(line.as_bytes()).await;
        let _ = o.flush().await;
    }

    /// 收尾：DELETE session（盡力就好）
    async fn close(&self) {
        let sid = lock(&self.session).sid.clone();
        let Some(sid) = sid else {
            return;
        };
        let _ = self
            .client
            .delete(&self.url)
            .header("authorization", format!("Bearer {}", self.token))
            .header("mcp-session-id", sid)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
    }
}

/// 這一行是不是 initialize 請求（解析失敗＝不是）
fn is_initialize(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|v| v.get("method").and_then(|m| m.as_str()).map(|m| m == "initialize"))
        .unwrap_or(false)
}

fn is_rpc(s: &str) -> bool {
    serde_json::from_str::<Value>(s)
        .map(|v| v.get("jsonrpc").is_some() || v.is_array())
        .unwrap_or(false)
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// SSE 解析（只取 `data:`；`id:`／`event:`／`retry:`／註解都不管）。chunk 可以切在任何位元組
#[derive(Default)]
pub(crate) struct SseParser {
    line: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in chunk {
            if b == b'\n' {
                let raw = std::mem::take(&mut self.line);
                self.on_line(&raw, &mut out);
            } else {
                self.line.push(b);
            }
        }
        out
    }

    pub(crate) fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.line.is_empty() {
            let raw = std::mem::take(&mut self.line);
            self.on_line(&raw, &mut out);
        }
        self.dispatch(&mut out);
        out
    }

    fn on_line(&mut self, raw: &[u8], out: &mut Vec<String>) {
        let mut line = String::from_utf8_lossy(raw).into_owned();
        if line.ends_with('\r') {
            line.pop();
        }
        if line.is_empty() {
            self.dispatch(out);
        } else if let Some(rest) = line.strip_prefix("data:") {
            self.data
                .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
    }

    fn dispatch(&mut self, out: &mut Vec<String>) {
        if self.data.is_empty() {
            return;
        }
        let d = self.data.join("\n");
        self.data.clear();
        if !d.trim().is_empty() {
            out.push(d);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 認得_initialize() {
        assert!(is_initialize(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#));
        assert!(!is_initialize(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}"#));
        assert!(!is_initialize("不是 JSON"));
    }

    #[test]
    fn sse_切在任何地方都拼得回來() {
        let body = "id: 0\nretry: 3000\ndata: \n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"x\":\"一二\"}}\r\n\r\n: ping\n\ndata: {\"a\":\ndata: 1}\n\n";
        let bytes = body.as_bytes();
        for cut in 0..bytes.len() {
            let mut p = SseParser::default();
            let mut got = p.push(&bytes[..cut]);
            got.extend(p.push(&bytes[cut..]));
            got.extend(p.finish());
            assert_eq!(got.len(), 2, "cut={cut}");
            assert_eq!(
                got[0],
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"x\":\"一二\"}}"
            );
            assert_eq!(got[1], "{\"a\":\n1}");
            assert!(serde_json::from_str::<Value>(&got[1]).is_ok());
        }
    }

    #[test]
    fn sse_最後沒有空行也送出() {
        let mut p = SseParser::default();
        assert!(p.push(b"data: {\"id\":2}").is_empty());
        assert_eq!(p.finish(), vec!["{\"id\":2}".to_string()]);
    }

    /// 連不上：有 id 的請求回 JSON-RPC error（埠 1 一定沒人聽）
    #[tokio::test]
    async fn 連不上回錯誤() {
        let link = Arc::new(Link {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            url: "http://127.0.0.1:1/mcp".into(),
            token: "t".into(),
            session: Mutex::new(Session::default()),
            reinit: tokio::sync::Mutex::new(()),
            out: tokio::sync::Mutex::new(tokio::io::stdout()),
        });
        match link
            .post(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.into(), false)
            .await
        {
            Outcome::Net(e) => assert!(e.is_connect(), "{e}"),
            _ => panic!("應該連不上"),
        }
    }
}
