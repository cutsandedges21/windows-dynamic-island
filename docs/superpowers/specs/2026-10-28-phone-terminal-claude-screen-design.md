# Island on your phone, part 2: terminal, Claude chat, screen

Date: 2026-10-28. Status: BUILT 2026-10-28 evening, all checks pass; not yet tried on the iPhone, no exe built, site not deployed. Moss asked for it ("go as fast as you can"); Moss picked the chat box inside
Island's app ("i dont want the user to have to leave the app"). The other calls below are Claude's
defaults, made so the build could start at once; Moss can change any of them.

Moss's words: "on the mobile app, i want to be able to view my pc screen using chrome remote desktop
(easiest way, i believe). i also want there to be a feature where i can directly talk to claude
whenever i want, rather than waiting for it to ask me a question so i respond. also, add a terminal
option so that if i am somewhere without my laptop, i can talk to claude and run commands on my
terminal and continue projects (like this one) remotely".

Read first: `docs/superpowers/specs/2026-10-22-island-phone-design.md` (how the phone site works:
iroh over n0 relays, `island-phone/1`, control stream of JSON lines, files on their own bi-streams,
the phone draws the island's own `SheetView`s), `docs/ARCHITECTURE.md`, `docs/STATUS.md` (last entries).

## Facts this design rests on

- Moss's Claude chats are almost all VS Code chats (entrypoint `claude-vscode`: 37,777 transcript
  lines against 1,633 `cli`). Island can type into a terminal chat (`claudeInject`, WriteConsoleInputW)
  but not into a VS Code chat: `vscode://anthropic.claude-code/open?session=…&prompt=…` only puts the
  text in the box and someone must press Enter at the PC. So a phone message to a VS Code chat must
  continue that chat in a process Island owns.
- Chrome Remote Desktop's host is installed on Moss's PC (Windows service `chromoting`, running).
  Google took the Chrome Remote Desktop app off the iOS App Store in September 2025; on an iPhone it
  runs as the website `https://remotedesktop.google.com/access` in Safari. Its pages refuse to be
  framed, so the phone app opens it rather than embedding it.
- The phone app drops its connection 30 s after it is hidden. Anything started from the phone
  (a shell, a Claude chat) must keep running on the PC and be picked up again on return.

## The three features

### 1. Terminal (a real shell on the PC, from the phone)

- **Island owns terminals** (new Rust module `src-tauri/src/term/`): pseudo-terminals through the
  `portable-pty` crate (ConPTY on Windows, a Unix pty on a Mac). Each terminal: `id` (8 random hex),
  `title`, `cwd`, `shell`, child `pid`, `started` (ms), `exit` (code once it ended, else null), a
  ring buffer of its last 256 KiB of output, and the set of streams attached to it. At most 8 at a
  time. They keep running when no phone is attached; Island kills them all when it quits. An ended
  terminal stays listed (with its exit code) until removed or for 10 minutes.
- Shells: Windows `powershell` = `pwsh.exe` when on PATH, else `powershell.exe -NoLogo`; `cmd` =
  `cmd.exe`; `bash` = Git Bash (`<Git>\bin\bash.exe --login -i`) when installed. Mac: `$SHELL -l`
  (zsh), `shell` reported as `bash`/`zsh` name. Default shell: `powershell` on Windows. Default cwd:
  the user's home folder. Environment: the user's, plus `TERM=xterm-256color`, `COLORTERM=truecolor`.
- **Off by default.** Settings › Your phone › **Terminal from your phone** (switch, default off;
  text: "A paired phone can open a terminal on this PC and run any command."). When off, a phone's
  terminal request is refused with "Turned on in Settings › Your phone on the PC". When Windows Hello
  is required before Allow (`claude.options.requireHello`), terminals are refused too (same rule as
  Allow from a phone). TypeScript tells Rust with `remote_term_allow(on)` at boot and on change.
- Opening a terminal from a phone shows a short note on the PC island ("iPhone opened a terminal"),
  the way Land shows an arrival.

#### Wire: terminals (Rust only; TypeScript never sees terminal bytes)

Control lines, phone → island, handled in **Rust** like `ping` (never forwarded to TypeScript):

