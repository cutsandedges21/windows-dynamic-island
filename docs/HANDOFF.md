> **On main since 2026-11-17 (Moss asked to merge wip/widgets-taskbar).** Widgets and the taskbar work and Moss uses them; still being polished, so check the 2026-11-17 update below before changing them. No release with them yet.

# Handoff: widgets, taskbar and the NotchPixel batch (2026-11-14)

For the next Claude chat working on Island. Read this first, then docs/STATUS.md (section "2026-11-12, NotchPixel batch").

## 2026-11-17 update (taskbar)

- Tried and REJECTED by Moss: the taskbar reserving a strip along the bottom (an app bar via SHAppBarMessage) so maximized windows end above it. Removed; the taskbar floats over windows at the bottom of the work area, as before. Do not bring the strip back.
- Kept: the taskbar hides while a full-screen app is in front and comes back after (`watch_fullscreen` in src-tauri/src/dock.rs). Checked on the lit screen: a full-screen window hid it, closing it brought it back.
- The 11-16 recording (drag a widget, slide the taskbar, double-click re-centre, Start) looked right.
- Another session built these on 11-17 (uncommitted). Moss checked them in the dev server and approved them:
  - Taskbar items (src/core/dock.ts): a small battery item, now playing (title over artist, at the clock's size), Wi-Fi and sound as separate buttons, and items you can show or hide (`settings.island.taskbar.hidden`, `DOCK_ITEMS`) from right-click › "Show on the taskbar" or Settings › Widgets. island.ts feeds battery (the `power` event + powerState) and Wi-Fi (radiosState every 15 s).
  - File Shelf: a built-in activity (src/activities/shelf.ts; catalog, registry, onboarding HELPERS). Dragging files over the island opens a split card, Shelf | Land (the `zones` block in sheet.ts, 96 px tall). A drop on Land works as before. A drop on the Shelf keeps the island open until the pill or the x is clicked (`shelfPinned`). Closed, the Shelf rests as a circle opposite the bot (src/core/shelf-bubble.ts; layout.ts shelfRect/shelfPanelRect). Hovering opens it so files can be dragged out. Its x clears it, with Undo for 6 s. Files dropped on the circle go onto the Shelf.
  - Browser previews: `/?land=drag|drag-shelf|shelf|circle` (src/dev/land.ts) and `/?dock` (src/dev/dock.ts).
  - Tests: test/dock-items.test.ts, test/shelf.test.ts, test/onboarding.test.ts (now includes 'shelf').
  - Not tested yet: a real file drag in the Tauri app (the drop zones are hit-tested with elementFromPoint), and dragging files out of the Shelf circle.
- Waiting on Moss: phone screen streaming with control (RustDesk-style, built fresh, no AGPL code) to replace Chrome Remote Desktop.
- Testing rule (Moss, 11-17): check changes in the dev server (`npm run app`), not a release rebuild each time.
- 11-17 afternoon, taskbar apps (in the 12:07 exe): drag an icon to rearrange (an open app dropped among the pins gets pinned: `movePins`), right-click an icon for Pin/Unpin and Close, Mac-style hover rise (`riseAt`, 14 px HEADROOM above the bar), a launching app's icon bounces, a click on the app in front minimizes it. Windows' own minimize animation can't be pointed at our icons (only Explorer, the taskman window, is asked: `SetTaskmanWindow` is refused), so src-tauri/src/dockfx.rs draws its own: a DWM thumbnail in a click-through overlay flies between the window and the icon while SPI_SETANIMATION is off for the instant the window changes state. Restore: the window is restored 4 px inside the screen's corner (Windows pulls a fully off-screen place back on), pushed off with SetWindowPos, activated there (so the image has the active title bar), the image flies out of the icon onto the window's VISIBLE frame (DWMWA_EXTENDED_FRAME_BOUNDS; the invisible resize borders caused a shake), then the window moves in under it. Moss approved the look from a Python prototype (C:\tmp\island-scripts\fx.py); not yet seen in the exe.
- 11-17 Shelf circle fix: `ShelfBubble.place()` reported a change on every call and the island calls it on every draw, so the island redrew every frame forever; in the release exe the IPC flood stopped startup ("island ready" never logged, no island, no widgets). Now it reports only real changes (`changedIf`). The drop card's Shelf | Land split is 50/50 (both `grow: 1`).
- 11-17 later (Moss's asks): the taskbar no longer hides over a full-screen app. It glides down until its bar touches the screen's bottom edge and goes as faint as the island's Ctrl fade (opacity 0.12); the pointer anywhere from its usual top to the screen's bottom (across its width) glides it back up, opaque and working; 350 ms after the pointer leaves it goes back down (`watch_fullscreen`, `pointer_near`, `glide`, `tucked_y` in src-tauri/src/dock.rs; `.dock.faint`). Windows with a title bar never count as full-screen (a maximized window fills the screen while Windows' taskbar auto-hides; that hid our taskbar and was likely the "glitch when a window opens"). The window is moved and sized in one SetWindowPos. Open apps keep their place on the taskbar (the order they opened in: `openOrder`), instead of moving when another comes to the front.
- Apps running as administrator (Task Manager): Windows (UIPI) refuses Island's SetWindowPos, SetWindowPlacement, ShowWindow, CloseWindow and WM_CLOSE on their windows (error 5); SetForegroundWindow and SwitchToThisWindow work. So the taskbar restores them with SwitchToThisWindow (Windows' own animation, no flight: `controllable()` in dockfx.rs) and can't minimize or close them (it does nothing rather than fly an image that can't land; that was Moss's "Task Manager glitch"). procs::activate also falls back to SwitchToThisWindow, for every caller. Making it minimize them would need Island to run as administrator, or UI Automation on Windows' own (hidden) taskbar button.
- Debugging a stuck island page: start Island with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and read its console with C:\tmp\island-scripts\cdp.mjs.
- Still open: the lyrics tile with music playing.

## Where things stand (2026-11-14, ~03:00, end of the night session)

Built, in the running exe (release/Island.exe, 02:5x), uncommitted:
- Steps 1-3 of the batch (power from phone, Land shelf, Apps tile, game card + strip, phone now-playing).
- Desktop widgets: Island › Widgets page (gallery of 12 kinds, Look swatches + glass slider), drag from anywhere, right-click menu (Lock in place, sizes for lists and lyrics, Remove widget, Widget settings…), Win+D brings them up, new ones find a free spot, empty ones say why ("Music is off" / "Nothing playing").
- The taskbar: Start, Quick settings, notifications, clock, app icons (pins + open, dot/accent bar, click to bring forward/cycle/launch), music, timer; slides along the bottom by its empty space, double-click re-centres; right-click: Lock in place, Back to the middle, Taskbar settings…; own Look; Hide Windows' taskbar option (off on Moss's PC right now; default on for new users).
- Music's Control Center tile = lyrics (sizes 1x2 / 1x4 / 2x4).

Verified 2026-11-14 night by simulated input + each window's own rendering (the laptop display was off, so NO screen video yet): everything in the two bullets above for widgets and the taskbar, both looks (Matte white tried on widgets and on the taskbar, Glass shows its slider), Settings › Widgets page layout.

Next chat, in order:
1. With the screen on: `cap.py rec` a clip of dragging a widget, right-clicking it, sliding the taskbar, clicking Start; look at the frames; fix anything off.
2. Play music: check the lyrics tile in Control Center (all three sizes) and the Music widget's sizes.
3. Moss's request 7: step 5 websites in a drawer, step 6 languages (FR, ES, DE, IT), outlined agent rows, notchify's mascot in Claude's expanded view (always orange). Each needs a short spec first (see STATUS.md plan).

## Moss's requests still open (2026-11-14, in his words, condensed)

1. Visually verify everything: screenshots AND screen recordings, before saying it works.
2. Settings: a separate, clean, polished section for widgets.
3. Widgets get the same look options as the island: solid (black, white), matte (black, white), glass with its slider.
4. The taskbar must be fully functional.
5. Right-click on a widget or the taskbar: make it draggable or not (lock). Widgets that show more when bigger get size options there too (simple).
6. Music's Control Center tile = lyrics (cover, title, artist, lyrics big), sizes 1x2, 1x4, 2x4. Built, needs an exe + a look.
7. After that, the rest of the batch: step 5 websites in a drawer, step 6 languages (FR, ES, DE, IT), outlined agent rows, notchify's pixel mascot in Claude's expanded view (always orange).

## How to verify on this PC (important)

- PowerShell/GDI screenshots (CopyFromScreen) do NOT show WebView2 windows here (they missed the widgets, the taskbar and Windows' own taskbar). Use Desktop Duplication:
  `python -I C:\tmp\island-scripts\cap.py shot OUT.png [x y w h]` and `... rec OUT.mp4 SECONDS [x y w h]` (ffmpeg ddagrab; physical px, screen is 1920x1080 at 125 %).
- PrintWindow per window (`C:\tmp\island-scripts\grab.ps1`) shows what a window draws even when covered.
- `C:\tmp\island-scripts\wins.ps1` lists Island's windows (DPI-unaware: logical coords, 1536x864).
- Vitest: always `cd "/c/Users/sport/OneDrive/Documents/CodingPersonal/windows-dynamic-island" && npx vitest run` (without that exact cd it finds no runner).
- Multi-line edits: write a Python script to C:\tmp\island-scripts and run `python -I 'C:\tmp\island-scripts\x.py'` (heredocs with quotes break). src/core/settings.ts is NOT valid UTF-8: edit it with latin-1 decoding.
- Rebuild: stop Island (`Stop-Process -Name island`), `npm run release` (5-8 min), start `release\Island.exe`. Phone site: `npm run phone:deploy` only when Moss asks in that message.

## What was learned

- `#stage` has `pointer-events: none` (the island needs it): any new page drawn on the stage (widgets, taskbar) must set `pointer-events: auto` on its own elements, or it gets no clicks.
- Every window hears every Tauri event: give each widget its own event name (`widget-frame-<id>`).
- Desktop widgets survive Win+D by being OWNED by the desktop icon view (SHELLDLL_DefView): `SetWindowLongPtrW(GWLP_HWNDPARENT, defview)` (idea from DeskBox; DeskBox is GPL-3.0 and widget-js has no license, so no code from either may be copied into Island).
- The taskbar window sits in the topmost band but Windows' taskbar stays above it: place it at the bottom of the WORK AREA (above Windows' taskbar), or hide Windows' taskbar (Settings › Taskbar › Hide Windows' taskbar, `dock_autohide`, restored on quit via `dock::quit`).
- Never write a file with `open(p, 'wb').write(s.encode(...))`: the open truncates first, and an encode error then leaves an EMPTY file (this emptied src/core/settings.ts twice on 2026-11-14). Write to `p + '.tmp'` and `os.replace`. If settings.ts is ever empty again: `git show :src/core/settings.ts > src/core/settings.ts`, then `python -I C:\tmp\island-scripts\settings_rebuild.py` re-applies every working edit (sound settings, tall tile sizes, widgets, taskbar, looks).
