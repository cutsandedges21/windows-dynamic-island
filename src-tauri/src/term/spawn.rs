// What runs in a terminal and how it starts. Shells on Windows: `powershell` = pwsh.exe when it
// is on PATH, else powershell.exe -NoLogo; `cmd` = cmd.exe; `bash` = Git Bash (--login -i) when
// Git for Windows is installed. A Mac runs the user's shell as a login shell whatever is asked.
// A program (a Claude chat's `claude`) runs directly with its arguments, no shell between, so
// nothing in them is ever read as a command; on Windows only real programs (.exe, .com) run,
// never a .cmd or .bat script, which cmd.exe would read.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// What to start in a terminal.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The name terminals report (`powershell`, `cmd`, `bash`, `zsh`, `claude`…).
    pub shell: String,
    /// How its title starts before the program gives one ("PowerShell · Documents").
    pub label: String,
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// The shell to start for `kind` (None: the default, PowerShell).
#[cfg(windows)]
pub fn shell(kind: Option<&str>) -> Result<Spec, String> {
    let spec = |program: PathBuf, args: &[&str], shell: &str, label: &str| Spec { program, args: args.iter().map(|a| a.to_string()).collect(), shell: shell.into(), label: label.into() };
    let system32 = || PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32");
    match kind.unwrap_or("powershell") {
        "powershell" => {
            if let Some(pwsh) = on_path("pwsh.exe") {
                return Ok(spec(pwsh, &[], "powershell", "PowerShell"));
            }
            let ps = on_path("powershell.exe").unwrap_or_else(|| system32().join("WindowsPowerShell").join("v1.0").join("powershell.exe"));
            Ok(spec(ps, &["-NoLogo"], "powershell", "PowerShell"))
        }
        "cmd" => {
            let cmd = std::env::var_os("ComSpec").map(PathBuf::from).filter(|p| p.is_file()).unwrap_or_else(|| system32().join("cmd.exe"));
            Ok(spec(cmd, &[], "cmd", "Command Prompt"))
        }
        "bash" => git_bash().map(|bash| spec(bash, &["--login", "-i"], "bash", "Git Bash")).ok_or_else(|| "Git Bash isn't installed on the PC.".to_string()),
        _ => Err("Island doesn't know that shell.".into()),
    }
}

/// The user's shell as a login shell (zsh unless they changed it); every kind asks for it.
#[cfg(not(windows))]
pub fn shell(_kind: Option<&str>) -> Result<Spec, String> {
    let program = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let name = program.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "zsh".into());
    Ok(Spec { program, args: vec!["-l".into()], shell: name.clone(), label: name })
}

/// Git for Windows' bash.exe: where its installer says, else beside git.exe on PATH, else the
/// usual places.
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for hive in [windows_registry::LOCAL_MACHINE, windows_registry::CURRENT_USER] {
        if let Ok(path) = hive.open(r"SOFTWARE\GitForWindows").and_then(|k| k.get_string("InstallPath")) {
            roots.push(PathBuf::from(path));
        }
    }
    // …\Git\cmd\git.exe (or …\Git\bin\git.exe): Git's folder is two up.
    if let Some(root) = on_path("git.exe").and_then(|git| git.parent()?.parent().map(Path::to_path_buf)) {
        roots.push(root);
    }
    for (var, sub) in [("ProgramFiles", "Git"), ("ProgramW6432", "Git"), ("LOCALAPPDATA", r"Programs\Git")] {
        if let Some(base) = std::env::var_os(var) {
            roots.push(PathBuf::from(base).join(sub));
        }
    }
    roots.into_iter().map(|root| root.join("bin").join("bash.exe")).find(|p| p.is_file())
}

