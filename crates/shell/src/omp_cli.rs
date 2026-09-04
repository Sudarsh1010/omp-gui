//! Shared omp CLI shell-out helper (ADR-0011): the single lever every
//! omp-backed Shell Bridge module — `config.rs` (#24), and later the auth
//! and models bridges (#25, #27) — invokes the pinned binary through.
//! `run_omp_cli` resolves the binary the same way a session would
//! (`omp::resolve_omp_path`) and pins the working directory to a
//! guaranteed-empty scratch directory so omp's project-layer discovery
//! (`.omp/config.yml`, `.omp/settings.json`, `.claude/settings.json` under
//! `cwd`) can never merge a project file into a value this module reads or
//! writes globally — ADR-0011's "Scope is global-only" paragraph.
//!
//! A non-zero exit is omp's own schema validation speaking (`Rejected`),
//! never a transport failure; failing to resolve, spawn, or parse the
//! binary's output is `Unavailable`, naming the stage. Every omp-backed
//! bridge command rejects with this same `CliError` — there is no
//! per-module error enum for the omp-CLI seam (unlike `BridgeError`/
//! `BrowserError`/`PreferencesError`, which each guard a different failure
//! surface).

use serde::Serialize;
use serde::de::DeserializeOwned;
use specta::Type;
use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

/// Raw result of one `run_omp_cli` invocation.
pub(crate) struct CliOutput {
    pub stdout: String,
    #[allow(dead_code)]
    pub stderr: String,
    #[allow(dead_code)]
    pub status: i32,
}

/// Which step of an omp CLI shell-out failed. `Exit` is part of the
/// contract shape (mirrored by the smoke-test routine's own stage enum,
/// #23) even though `run_omp_cli` itself never constructs it — a non-zero
/// exit is always `CliError::Rejected`, omp's own validation speaking,
/// never a transport-stage failure.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CliStage {
    Resolve,
    Spawn,
    #[allow(dead_code)]
    Exit,
    Parse,
}

/// Errors from an omp CLI shell-out. Every omp-backed bridge command
/// (config, auth, models) rejects with this — see the module doc.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum CliError {
    /// omp could not be resolved, spawned, or its output parsed — a
    /// binary/environment problem, not a value the user typed.
    Unavailable { stage: CliStage, message: String },
    /// omp ran and exited non-zero: its own validation/usage error text.
    Rejected { message: String },
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable { stage, message } => {
                write!(f, "omp unavailable ({stage:?}): {message}")
            }
            Self::Rejected { message } => write!(f, "omp rejected: {message}"),
        }
    }
}

/// `<app_cache_dir>/omp-scratch`, wiped and recreated empty on every call.
/// Never the user's home directory or any real project path — a project's
/// `.claude/settings.json` there would silently shadow the global value
/// every one of these commands reads or writes (ADR-0011, note
/// `04-omp-cli-surface.md` §11's leak test).
fn scratch_dir(app: &AppHandle) -> Result<PathBuf, CliError> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| CliError::Unavailable {
            stage: CliStage::Resolve,
            message: format!("could not resolve the app cache directory: {e}"),
        })?;
    let scratch = cache_dir.join("omp-scratch");
    if scratch.exists() {
        fs::remove_dir_all(&scratch).map_err(|e| CliError::Unavailable {
            stage: CliStage::Resolve,
            message: format!("could not clear the omp scratch directory: {e}"),
        })?;
    }
    fs::create_dir_all(&scratch).map_err(|e| CliError::Unavailable {
        stage: CliStage::Resolve,
        message: format!("could not create the omp scratch directory: {e}"),
    })?;
    Ok(scratch)
}

/// Runs the resolved omp binary with `args`, `current_dir` pinned to the
/// scratch directory (see `scratch_dir`). Non-zero exit yields `Rejected`
/// carrying omp's own stderr (falling back to stdout when stderr is
/// empty), trimmed — that is omp's validation talking, not a spawn
/// failure.
pub(crate) fn run_omp_cli(app: &AppHandle, args: &[&str]) -> Result<CliOutput, CliError> {
    let (omp_path, _source) =
        crate::omp::resolve_omp_path(app).map_err(|e| CliError::Unavailable {
            stage: CliStage::Resolve,
            message: e.to_string(),
        })?;
    let scratch = scratch_dir(app)?;
    let output = Command::new(&omp_path)
        .args(args)
        .current_dir(&scratch)
        .output()
        .map_err(|e| CliError::Unavailable {
            stage: CliStage::Spawn,
            message: format!("failed to spawn {}: {e}", omp_path.display()),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let message = if !stderr.trim().is_empty() {
            stderr.trim()
        } else {
            stdout.trim()
        };
        return Err(CliError::Rejected {
            message: message.to_string(),
        });
    }
    Ok(CliOutput {
        stdout,
        stderr,
        status: output.status.code().unwrap_or(-1),
    })
}

/// `run_omp_cli`, then parses `stdout` as JSON into `T`. A parse failure —
/// omp exited 0 but its `--json` output didn't match this pin's expected
/// shape — is `Unavailable{stage: Parse}`, a version-skew signal rather
/// than a validation rejection.
pub(crate) fn run_omp_json<T: DeserializeOwned>(
    app: &AppHandle,
    args: &[&str],
) -> Result<T, CliError> {
    let output = run_omp_cli(app, args)?;
    serde_json::from_str(&output.stdout).map_err(|e| CliError::Unavailable {
        stage: CliStage::Parse,
        message: format!("failed to parse omp's JSON output: {e}"),
    })
}