| Message | Reply |
|---|---|
| `{"t":"term-list"}` | `{"t":"terms","items":[TermInfo…],"allowed":bool}` |
| `{"t":"term-kill","id":"…"}` | ends that terminal (if running) and removes it; then `terms` |

Rust also sends `terms` to every connected phone whenever the list changes (opened, title changed,
ended, removed), at most 4 a second.

`TermInfo` = `{"id","title","cwd","shell","pid","started","exit":int|null,"attached":int,"claude":bool}`
(`claude`: the terminal was started by Island for a Claude chat, see 2).

A terminal stream: the phone opens a new **bi-stream**; first line (JSON, `\n`):
`{"t":"term","id":"<id>"|null,"cols":int,"rows":int,"cwd":string|null,"shell":"powershell"|"cmd"|"bash"|null}`
(`id` null = open a new terminal with that cwd/shell, defaults when null; a given `id` = attach to
it and resize it). Rust answers one line: `{"t":"term-ok","id":"…","title":"…"}` or
`{"t":"term-error","error":"<plain words>"}` (then finishes the stream). After `term-ok`, both
directions carry **frames**: `[kind: u8][len: u32 big-endian][payload: len bytes]`, payload at most
64 KiB:

| kind | direction | payload |
|---|---|---|
| 0 `data` | both | raw bytes (PC → phone: output; phone → PC: keyboard input) |
| 1 `resize` | phone → PC | JSON `{"cols":int,"rows":int}` (1..=500 each) |
| 2 `exit` | PC → phone | JSON `{"code":int|null}`; Rust finishes the stream after it |
| 3 `title` | PC → phone | JSON `{"title":string}` |

Right after `term-ok`, Rust sends the ring buffer as one or more `data` frames (the phone resets its
screen before writing them), then live output. Several streams may attach to one terminal; the last
`resize` wins. A stream that closes detaches; the terminal keeps running. A phone not allowed
terminals gets `term-error`. A Claude-chat terminal (see 2) can be attached like any other.

Rust commands for TypeScript (Tauri): `term_open({cwd, shell, program, args, cols, rows, title, claude})
-> {id, pid}` (`program`+`args` run directly, no shell, so no quoting problems; when `program` is
null the shell starts), `term_write(id, text)`, `term_list() -> TermInfo[]`, `term_kill(id)`,
`remote_term_allow(on)`. Event to the island window: `term-changed` (the list) so the Claude chat can
find its terminals.

### 2. Claude chat in Island's phone app

- The phone's bottom bar gets a **Claude** button: it opens Claude's card on the phone
  (`nav open:card id:claude`). Claude's `sheet()` answers `reason: 'open'` (phones; it returned null
  before and phones fell back to the hover card):
  - **List** (no chat chosen): the limits meters (as in the hover card), then **Chats**: every live
    session and the closed-recently ones (up to 8 together), each a row whose action is `chat`
    (arg: session id), detail = status (Working… / Your turn / Needs you) · project. Then
    **New chat** buttons for up to 4 recent project folders (distinct `cwd`s of the sessions, newest
    first), action `chat-new`, arg the folder path.
  - **Chat** (`chat` chosen): a head with the chat's title, `project · status`, a back button
    (`chat-back`). Then the last 12 messages of its transcript, oldest first: Claude's text as
    `bubble` text (up to 9 lines each), the user's as plain text starting "You: ", tool use as one
    short muted line each ("Edited island.ts", "Ran npm test", from `describeTool`). If Claude is
    working: a muted "Claude is working…" line. If a permission card or question is waiting for this
    chat: a line saying so (the urgent card shows first anyway). Then the input
    **"Message Claude…"** (action `say:<id>`), always there, also while Claude works (Claude Code
    queues it). Under it a one-line hint of where the message goes (see the routing below).
  - **New chat** (`chat-new` chosen): head "New chat in <folder name>", the input
    "What should Claude do?" (action `say:new:<folder path>`).
  - `chat`/`chat-new` call `ctx.openCard()` so the card opens on the phone that tapped (the
    existing phone-started-action rule); on the PC these actions never occur.
