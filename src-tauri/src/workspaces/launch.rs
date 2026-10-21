// Opening what a workspace holds: starting an app, opening a file (with its own app or a chosen
// one) or a folder, running a command in Windows Terminal or a console window, finding an app
// that's already running, and the list of installed apps. Every path and command comes from a
// workspace the user made and confirmed; this file only carries them out. A Mac uses `open`
// and Terminal (no reuse detection: `open -a` brings a running app to the front by itself).

use serde::{Deserialize, Serialize};

use super::paths;

#[derive(Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Launch {
    App {
        path: String,
        args: String,
        cwd: String,
    },
    #[serde(rename_all = "camelCase")]
    File {
        path: String,
        open_with: String,
    },
    Folder {
        path: String,
    },
    Command {
        /// The item's id: names the script a Command Prompt command is written to.
        id: String,
        command: String,
        shell: String,
        host: String,
        cwd: String,
        title: String,
    },
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Launched {
    /// The process started, when the system says (not for apps opened through the shell).
    pub pid: Option<u32>,
    /// Said beside the result ("Windows Terminal isn't installed, so it ran in its own window").
    pub note: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub pid: u32,
    /// Its main window, when it has one on screen.
    pub hwnd: Option<isize>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub name: String,
    /// What to launch: the program's path, or `shell:AppsFolder\<id>` for Store apps.
    pub target: String,
}

/// The folder something starts in: its own (relative to the project folder), else the project
/// folder; only one that exists.
fn start_dir(cwd: &str, base: &str) -> Option<String> {
    [cwd, base]
        .iter()
        .filter(|c| !c.trim().is_empty())
        .filter_map(|c| paths::resolve(c, base))
        .find(|p| p.is_dir())
        .map(|p| p.display().to_string())
}

fn existing(path: &str, base: &str) -> Result<std::path::PathBuf, String> {
    let p = paths::resolve(path, base).ok_or_else(|| format!("That can't be a path: {path}"))?;
    if std::fs::metadata(&p).is_err() {
        return Err(format!("Not found: {}", p.display()));
    }
    Ok(p)
}

