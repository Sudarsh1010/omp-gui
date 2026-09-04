//! Launch, stream, and take over the app-owned Browser Pane Chromium (ADR-0006, ADR-0007).
//!
//! Per project, this module owns a headed Chrome-for-Testing process with a
//! persistent `--user-data-dir` and an ephemeral `--remote-debugging-port`.
//! omp's builtin browser tool attaches to that same port via its existing
//! `connected`-kind CDP path (notes/browser.md §2, §9). On launch this
//! module hands omp that URL itself via `config::set_value`/`reset_value`
//! (`set_connected_cdp_config`, defined just after `browser_stop` below),
//! and resets it once the project's last interested party stops the
//! browser — the same config-bridge lever `browser_set_relay` (near the
//! bottom of this file) uses for `browser.relay`, sharing its accepted
//! gap: an omp session only reads config at its own startup (see
//! `set_connected_cdp_config`'s doc comment).
//!
//! Separately, this module runs its *own* second CDP client (flatten-mode,
//! ADR-0006) that starts a screencast on every page target and rebroadcasts
//! decoded JPEG frames to a tiny localhost WebSocket server. Frames never
//! transit Tauri events (ADR-0007) — the frontend connects to that server
//! directly.
//!
//! Takeover forwards pane input back through this same second CDP client —
//! `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` calls against the
//! most recently attached page — over the same localhost WebSocket the
//! pane already uses for frames, made bidirectional (frames down, input
//! up). The per-session `takeover` flag this module owns is also what the
//! TypeScript side reads (via `BrowserInfo.takeover` and this socket's
//! `{"type":"takeover"}` pushes) to hold back the agent's next
//! browser-tool call while a human is driving (ADR-0006).
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
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream as SyncTcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

/// Power-user override, mirrors `OMP_GUI_OMP_PATH`'s naming (ADR-0004).
/// Crate-visible so `preferences.rs`'s `preferences_effective` (#22) can
/// report the exact env var name the Chromium Path row's description
/// documents, rather than a second, driftable copy of the string.
pub(crate) const CHROMIUM_OVERRIDE_ENV: &str = "OMP_GUI_CHROMIUM_PATH";
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

/// Messages pushed down to every connected pane WebSocket client: JPEG
/// screencast frames (as before) plus, new here, Takeover state changes —
/// sent once up front on connect and again on every toggle, since the
/// broadcast channel itself never replays history to a client that joins
/// mid-stream.
#[derive(Clone)]
enum PaneMessage {
    Frame(Bytes),
    Takeover(bool),
}

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
    /// Whether a human is currently driving this pane (see
    /// `browser_set_takeover`).
    pub takeover: bool,
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
    RelayLaunchFailed { message: String },
    RelayConfigFailed { message: String },
    CdpConfigFailed { message: String },
    InstallFailed { message: String },
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
            Self::RelayLaunchFailed { message } => {
                write!(f, "browser relay launch failed: {message}")
            }
            Self::RelayConfigFailed { message } => {
                write!(f, "browser relay config failed: {message}")
            }
            Self::CdpConfigFailed { message } => {
                write!(f, "browser CDP config failed: {message}")
            }
            Self::InstallFailed { message } => {
                write!(f, "chromium install failed: {message}")
            }
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
    takeover: Arc<AtomicBool>,
    outbound_tx: broadcast::Sender<PaneMessage>,
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
            takeover: self.takeover.load(Ordering::Relaxed),
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
    /// Relay daemons (T11), keyed by port — see the "Relay mode" section
    /// near the end of this file.
    relay: Mutex<HashMap<u16, RelayDaemon>>,
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
            relay: Mutex::new(HashMap::new()),
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

    let (outbound_tx, _) = broadcast::channel::<PaneMessage>(FRAME_CHANNEL_CAPACITY);
    let (input_tx, input_rx) = mpsc::unbounded_channel::<(String, Value)>();
    let takeover = Arc::new(AtomicBool::new(false));
    let frame_server_task = state
        .runtime
        .spawn(run_frame_server(
            listener,
            outbound_tx.clone(),
            input_tx,
            takeover.clone(),
        ))
        .abort_handle();
    let pump_task = state
        .runtime
        .spawn(run_cdp_pump(
            cdp_ws_url.clone(),
            outbound_tx.clone(),
            input_rx,
            takeover.clone(),
        ))
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
        takeover,
        outbound_tx,
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
    drop(sessions);

    // Best-effort: feed omp's builtin browser tool this project's CDP
    // endpoint (see `set_connected_cdp_config`'s doc comment). A failed
    // config write must not fail the launch itself — the pane's
    // screencast and human Takeover driving both work with no dependency
    // on omp ever attaching.
    if let Err(_err) = set_connected_cdp_config(&app, Some(&info.cdp_url)) {
        #[cfg(debug_assertions)]
        eprintln!("[browser cdp-config] failed to set browser.cdpUrl: {_err}");
    }
    Ok(info)
}

