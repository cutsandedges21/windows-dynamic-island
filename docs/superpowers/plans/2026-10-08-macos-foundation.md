# Island on macOS, Part 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Moss's rule: no agent fan-outs; execute inline.)

**Goal:** Island compiles, bundles and starts on macOS (GitHub's Mac runners), with the pill under the menu bar and OS-free activities working, while the Windows app stays unchanged.

**Architecture:** Windows code stays where it is. Files that are almost all Windows API get a Mac twin in `src-tauri/src/mac/`, swapped in by `#[cfg_attr(target_os = "macos", path = "mac/<name>.rs")]` on their `mod` line, so the Windows files do not change at all. Files that are mostly portable get small `#[cfg]` guards. Mac twins of features that come in later parts return `Err("not on Mac yet")`; the UI's `call()` already turns any error into its fallback (`null`, `[]`, `false`, `0`). The UI hides activities a Mac cannot run yet.

**Tech Stack:** Tauri 2.12.1, Rust (`cfg` attributes, `libc` and CoreGraphics FFI on macOS), TypeScript + Vitest, GitHub Actions `macos-latest`.

**Spec:** `docs/superpowers/specs/2026-10-08-macos-foundation-design.md`

**Facts this plan relies on (checked 2026-10-08):**
- A local `cargo check --target aarch64-apple-darwin` fails on Windows (`objc2-exception-helper` compiles Objective-C, which needs Apple's SDK). The Mac compiler is GitHub Actions only.
- Tauri 2.12.1 has `Monitor::work_area()`, `App::set_activation_policy`, `WebviewWindowBuilder::{visible_on_all_workspaces, accept_first_mouse, focusable}`, `WebviewWindow::{set_focusable, cursor_position, set_ignore_cursor_events}`, `AppHandle::{available_monitors, primary_monitor, monitor_from_point}`.
- `src/core/native.ts` `call()` returns the fallback on any error. Fallbacks: state calls `null`; `proc_snapshot`/`win_enum`/`ports_listening` `[]`; `win_foreground_pid` `0`; `input_modifiers_down` `false`.
- The vendored `tauri-plugin-biometry` already has a macOS backend.
- The repo is public, so macOS runners are free.

**Working tree:** a separate worktree on branch `mac-part1` at `C:\tmp\island-mac`, so another session's work on `main` is never touched. Cargo output for this worktree goes to `C:\tmp\island-mac-target`.

---

## File map

**Create (Rust, macOS only):**
- `src-tauri/src/mac/mod.rs`: shared Mac helpers (`NOT_YET`, `input`, `sys`).
- `src-tauri/src/mac/input.rs`: mouse buttons, click counters and the Control key through CoreGraphics.
- `src-tauri/src/mac/sys.rs`: RAM, CPU name, macOS version, uptime, disk space, host name, local timestamp through `libc`.
- `src-tauri/src/mac/monitors.rs`: real displays through Tauri's monitor API.
- `src-tauri/src/mac/shell.rs`: real `open`/reveal/HTTP GET; the rest not yet.
- `src-tauri/src/mac/{agenda,audio,dnd,game,media,msgwin,net,pipe,procs,spectrum,system}.rs`: same command names as Windows, "not on Mac yet".

**Create (shared):**
- `src-tauri/src/nowindow.rs`: `Command::no_window()` (CREATE_NO_WINDOW on Windows, nothing elsewhere).
- `src-tauri/tauri.macos.conf.json`: Mac bundle settings.
- `.github/workflows/macos.yml`: Mac check, build, smoke test.
- `src/core/platform.ts` + `test/platform.test.ts`: which system Island runs on, and what is available there.

**Modify:**
- `src-tauri/Cargo.toml`: Windows-only crates under `cfg(windows)`; Mac crates; `macos-private-api`.
- `src-tauri/tauri.conf.json`: `app.macOSPrivateApi: true` (ignored on Windows).
- `src-tauri/src/lib.rs`: module swaps, Mac start-up.
- `src-tauri/src/overlay.rs`: Mac cursor, buttons, Control key, focus; Windows parts behind `cfg(windows)`.
- `src-tauri/src/{log,fsx,updater,hooks,claude,chat,local,llama}.rs`: small guards.
- `src/activities/catalog.ts`: `mac?: 'soon' | 'never'` per activity.
- `src/core/island.ts`, `src/app.ts`, `src/styles/app.css`, `src/core/onboarding.ts`, `src/welcome.ts`, `test/onboarding.test.ts`: hide what a Mac cannot run yet.

---

### Task 1: Worktree and hand-off

**Files:** none in the repo.

- [ ] **Step 1: Create the worktree**

```bash
cd C:/Users/sport/OneDrive/Documents/CodingPersonal/windows-dynamic-island
git fetch origin
git worktree add -b mac-part1 C:/tmp/island-mac origin/main
cd C:/tmp/island-mac && npm ci --no-audit --no-fund
```
Expected: `Preparing worktree (new branch 'mac-part1')`, then `added N packages`.

- [ ] **Step 2: Tell the other session**

Run ListAgents. If another session is working in `windows-dynamic-island`, SendMessage it:
"Island macOS part 1 is on branch `mac-part1` in worktree C:\tmp\island-mac. At merge time it changes: src-tauri/Cargo.toml, tauri.conf.json (macOSPrivateApi only), lib.rs, overlay.rs, log.rs, fsx.rs, updater.rs, hooks.rs, claude.rs, chat.rs, local.rs, llama.rs, src/activities/catalog.ts (a `mac` field), src/core/island.ts (one guard in syncActivities), src/app.ts (activity card), src/styles/app.css, src/core/onboarding.ts, src/welcome.ts, test/onboarding.test.ts; new files under src-tauri/src/mac/, src/core/platform.ts, .github/. Please tell me if you are mid-change in any of these."

---

### Task 2: Dependencies and config

**Files:**
- Modify: `src-tauri/Cargo.toml:17,27,32-33,39-43`
- Modify: `src-tauri/tauri.conf.json` (`app` block)
- Create: `src-tauri/tauri.macos.conf.json`

- [ ] **Step 1: Cargo.toml**

Line 17, replace:
```toml
tauri = { version = "2", features = ["tray-icon", "image-png"] }
```
with:
```toml
tauri = { version = "2", features = ["tray-icon", "image-png", "macos-private-api"] }
```

Delete line 27 (`windows-registry = "0.5"`), lines 32-33 (the keyring comment and `keyring = ...`), and lines 39-41 (the windows-core comment and `windows-core = "0.61"`).

Replace `[dependencies.windows]` (line 43) with this block and the renamed table header:
```toml
[target.'cfg(windows)'.dependencies]
windows-registry = "0.5"
# API keys live in the Windows Credential Manager (src/secrets.rs).
keyring = { version = "3", features = ["windows-native"] }
# The #[interface] macro for QuietHours.dll's COM interface (src/dnd.rs) names this crate;
# the same 0.61 copy `windows` already uses.
windows-core = "0.61"

[target.'cfg(target_os = "macos")'.dependencies]
# API keys live in the macOS Keychain.
keyring = { version = "3", features = ["apple-native"] }
# sysctl, statfs, localtime_r (src/mac/sys.rs).
libc = "0.2"

[target.'cfg(windows)'.dependencies.windows]
```
(The `version = "0.61"` and `features = [...]` lines under it stay as they are.)

- [ ] **Step 2: tauri.conf.json**

In the `"app"` object, after `"withGlobalTauri": false,` add:
```json
    "macOSPrivateApi": true,
```

- [ ] **Step 3: tauri.macos.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "targets": ["app", "dmg"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"],
    "resources": null,
    "shortDescription": "A fluid activity island for your Mac",
    "macOS": { "minimumSystemVersion": "12.0" }
  }
}
```

- [ ] **Step 4: Windows still builds**

```bash
cd C:/tmp/island-mac/src-tauri && CARGO_TARGET_DIR=C:/tmp/island-mac-target cargo test --lib 2>&1 | grep -E "^error|test result"
```
Expected: `test result: ok. 95 passed` (or the current count), no `error`. Cargo.lock gains libc/security-framework entries.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/tauri.macos.conf.json Cargo.lock
git commit -m "macOS: Windows-only crates behind cfg(windows), Mac bundle config"
```

---

### Task 3: The Mac CI (the failing test)

**Files:**
- Create: `.github/workflows/macos.yml`

- [ ] **Step 1: Workflow**

```yaml
name: macOS

on:
  push:
  workflow_dispatch:

concurrency:
  group: macos-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      # generate_context! reads the frontend folder at compile time.
      - run: mkdir -p dist && echo '<!doctype html>' > dist/index.html
      - run: cargo check -p island --lib --locked

  build:
    needs: check
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin
      - uses: Swatinem/rust-cache@v2
      - run: npm ci
      - run: npm run build:web
      - run: npx tauri build --target universal-apple-darwin --bundles app,dmg
      - name: Smoke test
        run: |
          APP="target/universal-apple-darwin/release/bundle/macos/Island.app"
          "$APP/Contents/MacOS/island" > run.log 2>&1 &
          PID=$!
          sleep 25
          screencapture -x shot.png || echo "screencapture failed"
          kill $PID || true
          cp "$HOME/Library/Application Support/Island/island.log" island.log || true
          cat island.log || true
          grep -q "island ready" island.log
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: island-macos
          path: |
            target/universal-apple-darwin/release/bundle/dmg/*.dmg
            shot.png
            island.log
            run.log
```

- [ ] **Step 2: Push and watch it fail**

```bash
git add .github/workflows/macos.yml
git commit -m "CI: build and smoke-test Island on macOS"
git push -u origin mac-part1
gh run watch --exit-status $(gh run list --branch mac-part1 --workflow macOS --limit 1 --json databaseId -q '.[0].databaseId') 2>&1 | tail -5
```
Expected: `check` fails with errors in our crate (`windows` imports, `std::os::windows`). This is the failing test the next tasks make pass. Save the error list: `gh run view --log-failed > C:/tmp/mac-errors-1.txt`.

---

### Task 4: Shared helpers

**Files:**
- Create: `src-tauri/src/nowindow.rs`, `src-tauri/src/mac/mod.rs`, `src-tauri/src/mac/input.rs`, `src-tauri/src/mac/sys.rs`

- [ ] **Step 1: nowindow.rs**

```rust
// Helper processes start without a console window: CREATE_NO_WINDOW on Windows.
// Other systems open no window for them in the first place.

pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000)
    }

    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}
```

- [ ] **Step 2: mac/mod.rs**

```rust
// macOS-only helpers. The Mac twins of Windows modules (mac/media.rs and the rest)
// are not declared here: lib.rs swaps each one in with a `path` attribute on the
// Windows module's own `mod` line.

pub mod input;
pub mod sys;

/// What a Mac twin answers for a feature that comes in a later part.
pub const NOT_YET: &str = "not on Mac yet";
```

- [ ] **Step 3: mac/input.rs**

```rust
// Mouse buttons and the Control key, read the way overlay.rs reads them on Windows:
// polled from the overlay thread. The click counters catch a click that starts and
// ends between two polls (Windows' GetAsyncKeyState low bit does the same there).

const COMBINED_SESSION: i32 = 0; // kCGEventSourceStateCombinedSessionState
const LEFT_BUTTON: u32 = 0; // kCGMouseButtonLeft
const RIGHT_BUTTON: u32 = 1; // kCGMouseButtonRight
const LEFT_DOWN: u32 = 1; // kCGEventLeftMouseDown
const RIGHT_DOWN: u32 = 3; // kCGEventRightMouseDown
const CONTROL_MASK: u64 = 1 << 18; // kCGEventFlagMaskControl

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGEventSourceFlagsState(state: i32) -> u64;
    fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
}

pub fn control_down() -> bool {
    unsafe { CGEventSourceFlagsState(COMBINED_SESSION) & CONTROL_MASK != 0 }
}

/// Mouse-down counts at the last poll.
pub struct Clicks {
    left: u32,
    right: u32,
}

impl Clicks {
    pub fn new() -> Self {
        unsafe {
            Self {
                left: CGEventSourceCounterForEventType(COMBINED_SESSION, LEFT_DOWN),
                right: CGEventSourceCounterForEventType(COMBINED_SESSION, RIGHT_DOWN),
            }
        }
    }

    /// ((left held, left pressed since last poll), (right held, right pressed since last poll)).
    pub fn poll(&mut self) -> ((bool, bool), (bool, bool)) {
        unsafe {
            let left = CGEventSourceCounterForEventType(COMBINED_SESSION, LEFT_DOWN);
            let right = CGEventSourceCounterForEventType(COMBINED_SESSION, RIGHT_DOWN);
            let hits = (left != self.left, right != self.right);
            self.left = left;
            self.right = right;
            (
                (CGEventSourceButtonState(COMBINED_SESSION, LEFT_BUTTON), hits.0),
                (CGEventSourceButtonState(COMBINED_SESSION, RIGHT_BUTTON), hits.1),
            )
        }
    }
}
```

- [ ] **Step 4: mac/sys.rs**

```rust
// Facts about this Mac through sysctl and statfs: what Windows reads from the
// registry and Win32 in llama.rs, local.rs and hooks.rs.

use std::ffi::{CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn sysctl_bytes(name: &str) -> Option<Vec<u8>> {
    let name = CString::new(name).ok()?;
    let mut len: libc::size_t = 0;
    unsafe {
        if libc::sysctlbyname(name.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0) != 0 || len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len];
        if libc::sysctlbyname(name.as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
        buf.truncate(len);
        Some(buf)
    }
}

fn sysctl_string(name: &str) -> Option<String> {
    let mut buf = sysctl_bytes(name)?;
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf8(buf).ok()
}

pub fn total_memory() -> u64 {
    sysctl_bytes("hw.memsize").and_then(|b| b.try_into().ok()).map(u64::from_ne_bytes).unwrap_or(0)
}

pub fn cpu_name() -> String {
    sysctl_string("machdep.cpu.brand_string").map(|s| s.trim().to_string()).unwrap_or_default()
}

pub fn os_version() -> String {
    sysctl_string("kern.osproductversion").map(|v| format!("macOS {v}")).unwrap_or_else(|| "macOS".to_string())
}

pub fn uptime_secs() -> u64 {
    let Some(buf) = sysctl_bytes("kern.boottime") else { return 0 };
    if buf.len() < std::mem::size_of::<libc::timeval>() {
        return 0;
    }
    let boot = unsafe { std::ptr::read_unaligned(buf.as_ptr().cast::<libc::timeval>()) };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    now.saturating_sub(boot.tv_sec.max(0) as u64)
}

/// (free bytes for this user, total bytes) of the volume holding `path`.
pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let unit = s.f_bsize as u64;
    Some((s.f_bavail * unit, s.f_blocks * unit))
}

pub fn host_name() -> String {
    let mut buf = [0 as libc::c_char; 256];
    if unsafe { libc::gethostname(buf.as_mut_ptr(), buf.len()) } != 0 {
        return String::new();
    }
    let name = unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().to_string();
    name.trim_end_matches(".local").to_string()
}

/// Local time as yyyymmdd-hhmmss, for backup file names.
pub fn local_stamp() -> String {
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}
```

- [ ] **Step 5: Commit** (lib.rs declares these in Task 9)

```bash
git add src-tauri/src/nowindow.rs src-tauri/src/mac/mod.rs src-tauri/src/mac/input.rs src-tauri/src/mac/sys.rs
git commit -m "macOS: no_window(), CoreGraphics input, sysctl facts"
```

---

### Task 5: Paths, updater, hook backups

**Files:**
- Modify: `src-tauri/src/log.rs:11-16`
- Modify: `src-tauri/src/fsx.rs:18-26,474`
- Modify: `src-tauri/src/updater.rs:126-129,146-157`
- Modify: `src-tauri/src/hooks.rs:15,139-142`

- [ ] **Step 1: log.rs data_dir**

Replace:
```rust
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Island")
}
```
with:
```rust
/// %LOCALAPPDATA%\Island on Windows, ~/Library/Application Support/Island on a Mac.
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    base.unwrap_or_else(std::env::temp_dir).join("Island")
}
```
Also change line 1's comment to: `// Append-only log, island.log in data_dir(), rotated past 512 KB.`

- [ ] **Step 2: fsx.rs roots and home**

Replace in `roots()`:
```rust
    for var in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "OneDrive"] {
```
with:
```rust
    #[cfg(windows)]
    const VARS: &[&str] = &["USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "OneDrive"];
    #[cfg(not(windows))]
    const VARS: &[&str] = &["HOME", "CLAUDE_CONFIG_DIR"];
    for var in VARS {
```
In `known_folders()` replace:
```rust
    let home = std::env::var("USERPROFILE").unwrap_or_default();
```
with:
```rust
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
```

- [ ] **Step 3: updater.rs**

In `start()` replace:
```rust
    if cfg!(debug_assertions) {
```
with:
```rust
    // Mac updates come with part 5; the release asset is a Windows exe.
    if cfg!(debug_assertions) || cfg!(target_os = "macos") {
```
In `after_update()` replace the block from `use windows::Win32::Foundation::CloseHandle;` through the closing `}` of `unsafe { ... }` with:
```rust
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        unsafe {
            if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                let _ = WaitForSingleObject(h, 15_000);
                let _ = CloseHandle(h);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
```

- [ ] **Step 4: hooks.rs stamp**

Line 15: put `#[cfg(windows)]` above `use windows::Win32::System::SystemInformation::GetLocalTime;`.
Replace `fn stamp()`:
```rust
fn stamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}
```
with:
```rust
#[cfg(windows)]
fn stamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

#[cfg(target_os = "macos")]
fn stamp() -> String {
    crate::mac::sys::local_stamp()
}
```

- [ ] **Step 5: Windows check and commit**

```bash
cd C:/tmp/island-mac/src-tauri && CARGO_TARGET_DIR=C:/tmp/island-mac-target cargo test --lib 2>&1 | grep -E "^error|test result"
```
Expected: all pass. (`mac::` paths are only compiled on macOS.)
```bash
git add src-tauri/src/log.rs src-tauri/src/fsx.rs src-tauri/src/updater.rs src-tauri/src/hooks.rs
git commit -m "macOS: data folder, home folder, no self-update yet, hook backup stamp"
```

---

### Task 6: claude.rs and chat.rs

**Files:**
- Modify: `src-tauri/src/claude.rs`
- Modify: `src-tauri/src/chat.rs`

- [ ] **Step 1: claude.rs imports and constants**

Put `#[cfg(windows)]` above each of these lines: `use std::io::Write;`, `use std::os::windows::process::CommandExt;`, `use windows::core::{PCWSTR, PWSTR};`, `use windows::Win32::Foundation::CloseHandle;`, the `use windows::Win32::System::Threading::{...};` statement, `use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWMINNOACTIVE, SW_SHOWNORMAL};`, `const CREATE_NO_WINDOW`, `const DETACHED_PROCESS`.

- [ ] **Step 2: claude.rs home and claude binary**

Replace:
```rust
pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}
```
with:
```rust
pub fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Claude Code's program name on this system.
pub const CLAUDE_BIN: &str = if cfg!(windows) { "claude.exe" } else { "claude" };
```
In `find_claude_exe()` replace both `"claude.exe"` with `CLAUDE_BIN`.

- [ ] **Step 3: claude.rs Windows-only functions**

Put `#[cfg(windows)]` above: `fn quote_arg`, `fn wide`, `fn spawn_console`, `pub fn claude_resume` (above its `#[tauri::command]`), `fn hook_exe`, `pub async fn claude_inject` (above its `#[tauri::command]`), `const WT_TAB_SCRIPT`, `pub async fn claude_select_wt_tab` (above its `#[tauri::command]`). Put `#[cfg_attr(not(windows), allow(dead_code))]` above `fn cwd_ok` and `fn clean_prompt`.

After `claude_select_wt_tab`, add:
```rust
// Resuming, typing into a session and picking a terminal tab come to the Mac in part 2.

#[cfg(not(windows))]
#[tauri::command]
pub fn claude_resume() -> bool {
    false
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn claude_inject() -> InjectResult {
    InjectResult { ok: false, error: Some(crate::mac::NOT_YET.into()) }
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn claude_select_wt_tab() -> Option<isize> {
    None
}
```

- [ ] **Step 4: chat.rs**

Delete `use std::os::windows::process::CommandExt;` and `const CREATE_NO_WINDOW: u32 = 0x0800_0000;`. Add `use crate::nowindow::NoWindow;` next to `use crate::secrets;`.
In `find_claude_exe()` replace both `"claude.exe"` with `crate::claude::CLAUDE_BIN`, and before its final `local.is_file().then_some(local)` line insert (Mac apps started from Finder get a short PATH, so look where Homebrew puts it too):
```rust
    #[cfg(target_os = "macos")]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let candidate = Path::new(dir).join(crate::claude::CLAUDE_BIN);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
```
(If `Path` is not imported in chat.rs, use `std::path::Path::new`.)
Replace `kill_tree`:
```rust
fn kill_tree(child: &mut Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = child.kill();
    let _ = child.wait();
}
```
with:
```rust
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_window()
        .status();
    let _ = child.kill();
    let _ = child.wait();
}
```
In `run_hidden` replace `.creation_flags(CREATE_NO_WINDOW)` with `.no_window()`.

- [ ] **Step 5: Windows check and commit**

```bash
cd C:/tmp/island-mac/src-tauri && CARGO_TARGET_DIR=C:/tmp/island-mac-target cargo test --lib 2>&1 | grep -E "^error|test result"
```
Expected: all pass. (`crate::nowindow` is declared in Task 9; until then add `mod nowindow;` to lib.rs now, after `mod net;`.)
```bash
git add src-tauri/src/claude.rs src-tauri/src/chat.rs src-tauri/src/lib.rs
git commit -m "macOS: Claude Code paths and Ask's claude lookup; Windows-only session commands"
```

---

### Task 7: local.rs and llama.rs

**Files:**
- Modify: `src-tauri/src/local.rs:423,434-473`
- Modify: `src-tauri/src/llama.rs:150-200,262-283,499,589-616`

- [ ] **Step 1: local.rs device info**

Put `#[cfg(windows)]` above `fn os_label`, above `fn device_info`, and above `fn fixed_drives`. After `fixed_drives` add:
```rust
#[cfg(target_os = "macos")]
fn device_info() -> DeviceInfo {
    use crate::mac::sys;
    DeviceInfo {
        computer: sys::host_name(),
        user: std::env::var("USER").unwrap_or_default(),
        os: sys::os_version(),
        cpu: crate::llama::cpu_name(),
        threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        uptime_secs: sys::uptime_secs(),
        drives: sys::disk_space(std::path::Path::new("/")).map(|(free, total)| vec![Drive { root: "/".into(), free, total }]).unwrap_or_default(),
    }
}
```
(Match the field types of `DeviceInfo` and `Drive` as declared in local.rs; `uptime_secs` is `u64`.)

- [ ] **Step 2: llama.rs hardware**

Put `#[cfg(windows)]` above `pub fn hardware`, `fn gpus`, `pub fn cpu_name`, `fn disk_free`, `fn extract`. After `disk_free` add:
```rust
/// Island's own runtime is the Windows llama.cpp build; Macs use Ollama until a later part.
#[cfg(target_os = "macos")]
const MAC_RUNTIME: &str = "Island's own model runtime comes to the Mac later. Install Ollama from ollama.com and pick an Ollama model.";

#[cfg(target_os = "macos")]
pub fn hardware() -> (u64, Vec<Gpu>) {
    (crate::mac::sys::total_memory(), Vec::new())
}

#[cfg(target_os = "macos")]
pub fn cpu_name() -> String {
    crate::mac::sys::cpu_name()
}

#[cfg(target_os = "macos")]
fn disk_free(path: &Path) -> Option<u64> {
    let dir = path.ancestors().find(|p| p.is_dir())?;
    crate::mac::sys::disk_space(dir).map(|(free, _)| free)
}

#[cfg(target_os = "macos")]
fn extract(_zip: &Path, _dir: &Path) -> Result<(), String> {
    Err(MAC_RUNTIME.to_string())
}
```

- [ ] **Step 3: llama.rs stop before downloading on a Mac**

First line inside `pub async fn setup(...)`:
```rust
    #[cfg(target_os = "macos")]
    return Err(MAC_RUNTIME.to_string());
```
First line inside `pub async fn ensure(...)`: the same two lines.
In `ensure`, delete `use std::os::windows::process::CommandExt;` and `const CREATE_NO_WINDOW: u32 = 0x0800_0000;` (around line 595) and replace `.creation_flags(CREATE_NO_WINDOW)` on the llama-server command (around line 616) with `.no_window()`; add `use crate::nowindow::NoWindow;` at the top of llama.rs.

If rustc warns "unreachable code" on macOS after the early return, put `#[cfg_attr(target_os = "macos", allow(unreachable_code, unused_variables))]` on `setup` and `ensure`.

- [ ] **Step 4: Windows check and commit**

```bash
cd C:/tmp/island-mac/src-tauri && CARGO_TARGET_DIR=C:/tmp/island-mac-target cargo test --lib 2>&1 | grep -E "^error|test result"
```
Expected: all pass.
```bash
git add src-tauri/src/local.rs src-tauri/src/llama.rs
git commit -m "macOS: device facts via sysctl; Local AI uses Ollama on a Mac for now"
```

---

### Task 8: overlay.rs

**Files:**
- Modify: `src-tauri/src/overlay.rs`

- [ ] **Step 1: Imports**

Put `#[cfg(windows)]` above each of the three `use windows::...` statements (lines 17-22).

- [ ] **Step 2: Window handle and activation**

Put `#[cfg(windows)]` above `fn hwnd_of`, `pub fn hwnd_raw`, and above the doc comment of `fn set_activating`. After `set_activating` add:
```rust
/// A Mac window that cannot become key never takes the keyboard from the app in front.
#[cfg(target_os = "macos")]
fn set_activating(win: &WebviewWindow, activating: bool) {
    let _ = win.set_focusable(activating);
}
```

- [ ] **Step 3: build()**

Replace:
```rust
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build()?;
```
with:
```rust
        .background_color(tauri::window::Color(0, 0, 0, 0));
    // On a Mac: on every desktop, and the first click on the pill counts even while another app is in front.
    #[cfg(target_os = "macos")]
    let win = win.visible_on_all_workspaces(true).accept_first_mouse(true);
    let win = win.build()?;
```

- [ ] **Step 4: cover()**

Wrap the `if let Some(h) = hwnd_of(win) { ... }` block in `#[cfg(windows)]` (put the attribute on the `if let` statement).

- [ ] **Step 5: Windows-only helpers**

Put `#[cfg(windows)]` above `fn cursor`, `fn button_state` (above its doc comment), `const SHELL_CLASSES`, `fn fullscreen_on` (above its doc comment), and the `ForegroundInfo` struct (above its `#[derive]`).

- [ ] **Step 6: spawn_poll**

Put `#[cfg(windows)]` above `let mut last_fg = ...;` and `let mut last_info: ...;`. After `let mut last_geom = ...;` add:
```rust
        #[cfg(target_os = "macos")]
        let mut clicks = crate::mac::input::Clicks::new();
```
Replace:
```rust
            let own = hwnd_of(&win).map(|h| h.0 as isize).unwrap_or(0);

            if last_fg.elapsed() >= Duration::from_millis(400) {
```
with:
```rust
            #[cfg(windows)]
            let own = hwnd_of(&win).map(|h| h.0 as isize).unwrap_or(0);

            #[cfg(windows)]
            if last_fg.elapsed() >= Duration::from_millis(400) {
```
Replace:
```rust
            let Some((cx, cy)) = cursor() else { continue };
```
with:
```rust
            #[cfg(windows)]
            let pointer = cursor();
            #[cfg(target_os = "macos")]
            let pointer = win.cursor_position().ok().map(|p| (p.x, p.y));
            let Some((cx, cy)) = pointer else { continue };
```
Replace:
```rust
            let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } as u16 & 0x8000 != 0;
```
with:
```rust
            #[cfg(windows)]
            let ctrl = unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } as u16 & 0x8000 != 0;
            #[cfg(target_os = "macos")]
            let ctrl = crate::mac::input::control_down();
```
Replace:
```rust
            let (left, left_hit) = button_state(VK_LBUTTON.0);
            let (right, right_hit) = button_state(VK_RBUTTON.0);
```
with:
```rust
            #[cfg(windows)]
            let ((left, left_hit), (right, right_hit)) = (button_state(VK_LBUTTON.0), button_state(VK_RBUTTON.0));
            #[cfg(target_os = "macos")]
            let ((left, left_hit), (right, right_hit)) = clicks.poll();
```

- [ ] **Step 7: island_set_focusable**

Put `#[cfg(windows)]` above its doc comment. After it add:
```rust
/// The island takes the keyboard while an inline input is open.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn island_set_focusable(app: AppHandle, focusable: bool) -> bool {
    let Some(win) = window(&app) else { return false };
    set_activating(&win, focusable);
    if focusable {
        win.set_focus().is_ok()
    } else {
        true
    }
}
```

- [ ] **Step 8: Windows check and commit**

```bash
cd C:/tmp/island-mac/src-tauri && CARGO_TARGET_DIR=C:/tmp/island-mac-target cargo test --lib 2>&1 | grep -E "^error|test result"
```
Expected: all pass.
```bash
git add src-tauri/src/overlay.rs
git commit -m "macOS: overlay cursor, clicks, Control key and focus"
```

---

### Task 9: Mac twins and lib.rs

**Files:**
- Create: `src-tauri/src/mac/{agenda,audio,dnd,game,media,msgwin,net,pipe,procs,spectrum,system,monitors,shell}.rs`
- Modify: `src-tauri/src/lib.rs:1-26,44-67`

- [ ] **Step 1: Not-yet twins**

`mac/agenda.rs`:
```rust
// Calendar accounts on a Mac come later; Calendar works from a calendar link now.

#[tauri::command]
pub async fn agenda_read() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
```
`mac/audio.rs`:
```rust
// Volume and microphone on a Mac come in part 3.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub async fn audio_state() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn audio_set() -> bool {
    false
}

#[tauri::command]
pub async fn mic_set_mute() -> bool {
    false
}
```
`mac/dnd.rs`:
```rust
// Focus (Do Not Disturb) on a Mac comes in part 4; Quiet still quiets Island itself.

#[tauri::command]
pub async fn dnd_get() -> Option<bool> {
    None
}

#[tauri::command]
pub async fn dnd_set() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
```
`mac/game.rs`:
```rust
// Game FPS and ping read Windows' ETW; there is no Mac version.

pub fn start() {}

#[tauri::command]
pub fn game_state() -> Result<(), String> {
    Err("Windows only".into())
}

#[tauri::command]
pub async fn game_fps_setup() -> Result<(), String> {
    Err("Windows only".into())
}
```
`mac/media.rs`:
```rust
// Now playing on a Mac comes in part 3.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub async fn media_state() -> Option<()> {
    None
}

#[tauri::command]
pub async fn media_control() -> bool {
    false
}
```
`mac/msgwin.rs`:
```rust
// Device, power and clipboard broadcasts on a Mac come in part 4.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}
```
`mac/net.rs`:
```rust
// Network readings on a Mac come in part 4.

#[tauri::command]
pub async fn net_sample() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn ports_listening() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
```
`mac/pipe.rs`:
```rust
// Claude Code's hook relay reaches Island over a Unix socket on a Mac (part 2).

use tauri::AppHandle;

#[derive(Default)]
pub struct Pending;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub fn hook_reply() -> bool {
    false
}
```
`mac/procs.rs`:
```rust
// Processes and windows on a Mac come in part 2 (Claude Code needs them).

#[tauri::command]
pub async fn proc_snapshot() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn win_enum() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub fn win_activate() -> bool {
    false
}

#[tauri::command]
pub fn win_foreground() -> isize {
    0
}

#[tauri::command]
pub fn win_foreground_pid() -> u32 {
    0
}

#[tauri::command]
pub fn input_modifiers_down() -> bool {
    crate::mac::input::control_down()
}

#[tauri::command]
pub fn win_allow_foreground() {}
```
`mac/spectrum.rs`:
```rust
// The music bars follow the speakers on a Mac in part 3; until then they bounce.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub fn spectrum_watch() {}
```
`mac/system.rs`:
```rust
// Battery, CPU and memory on a Mac come in part 4.

use tauri::AppHandle;

pub fn start(_app: AppHandle) {}

#[tauri::command]
pub fn power_state() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}

#[tauri::command]
pub async fn sys_sample() -> Result<(), String> {
    Err(crate::mac::NOT_YET.into())
}
```

- [ ] **Step 2: mac/monitors.rs (real)**

```rust
// Displays on a Mac, through Tauri's monitor API. Same shapes as monitors.rs on
// Windows. The work area is the screen's visible frame: below the menu bar, beside
// or above the Dock, so the pill's top edge sits just under the menu bar.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Monitor};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// lib.rs calls this in setup, before the island is placed.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub primary: bool,
    pub bounds: Rect,
    pub work: Rect,
    pub scale: f64,
    pub portrait: bool,
    /// Where the Dock is ("hidden" when it auto-hides). The menu bar is not counted.
    pub taskbar: &'static str,
}

fn dock_edge(b: &Rect, w: &Rect) -> &'static str {
    if w.x > b.x {
        "left"
    } else if w.x + w.width < b.x + b.width {
        "right"
    } else if w.y + w.height < b.y + b.height {
        "bottom"
    } else {
        "hidden"
    }
}

fn info(m: &Monitor, primary: Option<&Monitor>) -> MonitorInfo {
    let (pos, size, wa) = (m.position(), m.size(), m.work_area());
    let bounds = Rect { x: pos.x, y: pos.y, width: size.width as i32, height: size.height as i32 };
    let work = Rect { x: wa.position.x, y: wa.position.y, width: wa.size.width as i32, height: wa.size.height as i32 };
    let name = m.name().cloned().unwrap_or_else(|| "Display".to_string());
    MonitorInfo {
        id: format!("{name}@{},{}", pos.x, pos.y),
        primary: primary.is_some_and(|p| p.position() == pos && p.size() == size),
        taskbar: dock_edge(&bounds, &work),
        portrait: size.height > size.width,
        scale: m.scale_factor(),
        name,
        bounds,
        work,
    }
}

pub fn all() -> Vec<MonitorInfo> {
    let Some(app) = APP.get() else { return Vec::new() };
    let primary = app.primary_monitor().ok().flatten();
    app.available_monitors().unwrap_or_default().iter().map(|m| info(m, primary.as_ref())).collect()
}

pub fn primary() -> Option<MonitorInfo> {
    all().into_iter().find(|m| m.primary).or_else(|| all().into_iter().next())
}

pub fn find(id: &str) -> Option<MonitorInfo> {
    all().into_iter().find(|m| m.id == id)
}

pub fn at_cursor() -> Option<MonitorInfo> {
    let app = APP.get()?;
    let p = app.cursor_position().ok()?;
    let m = app.monitor_from_point(p.x, p.y).ok().flatten()?;
    let primary = app.primary_monitor().ok().flatten();
    Some(info(&m, primary.as_ref()))
}

#[tauri::command]
pub fn monitors_list() -> Vec<MonitorInfo> {
    all()
}

#[tauri::command]
pub fn monitor_at_cursor() -> Option<MonitorInfo> {
    at_cursor()
}
```

- [ ] **Step 3: mac/shell.rs (real open and HTTP)**

```rust
// Small OS actions on a Mac: open URLs (same allow-list as Windows) and files with
// `open`, reveal in Finder with `open -R`, HTTP GET. Lock, snip and the clipboard
// come in part 4.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

const SCHEMES: &[&str] = &[
    "https", "http", "vscode", "vscode-insiders", "vscodium", "cursor", "windsurf", "claude", "spotify", "msteams", "zoommtg", "zoomus", "mailto",
];

fn scheme_ok(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else { return false };
    !rest.is_empty() && SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) && !url.contains(['\r', '\n', '\0'])
}

fn open(args: &[&str]) -> bool {
    Command::new("/usr/bin/open").args(args).status().is_ok_and(|s| s.success())
}

fn open_url_checked(url: &str) -> bool {
    if !scheme_ok(url) {
        crate::log::line(format!("refused url scheme: {}", url.split(':').next().unwrap_or("")));
        return false;
    }
    let ok = open(&[url]);
    crate::log::line(format!("open url {} ok={ok}", url.split('?').next().unwrap_or("")));
    ok
}

#[tauri::command]
pub fn open_url(url: String) -> bool {
    open_url_checked(&url)
}

/// A path under the user's folders, or an allow-listed URL.
#[tauri::command]
pub fn shell_open(target: String) -> bool {
    if target.contains("://") || target.starts_with("mailto:") {
        return open_url_checked(&target);
    }
    let p = Path::new(&target);
    crate::fsx::allowed(p) && p.exists() && open(&[&target])
}

#[tauri::command]
pub fn shell_reveal(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && p.exists() && open(&["-R", &path])
}

#[tauri::command]
pub fn shell_edit_image(path: String) -> bool {
    let p = Path::new(&path);
    crate::fsx::allowed(p) && p.is_file() && open(&["-a", "Preview", &path])
}

#[tauri::command]
pub fn shell_lock() {}

#[tauri::command]
pub fn shell_snip() {}

#[tauri::command]
pub fn clipboard_set_text() -> bool {
    false
}

#[tauri::command]
pub fn clipboard_copy_image() -> bool {
    false
}

#[tauri::command]
pub fn clipboard_history() {}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
}

/// HTTPS GET for calendar feeds and weather; capped and time-limited.
#[tauri::command]
pub async fn http_get(url: String, max_bytes: Option<usize>) -> Option<HttpResponse> {
    if !url.to_ascii_lowercase().starts_with("https://") {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("Island/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let resp = client.get(&url).send().await.ok()?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.ok()?;
    let cap = max_bytes.unwrap_or(2 * 1024 * 1024).min(16 * 1024 * 1024);
    Some(HttpResponse { status, body: String::from_utf8_lossy(&bytes[..bytes.len().min(cap)]).to_string() })
}
```

- [ ] **Step 4: lib.rs modules**

Replace the module list (lines 1-26) with:
```rust
mod app;
#[cfg_attr(target_os = "macos", path = "mac/agenda.rs")]
mod agenda;
#[cfg_attr(target_os = "macos", path = "mac/audio.rs")]
mod audio;
mod chat;
mod claude;
#[cfg_attr(target_os = "macos", path = "mac/dnd.rs")]
mod dnd;
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
#[cfg_attr(target_os = "macos", path = "mac/pipe.rs")]
mod pipe;
#[cfg_attr(target_os = "macos", path = "mac/procs.rs")]
mod procs;
mod secrets;
#[cfg_attr(target_os = "macos", path = "mac/shell.rs")]
mod shell;
#[cfg_attr(target_os = "macos", path = "mac/spectrum.rs")]
mod spectrum;
mod store;
#[cfg_attr(target_os = "macos", path = "mac/system.rs")]
mod system;
mod updater;
```
(Remove the `mod nowindow;` line added in Task 6 if it is now duplicated.)

- [ ] **Step 5: lib.rs setup**

Replace:
```rust
        .setup(move |app| {
            let handle = app.handle().clone();
```
with:
```rust
        .setup(move |app| {
            // A Mac menu bar app: no Dock icon, no app menu.
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                monitors::init(app.handle());
            }
            let handle = app.handle().clone();
```
Replace `            hooks::ensure_hook_exe(&handle);` with:
```rust
            #[cfg(windows)]
            hooks::ensure_hook_exe(&handle);
```

- [ ] **Step 6: Windows check**

```bash
cd C:/tmp/island-mac/src-tauri && CARGO_TARGET_DIR=C:/tmp/island-mac-target cargo test --lib 2>&1 | grep -E "^error|test result"
```
Expected: all pass. On Windows the `path` attributes do nothing and `mod mac` is skipped.

- [ ] **Step 7: Commit, push, iterate until the Mac check is green**

```bash
git add src-tauri/src/mac src-tauri/src/lib.rs
git commit -m "macOS: Mac twins of the Windows-only modules; real displays, open and HTTP"
git push
gh run watch --exit-status $(gh run list --branch mac-part1 --workflow macOS --limit 1 --json databaseId -q '.[0].databaseId') 2>&1 | tail -5
```
Expected: `check` passes. If it fails: `gh run view --log-failed | grep -E "^.*error(\[E[0-9]+\])?:" -A6 | head -80`, fix every listed error in one commit (Windows `cargo test --lib` before each push), push again. Typical leftovers: an unused Windows import outside a `cfg`, a type in a Windows-only function signature. A failing `build` job is handled in Task 11.

---

### Task 10: What the UI offers on a Mac

**Files:**
- Create: `src/core/platform.ts`, `test/platform.test.ts`
- Modify: `src/activities/catalog.ts` (`ActivityMeta` + entries), `src/core/island.ts` (`syncActivities`), `src/app.ts` (`orderedIds`, `activityCard`), `src/styles/app.css`, `src/core/onboarding.ts` (`Facts`, `glanceChoices`, `planActivities`), `src/welcome.ts` (`facts`, `loadFacts`), `test/onboarding.test.ts`

- [ ] **Step 1: Failing test**

`test/platform.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { availableHere, detectPlatform, unavailableReason } from '../src/core/platform';

describe('platform', () => {
  it('reads the system from the user agent', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('macos');
  });

  it('everything runs on Windows', () => {
    for (const id of ['claude', 'music', 'game', 'timer']) expect(availableHere(id, 'windows')).toBe(true);
  });

  it('a Mac runs the OS-free activities and labels the rest', () => {
    for (const id of ['timer', 'weather', 'calendar', 'downloads', 'ask', 'local', 'github', 'notion']) expect(availableHere(id, 'macos')).toBe(true);
    expect(unavailableReason('music', 'macos')).toBe('Coming to Mac');
    expect(unavailableReason('claude', 'macos')).toBe('Coming to Mac');
    expect(unavailableReason('game', 'macos')).toBe('Windows only');
  });
});
```
Run: `npx vitest run test/platform.test.ts`. Expected: FAIL, cannot find `../src/core/platform`.

- [ ] **Step 2: platform.ts**

```ts
// Which system Island runs on, and which activities that system can run yet.

import { CATALOG_BY_ID } from '../activities/catalog';

export type Platform = 'windows' | 'macos';

export function detectPlatform(userAgent: string): Platform {
  return /Macintosh|Mac OS X/.test(userAgent) ? 'macos' : 'windows';
}

export const platform: Platform = typeof navigator === 'undefined' ? 'windows' : detectPlatform(navigator.userAgent);

/** Why this activity cannot run here, in words for the Activities page; null when it can. */
export function unavailableReason(id: string, on: Platform = platform): string | null {
  const mac = CATALOG_BY_ID.get(id)?.mac;
  if (on !== 'macos' || !mac) return null;
  return mac === 'never' ? 'Windows only' : 'Coming to Mac';
}

export function availableHere(id: string, on: Platform = platform): boolean {
  return unavailableReason(id, on) === null;
}
```

- [ ] **Step 3: catalog.ts**

In `ActivityMeta`, after `options: OptionSpec[];` add:
```ts
  /** On a Mac: 'soon' = comes in a later part, 'never' = Windows only. Absent = runs on a Mac. */
  mac?: 'soon' | 'never';
```
Add `mac: 'never',` to the `game` entry and `mac: 'soon',` to these entries: `claude`, `music`, `battery`, `sound`, `screenshots`, `calls`, `devices`, `external`, `system`, `clipboard`, `network`, `servers`, `quick`. (Put it after `icon:` in each.)

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/platform.test.ts`. Expected: 3 passed.

- [ ] **Step 5: island.ts guard**

In `syncActivities`, replace `      if (cfg?.enabled && !running) {` with `      if (cfg?.enabled && !running && availableHere(id)) {` and add `import { availableHere } from './platform';` to the imports.

- [ ] **Step 6: Activities page**

In `src/app.ts` add `import { availableHere, unavailableReason } from './core/platform';`.
In `orderedIds()` replace `      const band = c.enabled ? c.priority : 'available';` with `      const band = c.enabled && availableHere(id) ? c.priority : 'available';`.
In `activityCard()` replace:
```ts
  const card = h('div', { class: `act-card${c.enabled ? '' : ' off'}${open ? ' open' : ''}`, 'data-id': meta.id });
```
with:
```ts
  const reason = unavailableReason(meta.id);
  const card = h('div', { class: `act-card${c.enabled && !reason ? '' : ' off'}${reason ? ' unavailable' : ''}${open ? ' open' : ''}`, 'data-id': meta.id });
```
and replace the `toggle(c.enabled, (v) => { ... }, \`Enable ${meta.name}\`),` element with:
```ts
    reason
      ? h('span', { class: 'act-soon', text: reason })
      : toggle(c.enabled, (v) => {
          c.enabled = v;
          save(true);
          flipRender();
        }, `Enable ${meta.name}`),
```
In `src/styles/app.css` after the `.act-card.off` rule add:
```css
.act-card.unavailable .act-desc { opacity: 0.55; }
.act-soon { font-size: 12px; opacity: 0.7; white-space: nowrap; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
```

- [ ] **Step 7: First-run setup, failing test first**

In `test/onboarding.test.ts` add inside the `planActivities` describe:
```ts
  it('on a Mac, plans only what a Mac can run', () => {
    const mac: Facts = { laptop: true, claudeCode: true, platform: 'macos' };
    const plan = planActivities(answers({ uses: ['media', 'coding'], glance: ['music', 'timer', 'calendar'] }), mac);
    expect(plan.enabled).not.toContain('music');
    expect(plan.enabled).not.toContain('claude');
    expect(plan.enabled).not.toContain('battery');
    expect(plan.picked).toContain('timer');
    expect(glanceChoices(mac).map((g) => g.id)).not.toContain('music');
  });
```
Run: `npx vitest run test/onboarding.test.ts`. Expected: FAIL (type error on `platform` or `music` still enabled).

- [ ] **Step 8: onboarding.ts**

Add `import { availableHere, type Platform } from './platform';`.
In `Facts` add:
```ts
  /** The system Island runs on (Windows when not given). */
  platform?: Platform;
```
Replace `glanceChoices`'s body with:
```ts
  return GLANCE.filter((g) => (!g.laptop || facts.laptop) && availableHere(g.id, facts.platform ?? 'windows'));
```
In `planActivities` replace:
```ts
  const enabled = [...new Set([...picked, ...helpers])];
```
with:
```ts
  const here = (id: string) => availableHere(id, facts.platform ?? 'windows');
  const enabled = [...new Set([...picked, ...helpers])].filter(here);
```
and change the return to `return { picked: picked.filter(here), enabled, hidden: enabled.filter((id) => !picked.includes(id)) };`.

- [ ] **Step 9: welcome.ts**

Add `import { platform } from './core/platform';`. Replace `const facts = (): Facts => flow.facts ?? { laptop: false, claudeCode: false };` with `const facts = (): Facts => flow.facts ?? { laptop: false, claudeCode: false, platform };` and in `loadFacts` replace `flow.facts = { laptop: Boolean(power?.hasBattery), claudeCode };` with `flow.facts = { laptop: Boolean(power?.hasBattery), claudeCode, platform };`.

- [ ] **Step 10: All web checks and commit**

```bash
cd C:/tmp/island-mac && npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |Test Files"
```
Expected: tsc silent; all tests pass (previous count + 4).
```bash
git add src/core/platform.ts test/platform.test.ts src/activities/catalog.ts src/core/island.ts src/app.ts src/styles/app.css src/core/onboarding.ts src/welcome.ts test/onboarding.test.ts
git commit -m "macOS: the UI offers only what a Mac can run, labels the rest"
git push
```

---

### Task 11: Mac build and smoke test green

- [ ] **Step 1: Watch the run**

```bash
gh run watch --exit-status $(gh run list --branch mac-part1 --workflow macOS --limit 1 --json databaseId -q '.[0].databaseId') 2>&1 | tail -5
```
Expected: `check` and `build` pass.

- [ ] **Step 2: If `build` fails**, read `gh run view --log-failed | tail -60`. Bundling errors (icons, resources) are fixed in `tauri.macos.conf.json`; a smoke failure means `island.log` lacks "island ready": download the artifact (`gh run download <id> -n island-macos -D C:/tmp/mac-run`) and read `island.log` and `run.log`. Fix, push, watch again.

- [ ] **Step 3: Look at the screenshot**

```bash
gh run download $(gh run list --branch mac-part1 --workflow macOS --limit 1 --json databaseId -q '.[0].databaseId') -n island-macos -D C:/tmp/mac-run
```
Read `C:/tmp/mac-run/shot.png`. Expected: the pill at top centre just under the menu bar. If `screencapture` failed on the runner, note it and rely on the log (spec: Risks).

---

### Task 12: Windows unchanged

- [ ] **Step 1: Full Windows checks in the worktree**

```bash
cd C:/tmp/island-mac && npx tsc --noEmit && npx vitest run 2>&1 | grep -E "Tests |Test Files"
cd src-tauri && CARGO_TARGET_DIR=C:/tmp/island-mac-target cargo test --lib 2>&1 | grep -E "test result"
```
Expected: all green.

- [ ] **Step 2: Windows build starts and shows the pill**

```bash
cd C:/tmp/island-mac && CARGO_TARGET_DIR=C:/tmp/island-mac-target node scripts/tauri.mjs build --no-bundle 2>&1 | tail -3
```
Then quit the running Island from its tray icon, run `C:/tmp/island-mac-target/release/island.exe`, wait 15 s, and check `tail -3 "$LOCALAPPDATA/Island/island.log"` shows `island ready`. Quit it and restart Moss's normal Island (`release\Island.exe` in the main folder).

---

### Task 13: Docs, merge, remind

- [ ] **Step 1: Docs**

Append to `docs/ARCHITECTURE.md` under "## Rust (`src-tauri/src`)":
```markdown
### macOS

Windows code stays where it is. A module that is almost all Windows API has a Mac twin in `src-tauri/src/mac/<name>.rs`, swapped in by `#[cfg_attr(target_os = "macos", path = "mac/<name>.rs")]` on its `mod` line in lib.rs. Twins of features that come later return `Err("not on Mac yet")`; `native.ts` turns that into its fallback. Mostly-portable modules use `#[cfg(windows)]` guards, `crate::nowindow::NoWindow` for helper processes, and `crate::mac::sys` for system facts. `src/core/platform.ts` decides what the UI offers (catalog field `mac: 'soon' | 'never'`). Mac builds: `.github/workflows/macos.yml` (artifacts only until part 2).
```
Append a STATUS entry for part 1 (what works on a Mac, the CI run link, what is unverified: real-Mac clicks, focus, outside-click counters, notifications).

- [ ] **Step 2: Merge**

```bash
git add docs/ARCHITECTURE.md docs/STATUS.md && git commit -m "Docs: Island on macOS, part 1" && git push
gh pr create --base main --head mac-part1 --title "Island on macOS, part 1: foundation" --body "Spec: docs/superpowers/specs/2026-10-08-macos-foundation-design.md. Windows code unchanged except small cfg guards; Mac twins in src-tauri/src/mac/. macOS CI green; Windows tsc, Vitest, cargo tests green."
gh pr merge --merge --delete-branch
```
Tell the other session (SendMessage) that `main` moved, so it pulls before its next commit. Remove the worktree: `git worktree remove C:/tmp/island-mac`.

- [ ] **Step 3: Remind Moss**

End the part with: what works on a Mac now, how to try the `.dmg` on the borrowed Mac (Actions run › Artifacts › island-macos; right-click › Open the first time), part 2 next, and the deferred step 2 (code signing).
