# Island on your phone: design

Date: 2026-10-22. Status: approved by Moss (all three phases; publish the site on Vercel).

Moss asked for "a website so users can interact with the island from their phone", with: see the
island live, tap the tiles, answer Claude, send things to the PC, "and anything else that would be
really cool and useful". It must work **anywhere**: home Wi-Fi, school Wi-Fi (Vanier's keeps
devices apart, so a same-network page fails there) and cellular. Moss does not run servers of
their own (no relay; see LAND-ANYWHERE.md).

## The idea in one paragraph

The phone shows a **live copy of the island** and taps on it act on the real one. The island
already turns everything it draws into plain data: Duplicate mode sends the pill as a
`MirrorFrame` (src/core/mirror.ts), and cards and Control Center are `SheetView`s whose buttons
carry action strings (`act:<activity>:<name>`, src/core/sheet.ts, island.ts `nsAction`). The phone
website draws that data with the island's own renderers (`PillRenderer`, `SheetRenderer`,
`BubbleView`, the same CSS), so it looks exactly like the island and every activity works on
the phone without phone-only code. A tap sends the action back; the island runs it as if it
had been clicked. The phone reaches the PC through iroh, the library Land anywhere already
uses: in a browser iroh runs as WebAssembly and goes through n0's relays over WebSocket, while
the QUIC/TLS session stays end to end between the phone and the PC.

```
iPhone (Home Screen web app, https)                PC (Island)
┌────────────────────────────────────┐            ┌──────────────────────────────────────┐
│ phone/web: shell, pairing, Send     │            │ src/remote/hub.ts (TS): views, nav,  │
│  draws with src/core renderers      │            │   allowlist, phone commands          │
│ phone/web/src/link: TS wrapper      │            │ src/core/island.ts: phoneView/Action │
│ phone/wasm: iroh endpoint (wasm32)  │            │ src-tauri/src/remote (Rust): accept, │
└──────────────┬─────────────────────┘            │   pairing, phones.json, lines, files,│
               │ QUIC over wss, ALPN island-phone/1│   Web Push                            │
               └────────── n0 relay ───────────────┤ src-tauri/src/anywhere.rs endpoint   │
                                                   └──────────────────────────────────────┘
```

Rejected: a phone-only app with hand-built screens (every feature twice; new island features
never reach the phone on their own). ntfy as the channel (250 messages a day and 4 KB per
message on ntfy.sh: too small for a live view). A page served by Island on the local network
(fails at school and on cellular).

## Phases

1. **Live island.** Pair; the pill (with the bot), Control Center (tap tiles), every card:
   Claude's permission cards, questions, the reply window, Reminders' input, Land, Workspaces'
   restore questions. Offline state ("MossLaptop is offline · last seen 2:14 PM"). Installable to
   the Home Screen.
2. **Phone ↔ PC.** Send photos, files, text and links to the PC (files to Downloads, text to the
   PC clipboard, both shown on the island); copy the PC's clipboard to the phone; send a file from
   the PC to the phone (Land's card lists paired phones); **Lock my PC**.
3. **Notifications from the Home Screen app.** Web Push straight from Island to the phone (no
   ntfy app needed): the moments ntfy gets today; tapping one opens the app on that card.

Each phase is built and checked end to end before the next starts.

## Pairing

1. PC: Settings › **Your phone** › **Pair a phone**. Island makes a one-time code (16 random
   bytes, hex), good for 10 minutes and 5 wrong tries, and shows a QR code of
   `PHONE_SITE/#pair=<payload>`, where payload is base64url (no padding) of
   `{"v":1,"id":"<island EndpointId, its Display form>","relays":["<home relay URL, no trailing dot>", …],"code":"<32 hex>","name":"<computer name>"}`.
   The steps beside the QR code: on the iPhone open the site, Share › Add to Home Screen, open
   Island from the Home Screen, tap Scan, point at this code.
2. Why the Home Screen first: iOS gives Home Screen web apps their own storage, which Safari's
   7-day wipe of unvisited sites does not touch; a pairing made in a Safari tab would be lost.
   Web Push (phase 3) also needs the Home Screen app. Opening the pairing URL in Safari (camera
   scan) shows the Add to Home Screen steps; "Use it in Safari anyway" pairs right there.
3. Phone: makes its own iroh secret key the first time (32 bytes from `crypto.getRandomValues`,
   kept in localStorage as base64), dials the island (`EndpointAddr` = id + relay URLs) on ALPN
   `island-phone/1`, opens the control stream and sends `pair` with the code and a name
   ("iPhone" from the user agent; renamed on the PC).
4. PC: checks the code (constant-time, unexpired, unused), stores the phone's EndpointId, name,
   paired time in `<data dir>/phones.json`, answers `paired`, and the session starts. Wrong
   code: `denied`, close; the fifth wrong try ends the code.
5. Later connections send `hi`; only EndpointIds in phones.json get past it. The id is the
   phone's key, proven by the TLS handshake. Settings lists phones (Connected now / last seen,
   Rename, Remove). Remove closes its connection with `bye` and forgets it.