/// A window title Windows Terminal's command line can't misread: no quotes or semicolons.
fn clean_title(title: &str) -> String {
    let t: String = title.chars().filter(|c| !matches!(c, '"' | ';' | '\r' | '\n' | '\0')).take(60).collect();
    if t.trim().is_empty() { "Island".into() } else { t }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The PowerShell a command runs as: titled, in its folder, showing the command, then the command.
pub fn ps_script(command: &str, dir: Option<&str>, title: &str) -> String {
    let q = |s: &str| s.replace('\'', "''");
    let mut s = format!("$Host.UI.RawUI.WindowTitle = '{}'\n", q(title));
    if let Some(d) = dir {
        s.push_str(&format!("Set-Location -LiteralPath '{}'\n", q(d)));
    }
    // A here-string shows the command exactly, unless a line of it would end the here-string.
    if command.lines().any(|l| l.starts_with("'@")) {
        s.push_str(&format!("Write-Host -ForegroundColor DarkGray '> {}'\n", q(command.lines().next().unwrap_or(""))));
    } else {
        s.push_str(&format!("Write-Host -ForegroundColor DarkGray @'\n> {command}\n'@\n"));
    }
    s.push_str(command);
    s.push('\n');
    s
}

/// -EncodedCommand's form: base64 of the script in UTF-16LE. Nothing in it needs quoting.
pub fn encode_ps(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A Command Prompt command as a batch file: UTF-8, titled, in its folder; the command's lines
/// echo as they run, so the window shows what ran.
pub fn cmd_script(command: &str, dir: Option<&str>, title: &str) -> String {
    let mut s = String::from("@chcp 65001 >nul\r\n");
    s.push_str(&format!("@title {}\r\n", title.replace(['&', '|', '<', '>', '^', '%'], "")));
    if let Some(d) = dir {
        s.push_str(&format!("@cd /d \"{d}\"\r\n"));
    }
    for line in command.lines() {
        s.push_str(line);
        s.push_str("\r\n");
    }
    s
}

/// Words of an argument string, keeping "quoted parts" together (for the Mac's `open --args`).
#[cfg_attr(windows, allow(dead_code))]
pub fn split_args(args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in args.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        out.push(cur);
    }
    out
}

// ------------------------------------------------------------------ Windows

#[cfg(windows)]
mod win {
    use std::path::{Path, PathBuf};

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        COINIT_DISABLE_OLE1DDE, STGM_READ,
    };
    use windows::Win32::System::Threading::{GetProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Shell::{
        IEnumShellItems, IShellItem, IShellLinkW, SHGetKnownFolderItem, SHGetKnownFolderPath, ShellExecuteExW, ShellLink, BHID_EnumItems,
        FOLDERID_AppsFolder, KF_FLAG_DEFAULT, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
        SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING, SLGP_RAWPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
        SW_SHOWNORMAL, WS_EX_TOOLWINDOW,
    };

    use super::{existing, start_dir, InstalledApp, Launch, Launched, Running};

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// COM for this thread (the shell may hand ShellExecuteEx to an extension that needs it).
    pub struct Com(bool);
    impl Com {
        pub fn new() -> Self {
            Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok())
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Why a launch failed, in words; `code` is the Windows error.
    pub struct Failed {
        pub code: u32,
        pub text: String,
    }

    fn reason(code: u32, what: &str) -> String {
        match code {
            2 | 3 => format!("Not found: {what}"),
            5 => "Windows refused to open it (access denied).".into(),
            193 => "Windows can't run that file as a program.".into(),
            740 => "It needs to run as administrator.".into(),
            1155 => "No app is set to open this kind of file.".into(),
            1223 => "You said no to the administrator prompt.".into(),
            _ => format!("Windows couldn't open it (error {code})."),
        }
    }

    /// ShellExecuteEx "open": what double-clicking does, with arguments and a start folder.
    pub fn shell_exec(file: &str, params: Option<&str>, dir: Option<&str>) -> Result<Option<u32>, Failed> {
        let verb = wide("open");
        let file_w = wide(file);
        let params_w = params.map(wide);
        let dir_w = dir.map(wide);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file_w.as_ptr()),
            lpParameters: params_w.as_ref().map(|p| PCWSTR(p.as_ptr())).unwrap_or(PCWSTR::null()),
            lpDirectory: dir_w.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        crate::procs::allow_any_foreground();
        if let Err(e) = unsafe { ShellExecuteExW(&mut info) } {
            let code = (e.code().0 as u32) & 0xFFFF;
            crate::log::line(format!("workspaces: open {} failed: {code}", Path::new(file).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
            return Err(Failed { code, text: reason(code, file) });
        }
        if info.hProcess.is_invalid() {
            return Ok(None);
        }
        let pid = unsafe { GetProcessId(info.hProcess) };
        let _ = unsafe { CloseHandle(info.hProcess) };
        Ok((pid != 0).then_some(pid))
    }

    fn is_shell_app(path: &str) -> bool {
        path.trim().to_ascii_lowercase().starts_with("shell:appsfolder\\")
    }

    pub fn launch(item: Launch, base: &str) -> Result<Launched, String> {
        let _com = Com::new();
        let done = |pid: Option<u32>| Launched { pid, note: None };
        match item {
            Launch::App { path, args, cwd } => {
                let target = if is_shell_app(&path) { path.trim().to_string() } else { existing(&path, base)?.display().to_string() };
                let dir = start_dir(&cwd, base);
                let args = args.trim();
                shell_exec(&target, (!args.is_empty()).then_some(args), dir.as_deref()).map(done).map_err(|f| f.text)
            }
            Launch::File { path, open_with } => {
                let file = existing(&path, base)?;
                let dir = file.parent().map(|p| p.display().to_string());
                if open_with.trim().is_empty() {
                    shell_exec(&file.display().to_string(), None, dir.as_deref()).map(done).map_err(|f| f.text)
                } else {
                    let program = existing(&open_with, base)?;
                    shell_exec(&program.display().to_string(), Some(&format!("\"{}\"", file.display())), dir.as_deref()).map(done).map_err(|f| f.text)
                }
            }
            Launch::Folder { path } => {
                let dir = existing(&path, base)?;
                if !dir.is_dir() {
                    return Err(format!("That's a file, not a folder: {}", dir.display()));
                }
                shell_exec(&dir.display().to_string(), None, None).map(done).map_err(|f| f.text)
            }
            Launch::Command { id, command, shell, host, cwd, title } => run_command(&id, &command, &shell, &host, &cwd, &title, base),
        }
    }

    fn run_command(id: &str, command: &str, shell: &str, host: &str, cwd: &str, title: &str, base: &str) -> Result<Launched, String> {
        if command.trim().is_empty() {
            return Err("There's no command to run.".into());
        }
        if !super::valid_id(id) {
            return Err("Bad item id.".into());
        }
        let dir = start_dir(cwd, base);
        let title = super::clean_title(title);
        let (program, params) = if shell == "cmd" {
            let script = crate::log::data_dir().join("workspaces").join(format!("{id}.cmd"));
            if let Some(parent) = script.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&script, super::cmd_script(command, dir.as_deref(), &title)).map_err(|e| format!("Couldn't write the command's script: {e}"))?;
            ("cmd.exe".to_string(), format!("/K \"{}\"", script.display()))
        } else {
            let exe = if shell == "pwsh" { "pwsh.exe" } else { "powershell.exe" };
            (exe.to_string(), format!("-NoLogo -NoExit -EncodedCommand {}", super::encode_ps(&super::ps_script(command, dir.as_deref(), &title))))
        };
        let mut note = None;
        if host == "terminal" {
            // `-w 0`: a new tab in the open Terminal window (one is made if there is none).
            let mut wt = String::from("-w 0 new-tab");
            if let Some(d) = &dir {
                // A trailing backslash would escape the closing quote; a semicolon would split the line.
                wt.push_str(&format!(" -d \"{}\"", d.trim_end_matches('\\').replace(';', "\\;")));
            }
            wt.push_str(&format!(" --title \"{title}\" {program} {params}"));
            match shell_exec("wt.exe", Some(&wt), dir.as_deref()) {
                Ok(pid) => return Ok(Launched { pid, note: None }),
                Err(f) if f.code == 2 || f.code == 3 => note = Some("Windows Terminal isn't installed, so it ran in its own window.".to_string()),
                Err(f) => return Err(f.text),
            }
        }
        if shell == "pwsh" && which("pwsh.exe").is_none() {
            return Err("PowerShell 7 isn't installed. Choose PowerShell in the editor, or install PowerShell 7.".into());
        }
        shell_exec(&program, Some(&params), dir.as_deref()).map(|pid| Launched { pid, note }).map_err(|f| f.text)
    }

    fn which(name: &str) -> Option<PathBuf> {
        super::paths::resolve(name, "").filter(|p| p.is_file())
    }

    // -------------------------------------------------------------- running apps

    /// The program a shortcut starts.
    pub fn shortcut_target(lnk: &Path) -> Option<PathBuf> {
        let _com = Com::new();
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let file: IPersistFile = windows::core::Interface::cast(&link).ok()?;
            file.Load(PCWSTR(wide(&lnk.display().to_string()).as_ptr()), STGM_READ).ok()?;
            let mut buf = [0u16; 1024];
            link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32).ok()?;
            let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
            let raw = String::from_utf16_lossy(&buf[..len]);
            (!raw.is_empty()).then(|| PathBuf::from(super::paths::expand(&raw)))
        }
    }

    /// The .exe an app item starts, when that can be known (not Store apps).
    pub fn program_of(path: &str, base: &str) -> Option<PathBuf> {
        if is_shell_app(path) {
            return None;
        }
        let p = super::paths::resolve(path, base)?;
        let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        match ext.as_str() {
            "exe" => Some(p),
            "lnk" => shortcut_target(&p).filter(|t| t.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))),
            _ => None,
        }
    }

    /// The full path of a process's program; None for one Island may not look into.
    pub fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    struct Find<'a> {
        pids: &'a [u32],
        found: Option<HWND>,
    }

    unsafe extern "system" fn find_main(hwnd: HWND, data: LPARAM) -> windows::core::BOOL {
        let find = unsafe { &mut *(data.0 as *mut Find) };
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let tool = (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0;
            let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.0.is_null());
            if find.pids.contains(&pid) && IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 && !tool && !owned {
                find.found = Some(hwnd);
                return false.into();
            }
        }
        true.into()
    }

    pub fn running(path: &str, base: &str) -> Option<Running> {
        let program = program_of(path, base)?;
        let want = program.display().to_string().to_lowercase();
        let name = program.file_name()?.to_string_lossy().to_lowercase();
        let pids: Vec<u32> = crate::procs::snapshot(false)
            .into_iter()
            .filter(|row| row.2 == name)
            .map(|row| row.0)
            .filter(|pid| image_path(*pid).is_some_and(|p| p.to_lowercase() == want))
            .collect();
        let first = *pids.first()?;
        let mut find = Find { pids: &pids, found: None };
        unsafe {
            let _ = EnumWindows(Some(find_main), LPARAM(&mut find as *mut _ as isize));
        }
        Some(Running { pid: first, hwnd: find.found.map(|h| h.0 as isize) })
    }

    // -------------------------------------------------------------- installed apps

    fn display(item: &IShellItem, kind: windows::Win32::UI::Shell::SIGDN) -> Option<String> {
        unsafe {
            let p = item.GetDisplayName(kind).ok()?;
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
    }

    /// "{6D809377-…}\Microsoft VS Code\Code.exe" (a known folder, then the rest) to a real path.
    fn known_folder_path(id: &str) -> Option<PathBuf> {
        let rest = id.strip_prefix('{')?;
        let (guid, tail) = rest.split_once('}')?;
        let guid = windows::core::GUID::try_from(guid).ok()?;
        unsafe {
            let p = SHGetKnownFolderPath(&guid, KF_FLAG_DEFAULT, None).ok()?;
            let root = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            Some(PathBuf::from(root?).join(tail.trim_start_matches('\\')))
        }
    }

    /// Start's list of apps (what "All apps" shows): desktop programs by path, Store apps by id.
    pub fn installed() -> Vec<InstalledApp> {
        let _com = Com::new();
        let mut out = Vec::new();
        unsafe {
            let Ok(folder) = SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None) else { return out };
            let Ok(items) = folder.BindToHandler::<Option<&IBindCtx>, IEnumShellItems>(None, &BHID_EnumItems) else { return out };
            loop {
                let mut one: [Option<IShellItem>; 1] = [None];
                let mut got = 0u32;
                if items.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                    break;
                }
                let Some(item) = one[0].take() else { break };
                let (Some(name), Some(id)) = (display(&item, SIGDN_NORMALDISPLAY), display(&item, SIGDN_PARENTRELATIVEPARSING)) else { continue };
                let target = if id.contains('!') {
                    // A Store app's id (Package!App).
                    format!("shell:AppsFolder\\{id}")
                } else {
                    let path = if id.starts_with('{') { known_folder_path(&id) } else { Some(PathBuf::from(&id)) };
                    match path {
                        Some(p) if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) && p.is_file() => p.display().to_string(),
                        // Help files, web links and uninstallers listed in Start are not apps.
                        _ => continue,
                    }
                };
                out.push(InstalledApp { name, target });
            }
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        out.dedup_by(|a, b| a.target.eq_ignore_ascii_case(&b.target));
        out
    }
}

