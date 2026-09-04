//! Shared launch-time protocol smoke test (ADR-0004, ADR-0008): spawns a
//! candidate `omp` binary in `--mode rpc-ui`, waits for the `ready` frame,
//! negotiates protocol v2 when advertised, completes one canned
//! `get_state` command round trip, then kills the process. This is the one
//! Rust copy of that sequence, reused by (1) the omp binary override gate
//! (`omp_smoke_test`/`omp_override_commit` in `omp.rs`) before a custom
//! path is ever committed to App Preferences, and (2) the pin-bump CI
//! gate's `cargo test -p shell smoke` (the unit tests below) — so a broken
//! release is caught without spinning up the TypeScript IPC package at
//! all, alongside (not instead of) `platform/ipc/src/session/smoke.test.ts`'s
//! own protocol suite.
//!
//! Mirrors `platform/ipc/src/session/session.ts`'s `RpcSession.start`/
//! `command` framing (wait for `ready` -> `negotiate_protocol` if v2 is
//! advertised -> one command/response round trip) but stays deliberately
//! minimal: no chunk reassembly, no event bus, no retries, no imported
//! wire types -- this is a go/no-go gate over a handful of stable frames,
//! not a session (the "tiny, stable surface -> Rust" placement rule ADR-0007
//! already uses for the pane's CDP client).
//!
//! The candidate binary runs with `PI_CODING_AGENT_DIR` pointed at a fresh,
//! empty temp directory and `current_dir` set to another empty temp
//! directory, so a smoke test never touches the user's real `~/.omp` agent
//! store, credentials, or project config, and never leaves a session file
//! anywhere the user would see it (ADR-0004: "a candidate under test is
//! never used for anything else"). Both scratch directories are removed
//! when the test finishes, whether it passed or failed.

use serde::Serialize;
use serde_json::{Value, json};
use specta::Type;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Per-stage timeout: generous enough for a cold-started real omp binary,
/// tight enough that a hung or non-responsive candidate fails fast.
const STAGE_TIMEOUT: Duration = Duration::from_secs(10);

/// Which step of the smoke sequence failed, serialized lowercase so it
/// reads as machine truth (Geist Mono, red-on-wash) in the override row
/// rather than prose.
#[derive(Debug, Clone, Copy, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SmokeStage {
    /// The process could not be spawned at all (missing file, not
    /// executable, permission denied).
    Launch,
    /// The process spawned but never produced a valid `ready` frame within
    /// the timeout (exited early, wrote garbage, or hung).
    Ready,
    /// The `ready` frame arrived (and protocol v2 was negotiated when
    /// advertised) but the canned `get_state` command never received a
    /// correlated, successful response within the timeout.
    RoundTrip,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    /// The negotiated omp version, from `<path> --version`; falls back to
    /// the `ready` frame's own `version` field (if present) when the
    /// `--version` invocation itself fails.
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SmokeFailure {
    pub stage: SmokeStage,
    pub message: String,
}

impl SmokeFailure {
    fn new(stage: SmokeStage, message: impl Into<String>) -> Self {
        Self { stage, message: message.into() }
    }
}

/// A directory under the OS temp root, removed on drop regardless of how
/// the smoke test exits. No new dependency: `uuid` (already a workspace
/// dependency) keeps the name collision-free across concurrent smoke runs.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(label: &str) -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("omp-gui-smoke-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs the shared smoke sequence against `path`. Never mutates anything
/// outside the two scratch temp directories it creates and removes.
pub(crate) fn smoke_test(path: &Path) -> Result<SmokeReport, SmokeFailure> {
    let cwd = ScratchDir::new("cwd").map_err(|e| {
        SmokeFailure::new(SmokeStage::Launch, format!("could not create a scratch working directory: {e}"))
    })?;
    let agent_dir = ScratchDir::new("agent-dir").map_err(|e| {
        SmokeFailure::new(SmokeStage::Launch, format!("could not create a scratch agent directory: {e}"))
    })?;

    let mut child = Command::new(path)
        .arg("--mode")
        .arg("rpc-ui")
        .current_dir(cwd.path())
        .env("PI_CODING_AGENT_DIR", agent_dir.path())
        // omp refuses to enter rpc-ui mode at all ("No models available")
        // unless some provider credential is visible, even though the
        // smoke sequence below never sends a `prompt` and so never makes a
        // real model call. A fixed placeholder unblocks that startup gate
        // without ever touching (or needing) the user's real credentials,
        // which live in their real `~/.omp` untouched by this scratch
        // `PI_CODING_AGENT_DIR` (ADR-0009).
        .env("ANTHROPIC_API_KEY", "sk-ant-omp-gui-smoke-test-placeholder")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| SmokeFailure::new(SmokeStage::Launch, format!("failed to launch {}: {e}", path.display())))?;

    let mut stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");

    // A background reader thread turns the blocking line-oriented pipe into
    // a channel the main thread can `recv_timeout` on, since std's
    // `BufRead::lines()` has no timeout of its own. The channel's sender is
    // dropped (closing it) the moment the reader thread's `for` loop ends,
    // which is exactly when the subprocess's stdout closes (it exited) --
    // that's how a silently-exiting fake binary is told apart from one
    // that's merely slow.
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let result = run_sequence(&mut stdin, &rx, path);
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn run_sequence(stdin: &mut impl Write, rx: &mpsc::Receiver<String>, path: &Path) -> Result<SmokeReport, SmokeFailure> {
    let ready = wait_for_ready(rx)?;

    let supported: Vec<i64> = ready
        .get("supportedProtocolVersions")
        .and_then(Value::as_array)
        .map(|versions| versions.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();

    if supported.contains(&2) {
        send_command(stdin, rx, json!({"type": "negotiate_protocol", "protocolVersion": 2, "id": "smoke-negotiate"}), "smoke-negotiate")?;
    } else if !supported.contains(&1) {
        return Err(SmokeFailure::new(
            SmokeStage::RoundTrip,
            format!("ready frame advertised no protocol version this app understands: {supported:?}"),
        ));
    }

    send_command(stdin, rx, json!({"type": "get_state", "id": "smoke-get-state"}), "smoke-get-state")?;

    let version = query_version(path)
        .or_else(|| ready.get("version").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_string());
    Ok(SmokeReport { version })
}

/// Waits for the first line that parses as JSON with `"type":"ready"`,
/// exactly like `session.ts`'s `RpcSession.start`: malformed lines and
/// non-`ready` frames arriving first are tolerated and skipped, not fatal.
fn wait_for_ready(rx: &mpsc::Receiver<String>) -> Result<Value, SmokeFailure> {
    let deadline = Instant::now() + STAGE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SmokeFailure::new(SmokeStage::Ready, "timed out waiting for the omp ready frame"));
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Ok(frame) = serde_json::from_str::<Value>(&line)
                    && frame.get("type").and_then(Value::as_str) == Some("ready")
                {
                    return Ok(frame);
                }
                // Malformed line or a non-ready frame arriving first: keep waiting.
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(SmokeFailure::new(SmokeStage::Ready, "timed out waiting for the omp ready frame"));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(SmokeFailure::new(SmokeStage::Ready, "the process exited before sending a ready frame"));
            }
        }
    }
}

