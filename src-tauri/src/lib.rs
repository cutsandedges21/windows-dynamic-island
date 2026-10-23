// Island: the native layer. Everything here is OS access; product logic lives in
// TypeScript (src/). See docs/ARCHITECTURE.md.

// On a Mac, a module that is almost all Windows API is swapped for its twin in
// src/mac/ (same command names), so the Windows file never changes.
mod app;
#[cfg_attr(target_os = "macos", path = "mac/agenda.rs")]
mod agenda;
#[cfg_attr(target_os = "macos", path = "mac/audio.rs")]
mod audio;
mod calls;
mod land;
mod anywhere;
mod chat;
mod claude;
#[cfg_attr(target_os = "macos", path = "mac/dnd.rs")]
mod dnd;
mod firewall;
mod fsx;
#[cfg_attr(target_os = "macos", path = "mac/game.rs")]
mod game;
mod hooks;
mod integrations;
mod llama;
mod local;
mod log;
#[cfg(target_os = "macos")]
mod mac;
#[cfg_attr(target_os = "macos", path = "mac/media.rs")]
mod media;
#[cfg_attr(target_os = "macos", path = "mac/monitors.rs")]
mod monitors;
#[cfg_attr(target_os = "macos", path = "mac/msgwin.rs")]
mod msgwin;
#[cfg_attr(target_os = "macos", path = "mac/net.rs")]
mod net;
mod nowindow;
mod overlay;
mod phone;
#[cfg_attr(target_os = "macos", path = "mac/phonelink.rs")]
mod phonelink;
#[cfg_attr(target_os = "macos", path = "mac/pipe.rs")]
mod pipe;
#[cfg_attr(target_os = "macos", path = "mac/procs.rs")]
mod procs;
mod remote;
mod secrets;
#[cfg_attr(target_os = "macos", path = "mac/shell.rs")]
mod shell;
#[cfg_attr(target_os = "macos", path = "mac/spectrum.rs")]
mod spectrum;
mod store;
mod notice;
#[cfg_attr(target_os = "macos", path = "mac/system.rs")]
mod system;
mod updater;
mod web;
mod workspaces;

use std::sync::Arc;

use tauri::Manager;

#[tauri::command]
fn log_line(text: String) {
    log::line(text);
}

/// A variable an editor or a Claude Code session sets for its own processes. Island started from
/// a shell in one of them would hand these to every app it opens: ELECTRON_RUN_AS_NODE makes
/// Electron apps (VS Code, Cursor, Slack…) run as plain Node and quit without a window, and the
/// session's ids make `claude` think it runs inside another session. CLAUDE_CONFIG_DIR is the
/// user's own setting and stays.
fn host_variable(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    n != "CLAUDE_CONFIG_DIR" && (n.starts_with("ELECTRON_") || n.starts_with("VSCODE_") || n.starts_with("CURSOR_") || n == "CLAUDECODE" || n.starts_with("CLAUDE_CODE_") || n == "CLAUDE_PID" || n == "CLAUDE_EFFORT" || n == "CLAUDE_AGENT_SDK_VERSION")
}

/// Island's environment as if started from the desktop, whoever started it.
fn scrub_host_env() {
    let names: Vec<String> = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| host_variable(k)).collect();
    for name in &names {
        std::env::remove_var(name);
    }
    if !names.is_empty() {
        log::line(format!("start: dropped {} editor/session variables (Island was started from inside an editor or Claude Code)", names.len()));
    }
}

