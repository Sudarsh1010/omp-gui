//! Downloads a headed Chrome for Testing into the `@puppeteer/browsers`
//! cache layout that `browser::resolve_chromium_executable` already scans.
//!
//! ADR-0006 requires the pane's Chromium to run *headed* (headless
//! fingerprints trip bot detection), and omp's builtin browser tool only
//! ever downloads the headless-only `chrome-headless-shell` — so acquiring
//! a usable binary is this app's job. The installer resolves the Stable
//! channel from the Chrome team's canonical "last known good" endpoint
//! (the same source `@puppeteer/browsers` resolves `chrome@stable` from),
//! streams the platform zip to disk with typed progress events, and
//! extracts it under `~/.cache/puppeteer/chrome/<platform>-<version>/` so
//! the very next `browser_launch` finds it with no further coordination.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use tokio::io::AsyncWriteExt;

use crate::browser::{BrowserError, chrome_for_testing_relative_path};

/// Maintained by the Chrome team; lists the newest build per channel that
/// passed their gates, with per-platform download URLs.
const LAST_KNOWN_GOOD_URL: &str = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

/// Emit at most ~10 progress events/second — the pane only drives a
/// progress bar, and ADR-0007's "no high-rate traffic over Tauri events"
/// concern starts well above this.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct ChromiumInstallState {
    /// One install at a time, app-wide: a second click while a download is
    /// running must not race a half-written cache directory.
    installing: AtomicBool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChromiumInstallPhase {
    Resolving,
    Downloading,
    Extracting,
}

/// Typed payload for the `chromium-install:progress` event. Byte counts are
/// `u32` (caps at 4 GiB) because specta's default TypeScript export rejects
/// `u64`; Chrome for Testing zips are ~150 MB.
#[derive(Serialize, Clone, Type, Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "chromium-install:progress")]
pub struct ChromiumInstallEvent {
    pub phase: ChromiumInstallPhase,
    pub received_bytes: u32,
    pub total_bytes: Option<u32>,
}

/// Download and install a headed Chrome for Testing (Stable), returning the
/// installed executable path. Progress streams as `ChromiumInstallEvent`s;
/// the command itself resolves only on completion, so the frontend awaits
/// it and re-launches. Idempotent-ish: a concurrent call fails fast rather
/// than double-downloading.
#[tauri::command]
#[specta::specta]
pub async fn browser_install_chromium(
    app: AppHandle,
    state: State<'_, ChromiumInstallState>,
) -> Result<String, BrowserError> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(BrowserError::InstallFailed {
            message: "a Chrome for Testing install is already running".into(),
        });
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|e| BrowserError::InstallFailed {
            message: format!("cannot resolve home directory: {e}"),
        });
    let result = match home {
        Ok(home) => {
            let event_app = app.clone();
            install_chromium(&home, move |phase, received_bytes, total_bytes| {
                let _ = ChromiumInstallEvent {
                    phase,
                    received_bytes,
                    total_bytes,
                }
                .emit(&event_app);
            })
            .await
        }
        Err(e) => Err(e),
    };
    state.installing.store(false, Ordering::SeqCst);
    result.map(|path| path.display().to_string())
}

#[derive(Deserialize)]
struct LastKnownGood {
    channels: Channels,
}

#[derive(Deserialize)]
struct Channels {
    #[serde(rename = "Stable")]
    stable: Channel,
}

#[derive(Deserialize)]
struct Channel {
    version: String,
    downloads: Downloads,
}

#[derive(Deserialize)]
struct Downloads {
    chrome: Vec<DownloadEntry>,
}

#[derive(Deserialize)]
struct DownloadEntry {
    platform: String,
    url: String,
}

/// This build's platform key in the endpoint's `downloads` arrays.
fn cft_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else if cfg!(target_os = "windows") {
        "win64"
    } else {
        "linux64"
    }
}

