// The Apps tile: what is pinned to the taskbar (its first list of apps), and each app's icon.

use std::path::PathBuf;

use windows::core::{Interface, HSTRING};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

use crate::workspaces::launch::InstalledApp;

/// Icons asked for at once, at most.
const MAX_ICONS: usize = 80;

/// Where Windows keeps the taskbar's pinned shortcuts (Store apps pinned there have none).
fn pins_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"))
}

/// A Chrome or Edge web app's address in Start's list (shell:AppsFolder\Chrome._crx_<id>), from
/// the shortcut that opens it (chrome_proxy.exe --app-id=<id>). Its windows carry the same id, so
/// the taskbar can group them under the app instead of the browser.
pub fn web_app_id(program: &str, args: &str) -> Option<String> {
    let id: String = args.split("--app-id=").nth(1)?.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    if id.is_empty() {
        return None;
    }
    let edge = std::path::Path::new(program).file_name().is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().starts_with("msedge"));
    Some(format!(r"shell:AppsFolder\{}._crx_{id}", if edge { "MSEdge" } else { "Chrome" }))
}

/// The program a shortcut opens, when it is one that exists and the shortcut adds nothing to it.
/// A web app's shortcut gives the web app's address; any other with arguments stays the shortcut,
/// so it opens with them and shows its own icon.
unsafe fn link_target(lnk: &std::path::Path) -> Option<String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
        let mut args = [0u16; 1024];
        link.GetArguments(&mut args).ok()?;
        let args = String::from_utf16_lossy(&args[..args.iter().position(|c| *c == 0).unwrap_or(0)]);
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let len = buf.iter().position(|c| *c == 0).unwrap_or(0);
        let path = String::from_utf16_lossy(&buf[..len]);
        if let Some(id) = web_app_id(&path, &args) {
            return Some(id);
        }
        if !args.trim().is_empty() {
            return None;
        }
        (!path.is_empty() && std::path::Path::new(&path).is_file()).then_some(path)
    }
}

/// The taskbar's pinned apps, by name: each one's program, or the shortcut itself when it
/// opens something else.
#[tauri::command]
pub async fn apps_pinned() -> Vec<InstalledApp> {
    tokio::task::spawn_blocking(|| {
        let Some(dir) = pins_dir() else { return Vec::new() };
        let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
        let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok();
        let start = crate::workspaces::launch::ws_apps_now();
        let mut out: Vec<InstalledApp> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")))
            .filter_map(|p| {
                let name = p.file_stem()?.to_string_lossy().to_string();
                let mut target = unsafe { link_target(&p) }.unwrap_or_else(|| p.display().to_string());
                if target.starts_with("shell:AppsFolder") {
                    // A web app: use the id Start lists it under, which is the one its windows carry
                    // (the shortcut's own id differs).
                    if let Some(a) = start.iter().find(|a| a.name.eq_ignore_ascii_case(&name) && crate::workspaces::launch::is_web_app(a.target.rsplit('\\').next().unwrap_or(""))) {
                        target = a.target.clone();
                    }
                }
                Some(InstalledApp { name, target })
            })
            .collect();
        if init {
            unsafe { CoUninitialize() };
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        out
    })
    .await
    .unwrap_or_default()
}

/// Each app's icon as a PNG data address, in the order asked; None where Windows has none.
#[tauri::command]
pub async fn apps_icons(targets: Vec<String>, px: u32) -> Vec<Option<String>> {
    tokio::task::spawn_blocking(move || targets.iter().take(MAX_ICONS).map(|t| crate::shelf::shell_image(t, px, true)).collect()).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::web_app_id;

    #[test]
    fn a_web_app_shortcut_gives_its_start_address() {
        let p = r"C:\Program Files\Google\Chrome\Application\chrome_proxy.exe";
        assert_eq!(web_app_id(p, " --profile-directory=Default --app-id=cinhimbnkkghhklpknlkffjgod").as_deref(), Some(r"shell:AppsFolder\Chrome._crx_cinhimbnkkghhklpknlkffjgod"));
        assert_eq!(web_app_id(r"C:\x\msedge_proxy.exe", "--app-id=abc").as_deref(), Some(r"shell:AppsFolder\MSEdge._crx_abc"));
        assert_eq!(web_app_id(p, "--profile-directory=Default"), None);
        assert_eq!(web_app_id(p, ""), None);
    }
}
