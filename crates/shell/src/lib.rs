mod omp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            omp::omp_start,
            omp::omp_send,
            omp::omp_kill,
        ])
        .events(tauri_specta::collect_events![
            omp::OmpFrameEvent,
            omp::OmpExitEvent,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Result);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(omp::OmpState::default())
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
    use crate::omp;

    #[test]
    fn export_bindings() {
        let builder = tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                omp::omp_start,
                omp::omp_send,
                omp::omp_kill,
            ])
            .events(tauri_specta::collect_events![
                omp::OmpFrameEvent,
                omp::OmpExitEvent,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Result);

        let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../platform/ipc/src/bindings/bindings.gen.ts");
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        builder
            .export(specta_typescript::Typescript::default(), &out)
            .unwrap();
    }
}