/// Pick this platform's Stable download out of the endpoint's manifest.
fn stable_download(manifest: &LastKnownGood) -> Result<(&str, &str), BrowserError> {
    let channel = &manifest.channels.stable;
    let platform = cft_platform();
    let entry = channel
        .downloads
        .chrome
        .iter()
        .find(|d| d.platform == platform)
        .ok_or_else(|| BrowserError::InstallFailed {
            message: format!("no Stable chrome download listed for platform {platform}"),
        })?;
    Ok((&channel.version, &entry.url))
}

fn install_err(context: &str, e: impl std::fmt::Display) -> BrowserError {
    BrowserError::InstallFailed {
        message: format!("{context}: {e}"),
    }
}

/// The whole pipeline: resolve → stream-download → extract → verify.
/// `progress` fires on every phase change and at most every
/// `PROGRESS_INTERVAL` during the download.
async fn install_chromium(
    home: &Path,
    mut progress: impl FnMut(ChromiumInstallPhase, u32, Option<u32>),
) -> Result<PathBuf, BrowserError> {
    progress(ChromiumInstallPhase::Resolving, 0, None);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| install_err("failed to build HTTP client", e))?;

    let manifest_bytes = client
        .get(LAST_KNOWN_GOOD_URL)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| install_err("failed to fetch Chrome for Testing versions", e))?
        .bytes()
        .await
        .map_err(|e| install_err("failed to read Chrome for Testing versions", e))?;
    let manifest: LastKnownGood = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| install_err("unexpected Chrome for Testing versions payload", e))?;
    let (version, url) = stable_download(&manifest)?;

    // Download beside the destination (same filesystem, so the extracted
    // tree never crosses devices) under a name `find_chrome_in_cache` can
    // never mistake for an install (it only looks at directories).
    let chrome_cache = home.join(".cache").join("puppeteer").join("chrome");
    tokio::fs::create_dir_all(&chrome_cache)
        .await
        .map_err(|e| install_err("failed to create cache directory", e))?;
    let zip_path = chrome_cache.join(format!(".omp-gui-chrome-{version}.zip.part"));

    let response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| install_err("chrome download failed", e))?;
    let total_bytes = response.content_length().map(|n| n as u32);
    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .map_err(|e| install_err("failed to create download file", e))?;
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    progress(ChromiumInstallPhase::Downloading, 0, total_bytes);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| install_err("chrome download interrupted", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| install_err("failed writing download", e))?;
        received += chunk.len() as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            progress(
                ChromiumInstallPhase::Downloading,
                received as u32,
                total_bytes,
            );
            last_emit = Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|e| install_err("failed writing download", e))?;
    drop(file);
    progress(
        ChromiumInstallPhase::Downloading,
        received as u32,
        total_bytes,
    );

    // `<platform>-<version>` mirrors `@puppeteer/browsers`' `<platform
    // >-<buildId>` shape; `find_chrome_in_cache` deliberately matches any
    // directory name, so only the zip's own `chrome-<platform>/` root has
    // to line up with `chrome_for_testing_relative_path`.
    progress(
        ChromiumInstallPhase::Extracting,
        received as u32,
        total_bytes,
    );
    let dest = chrome_cache.join(format!("{}-{version}", cft_platform()));
    let zip_for_extract = zip_path.clone();
    let dest_for_extract = dest.clone();
    tokio::task::spawn_blocking(move || extract_archive(&zip_for_extract, &dest_for_extract))
        .await
        .map_err(|e| install_err("extraction task failed", e))??;
    let _ = tokio::fs::remove_file(&zip_path).await;

    let executable = dest.join(chrome_for_testing_relative_path());
    if !executable.is_file() {
        return Err(BrowserError::InstallFailed {
            message: format!(
                "extraction did not produce the expected executable at {}",
                executable.display()
            ),
        });
    }
    Ok(executable)
}

/// Runtime dispatch (not `#[cfg]`-gated functions) so BOTH extractors
/// typecheck on every target: local macOS builds compile the zip-crate
/// path CI's ubuntu `cargo test -p shell` job exercises, and vice versa.
fn extract_archive(zip: &Path, dest: &Path) -> Result<(), BrowserError> {
    if cfg!(target_os = "macos") {
        extract_with_ditto(zip, dest)
    } else {
        extract_with_zip_crate(zip, dest)
    }
}

