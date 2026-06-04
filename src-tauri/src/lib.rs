// Inline module tree -> resolves to src/commands/projects.rs without a mod.rs.
mod commands {
    pub mod projects;
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::projects::list_projects,
            commands::projects::create_project,
            commands::projects::open_project,
            commands::projects::delete_project,
            commands::projects::save_animation,
            commands::projects::load_animation,
            commands::projects::save_conversation,
            commands::projects::load_conversation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
