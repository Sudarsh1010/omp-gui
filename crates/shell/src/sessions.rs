//! Enumerate on-disk `omp` session JSONL files and guard against a second
//! live process driving the same file (ADR-0005's single-writer guard,
//! issue #8).
//!
//! Listing and header parsing here are a deliberately lightweight subset of
//! omp's own `session-listing.ts` (title/cwd/timestamp only — no per-file
//! tail scan for `SessionStatus`, no full-transcript `firstMessage`/
//! `allMessagesText` extraction): the switcher only needs enough to render
//! a picker row, and omp's own richer algorithm depends on Node/Bun
//! builtins that don't exist here anyway (ADR-0007: Rust owns raw bytes,
//! not session-format parsing beyond what a UI surface strictly needs).
//! `platform/ipc/src/bridge/node.ts`'s seam-test implementation of this
//! same `ShellBridge.listSessionFiles` contract instead imports and reuses
//! omp's real `listAllSessions` directly (it runs under Bun, not a Tauri
//! webview) — this file is the production (webview) path's necessarily
//! independent reimplementation, not a second copy of a shared algorithm.
//!
//! ## Ownership registry split (ADR-0005)
//!
//! ADR-0005 asks for a registry of which live process owns which session
//! file. That splits across two independent halves, each answerable only
//! from its own side:
//!
//!  - **This app's own subprocesses.** `platform/ipc/src/session/
//!    session-directory.ts` tracks this deterministically in TypeScript: it
//!    already knows exactly which `SessionsStore` session is driving which
//!    file (it made the `switch_session` call) and exactly when that
//!    subprocess exits (`RpcSession.onExit`). Duplicating that bookkeeping
//!    here via an extra IPC round-trip would just be a slower, laggier copy
//!    of state TypeScript already has for free — and the seam tests drive
//!    this exact guard against two real (Bun-spawned) omp subprocesses with
//!    no Tauri runtime in the loop at all, so the authoritative half has to
//!    be reachable from plain TypeScript regardless.
//!  - **A genuinely external process** (e.g. the user's terminal `omp` on
//!    the same project) — the case ADR-0005 calls out by name. This app has
//!    no bookkeeping for a process it never spawned; the only way to learn
//!    about it is to ask the OS, which only Rust can do. That's
//!    [`probe_foreign_session_lock`] below: a best-effort `lsof` scan,
//!    filtered against this app's own tracked child PIDs
//!    ([`OmpState::child_pids`]) so a file this app itself is driving is
//!    never misreported as foreign.
use crate::omp::OmpState;
use serde::Serialize;
use specta::Type;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, State};

/// Only plain, live session files are listed — matches omp's own
/// `SESSION_SUFFIX` (`gc-cli.ts`). GC-compressed `.jsonl.gz` archives and
/// orphaned `.jsonl.<id>.bak` backups are excluded: resuming either would
/// need omp-side decompression/recovery support this app doesn't drive.
const SESSION_SUFFIX: &str = ".jsonl";

/// Bytes scanned from the start of a file for its title/session header
/// records — matches `session-listing.ts`'s `SESSION_LIST_PREFIX_BYTES`.
const HEADER_SCAN_BYTES: u64 = 4096;

/// Bytes scanned from the start of a file for `read_session_preview`'s
/// message extraction — generous enough for a first look at a session
/// without risking a slow read of a multi-MB transcript.
const PREVIEW_SCAN_BYTES: u64 = 262_144;
/// Message count ceiling for the same preview scan.
const PREVIEW_MAX_MESSAGES: usize = 40;
/// Per-message character ceiling for the same preview scan.
const PREVIEW_MAX_TEXT_CHARS: usize = 4000;

/// Errors returned from session-directory Shell Bridge commands.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SessionsError {
    /// The user's home directory could not be resolved.
    HomeDirUnavailable,
    /// An I/O error while walking or reading the sessions directory.
    IoFailed { message: String },
}

impl fmt::Display for SessionsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeDirUnavailable => write!(f, "could not resolve the home directory"),
            Self::IoFailed { message } => write!(f, "session directory I/O failed: {message}"),
        }
    }
}

/// One on-disk session file, lightweight metadata only (see module doc).
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileEntry {
    /// Absolute path — the exact string the `switch_session` rpc-ui
    /// command's `sessionPath` field expects.
    pub path: String,
    /// The session's own id, from its `session` header record (falls back
    /// to the uuid embedded in the filename if the header can't be read).
    pub id: String,
    /// Working directory the session was started in; empty if unknown.
    pub cwd: String,
    /// Freshest known title: the file's `title`-record override if
    /// present, else the `session` header's own `title`.
    pub title: Option<String>,
    /// The session header's own `timestamp`, verbatim (already ISO 8601 as
    /// written by omp) — relayed as-is rather than reparsed/reformatted.
    pub created_at: Option<String>,
    /// The file's on-disk mtime, as Unix epoch **seconds** — always
    /// present, and what listing sorts newest-first by. `u32`, not
    /// `u64`/`i64`: specta's TypeScript exporter unconditionally aborts on
    /// 64-bit integer fields (`Primitive::u64 | i64 | ... =>
    /// Err(bigint_forbidden)` in `specta-typescript`, no override short of
    /// accepting JS `number` precision loss) since they can silently lose
    /// precision crossing the JSON boundary. Seconds (not milliseconds) in
    /// a `u32` sidesteps that entirely and is safe until year 2106.
    pub modified_at: u32,
    /// File size in bytes, saturating at `u32::MAX` (~4 GiB) for the exact
    /// same reason `modified_at` is `u32`, not `u64` — no real session
    /// transcript approaches that size.
    pub size_bytes: u32,
}

