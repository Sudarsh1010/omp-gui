//! Shared `omp` CLI shell-out helper (ADR-0011): the single subprocess
//! plumbing every Settings-page bridge command (`config` §C, `auth-broker`/
//! `token` §E, `models` §E) shells out through, so each ticket's
//! `omp <subcommand>` invocation is a thin caller over one guaranteed-empty
//! scratch cwd and one error shape, never a second, driftable copy. If two
//! tickets both add this file, the merger keeps one copy — every function
//! and type here is written to match exactly so either copy is
//! interchangeable.
//!
//! Every invocation runs with `current_dir` set to `<app_cache_dir>/
//! omp-scratch`, wiped and recreated before each call, so omp's
//! project-layer config discovery (`.omp/config.yml`, `.omp/settings.json`,
//! `.claude/settings.json` under cwd) can never merge a stray file into a
//! Settings-page read or write (ADR-0011 paragraph 3) — the same guarantee
//! `preferences.rs`'s App Preferences file sidesteps entirely by not being
//! omp-backed at all.

use serde::de::DeserializeOwned;
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

use crate::omp;

const SCRATCH_DIR: &str = "omp-scratch";

/// Raw result of one `omp` invocation, before any command-specific parsing.
/// `stderr`/`status` are unused by this ticket's own callers but kept for
/// every other `run_omp_cli` caller (#24's `config`, #27's `models`).
#[allow(dead_code)]
pub(crate) struct CliOutput {
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

/// The stage at which an `omp` CLI invocation failed to even produce a
/// result to validate — as opposed to `CliError::Rejected`, which is omp's
/// own validation/business-logic error for a request it fully understood.
/// `Exit` is reserved for a future caller distinguishing a clean non-zero
/// exit from a spawn/resolve failure; unconstructed here is expected.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CliStage {
    Resolve,
    Spawn,
    #[allow(dead_code)]
    Exit,
    Parse,
}

/// Errors returned from every omp-backed Shell Bridge command (`config`,
/// `auth-broker`/`token`, `models`) that shells out through
/// [`run_omp_cli`]/[`run_omp_json`]. `Unavailable` names the stage omp
/// itself could not be reached at (a per-section degrade trigger);
/// `Rejected` is omp's own error text for a request it understood but
/// refused — carried through to the UI verbatim, never rewritten.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum CliError {
    Unavailable { stage: CliStage, message: String },
    Rejected { message: String },
}

/// Guarantees `<app_cache_dir>/omp-scratch` exists and is empty before an
/// `omp` invocation runs with it as `current_dir` — never the user's home
/// or a real project directory, so no `.omp/config.yml`-style project layer
/// can ever shadow the global values a Settings-page call is reading or
/// writing (ADR-0011 paragraph 3).
fn ensure_scratch_dir(app: &AppHandle) -> Result<PathBuf, CliError> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| CliError::Unavailable {
            stage: CliStage::Resolve,
            message: format!("failed to resolve app cache dir: {e}"),
        })?;
    let scratch = cache_dir.join(SCRATCH_DIR);
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch).map_err(|e| CliError::Unavailable {
            stage: CliStage::Resolve,
            message: format!("failed to clear omp scratch dir: {e}"),
        })?;
    }
    std::fs::create_dir_all(&scratch).map_err(|e| CliError::Unavailable {
        stage: CliStage::Resolve,
        message: format!("failed to create omp scratch dir: {e}"),
    })?;
    Ok(scratch)
}

/// Shells out to the resolved `omp` binary with `args`, `current_dir` set
/// to a freshly emptied scratch directory. A non-zero exit is omp's own
/// validation error (`Rejected`, stderr preferred over stdout, trimmed); a
/// failure to even resolve or spawn the binary is `Unavailable`.
pub(crate) fn run_omp_cli(app: &AppHandle, args: &[&str]) -> Result<CliOutput, CliError> {
    let (omp_path, _source) = omp::resolve_omp_path(app).map_err(|e| CliError::Unavailable {
        stage: CliStage::Resolve,
        message: e.to_string(),
    })?;
    let scratch = ensure_scratch_dir(app)?;

    let output = Command::new(&omp_path)
        .args(args)
        .current_dir(&scratch)
        .output()
        .map_err(|e| CliError::Unavailable {
            stage: CliStage::Spawn,
            message: format!(
                "failed to run {} {}: {e}",
                omp_path.display(),
                args.join(" ")
            ),
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let status = output.status.code().unwrap_or(-1);

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
        status,
    })
}

/// [`run_omp_cli`], then parses `stdout` as JSON into `T`. A parse failure
/// is `Unavailable{stage: Parse}` — the binary ran and exited cleanly, but
/// didn't speak the shape this command expects (e.g. an override binary
/// predating a subcommand's `--json` flag).
pub(crate) fn run_omp_json<T: DeserializeOwned>(
    app: &AppHandle,
    args: &[&str],
) -> Result<T, CliError> {
    let output = run_omp_cli(app, args)?;
    serde_json::from_str(&output.stdout).map_err(|e| CliError::Unavailable {
        stage: CliStage::Parse,
        message: format!("failed to parse `omp {}` output: {e}", args.join(" ")),
    })
}
