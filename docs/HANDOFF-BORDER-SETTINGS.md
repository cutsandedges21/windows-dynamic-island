# Handoff: screen border, notches, island melt, Settings redesign (2026-11-18)

Read this first in the next chat. Nothing here is committed. Do not commit unless Moss asks.
Other sessions (Cursor chats, other Claude chats) edit the same tree: stage only your own hunks if ever asked to commit.

## Moss's standing rules (from this and earlier sessions)
- Keep only ONE build backup (n-1). It is now `release/Island.prev.exe` (scripts/tauri.mjs). NOT `Island.old.exe`: Island's updater deletes that name on every start (updater.rs tidy), which is why earlier backups "vanished".
- Don't commit unless asked. Never review agents. Build/fan-out agents only when Moss says.
- Glide unchanged; Spotlight smooth and persistent; taskbar styles combinable.
- Do NOT change island size (Moss: "let that be").
- Show visual progress: screenshot big changes. The Playwright MCP plugin fails to connect in these sessions; use the headless Chrome script `C:\tmp\island-scripts\pv.mjs` (see Tools) or open the preview in real Chrome (`chrome.exe --new-window "<url>"`).
- Ask Moss when anything is unclear (he said so repeatedly).
- Moss writes short; reply short, ADHD format (what's done first, numbered, no recap walls).

## Tools / commands
- Dev server: Vite already running on `http://localhost:5188` (also 5199 / 1430 from other sessions). Previews:
  - Taskbar: `/?dock&edge=1&melt=1&border=1&side=left|right|top|bottom&look=black|white|matte-black|matte-white|glass&size=small|medium|large&styles=rise,spotlight,glide&gap=190`
  - Border + notches: `/?frame&dock&edge=1&melt=1&border=1&island=1&glow=claude&motion=still|orbit&size=small|medium|large&sites=bottom-left|off&shelf=bottom-right|off&out=sites,shelf`
  - Island: `/?x=1` (or `/?fill` = open island with data); seed settings with PRE (below).
  - Settings window: `http://localhost:5188/app.html#<page>`; needs WAIT≈5000–8000 first load, and inject CSS `*{backdrop-filter:none!important}` or headless shows blank (Mica blur).
- `C:\tmp\island-scripts\pv.mjs`: `node pv.mjs "<query or full http url>" out.png [w] [h] [dpr] ["<js expr>"]`. Env: `WAIT=ms`, `PRE="<js run before page>"` (e.g. `localStorage.setItem('island:settings', JSON.stringify({...}))`), `MOUSE=x,y` (hover before shot).
- `C:\tmp\island-scripts\pyrep.py <file> <patch>`: applies `@@@ OLD / @@@ NEW / @@@ END` blocks (exact, unique). Use it (or the Edit tool); bash heredocs with backticks break.
- Real screen: `python -I cap.py shot <png>` in `C:\tmp\island-scripts` (Desktop Duplication). Moss's screen is 1920×1080 at 125%: any Python that moves the mouse must call `ctypes.windll.shcore.SetProcessDpiAwareness(2)` first. The white box seen around the pointer in captures is Moss's pointer, not a bug.
- `C:\tmp\island-scripts\framestyle.py [island|screen] [bottom|left|right|top]`: stops Island, turns border on (+ blend, taskbar edge+melt), restarts release exe. `dockstyle.py` = taskbar styles.
- Tests: `cd "C:/Users/sport/OneDrive/Documents/CodingPersonal/windows-dynamic-island" && env -u ELECTRON_RUN_AS_NODE node node_modules/vitest/vitest.mjs run` (uppercase C: path). Last full run: 95 files / 1366 tests pass (before Settings redesign; frame.test.ts now has 12).
- Type check: `npx tsc --noEmit -p .`
- Release build (~5 min, run in background): `env -u ELECTRON_RUN_AS_NODE npm run release > /c/tmp/island-scripts/build-frame.log 2>&1`. To stop a build, kill the process tree (TaskStop alone leaves cargo running): PowerShell `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'tauri.mjs release|cargo.*custom-protocol|tauri.js. build|npm-cli.js. run release' } | % { Stop-Process -Id $_.ProcessId -Force }`.
- Island log: `%LOCALAPPDATA%\Island\island.log`. Settings: `%APPDATA%\com.moss.island\settings.json`.
- Moss's settings right now: blend on, taskbar on/edge/melt/bottom, frame on, glow 'screen', sites notch on (bottom-left, small), shelf notch on (bottom-right, small), sites = GitHub, YouTube (+ maybe Claude).

## Current build state
- `release/Island.exe` = 15:02 build (running). `release/Island.prev.exe` = 14:22.
- Everything listed under "Done since the 15:02 build" is in the code but NOT built yet.
- The code TYPE-CHECKS again (last step of the session): the Settings pages are split and wired. What's left is mainly the CSS (see "Still TO DO"). Full vitest not re-run after the Settings changes.

## Done and in the 15:02 build (verified on Moss's real screen)
1. Taskbar on any side (bottom/left/right/top) with all sizes/styles: `src-tauri/src/dock.rs` (`Side`, `place_on`, `dock_side`, pivot for top split), `src/core/dock.ts` (axis helpers, `meltMasks(side,…)`, vertical layout), CSS in island.css ("the taskbar on a side or the top"). Top taskbar splits round the island (gap = pill width via `dock-gap` event; `island.ts dockSplits/reportPill`). Right-click menu has Position. Settings › Taskbar has Position. Real screen tested only for bottom; left/right/top only in preview.
2. Screen border: own window `frame` (`src-tauri/src/frame.rs`: full screen, click-through except notch rects, restack island > dock > frame every 300 ms, hides under full-screen games via `dock::full()`, shares the WebView2 drop target like overlay.rs so files can be dropped). Page `src/core/frame.ts` (`runFrame`, `FrameHost`). Border width `FRAME_W = 4` (settings.ts; Moss wanted "a tiny bit more" than 3). Only offered when taskbar edge + island blend (`frameAvailable`, `frameOn`).
3. Taskbar melted feet flatten onto the border (`meltEnds(out, up, border, side, h, r)`).
4. Island melted ends when border + blend (`island.ts placeFeet/edgeSpan`, `.pill-foot`).
5. Notches (Websites, Shelf): corner + size per notch, favicons (Google s2; CSP img-src now allows `https://www.google.com https://*.gstatic.com` in tauri.conf.json), right-click menus, Shelf drag-out (via island `act:shelf:drag-out`) and drop-in (`shelf-drop`), labels beside items.
6. Whole-screen glow (Settings › Screen border › Glow: Island only / Whole screen): canvas ring mask round border + taskbar + island + notches (`ringMask`), island glows off in screen mode (`syncGlow`), island re-reports its shape every second.
7. Open island blended: bar + card share one background (`syncUnion`, `.pill.joined/.sheet.joined`, `--u-*` vars), no seam.
8. Edit mode tray (add tiles) = one row scrolling sideways, wheel scrolls it (`sheet.ts` tray + `.sb-tiles .tray`).
9. Backup renamed to Island.prev.exe (scripts/tauri.mjs).
10. Settings › Widgets › Screen border section with Glow, notch Place/Size, websites list (add/remove/move up) — `src/widgets-page.ts`.

## Done since the 15:02 build (in code, NOT built, mostly verified in preview)
1. Notches work WITHOUT the border (Moss: "option even without the border, positions stay"): `notchesOn()` in settings.ts; FrameHost enabled = `frameOn || notchesOn`; `width: frameOn ? FRAME_W : 0` (border hidden, feet melt into the screen edge). Default `sites.on` is now false (Moss's saved settings keep true). Tests updated (frame.test.ts, 12 pass). Settings section renamed "Screen border and notches"; notch rows always shown, border rows only when available.
2. Notches tucked = THE SAME notch at FULL LENGTH, slim (TAB.thick 13 px), and on hover its background WIDENS out of the border as one shape (`.notch-bg { width: calc(100% * var(--nk)) }`, `.notch.out` → 100%); icons fade in after. Moss: tucked must match expanded length and "push out of the border as one, not as its own entity"; expanded size must NOT change. Verified in preview (looks right).
3. Glow no longer fades while things move (Moss disliked hover stopping the whole glow). The global ring always uses the tucked (slim, squashed) notch shape (`FramePart.squash`, `barMatrix(..., squash)`); an expanded notch draws its own ring (`notchRing()` SVG mask, `.nt-ring` with `.nt-cone` turning about the screen centre, synced via `html[data-fr-motion]` and vars `--lap --c --hot --p` now on `<html>`). Verified in preview with `motion=still`: the light runs from the border round the expanded notch seamlessly. Old tab element/CSS (`.notch-tab`, `.fr-glow.moving`) removed.
4. Island/cards draw NO outline when melted into the border (Moss: "still see border"): `html.island-melt[data-blend] … { box-shadow: none }`, glass ::after hidden, foot rim hidden.
5. Coloured card (music) tint runs top→bottom when melted (both sides match); feet tint 46%→26% fading outward; border tint fade `TINT_FADE 120`, `TINT_STRENGTH 26` (`frame.ts drawTint`, `.fr-tint`). Moss said the right side's fade looked wrong before this; check it on the real screen.
6. Control Center card exactly as wide as the bar when blended top/bottom (`island.ts gridGeometry`: `flush` → width = max(360, pillW)). Moss: no "bump" where the card was wider than the bar. Not yet seen on screen.
7. Glitch fixes: feet no longer detach while opening (feet stay on the pill unless a grown card touches the edge); island reports its parts every second; `frame-hello`/`ready` resend positions when the border window opens.

## In progress: Settings redesign (src/app.ts) — compiles, NO CSS YET
Moss's request (verbatim intent): clean up Settings; match the feel/vibe of the island, not a boring page; options clearer; navigation SUPER easy and simple; sections clearer; more previews in all relevant sections (he likes the Behavior right-click-menu preview); everything super easy; activities simple to edit, find, understand.
Moss's answers: Sidebar + search; Activities = tiles by category + detail panel with live preview (priority as simple High/Medium/Low); window look FOLLOWS THE PILL COLOUR (black/white/matte/glass); previews wanted: Island look, Taskbar & border, Each activity, Alerts & sounds.

Already written:
- `src/previews.ts` (new): `islandPreview(s)`, `screenPreview(s)`, `activityPreview(meta, cfg, s)`, `alertPreview(s, play)`. They use classes `.preview .pv-screen .pv-pill .pv-pill-bg .pv-pill-in .pv-foot .pv-glow .pv-bot .pv-border .pv-top .pv-window .pv-bar .pv-bar-bg .pv-bar-in .pv-notch .pv-notch-bg .pv-notch-in .pv-caption .pv-chips .pv-chip .pv-toast .pv-phone .pv-try .pv-ico .pv-text .pv-dot` and `data-look` — **NO CSS FOR THEM EXISTS YET.** Remove the unused `export { NOTCH_CORNERS }` / import at its end.
- `src/widgets-page.ts`: `desktopWidgetsPage(host)` and `taskbarPage(host)` (taskbar page shows `screenPreview` in `.preview-dock`, then taskbar section, then border+notches).
- `src/app.ts`:
  - New `Page` type: island, activities, taskbar, widgets, workspaces, behavior, alerts, phone, controls, general, welcome; `ALIAS {settings:'island'}`; `pageOf()`.
  - New `nav()` with brand pill, search input (`data-focus="nav-search"`), items from `NAV` (label + small subtitle, icons spark/pulse/window/widgets/spaces/sliders/bell/phone/keyboard/settings).
  - `render()` sets `html[data-pill]`, keeps focus/caret, panel scroll, calls `revealRow()`.
  - `pageBody(p)` switch, `searchPage()` (searches activities + rows of SEARCHED pages, click → `reveal` row + flash), `firstSentence()`.
  - Activities: `CATEGORIES` chips, `actQuery`, `actCat`, `actOpen`, `activitiesPage()`, `activityTile()`, `activityPanel()` (header + `activityPreview` + description + `cardBody(meta)`). Old band list, drag/FLIP code removed (`flipRender` now just `render()`).
DONE at the very end of the session (compiles):
- `settingsPage(part)` now builds the old sections and keeps only the part's ones (by h2 title); `islandPage/behaviorPage/alertsPage/phonePage/generalPage` wrap it. Island page has `islandPreview` in `.preview-dock` + `sizeCard()`; Alerts page has `alertPreview` (plays chimes).
- Escape: closes the activity panel, then clears search, then closes the window.
- Dock "Taskbar settings…" and the Websites "+"/menu now open `'taskbar'`.
- NOTE: the Behavior section still holds rows that belong elsewhere conceptually (When nothing is happening, When pointed at, Hover card, Reduce motion are in Appearance → they show on the Island page). Consider moving them to Behavior for clearer sections.

Still TO DO for the redesign (step 1 below is done as described above, the rest is not):
1. (done) Split the old `settingsPage()` (app.ts ~line 1375) into `islandPage()`, `behaviorPage()`, `alertsPage()`, `phonePage()`, `generalPage()` (tsc currently errors that these don't exist):
   - islandPage: head + `h('div',{class:'preview-dock'},[islandPreview(settings)])` + Look (pill colour, glass slider, accent swatches, size, bot) + Place (blend, distance, Show the island on + monitors) + Glow (border glow speed) + Width (`sizeCard()`).
   - behaviorPage: When nothing is happening, When pointed at, Hover card, Expand on hover, Reduce motion, Peek behind, Peek lasts, Smart fade, Hide in full-screen, Show other activities, Do not disturb, `menuRow(i)` (has the right-click menu preview), `hideRow(i, mac)`.
   - alertsPage: `alertPreview(settings, (k) => void playSound(k, settings.general.sound))` + notifications, sounds, `soundRows`, send to phone, phone approve.
   - phonePage: head + `phoneSection({settings: () => settings, save: () => save(true)})`.
   - generalPage: Startup (start with Windows, update automatically, run setup), Privacy (+ privacyNote), About (version, log folder, quit).
   - Delete `settingsPage` afterwards; remove unused imports (tsc lists them).
2. Escape key in `boot()`: if `actOpen` → close panel (render) and don't close window; if `searchQuery` → clear it.
3. Write `src/styles/settings.css` (import it in app.ts AFTER app.css; app.css contains a non-UTF-8 byte, so don't rewrite it with Python—append with `cat >>` or use a new file):
   - Theme by `html[data-pill]` like the island (black #050506 / white / matte-black / matte-white / glass over Mica), `--ink` per theme, override `.card .row .segmented .switch .btn inputs nav` colours (app.css hardcodes white-on-dark).
   - Sidebar: brand pill like the island, search box, nav items as pills (label + small subtitle), active item lit with the accent.
   - Search results list (`.search-list .search-hit .hit-ico .hit-text .hit-go`), `.row.flash` highlight.
   - Activities: `.chips .chip(.on)`, `.act-grid` (responsive tiles), `.act-tile(.on/.unavailable)`, `.tile-top .tile-name .tile-desc .tile-foot .prio.p-high/.p-medium/.p-low/.off .tile-open .act-icon(.big)`, panel `.act-panel-wrap` (dim overlay) + `.act-panel` (slides in from the right, scrollable) `.panel-head .panel-title .panel-x .panel-desc`.
   - Previews (all `.pv-*` above): mini screen with wallpaper gradient, pill per `data-look` (copy the pill gradients from island.css :root/html[data-pill] rules), blend (square top corners, flush) vs floating, melted feet, rotating glow ring (conic + rotate, `--lap`), bot circle with accent, border line, mini taskbar on each side (`.side-bottom/left/right/top`, `.edge`, `.melt`, scale `--z`), notches at corners (`.at-top-left` etc., `--nz`, stacked by `--before`), activity chips lit, toast and phone badge, `.pulse` animation, `.preview-dock` (sticky at the top of the page so the preview stays visible while scrolling).
   - Springy motion like the island (spring easing), rounded pill controls.
4. Update openers of old page names: dock right-click "Taskbar settings…" (`dock.ts dockMenu` → `native.openApp('widgets')`) should open `'taskbar'`; frame `sites-settings` act (`island.ts frameAct` → `native.openApp('widgets')`) should open `'taskbar'`. Check other `openApp('settings'|'widgets'|…)` callers (`grep -rn "openApp(" src`) and the Rust/tray menu still work via ALIAS.
5. Workspaces page: `workspacesView()` unchanged; make sure nav `go('workspaces')` still calls `.home()` when already there.
6. Screenshot every page in the preview (black and white looks), show Moss, iterate.
7. Run tsc + full vitest; fix tests that referenced old Settings pages if any.
8. Build release, restart Island, check the real screen (notches widening, glow over expanded notch, music tint both sides, Control Center width, no outline), report to Moss with screenshots.

## Other open items / known gaps (tell Moss or do)
- Island's left melted foot sits under the bot bubble (Moss hasn't commented yet).
- Websites: no drag-in of links from a browser (add in Settings; "+" opens Settings).
- Glass/matte looks: the border colour is approximated (`--fr-bg` in island.css); glass rim ::after on joined pill/sheet hidden.
- Left/right/top taskbar not tried on the real screen yet.
- Glow ring is recomputed (canvas → PNG) on taskbar/island moves; island moves often (hover) — watch CPU.
- Old memory note: `memory/project_island_screen_border.md` (update it when done).
- Earlier session's leftovers from the blend agent (not done): faint seam where bar meets card on hover cards, left/right anchors untested, pill glow jump mid-fade, duplicate screens.

## Key files touched this session
src-tauri: `dock.rs`, `frame.rs` (new), `overlay.rs` (share_drop_target pub(crate)), `lib.rs` (mod frame, commands dock_side/frame_show/frame_solid/frame_hello), `capabilities/default.json` ("frame" window), `tauri.conf.json` (CSP img-src).
src: `core/dock.ts`, `core/frame.ts` (new), `core/island.ts`, `core/sheet.ts` (edgeShape, grownRect, tray wheel), `core/settings.ts` (DockSide, NOTCH_*, FrameConfig, PinnedSite, siteOf, frameAvailable/frameOn/notchesOn, FRAME_W, MAX_SITES, migrations), `core/native.ts` (dockSide, dockFit pivot, frameShow/frameSolid/frameHello), `main.ts` (frame window + /?frame preview), `dev/dock.ts`, `dev/frame.ts` (new), `widgets-page.ts`, `previews.ts` (new), `app.ts`, `styles/island.css`, `styles/app.css` (sites list styles appended), `test/frame.test.ts` (new), `scripts/tauri.mjs`.