/// Result of probing whether a process outside this app currently has a
/// session file open (best-effort; see module doc).
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignLockProbe {
    pub locked: bool,
    /// PIDs of the foreign holders, for diagnostics.
    pub pids: Vec<u32>,
}

/// One extracted message from `read_session_preview`'s bounded read-only scan.
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionPreviewMessage {
    pub role: String,
    pub text: String,
}

/// A bounded, read-only reconstruction of a session's early messages —
/// backs the switcher's "view read-only" affordance for a file this app
/// refuses to drive (ADR-0005). Never opens the file for writing, so it
/// carries none of `switch_session`'s corruption risk.
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionPreview {
    pub path: String,
    pub messages: Vec<SessionPreviewMessage>,
    /// True if more content exists beyond this bounded scan (the message
    /// cap was hit, or the file is larger than the scan window).
    pub truncated: bool,
}

/// The sessions root a spawned `omp` subprocess would itself resolve to.
/// Mirrors `@oh-my-pi/pi-utils`'s `dirs.ts` default (non-profile, non-XDG)
/// path: `PI_CODING_AGENT_DIR` wins outright if set, else `$HOME/
/// <PI_CONFIG_DIR or .omp>/agent/sessions`. `omp_start` spawns the child
/// with an inherited, unmodified environment (`omp.rs`), so this needs to
/// honor the same two env vars to stay pointed at whatever the real
/// subprocess would use. Profile (`OMP_PROFILE`) and Linux XDG overrides
/// are intentionally not replicated here, matching the fidelity level the
/// rest of this crate's path resolution already commits to
/// (`resolve_omp_path` doesn't handle them either).
fn sessions_root(app: &AppHandle) -> Result<PathBuf, SessionsError> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir).join("sessions"));
        }
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|_| SessionsError::HomeDirUnavailable)?;
    let config_dir_name = std::env::var("PI_CONFIG_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| ".omp".to_string());
    Ok(home.join(config_dir_name).join("agent").join("sessions"))
}

/// Reads up to `max_bytes` from the start of `path` as lossy UTF-8. The
/// returned `bool` is true when the file is larger than `max_bytes` (i.e.
/// this is a genuine prefix, not the whole file) — a cut-off final line at
/// that boundary is harmless, since callers parse line-by-line and simply
/// skip whatever fails to parse as JSON.
fn read_prefix(path: &Path, max_bytes: u64) -> (String, bool) {
    let Ok(file) = fs::File::open(path) else {
        return (String::new(), false);
    };
    let mut buf = Vec::new();
    if file.take(max_bytes + 1).read_to_end(&mut buf).is_err() {
        return (String::new(), false);
    }
    let hit_cap = buf.len() as u64 > max_bytes;
    if hit_cap {
        buf.truncate(max_bytes as usize);
    }
    (String::from_utf8_lossy(&buf).into_owned(), hit_cap)
}

struct SessionHeader {
    id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    created_at: Option<String>,
}

/// Parses a bounded prefix for its `title` override record and `session`
/// header record — see the real format at `session-listing.ts`'s
/// `SessionListHeader`/`sessionListHeaderFromRecord`: line 1 is typically a
/// fixed-width-padded `{"type":"title",...}` cache entry rewritten in place
/// on rename, line 2 the `{"type":"session",...}` header written once at
/// creation. Scanned defensively (any line, not just 1/2) since it's cheap
/// and bounded either way.
fn parse_session_header(prefix: &str) -> SessionHeader {
    let mut id = None;
    let mut cwd = None;
    let mut session_title = None;
    let mut title_override = None;
    let mut created_at = None;

    for line in prefix.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("title") => {
                if let Some(t) = value.get("title").and_then(|t| t.as_str()) {
                    title_override = Some(t.to_string());
                }
            }
            Some("session") => {
                id = value.get("id").and_then(|v| v.as_str()).map(str::to_string);
                cwd = value
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                session_title = value
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                created_at = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            _ => {}
        }
    }

    SessionHeader {
        id,
        cwd,
        title: title_override.or(session_title),
        created_at,
    }
}