pub fn run() {
    // First, before any thread starts (and before Island opens anything).
    scrub_host_env();
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--install-hooks" || a == "--remove-hooks") {
        std::process::exit(hooks::cli(args.iter().any(|a| a == "--install-hooks")));
    }
    // Before the single-instance check: the exe that started this one must be gone first.
    let updated_from = updater::after_update(&args);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            app::open_app(app, Some("activities".into()));
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(app::on_shortcut)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_biometry::init())
        .manage(Arc::new(overlay::Overlay::new()))
        .manage(store::SettingsStore::default())
        .manage(fsx::Watches::default())
        .manage(pipe::Pending::default())
        .manage(app::Hotkeys::default())
        .manage(land::LandState::default())
        .manage(land::share::ShareState::default())
        .manage(remote::RemoteState::default())
        .manage(workspaces::WsStore::default())
        .setup(move |app| {
            // A Mac menu bar app: no Dock icon, no app menu.
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                monitors::init(app.handle());
            }
            let handle = app.handle().clone();
            log::line(format!("start v{}", app.package_info().version));
            *app.state::<store::SettingsStore>().value.lock().unwrap() = store::load(&handle);
            // Island on your phone: its endpoint starts in the background when a phone is paired.
            remote::setup(&handle);
            overlay::create(&handle)?;
            overlay::spawn_poll(handle.clone(), app.state::<Arc<overlay::Overlay>>().inner().clone());
            app::create_tray(&handle)?;
            #[cfg(windows)]
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            msgwin::start(handle.clone());
            media::start(handle.clone());
            audio::start(handle.clone());
            spectrum::start(handle.clone());
            system::start(handle.clone());
            game::start();
            updater::tidy();
            std::thread::spawn(secrets::forget_retired);
            updater::start(handle.clone());
            if let Some(from) = updated_from.clone() {
                updater::announce(handle.clone(), from);
            }
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
            overlay::island_set_peek,
            overlay::island_paste_arm,
            msgwin::clipboard_paste,
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
            spectrum::spectrum_watch,
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
            shell::sound_output,
            shell::http_get,
            app::tray_update,
            app::hotkeys_set,
            app::notify,
            phone::phone_push,
            phone::phone_listen,
            remote::remote_pair_start,
            remote::remote_pair_stop,
            remote::remote_phones,
            remote::remote_rename,
            remote::remote_forget,
            remote::remote_send,
            remote::remote_send_file,
            remote::remote_vapid,
            remote::remote_push,
            remote::remote_name,
            phonelink::phone_link_access,
            phonelink::phone_link_watch,
            app::app_open,
            app::app_quit,
            app::autostart_get,
            app::autostart_set,
            updater::update_set,
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
            land::land_start,
            land::land_stop,
            land::land_scan,
            land::land_place,
            firewall::land_firewall,
            calls::call_controls,
            calls::call_camera,
            firewall::land_firewall_fix,
            land::land_send,
            land::land_send_text,
            land::share::land_share_start,
            land::share::land_share_stop,
            land::land_answer,
            land::land_cancel,
            land::land_stage,
            land::land_me,
            land::land_friends,
            land::land_friends_online,
            land::land_friend_add,
            land::land_friend_add_nearby,
            land::land_friend_answer,
            land::land_friend_remove,
            workspaces::workspaces_load,
            workspaces::workspaces_init,
            workspaces::workspaces_replace,
            workspaces::workspaces_upsert,
            workspaces::workspaces_remove,
            workspaces::workspaces_reorder,
            workspaces::paths::ws_check,
            workspaces::paths::ws_show,
            workspaces::pick::ws_pick,
            workspaces::launch::ws_launch,
            workspaces::launch::ws_running,
            workspaces::launch::ws_apps,
            workspaces::layout::ws_windows,
            workspaces::layout::ws_place,
            notice::notice_now,
            notice::notice_load,
            notice::notice_save,
            notice::notice_forget,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Island");
}

#[cfg(test)]
mod env_tests {
    #[test]
    fn editor_and_session_variables_are_dropped_and_user_settings_kept() {
        for name in ["ELECTRON_RUN_AS_NODE", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "VSCODE_PID", "VSCODE_IPC_HOOK", "CURSOR_WORKSPACE_LABEL", "CLAUDE_PID"] {
            assert!(super::host_variable(name), "{name}");
        }
        for name in ["CLAUDE_CONFIG_DIR", "PATH", "USERPROFILE", "LOCALAPPDATA", "OneDrive", "ANTHROPIC_API_KEY"] {
            assert!(!super::host_variable(name), "{name}");
        }
    }
}