/// macOS: `/usr/bin/ditto -x -k` — ships on every macOS and is the stock
/// tool guaranteed to restore the symlinks inside "Google Chrome for
/// Testing.app"'s framework bundle (plus permissions), which a partial
/// extraction would silently break at launch time.
fn extract_with_ditto(zip: &Path, dest: &Path) -> Result<(), BrowserError> {
    std::fs::create_dir_all(dest).map_err(|e| install_err("failed to create install dir", e))?;
    let output = std::process::Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip)
        .arg(dest)
        .output()
        .map_err(|e| install_err("failed to run ditto", e))?;
    if !output.status.success() {
        return Err(BrowserError::InstallFailed {
            message: format!(
                "ditto exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }
    Ok(())
}

/// Windows/Linux zips contain plain files only (no symlinked frameworks),
/// so the `zip` crate's extraction — which restores unix modes — suffices.
fn extract_with_zip_crate(zip: &Path, dest: &Path) -> Result<(), BrowserError> {
    let file = std::fs::File::open(zip).map_err(|e| install_err("failed to open download", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| install_err("downloaded zip is unreadable", e))?;
    archive
        .extract(dest)
        .map_err(|e| install_err("failed to extract chrome", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact shape of googlechromelabs.github.io's
    /// `last-known-good-versions-with-downloads.json`, trimmed to one
    /// channel — the contract `stable_download` depends on.
    const FIXTURE: &str = r#"{
        "timestamp": "2025-08-26T00:00:00.000Z",
        "channels": {
            "Stable": {
                "channel": "Stable",
                "version": "139.0.7258.66",
                "revision": "1477651",
                "downloads": {
                    "chrome": [
                        {"platform": "linux64", "url": "https://storage.googleapis.com/chrome-for-testing-public/139.0.7258.66/linux64/chrome-linux64.zip"},
                        {"platform": "mac-arm64", "url": "https://storage.googleapis.com/chrome-for-testing-public/139.0.7258.66/mac-arm64/chrome-mac-arm64.zip"},
                        {"platform": "mac-x64", "url": "https://storage.googleapis.com/chrome-for-testing-public/139.0.7258.66/mac-x64/chrome-mac-x64.zip"},
                        {"platform": "win32", "url": "https://storage.googleapis.com/chrome-for-testing-public/139.0.7258.66/win32/chrome-win32.zip"},
                        {"platform": "win64", "url": "https://storage.googleapis.com/chrome-for-testing-public/139.0.7258.66/win64/chrome-win64.zip"}
                    ],
                    "chromedriver": []
                }
            }
        }
    }"#;

    #[test]
    fn stable_download_picks_this_platform() {
        let manifest: LastKnownGood = serde_json::from_str(FIXTURE).unwrap();
        let (version, url) = stable_download(&manifest).unwrap();
        assert_eq!(version, "139.0.7258.66");
        assert!(
            url.contains(cft_platform()),
            "url {url} should embed {}",
            cft_platform()
        );
        assert!(url.ends_with(".zip"));
    }

    /// Network-heavy end-to-end smoke: resolve → download (~150 MB) →
    /// extract → verify the binary answers `--version`. Run explicitly:
    /// `cargo test -p shell install_chromium_end_to_end -- --ignored`.
    #[test]
    #[ignore = "downloads ~150 MB from Google's CDN"]
    fn install_chromium_end_to_end() {
        let tmp = std::env::temp_dir().join(format!("omp-gui-cft-install-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let executable = runtime
            .block_on(install_chromium(&tmp, |_phase, _received, _total| {}))
            .unwrap();
        let output = std::process::Command::new(&executable)
            .arg("--version")
            .output()
            .unwrap();
        assert!(output.status.success());
        let version = String::from_utf8_lossy(&output.stdout);
        assert!(
            version.contains("Google Chrome for Testing"),
            "unexpected --version output: {version}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
