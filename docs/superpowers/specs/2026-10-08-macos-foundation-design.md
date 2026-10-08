# Island on macOS, part 1: Foundation

Approved by Moss on 2026-10-08. Part 1 of 5 of the macOS version (step 3 of Moss's plan; step 2, code signing, is deferred).

## Goal

Island builds for macOS on GitHub's Mac runners and runs on a Mac: the pill floats just under the menu bar and looks and moves exactly as on Windows. Activities that need no OS-specific code work. Everything else says "Coming to Mac" instead of failing. The Windows app keeps working unchanged.

## The five parts

1. **Foundation** (this spec): builds, the window, OS-free activities, a "not on Mac yet" answer for the rest.
2. **Claude Code**: sessions, limits, the hook relay (Unix socket instead of a named pipe), permission and question cards, replies, resume in Terminal.
3. **Music and sound**: now playing, volume, the music bars.
4. **System**: battery, CPU/RAM, network, screenshots, clipboard, Do Not Disturb, displays, calls, devices, quick actions, servers, the built-in llama.cpp runtime.
5. **Mac auto-update** (step 4 of Moss's plan), plus Touch ID (the vendored `tauri-plugin-biometry` already has a macOS backend).

Games (FPS/ping) stays Windows-only: it reads ETW, which has no Mac counterpart.

## Decisions

- **Placement**: below the menu bar, like Windows. The notch is ignored. Other edges stay available in Settings.
- **Testing**: GitHub's Mac runners build and smoke-test every change; Moss checks on a borrowed Mac a few parts at a time.
- **Code organization** (option 1 of 3): Windows code stays where it is, behind `#[cfg(windows)]`. Mac code goes in `src-tauri/src/mac/`, one file per feature. No shared platform trait, no fork.
- **Distribution**: Mac builds are GitHub Actions artifacts only. The first Mac release on the Releases page waits for part 2. Builds are universal (Apple Silicon and Intel), macOS 12 and later, unsigned (ad-hoc signed by the toolchain); the first open on a Mac needs right-click › Open or System Settings › Privacy & Security › Open Anyway.

## Code organization

- A module that is almost all Windows API (`media.rs`, `audio.rs`, `system.rs`, `net.rs`, `monitors.rs`, `shell.rs`, …) gets a Mac twin, `src-tauri/src/mac/<name>.rs`, swapped in by `#[cfg_attr(target_os = "macos", path = "mac/<name>.rs")]` on its `mod` line in `lib.rs`. The Windows file does not change. The twin has the same command names, so the command list in `lib.rs` is the same on both systems.
- A module that is mostly portable (`overlay.rs`, `claude.rs`, `chat.rs`, `local.rs`, `llama.rs`, …) keeps one file; its Windows-only lines get `#[cfg(windows)]` and Mac lines `#[cfg(target_os = "macos")]`.
- In part 1 a twin's command for a later feature returns `Err("not on Mac yet")`; `native.ts`'s `call()` turns any error into its fallback (`null`, `[]`, `false`, `0`), which the UI already treats as "nothing here". No reading is invented.
- Start-up tasks in `lib.rs` that are Windows-only (`msgwin::start`, `pipe::start`, `hooks::ensure_hook_exe`, `game::start`, the updater) do nothing on the Mac.
- `windows`, `windows-core` and `windows-registry` move to `[target.'cfg(windows)'.dependencies]`. `keyring` uses `windows-native` on Windows and `apple-native` on macOS. New Mac-only crates, if any, go under `[target.'cfg(target_os = "macos")'.dependencies]`.
- `hook/` (the `island-hook` relay) is not built for the Mac in part 1. `build.rs` already embeds an empty file when `bin/island-hook.exe` is missing.

## The window on a Mac

The same design as Windows (`overlay.rs`): one transparent, borderless, always-on-top window over a monitor's work area, with the pill drawn inside it.

- **Area**: Tauri's `Monitor::work_area()`, which on macOS is the screen's visible frame: below the menu bar, above the Dock. So the pill's top anchor lands just under the menu bar with no Mac-specific layout code.
- **Transparency**: macOS needs Tauri's `macos-private-api` cargo feature and `"macOSPrivateApi": true`.
- **No Dock icon, no app menu**: `ActivationPolicy::Accessory`.
- **Every desktop**: `visible_on_all_workspaces(true)`.
- **Click-through**: the existing 16 ms cursor poll and `set_ignore_cursor_events`, already cross-platform in Tauri. The Mac cursor read uses Tauri's `cursor_position()` instead of `GetCursorPos`.
- **Focus**: the pill must not take focus from the app in front, except while its text input is open. Windows toggles `WS_EX_NOACTIVATE`; the Mac uses `set_focusable(bool)` from the same `island_set_focusable` command.
- **Monitors**: `monitors.rs` lists screens through Tauri's monitor API on the Mac.
- **Tray**: the Tauri tray icon becomes a menu bar icon. Same menu.

Not in part 1: hiding over full-screen apps, the notch, a template (monochrome) menu bar icon.

## Platform-specific config

`src-tauri/tauri.macos.conf.json` (merged over `tauri.conf.json` by Tauri on macOS) sets: bundle targets `app` and `dmg`; PNG icons (Tauri makes the `.icns`); no `island-hook.exe` resource; `bundle.macOS.minimumSystemVersion: "12.0"`. `app.macOSPrivateApi: true` goes in `tauri.conf.json` itself, with the `macos-private-api` cargo feature on every platform: Tauri's CLI rewrites the cargo features to match the config, so a Mac-only setting would flip `Cargo.toml` between systems. Windows ignores both.

## What runs on a Mac in part 1

- **Works**: the pill and its animations, Control Center, the Activities and Settings windows, first-run setup, Timer, Weather, Calendar from an ICS link, the seven integrations (GitHub, Vercel, n8n, Stripe, Cal.com, Resend, Notion), Ask, Local AI through Ollama. The implementation plan confirms each one by listing the native commands it calls; any activity whose commands have no Mac version yet moves to "Coming to Mac".
- **Coming to Mac**: every other activity. On the Mac the Activities window shows it greyed out with "Coming to Mac" and it cannot be switched on; first-run setup does not offer it.
- **Windows only**: Games, labelled "Windows only".
- The UI learns the platform once: `native.ts` exports `platform` (`'macos'` when the webview's user agent says Macintosh, otherwise `'windows'`). Catalog entries get an optional `mac?: 'soon' | 'never'`; no field means "works on the Mac".

## Files and folders on a Mac

- Data folder (`log::data_dir()`, settings, models): `~/Library/Application Support/Island` instead of `%LOCALAPPDATA%\Island`.
- Log: `island.log` in that folder, as on Windows.
- Claude Code's folder (`~/.claude`) is the same on both systems; part 2 uses it.

## Build and CI

- `.github/workflows/macos.yml`, on push to `main` and on manual run, on `macos-latest`:
  1. Install Node and Rust with both Apple targets; cache Cargo.
  2. `npm ci`, `npm run build:web` (typecheck + Vite).
  3. `npx tauri build --target universal-apple-darwin --bundles app,dmg`.
  4. Smoke test: start the built app, wait 20 s, take a screenshot with `screencapture`, copy `island.log`, quit it.
  5. Upload the `.dmg`, the screenshot and the log as artifacts.
- The job fails if the build fails or the log lacks "island ready".
- If a local `cargo check --target aarch64-apple-darwin` works on Moss's PC, it is used for fast feedback before pushing; CI stays the source of truth.

## Done when

- **Windows unchanged**: `tsc`, all Vitest tests and the cargo lib tests pass on Windows, and a Windows build starts and shows the pill.
- **Mac on CI**: the workflow is green, the screenshot shows the pill under the menu bar, the log has "island ready" and no panic.
- **Mac by hand** (when Moss has the borrowed Mac; not required to close part 1): the `.dmg` opens, the pill sits under the menu bar, clicks on the pill work and clicks elsewhere pass through to the app behind, Control Center opens, a timer runs, there is no Dock icon.

## Working alongside other sessions

Another Claude session is editing this repo (Control Center, sheet, settings, onboarding). Before touching a file another session may be editing (`src/activities/catalog.ts`, settings, onboarding), message it through ListAgents/SendMessage to agree who takes which file. Commit only part-1 files, by explicit path. The other session owns Windows releases.

## Risks

- **Slow feedback**: each CI round is about 15 minutes. Mitigation: a local cross-target `cargo check` if it works, and batching fixes per round.
- **Click-through on macOS**: `set_ignore_cursor_events` toggled from a poll may behave differently from Windows (for example, the first click after a toggle). Only a real Mac shows this; the CI screenshot cannot.
- **CI screenshots**: `screencapture` on a runner may need permissions the runner lacks. If so, the smoke test checks the log only and the screenshot is dropped.
- **Notifications**: unsigned Mac apps may not get notification permission; acceptable until part 5.
