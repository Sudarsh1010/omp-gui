//! Launch and stream the app-owned Browser Pane Chromium (ADR-0006, ADR-0007).
//!
//! Per project, this module owns a headed Chrome-for-Testing process with a
//! persistent `--user-data-dir` and an ephemeral `--remote-debugging-port`.
//! omp's builtin browser tool attaches to that same port via its existing
//! `connected`-kind CDP path (notes/browser.md §2, §9) — this module never
//! talks to omp about it, it only launches Chromium and exposes the endpoint.
//!
//! Separately, this module runs its *own* second CDP client (flatten-mode,
//! ADR-0006) that starts a screencast on every page target and rebroadcasts
//! decoded JPEG frames to a tiny localhost WebSocket server. Frames never
//! transit Tauri events (ADR-0007) — the frontend connects to that server
//! directly.
//!
//! Both the CDP pump and the frame server are "slow-moving byte-pump with a
//! tiny surface" (ADR-0007): a handful of stable CDP methods, hand-rolled
//! over `tokio-tungstenite` rather than a full CDP binding crate.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

/// Power-user override, mirrors `OMP_GUI_OMP_PATH`'s naming (ADR-0004).
const CHROMIUM_OVERRIDE_ENV: &str = "OMP_GUI_CHROMIUM_PATH";
/// The ecosystem-standard override that omp's own Chromium resolution also
/// honors first (notes/browser.md §5) — set once, both processes agree.
const PUPPETEER_EXECUTABLE_ENV: &str = "PUPPETEER_EXECUTABLE_PATH";

/// How long to wait for Chrome's `DevTools listening on ws://…` stderr
/// banner — the same signal `@puppeteer/browsers`' own launcher waits on —
/// before giving up on a cold start.
const CHROME_LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);

/// Ring buffer depth for the frame broadcast channel: a live pane only ever
/// wants "now", so this only needs to absorb brief consumer stalls.
const FRAME_CHANNEL_CAPACITY: usize = 4;

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// Info the frontend needs to render the pane and (later) hand omp's browser
/// tool a `connected`-kind CDP URL.
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub project_path: String,
    /// `http://127.0.0.1:<port>` — omp's `connected` kind requires an HTTP
    /// discovery URL, not a raw websocket one (notes/browser.md §2:
    /// `normalizeConnectedCdpUrl` rejects `ws(s)://`).
    pub cdp_url: String,
    /// The browser-level CDP websocket endpoint Chrome printed on startup.
    pub cdp_ws_url: String,
    /// Localhost WebSocket endpoint streaming raw JPEG screencast frames as
    /// binary messages — never through Tauri events (ADR-0007).
    pub frame_endpoint: String,
    pub user_data_dir: String,
    pub chromium_path: String,
}

/// Errors returned from Browser Pane Shell Bridge commands.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum BrowserError {
    ChromiumNotFound { message: String },
    ProfileDirFailed { message: String },
    SpawnFailed { message: String },
    LaunchTimeout { message: String },
    AttachFailed { message: String },
    FrameServerFailed { message: String },
    UnknownProject,
}

impl fmt::Display for BrowserError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ChromiumNotFound { message } => write!(f, "chromium not found: {message}"),
            Self::ProfileDirFailed { message } => write!(f, "profile directory failed: {message}"),
            Self::SpawnFailed { message } => write!(f, "spawn failed: {message}"),
            Self::LaunchTimeout { message } => write!(f, "launch timed out: {message}"),
            Self::AttachFailed { message } => write!(f, "CDP attach failed: {message}"),
            Self::FrameServerFailed { message } => write!(f, "frame server failed: {message}"),
            Self::UnknownProject => write!(f, "unknown project"),
        }
    }
}

/// A running per-project Chrome-for-Testing instance plus the two background
/// tasks feeding its pane (the CDP pump and the frame server). Ref-counted:
/// concurrent sessions in the same project (ADR-0005's unbounded-sessions
/// stance) share one browser rather than launching a second Chromium against
/// the same locked profile directory.
struct BrowserSession {
    chrome: Child,
    user_data_dir: PathBuf,
    cdp_url: String,
    cdp_ws_url: String,
    frame_endpoint: String,
    chromium_path: String,
    ref_count: usize,
    pump_task: tokio::task::AbortHandle,
    frame_server_task: tokio::task::AbortHandle,
}

