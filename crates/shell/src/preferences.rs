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
    WriteFailed { message: String },
}

impl fmt::Display for PreferencesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WriteFailed { message } => write!(f, "write failed: {message}"),
        }
    }
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
}
