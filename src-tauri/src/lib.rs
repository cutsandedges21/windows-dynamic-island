// Island: the native layer. Everything here is OS access; product logic lives in
// TypeScript (src/). See docs/ARCHITECTURE.md.

mod app;
mod agenda;
mod audio;
mod chat;
mod claude;
mod dnd;
mod fsx;
mod game;
mod hooks;
mod integrations;
mod llama;
mod local;
mod log;
mod media;
mod monitors;
mod msgwin;
mod net;
mod overlay;
mod pipe;
mod procs;
mod secrets;
mod shell;
mod store;
mod system;

use std::sync::Arc;

use tauri::Manager;

#[tauri::command]
fn log_line(text: String) {
    log::line(text);
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--install-hooks" || a == "--remove-hooks") {
        std::process::exit(hooks::cli(args.iter().any(|a| a == "--install-hooks")));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app::open_app(app, Some("activities".into()));
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| app::on_shortcut(app, shortcut, event))
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_biometry::init())
        .manage(Arc::new(overlay::Overlay::new()))
        .manage(store::SettingsStore::default())
        .manage(fsx::Watches::default())
        .manage(pipe::Pending::default())
        .manage(app::Hotkeys::default())
        .setup(|app| {
            let handle = app.handle().clone();
            log::line(format!("start v{}", app.package_info().version));
            *app.state::<store::SettingsStore>().value.lock().unwrap() = store::load(&handle);
            overlay::create(&handle)?;
            overlay::spawn_poll(handle.clone(), app.state::<Arc<overlay::Overlay>>().inner().clone());
            app::create_tray(&handle)?;
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            msgwin::start(handle.clone());
            media::start(handle.clone());
            audio::start(handle.clone());
            system::start(handle.clone());
            game::start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_line,
            store::settings_get,
            store::settings_set,
            monitors::monitors_list,
            monitors::monitor_at_cursor,
            overlay::island_place,
            overlay::island_set_hit,
            overlay::island_show,
            overlay::island_mirrors,
            overlay::mirror_hello,
            overlay::island_set_focusable,
            procs::proc_snapshot,
            procs::win_enum,
            procs::win_activate,
            procs::win_foreground,
            procs::win_foreground_pid,
            game::game_state,
            game::game_fps_setup,
            agenda::agenda_read,
            dnd::dnd_get,
            dnd::dnd_set,
            procs::input_modifiers_down,
            procs::win_allow_foreground,
            fsx::fs_stat_many,
            fsx::fs_read_dir,
            fsx::fs_list_files,
            fsx::fs_read_tail,
            fsx::fs_read_text,
            fsx::fs_read_bytes,
            fsx::fs_watch,
            fsx::fs_unwatch,
            fsx::known_folders,
            fsx::claude_transcript_meta,
            fsx::claude_usage_entries,
            claude::claude_env,
            claude::claude_usage_fetch,
            claude::claude_resume,
            claude::claude_inject,
            claude::claude_select_wt_tab,
            hooks::hooks_status,
            hooks::hooks_preview,
            hooks::hooks_write,
            pipe::hook_reply,
            media::media_state,
            media::media_control,
            audio::audio_state,
            audio::audio_set,
            audio::mic_set_mute,
            system::power_state,
            system::sys_sample,
            net::net_sample,
            net::ports_listening,
            shell::open_url,
            shell::shell_open,
            shell::shell_reveal,
            shell::shell_edit_image,
            shell::shell_lock,
            shell::shell_snip,
            shell::clipboard_set_text,
            shell::clipboard_copy_image,
            shell::clipboard_history,
            shell::http_get,
            app::tray_update,
            app::hotkeys_set,
            app::notify,
            app::app_open,
            app::app_quit,
            app::autostart_get,
            app::autostart_set,
            secrets::secret_has,
            secrets::secret_set,
            secrets::secret_delete,
            integrations::integration_poll,
            chat::ask_claude,
            chat::ask_backends,
            local::local_status,
            local::local_ask,
            local::local_cancel,
            local::local_device_info,
            local::local_warm,
            local::local_setup,
            local::local_setup_cancel,
            local::local_remove,
            local::local_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Island");
}
