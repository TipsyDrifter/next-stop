//! 127.0.0.1:<埠>/mcp 的 Streamable HTTP（rmcp 3.7＋axum 0.8；寫法照 spike `prototypes/mcp-spike/`）。
//!
//! 門口三關（契約 §3）：
//!   1. axum middleware：有 `Origin` 就 403（瀏覽器才會帶）、`Authorization: Bearer` 與「當下」金鑰定長比較（換金鑰立刻生效）
//!   2. rmcp `allowed_hosts`＝`127.0.0.1:<埠>`／`localhost:<埠>`（擋 DNS rebinding）
//!   3. `call_tool`：開關關著直接回「沒有開放」（不打擾 WebView），開著才經 `bridge` 轉給主視窗
//! 綁不起來（埠被占用）只記進狀態，App 照常開、不換埠（D-主-93）。

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
        ToolAnnotations,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData as McpError, RoleServer, ServerHandler,
};
use serde_json::{json, Value};

use super::bridge::{BridgeError, CallEvent, CALL_EVENT, CALL_TIMEOUT};
use super::config::{Access, AccessMap};
use super::{McpState, RecentKind, ToolModule, ToolSpec, BLOCKED_EVENT};

/// 送事件給主視窗（App 裡＝`emit_to("main", …)`；測試給假的）
pub type Emit = Arc<dyn Fn(&str, Value) -> Result<(), String> + Send + Sync>;

/// `tools/list` 時 WebView 還沒註冊：等一下再回（剛開 App 就有助理連上）
const LIST_WAIT: Duration = Duration::from_secs(10);
const CALL_WAIT: Duration = Duration::from_secs(5);

const INSTRUCTIONS: &str = "這是使用者的私鐵手帳（Next Stop）：任務（車票）、時刻表、筆記、日記與帳目都在這裡。\
先呼叫 get-overview 看今天的狀況；要一次排好幾張車票，先用 propose-schedule 提案、跟使用者確認後再 apply-schedule。";

const NOT_READY: &str = "App 還在啟動，請稍後再試。";
const TIMEOUT_MSG: &str =
    "私鐵手帳 30 秒內沒有回應（可能還在忙）。如果是寫入，請先查一下有沒有做完，再決定要不要重試。";
const DROPPED_MSG: &str =
    "私鐵手帳剛重新載入，這次呼叫不確定有沒有做完。如果是寫入，請先查一下，再決定要不要重試。";

/* ───────────────────────── 純函式（可測）───────────────────────── */

/// 定長比較：長度不同直接 false（金鑰長度固定，不算洩漏）；相同長度時走完全部位元組
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

fn bearer_value(v: &str) -> Option<&str> {
    let (scheme, rest) = v.trim().split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| rest.trim())
}

