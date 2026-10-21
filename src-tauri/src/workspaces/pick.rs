// The system's own Open dialog, for choosing an app, files or a folder to add to a workspace.
// Windows: IFileOpenDialog on a thread of its own (COM, single-threaded apartment), owned by
// the window that asked, so it sits on top of it. Mac: AppleScript's choose file / folder.
// Cancelling gives an empty list.

#[cfg(windows)]
mod win {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, FOS_ALLOWMULTISELECT, FOS_FILEMUSTEXIST,
        FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_NODEREFERENCELINKS, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn pick(owner: isize, kind: &str, multiple: bool, start: Option<String>) -> Vec<String> {
        unsafe {
            let inited = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
            let out = show(owner, kind, multiple, start).unwrap_or_default();
            if inited {
                CoUninitialize();
            }
            out
        }
    }

    unsafe fn show(owner: isize, kind: &str, multiple: bool, start: Option<String>) -> windows::core::Result<Vec<String>> {
        let dialog: IFileOpenDialog = unsafe { CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)? };
        let mut opts = unsafe { dialog.GetOptions()? } | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR;
        opts |= if kind == "folder" { FOS_PICKFOLDERS } else { FOS_FILEMUSTEXIST };
        // A Start menu shortcut stays a shortcut: it carries the app's arguments and folder.
        if kind == "app" {
            opts |= FOS_NODEREFERENCELINKS;
        }
        if multiple {
            opts |= FOS_ALLOWMULTISELECT;
        }
        unsafe { dialog.SetOptions(opts)? };

        // The filter strings must outlive SetFileTypes' use of them (until Show returns).
        let names = [wide("Apps and shortcuts"), wide("All files")];
        let specs = [wide("*.exe;*.lnk;*.bat;*.cmd;*.com;*.msc;*.appref-ms;*.url"), wide("*.*")];
        if kind == "app" {
            let filters = [
                COMDLG_FILTERSPEC { pszName: PCWSTR(names[0].as_ptr()), pszSpec: PCWSTR(specs[0].as_ptr()) },
                COMDLG_FILTERSPEC { pszName: PCWSTR(names[1].as_ptr()), pszSpec: PCWSTR(specs[1].as_ptr()) },
            ];
            unsafe { dialog.SetFileTypes(&filters)? };
        }
        let title = wide(match kind {
            "app" => "Choose an app",
            "folder" => "Choose a folder",
            "program" => "Choose the program to open it with",
            _ if multiple => "Choose files",
            _ => "Choose a file",
        });
        unsafe { dialog.SetTitle(PCWSTR(title.as_ptr()))? };
        if let Some(dir) = start.filter(|d| !d.trim().is_empty()) {
            let w = wide(&super::super::paths::expand(&dir));
            if let Ok(item) = unsafe { SHCreateItemFromParsingName::<_, Option<&IBindCtx>, IShellItem>(PCWSTR(w.as_ptr()), None) } {
                let _ = unsafe { dialog.SetFolder(&item) };
            }
        }
        // Cancel comes back as an error (ERROR_CANCELLED): nothing chosen.
        if unsafe { dialog.Show(Some(HWND(owner as *mut _))) }.is_err() {
            return Ok(Vec::new());
        }
        let results = unsafe { dialog.GetResults()? };
        let mut out = Vec::new();
        for i in 0..unsafe { results.GetCount()? } {
            let item = unsafe { results.GetItemAt(i)? };
            let name: PWSTR = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH)? };
            if let Ok(s) = unsafe { name.to_string() } {
                out.push(s);
            }
            unsafe { CoTaskMemFree(Some(name.0 as *const _)) };
        }
        Ok(out)
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::process::Command;

    fn quote(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub fn pick(kind: &str, multiple: bool, start: Option<String>) -> Vec<String> {
        let what = match kind {
            "folder" => "choose folder",
            "app" => "choose file of type {\"com.apple.application-bundle\"}",
            _ => "choose file",
        };
        let prompt = match kind {
            "app" => "Choose an app",
            "folder" => "Choose a folder",
            "program" => "Choose the program to open it with",
            _ => "Choose a file",
        };
        let mut call = format!("{what} with prompt {}", quote(prompt));
        if let Some(dir) = start.filter(|d| !d.trim().is_empty()) {
            call.push_str(&format!(" default location (POSIX file {})", quote(&dir)));
        } else if kind == "app" {
            call.push_str(" default location (path to applications folder)");
        }
        if multiple {
            call.push_str(" with multiple selections allowed");
        }
        let script = format!(
            "set picked to ({call})\nif class of picked is not list then set picked to {{picked}}\nset out to \"\"\nrepeat with f in picked\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out"
        );
        let Ok(o) = Command::new("/usr/bin/osascript").arg("-e").arg(script).output() else { return Vec::new() };
        // Cancel exits with an error (-128): nothing chosen.
        if !o.status.success() {
            return Vec::new();
        }
        // Folders come back with a trailing slash.
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| if l.len() > 1 { l.trim_end_matches('/').to_string() } else { l.to_string() })
            .collect()
    }
}

/// Opens the system's Open dialog over the window that asked. `kind`: "app", "file",
/// "program" (an app to open a file with) or "folder". The chosen paths; empty when cancelled.
#[tauri::command]
pub async fn ws_pick(window: tauri::WebviewWindow, kind: String, multiple: bool, start: Option<String>) -> Vec<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    #[cfg(windows)]
    let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let _ = &window;
    std::thread::spawn(move || {
        #[cfg(windows)]
        let chosen = win::pick(owner, &kind, multiple, start);
        #[cfg(target_os = "macos")]
        let chosen = mac::pick(&kind, multiple, start);
        let _ = tx.send(chosen);
    });
    rx.await.unwrap_or_default()
}
