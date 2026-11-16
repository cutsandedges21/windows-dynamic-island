> **WORK IN PROGRESS (2026-11-16): desktop widgets and the taskbar are NOT finished.** They run, but they have only been checked by simulated input (no screen recording yet), so expect rough edges. This is on a `wip/` branch on purpose: do not merge into `main` or release it until the list below is done.

# Handoff: widgets, taskbar and the NotchPixel batch (2026-11-14)

For the next Claude chat working on Island. Read this first, then docs/STATUS.md (section "2026-11-12, NotchPixel batch").

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