/// Falls back to the id embedded in a `<file-safe-timestamp>_<uuid>.jsonl`
/// filename (mirrors `session-listing.ts`'s `sessionIdFromSessionPath`) when
/// a file's header couldn't be read or parsed.
fn session_id_from_filename(file_name: &str) -> String {
    let stem = file_name.strip_suffix(SESSION_SUFFIX).unwrap_or(file_name);
    match stem.rsplit_once('_') {
        Some((_, id)) if !id.is_empty() => id.to_string(),
        _ => stem.to_string(),
    }
}

fn read_session_entry(path: &Path, file_name: &str) -> Option<SessionFileEntry> {
    let metadata = fs::metadata(path).ok()?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| u32::try_from(d.as_secs()).ok())
        .unwrap_or(0);

    let (prefix, _) = read_prefix(path, HEADER_SCAN_BYTES);
    let header = parse_session_header(&prefix);

    Some(SessionFileEntry {
        path: path.display().to_string(),
        id: header
            .id
            .unwrap_or_else(|| session_id_from_filename(file_name)),
        cwd: header.cwd.unwrap_or_default(),
        title: header.title,
        created_at: header.created_at,
        modified_at,
        size_bytes: u32::try_from(metadata.len()).unwrap_or(u32::MAX),
    })
}

/// Enumerate every on-disk session file across all projects, newest-first,
/// **without spawning omp** — a plain directory walk plus a bounded header
/// read per file (issue #8's "list past sessions from disk" criterion).
/// A missing sessions root (fresh install, omp never run) yields an empty
/// list rather than an error; an unreadable individual project directory or
/// file is skipped rather than failing the whole scan.
#[tauri::command]
#[specta::specta]
pub fn list_session_files(app: AppHandle) -> Result<Vec<SessionFileEntry>, SessionsError> {
    let root = sessions_root(&app)?;
    let project_dirs = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(SessionsError::IoFailed {
                message: e.to_string(),
            });
        }
    };

    let mut out = Vec::new();
    for project_dir in project_dirs.flatten() {
        if !project_dir.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !file_name.ends_with(SESSION_SUFFIX) {
                continue;
            }
            if let Some(entry) = read_session_entry(&path, file_name) {
                out.push(entry);
            }
        }
    }

    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

/// Best-effort scan for an OS process — other than one this app itself
/// spawned — holding `path` open. See the module doc for why this is the
/// only reachable signal for a genuinely external process (e.g. a terminal
/// `omp`): there is no lock file to read (ADR-0005: "no OS-level lock").
/// Missing `lsof` (or any spawn failure) is treated as "nothing detected"
/// rather than an error: this is a corruption *mitigation*, so failing open
/// (never drive-blocking the user on environment noise) is the right
/// default — the deterministic half of the guard (this app's own sessions,
/// tracked in `session-directory.ts`) still holds regardless.
#[tauri::command]
#[specta::specta]
pub fn probe_foreign_session_lock(
    state: State<'_, OmpState>,
    path: String,
) -> Result<ForeignLockProbe, SessionsError> {
    let our_pids = state.child_pids();
    let pids: Vec<u32> = match Command::new("lsof").arg("-t").arg(&path).output() {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .filter(|pid| !our_pids.contains(pid))
            .collect(),
        Err(_) => Vec::new(),
    };
    Ok(ForeignLockProbe {
        locked: !pids.is_empty(),
        pids,
    })
}

/// Extracts and concatenates every `type:"text"` block's text from a
/// message's `content` (thinking/toolCall/image blocks are skipped — this
/// is a readable preview, not a faithful transcript replay). `content` can
/// also be a bare string on some historical/simple messages.
fn extract_preview_text(content: Option<&serde_json::Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Read-only bounded reconstruction of a session's early messages, for the
/// switcher's "view read-only" affordance on a guarded file — see
/// [`SessionPreview`].
#[tauri::command]
#[specta::specta]
pub fn read_session_preview(path: String) -> Result<SessionPreview, SessionsError> {
    let (prefix, hit_byte_cap) = read_prefix(Path::new(&path), PREVIEW_SCAN_BYTES);
    let mut messages = Vec::new();
    let mut hit_message_cap = false;

    for line in prefix.lines() {
        if messages.len() >= PREVIEW_MAX_MESSAGES {
            hit_message_cap = true;
            break;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(role) = message.get("role").and_then(|r| r.as_str()) else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = extract_preview_text(message.get("content"));
        if text.is_empty() {
            continue;
        }
        let text = if text.chars().count() > PREVIEW_MAX_TEXT_CHARS {
            let mut clipped: String = text.chars().take(PREVIEW_MAX_TEXT_CHARS).collect();
            clipped.push('\u{2026}');
            clipped
        } else {
            text
        };
        messages.push(SessionPreviewMessage {
            role: role.to_string(),
            text,
        });
    }

    Ok(SessionPreview {
        path,
        messages,
        truncated: hit_message_cap || hit_byte_cap,
    })
}
