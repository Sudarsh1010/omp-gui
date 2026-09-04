//! App Preferences: the tiny app-owned JSON file for the handful of values
//! that structurally cannot live in omp (ADR-0011, issue #19/#20) — which
//! omp binary to run, the Chromium path, the default working directory for
//! new sessions, and the app's own theme. Owned entirely by the Rust shell
//! and always readable/writable independent of a working omp binary, so the
//! Settings page can open (and repair a broken omp override) even when
//! every omp-backed section has failed.
//!
//! File lives at `<tauri app_config_dir>/preferences.json`. Unknown keys
//! (written by a newer app version, or a future App Preference this crate
//! doesn't know about yet) are preserved verbatim across a write
//! (`write_file`'s object-overlay merge) — issue #19 story #41, "survive an
//! app downgrade". A read never rewrites the file: a missing or corrupt
//! file silently yields defaults, leaving whatever bytes are on disk
//! (if any) untouched until the next explicit save.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Current on-disk schema version, written on every save. Bump only
/// alongside an explicit migration in `read_file`/`write_file`.
const PREFERENCES_VERSION: u32 = 1;

const PREFERENCES_FILE: &str = "preferences.json";

/// The app's chosen appearance. `System` follows the OS's
/// `prefers-color-scheme` live; `Light`/`Dark` pin one palette.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

impl Default for Theme {
    fn default() -> Self {
        Theme::System
    }
}

/// The four values ADR-0011 says structurally cannot live in omp. Every
/// field defaults to "unset" (`Theme::System`, `None`) so a brand-new file
/// (or a corrupt one, per `read_file`) renders identically to one that was
/// never written.
#[derive(Debug, Serialize, Deserialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    #[serde(default)]
    pub theme: Theme,
    /// Power-user override of the omp binary to run (ADR-0004's settings
    /// escape hatch); `None` runs the resolved default (env override, dev
    /// binary, or bundled pin — see `omp::resolve_omp_path`).
    #[serde(default)]
    pub omp_path: Option<String>,
    /// Override for the Chromium executable the Browser Pane launches.
    #[serde(default)]
    pub chromium_path: Option<String>,
    /// Default working directory new sessions spawn into; `None` falls
    /// back to `omp_start`'s own default (the user's home directory).
    #[serde(default)]
    pub default_working_directory: Option<String>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: Theme::default(),
            omp_path: None,
            chromium_path: None,
            default_working_directory: None,
        }
    }
}

/// Errors returned from App Preferences Shell Bridge commands.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PreferencesError {
    WriteFailed {
        message: String,
    },
    /// `preferences_effective` (#22) could not resolve the user's home
    /// directory, the last-resort fallback for the working-directory row.
    HomeDirUnavailable {
        message: String,
    },
}

impl fmt::Display for PreferencesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WriteFailed { message } => write!(f, "write failed: {message}"),
            Self::HomeDirUnavailable { message } => {
                write!(f, "home directory unavailable: {message}")
            }
        }
    }
}

/// Where `preferences_effective`'s working-directory value came from —
/// the specta-typed mirror of `omp::StartCwdSource`'s non-`Requested`
/// variants (a fresh session, which is what this command describes, never
/// has a `requested` resume cwd).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkingDirectorySource {
    /// The App Preferences `defaultWorkingDirectory` named an existing
    /// directory.
    Preference,
    /// No preference was set at all.
    Home,
    /// A preference was set but no longer names an existing directory.
    Fallback,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveWorkingDirectory {
    /// The directory a fresh session would actually spawn into.
    pub value: String,
    pub source: WorkingDirectorySource,
    /// The raw, unresolved `defaultWorkingDirectory` preference (even when
    /// it no longer names an existing directory), so the Settings row can
    /// show the user what they set alongside the effective value.
    pub preferred: Option<String>,
}