/// Release this caller's interest in a project's Browser Pane. The Chromium
/// keeps running (and its persistent profile keeps existing) until every
/// caller has released it — mirroring omp's own connected-URL refcount
/// (notes/browser.md §2) — then `BrowserSession::drop` tears it down.
#[tauri::command]
#[specta::specta]
pub fn browser_stop(
    app: AppHandle,
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
    drop(sessions);

    if should_remove {
        // Best-effort, mirroring the set call in `browser_launch`: reset
        // `browser.cdpUrl` now that this project's last interested party
        // has released the Chromium (see `set_connected_cdp_config`'s doc
        // comment for why a failure here must not block the teardown).
        if let Err(_err) = set_connected_cdp_config(&app, None) {
            #[cfg(debug_assertions)]
            eprintln!("[browser cdp-config] failed to reset browser.cdpUrl: {_err}");
        }
    }
    Ok(())
}

/// Feed omp's builtin browser tool this project's app-owned Chromium so its
/// `connected`-kind CDP path (notes/browser.md §2, §9) can attach —
/// `browser.cdpUrl` (`config/settings-schema.ts:4509-4519`; omp's settings
/// resolution checks `browser.relay` *before* this key, so an enabled relay
/// still wins). Mirrors `browser_set_relay`'s `config::set_value`/
/// `reset_value` shape and its doc comment in full: this is a short-lived
/// CLI invocation of the
/// pinned binary, not an RPC call into a running `--mode rpc-ui` session,
/// so a session already running when a Browser Pane launches or stops
/// keeps whichever CDP config (or none) it resolved at its own startup —
/// only omp sessions started *after* this call see it. That gap is
/// accepted, not closed, by both `browser_launch` and `browser_stop`,
/// which therefore treat every call here as best-effort.
fn set_connected_cdp_config(app: &AppHandle, cdp_url: Option<&str>) -> Result<(), BrowserError> {
    let result = match cdp_url {
        Some(url) => crate::config::set_value(app, "browser.cdpUrl", url),
        None => crate::config::reset_value(app, "browser.cdpUrl"),
    };
    result
        .map(|_| ())
        .map_err(|e| BrowserError::CdpConfigFailed {
            message: e.to_string(),
        })
}

/// Toggle Takeover for a project's Browser Pane. Two things change:
///
/// 1. Pane input forwarded over the frame WebSocket (see `parse_pane_input`)
///    starts (or stops) being dispatched into the live Chromium via the CDP
///    pump's `Input.dispatch*` calls (`run_cdp_pump`) — while disabled,
///    that same input is still accepted but silently dropped rather than
///    dispatched.
/// 2. Every connected pane for this project — the Chromium is shared
///    across concurrent sessions, per `BrowserSession`'s doc comment — is
///    notified of the new state over its own WebSocket, so a "you are
///    driving" affordance stays correct regardless of which pane flipped
///    the toggle.
///
/// This module has no visibility into omp's own RPC session traffic
/// (ADR-0007: Rust never parses rpc-ui protocol frames, it only pipes
/// bytes), so it cannot itself hold back the agent's next browser-tool
/// call. That half of ADR-0006's "user is driving ... suppressing agent
/// input" is implemented on the TypeScript side, in `BrowserPane.tsx`'s
/// `denyBrowserApprovalsWhileTakenOver`, which watches this same flag
/// (echoed back in `BrowserInfo.takeover` and every pane
/// `{"type":"takeover"}` push) and auto-denies the browser tool's approval
/// prompt for any attached session while it is set.
#[tauri::command]
#[specta::specta]
pub fn browser_set_takeover(
    state: State<'_, BrowserState>,
    project_path: String,
    enabled: bool,
) -> Result<(), BrowserError> {
    let key = std::fs::canonicalize(&project_path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| BrowserError::UnknownProject)?;

    let sessions = state.sessions.lock();
    let session = sessions.get(&key).ok_or(BrowserError::UnknownProject)?;
    session.takeover.store(enabled, Ordering::Relaxed);
    let _ = session.outbound_tx.send(PaneMessage::Takeover(enabled));
    Ok(())
}

