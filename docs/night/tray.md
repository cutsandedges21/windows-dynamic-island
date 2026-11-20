# tray (#11): Windows tray icons inside Island's taskbar

Status: STARTED (reading code). Nothing edited yet.

## Plan
1. Rust `src-tauri/src/trayhost.rs`: hidden "Shell_TrayWnd" window on its own thread, above Explorer's;
   parses WM_COPYDATA (dwData 1) NOTIFYICONDATA, forwards EVERYTHING to Explorer's real Shell_TrayWnd.
   Broadcasts "TaskbarCreated" on start. Icons -> PNG data URLs. Event `tray-icons` + commands.
2. lib.rs: `mod trayhost;` + commands registered + start/stop hooks (small edits).
3. native.ts wrappers (small edit).
4. `src/core/dock-tray.ts`: row of tray icons + overflow card; small hook in dock.ts; DOCK_ITEMS 'tray'.
5. Tests: vitest for pure TS logic; cargo tests for parsing.

## Done
(nothing yet)

## Next
Step 1.

## Files touched
(none yet)

## How to check
(later)

## Open questions
(none yet)