/// Folders a program is looked for in besides PATH (Claude Code's own installer puts it in the
/// first; a Mac app's PATH has none of these).
fn extra_dirs() -> Vec<PathBuf> {
    let home = crate::claude::home();
    let mut dirs = vec![home.join(".local").join("bin")];
    if cfg!(not(windows)) {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// Whether Windows would run this file as a program by itself.
fn runnable(path: &Path) -> bool {
    if cfg!(windows) {
        let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
        matches!(ext.as_deref(), Some("exe" | "com")) && path.is_file()
    } else {
        path.is_file()
    }
}

/// `program` (a name looked for on PATH, or a full path) with `args`, run directly.
pub fn program(program: &str, args: &[String]) -> Result<Spec, String> {
    let name = program.trim();
    let missing = || format!("Island can't find {} on this computer.", if name.is_empty() { "that program" } else { name });
    if name.is_empty() {
        return Err(missing());
    }
    if args.iter().any(|a| a.contains('\0')) {
        return Err("Island can't pass that text to a program.".into());
    }
    let given = Path::new(name);
    let found = if given.components().count() > 1 || given.is_absolute() {
        Some(given.to_path_buf()).filter(|p| p.is_absolute() && runnable(p))
    } else {
        let names: Vec<String> = if cfg!(windows) && given.extension().is_none() { vec![format!("{name}.exe"), format!("{name}.com")] } else { vec![name.to_string()] };
        let path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
        path.into_iter().chain(extra_dirs()).flat_map(|dir| names.iter().map(move |n| dir.join(n))).find(|p| runnable(p))
    };
    let program = found.ok_or_else(missing)?;
    let stem = program.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.to_string());
    let label = match stem.to_ascii_lowercase().as_str() {
        "claude" => "Claude".to_string(),
        _ => stem.clone(),
    };
    Ok(Spec { program, args: args.to_vec(), shell: stem.to_ascii_lowercase(), label })
}

/// A started terminal: its program, the pty's two ends, and on Windows the job that holds
/// everything started in it.
pub struct Started {
    pub pid: u32,
    pub child: Box<dyn Child + Send + Sync>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    pub master: Box<dyn MasterPty + Send>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    #[cfg(windows)]
    pub job: Option<Job>,
}

pub fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// Starts `spec` in a new pseudo-terminal of `cols`×`rows` in `cwd`, with the user's environment
/// plus TERM and COLORTERM.
pub fn start(spec: &Spec, cwd: &Path, cols: u16, rows: u16) -> Result<Started, String> {
    let fail = |e| failed(spec, e);
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(fail)?;
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    #[cfg(not(windows))]
    cmd.env("PATH", mac_path());
    let child = pair.slave.spawn_command(cmd).map_err(fail)?;
    // Only the program holds the terminal's other end now, so its output ends when it does (a
    // Unix pty; ConPTY ends when the master goes).
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    #[cfg(windows)]
    let job = Job::new().filter(|job| job.adopt(child.as_ref()));
    let killer = child.clone_killer();
    let reader = pair.master.try_clone_reader().map_err(fail)?;
    let writer = pair.master.take_writer().map_err(fail)?;
    Ok(Started {
        pid,
        child,
        killer,
        master: pair.master,
        reader,
        writer,
        #[cfg(windows)]
        job,
    })
}

fn failed(spec: &Spec, e: impl std::fmt::Display) -> String {
    crate::log::line(format!("term: can't start {}: {e}", spec.shell));
    format!("{} didn't start on the PC.", spec.label)
}

/// A Mac app starts with a bare PATH; programs started in a terminal get the usual folders too.
#[cfg(not(windows))]
fn mac_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for dir in extra_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// A Windows job holding a terminal's program and everything it starts: ending the terminal ends
/// them all, and so does Island going away, even by a crash (the job is killed when its last
/// handle closes). A program that ends by itself lets go of the job first, so what it started
/// in the background (an app it opened) keeps running.
#[cfg(windows)]
pub struct Job(windows::Win32::Foundation::HANDLE);

// The handle is only passed to thread-safe Win32 calls.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    fn new() -> Option<Job> {
        use windows::Win32::System::JobObjects::{CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
        let job = Job(unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }.ok()?);
        job.set_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).then_some(job)
    }

    fn set_limits(&self, flags: windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT) -> bool {
        use windows::Win32::System::JobObjects::{JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION};
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = flags;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        unsafe { SetInformationJobObject(self.0, JobObjectExtendedLimitInformation, &info as *const _ as *const std::ffi::c_void, size) }.is_ok()
    }

    fn adopt(&self, child: &(dyn Child + Send + Sync)) -> bool {
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        let Some(handle) = child.as_raw_handle() else { return false };
        let ok = unsafe { AssignProcessToJobObject(self.0, windows::Win32::Foundation::HANDLE(handle)) }.is_ok();
        if !ok {
            crate::log::line("term: Windows wouldn't put a terminal in a job; ending it ends only its program");
        }
        ok
    }

    /// Ends everything in it.
    pub fn kill(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        let _ = unsafe { TerminateJobObject(self.0, 1) };
    }

    /// Closes it without ending what is still in it.
    pub fn release(self) {
        self.set_limits(windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT(0));
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_are_found_on_path_and_must_be_real() {
        let missing = program("island-no-such-program", &[]).unwrap_err();
        assert_eq!(missing, "Island can't find island-no-such-program on this computer.");
        assert!(program("  ", &[]).is_err());
        assert!(program("relative\\or/odd", &[]).is_err(), "a relative path isn't looked up");
        assert!(program("x", &["a\0b".into()]).is_err());
        #[cfg(windows)]
        {
            let cmd = program("cmd", &["/c".into(), "echo hi".into()]).unwrap();
            assert!(cmd.program.ends_with("cmd.exe"), "{:?}", cmd.program);
            assert_eq!((cmd.shell.as_str(), cmd.args.len()), ("cmd", 2));
            assert!(program(&cmd.program.to_string_lossy(), &[]).is_ok(), "a full path to a program");
            // A script is never run directly, even by its full path.
            let dir = std::env::temp_dir().join(format!("island-term-spawn-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("tool.cmd");
            std::fs::write(&script, "@echo off\r\n").unwrap();
            assert!(program(&script.to_string_lossy(), &[]).is_err());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_shells() {
        let ps = shell(None).unwrap();
        assert_eq!((ps.shell.as_str(), ps.label.as_str()), ("powershell", "PowerShell"));
        let name = ps.program.file_name().unwrap().to_string_lossy().to_ascii_lowercase();
        assert!(name == "pwsh.exe" || (name == "powershell.exe" && ps.args == ["-NoLogo"]), "{:?} {:?}", ps.program, ps.args);
        let cmd = shell(Some("cmd")).unwrap();
        assert_eq!((cmd.shell.as_str(), cmd.label.as_str()), ("cmd", "Command Prompt"));
        assert!(cmd.program.is_file());
        match shell(Some("bash")) {
            Ok(bash) => {
                assert!(bash.program.ends_with(r"bin\bash.exe") && bash.args == ["--login", "-i"], "{:?}", bash.program);
                assert!(!bash.program.to_string_lossy().to_ascii_lowercase().contains("system32"), "Git's bash, not WSL's");
            }
            Err(e) => assert_eq!(e, "Git Bash isn't installed on the PC."),
        }
        assert_eq!(shell(Some("fish")).unwrap_err(), "Island doesn't know that shell.");
    }
}