// ------------------------------------------------------------------ Mac

#[cfg(not(windows))]
mod mac {
    use std::process::Command;

    use super::{existing, start_dir, InstalledApp, Launch, Launched, Running};

    fn run(mut c: Command) -> Result<Launched, String> {
        match c.status() {
            Ok(s) if s.success() => Ok(Launched::default()),
            Ok(_) => Err("macOS couldn't open it.".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn applescript_string(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    pub fn launch(item: Launch, base: &str) -> Result<Launched, String> {
        match item {
            Launch::App { path, args, .. } => {
                let app = existing(&path, base)?;
                let mut c = Command::new("/usr/bin/open");
                c.arg("-a").arg(&app);
                let words = super::split_args(&args);
                if !words.is_empty() {
                    c.arg("--args").args(words);
                }
                run(c)
            }
            Launch::File { path, open_with } => {
                let file = existing(&path, base)?;
                let mut c = Command::new("/usr/bin/open");
                if !open_with.trim().is_empty() {
                    c.arg("-a").arg(existing(&open_with, base)?);
                }
                c.arg(&file);
                run(c)
            }
            Launch::Folder { path } => {
                let dir = existing(&path, base)?;
                let mut c = Command::new("/usr/bin/open");
                c.arg(&dir);
                run(c)
            }
            Launch::Command { command, cwd, .. } => {
                if command.trim().is_empty() {
                    return Err("There's no command to run.".into());
                }
                let dir = start_dir(&cwd, base);
                let line = match dir {
                    Some(d) => format!("cd '{}' && {}", d.replace('\'', "'\\''"), command),
                    None => command,
                };
                let script = format!("tell application \"Terminal\"\nactivate\ndo script {}\nend tell", applescript_string(&line));
                let mut c = Command::new("/usr/bin/osascript");
                c.arg("-e").arg(script);
                run(c)
            }
        }
    }

    pub fn running(_path: &str, _base: &str) -> Option<Running> {
        None
    }

    pub fn installed() -> Vec<InstalledApp> {
        let mut out = Vec::new();
        for dir in ["/Applications", "/System/Applications", "/Applications/Utilities"] {
            let Ok(rd) = std::fs::read_dir(dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "app") {
                    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    out.push(InstalledApp { name, target: p.display().to_string() });
                }
            }
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        out
    }
}

/// The full path of a process's program (Windows); None for one Island may not look into.
#[cfg(windows)]
pub fn program_path(pid: u32) -> Option<String> {
    win::image_path(pid)
}

#[cfg(windows)]
use win as native;
#[cfg(not(windows))]
use mac as native;

#[cfg(test)]
pub fn launch_now(item: Launch, base: &str) -> Result<Launched, String> {
    native::launch(item, base)
}
#[cfg(test)]
pub fn running_now(path: &str, base: &str) -> Option<Running> {
    native::running(path, base)
}
#[cfg(test)]
pub fn ws_apps_now() -> Vec<InstalledApp> {
    native::installed()
}

/// Opens one item. `base` is the workspace's project folder.
#[tauri::command]
pub async fn ws_launch(item: Launch, base: String) -> Result<Launched, String> {
    tauri::async_runtime::spawn_blocking(move || native::launch(item, &base)).await.map_err(|e| e.to_string())?
}

/// The app an item starts, if it's running now, with its main window.
#[tauri::command]
pub async fn ws_running(path: String, base: String) -> Option<Running> {
    tauri::async_runtime::spawn_blocking(move || native::running(&path, &base)).await.ok().flatten()
}

/// The apps installed for this user, as Start lists them.
#[tauri::command]
pub async fn ws_apps() -> Vec<InstalledApp> {
    tauri::async_runtime::spawn_blocking(native::installed).await.unwrap_or_default()
}