impl BrowserSession {
    fn info(&self, project_path: &str) -> BrowserInfo {
        BrowserInfo {
            project_path: project_path.to_string(),
            cdp_url: self.cdp_url.clone(),
            cdp_ws_url: self.cdp_ws_url.clone(),
            frame_endpoint: self.frame_endpoint.clone(),
            user_data_dir: self.user_data_dir.display().to_string(),
            chromium_path: self.chromium_path.clone(),
        }
    }
}

impl Drop for BrowserSession {
    fn drop(&mut self) {
        self.pump_task.abort();
        self.frame_server_task.abort();
        let _ = self.chrome.kill();
        let _ = self.chrome.wait();
    }
}

pub struct BrowserState {
    /// A dedicated runtime rather than relying on Tauri's own async runtime:
    /// this keeps the pane's websocket plumbing fully decoupled from Tauri's
    /// internal executor choice, matching the rest of this crate's habit of
    /// managing its own OS threads explicitly (see `omp.rs`'s stdout pumps).
    runtime: tokio::runtime::Runtime,
    sessions: Mutex<HashMap<String, BrowserSession>>,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("failed to start the browser pane's async runtime"),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// Launch (or, if this project already has one running, attach to) the
/// per-project Browser Pane Chromium.
#[tauri::command]
#[specta::specta]
pub fn browser_launch(
    app: AppHandle,
    state: State<'_, BrowserState>,
    project_path: String,
) -> Result<BrowserInfo, BrowserError> {
    let canonical =
        std::fs::canonicalize(&project_path).map_err(|e| BrowserError::ProfileDirFailed {
            message: format!("project path {project_path} is not accessible: {e}"),
        })?;
    let key = canonical.to_string_lossy().into_owned();

    {
        let mut sessions = state.sessions.lock();
        if let Some(session) = sessions.get_mut(&key) {
            session.ref_count += 1;
            return Ok(session.info(&key));
        }
    }

    let chromium_path = resolve_chromium_executable(&app)?;
    let user_data_dir = profile_dir_for_project(&app, &canonical)?;
    std::fs::create_dir_all(&user_data_dir).map_err(|e| BrowserError::ProfileDirFailed {
        message: format!(
            "failed to create profile directory {}: {e}",
            user_data_dir.display()
        ),
    })?;

    let mut child = Command::new(&chromium_path)
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", user_data_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--window-size=1280,800")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BrowserError::SpawnFailed {
            message: format!("failed to spawn {}: {e}", chromium_path.display()),
        })?;

    let stderr = child.stderr.take().expect("stderr piped");
    let (banner_tx, banner_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    // The exact signal `@puppeteer/browsers`' own launcher
                    // scrapes for (`CDP_WEBSOCKET_ENDPOINT_REGEX`), not a
                    // `DevToolsActivePort` file read/race.
                    if let Some(url) = line.strip_prefix("DevTools listening on ") {
                        let _ = banner_tx.send(url.trim().to_string());
                    }
                    #[cfg(debug_assertions)]
                    eprintln!("[chrome stderr] {line}");
                }
                Err(_) => break,
            }
        }
    });

    let cdp_ws_url = banner_rx.recv_timeout(CHROME_LAUNCH_TIMEOUT).map_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
        BrowserError::LaunchTimeout {
            message: "Chrome for Testing did not report its DevTools endpoint in time".into(),
        }
    })?;
    let cdp_url = http_origin_of(&cdp_ws_url)?;

    // Bind the frame server's loopback listener synchronously so its port is
    // known before this command returns; the CDP pump and the accept loop
    // then run in the background for as long as the session lives.
    let listener = state
        .runtime
        .block_on(TcpListener::bind("127.0.0.1:0"))
        .map_err(|e| BrowserError::FrameServerFailed {
            message: format!("failed to bind pane frame server: {e}"),
        })?;
    let frame_port = listener
        .local_addr()
        .map_err(|e| BrowserError::FrameServerFailed {
            message: e.to_string(),
        })?
        .port();
    let frame_endpoint = format!("ws://127.0.0.1:{frame_port}");

    let (frame_tx, _) = broadcast::channel::<Bytes>(FRAME_CHANNEL_CAPACITY);
    let frame_server_task = state
        .runtime
        .spawn(run_frame_server(listener, frame_tx.clone()))
        .abort_handle();
    let pump_task = state
        .runtime
        .spawn(run_cdp_pump(cdp_ws_url.clone(), frame_tx))
        .abort_handle();

    let session = BrowserSession {
        chrome: child,
        user_data_dir,
        cdp_url,
        cdp_ws_url,
        frame_endpoint,
        chromium_path: chromium_path.display().to_string(),
        ref_count: 1,
        pump_task,
        frame_server_task,
    };
    // Re-check rather than trust the early lock-released check at the top:
    // a concurrent `browser_launch` for this same *new* project could have
    // finished first while we were spawning. If so, adopt its session and
    // let `session` (our now-redundant Chromium) fall out of scope, whose
    // `Drop` tears it down.
    let mut sessions = state.sessions.lock();
    if let Some(existing) = sessions.get_mut(&key) {
        existing.ref_count += 1;
        return Ok(existing.info(&key));
    }
    let info = session.info(&key);
    sessions.insert(key, session);
    Ok(info)
}