- **Where a message goes** (`messageChat(id, text)` in the Claude activity):
  1. The chat runs in an Island terminal (its pid is a terminal's child, or the chat was started by
     Island): `term_write(id, text + '\r')`.
  2. A live terminal chat (`cli`, not in an Island terminal): the existing `claudeInject`.
  3. A VS Code chat (alive or closed) or a closed terminal chat: Island starts an Island terminal in
     the chat's `cwd` running `claude --resume <sessionId> [--fork-session] <text>` (program+args,
     no shell). `--fork-session` when the original chat's process is still alive (a VS Code panel
     still holds it), so the two never write over each other; a closed chat resumes as it is.
     Island remembers original → new chat, and the phone's chat view follows the new chat once the
     tracker sees it (the session whose process is the terminal's child). The hint says: "Continues
     on your PC in the background (a copy of the VS Code chat)" / "Reopens the chat on your PC in the
     background".
  4. New chat: an Island terminal in that folder running `claude <text>`; the chat view follows it.
  Errors flash on the phone as toasts ("Couldn't start Claude: …").
- Chats in Island terminals are normal chats to the rest of Island: the tracker, hooks, permission
  cards, questions, reply window and pushes work as for any terminal chat. On the PC, their "Open"
  button offers **Open in VS Code**: Island ends the terminal's Claude (`term_kill`) and opens
  `vscode://anthropic.claude-code/open?session=<id>`, so you pick up there with everything said
  from the phone.

### 3. Screen (Chrome Remote Desktop)

- Rust `screen_state() -> "ready" | "off" | "missing" | null`: Windows: the `chromoting` service is
  running / installed but stopped / not installed (Service Control Manager); Mac: null.
- `hello` carries it (`screen`). The phone's bottom bar gets a **Screen** button:
  - `ready`: opens `https://remotedesktop.google.com/access` with a plain same-window navigation
    (`location.href`, no `_blank`), so iOS shows it in the Home Screen app's own in-app browser,
    which slides over Island's app with a **Done** button that returns to it (Moss: "keep everything
    within the app"). It can't be an iframe: the site sends `X-Frame-Options: SAMEORIGIN` (checked
    2026-10-28). A one-time note the first time: "Sign in with the Google account your PC uses, tap
    your PC, enter its PIN. Tap Done to come back to Island."
  - `off`/`missing`/null: a sheet with the steps (on the PC: open remotedesktop.google.com/access in
    Chrome, Set up remote access, install, pick a name and PIN; on the iPhone: the Chrome Remote
    Desktop app is gone from the App Store, use this button) and **Open Chrome Remote Desktop**
    anyway.
- PC Settings › Your phone shows "Chrome Remote Desktop: ready / not set up" with **Set it up**
  (opens the URL on the PC).

## Protocol changes (src/remote/protocol.ts, shared)