/// Where `resolve_chromium_source` picked the Chromium executable from.
/// Crate-visible so `preferences.rs`'s `preferences_effective` (#22) can
/// map it onto its own specta-typed `ChromiumPathSource` for the Settings
/// row, without a second copy of this precedence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChromiumSource {
    /// `OMP_GUI_CHROMIUM_PATH` or `PUPPETEER_EXECUTABLE_PATH`.
    Env,
    /// The App Preferences `chromiumPath` (#22).
    Preference,
    /// A `@puppeteer/browsers`-managed cache scan.
    Cache,
    /// Nothing resolved.
    None,
}

/// `PUPPETEER_EXECUTABLE_PATH` / our own override, checked first by
/// `resolve_chromium_executable`'s caller (`Ok` only for a path that is
/// actually a file). Factored out so `preferences_effective` (#22) can
/// report the same env-var resolution without duplicating it.
pub(crate) fn chromium_env_override() -> Option<PathBuf> {
    [CHROMIUM_OVERRIDE_ENV, PUPPETEER_EXECUTABLE_ENV]
        .into_iter()
        .find_map(|env_var| std::env::var(env_var).ok())
        .map(PathBuf::from)
}

/// Scans the standard `@puppeteer/browsers` cache layout (see
/// `resolve_chromium_executable`'s doc comment) under both the
/// ecosystem-default cache and omp's own managed-browser cache. Factored
/// out so `preferences_effective` (#22) can run the identical scan.
pub(crate) fn find_cached_chromium(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let relative = chrome_for_testing_relative_path();
    [
        home.join(".cache").join("puppeteer"),
        home.join(".omp").join("puppeteer"),
    ]
    .into_iter()
    .find_map(|cache_root| find_chrome_in_cache(&cache_root, &relative))
}

/// Pure precedence resolution, independent of any actual env/filesystem
/// probing so it is unit-testable: `env_override` (already validated by
/// the caller's own env-var lookup) wins when it names an existing file;
/// otherwise a non-empty `preference` (#22's App Preferences
/// `chromiumPath`) wins when it names an existing file; otherwise
/// `cache_lookup` runs lazily (only reached when both prior steps miss,
/// so an idle Settings row never pays for a cache scan a hit env var or
/// preference would have skipped).
pub(crate) fn resolve_chromium_source(
    env_override: Option<PathBuf>,
    preference: Option<&str>,
    cache_lookup: impl FnOnce() -> Option<PathBuf>,
) -> (Option<PathBuf>, ChromiumSource) {
    if let Some(path) = env_override {
        if path.is_file() {
            return (Some(path), ChromiumSource::Env);
        }
    }
    if let Some(dir) = preference.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(dir);
        if path.is_file() {
            return (Some(path), ChromiumSource::Preference);
        }
    }
    if let Some(path) = cache_lookup() {
        return (Some(path), ChromiumSource::Cache);
    }
    (None, ChromiumSource::None)
}

