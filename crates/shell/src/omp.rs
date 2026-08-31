//! Spawn and byte-pipe the pinned `omp --mode rpc-ui` subprocess (ADR-0001, ADR-0007).
//!
//! Rust owns the raw NDJSON pipes only — every protocol concern (framing,
//! negotiation, command correlation) lives in the TypeScript frontend.

use parking_lot::Mutex;
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use tauri::{AppHandle, Emitter, Manager, State};

/// The bundled pin, embedded at build time (ADR-0004). Bumped only via the
/// weekly smoke gate (ADR-0008).
const PIN: &str = include_str!("../../../omp-pin.json");

/// Environment variable power users point at their own omp install (ADR-0004).
const OVERRIDE_ENV: &str = "OMP_GUI_OMP_PATH";

/// Raw NDJSON line received on the subprocess's stdout.
pub const EVENT_FRAME: &str = "omp:frame";
/// The subprocess exited (payload: exit code, or -1 on signal).
pub const EVENT_EXIT: &str = "omp:exit";

fn pinned_version() -> String {
    serde_json::from_str::<serde_json::Value>(PIN)
        .ok()
        .and_then(|v| v.get("version")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

/// Where the omp binary was resolved from, in priority order (ADR-0004).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum OmpBinarySource {
    /// `OMP_GUI_OMP_PATH` power-user override.
    Override,
    /// Repo-local download from `scripts/fetch-omp.mjs` (development).
    DevBinary,
    /// Binary bundled into the app at build time.
    Bundled,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OmpStartInfo {
    pub version: String,
    pub path: String,
    pub source: OmpBinarySource,
}

fn resolve_omp_path(app: &AppHandle) -> Result<(PathBuf, OmpBinarySource), String> {
    if let Ok(path) = std::env::var(OVERRIDE_ENV) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok((path, OmpBinarySource::Override));
        }
        return Err(format!("{OVERRIDE_ENV} points at a missing file"));
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/omp");
    if dev.is_file() {
        return Ok((dev, OmpBinarySource::DevBinary));
    }

    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("binaries/omp");
    if bundled.is_file() {
        return Ok((bundled, OmpBinarySource::Bundled));
    }

    Err("no omp binary found; run `node scripts/fetch-omp.mjs` or set OMP_GUI_OMP_PATH".into())
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
    child: Mutex<Option<OmpChild>>,
}

/// Spawn the pinned omp binary as an rpc-ui subprocess and start piping raw
/// NDJSON stdout lines to the frontend as `omp:frame` events.
#[tauri::command]
pub fn omp_start(app: AppHandle, state: State<'_, OmpState>) -> Result<OmpStartInfo, String> {
    let (path, source) = resolve_omp_path(&app)?;

    // One process = one session (ADR-0005); T1 drives a single session, so a
    // fresh start replaces any live child.
    state.child.lock().take();

    let cwd = app.path().home_dir().map_err(|e| e.to_string())?;
    let mut child = Command::new(&path)
        .args(["--mode", "rpc-ui"])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", path.display()))?;

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
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[omp stdout] {line}");
                    let _ = exit_app.emit(EVENT_FRAME, line);
                }
                Err(_) => break,
            }
        }
        let _ = exit_app.emit(EVENT_EXIT, ());
    });

    *state.child.lock() = Some(OmpChild {
        stdin: child.stdin.take().expect("stdin piped"),
        child,
    });

    Ok(OmpStartInfo {
        version: pinned_version(),
        path: path.display().to_string(),
        source,
    })
}

/// Write one NDJSON command line to the subprocess's stdin.
#[tauri::command]
pub fn omp_send(state: State<'_, OmpState>, line: String) -> Result<(), String> {
    eprintln!("[omp stdin] {line}");
    let mut guard = state.child.lock();
    let child = guard.as_mut().ok_or("no omp session running")?;
    child
        .stdin
        .write_all(line.as_bytes())
        .and_then(|()| child.stdin.write_all(b"\n"))
        .and_then(|()| child.stdin.flush())
        .map_err(|e| format!("failed to write to omp stdin: {e}"))
}

/// Kill the running omp subprocess, if any.
#[tauri::command]
pub fn omp_kill(state: State<'_, OmpState>) -> Result<(), String> {
    state.child.lock().take();
    Ok(())
}
