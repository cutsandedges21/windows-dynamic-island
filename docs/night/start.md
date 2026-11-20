# start — ask #16: Island's own Start menu (owner: start)

## Design (decided 23:35)
- The taskbar has NO Start button today: commit 531f92d turned it into the Apps arrow (dk-start = arrow).
  So: a NEW Start button (Windows-like logo, Island look) goes back at the bar's start, before the arrow
  (DOCK_ITEMS gets 'start', so it can be hidden like the rest). Moss's "windows button" most likely also
  means the Windows KEY: a low-level keyboard hook (only while the taskbar is on and the setting says
  Island's Start) opens Island's Start on a lone Win press; Win+E, Win+D etc. still go to Windows
  (lone press is swallowed and masked with vkE8 like AutoHotkey's MenuMaskKey, then Win-up injected).
- The menu is its OWN window (label "start"), not inside the dock window: the dock window is exactly
  the bar's length with the bar at a fixed 12px offset (growing it would move the bar), and the taskbar
  agent is reworking dock sizing for "Edit position". The start window's bottom edge sits on the bar's
  top edge (bottom side; mirrored for top/left/right), so the menu slides out from behind the bar with a
  spring, like the Apps card. Hidden (not destroyed) after close; pre-made a few s after the taskbar shows.
- Data: Start's app list = ws_apps (AppsFolder), icons = apps_icons, launch = ws_launch (all existing);
  new Rust (startmenu.rs): recent files (Recent folder .lnk), user name + account picture (registry),
  allow-listed actions (Settings, Explorer, Documents, Downloads, Pictures, power: lock/sleep/sign out/
  restart/shut down reusing shell.rs power code; Win+X tools for the Start button's right-click), web /
  files search, run as admin, open file location.
- Settings: settings.island.start = { opens: 'island' | 'windows', winKey: boolean, pins: StartPin[] | null }
  (pins null = not set up; the first open seeds them from the taskbar's apps + common apps).
- Island side: StartHost (in startmenu.ts) sends 'start-frame' (look, pins) to the start window, saves pin
  changes ('start-pins'), handles 'start-pref', drives native.startKeys / startPrepare; DockHost's 'start'
  act calls it (hook `startMenu`).

## Status
- [ ] 1 Rust startmenu.rs + lib.rs + capabilities (cargo check, cargo tests)
- [ ] 2 native.ts wrappers
- [ ] 3 startmenu.ts page + host + helpers + CSS + vitest
- [ ] 4 settings.ts (start prefs, DOCK_ITEMS 'start')
- [ ] 5 dock.ts hook (Start button, anchor report, act, right-click menu)
- [ ] 6 island.ts wiring
- [ ] 7 main.ts routing + /?start preview (src/dev/start.ts)
- [ ] 8 Settings › Taskbar rows (widgets-page.ts → src/start-settings.ts)
- [ ] 9 screenshots black/white/glass/matte, iterate
- [ ] 10 tsc + vitest + cargo check

## Files touched
- docs/night/start.md (this file)

## How to check
- (later)

## Open questions
- Keep the Apps arrow next to Start? (kept; hideable)
