// Crate root. The Claude bridge lives at the top level (commands/claude.rs reaches
// it via `crate::claude_bridge`); the command modules are grouped under `commands`.
mod claude_bridge;

// Inline module tree -> resolves to src/commands/<name>.rs without a mod.rs.
mod commands {
    pub mod claude;
    pub mod export;
    pub mod projects;
    pub mod zip;
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
        // Single serialized Claude CLI bridge, shared across invoke_claude/cancel_claude.
        .manage(commands::claude::ClaudeState::default())
        // On startup, materialize the bundled MCP config + skills prompt into the app
        // config dir so the Claude bridge can point the CLI at real files.
        .setup(|app| {
            claude_bridge::ensure_claude_config(app.handle())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            Ok(())
        })
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
            commands::claude::invoke_claude,
            commands::claude::cancel_claude,
            commands::claude::check_claude_installed,
            commands::zip::export_project_zip,
            commands::zip::import_project_zip,
            commands::export::export_tsx,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