/// Where `preferences_effective`'s Chromium value came from — the
/// specta-typed mirror of `browser::ChromiumSource`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChromiumPathSource {
    /// `OMP_GUI_CHROMIUM_PATH` or `PUPPETEER_EXECUTABLE_PATH`.
    Env,
    /// The App Preferences `chromiumPath` (#22).
    Preference,
    /// A `@puppeteer/browsers`-managed cache scan.
    Cache,
    /// Nothing resolved.
    None,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveChromiumPath {
    /// The Chromium executable the Browser Pane would actually launch, or
    /// `None` when nothing resolved anywhere.
    pub value: Option<String>,
    pub source: ChromiumPathSource,
    /// The primary override env var's name (`browser.rs`'s
    /// `CHROMIUM_OVERRIDE_ENV`), for the row's description text — never a
    /// second, driftable copy of the string.
    pub env_var: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePreferences {
    pub working_directory: EffectiveWorkingDirectory,
    pub chromium: EffectiveChromiumPath,
}

/// Pure read of the preferences file at `path`. A missing file, an
/// unparseable one, or one that doesn't parse into `AppPreferences` all
/// yield `AppPreferences::default()` — this function never writes, so the
/// original bytes (if any) are left exactly as found.
pub(crate) fn read_file(path: &Path) -> AppPreferences {
    let Ok(bytes) = fs::read(path) else {
        return AppPreferences::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Overlays `prefs`' known fields (plus the schema `version`) onto whatever
/// JSON object already exists on disk at `path`, so keys this version of
/// the app doesn't know about (written by a newer version, or a future App
/// Preference) survive verbatim. Writes atomically: a sibling temp file
/// followed by an OS-level rename, so a crash mid-write can never leave a
/// half-written `preferences.json` behind.
pub(crate) fn write_file(path: &Path, prefs: &AppPreferences) -> Result<(), io::Error> {
    let mut root = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    let known = match serde_json::to_value(prefs).expect("AppPreferences always serializes") {
        serde_json::Value::Object(map) => map,
        _ => unreachable!("AppPreferences always serializes to a JSON object"),
    };
    for (key, value) in known {
        root.insert(key, value);
    }
    root.insert(
        "version".to_string(),
        serde_json::Value::from(PREFERENCES_VERSION),
    );

    let serialized = serde_json::to_vec_pretty(&serde_json::Value::Object(root))
        .expect("a plain JSON object always serializes");

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &serialized)?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

fn preferences_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(PREFERENCES_FILE))
}

/// Pure read of the app-owned preferences file. Corrupt/missing → defaults,
/// never rewritten by a read. Crate-visible so other commands can consume
/// it directly (#22's spawn cwd + Chromium path, #23's omp override) even
/// though only theme has a UI yet.
pub(crate) fn load_preferences(app: &AppHandle) -> AppPreferences {
    match preferences_path(app) {
        Some(path) => read_file(&path),
        None => AppPreferences::default(),
    }
}

/// Reads the existing file (if parseable), overlays `prefs`, and writes it
/// back atomically. Unknown keys already on disk survive.
pub(crate) fn save_preferences(
    app: &AppHandle,
    prefs: &AppPreferences,
) -> Result<(), PreferencesError> {
    let path = preferences_path(app).ok_or_else(|| PreferencesError::WriteFailed {
        message: "could not resolve the app config directory".to_string(),
    })?;
    write_file(&path, prefs).map_err(|e| PreferencesError::WriteFailed {
        message: e.to_string(),
    })
}

/// Read the app's own preferences file (theme, omp/Chromium overrides,
/// default working directory) — always available, even when omp itself is
/// unreachable (ADR-0011).
#[tauri::command]
#[specta::specta]
pub fn preferences_read(app: AppHandle) -> Result<AppPreferences, PreferencesError> {
    Ok(load_preferences(&app))
}

/// Write the app's preferences file, preserving any keys this command
/// doesn't know about, and return what is now on disk.
#[tauri::command]
#[specta::specta]
pub fn preferences_write(
    app: AppHandle,
    prefs: AppPreferences,
) -> Result<AppPreferences, PreferencesError> {
    save_preferences(&app, &prefs)?;
    Ok(load_preferences(&app))
}

/// Filesystem facts about `path`, for the working-directory/Chromium-path
/// rows (#22) to validate an edit inline before committing it — a
/// directory picker's escape hatch, since no Tauri dialog plugin is wired
/// in yet (`01-shell-bridge.md`). Deliberately infallible: a bad or
/// missing path is information for the caller to render, not an error.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PathProbe {
    pub exists: bool,
    pub is_dir: bool,
    pub is_executable: bool,
}