One phone can pair with several PCs (the phone keeps a list and opens the last used; a switcher
shows when there are more). A PC can pair several phones.

## The connection

- ALPN `island-phone/1` on an iroh endpoint of the remote's own (its own key,
  `<data dir>/phone-endpoint.key`, the same relay settings as Land anywhere's in anywhere.rs). So
  phones work with Land anywhere switched off and Land's accept rules stay untouched. It runs
  while a phone is paired or being paired.
- The phone opens one bidirectional **control stream** right after connecting. Every control
  message is one JSON object on one line (UTF-8, `\n`), at most 1 MiB per line; a longer line
  closes the connection.
- The phone keeps the connection only while its page is visible (closes 30 s after it is hidden;
  reconnects on show). It sends `ping` every 15 s; Rust answers `pong`. Reconnect backoff while
  visible: 1 s, 2 s, 4 s … 30 s.
- File transfers (phase 2) each get their own bidirectional stream.

### Messages

Phone → island, handled in **Rust** (never forwarded to TypeScript):

| Message | Meaning |
|---|---|
| `{"t":"pair","v":1,"code":"…","name":"iPhone"}` | first line when pairing |
| `{"t":"hi","v":1}` | first line when already paired |
| `{"t":"ping"}` | keepalive → `{"t":"pong"}` |
| `{"t":"push-sub","sub":{endpoint,keys:{p256dh,auth}}\|null}` | phase 3: Web Push subscription, kept in phones.json |

Island → phone, from **Rust**: `{"t":"paired","name":"<island name>"}`,
`{"t":"denied","why":"code"|"expired"|"unknown"|"version"}` (then close),
`{"t":"pong"}`, `{"t":"bye","why":"removed"}` (then close).

Every other line from a phone that got past `pair`/`hi` goes to TypeScript as the event
`remote-msg` `{phone, msg}`. TypeScript sends with the command `remote_send(phone, msg)`.

Phone → island, handled in **TypeScript** (src/remote/hub.ts):

| Message | Meaning |
|---|---|
| `{"t":"nav","open":"grid"\|"none"}` / `{"t":"nav","open":"card","id":"<activity>"}`, optional `"width":<css px>` | what the phone shows under its pill |
| `{"t":"act","action":"act:music:toggle","arg":…}` | a tap; run only if that action is in what this phone was last sent (see Security) |
| `{"t":"text","text":"…"}` | phase 2: text/link from the phone → PC clipboard + a card on the island |
| `{"t":"clip-get"}` | phase 2: the PC clipboard's text → `clip` |
| `{"t":"lock"}` | phase 2: lock the PC (`shell_lock`) |

Island → phone, from **TypeScript**:

| Message | Meaning |
|---|---|
| `{"t":"hello","v":1,"name","platform":"windows"\|"macos","version","allow":bool,"vapid":string\|null}` | first message of a session. `allow`: whether Allow buttons may be pressed from a phone. `vapid`: phase 3 |
| `{"t":"pill","frame":MirrorFrame,"bot":{look,play,strength}\|null}` | the pill as the island draws it, and the bot as `BubbleView.show` takes it; sent on change |
| `{"t":"view","nav":{…},"view":SheetView\|null,"urgent":"<activity>"\|null}` | what to draw under the pill; sent on change, at most 8 a second |
| `{"t":"toast","text","tone":"good"\|"bad"\|"info"}` | a short note (Sent, Locked, errors) |
| `{"t":"clip","text"}` | phase 2: answer to `clip-get` |

Shared TypeScript types, the ALPN, limits, `PHONE_SITE` and the pairing payload's encode/decode
live in **src/remote/protocol.ts**, imported by the island and by the phone site. Rust mirrors
what it reads (pair, hi, ping, push-sub, file headers).

### Files (phase 2)

- Phone → PC: a new bi-stream; first line `{"t":"file","id":"<random>","name":"IMG_0001.JPG","size":<bytes>,"mime":"image/jpeg"}`,
  then exactly `size` bytes, then the phone finishes its side. Rust saves to Downloads with
  Land's rules (never overwrite: `name (2).jpg`; the "from another computer" mark), at most
  2 GiB, and answers one line `{"t":"file-ok","id","name":"<saved name>"}` or
  `{"t":"file-error","id","error"}`. It emits `remote-file` `{phone, id, name, path, size, mime}`;
  TypeScript shows it on the island like Land shows a received file (Open, Show in folder).
