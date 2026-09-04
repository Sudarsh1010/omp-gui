//! Spawn and byte-pipe the pinned `omp --mode rpc-ui` subprocess (ADR-0001, ADR-0007).
//!
//! Rust owns the raw NDJSON pipes only — every protocol concern (framing,
//! negotiation, command correlation) lives in the TypeScript frontend.

use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
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

/// Crate-visible (not just this file's) so `browser.rs`'s relay daemon
/// (T11) can spawn the same pinned `omp browser-relay`/`omp config`
/// invocations against the exact binary a session would use, without a
/// second, driftable copy of this resolution order (ADR-0004).
pub(crate) fn resolve_omp_path(app: &AppHandle) -> Result<(PathBuf, OmpBinarySource), BridgeError> {
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
        message: "no omp binary found; run `node scripts/fetch-omp.mjs` or set OMP_GUI_OMP_PATH"
            .into(),
    })
}

/// Where `resolve_start_cwd` picked the spawn cwd from. Not itself
/// serialized to the frontend — `omp_start` only needs the resolved
/// `PathBuf` — but `preferences_effective` (#22, `preferences.rs`) calls
/// this same function with `requested: None` and maps `Preference`/
/// `Home`/`Fallback` onto its own specta-typed `WorkingDirectorySource`,
/// so this one function is the single source of truth both consult.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartCwdSource {
    /// `requested` named an existing directory (a resume's recorded cwd).
    Requested,
    /// The App Preferences `defaultWorkingDirectory` named an existing
    /// directory.
    Preference,
    /// No preference was set at all.
    Home,
    /// A preference was set but no longer names an existing directory.
    Fallback,
}

/// Pure resolution of a fresh (or resuming) session's spawn cwd: an
/// explicit `requested` directory always wins when it exists — this is
/// the resume-cwd guard `omp_start`'s doc comment describes, so a resume
/// is never redirected by the default-working-directory preference below
/// it. Otherwise a non-empty, existing `preferred` directory (#22's App
/// Preferences `defaultWorkingDirectory`) wins; a non-empty `preferred`
/// that no longer exists on disk falls back to `home` (`Fallback`, kept
/// distinct from `Home` so `preferences_effective` can show the user why);
/// no preference at all is plain `Home`.
pub(crate) fn resolve_start_cwd(
    requested: Option<&str>,
    preferred: Option<&str>,
    home: &Path,
) -> (PathBuf, StartCwdSource) {
    if let Some(dir) = requested {
        let trimmed = dir.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
            return (PathBuf::from(trimmed), StartCwdSource::Requested);
        }
    }
    match preferred.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) if Path::new(dir).is_dir() => (PathBuf::from(dir), StartCwdSource::Preference),
        Some(_) => (home.to_path_buf(), StartCwdSource::Fallback),
        None => (home.to_path_buf(), StartCwdSource::Home),
    }
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

impl OmpState {
    /// PIDs of every subprocess this app currently has running, for
    /// `sessions::probe_foreign_session_lock` to exclude from its
    /// foreign-lock scan (ADR-0005): a PID we spawned ourselves isn't
    /// "another live process" even though it does hold the session file
    /// open.
    pub(crate) fn child_pids(&self) -> HashSet<u32> {
        self.children
            .lock()
            .values()
            .map(|c| c.child.id())
            .collect()
    }
}

/// Spawn the pinned omp binary as an rpc-ui subprocess and start piping raw
/// NDJSON stdout lines to the frontend as `omp:frame` events.
///
/// `cwd` sets the subprocess working directory. Callers pass the recorded
/// cwd of a session they are about to resume so omp's `switch_session` guard
/// (which refuses a resume whose recorded cwd differs from the live process
/// cwd, since the rpc-ui protocol has no cwd-change opt-in) accepts it.
/// When omitted, empty, or naming a path that is not an existing directory
/// (a fresh session), falls back to the App Preferences
/// `defaultWorkingDirectory` (#22) when that names an existing directory,
/// else the user's home directory — see `resolve_start_cwd`.
#[tauri::command]
#[specta::specta]
pub fn omp_start(
    app: AppHandle,
    state: State<'_, OmpState>,
    cwd: Option<String>,
) -> Result<OmpStartInfo, BridgeError> {
    let (path, source) = resolve_omp_path(&app)?;
    let preferred_cwd = crate::preferences::load_preferences(&app).default_working_directory;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| BridgeError::SpawnFailed {
            message: e.to_string(),
        })?;
    let (cwd, _cwd_source) = resolve_start_cwd(cwd.as_deref(), preferred_cwd.as_deref(), &home);

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

    let event_app = app.clone();
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
                    .emit(&event_app);
                }
                Err(_) => break,
            }
        }

        let code = {
            let state = event_app.state::<OmpState>();
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
        .emit(&event_app);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A unique, existing temp directory, cleaned up via `Drop`.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("omp-gui-omp-test-{name}-{nanos}"));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn requested_wins_over_preference_and_home() {
        let requested = TempDir::new("requested");
        let preferred = TempDir::new("preferred");
        let home = TempDir::new("home");

        let (cwd, source) = resolve_start_cwd(
            Some(requested.0.to_str().unwrap()),
            Some(preferred.0.to_str().unwrap()),
            &home.0,
        );
        assert_eq!(cwd, requested.0);
        assert_eq!(source, StartCwdSource::Requested);
    }

    #[test]
    fn a_missing_requested_directory_falls_through_to_preference() {
        let preferred = TempDir::new("preferred2");
        let home = TempDir::new("home2");

        let (cwd, source) = resolve_start_cwd(
            Some("/nonexistent/omp-gui-requested-should-never-exist"),
            Some(preferred.0.to_str().unwrap()),
            &home.0,
        );
        assert_eq!(cwd, preferred.0);
        assert_eq!(source, StartCwdSource::Preference);
    }

    #[test]
    fn no_requested_and_no_preference_falls_back_to_home() {
        let home = TempDir::new("home3");

        let (cwd, source) = resolve_start_cwd(None, None, &home.0);
        assert_eq!(cwd, home.0);
        assert_eq!(source, StartCwdSource::Home);
    }

    #[test]
    fn a_preference_naming_a_missing_directory_falls_back_to_home_as_fallback() {
        let home = TempDir::new("home4");

        let (cwd, source) = resolve_start_cwd(
            None,
            Some("/nonexistent/omp-gui-preference-should-never-exist"),
            &home.0,
        );
        assert_eq!(cwd, home.0);
        assert_eq!(source, StartCwdSource::Fallback);
    }

    #[test]
    fn blank_requested_and_preference_strings_are_treated_as_unset() {
        let home = TempDir::new("home5");

        let (cwd, source) = resolve_start_cwd(Some("   "), Some(""), &home.0);
        assert_eq!(cwd, home.0);
        assert_eq!(source, StartCwdSource::Home);
    }
}