/// Release this caller's interest in a project's Browser Pane. The Chromium
/// keeps running (and its persistent profile keeps existing) until every
/// caller has released it — mirroring omp's own connected-URL refcount
/// (notes/browser.md §2) — then `BrowserSession::drop` tears it down.
#[tauri::command]
#[specta::specta]
pub fn browser_stop(
    state: State<'_, BrowserState>,
    project_path: String,
) -> Result<(), BrowserError> {
    let key = std::fs::canonicalize(&project_path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| BrowserError::UnknownProject)?;

    let mut sessions = state.sessions.lock();
    let should_remove = match sessions.get_mut(&key) {
        Some(session) => {
            session.ref_count = session.ref_count.saturating_sub(1);
            session.ref_count == 0
        }
        None => return Err(BrowserError::UnknownProject),
    };
    if should_remove {
        sessions.remove(&key);
    }
    Ok(())
}

/// `PUPPETEER_EXECUTABLE_PATH` / our own override always win; otherwise scan
/// the standard `@puppeteer/browsers` cache layout (`<root>/chrome/<platform
/// >-<buildId>/<relative>`) under both the ecosystem-default cache and omp's
/// own managed-browser cache, so a Chrome for Testing the user already has —
/// via either `npx @puppeteer/browsers install` or omp's own headless
/// downloads — is reused instead of demanding a fresh bundle (notes/
/// browser.md §5). We don't bundle one ourselves yet, so failing here must
/// give the user an actionable next step.
fn resolve_chromium_executable(app: &AppHandle) -> Result<PathBuf, BrowserError> {
    for env_var in [CHROMIUM_OVERRIDE_ENV, PUPPETEER_EXECUTABLE_ENV] {
        if let Ok(path) = std::env::var(env_var) {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    if let Ok(home) = app.path().home_dir() {
        let relative = chrome_for_testing_relative_path();
        for cache_root in [
            home.join(".cache").join("puppeteer"),
            home.join(".omp").join("puppeteer"),
        ] {
            if let Some(found) = find_chrome_in_cache(&cache_root, &relative) {
                return Ok(found);
            }
        }
    }

    Err(BrowserError::ChromiumNotFound {
        message: format!(
            "no Chrome for Testing binary found. Install one (e.g. `npx @puppeteer/browsers install \
             chrome@stable`), run omp's browser tool once to let it download its own copy, or set \
             {CHROMIUM_OVERRIDE_ENV} / {PUPPETEER_EXECUTABLE_ENV} to an existing Chrome binary."
        ),
    })
}

/// `<cacheRoot>/chrome/<anything>/<relative_executable>` — the buildId
/// directory name is unknown (and, deliberately, never computed here: that
/// would mean reimplementing `@puppeteer/browsers`' network-resolved version
/// pinning), so every subdirectory is checked for the known relative layout
/// instead.
fn find_chrome_in_cache(cache_root: &Path, relative_executable: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(cache_root.join("chrome")).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .map(|dir| dir.join(relative_executable))
        .find(|candidate| candidate.is_file())
}

/// Mirrors `@puppeteer/browsers`' `relativeExecutablePath()`
/// (`browser-data/chrome.js`), which is what actually lays out the cache
/// directories this module scans.
fn chrome_for_testing_relative_path() -> PathBuf {
    if cfg!(target_os = "macos") {
        let arch_folder = if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        };
        PathBuf::from(format!("chrome-{arch_folder}"))
            .join("Google Chrome for Testing.app")
            .join("Contents")
            .join("MacOS")
            .join("Google Chrome for Testing")
    } else if cfg!(target_os = "windows") {
        PathBuf::from("chrome-win64").join("chrome.exe")
    } else {
        PathBuf::from("chrome-linux64").join("chrome")
    }
}

/// Extracts `http://<host>:<port>` from Chrome's `ws://<host>:<port>/
/// devtools/browser/<uuid>` banner — the HTTP form omp's `connected` kind
/// requires (see `BrowserInfo::cdp_url`'s doc comment).
fn http_origin_of(cdp_ws_url: &str) -> Result<String, BrowserError> {
    let rest = cdp_ws_url
        .strip_prefix("ws://")
        .ok_or_else(|| BrowserError::AttachFailed {
            message: format!("unexpected CDP endpoint scheme: {cdp_ws_url}"),
        })?;
    let host_port = rest.split('/').next().unwrap_or(rest);
    Ok(format!("http://{host_port}"))
}

/// One persistent profile directory per project (ADR-0006), named from a
/// stable hash of the canonicalized project path. Deliberately *not*
/// `std::collections::hash_map::DefaultHasher`: its algorithm is explicitly
/// unspecified and may change across Rust releases, which would silently
/// relocate — and thus appear to wipe — every project's logins the next time
/// the app happens to rebuild with a different toolchain. FNV-1a is a fixed,
/// public algorithm this crate owns forever instead.
fn profile_dir_for_project(
    app: &AppHandle,
    canonical_project_path: &Path,
) -> Result<PathBuf, BrowserError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| BrowserError::ProfileDirFailed {
            message: e.to_string(),
        })?;
    let digest = fnv1a64(canonical_project_path.to_string_lossy().as_bytes());
    let slug: String = canonical_project_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(base
        .join("browser-profiles")
        .join(format!("{slug}-{digest:016x}")))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes
        .iter()
        .fold(OFFSET, |hash, &b| (hash ^ b as u64).wrapping_mul(PRIME))
}