- PC → phone: Land's card lists connected paired phones beside nearby computers and friends; a
  send opens a bi-stream to the phone with the same header and bytes (at most 200 MB: it is held
  in the phone's memory). The phone shows "From MossLaptop · report.pdf · Save" (Save = the iOS
  share sheet through `navigator.share({files})`, else a download link) and answers `file-ok`.

## The island side

### Rust: `src-tauri/src/remote/` (new)

- Pairing codes (one at a time), `phones.json` (id, name, pairedAt, lastSeen, push subscription),
  the per-phone session (control stream reader/writer, a bounded send queue that keeps the
  newest `pill` and `view` when the phone falls behind), file streams, and phase 3's Web Push.
- Its own endpoint (see The connection) accepts only `island-phone/1`; any key may connect, and
  `remote` closes anything that hasn't paired or said `hi` from a paired id within 10 s.
- Commands: `remote_pair_start(site) -> {url, qr, size, expires}` (QR made by `land::share::qr`),
  `remote_pair_stop()`, `remote_phones() -> [{id, name, pairedAt, lastSeen, connected, push}]`,
  `remote_rename(id, name)`, `remote_forget(id)`, `remote_send(phone: Option<String>, msg)`
  (None = every connected phone), `remote_send_file(phone, path)` (phase 2),
  `remote_push(title, body, tag, open)` (phase 3).
- Events to the island window: `remote-phones` (the list, on any change), `remote-paired`
  `{phone, name}`, `remote-msg` `{phone, msg}`, `remote-file` `{phone, id, name, path, size, mime}`,
  `remote-file-sent` `{phone, name, ok, error?}` (phase 2).
- Mac: same code (iroh is portable); `shell_lock` and Downloads already have Mac twins or must
  get them where missing.

### TypeScript: `src/remote/` (new) and hooks in `src/core/island.ts`

