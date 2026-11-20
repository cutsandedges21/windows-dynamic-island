# Island on a Mac

Island runs on macOS 12 (Monterey) and later, on Apple chips and Intel. The Mac version is the same app as on Windows: the same island, the same activities and settings. Only the layer that talks to the system is different. That layer lives in `src-tauri/src/mac/`, in `hook/src/unix.rs`, and behind `#[cfg(target_os = "macos")]` / `platform === 'macos'`. The Windows code paths are untouched.

## What works on a Mac

| Activity | How the Mac does it |
|---|---|
| Claude Code, Codex, Cursor, Antigravity, Other apps | Their hooks reach Island through `island-hook` over a Unix socket (`~/Library/Application Support/Island/hook.sock`). Permission prompts, questions and replies work in the island, the same as on Windows. Claude Code's limits use its sign-in from the Keychain. A closed chat reopens in Terminal. Replies are typed into the chat's Terminal or iTerm tab, and the chat's tab comes forward. |
| Music | The Mac's Now Playing (every player, browsers too), with the album art and the controls. From macOS 15.4, which only lets Apple's own apps read Now Playing, Spotify and Music are asked directly. |
| System Controls, Quick Actions | Volume, mute, the output device and the microphone (Core Audio). The built-in screen's brightness. The Wi-Fi and Bluetooth switches and their menus. Lock, the screenshot toolbar. |
| Battery, System Stats, Network, Local Servers | IOKit, the Mach statistics and the GPU's own counters (CPU, memory, GPU, the apps using the most), interface counters, `lsof` for dev servers. |
| Clipboard, Screenshots, Devices | The pasteboard (password managers skipped), the screenshot folder (the Desktop unless changed), drives under `/Volumes`, earbud and mouse batteries. |
| Mic & Camera | Whether the microphone or a camera is in use (macOS doesn't say which app, so Island names the call app that runs). Mute for every app. The camera button sends Zoom's, Teams' or Meet's own shortcut. |
| Calendar, Reminders | The Mac's own calendars (EventKit). Reminders go on the Notification Center's schedule, so they show even when Island is closed. |
| Workspaces, Apps | Opening apps, files, folders and commands; saving and restoring window layouts; noticing what you work on. Apps starts with the Dock's apps, with their real icons. |
| Taskbar, widgets, screen border | Island's own taskbar, desktop widgets and screen border, over every Space. The taskbar's Start button opens the Mac's app launcher. |
| Land, Island on your phone, Bot chat, Timer, Weather, Hockey, GitHub… | The same code as on Windows. |

## What macOS asks the first time

Each permission shows macOS's own prompt once, when the feature is first used:

- **Automation** (Terminal, iTerm, System Events, Spotify, Music): bringing up a chat's tab, typing a reply into it, restarting or shutting down from your phone, the Spotify/Music fallback.
- **Accessibility**: restoring window layouts, raising one particular window, the taskbar's minimize/close, the call camera's shortcut.
- **Calendars**, **Bluetooth**, **Local Network** (Land), **Notifications**.

Why Island asks is written in `src-tauri/Info.plist`.

## What a Mac can't do, and what Island does instead

- **Quiet doesn't switch Focus.** macOS lets no third-party app turn Focus on or off. Quiet still quiets Island itself, and says so once.
- **Games and Phone (Phone Link)** stay Windows-only. Frame rates need Apple-only access. On a Mac, an iPhone's notifications already show in the Mac's own Notification Center.
- **The music bars bounce** instead of following the sound. Reading the Mac's sound output needs a separate audio driver on macOS 12.
- **The tray's icons** aren't in Island's taskbar: a Mac keeps those in its menu bar.
- **Dragging files out of the Shelf** isn't on a Mac yet. A shelf file opens or shows in the Finder instead.
- **Island's own Local AI model runtime** isn't on a Mac yet: Bot chat uses Ollama there.

## How it is built and checked

- `.github/workflows/macos.yml` runs on every push to any branch. It builds the hook relay for both chips (`lipo`), the web pages lowered for Safari 15 (`ISLAND_MAC=1`, see `vite.config.ts`), and the universal `.app` and `.dmg`. It runs every Rust test on a Mac, then starts Island, sends it Claude Code events through the relay and takes screenshots.
- The Mac web build adds `src/mac/compat.ts` (what Safari 15 lacks) and `src/mac/words.ts` (the Activities page in a Mac's words). The Windows build doesn't include them and is unchanged.
- Rust for macOS can be type-checked on Windows without a Mac (a stand-in C compiler for the build scripts). Linking and running need the Mac CI.
