# Architecture

Working name: **Island** (identifier `com.moss.island`). The product name is still open.

```
Activities ──► Priority ──► Layout ──► Animation ──► Rendered pill
 (TS)          (TS)         (TS)        (TS springs)   (one DOM element tree)
   ▲
   │ typed commands + events (Tauri IPC)
   │
 Rust native layer: windows, monitors, processes, files, media, audio,
 power, network, clipboard, devices, Claude hook pipe, HTTP
```

## Windows

| Window | What it is |
|---|---|
| `island` | Transparent, borderless, always-on-top, non-activating tool window that covers the **work area** of the chosen monitor. The pill is drawn inside it with CSS transforms, so moving it between the four anchors is a spring animation inside one window, never an OS window move. Outside the pill the window ignores the mouse: a Rust thread polls the cursor and toggles click-through against the hit rect the island publishes. |
| `app` | A normal window (Mica) with two pages: **Activities** and **Settings**. Opened from the tray, the island's quick menu, or `Alt+Shift+A`. |

Decisions Moss made during the build (they override the spec where they differ):

- **Tap outside → resting size.** Any press outside the pill (reported by the Rust poll thread, or a press on the window's transparent margin) closes views, clears surfaced events and the inline input, and dismisses urgent cards. A dismissed permission card is declined, so the terminal asks immediately instead of waiting out the hook timeout.
- **Vertical on the sides.** Left/right pills stand vertical: length along the edge (level percentages of the work-area height), thickness growing inward. Text stays upright; segments stack top to bottom (`fitVertical`). The pill turns horizontal only while an inline input is open.
- **No flip on time.** Clocks, timers and counters update in place (`timeLike()` in the renderer); only wording changes roll.

- **The card under the pill.** Anything longer than one row (a chat's last message and a reply box, a permission's full command, Claude's questions, limits and sessions on hover, the grid of everything that is on) goes in a card attached to the pill on the side it grows towards (`sheet.ts`). Hovering an activity's chip asks that activity for its card, so Claude's sessions, limits and tokens show on hover instead of behind a "…" screen.
- **Everything at a glance when open.** Tapping the island opens a Control-Center grid: one tile per switched-on activity (`Activity.tile()`), plus the island's own Day tile.
- **Arranged like iOS Control Center.** The grid is four cells across and four down per page, invisible except while arranging (empty cells then show faintly). Long-press a tile (or an empty spot) to arrange; still holding, the same press carries the tile. A tile lands on the exact cell it is dropped on, leaving empty cells before it if dropped past the others; dropped onto tiles, it goes in front and they move on; its old spot closes up. Dragging a tile's corner arc resizes it (1x1, 2x1, 1x2, 2x2; lists, cards and players two wide at least). Holding a carried tile at the card's side for two seconds turns the page; past the last page it makes a new one, and a page left empty goes on the drop. Layout rules: `grid.ts` (`moveTile`, `settle`), saved as `island.grid.pages` (tile keys per page, `null` for an empty cell the user left).

The island only takes keyboard focus while an inline input is open (Continue Session, Ask), or after the user clicks into an input on the card. Rust then drops `WS_EX_NOACTIVATE`, activates the window, and on release restores the window that had focus before. A card never takes focus by itself, so it cannot steal keystrokes from whatever the user is typing in.

## TypeScript core (`src/core`)

| Module | Job |
|---|---|
| `spring.ts` | Exact damped-spring solver (SwiftUI-style `response` + `damping`). Retargeting keeps velocity, which is what makes interrupted motion look physical. |
| `animator.ts` | One `requestAnimationFrame` loop for every spring in the app. It stops when everything has settled, so an idle island costs zero frames. |
| `layout.ts` | Island geometry from work area, anchor, level and width percentages. The anchor gives an **expansion vector**: top grows down, bottom grows up, left grows right, right grows left. Text never rotates. |
| `segments.ts` | The content model. An activity describes its pill content as a list of keyed segments (icon, dot, text, progress, button, chip, input, meter…). The fitter measures them with canvas `measureText` (no DOM layout), drops low-priority segments and truncates text to fit the space budget. |
| `renderer.ts` | Keyed DOM renderer. Matching keys spring to their new x and width; new segments blur-fade in, removed ones blur-fade out; changed text rolls. Only `transform`, `opacity`, `filter` and the shell's size animate. |
| `sheet.ts` | The card under the pill. Typed blocks (header, wrapped text, code, buttons, input, meter, rows, choices, stats, countdown, tile grid), keyed like segments; unchanged blocks are left alone, inputs and meters are patched in place. Its height springs to the content and its position rides the pill's frames. Activity text only ever goes in through `textContent`. |
| `grid.ts` | The Control Center's layout as data: pages of tile keys and empty cells, packed first-fit per page, overflow to the next page. `moveTile` (drag and resize), `settle` (tidy and place), `withNew` (new tiles next to their neighbour in the activities order). |
| `island.ts` | The island engine: picks the primary activity, the level (idle, compact, expanded, maximum), secondary chips and overflow, hover, open/closed, transient surfacing, interrupts, quick menu, inline input focus. |
| `priority.ts` | Ranking: band (high, medium, low) and manual order, plus foreground or background weight and interrupts. |
| `activity.ts` | The Activity contract and registry. Built-in and external activities use the same contract. |
| `bus.ts` | Typed event bus inside a window. |
| `settings.ts` | The settings schema and defaults. Rust persists them (`settings.json`) and broadcasts every change to both windows. |
| `native.ts` | Typed wrappers for every Rust command and event, plus a browser mock so `npm run dev` previews the island in a normal browser. |

## Activities (`src/activities`)

Each activity owns its state, reads native data through `native.ts`, and renders `compact`, `expanded` and `maximum` segment lists. Behaviour flags per activity: enabled, priority, auto-show, persistent, interactive, interrupt.

Claude (`src/activities/claude`) is a TypeScript port of Usage Clip (`claude-session-monitor`):

| Usage Clip module | Here | Notes |
|---|---|---|
| `registry.js`, `paths.js`, `status.js`, `transcript.js`, `procinfo.js`, `tracker.js`, `history.js`, `tokens.js`, `usage.js`, `desktop-chats.js` | same names, `.ts` | Logic ported as is, unit tests ported to Vitest. File and process access goes through small Rust primitives (`fs_read_tail`, `fs_scan_lines`, `proc_snapshot`, …). |
| `focus.js`, `platform/win32.js` | `focus.ts` + Rust `procs.rs` | Window activation keeps the foreground-lock escalation (plain request, AttachThreadInput, synthetic Alt). |
| `usage.js` HTTP | Rust `claude_usage_fetch` | The OAuth token is read and used in Rust and never enters the webview. |
| tray, hotkeys `Alt+Shift+1–9`, `Alt+Shift+0`, toasts | Rust `tray.rs`, `hotkeys.rs` + TS | Same behaviour. |

New on top of Usage Clip:

- **Hooks** (from Coucou, MIT): `island-hook.exe` is registered as a Claude Code hook for each event. It forwards the event over `\\.\pipe\island-<user SID>`. Two events wait for the island: `PermissionRequest` (Allow, Deny, Deny with a reason, or the answers to an `AskUserQuestion`) and `Stop` (the reply window, below). If the island is closed or doesn't answer in time, the hook prints nothing and Claude Code carries on as if Island were not installed. Installing shows a diff of `~/.claude/settings.json` and takes a dated backup first; nothing is written without a click (or `Island.exe --install-hooks`).
- **The reply window.** When a chat finishes, its `Stop` hook asks the island whether to wait. The island answers within milliseconds: if the chat's own window is in front (and, when several chats share that window, it is the one last prompted) it passes at once; otherwise it shows the card with the chat's final message (`last_assistant_message`) and a reply box, and the chat waits `replyWindowSeconds` (45 s by default; clicking the box extends it to 4 minutes, never past 270 s). A reply typed there becomes `{"decision":"block","reason":…}`, which Claude Code documents as "keep going with this", so the reply lands in that same chat, editor or terminal. Switching to the chat's window, tapping outside the island, or a new prompt in the chat releases it immediately. If Claude Code stops waiting first, the pipe closes and the card goes.
- **Wire format.** The island answers a waiting hook with one word (`ack`, `ack:<ms>`, `hold:<ms>`, `allow`, `deny`, `pass`) or one JSON line (`{"kind":"reply","text"}`, `{"kind":"deny","message"}`, `{"kind":"answer","updatedInput"}`). Only `island-hook` turns these into Claude Code's JSON (`output_json` in `hook/src/main.rs`), so that format lives in one place.
- **Continue Session** (and replies typed after the reply window closed), through public mechanisms only:
  - editor chats (`claude-vscode`): the extension's own deep link, `<editor>://anthropic.claude-code/open?session=<id>&prompt=<text>`. The extension opens the chat with the text in its box but does not send it, so the text also goes on the clipboard and the island says to press Enter there;
  - live terminal chats: `island-hook.exe inject <pid>` attaches to the session's console and types the prompt plus Enter (`WriteConsoleInputW`);
  - closed terminal chats: `claude --resume <id> "<prompt>"` in a minimized console. The chat then shows up as live again, and its permission prompts reach the island through the hooks.

## Rust (`src-tauri/src`)

Rust is kept to native access: window styles and click-through, monitors and work areas, process table and window activation, file primitives, the hook pipe, GSMTC media, Core Audio volume and mic, power, CPU and memory, network throughput, clipboard and device messages (one message-only window), TCP listeners, HTTP GET, and settings persistence. Product logic stays in TypeScript.

## Build notes

- The Cargo target directory lives outside OneDrive (`%LOCALAPPDATA%\windows-dynamic-island\target`, set by `scripts/tauri.mjs`), because OneDrive would otherwise sync several GB of build output.
- `npm run dev` serves the island in a browser with mocked native data (fast UI work). `npm run tauri dev` runs the real app. `npm run release` builds the exe and copies it to `release/`.