/// 門口：有 Origin＝403；金鑰不對或沒帶＝401；空金鑰（設定壞到產不出金鑰）誰都進不來
pub(crate) fn check_headers(headers: &HeaderMap, token: &str) -> Result<(), StatusCode> {
    if headers.contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_value);
    match given {
        Some(g) if !token.is_empty() && ct_eq(g.as_bytes(), token.as_bytes()) => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// 開關把關：總覽＝五個裡任一 ≥ 只看；其他＝該功能 ≥ 工具要的（read < write）
pub(crate) fn allowed(module: ToolModule, need: Access, access: &AccessMap) -> bool {
    match module.module() {
        None => access.any_readable(),
        Some(m) => access.get(m) >= need.max(Access::Read),
    }
}

/// `read_only`＝這個功能開在「只看」、被擋的是寫入（沙盒 F1：只說「沒有開放」會讓人以為開關沒生效）
pub(crate) fn blocked_message(module: ToolModule, read_only: bool) -> String {
    match module.module() {
        Some(m) if read_only => format!(
            "這個功能（{}）只開放「只看」，不能改；要讓助理修改，請到 設定 › 外部助理 改成「可改」。",
            m.label()
        ),
        Some(m) => format!(
            "這個功能（{}）沒有開放給外部助理，請到 設定 › 外部助理 打開。",
            m.label()
        ),
        None => "目前沒有任何功能開放給外部助理，請到 設定 › 外部助理 打開。".to_string(),
    }
}

/// 最近紀錄那一行（短）
fn blocked_summary(module: ToolModule, read_only: bool) -> String {
    match module.module() {
        Some(m) if read_only => format!("只開放只看：{}", m.label()),
        Some(m) => format!("沒有開放：{}", m.label()),
        None => "沒有開放任何功能".to_string(),
    }
}

pub(crate) fn to_rmcp_tool(s: &ToolSpec) -> Tool {
    let mut ann = ToolAnnotations::with_title(s.title.clone())
        .read_only(s.annotations.read_only_hint)
        .destructive(s.annotations.destructive_hint)
        .open_world(s.annotations.open_world_hint);
    if let Some(v) = s.annotations.idempotent_hint {
        ann = ann.idempotent(v);
    }
    Tool::new(
        s.name.clone(),
        s.description.clone(),
        Arc::new(s.input_schema.clone()),
    )
    .with_title(s.title.clone())
    .with_annotations(ann)
}

fn clip(s: &str, n: usize) -> String {
    let mut it = s.chars();
    let head: String = it.by_ref().take(n).collect();
    if it.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn error_result(text: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}

/* ───────────────────────── ServerHandler ───────────────────────── */

#[derive(Clone)]
pub struct NextStopServer {
    state: Arc<McpState>,
    emit: Emit,
}

impl NextStopServer {
    pub fn new(state: Arc<McpState>, emit: Emit) -> Self {
        Self { state, emit }
    }

    /// `tools/call` 的本體（拆出來才測得到，不必造 RequestContext）
    pub(crate) async fn dispatch(&self, name: &str, args: Value) -> CallToolResult {
        let Some(tools) = wait_tools(&self.state, CALL_WAIT).await else {
            return error_result(NOT_READY);
        };
        let Some(spec) = tools.iter().find(|t| t.name == name).cloned() else {
            return error_result(format!("沒有這支工具：{name}"));
        };
        let access = self.state.access();
        if !allowed(spec.module, spec.access, &access) {
            let read_only = spec.module.module().is_some_and(|m| access.get(m) == Access::Read);
            self.state.push_recent(
                RecentKind::Blocked,
                spec.module,
                name,
                blocked_summary(spec.module, read_only),
            );
            if let Err(e) = (self.emit)(
                BLOCKED_EVENT,
                json!({ "module": spec.module, "tool": name, "readOnly": read_only }),
            ) {
                eprintln!("[mcp] 送 {BLOCKED_EVENT} 失敗：{e}");
            }
            return error_result(blocked_message(spec.module, read_only));
        }

        let emit = self.emit.clone();
        let tool = name.to_string();
        let res = self
            .state
            .bridge
            .call(CALL_TIMEOUT, move |id| {
                let ev = CallEvent {
                    id: id.to_string(),
                    tool,
                    args,
                    access,
                };
                let payload = serde_json::to_value(&ev).map_err(|e| e.to_string())?;
                emit(CALL_EVENT, payload)
            })
            .await;

        let module = spec.module;
        match res {
            Ok(r) if r.ok && !r.is_error => {
                if r.write {
                    let summary = r.summary.clone().unwrap_or_else(|| clip(&r.text, 80));
                    self.state
                        .push_recent(RecentKind::Write, module, name, summary);
                }
                CallToolResult::success(vec![ContentBlock::text(r.text)])
            }
            Ok(r) => {
                // isError＝助理自己修得了的錯，不進最近紀錄；ok=false 才是 App 內部錯
                if !r.ok {
                    self.state
                        .push_recent(RecentKind::Error, module, name, clip(&r.text, 80));
                }
                error_result(r.text)
            }
            Err(e) => {
                let msg = match e {
                    BridgeError::Timeout => TIMEOUT_MSG.to_string(),
                    BridgeError::Dropped => DROPPED_MSG.to_string(),
                    BridgeError::Emit(e) => {
                        format!("私鐵手帳的主視窗沒有回應（{e}），請確認 App 開著再試一次。")
                    }
                };
                self.state
                    .push_recent(RecentKind::Error, module, name, clip(&msg, 80));
                error_result(msg)
            }
        }
    }
}

async fn wait_tools(state: &McpState, max: Duration) -> Option<Arc<Vec<ToolSpec>>> {
    let deadline = tokio::time::Instant::now() + max;
    loop {
        if let Some(t) = state.tools() {
            return Some(t);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

impl ServerHandler for NextStopServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("next-stop", env!("CARGO_PKG_VERSION")).with_title("私鐵手帳"),
            )
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let tools = wait_tools(&self.state, LIST_WAIT)
            .await
            .map(|t| t.iter().map(to_rmcp_tool).collect::<Vec<_>>())
            .unwrap_or_default();
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let args = request
            .arguments
            .map(Value::Object)
            .unwrap_or_else(|| json!({}));
        Ok(self.dispatch(&request.name, args).await.into())
    }
}

/* ───────────────────────── HTTP ───────────────────────── */

async fn gate(State(state): State<Arc<McpState>>, req: Request, next: Next) -> Response {
    let verdict = check_headers(req.headers(), &state.token());
    match verdict {
        Ok(()) => next.run(req).await,
        Err(StatusCode::FORBIDDEN) => (StatusCode::FORBIDDEN, "origin not allowed").into_response(),
        Err(code) => (code, "bad token").into_response(),
    }
}

fn bind_error_message(port: u16, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::AddrInUse {
        format!("連接埠 {port} 被其他程式占用，外部助理連不進來。")
    } else {
        format!("連接埠 {port} 開不起來（{e}），外部助理連不進來。")
    }
}

/// 在 Tauri 的 async runtime 上跑（`mod.rs` 的 setup spawn）；回來＝不再聽（錯誤已記進狀態）
pub async fn serve(state: Arc<McpState>, emit: Emit) {
    let port = state.port();
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            let msg = bind_error_message(port, &e);
            eprintln!("[mcp] {msg}");
            state.set_listen_error(msg);
            return;
        }
    };
    state.set_listening();

    let handler = NextStopServer::new(state.clone(), emit);
    let cfg = StreamableHttpServerConfig::default()
        .with_allowed_hosts([format!("127.0.0.1:{port}"), format!("localhost:{port}")])
        .enforce_origin_validation();
    let service = StreamableHttpService::new(
        move || Ok(handler.clone()),
        Arc::new(LocalSessionManager::default()),
        cfg,
    );
    let app = Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(state.clone(), gate));
    if let Err(e) = axum::serve(listener, app).await {
        let msg = format!("外部助理的連接埠 {port} 停了（{e}）。");
        eprintln!("[mcp] {msg}");
        state.set_listen_error(msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::bridge::Reply;
    use crate::mcp::config::{McpConfig, Module};
    use crate::mcp::{lock, ToolHints};
    use axum::http::HeaderValue;
    use std::sync::Mutex;

    #[test]
    fn 定長比較() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(!ct_eq(b"", b"a"));
        assert!(ct_eq(b"", b""));
    }

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(k.clone(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn 門口_金鑰與_origin() {
        let t = "tok_123";
        assert_eq!(
            check_headers(&headers(&[(header::AUTHORIZATION, "Bearer tok_123")]), t),
            Ok(())
        );
        assert_eq!(
            check_headers(&headers(&[(header::AUTHORIZATION, "bearer  tok_123 ")]), t),
            Ok(())
        );
        assert_eq!(
            check_headers(&headers(&[(header::AUTHORIZATION, "Bearer tok_124")]), t),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            check_headers(&headers(&[(header::AUTHORIZATION, "tok_123")]), t),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            check_headers(&headers(&[(header::AUTHORIZATION, "Basic tok_123")]), t),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            check_headers(&HeaderMap::new(), t),
            Err(StatusCode::UNAUTHORIZED)
        );
        // 帶 Origin：金鑰對也擋
        assert_eq!(
            check_headers(
                &headers(&[
                    (header::AUTHORIZATION, "Bearer tok_123"),
                    (header::ORIGIN, "http://evil.example")
                ]),
                t
            ),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            check_headers(&headers(&[(header::ORIGIN, "null")]), t),
            Err(StatusCode::FORBIDDEN)
        );
        // 空金鑰誰都進不來
        assert_eq!(
            check_headers(&headers(&[(header::AUTHORIZATION, "Bearer ")]), ""),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn 開關把關() {
        let mut a = AccessMap::default();
        assert!(!allowed(ToolModule::Overview, Access::Read, &a));
        assert!(!allowed(ToolModule::Tasks, Access::Read, &a));
        a.set(Module::Ledger, Access::Read);
        assert!(allowed(ToolModule::Overview, Access::Read, &a));
        assert!(allowed(ToolModule::Ledger, Access::Read, &a));
        assert!(!allowed(ToolModule::Ledger, Access::Write, &a));
        assert!(!allowed(ToolModule::Tasks, Access::Read, &a));
        a.set(Module::Tasks, Access::Write);
        assert!(allowed(ToolModule::Tasks, Access::Read, &a));
        assert!(allowed(ToolModule::Tasks, Access::Write, &a));
        // 工具宣告 off 也當成要 read（不會因此繞過開關）
        assert!(!allowed(ToolModule::Notes, Access::Off, &a));
    }

    #[test]
    fn 被擋的話與功能名稱() {
        assert_eq!(
            blocked_message(ToolModule::Diary, false),
            "這個功能（日記）沒有開放給外部助理，請到 設定 › 外部助理 打開。"
        );
        assert!(blocked_message(ToolModule::Overview, false).contains("設定 › 外部助理"));
        assert!(blocked_message(ToolModule::Tasks, true).contains("只開放「只看」"));
        assert_eq!(blocked_summary(ToolModule::Notes, true), "只開放只看：筆記");
    }

    fn spec(name: &str, module: ToolModule, access: Access) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            title: format!("{name} 標題"),
            description: format!("{name} 說明"),
            input_schema: serde_json::from_str(r#"{"type":"object","properties":{}}"#).unwrap(),
            module,
            access,
            annotations: ToolHints {
                read_only_hint: access != Access::Write,
                destructive_hint: false,
                idempotent_hint: None,
                open_world_hint: false,
            },
        }
    }

    #[test]
    fn 轉成_rmcp_tool() {
        let t = to_rmcp_tool(&spec("find-tasks", ToolModule::Tasks, Access::Read));
        let j = serde_json::to_value(&t).unwrap();
        assert_eq!(j["name"], "find-tasks");
        assert_eq!(j["title"], "find-tasks 標題");
        assert_eq!(j["description"], "find-tasks 說明");
        assert_eq!(j["inputSchema"]["type"], "object");
        assert_eq!(j["annotations"]["readOnlyHint"], true);
        assert_eq!(j["annotations"]["destructiveHint"], false);
        assert_eq!(j["annotations"]["openWorldHint"], false);
        assert!(j["annotations"].get("idempotentHint").is_none());
    }

    /// 假的主視窗：記下送了什麼；收到 mcp:call 就照 `answer` 立刻回
    fn harness(
        access: AccessMap,
        answer: impl Fn(&str) -> Reply + Send + Sync + 'static,
    ) -> (
        NextStopServer,
        Arc<McpState>,
        Arc<Mutex<Vec<(String, Value)>>>,
    ) {
        let mut cfg = McpConfig::locked("x");
        cfg.access = access;
        let state = Arc::new(McpState::new(cfg, None));
        state.set_tools(vec![
            spec("get-overview", ToolModule::Overview, Access::Read),
            spec("find-tasks", ToolModule::Tasks, Access::Read),
            spec("add-tasks", ToolModule::Tasks, Access::Write),
        ]);
        let sent = Arc::new(Mutex::new(Vec::new()));
        let (s2, sent2) = (state.clone(), sent.clone());
        let emit: Emit = Arc::new(move |ev: &str, payload: Value| {
            lock(&sent2).push((ev.to_string(), payload.clone()));
            if ev == CALL_EVENT {
                let id = payload["id"].as_str().unwrap().to_string();
                s2.bridge.resolve(answer(&id));
            }
            Ok(())
        });
        (NextStopServer::new(state.clone(), emit), state, sent)
    }

    fn text_of(r: &CallToolResult) -> String {
        serde_json::to_value(r).unwrap()["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn 關著的功能_不打擾_webview() {
        let (srv, state, sent) = harness(AccessMap::default(), |_| unreachable!());
        let r = srv.dispatch("find-tasks", json!({})).await;
        assert_eq!(r.is_error, Some(true));
        assert!(text_of(&r).contains("（任務）沒有開放"));
        let sent = lock(&sent).clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, BLOCKED_EVENT);
        assert_eq!(sent[0].1["module"], "tasks");
        assert_eq!(state.recent()[0].kind, RecentKind::Blocked);
    }

    #[tokio::test]
    async fn 只看擋寫入() {
        let mut a = AccessMap::default();
        a.set(Module::Tasks, Access::Read);
        let (srv, _state, sent) = harness(a, |id| Reply {
            id: id.into(),
            ok: true,
            text: "找到 2 張".into(),
            is_error: false,
            write: false,
            summary: None,
        });
        let r = srv.dispatch("find-tasks", json!({"query": "x"})).await;
        assert_eq!(r.is_error, Some(false));
        assert_eq!(text_of(&r), "找到 2 張");
        let r = srv.dispatch("add-tasks", json!({})).await;
        assert_eq!(r.is_error, Some(true));
        let sent = lock(&sent).clone();
        assert_eq!(sent[0].0, CALL_EVENT);
        assert_eq!(sent[0].1["tool"], "find-tasks");
        assert_eq!(sent[0].1["args"]["query"], "x");
        assert_eq!(sent[0].1["access"]["tasks"], "read");
        assert_eq!(sent[1].0, BLOCKED_EVENT);
    }

    #[tokio::test]
    async fn 寫入成功記最近紀錄_內部錯也記() {
        let mut a = AccessMap::default();
        a.set(Module::Tasks, Access::Write);
        let (srv, state, _sent) = harness(a, |id| Reply {
            id: id.into(),
            ok: true,
            text: "建立了 3 張車票\n{...}".into(),
            is_error: false,
            write: true,
            summary: Some("建立了 3 張車票".into()),
        });
        let r = srv.dispatch("add-tasks", json!({"tasks": []})).await;
        assert_eq!(r.is_error, Some(false));
        let rec = state.recent();
        assert_eq!(rec[0].kind, RecentKind::Write);
        assert_eq!(rec[0].summary, "建立了 3 張車票");
        assert_eq!(rec[0].tool, "add-tasks");

        let mut a = AccessMap::default();
        a.set(Module::Tasks, Access::Write);
        let (srv, state, _sent) = harness(a, |id| Reply {
            id: id.into(),
            ok: false,
            text: "內部錯誤".into(),
            is_error: true,
            write: false,
            summary: None,
        });
        let r = srv.dispatch("add-tasks", json!({})).await;
        assert_eq!(r.is_error, Some(true));
        assert_eq!(state.recent()[0].kind, RecentKind::Error);
    }

    #[tokio::test]
    async fn 沒有這支工具() {
        let (srv, _state, sent) = harness(AccessMap::default(), |_| unreachable!());
        let r = srv.dispatch("nope", json!({})).await;
        assert_eq!(r.is_error, Some(true));
        assert!(text_of(&r).contains("沒有這支工具"));
        assert!(lock(&sent).is_empty());
    }

    #[test]
    fn 截斷() {
        assert_eq!(clip("一二三", 5), "一二三");
        assert_eq!(clip("一二三四五六", 5), "一二三四五…");
    }
}