/// Runs the app's own second CDP client against the app-owned Chromium
/// (ADR-0006): discovers page targets, attaches to each in flatten mode, and
/// starts a screencast, rebroadcasting decoded JPEG frames to every
/// connected pane over `frames` — never through Tauri events (ADR-0007).
///
/// Best-effort by design: a single failed CDP call (an `"error"` response)
/// is logged and dropped rather than tearing down the whole pump, since one
/// mis-attached target should not blank out frames already flowing from
/// others. A transport-level failure (the socket itself breaking) ends the
/// pump — nothing further can be done over a dead connection.
async fn run_cdp_pump(cdp_ws_url: String, frames: broadcast::Sender<Bytes>) {
    let mut ws = match tokio_tungstenite::connect_async(&cdp_ws_url).await {
        Ok((ws, _response)) => ws,
        Err(_err) => {
            #[cfg(debug_assertions)]
            eprintln!("[browser cdp] failed to attach second CDP client to {cdp_ws_url}: {_err}");
            return;
        }
    };

    let mut next_id: u64 = 1;
    if send_cdp(
        &mut ws,
        next_id,
        "Target.setDiscoverTargets",
        json!({ "discover": true }),
        None,
    )
    .await
    .is_err()
    {
        return;
    }

    let mut pending_attach: HashSet<u64> = HashSet::new();
    let mut known_targets: HashSet<String> = HashSet::new();

    while let Some(incoming) = ws.next().await {
        let Ok(Message::Text(text)) = incoming else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };

        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            if value.get("error").is_some() {
                #[cfg(debug_assertions)]
                eprintln!("[browser cdp] command {id} failed: {value}");
                continue;
            }
            if pending_attach.remove(&id) {
                let Some(session_id) = value.pointer("/result/sessionId").and_then(Value::as_str)
                else {
                    continue;
                };
                next_id += 1;
                if send_cdp(&mut ws, next_id, "Page.enable", json!({}), Some(session_id))
                    .await
                    .is_err()
                {
                    return;
                }
                next_id += 1;
                if send_cdp(
                    &mut ws,
                    next_id,
                    "Page.startScreencast",
                    json!({
                        "format": "jpeg",
                        "quality": 80,
                        "maxWidth": 1280,
                        "maxHeight": 800,
                        "everyNthFrame": 1,
                    }),
                    Some(session_id),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            continue;
        }

        match value.get("method").and_then(Value::as_str) {
            Some("Target.targetCreated" | "Target.targetInfoChanged") => {
                let is_page = value
                    .pointer("/params/targetInfo/type")
                    .and_then(Value::as_str)
                    == Some("page");
                let Some(target_id) = value
                    .pointer("/params/targetInfo/targetId")
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if is_page && known_targets.insert(target_id.to_string()) {
                    next_id += 1;
                    pending_attach.insert(next_id);
                    if send_cdp(
                        &mut ws,
                        next_id,
                        "Target.attachToTarget",
                        json!({ "targetId": target_id, "flatten": true }),
                        None,
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                }
            }
            Some("Target.targetDestroyed") => {
                if let Some(target_id) = value.pointer("/params/targetId").and_then(Value::as_str) {
                    known_targets.remove(target_id);
                }
            }
            Some("Page.screencastFrame") => {
                // Two different `sessionId`s are in play here: the envelope
                // one (string) is the flatten-mode target session used to
                // route the ack; `params.sessionId` (a number) is the
                // per-frame id `Page.screencastFrameAck` must echo back.
                let Some(target_session_id) = value.get("sessionId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(params) = value.get("params") else {
                    continue;
                };
                if let Some(data) = params.get("data").and_then(Value::as_str) {
                    if let Ok(bytes) = BASE64_STANDARD.decode(data) {
                        // No receivers (no pane currently open) is a normal,
                        // silent no-op — the CDP pump keeps running so a
                        // pane opened moments later doesn't need to re-attach.
                        let _ = frames.send(Bytes::from(bytes));
                    }
                }
                if let Some(frame_ack_id) = params.get("sessionId").and_then(Value::as_u64) {
                    next_id += 1;
                    if send_cdp(
                        &mut ws,
                        next_id,
                        "Page.screencastFrameAck",
                        json!({ "sessionId": frame_ack_id }),
                        Some(target_session_id),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                }
            }
            _ => {}
        }
    }
}

async fn send_cdp(
    ws: &mut WsStream,
    id: u64,
    method: &str,
    params: Value,
    session_id: Option<&str>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let mut envelope = json!({ "id": id, "method": method, "params": params });
    if let Some(session_id) = session_id {
        envelope["sessionId"] = Value::String(session_id.to_string());
    }
    ws.send(Message::Text(envelope.to_string().into())).await
}

/// Accepts localhost pane connections and rebroadcasts screencast frames to
/// each of them as binary WebSocket messages — the ADR-0007 frame-serving
/// endpoint. Never touches Tauri's event bus.
async fn run_frame_server(listener: TcpListener, frames: broadcast::Sender<Bytes>) {
    loop {
        let Ok((stream, _addr)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(serve_frame_client(stream, frames.subscribe()));
    }
}

async fn serve_frame_client(stream: TcpStream, mut frames: broadcast::Receiver<Bytes>) {
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    loop {
        tokio::select! {
            frame = frames.recv() => {
                match frame {
                    Ok(bytes) => {
                        if ws.send(Message::Binary(bytes)).await.is_err() {
                            return;
                        }
                    }
                    // A slow client skips forward to the newest frame rather
                    // than catching up frame-by-frame — a live pane only
                    // ever wants "now".
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Err(_)) => return,
                    _ => {}
                }
            }
        }
    }
}
