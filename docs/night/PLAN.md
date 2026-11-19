# Night batch 2026-11-18 → 11-19 (Moss asleep)

Moss's 17 asks (his words, condensed). Owner in brackets. Progress per owner lives in `docs/night/<owner>.md`
(each owner keeps it current after every step: done / next / files touched / how to check / open questions),
so anyone can resume if an agent is stopped by the usage limit.

| # | Ask | Owner |
|---|-----|-------|
| 1 | Taskbar: an app's open-windows preview shows only after a delay, not instantly | taskbar |
| 2 | Remove "Lock in place"; the taskbar is ALWAYS locked. Add "Edit position" (taskbar right-click + Settings › Taskbar; keep "Back to the middle"). In edit mode you can stretch it upwards and sideways like a window (e.g. wider and shorter), drag it, double-click to centre | taskbar |
| 3 | Rise style: the app under the mouse not only rises but also takes more space (magnifies and pushes neighbours apart, like Windhawk / macOS Dock magnification) | taskbar |
| 4 | "Show names" option on the taskbar: add style/font options for the names | lead |
| 5 | Settings › Taskbar: put the styles (Rise, Spotlight, Glide, Names) in their own separated group, same page | lead |
| 6 | Taskbar right-click › Settings just opens the page; fix (Activities does almost the same; Moss wants to talk about it) | lead |
| 7 | Settings: switches are too bright when ON; tone them down | lead |
| 8 | Taskbar Glass tint slider: dragging it draws a rectangle round it (focus outline); remove it | lead |
| 9 | "Blend into the bottom" and "Auto-hide" go INSIDE "Hide Windows' taskbar" (only shown when that is on) | lead |
| 10 | Taskbar sits ABOVE Windows' taskbar automatically when Hide Windows' taskbar is off; at the very bottom when it is on | taskbar |
| 11 | System tray icons (notification area) inside Island's taskbar (right now even Island's own icon can't be seen) | tray |
| 12 | Screen border and notches get their own look (black, white, matte, glass…), Auto-hide, Melt, and Blend into the [edge it sits on] options | border |
| 13 | Land: received file/image card gets an "Open" button (next to "Show in folder") | border |
| 14 | Taskbar app icons must match Windows' taskbar icons exactly | taskbar |
| 15 | Notches: keep the hover look EXACTLY; fix the resting (not hovered) look, now squashed/stretched. Moss likes how they look in the Settings preview | border |
| 16 | Start button on Island's taskbar opens Island's OWN Start menu (out of the taskbar) with everything Windows' Start has, in Island's UI | start |
| 17 | Music widget shows colour from the album art like the island does | border |
| 18 | (Moss's 2nd msg "15") Notches can be dragged anywhere, not only the 4 corners: an Edit button lets you drag, Done locks it, Reset puts it back (like Control Center's edit). PLUS an option to leave them unlocked so you can always drag them | lead (after border is done) |
| 19 | (Moss's 2nd msg "16") Taskbar Apps card search must find EVERY app on the PC, not only ones in Start (no need to pin to Start first) | lead (after start is done; shares apps.rs) |

## Justin sync
Moss: talk to Justin's Claude on GitHub issue #20 so nobody overwrites the other. Posted our file list there 23:30 (comment 6999728781). Before pushing: `gh issue view 20 --repo cutsandedges21/windows-dynamic-island --json comments`, `git pull --rebase`.

## Lead progress (Settings items)
- #7 switches toned down (settings.css `.switch.on` mixes accent into the window colour, no glow). #8 slider focus box removed (`.row input[type='range']:focus`). Not yet screenshotted.
- #9 Blend/Melt/Auto-hide nested under Hide Windows' taskbar when the bar is at the bottom (`barNeedsHidden/barEdge/barAutoHide` in settings.ts; island.ts hooks gate them and turning one on from the taskbar menu turns Hide Windows' taskbar on; previews.ts uses barEdge).
- #5 Styles on their own card (`stylesSection` in widgets-page.ts). #4 Names is a style of its own (`DOCK_STYLES` + 'names', migration keeps names for old Glide users) with Font (System/Clean/Serif/Mono/Handwritten), Look (Bubble/Plain/Outline), Bold, and a sample; dock.ts sets `html[data-name-font/look]`, CSS in island.css + settings.css. tsc clean 23:29. Not yet screenshotted.
- #6 not built: needs Moss's call (see morning notes).
- 23:34 checked in headless Chrome: Settings › Taskbar page (`C:/tmp/island-scripts/night/settings-taskbar.png`), name styles on the bar (`night/dock-names-all.png`; dock preview takes `&names=serif,plain,bold`). Not yet: real app, vitest.

## Rules for everyone (read before editing)
- Repo: `C:/Users/sport/OneDrive/Documents/CodingPersonal/windows-dynamic-island` (Tauri 2 app "Island": Rust in `src-tauri/src`, TS in `src`). Read `docs/HANDOFF-BORDER-SETTINGS.md` (tools, previews) and `docs/HANDOFF.md` (taskbar history) as needed.
- Several agents edit this working tree AT THE SAME TIME. Stay in your own files. Shared files (`src/core/dock.ts`, `src/styles/island.css`, `src/widgets-page.ts`, `src/app.ts`, `src/core/native.ts`, `src-tauri/src/lib.rs`, `src/core/settings.ts`, `src/styles/settings.css`): small targeted edits with the Edit tool only. Never rewrite a whole shared file, never run a formatter over it, never `git checkout/stash/reset/commit`. If an Edit fails because the file changed, re-read and redo.
- `src/core/settings.ts` is NOT valid UTF-8: edit it with a Python script that reads/writes latin-1, writes `p+'.tmp'` then `os.replace` (never open-for-write first). Re-read right before writing. Scripts go in `C:/tmp/island-scripts`, run with `python -I`.
- Do NOT stop or restart the running `release/Island.exe`, do NOT run `npm run release` or `npm run app`. The lead builds and tests the real app at the end.
- Checks you CAN run: `npx tsc --noEmit -p .`; vitest: `cd "C:/Users/sport/OneDrive/Documents/CodingPersonal/windows-dynamic-island" && env -u ELECTRON_RUN_AS_NODE node node_modules/vitest/vitest.mjs run [file]`; `cd src-tauri && cargo check` (others share the cargo lock; errors in files you don't own are someone else's work in progress: ignore or wait). Browser previews through the Vite server already running at `http://localhost:5188` (do not start/stop servers): `node C:/tmp/island-scripts/pv.mjs "<query or url>" out.png [w] [h] [dpr] ["<js>"]` with env `WAIT`, `PRE`, `MOUSE` (see HANDOFF-BORDER-SETTINGS.md › Tools); then LOOK at the png with Read.
- UI words: plain, short, sentence case, like the existing Island UI. Match existing looks (black, white, matte black, matte white, glass) and the island's springy motion.
- No reviewer/verifier work, no subagents. Moss's note about the usage window is for the lead: do your work properly, but keep your progress file current because you may be stopped at any moment.