/// Writes one NDJSON command line and waits for its correlated
/// `{"type":"response","id":<id>}` frame, ignoring any other frame that
/// arrives first (side-channel events, stray output) -- the same tolerance
/// `RpcSession.command` has for interleaved frames.
fn send_command(stdin: &mut impl Write, rx: &mpsc::Receiver<String>, cmd: Value, id: &str) -> Result<Value, SmokeFailure> {
    let line = serde_json::to_string(&cmd).expect("a smoke command literal always serializes");
    writeln!(stdin, "{line}")
        .and_then(|_| stdin.flush())
        .map_err(|e| SmokeFailure::new(SmokeStage::RoundTrip, format!("failed to write to stdin: {e}")))?;

    let deadline = Instant::now() + STAGE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SmokeFailure::new(SmokeStage::RoundTrip, format!("timed out waiting for a response to {id}")));
        }
        match rx.recv_timeout(remaining) {
            Ok(raw) => {
                let Ok(frame) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if frame.get("type").and_then(Value::as_str) == Some("response")
                    && frame.get("id").and_then(Value::as_str) == Some(id)
                {
                    let success = frame.get("success").and_then(Value::as_bool).unwrap_or(false);
                    if !success {
                        let message = frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("omp rejected the command")
                            .to_string();
                        return Err(SmokeFailure::new(SmokeStage::RoundTrip, message));
                    }
                    return Ok(frame);
                }
                // Any other frame (an event, or a response to a different
                // id) is ignored and waiting continues.
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(SmokeFailure::new(SmokeStage::RoundTrip, format!("timed out waiting for a response to {id}")));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(SmokeFailure::new(SmokeStage::RoundTrip, "the process exited mid round-trip"));
            }
        }
    }
}

/// Runs `<path> --version` and trims its stdout; `None` on any failure
/// (missing binary, non-zero exit, empty output). Shared with `omp.rs`'s
/// `omp_binary_info`, which additionally caches the result per path.
pub(crate) fn query_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() { None } else { Some(version) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev_binary() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/omp")
    }

    #[test]
    fn bundled_binary_passes_and_reports_its_version() {
        let path = dev_binary();
        assert!(path.is_file(), "expected the pinned dev binary at {}", path.display());

        let report = smoke_test(&path).expect("the pinned omp binary must pass its own smoke test");
        assert!(report.version.contains("18.1.10"), "unexpected version string: {}", report.version);
    }

    #[test]
    fn nonexistent_path_fails_at_launch() {
        let path = std::env::temp_dir().join(format!("omp-gui-smoke-missing-{}", uuid::Uuid::new_v4()));
        let failure = smoke_test(&path).expect_err("a nonexistent path must fail the smoke test");
        assert_eq!(failure.stage, SmokeStage::Launch);
    }

    #[test]
    fn non_omp_executable_fails_at_launch_or_ready() {
        // `/bin/sh` (present on every POSIX host, including this NixOS
        // one where `/bin/true` doesn't exist) rejects the omp-style
        // `--mode rpc-ui` argument as an unrecognized option and exits
        // immediately with nothing on stdout -- a stand-in for "some
        // other binary that happens to be executable but is not omp",
        // exercising the Ready-stage path (the reader thread's channel
        // disconnects with no ready frame ever seen).
        let path = PathBuf::from("/bin/sh");
        assert!(path.is_file(), "expected /bin/sh to exist on a POSIX host");

        let failure = smoke_test(&path).expect_err("a non-omp executable must fail the smoke test");
        assert!(
            matches!(failure.stage, SmokeStage::Launch | SmokeStage::Ready),
            "expected Launch or Ready, got {:?}: {}",
            failure.stage,
            failure.message,
        );
    }
}