/// `PUPPETEER_EXECUTABLE_PATH` / our own override, then the App
/// Preferences `chromiumPath` override (#22), always win; otherwise scan
/// the standard `@puppeteer/browsers` cache layout (`<root>/chrome/<platform
/// >-<buildId>/<relative>`) under both the ecosystem-default cache and omp's
/// own managed-browser cache, so a *headed* Chrome for Testing the user
/// already has — via `npx @puppeteer/browsers install chrome@stable` — is
/// reused instead of demanding a fresh bundle (notes/browser.md §5). omp's
/// builtin browser tool downloads `chrome-headless-shell` (headless-only),
/// which the pane must never drive — ADR-0006 requires a headed binary
/// because headless fingerprints trip bot detection — so that download is
/// deliberately NOT matched here. We don't bundle one ourselves yet, so
/// failing here must
/// give the user an actionable next step.
fn resolve_chromium_executable(app: &AppHandle) -> Result<PathBuf, BrowserError> {
    let preference = crate::preferences::load_preferences(app).chromium_path;
    let (found, _source) =
        resolve_chromium_source(chromium_env_override(), preference.as_deref(), || {
            find_cached_chromium(app)
        });

    found.ok_or_else(|| BrowserError::ChromiumNotFound {
        message: format!(
            "no Chrome for Testing binary found. The Browser Pane needs a headed \
             Chrome for Testing (ADR-0006); omp's builtin browser tool only downloads \
             headless `chrome-headless-shell`, which cannot be used here. Install a headed \
             build with `npx @puppeteer/browsers install chrome@stable`, or set \
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
pub(crate) fn chrome_for_testing_relative_path() -> PathBuf {
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
/// connected pane over `outbound` — never through Tauri events (ADR-0007).
///
/// The same connection carries Takeover upstream: `input_rx` delivers
/// `(method, params)` pairs already validated by `parse_pane_input` from
/// pane WebSocket clients, dispatched here — while `takeover` is set — as
/// `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` calls against
/// whichever page attached most recently (`active_session_id`). This is
/// the one CDP connection omp's own `connected`-kind client never touches
/// (notes/browser.md: omp's browser machinery calls no `Input.dispatch*`
/// itself), so pane input dispatched here never races a call issued by
/// omp's own subprocess.
///
/// Best-effort by design: a single failed CDP call (an `"error"` response)
/// is logged and dropped rather than tearing down the whole pump, since one
/// mis-attached target should not blank out frames already flowing from
/// others. A transport-level failure (the socket itself breaking) ends the
/// pump — nothing further can be done over a dead connection.
async fn run_cdp_pump(
    cdp_ws_url: String,
    outbound: broadcast::Sender<PaneMessage>,
    mut input_rx: mpsc::UnboundedReceiver<(String, Value)>,
    takeover: Arc<AtomicBool>,
) {
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

    // `pending_attach` remembers which target a `Target.attachToTarget` call
    // was for, so its response (which only carries the command id) can be
    // turned back into a `target_id -> session_id` fact once it resolves.
    let mut pending_attach: HashMap<u64, String> = HashMap::new();
    let mut known_targets: HashSet<String> = HashSet::new();
    let mut target_sessions: HashMap<String, String> = HashMap::new();
    // Takeover targets whichever page attached most recently. Screencast
    // frames from every attached target already funnel into one undivided
    // broadcast stream (below), so — like the pane's own view — Takeover
    // input does not disambiguate multiple simultaneous tabs in v1 either.
    let mut active_session_id: Option<String> = None;

    loop {
        tokio::select! {
            incoming = ws.next() => {
                let Some(incoming) = incoming else { return };
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
                    if let Some(target_id) = pending_attach.remove(&id) {
                        let Some(session_id) = value.pointer("/result/sessionId").and_then(Value::as_str)
                        else {
                            continue;
                        };
                        target_sessions.insert(target_id, session_id.to_string());
                        active_session_id = Some(session_id.to_string());
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
                            pending_attach.insert(next_id, target_id.to_string());
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
                            if let Some(session_id) = target_sessions.remove(target_id) {
                                if active_session_id.as_deref() == Some(session_id.as_str()) {
                                    active_session_id = target_sessions.values().next().cloned();
                                }
                            }
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
                                let _ = outbound.send(PaneMessage::Frame(Bytes::from(bytes)));
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
            Some((method, params)) = input_rx.recv() => {
                // The sole Takeover enforcement point (see `serve_frame_client`,
                // which forwards every well-formed pane message here
                // unconditionally): a message that arrives — or was still
                // queued — after Takeover has been released is dropped, not
                // dispatched. See `BrowserPane.tsx`'s
                // `denyBrowserApprovalsWhileTakenOver` for the other half —
                // this module cannot itself hold back the agent's own
                // `connected`-kind CDP client (ADR-0007: no rpc-ui frame
                // parsing in Rust).
                if !takeover.load(Ordering::Relaxed) {
                    continue;
                }
                let Some(session_id) = active_session_id.clone() else {
                    continue;
                };
                next_id += 1;
                if send_cdp(&mut ws, next_id, &method, params, Some(&session_id))
                    .await
                    .is_err()
                {
                    return;
                }
            }
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

/// Validates one inbound pane message against the small allowlist of CDP
/// Input methods Takeover is permitted to drive. This WebSocket is
/// unauthenticated loopback (matching the frame side it extends), so the
/// allowlist is the only thing standing between "type into the pane" and
/// "drive Chrome arbitrarily" — never forward a pane-supplied `method`
/// verbatim without it.
fn parse_pane_input(text: &str) -> Option<(String, Value)> {
    let value: Value = serde_json::from_str(text).ok()?;
    let method = value.get("method")?.as_str()?;
    if !matches!(
        method,
        "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent"
    ) {
        return None;
    }
    let params = value.get("params")?.clone();
    Some((method.to_string(), params))
}

/// Accepts localhost pane connections and rebroadcasts screencast frames
/// (and Takeover state changes) to each of them — the ADR-0007
/// frame-serving endpoint, now bidirectional: `input_tx` carries validated
/// Takeover input back up to `run_cdp_pump`. Never touches Tauri's event bus.
async fn run_frame_server(
    listener: TcpListener,
    outbound: broadcast::Sender<PaneMessage>,
    input_tx: mpsc::UnboundedSender<(String, Value)>,
    takeover: Arc<AtomicBool>,
) {
    loop {
        let Ok((stream, _addr)) = listener.accept().await else {
            continue;
        };
        tokio::spawn(serve_frame_client(
            stream,
            outbound.subscribe(),
            input_tx.clone(),
            takeover.clone(),
        ));
    }
}

async fn serve_frame_client(
    stream: TcpStream,
    mut outbound: broadcast::Receiver<PaneMessage>,
    input_tx: mpsc::UnboundedSender<(String, Value)>,
    takeover: Arc<AtomicBool>,
) {
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    // Sync a freshly connected pane immediately: `outbound` never replays
    // history, so a pane opened after another viewer already toggled
    // Takeover would otherwise show stale "not driving" state until the
    // next unrelated broadcast.
    if ws
        .send(Message::Text(
            json!({ "type": "takeover", "enabled": takeover.load(Ordering::Relaxed) })
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            message = outbound.recv() => {
                match message {
                    Ok(PaneMessage::Frame(bytes)) => {
                        if ws.send(Message::Binary(bytes)).await.is_err() {
                            return;
                        }
                    }
                    Ok(PaneMessage::Takeover(enabled)) => {
                        if ws
                            .send(Message::Text(
                                json!({ "type": "takeover", "enabled": enabled }).to_string().into(),
                            ))
                            .await
                            .is_err()
                        {
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
                    Some(Ok(Message::Text(text))) => {
                        // Every well-formed message is forwarded
                        // unconditionally; `run_cdp_pump` is the sole
                        // Takeover policy enforcement point (one place to
                        // audit "does this only dispatch while driving").
                        if let Some((method, params)) = parse_pane_input(&text) {
                            let _ = input_tx.send((method, params));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Relay mode (T11, issue #12, ADR-0006 §"Human-in-the-loop", notes/
// browser.md §6): the per-task toggle that drives the user's own, already-
// logged-in Chrome through omp's `relay` browser kind instead of the
// app-owned Chromium above, for SSO/hardware-key/password-manager/payment
// flows synthesized input mishandles.
//
// `relay/server.ts` impersonates Chrome's own CDP discovery endpoint, so
// omp's ordinary `connected`/`relay`-kind `puppeteer.connect({ browserURL
// })` path (notes/browser.md §2) works against it unchanged; the piece this
// module actually owns is standing that server up (a plain `omp
// browser-relay` subprocess — the same CLI surface a user could run by
// hand) and, per `browser_set_relay`'s doc comment, the persisted config
// that makes an omp session pick relay mode at all.
// ═══════════════════════════════════════════════════════════════════════

/// Default port of the `omp browser-relay` endpoint — kept in sync with
/// `DEFAULT_RELAY_PORT` (`commands/browser-relay.ts`) / `DEFAULT_RELAY_URL`
/// (`tools/browser/relay/kind.ts`). Not user-configurable in v1: every
/// session shares one relay daemon, matching omp's own machine-global-
/// singleton design for it (`relay/daemon.ts`'s file doc).
const DEFAULT_RELAY_PORT: u16 = 9224;

/// Mirrors `relay/daemon.ts`'s `PROBE_TIMEOUT_MS`.
const RELAY_PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Mirrors `relay/daemon.ts`'s `READY_TIMEOUT_MS` for the *daemon's own*
/// startup — separate from, and much shorter than, the up-to-35s an omp
/// session waits for the browser-relay *extension* to complete its
/// handshake once the server is already up (`registry.ts`'s
/// `RELAY_EXTENSION_WAIT_MS`, notes/browser.md §6). This module only needs
/// to know the server bound its port, not that a human's browser has
/// attached yet.
const RELAY_LAUNCH_TIMEOUT: Duration = Duration::from_secs(15);

/// Info the frontend needs to reflect the Relay toggle's state — the
/// `sessionId`-scoped mirror of `BrowserInfo` for the T9 app-owned
/// Chromium. `cdpUrl`/`extensionEndpoint` are `null` once disabled.
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub session_id: String,
    pub enabled: bool,
    /// `http://127.0.0.1:9224` while enabled — the same HTTP CDP-discovery
    /// form omp's `connected`/`relay` kinds require (mirrors
    /// `BrowserInfo::cdp_url`; `relay/kind.ts`'s `DEFAULT_RELAY_URL`).
    pub cdp_url: Option<String>,
    /// `ws://127.0.0.1:9224/ext` — what the browser-relay Chrome extension
    /// dials into (`relay/protocol.ts`).
    pub extension_endpoint: Option<String>,
    /// True once the extension has completed its handshake: the relay's
    /// `GET /json/version` answers `200` rather than `503`
    /// (`relay/server.ts`).
    pub extension_connected: bool,
}

/// One relay daemon per port: the `browser-relay` server the extension
/// dials into (`relay/server.ts`). Machine-global by omp's own design — any
/// project's omp session, or a user running `omp browser-relay` by hand,
/// may already own it — so membership is tracked by which `sessionId`s
/// currently want relay mode on, making a duplicate enable for an
/// already-counted session, or a disable for one that never enabled, a safe
/// no-op rather than a double-count or underflow.
#[derive(Default)]
struct RelayDaemon {
    /// `Some` only when this struct spawned (and therefore owns the
    /// lifecycle of) the child process; adopted external/omp-lazy-started
    /// daemons are never touched (notes/browser.md §2: "connected and relay
    /// browsers belong to the user: drop our CDP link, never kill").
    child: Option<Child>,
    sessions: HashSet<String>,
}

impl Drop for RelayDaemon {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Toggle a session's browser between the app-owned connected Chromium (T9,
/// ADR-0006) and omp's `relay` kind. Enabling stands up the relay server the
/// browser-relay extension connects to (adopting one already running rather
/// than binding a second) and persists `browser.relay` — which omp's own
/// settings resolution checks *before* `browser.cdpUrl`
/// (`config/settings-schema.ts:4509-4519`: "Takes precedence over Browser
/// CDP URL") — so new omp sessions default to it. Disabling is the mirror
/// image: once no session wants relay, the persisted setting is reset and,
/// if this app spawned the daemon, it is torn down (`RelayDaemon::drop`).
///
/// omp has no RPC command for mutating a *running* session's settings (see
/// `browser_set_relay`'s doc comment), so a session already streaming when
/// this is called keeps whatever kind it resolved at its own startup — the
/// same, already-accepted gap `set_connected_cdp_config` documents for T9's
/// `connected` CDP URL. `sessionId` is accepted now so every call site is
/// ready the moment a per-running-session config lever exists.
#[tauri::command]
#[specta::specta]
pub fn browser_set_relay(
    app: AppHandle,
    state: State<'_, BrowserState>,
    session_id: String,
    enabled: bool,
) -> Result<RelayInfo, BrowserError> {
    if !enabled {
        return disable_relay(&app, &state, &session_id);
    }

    {
        let mut relay = state.relay.lock();
        if let Some(daemon) = relay.get_mut(&DEFAULT_RELAY_PORT) {
            if !daemon.sessions.is_empty() {
                daemon.sessions.insert(session_id.clone());
                let status = probe_relay_status(DEFAULT_RELAY_PORT, RELAY_PROBE_TIMEOUT);
                return Ok(relay_info(session_id, status));
            }
        }
    }

    // First session (of possibly several) to ask for relay: bring the
    // daemon up and flip the persisted config outside the lock — mirrors
    // `browser_launch` spawning Chromium before taking `state.sessions`.
    let (omp_path, _source) =
        crate::omp::resolve_omp_path(&app).map_err(|e| BrowserError::RelayLaunchFailed {
            message: e.to_string(),
        })?;
    let child = ensure_relay_daemon(&omp_path, DEFAULT_RELAY_PORT)?;
    crate::config::set_value(&app, "browser.relay", "true").map_err(|e| {
        BrowserError::RelayConfigFailed {
            message: e.to_string(),
        }
    })?;

    let mut relay = state.relay.lock();
    let daemon = relay.entry(DEFAULT_RELAY_PORT).or_default();
    if daemon.sessions.is_empty() {
        daemon.child = child;
    } else if child.is_some() {
        // Lost a race with a concurrent enable for a different session that
        // already finished (`daemon.sessions` is non-empty): drop our
        // now-redundant daemon rather than leaking a second relay process.
        drop(RelayDaemon {
            child,
            sessions: HashSet::new(),
        });
    }
    daemon.sessions.insert(session_id.clone());

    let status = probe_relay_status(DEFAULT_RELAY_PORT, RELAY_PROBE_TIMEOUT);
    Ok(relay_info(session_id, status))
}

fn relay_info(session_id: String, status: Option<u16>) -> RelayInfo {
    RelayInfo {
        session_id,
        enabled: true,
        cdp_url: Some(format!("http://127.0.0.1:{DEFAULT_RELAY_PORT}")),
        extension_endpoint: Some(format!("ws://127.0.0.1:{DEFAULT_RELAY_PORT}/ext")),
        extension_connected: status == Some(200),
    }
}

fn disable_relay(
    app: &AppHandle,
    state: &BrowserState,
    session_id: &str,
) -> Result<RelayInfo, BrowserError> {
    let now_empty = {
        let mut relay = state.relay.lock();
        match relay.get_mut(&DEFAULT_RELAY_PORT) {
            Some(daemon) => {
                daemon.sessions.remove(session_id);
                daemon.sessions.is_empty()
            }
            None => false,
        }
    };
    if now_empty {
        // Drop tears down the child if we own it (`RelayDaemon::drop`); an
        // adopted external/omp-lazy-started daemon is left running for
        // whoever else might still be using it.
        state.relay.lock().remove(&DEFAULT_RELAY_PORT);
        crate::config::reset_value(app, "browser.relay").map_err(|e| {
            BrowserError::RelayConfigFailed {
                message: e.to_string(),
            }
        })?;
    }
    Ok(RelayInfo {
        session_id: session_id.to_string(),
        enabled: false,
        cdp_url: None,
        extension_endpoint: None,
        extension_connected: false,
    })
}

/// Ensure a relay daemon answers at `port`, adopting one that is already
/// serving — manually started, left behind by a previous toggle, or lazily
/// started by an omp session's own `ensureRelayDaemon` — rather than
/// fighting it for the bind (`relay/daemon.ts`'s own philosophy: "a
/// manually started relay may already own the port ... adopt that external
/// server without attempting another bind"). Returns `Some(child)` only
/// when this call's own spawn is the process now bound to `port`; `None`
/// for every adopted case, so the caller never kills a daemon another
/// consumer still needs.
fn ensure_relay_daemon(omp_path: &Path, port: u16) -> Result<Option<Child>, BrowserError> {
    if probe_relay_status(port, RELAY_PROBE_TIMEOUT).is_some() {
        return Ok(None);
    }
    match spawn_relay_daemon(omp_path, port) {
        Ok(child) => Ok(Some(child)),
        Err(launch_err) => {
            // Lost a bind race (ours or a manual `omp browser-relay`)
            // between the probe above and our own spawn attempt; adopt
            // whichever process won rather than failing a toggle that,
            // from the user's perspective, should just work now.
            if probe_relay_status(port, RELAY_PROBE_TIMEOUT).is_some() {
                Ok(None)
            } else {
                Err(launch_err)
            }
        }
    }
}

/// Spawns `omp browser-relay --port <port>` and waits for its ready banner
/// (`cli/browser-relay-cli.ts`'s `runServe`: `"omp browser relay listening
/// on http://…"`, matching `relay/daemon.ts`'s own `READY_LOG_PATTERN`). A
/// losing EADDRINUSE race prints "already running; nothing to do" and exits
/// 0 *without* that banner — indistinguishable here from any other early
/// exit, which is fine: either way the caller re-probes and adopts.
fn spawn_relay_daemon(omp_path: &Path, port: u16) -> Result<Child, BrowserError> {
    let mut child = Command::new(omp_path)
        .args(["browser-relay", "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BrowserError::RelayLaunchFailed {
            message: format!("failed to spawn {} browser-relay: {e}", omp_path.display()),
        })?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            #[cfg(debug_assertions)]
            eprintln!("[browser-relay stderr] {line}");
        }
    });

    let (banner_tx, banner_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            #[cfg(debug_assertions)]
            eprintln!("[browser-relay stdout] {line}");
            if line.contains("browser relay listening on http://") {
                let _ = banner_tx.send(());
                break;
            }
        }
        // Dropping `banner_tx` here — whether or not it fired — lets
        // `recv_timeout` observe a disconnect the instant stdout closes,
        // rather than waiting out the full timeout on a child that has
        // already exited.
    });

    match banner_rx.recv_timeout(RELAY_LAUNCH_TIMEOUT) {
        Ok(()) => Ok(child),
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(BrowserError::RelayLaunchFailed {
                message: "omp browser-relay did not report readiness in time".into(),
            })
        }
    }
}

/// Bare HTTP/1.1 GET against the relay's CDP-discovery endpoint, mirroring
/// `probeRelayServer` (`relay/daemon.ts`): any response at all — `200` once
/// the extension has connected, `503` while still waiting for it
/// (`relay/server.ts`'s `/json/version` handler) — means a relay is
/// genuinely listening. `None` means nothing answered (connection refused,
/// or no response within `timeout`), the sole signal that it is safe to
/// attempt our own launch. No new dependency for this: a single GET against
/// a fixed loopback path is exactly the "tiny surface, hand-rolled" seam
/// ADR-0007 already establishes for this module's CDP traffic.
fn probe_relay_status(port: u16, timeout: Duration) -> Option<u16> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut stream = SyncTcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    stream
        .write_all(
            format!(
                "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    String::from_utf8_lossy(&response)
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A unique, existing temp file (stands in for a Chromium binary),
    /// cleaned up via `Drop`.
    struct TempFile(PathBuf);
    impl TempFile {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("omp-gui-chromium-test-{name}-{nanos}"));
            std::fs::write(&path, b"").unwrap();
            Self(path)
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            std::fs::remove_file(&self.0).ok();
        }
    }

    #[test]
    fn env_override_wins_over_preference_and_cache() {
        let env_path = TempFile::new("env");
        let pref_path = TempFile::new("pref");

        let (found, source) = resolve_chromium_source(
            Some(env_path.0.clone()),
            Some(pref_path.0.to_str().unwrap()),
            || panic!("cache_lookup must not run when the env override resolves"),
        );
        assert_eq!(found, Some(env_path.0.clone()));
        assert_eq!(source, ChromiumSource::Env);
    }

    #[test]
    fn preference_wins_over_cache_when_env_is_unset() {
        let pref_path = TempFile::new("pref2");

        let (found, source) =
            resolve_chromium_source(None, Some(pref_path.0.to_str().unwrap()), || {
                panic!("cache_lookup must not run when the preference resolves")
            });
        assert_eq!(found, Some(pref_path.0.clone()));
        assert_eq!(source, ChromiumSource::Preference);
    }

    #[test]
    fn a_missing_env_override_falls_through_to_preference() {
        let pref_path = TempFile::new("pref3");

        let (found, source) = resolve_chromium_source(
            Some(PathBuf::from("/nonexistent/omp-gui-chromium-env-override")),
            Some(pref_path.0.to_str().unwrap()),
            || panic!("cache_lookup must not run when the preference resolves"),
        );
        assert_eq!(found, Some(pref_path.0.clone()));
        assert_eq!(source, ChromiumSource::Preference);
    }

    #[test]
    fn a_missing_preference_falls_through_to_cache() {
        let cache_path = TempFile::new("cache");
        let cache_path_clone = cache_path.0.clone();

        let (found, source) = resolve_chromium_source(
            None,
            Some("/nonexistent/omp-gui-chromium-preference"),
            move || Some(cache_path_clone.clone()),
        );
        assert_eq!(found, Some(cache_path.0.clone()));
        assert_eq!(source, ChromiumSource::Cache);
    }

    #[test]
    fn nothing_resolved_anywhere_is_none() {
        let (found, source) = resolve_chromium_source(None, None, || None);
        assert_eq!(found, None);
        assert_eq!(source, ChromiumSource::None);
    }
}