- `hello` gains `term: boolean` (terminals allowed now), `screen: 'ready' | 'off' | 'missing' | null`,
  `folders: string[]` (up to 6 recent project folders: the distinct `cwd`s of Claude chats, newest
  first; the terminal's folder picker uses them). The hub sends a fresh `hello` when any of these
  change. Readers accept a `hello` without them (older island): `term: false`, `screen: null`,
  `folders: []`.
- New types and readers: `TermInfo`, `TermHeader` (the stream's first line), `TermReply`
  (`term-ok`/`term-error`), `PhoneControl` gains `term-list` and `term-kill`, `IslandMsg` gains
  `terms`. Frame constants: `TERM_DATA = 0, TERM_RESIZE = 1, TERM_EXIT = 2, TERM_TITLE = 3`,
  `TERM_FRAME_MAX = 65536`, `TERM_REPLAY_MAX = 262144`.
- Nothing else changes; the protocol version stays 1.

## Phone link (phone/wasm, phone/web/src/link)

`api.ts` `Link` gains:

```ts
/** Opens a terminal stream (new when header.id is null); resolves after term-ok, rejects with term-error's text. */
openTerm(header: TermHeader, on: { data(bytes: Uint8Array): void; title(t: string): void; exit(code: number | null): void; closed(): void }): Promise<TermHandle>;
```

```ts
export interface TermHandle {
  readonly id: string;
  readonly title: string;
  write(data: Uint8Array | string): void; // a data frame (strings as UTF-8)
  resize(cols: number, rows: number): void; // a resize frame
  close(): void; // finishes the stream; the terminal keeps running on the PC
}
```

`term-list`/`term-kill` go through `send()`; `terms` arrives through `onMessage`. The wasm side
opens the bi-stream, writes the header line, reads the reply line, then frames both ways.

## Phone app (phone/web)

- Bottom bar (320 CSS px wide on Moss's iPhone, Display Zoom): **Claude**, **Terminal**,
  **Screen**, **Send**, **More**. Clipboard and Lock PC move into More (the menu sheet), above the
  PC switcher.
- **Terminal screen** (full screen over the island view, Back returns): xterm.js (`@xterm/xterm`,
  `@xterm/addon-fit`), font 12 px monospace (A−/A+ buttons, kept in localStorage), the terminal list
  as tabs at the top (title, a dot for running/ended, ✕ = `term-kill` after a confirm), **+** opens
  a sheet: folder (Home, then `hello.folders`, then a text field for any path) and shell
  (PowerShell, Command Prompt, Git Bash), then opens it. A key bar above the keyboard: Esc, Tab, Ctrl (sticky: the next
  key is sent with Ctrl), ↑ ↓ ← →, ^C, Paste (clipboard text), and a keyboard toggle. Resizes on
  rotation and keyboard show/hide (visualViewport). On reconnect it reattaches the open terminal
  (header with its id). When terminals are off on the PC: a screen saying where to turn them on.
- **Screen**: as in 3.
- **Claude**: the bar button opens Claude's card; everything else is the island's own card renderer.
- The demo/fake link (`phone/web/src/dev/fake-link.ts`, `?demo`) gets a fake terminal (echoes input,
  prints a prompt) and `term`/`screen` in its hello, so the screens can be checked in a browser.

## Security

- Terminals are off until switched on at the PC; only paired phones can ask; Windows Hello-for-Allow
  turns them off for phones; the PC island shows each terminal a phone opens; Settings lists them
  (the terminal list) with End.
- The Claude chat runs only `claude` with program+args built by Island (the phone's text is one
  argument, never a shell string), in folders Claude already worked in or the phone's chosen folder.
  Permission prompts reach the phone through the existing cards; with Windows Hello for Allow, Allow
  stays off on phones as today.

## Testing

- Rust: frame encode/decode and limits, the ring buffer (wraps, replay order), header parsing,
  `term-list`/`term-kill` handling, the allow gate, a real pty test (start `cmd /c echo hi` or the
  default shell, read "hi" back, resize, kill) marked to run on Windows, `screen_state` mapping.
- TypeScript: protocol readers (old hello without the new fields), the Claude chat views (list,
  chat, new) and `messageChat` routing with fake natives (terminal chat → term_write, cli → inject,
  VS Code alive → resume with --fork-session, closed → resume without, new → `claude <text>`).
- Phone: Vitest for the frame codec and the key bar's key mapping; the demo in a browser: Claude,
  Terminal (type, see the echo), Screen.
- Real: on the PC, a terminal opened over the real link from a native test phone (as the 10-22
  integration test does over the local relay); then Moss on the iPhone.

## Build order and owners (parallel, no file shared)

| Part | Owns |
|---|---|
| Rust | `src-tauri/src/term/**` (new), `src-tauri/src/remote/**`, `src-tauri/src/screen.rs` (new), `src-tauri/src/lib.rs` registration, `src-tauri/Cargo.toml` |
| Island TypeScript | `src/remote/**` (incl. protocol.ts), `src/core/native.ts`, `src/core/island.ts` (hello facts), `src/activities/claude/**`, Settings in `src/app.ts`, `test/remote*.test.ts`, `test/claude-chat*.test.ts` |
| Phone link | `phone/wasm/**`, `phone/web/src/link/**`, `scripts/phone.mjs` |
| Phone app | `phone/web/**` except `src/link/**`, `phone/vite.config.ts`, `package.json` (xterm deps), `test/phone*.test.ts` |
| Integration (after) | fixes across the seams, docs (STATUS.md entry, ARCHITECTURE.md "Island on your phone" section, this spec's status) |