#[cfg(unix)]
fn is_executable_file(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable_file(metadata: &fs::Metadata) -> bool {
    metadata.is_file()
}

/// Probe an arbitrary filesystem path for the working-directory row (needs
/// `isDir`) and the Chromium-path row (needs `isExecutable`) to validate
/// on blur/Enter before writing it to the preferences file.
#[tauri::command]
#[specta::specta]
pub fn path_probe(path: String) -> PathProbe {
    match fs::metadata(Path::new(path.trim())) {
        Ok(metadata) => PathProbe {
            exists: true,
            is_dir: metadata.is_dir(),
            is_executable: is_executable_file(&metadata),
        },
        Err(_) => PathProbe {
            exists: false,
            is_dir: false,
            is_executable: false,
        },
    }
}

/// The effective default working directory and Chromium executable a
/// fresh session / Browser Pane launch would actually use right now, plus
/// where each came from (#22, issue #19 story: "Both rows show the
/// effective value and where it came from"). Reuses `omp::resolve_start_cwd`
/// and `browser::resolve_chromium_source` — the exact functions
/// `omp_start`/`browser_launch` themselves call — so this can never drift
/// from what a real spawn would do.
#[tauri::command]
#[specta::specta]
pub fn preferences_effective(app: AppHandle) -> Result<EffectivePreferences, PreferencesError> {
    let prefs = load_preferences(&app);

    let home = app
        .path()
        .home_dir()
        .map_err(|e| PreferencesError::HomeDirUnavailable {
            message: e.to_string(),
        })?;
    let (cwd, cwd_source) =
        crate::omp::resolve_start_cwd(None, prefs.default_working_directory.as_deref(), &home);
    let working_directory = EffectiveWorkingDirectory {
        value: cwd.display().to_string(),
        source: match cwd_source {
            crate::omp::StartCwdSource::Preference => WorkingDirectorySource::Preference,
            crate::omp::StartCwdSource::Fallback => WorkingDirectorySource::Fallback,
            // `requested` is always `None` above, so `omp`'s `Requested`
            // variant is structurally unreachable here.
            crate::omp::StartCwdSource::Home | crate::omp::StartCwdSource::Requested => {
                WorkingDirectorySource::Home
            }
        },
        preferred: prefs.default_working_directory.clone(),
    };

    let (chromium_path, chromium_source) = crate::browser::resolve_chromium_source(
        crate::browser::chromium_env_override(),
        prefs.chromium_path.as_deref(),
        || crate::browser::find_cached_chromium(&app),
    );
    let chromium = EffectiveChromiumPath {
        value: chromium_path.map(|p| p.display().to_string()),
        source: match chromium_source {
            crate::browser::ChromiumSource::Env => ChromiumPathSource::Env,
            crate::browser::ChromiumSource::Preference => ChromiumPathSource::Preference,
            crate::browser::ChromiumSource::Cache => ChromiumPathSource::Cache,
            crate::browser::ChromiumSource::None => ChromiumPathSource::None,
        },
        env_var: crate::browser::CHROMIUM_OVERRIDE_ENV.to_string(),
    };

    Ok(EffectivePreferences {
        working_directory,
        chromium,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A unique path under the OS temp dir — no `AppHandle` needed since
    /// `read_file`/`write_file` operate on a plain path.
    fn temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("omp-gui-preferences-test-{name}-{nanos}.json"))
    }

    #[test]
    fn write_carries_a_version_field() {
        let path = temp_path("version");
        let prefs = AppPreferences {
            theme: Theme::Dark,
            ..AppPreferences::default()
        };
        write_file(&path, &prefs).unwrap();

        let raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["version"], PREFERENCES_VERSION);
        assert_eq!(raw["theme"], "dark");

        fs::remove_file(&path).ok();
    }

    #[test]
    fn unknown_keys_survive_a_write() {
        let path = temp_path("unknown-keys");
        fs::write(
            &path,
            r#"{"version":1,"theme":"system","futureKey":{"nested":true}}"#,
        )
        .unwrap();

        let prefs = AppPreferences {
            theme: Theme::Light,
            ..AppPreferences::default()
        };
        write_file(&path, &prefs).unwrap();

        let raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["futureKey"]["nested"], true);
        assert_eq!(raw["theme"], "light");

        fs::remove_file(&path).ok();
    }

    #[test]
    fn corrupt_file_yields_defaults_and_is_left_untouched() {
        let path = temp_path("corrupt");
        fs::write(&path, b"{not valid json").unwrap();
        let before = fs::read(&path).unwrap();

        let prefs = read_file(&path);
        assert_eq!(prefs.theme, Theme::System);
        assert!(prefs.omp_path.is_none());

        let after = fs::read(&path).unwrap();
        assert_eq!(before, after, "a read must never rewrite a corrupt file");

        fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_yields_defaults() {
        let path = temp_path("missing");
        fs::remove_file(&path).ok();

        let prefs = read_file(&path);
        assert_eq!(prefs.theme, Theme::System);
        assert!(prefs.omp_path.is_none());
        assert!(prefs.chromium_path.is_none());
        assert!(prefs.default_working_directory.is_none());
    }

    #[test]
    fn path_probe_reports_an_existing_directory() {
        let dir = std::env::temp_dir();
        let probe = path_probe(dir.to_str().unwrap().to_string());
        assert!(probe.exists);
        assert!(probe.is_dir);
        assert!(!probe.is_executable);
    }

    #[test]
    fn path_probe_reports_a_missing_path() {
        let probe = path_probe("/nonexistent/omp-gui-path-probe-should-never-exist".to_string());
        assert!(!probe.exists);
        assert!(!probe.is_dir);
        assert!(!probe.is_executable);
    }

    #[test]
    fn path_probe_reports_an_executable_file() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("omp-gui-path-probe-exec-{nanos}"));
        fs::write(&path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&path, perms).unwrap();
        }

        let probe = path_probe(path.to_str().unwrap().to_string());
        assert!(probe.exists);
        assert!(!probe.is_dir);
        #[cfg(unix)]
        assert!(probe.is_executable);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn path_probe_reports_a_non_executable_file() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("omp-gui-path-probe-noexec-{nanos}"));
        fs::write(&path, b"not executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o644);
            fs::set_permissions(&path, perms).unwrap();
        }

        let probe = path_probe(path.to_str().unwrap().to_string());
        assert!(probe.exists);
        assert!(!probe.is_dir);
        assert!(!probe.is_executable);

        fs::remove_file(&path).ok();
    }
}
