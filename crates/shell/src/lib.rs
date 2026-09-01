mod browser;
mod chromium_install;
mod omp;
mod sessions;
/// The single specta builder shared by the runtime and the bindings export
/// test, so the checked-in bindings can never drift from the live handler.
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            omp::omp_start,
            omp::omp_send,
            omp::omp_kill,
            browser::browser_launch,
            browser::browser_stop,
            browser::browser_set_relay,
            browser::browser_set_takeover,
            chromium_install::browser_install_chromium,
            sessions::list_session_files,
            sessions::probe_foreign_session_lock,
            sessions::read_session_preview,
        ])
        .events(tauri_specta::collect_events![
            omp::OmpFrameEvent,
            omp::OmpExitEvent,
            chromium_install::ChromiumInstallEvent,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(omp::OmpState::default())
        .manage(browser::BrowserState::default())
        .manage(chromium_install::ChromiumInstallState::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn export_bindings() {
        let builder = super::specta_builder();

        let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../platform/ipc/src/bindings/bindings.gen.ts");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        builder
            .export(specta_typescript::Typescript::default(), &out)
            .unwrap();
    }
}
