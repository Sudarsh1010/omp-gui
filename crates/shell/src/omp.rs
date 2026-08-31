//! Spawn and byte-pipe the pinned `omp --mode rpc-ui` subprocess (ADR-0001, ADR-0007).
//!
//! Rust owns the raw NDJSON pipes only — every protocol concern (framing,
//! negotiation, command correlation) lives in the TypeScript frontend.

use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use uuid::Uuid;

/// The bundled pin, embedded at build time (ADR-0004). Bumped only via the
/// weekly smoke gate (ADR-0008).
const PIN: &str = include_str!("../../../omp-pin.json");

/// Environment variable power users point at their own omp install (ADR-0004).
const OVERRIDE_ENV: &str = "OMP_GUI_OMP_PATH";

fn pinned_version() -> String {
    serde_json::from_str::<serde_json::Value>(PIN)
        .ok()
        .and_then(|v| v.get("version")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

/// Where the omp binary was resolved from, in priority order (ADR-0004).
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub enum OmpBinarySource {
    /// `OMP_GUI_OMP_PATH` power-user override.
    Override,
    /// Repo-local download from `scripts/fetch-omp.mjs` (development).
    DevBinary,
    /// Binary bundled into the app at build time.
    Bundled,
}

#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct OmpStartInfo {
    pub session_id: String,
    pub version: String,
    pub path: String,
    pub source: OmpBinarySource,
}

/// Typed payload for the `omp:frame` event.
#[derive(Serialize, Clone, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "omp:frame")]
pub struct OmpFrameEvent {
    pub session_id: String,
    pub line: String,
}

/// Typed payload for the `omp:exit` event.
#[derive(Serialize, Clone, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "omp:exit")]
pub struct OmpExitEvent {
    pub session_id: String,
    pub code: i32,
}

/// Errors returned from Shell Bridge commands.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum BridgeError {
    BinaryNotFound { message: String },
    SpawnFailed { message: String },
    WriteFailed { message: String },
    KillFailed { message: String },
    UnknownSession,
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BinaryNotFound { message } => write!(f, "binary not found: {message}"),
            Self::SpawnFailed { message } => write!(f, "spawn failed: {message}"),
            Self::WriteFailed { message } => write!(f, "write failed: {message}"),
            Self::KillFailed { message } => write!(f, "kill failed: {message}"),
            Self::UnknownSession => write!(f, "unknown session"),
        }
    }
}

fn resolve_omp_path(app: &AppHandle) -> Result<(PathBuf, OmpBinarySource), BridgeError> {
    if let Ok(path) = std::env::var(OVERRIDE_ENV) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok((path, OmpBinarySource::Override));
        }
        return Err(BridgeError::BinaryNotFound {
            message: format!("{OVERRIDE_ENV} points at a missing file"),
        });
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/omp");
    if dev.is_file() {
        return Ok((dev, OmpBinarySource::DevBinary));
    }

    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| BridgeError::BinaryNotFound {
            message: e.to_string(),
        })?
        .join("binaries/omp");
    if bundled.is_file() {
        return Ok((bundled, OmpBinarySource::Bundled));
    }

    Err(BridgeError::BinaryNotFound {
        message:
            "no omp binary found; run `node scripts/fetch-omp.mjs` or set OMP_GUI_OMP_PATH"
                .into(),
    })
}

struct OmpChild {
    stdin: ChildStdin,
    child: Child,
}

impl Drop for OmpChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct OmpState {
    children: Mutex<HashMap<String, OmpChild>>,
}

/// Spawn the pinned omp binary as an rpc-ui subprocess and start piping raw
/// NDJSON stdout lines to the frontend as `omp:frame` events.
#[tauri::command]
#[specta::specta]
pub fn omp_start(
    app: AppHandle,
    state: State<'_, OmpState>,
) -> Result<OmpStartInfo, BridgeError> {
    let (path, source) = resolve_omp_path(&app)?;
    let cwd = app.path().home_dir().map_err(|e| BridgeError::SpawnFailed {
        message: e.to_string(),
    })?;

    let mut child = Command::new(&path)
        .args(["--mode", "rpc-ui"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| BridgeError::SpawnFailed {
            message: format!("failed to spawn {}: {e}", path.display()),
        })?;

    let session_id = Uuid::new_v4().to_string();

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[omp stderr] {line}");
                }
                Err(_) => break,
            }
        }
    });

    let exit_app = app.clone();
    let exit_session_id = session_id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[omp stdout] {line}");
                    let _ = OmpFrameEvent {
                        session_id: exit_session_id.clone(),
                        line,
                    }
                    .emit(&exit_app);
                }
                Err(_) => break,
            }
        }

        let code = {
            let state = exit_app.state::<OmpState>();
            let mut children = state.children.lock();
            if let Some(mut child) = children.remove(&exit_session_id) {
                child.child.wait().ok().and_then(|s| s.code()).unwrap_or(-1)
            } else {
                -1
            }
        };

        let _ = OmpExitEvent {
            session_id: exit_session_id,
            code,
        }
        .emit(&exit_app);
    });

    state.children.lock().insert(
        session_id.clone(),
        OmpChild {
            stdin: child.stdin.take().expect("stdin piped"),
            child,
        },
    );

    Ok(OmpStartInfo {
        session_id,
        version: pinned_version(),
        path: path.display().to_string(),
        source,
    })
}

/// Write one NDJSON command line to the subprocess's stdin.
#[tauri::command]
#[specta::specta]
pub fn omp_send(
    state: State<'_, OmpState>,
    session_id: String,
    line: String,
) -> Result<(), BridgeError> {
    eprintln!("[omp stdin] {line}");
    let mut children = state.children.lock();
    let child = children
        .get_mut(&session_id)
        .ok_or(BridgeError::UnknownSession)?;
    child
        .stdin
        .write_all(line.as_bytes())
        .and_then(|()| child.stdin.write_all(b"\n"))
        .and_then(|()| child.stdin.flush())
        .map_err(|e| BridgeError::WriteFailed {
            message: format!("failed to write to omp stdin: {e}"),
        })
}

/// Kill the running omp subprocess for the given session.
#[tauri::command]
#[specta::specta]
pub fn omp_kill(
    app: AppHandle,
    state: State<'_, OmpState>,
    session_id: String,
) -> Result<(), BridgeError> {
    let mut children = state.children.lock();
    let mut child = children
        .remove(&session_id)
        .ok_or(BridgeError::UnknownSession)?;
    child
        .child
        .kill()
        .and_then(|()| child.child.wait())
        .map_err(|e| BridgeError::KillFailed {
            message: format!("failed to kill omp session: {e}"),
        })?;

    let _ = OmpExitEvent {
        session_id,
        code: -1,
    }
    .emit(&app);
    Ok(())
}
