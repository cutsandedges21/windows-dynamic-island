# Workspaces

A workspace is the set of apps, files, folders, websites and terminal commands one piece of work
needs, plus a note on where it stands. Restoring it opens everything in order and says what opened
and what didn't. Moss asked for it on 2026-10-17 as "another built-in feature" of Island (the brief:
"Workspace Switcher").

## Decisions

- **Inside Island.** A **Workspaces** page in the Activities window (sidebar, between Activities and
  Settings). Later phases put the current workspace, restore progress and switching on the pill.
- **Island's own stack, no React or Tailwind.** The Activities window is plain TypeScript built with
  `h()` (`src/dom.ts`) and one stylesheet; a second UI framework in the same window would mean two
  design systems. Shared controls moved from `app.ts` to `src/controls.ts`.
- **A JSON file, not SQLite.** `workspaces.json` beside `settings.json` (`%APPDATA%\com.moss.island\`).
  Every other Island store is JSON, workspace data is small (hundreds of KB at most), SQLite would add
  a C compile to the Windows and Mac builds, and a JSON file can be read and backed up by hand.
- **Versioned, with migrations.** The file carries `version` (now 1). `readDoc` upgrades an older
  file one step at a time (`MIGRATIONS[n]` turns version n into n+1); Rust copies the old file to
  `workspaces.v<n>.json` before the upgraded one is written. A file from a newer Island is shown but
  never written back (it could lose what this one doesn't know).
- **Rust keeps the file; TypeScript owns its shape.** Both windows (and, later, the island) change
  workspaces, so instead of each writing the whole file, they send small operations that Rust applies
  one at a time under a lock: **upsert** (merge some top-level fields into one workspace, or add it
  first), **remove**, **reorder**. Each is saved (write beside, rename over) before it counts, then
  every window gets the `workspaces` event with the document and a revision number.
  `src/workspaces/store.ts` applies a change at once (no waiting to redraw) and, on each event, takes
  Rust's document and applies its own changes still on their way again on top, so a change from the
  other window never hides one made here. The same `applyOp` runs in TypeScript, Rust and the tests.
- **Fields have owners.** Save in the editor writes only the editor's fields (`EDITOR_FIELDS`); the
  star, archiving, notes typed on the workspace's page, restores and saved layouts each write their
  own, so saving an edit never undoes them.
- **An unreadable file is moved aside, never overwritten** (`workspaces.unreadable-<time>.json`); the
  page says where it went. If it can't even be moved, nothing is saved until it's fixed.

## Data (`src/workspaces/model.ts`)

| Field | What |
|---|---|
| `id`, `name`, `description`, `icon`, `color` | `color` is an accent key, or `''` for Island's accent (follows it). |
| `favorite`, `archived` | Favorites come first; archived ones fold away at the bottom. |
| `createdAt`, `updatedAt`, `lastOpenedAt` | Epoch ms. |
| `cwd` | The project folder: apps and commands start there unless they say otherwise; item paths may be written from it. |
| `resources` | What opens, in order. Kinds: `app` (path, arguments, start-in folder, bring the running one up or start another), `file` (path, open with), `folder`, `url`, `command` (text, PowerShell / PowerShell 7 / Command Prompt, Windows Terminal or its own window, start-in folder). Each: `enabled`, `mode` (`auto` or `ask`: wait for a yes), `wait` (seconds before the next one), `label`. |
| `notes` | `text` (where the work stands), `next` (the next step), `savedAt`. |
| `prefs` | `placeWindows`, `remindOnLeave` (used from Phase 2/3). |
| `layout` | Saved windows (Phase 2): program path, class, title, monitor, rectangle in pixels and as shares of the monitor's work area, maximized/minimized; the monitors as they were. Process ids are never kept. |
| `history` | The last 10 restores: when, how long, outcome, and each step's result in words. |

Paths may use `%VARIABLES%` and `~`, be relative to the project folder, or be a bare program name
(`code`, `wt`) that Windows finds through App Paths and PATH (`src-tauri/src/workspaces/paths.rs`).

## The page (`src/workspaces/`)

- `dashboard.ts`: a card per workspace (what it holds, the next step, when it was opened, Restore),
  favorites first, archived folded away; search (names, descriptions, notes, paths, addresses;
  Enter opens the best match); order (yours, recent, A–Z); drag a card, or Alt+arrow keys, to
  reorder; "Pick up where you left off" with the last three opened; a welcome with three starters.
- `detail.ts`: one workspace: what opens, numbered, with anything that can't open right now and why
  (`checks.ts`: missing, a folder where a file should be, a bad address); notes and next step, saved
  as they're typed; the project folder with Show in Explorer.
- `editor.ts`: name, description, icon and colour; project folder (Browse… opens the system's dialog);
  the items, added with the system's Open dialog (several files at once) or typed, opened for
  details, switched off, reordered by dragging the handle or with the arrow keys, removed with Undo;
  notes. The edit is a copy until Save (Ctrl+S). Meanwhile it's kept in `localStorage`, so closing
  the window loses nothing: the page offers "Keep editing" next time. Escape asks before throwing
  changes away.
- `page.ts` routes between the three and lives for the window's life (an edit survives going to
  Settings and back). A redraw waits while a mouse button is held, so a click or drag never lands on
  an element that was just replaced.

## Safety

- Nothing runs in Phase 1. When restoring arrives: commands start as **Ask me first** and show the
  exact command; a command set to run on its own says so in the editor.
- Checking a path only asks whether it exists and what it is; contents are never read.
  **Show in Explorer** opens a folder or selects a file, never runs it.
- Deleting asks first and can be undone for a few seconds; the apps and files themselves are never
  touched. Archive can be undone too.
- No screenshots, keystrokes or activity tracking: a workspace holds only what the user puts in it.

## Phases

1. **Foundation** (done 2026-10-17): the file, the store, the page (cards, a workspace, the editor),
   path checks, the system's Open dialog, Show in Explorer.
2. **Restoring** (done 2026-10-20): `src/workspaces/restore.ts` (the order and decisions, tested with
   fakes) runs in the island window (`engine.ts`), so closing the Activities window never stops a
   restore. Items open in order: apps (an already-running one is brought to the front instead),
   files (their app or a chosen one), folders, sites, commands (Windows Terminal tab or a console,
   as an encoded PowerShell command or a UTF-8 batch file; each shows the command it runs).
   "Ask me first" items wait for Run / Skip / Stop, on the pill's card or the workspace's page.
   Missing things fail with the reason and the rest go on; Stop, Try again (only what failed), the
   last 10 restores kept. Window layouts (`layout.ts`, Rust `layout.rs`): saved by program, class
   and title (never process ids), put back with SetWindowPlacement (plus a second size pass across
   scales) on the same screen if it's there, else the same share of the main screen, always
   reachable; apps just started get 15 s to show their windows. Add apps from Start's list (Store
   apps too) or from open windows. The Workspaces activity shows progress and questions on the pill
   and favorites in Control Center. Checked for real: a restore with a missing app, a folder and a
   command answered on the pill; Character Map started, found running and moved to the pixel.
   Not yet tried in the real app: Save the layout / Put them back now buttons (the calls under them
   were).
3. **Switching**: a keyboard launcher (a global shortcut), templates, history, a reminder to update
   the note when leaving a workspace.
4. **Integrations**: browser profiles and tab sets, Windows Terminal profiles, Claude Code sessions
   (Island already resumes them with `claude --resume <id>` and the editor deep link), each only once
   its interface is verified.
5. **Polish**: monitor and scaling tests, onboarding, the Mac.

## Tests

`test/workspaces.test.ts` (model, file reading and upgrades, operations, checks, the store with two
windows and late events) and `src-tauri/src/workspaces/tests.rs` (the file, set-aside, revisions and
backups, path checks and program lookup). Browser preview: `npx vite --port 1430`, then
`/app.html#workspaces` (the preview keeps workspaces in `localStorage`; Browse… needs the app).

## Notice what I work on (the workflow assistant)

Moss, 2026-10-20: "remembers what you're doing across apps; detect when you're working on a project,
surface its files and notes, and let you quickly resume." First built as a separate "Trail" activity;
Moss: "I don't want it to be called Trail. Call it Workspaces." So it is the Workspaces activity's
option **Notice what I work on** (off by default; Activities › Workspaces), with Ask where I stopped,
Offer workspaces, Keep window titles and Remember for (days) under it. `src/activities/notice.ts` is
the noticing half; `WorkspacesActivity` extends it (a restore takes the pill first).

- Every 5 s it reads the app window in front (`notice_now`: program, title, class; and the time since
  the last input, so time away isn't counted). `src/workspaces/notice/detect.ts` works out the project
  and file from the title (VS Code and its forks, JetBrains, Visual Studio, terminals, Explorer, Office;
  never browsers' page titles) and the workspace it belongs to (project folder, folder and file items).
- `src/workspaces/notice/model.ts` keeps spans (program, project, file, workspace) in
  `recent-work.json` in Island's data folder for 14 days (setting), never leaving the PC. Whole window
  titles only with "Keep window titles" on (off by default); turning it off erases the ones kept.
  Activities › Workspaces lists what you worked on today and has Forget everything.
- Switching into a workspace (after 20 s there, not seen in the last 30 min) shows it on the pill with
  its next step; its chip's card has the next step, notes, the files worked on today and Restore the
  rest. Leaving a workspace after 10 min or more asks "Where did you stop?" and saves the answer as
  its next step. A project with no workspace that gets 20 min or more in a day is offered as a
  workspace (once a day; Not now = a week); Make a workspace opens the editor with its name and apps.
  The Control Center tile becomes "Pick up" (the last places worked on this week).
- Tests: `test/workspaces-notice.test.ts` (titles, matching, spans, settling).

## Getting there

- The island's right-click menu has a **Workspaces** button (the grid icon, which was Activities');
  Activities got a new pulse icon there, on the open island and in the sidebar. The tray menu has
  Workspaces… too. The grid is Workspaces' icon throughout (sidebar, pill, Control Center, a new
  workspace's default icon).

## Time tab (built 2026-10-20)

Moss asked for the time Notice what I work on records per workspace to be shown like a phone app's stats screen (weekly bars + a donut). As built:

- **Tabs** under the Workspaces page head, as in the screenshot: trend icon = Time, grid icon = the cards. Equal halves, hairline across, rounded underline under the active one; role=tablist, aria-labels, arrow keys. Opens on the cards; the choice is remembered (UI_KEY). Shown only when there are workspaces.
- **Filter row** above both cards: ‹ This week › (Last week, "Oct 4 – 10"), back only as far as Notice keeps (days option).
- **Card "TIME PER DAY"**: stacked bars S M T W T F S (Sunday first), one segment per workspace, 2 px gaps, rounded segments (~6 px, at most h/2), bars ~28–30 px. Today's letter bold, past muted, future dim. A begun day with no time gets a small gray dot. Dashed "avg 2h 18m" line = week total ÷ days begun (today counts), label in a right gutter, no y-axis. Hover/focus a bar → tooltip with each workspace's time. Click a bar → that day is selected (others dim) and the donut + legend show it; click again or Escape (page.ts keydown, preventDefault) clears.
- **Card "TIME BY WORKSPACE · THIS WEEK"** (· TODAY / · MONDAY when a day is picked): donut (ring ≈ 37 % of radius, butt-cap 2–3 px gaps via stroke-dasharray, from 12 o'clock clockwise, largest first; one series = full ring; none = gray ring "0m"). Total in the middle in a serif like the screenshot ("Sitka Display", ui-serif, Georgia). Legend rows: dot · name (bold) · "6h 44m" (monospace) · percent (monospace, muted; largest remainder so they add to 100; "<1%" for slivers). Hovering a slice or legend row highlights the slice. Stack order = legend order top to bottom (largest on top, as in the screenshot).
- Side by side when the page is wide (container query, 1.25fr / 1fr), stacked when narrow; card radius ~18 px.
- **Empty states**: noticing off → "Turn it on" (host sets cfg('workspaces').enabled and options.notice, save(true)); on but nothing yet → the frames with zeros.
- **Data**: workspace time only (projects without one and deleted workspaces are left out). NoticeActivity.noticeCommand(cmd, arg) gets 'spans' {since, until} → [start, end, ws][] (engine's default branch passes arg). The page asks the island, falls back to native.noticeLoad() + readTrail. Refresh when the tab shows and every 60 s while visible; app.ts render calls a new WorkspacesPage.shown(). The browser preview reads spans from localStorage so it can be screenshotted.
- **Colours** (dataviz validator, dark, card #212123, all pairs: CVD ΔE ≥ 8.1, normal ≥ 15.1, all ≥ 3:1): sky #4f97e4, ember #bc4d1f, mint #10895e, violet #7c5cca, gold #bd8c12, rose #e06290, Others #6b6b72. Island's own swatches fail on the dark card (sky↔violet ΔE 1.8 for deutans, white has no hue). Each workspace takes its colour's family ('' = the accent from computed --accent; a custom hex = nearest hue; white = none); two wanting one family: the first in the user's order keeps it, the other takes the first free. At most 6 series (5 + Others).
- **Files**: new src/workspaces/time.ts (pure: weekStart, midnights, weekOf, daysBegun, averageDay, familyOf, seriesOf, seriesMs, hm, shares, shareText, weekLabel, dayName) + test/workspaces-time.test.ts; new src/workspaces/timeview.ts; page.ts/ctx.ts (ui.tab, time state, Escape); dashboard.ts (tabs); notice.ts + engine.ts ('spans'); app.ts (turn-on host, shown()); icons.ts ('trend'); workspaces.css. Then tsc + vitest, a screenshot in the preview, rebuild when Moss asks.
- **As built, beyond the plan**: the bars take the card's full height (beside the donut, as tall as it); the tooltip shows on hover and on keyboard focus only (not the focus a click leaves), above the bar or beside it when there's no room; the total uses lining figures (Sitka's default figures are old-style, "0m" read as "om"); the week's numbers leave out deleted workspaces, the average too; Ctrl+F on the Time tab goes to the cards' search.
- **Checked**: tsc (clean in these files); 574 Vitest (11 new in test/workspaces-time.test.ts); browser preview (headless Chromium, 1040×740 and 820 wide) with a made-up week: noticing off banner and Turn it on, hover tooltip, a picked day, an empty past week, the cards tab. Not yet in the exe: the island answers `spans` only after a rebuild (until then the page reads recent-work.json, which is up to a minute behind).
