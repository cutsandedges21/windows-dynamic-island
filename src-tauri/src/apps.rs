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

/// The program a shortcut opens, when it is one that exists.
unsafe fn link_target(lnk: &std::path::Path) -> Option<String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk.as_os_str()), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let len = buf.iter().position(|c| *c == 0).unwrap_or(0);
        let path = String::from_utf16_lossy(&buf[..len]);
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
        let mut out: Vec<InstalledApp> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")))
            .filter_map(|p| {
                let name = p.file_stem()?.to_string_lossy().to_string();
                let target = unsafe { link_target(&p) }.unwrap_or_else(|| p.display().to_string());
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
