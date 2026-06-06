// Crate root. The Claude config/path helpers live at the top level
// (commands/claude.rs, pty_bridge.rs and file_watch.rs reach them via
// `crate::claude_bridge`); the command modules are grouped under `commands`.
mod claude_bridge;
// Interactive Claude CLI over a PTY, plus the animation.tsx file watcher that
// keeps the editor/preview in sync with what Claude writes in the terminal.
mod file_watch;
mod pty_bridge;

// Inline module tree -> resolves to src/commands/<name>.rs without a mod.rs.
mod commands {
    pub mod claude;
    pub mod export;
    pub mod projects;
    pub mod render_toolchain;
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
        // Single interactive Claude PTY session + single animation.tsx watcher.
        .manage(pty_bridge::PtyState::default())
        .manage(file_watch::WatchState::default())
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
            commands::projects::list_project_files,
            commands::projects::read_file,
            commands::projects::write_file,
            commands::projects::list_assets,
            commands::projects::add_asset,
            commands::projects::save_conversation,
            commands::projects::load_conversation,
            commands::projects::reveal_project,
            commands::claude::check_claude_installed,
            commands::claude::get_claude_cli,
            commands::claude::set_claude_cli,
            pty_bridge::terminal_open,
            pty_bridge::terminal_input,
            pty_bridge::terminal_resize,
            pty_bridge::terminal_close,
            file_watch::watch_animation,
            commands::zip::export_project_zip,
            commands::zip::import_project_zip,
            commands::export::export_tsx,
            commands::export::export_mp4,
            commands::export::choose_render_output,
            commands::render_toolchain::render_toolchain_status,
            commands::render_toolchain::install_render_toolchain,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
