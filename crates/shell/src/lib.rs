mod omp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(omp::OmpState::default())
        .invoke_handler(tauri::generate_handler![
            omp::omp_start,
            omp::omp_send,
            omp::omp_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