- **hub.ts**: per connected phone its `nav`, width, last view JSON, allowlist and last pill key;
  sends `hello` on connect; on every island compose (and when a phone's nav changes) works out
  that phone's view and pill and sends what changed (at most 8 views a second per phone).
- **island.ts** gets three small entry points, nothing else changes for the PC:
  - every composed `MirrorFrame` (and the bot's look) goes to the hub, also when no Duplicate
    copy runs;
  - `phoneView(nav, width)`: an **urgent** card first (any running activity whose status has an
    `urgent` card that wasn't dismissed, the same card the PC shows for it), else for
    `open: grid` the Control Center grid packed for the phone's width (4 columns, the user's
    layout and pages), for `open: card` that activity's card (`reason: 'open'`), for `none`
    nothing. Actions come out namespaced exactly like on the PC;
  - `phoneAction(phone, action, arg)`: runs the action through `handleAction`. If the activity
    calls `ctx.openCard()` while that phone-started action runs, the card opens **on that phone**
    (its nav becomes that card), not on the PC.
- **Settings › Your phone** (a new section after Notifications in src/app.ts): what it is in two
  lines, **Pair a phone** (QR code, the steps, a 10-minute countdown, Cancel; closes itself with
  "Paired with iPhone" on `remote-paired`), the phone list (Connected now / Last seen …, Rename,
  Remove), and phase 3's Notifications state per phone. The setup's "Your phone and Island"
  screen (welcome.ts) mentions it in one line with a button to Settings.
- Phase 2 commands: `text` → copied to the PC clipboard at once and shown the way Land shows text
  from another computer (labelled with the phone's name, Open for a link); files from the phone
  show the way Land shows a received file; `clip-get` → the clipboard's text (`clipboardPaste`);
  `lock` → `shellLock`. Land's card lists connected phones as targets beside computers and friends
  (`remote_send_file` for files, a `text` line for text).
- Phase 3: wherever Island pushes to ntfy (`toPhone` in island.ts: notify and Claude's moments),
  it also calls `remote_push` for phones with a subscription; Quiet holds both.

## The phone site: `phone/` (new)

- **phone/wasm**: a small Rust crate (`cdylib`, wasm-bindgen, its own Cargo workspace, excluded
  from the root workspace) wrapping an iroh 1.3 endpoint in browser mode: make or load the key,
  dial an island, the control stream as lines in and out, file streams both ways, close. Built
  for `wasm32-unknown-unknown` with the recipe the 2026-10-22 spike proved (see the plan).
- **phone/web/src/link/**: the TypeScript wrapper the app uses (`api.ts` is the contract):
  connect, reconnect with backoff, send a message, subscribe to messages, send and receive files,
  state changes (connecting, online, offline, denied).
- **phone/web/**: Vite app, plain TypeScript and DOM like the rest of the repo, importing the
  island's renderers and CSS from `src/core` and `src/styles`. Screens:
  1. In Safari, not installed: how to Add to Home Screen (and "Use it in Safari anyway").
  2. Not paired: **Scan the code on your PC** (camera, QR decoded in the page) or paste a
     pairing link.
  3. Connecting / offline: "MossLaptop is offline · last seen 2:14 PM", retrying.
  4. The island: the pill at the top (safe area) drawn from `pill`, the bot beside it, the
     card or Control Center under it drawn from `view`. Tap the pill → Control Center; tap a
     chip → its card; a Back button returns to Control Center. Grid arranging is off on the phone.
     A bottom bar: **Send** and **Clipboard** (phase 2), **Lock PC** (phase 2, asks first),
     and a menu (switch PC, Remove this PC, Notifications in phase 3).
- PWA: manifest (name "Island", standalone, dark, icons from the app icon), a service worker that
  caches the shell (and, in phase 3, shows pushes and opens `/?open=<activity>` on a tap).
- Hosted on Vercel as a static site (project `islandphone`; the final address goes in
  `PHONE_SITE`). No data passes through Vercel. Headers: a CSP allowing the page itself, `wasm`,
  and `connect-src` to the relays (wss/https).

## Security

- Only paired phones get a session; a phone is its iroh key, proven by TLS. Pairing codes are
  one-time, 10 minutes, 5 tries. Removing a phone cuts it off at once.
- A phone can only press what it was shown: the hub keeps, per phone, the set of action strings
  in the last `view` and `pill` it sent, and runs an `act` only if its action is in that set.
  From `island:*` only `island:dnd` (Quiet). Never grid arranging, `island:app`, hiding or moving
  the island.
- Allow from a phone follows the existing rule for phone answers: with Windows Hello asked before
  Allow, `hello.allow` is false, the hub strips Claude's Allow buttons from what it sends to
  phones and refuses those actions.
- Traffic is end to end encrypted; the relay sees sizes and timing. Phase 3 pushes are encrypted
  for the phone (RFC 8291); Apple sees only that a push went to that endpoint.
- Files from the phone get the same "from another computer" mark as Land's.

## Errors and edge cases

- PC asleep, Island closed, relay unreachable: the phone shows offline with the last seen time
  and keeps retrying while visible.
- A protocol version the other side doesn't speak: `denied` `version` → "Update Island on your
  PC" or "Reload this page".
- A phone that fell behind gets the newest `pill`/`view` only (stale ones are dropped).
- Pairing while Island is hidden for a while: allowed; the phone shows the hidden pill as the PC
  does.

## Testing

- Rust: pairing (expiry, one-time, tries), phones.json, line framing and caps, the send queue's
  drop rule, file saving names; an integration test with a native "phone" over the local relay
  the Land tests already run (`local_relay`): pair, `hi`, a forwarded message, a file saved.
- TypeScript: protocol encode/decode, the allowlist, nav handling, `phoneView` with fake
  activities, the Allow stripping.
- Phone: Vitest for its pure parts; end to end in headless Edge and WebKit against a real Island
  through n0's relays (pair, see the pill and grid, tap a tile, answer a card, send a file).
- On Moss's iPhone after deploying: add to Home Screen, pair, the four phase 1 checks.

## Who builds what (parallel work, no file shared)

| Part | Owns |
|---|---|
| Rust (island) | `src-tauri/src/remote/**`, `lib.rs` registration, `src-tauri/Cargo.toml`, visibility-only changes in `land/files.rs` and `land/share.rs` |
| TypeScript (island) | `src/remote/**` except protocol.ts, the hooks in `src/core/island.ts`, `src/core/native.ts` wrappers, Settings in `src/app.ts`, `src/welcome.ts` line, phone deliveries and phone targets in `src/activities/land.ts`, `test/remote*.test.ts` |
| Phone link | `phone/wasm/**`, `phone/web/src/link/**` (api.ts given), `scripts/phone.mjs`, the root `Cargo.toml` exclude, `.gitignore` lines |
| Phone site | `phone/web/**` except `src/link/**`, `phone/vite.config.ts`, `package.json` scripts, `vercel.json`, `test/phone*.test.ts` |
| Shared (written first) | `src/remote/protocol.ts`, `phone/web/src/link/api.ts` |

## Risks

- n0's public relays are rate-limited and meant for development; Land already relies on them and
  a phone's traffic is small (a view is a few KB). If they throttle, the fix is a relay of our
  own, which Moss has said no to for now.
- WebKit (iPhone Safari) running iroh's wasm build: checked in WebKit on Windows, finally on the
  iPhone.
- Camera access for QR scanning in a Home Screen app, and Web Push, need iOS 16.4 or later.
- Album art inside views is base64; views with art are sent only when they change.
