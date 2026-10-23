# Land anywhere

Land today sends files to computers on the same network. This plan makes it work across any network, the way Blip does: drag files onto the pill, pick a friend, their island asks, the files land in their Downloads. Built in slices, each one shippable on its own. Slices 1–5 are done (2026-10-15/16): friends on any network send each other files, a dropped connection picks up where it left off, and a send to a friend who is offline waits for them. Slice 6's code went in, but Moss chose not to run a relay server (2026-10-16), so relayed transfers stay at n0's free speed, and the "Your relay" setting was taken out again (0.3.0). Left: 7 (speed, only if measured slow), 8 (Mac), 9 (ship).

```
Your island ── same network ──── TCP + Noise (Land today, unchanged) ──────────────► their island
     │
     └──────── any network ───── iroh: QUIC, dialled by the friend's public key
                                   ├─ direct, through both routers (most home networks)
                                   └─ through a relay when a router or firewall blocks that
                                      (still end-to-end encrypted; the relay only passes bytes)
```

## What Blip does

How Blip behaves for the people using it, and what that means for Island:

- **People are accounts.** You sign in with a code sent to your email, and find people by name or email address.
- **Its servers pass the invites** (send, accept, decline, pause, cancel) between the two apps.
- **Same network: direct. Any other network: through its relay servers.** Its free plan warns that speeds "may be affected by community usage", and the paid plan sells "full-speed sending": relaying the transfers between networks is the cost it pays.
- **End-to-end encrypted**, so a relay only passes bytes; transfers **pause and resume**.

## The choice: where the bytes go

| Way | What it needs | Cost |
| --- | --- | --- |
| Copy Blip: our own account server, message server and relay | A server running all the time, a database, sending email, relay bandwidth for every transfer | Hosting, plus work keeping it running |
| **iroh** (recommended) | The `iroh` crate. Islands dial each other by public key; iroh goes direct when it can, through a relay when it can't | $0 to start on n0's free relays (development/hobby use, rate-limited); later our own relay, open source, on a small server |
| WebRTC | A signalling server and TURN relays anyway | Same servers as copying Blip |

Why iroh: it gets **past most home routers directly** (hole punching plus UPnP/NAT-PMP port mapping), so most transfers never touch a relay, and relay bandwidth is the cost a relay-based service pays. iroh is also Rust (it slots into `land.rs`), stable since 1.0 (1.3.0 out 2026-09-28), and runs on Windows and Mac. Its default crypto is `ring`, so Windows builds need no extra tools, and it needs Rust 1.91+ (we have 1.95).

## How people find each other

**Decision for Moss** (the default below is assumed until Moss says otherwise):

1. **Friend codes (recommended).** Activities › Land shows "Your Land code" with Copy. Send it to a friend any way you like (Discord, a text). They paste it into Land › Add a friend, and both islands ask "Add Alex?". Once both say yes, they're friends and can send any time, from anywhere. No account, no email, no server of ours.
2. **Nearby computers can become friends in one tap.** A computer Land already found on your network can be added without a code, because the two have already met.
3. **Search by email, like Blip.** This needs our own account server, a user database and email sending. It's not part of this plan.

4. **Islands at the same place, when the Wi-Fi keeps devices apart** (2026-10-21, Moss's yes). School and café Wi-Fi often isolates clients, so the network announcements never arrive (seen at Vanier: sends went through the relay because Land never saw the other PC). Islands behind one router share its internet address: each one with Land anywhere on reads it from `https://1.1.1.1/cdn-cgi/trace` and listens on the ntfy.sh topic `island-place-<first 12 bytes of sha256("island-land-place/1|<ip>") in hex>`. Opening Land's card posts one signed "ask" (the same packet as on the network, sent with `Cache: no`); every Island there that takes files answers "here", each at most once a minute (ntfy.sh limits messages per internet address, and everyone there shares one). Found this way, a computer only shows with **Add** ("Here · tap to add"); files still go to friends only. Anyone who knows the internet address can read the names posted there, as anyone on the Wi-Fi hears them on the network. Code: `src-tauri/src/land/place.rs`.

Only friends (and computers on the same network, as today) can send offers. A connection from an unknown key is closed before anything reaches the screen.

## Slices

1. **An iroh endpoint in Land.** Done 2026-10-15.
   - `src-tauri/Cargo.toml`: `iroh 1.3` (default features minus metrics) and `data-encoding`.
   - `src-tauri/src/anywhere.rs`: a second key (iroh's Ed25519; Land's Noise key is X25519) in `<data dir>/land-anywhere.key`, made on first use. The endpoint uses `presets::N0` (n0's relays and key lookup) and the ALPNs `island-land/2` (transfers, slice 3) and `island-friend/1` (friend requests).
   - The accept loop closes any connection whose key isn't a friend's (close code 403) as soon as the handshake proves the key, except on `island-friend/1`.
   - Checked: 9 tests (codes, the key file, friend / stranger / removed friend / friend request over loopback), plus `found_by_key_through_n0` (ignored), which found an endpoint by key alone through n0's DNS and relay `use1-1` in 5 s.
   - Island.exe grew from 9.4 MB to 14.0 MB.
2. **Friends.** Done 2026-10-15 (one-tap add of nearby computers 2026-10-16); 2b not done.
   - **Code**: `land:` plus 56 base32 characters (version byte, the 32-byte key, 2 check bytes). Case, spaces, dashes and the prefix don't matter; a changed character fails the check ("That code has a typo").
   - **Request** on `island-friend/1`: one JSON message each way: `{t:"ask", name, os}`, then `{t:"yes", name}` or `{t:"no", why: declined | timeout | busy}`. Someone already a friend gets yes at once, with no prompt. A blocked key is closed before it can ask, and its Island only hears "They said no". At most 3 requests wait at once; after Not now, the same Island is turned away for 10 minutes.
   - **Kept** in `<data dir>/land-friends.json` (friends: id, name, added; blocked ids), written through a temp file. Owned by Rust, so the gate and the file never disagree.
   - **The island**: a request takes the island like a file offer: shake, a Windows notification, the pill "Alex wants to be friends" with Not now / Add, and a card with a 2-minute countdown and Block / Not now / Add. A file offer comes first. While the island is hidden, requests get no at once.
   - **Activities › Land**: a "Friends on other networks" switch (on by default; it starts the endpoint), Your Land code with Copy, Add a friend (paste, Add, waits for the answer), and the friends with Remove / Block. They are not told.
   - **Commands**: `land_me`, `land_friends`, `land_friend_add`, `land_friend_answer`, `land_friend_remove`; `land_start` takes `anywhere`. **Events**: `land-friend-ask` (state asking, then added | declined | blocked | expired | gone) and `land-friends`.
   - **Checked**: 6 friend tests in `anywhere.rs`, 1 in `land.rs` (Land's name and events reach the friend layer), 5 in `test/land.test.ts`. 30 Land cargo tests and 455 Vitest pass. On the real app: `ask_the_island_running_here` (ignored) asked Moss's running Island by its code alone. The island had the request 104 ms after it was sent, and iroh moved from the relay to a direct path within seconds.
   - **Nearby, no code** (2026-10-16): the LAN announcement carries the Island's friend key (`ak`) and that key's signature over its Land key (`aks`), so no one on the network can borrow a friend's key; a claim that fails the check is dropped and the packet kept. Older Islands ignore both fields. Activities › Land lists nearby Islands that can be added ("Add as friend", `land_friend_add_nearby`), which asks them like a code would.
   - **Still to do**: 2b, clickable `island://land/add?...` links via `tauri-plugin-deep-link` (Island registers no link scheme today).
3. **Send to a friend over iroh.** Done 2026-10-15.
   - **One protocol, two pipes.** `Wire` is Noise (TCP, computers nearby) or Plain (QUIC, friends: QUIC already encrypts and proves the other side's key). `send_json`, `recv`, `take_files` and the new `exchange` / `receive_on` take any tokio reader and writer.
   - **Same rules both ways.** The messages (`offer` → `accept`/`decline` → file frames → `done` → `saved`), the receive rules (nothing written before Accept, clean names, never overwrite, Zone.Identifier) and the `land-transfer` events are shared.
   - **Sending.** `send` looks the id up among the computers nearby first, then the friends. `send_far` dials the friend's key on `island-land/2` (20 s limit), opens one stream, runs the exchange, and closes the connection. Someone who removed you: "X isn't taking files from you. Ask them to add you again with your Land code."
   - **Receiving.** `Far` hands friends' `island-land/2` connections to Land (`land_connections`, then `receive_far`). A connection that never opens a stream is an online check and is dropped quietly. Friends can send even when "Let computers nearby send me files" is off.
   - **How it goes.** Transfers carry `via`: `lan`, `direct` or `relay`, refreshed with progress, since iroh can move from the relay to a direct path midway. Transfer rows add "· direct" or "· through a relay".
   - **The card.** Friends show after the computers nearby, with a globe badge and "Friend", then "Online" / "Not online". `land_friends_online` dials each friend with a 3 s limit when the card opens or files are dropped, and every 20 s while it is open. They can be picked like computers; a lone friend is picked for you. The Send label says "Pick who gets them" when there are friends.
   - **Checked.**
     - Rust: 4 new tests in `land.rs` (a friend gets files and folders after consent, direct; a friend declines; someone who removed you gets nothing; online = the friends that answer), and the 30 existing Land tests through the refactored code. 132 cargo lib tests in all.
     - Island: 5 new tests in `test/land.test.ts`; 460 Vitest pass.
     - For real, through n0's lookup and relays (`files_reach_a_friend_through_n0`, ignored): 2 MB arrived in 0.4 s the normal way (still on the relay at the end), and in 1.3 s with the relay only (about 1.5 MB/s, n0's free-relay limit).
   - **A friend nearby** (2026-10-16): shows once, as the computer nearby with the friend badge, and gets files the fast way (TCP on this network). Sending to a friend's key finds them nearby first.
4. **Resume after a drop.** Done 2026-10-16, for computers nearby and friends alike.
   - **When it applies.** The connection drops after Accept. Before Accept, nothing changes: the offer fails as before.
   - **Sender.** The transfer shows Paused ("Connection to X lost. Trying again…") and tries again after 2 s, 4 s, 8 s … up to 5 minutes apart, for 30 minutes; then "X didn't come back to finish, so Land stopped trying". Cancel stops it. Each try offers the same transfer again: `tid` (the transfer's id) and each file's `mtime` go with the offer.
   - **Receiver.** It keeps the `.landing` pieces (Paused, "Continues when X is back") for 2 hours, then removes them. An offer with the same sender key, `tid` and files (names, sizes, mtimes) is the same transfer, so it is accepted at once without asking again: `{t:"accept", have:[bytes per file]}`, taken from the pieces on disk. The sender seeks past that, and the transfer keeps its id on both islands.
   - **Edges.** Files changed meanwhile: a new offer, asked again. A paused receive the user cancels removes the pieces, and its comeback is turned away for an hour ("X cancelled."). Land turning off removes paused pieces. Senders without `tid` (older Islands) end as failed, as before.
   - **Integrity.** Same size and mtime, or it starts over. TCP + Noise and QUIC already check every byte in transit.
   - **Checked.** 4 tests in `land.rs` cut the connection after 300 KB of a 1 MB file, through a test-only switch (`cut_after`): it picks up nearby and with a friend over iroh, byte for byte, asked once; a cancel while paused stops the retries and removes the pieces; nobody coming back cleans up. 5 runs in a row passed. 1 test in `test/land.test.ts` (Paused on the pill and in the card, with Cancel).
5. **Send to a friend who is offline.** Done 2026-10-16.
   - **Waiting.** A friend whose Island can't be reached (`far_connect`, 20 s) makes the send wait (state `queued`) instead of failing. It is kept in `<data dir>/land-queue.json` (id, friend, the dropped paths, when it began), so it outlives Land turning off or Island restarting. On start, Land picks the waiting sends up again, reading the files from disk; files that are gone end the send ("The files waiting to be sent are gone").
   - **Goes as soon as they're back.** A starting Land says hello to its friends `hello_after` (5 s) later, dialling each like the online check. Any connection from a friend wakes the sends waiting for it at once (`kick`), and the friends that answer the hello wake this Island's own waiting sends. Without a hello, a try every `queue_retry` (2 min) finds them. After `queue_for` (3 days): "X didn't come online, so Land stopped trying to send". Cancel forgets it.
   - **The island.** A waiting send stays off the pill (it can wait days): in the Land card it says "Sends when Alex is online", with Cancel; the avatar says "Sends when online"; the tile, "1 waiting". When it goes, it takes the pill like any send, and the receiver is asked as usual.
   - **Found on the way.** `watch::Sender::send` drops the value when nothing listens yet, so Land's stop flag could stay false and a stopping Land wiped the waiting sends. Now `send_replace`.
   - **Checked.** 4 tests in `land.rs`: a send to a friend who is away waits, and goes the moment they start and say hello (the regular try was a minute away); cancel forgets it (and its line in `land-queue.json`); it outlives a restart of the sender's Island, same id, then delivers; nobody coming back gives up. 3 extra runs in a row passed. 1 test in `test/land.test.ts`. 146 cargo lib tests, 464 Vitest.
   - **Not done.** The optional phone push when a waiting send arrives.
6. **Our own relay, before other people use Land anywhere.** Code done 2026-10-16. Moss decided not to run a relay server (2026-10-16), and the setting was removed (0.3.0). The steps below stay for if that changes; the setting would have to come back first.
   - **Why.** n0's free relays are for development and hobby use, with no uptime promise. Measured here 2026-10-16: 20 MB relay-only in 17.5 s, **1.15 MB/s** (`relay_speed`, ignored). They also see who connects to whom, when and how much, though not the content. Direct paths don't use a relay at all.
   - **Island.** Activities › Land › Your relay: `https://relay.example.com` (empty: n0's). The endpoint uses that relay as its home and still finds friends by key through n0's lookup, so friends on n0's relays reach it too. A wrong address doesn't turn Land off: n0's relays are used, and the Land card says why.
   - **Checked.** `friends_meet_and_send_through_our_own_relay` runs a real iroh relay on this computer (self-signed, through `iroh-relay`'s server as a test-only dependency): two Islands meet through it and the file goes through it (`via: relay`). `a_relay_address_is_a_web_address`.
   - **Moss's part: run the relay** (about an hour):
     1. A small Linux server with a public IP. Free tiers exist (Oracle Cloud Always Free, for example); check their terms first.
     2. A domain name pointing at it (an A record), for example `relay.yourdomain.com`. A free DuckDNS name also works.
     3. Open TCP 80 (Let's Encrypt and the captive-portal check), TCP 443 (the relay) and UDP 7842 (QUIC address discovery). Keep 9090 (metrics) closed.
     4. On the server: `cargo install iroh-relay --features server` (needs Rust), then `/etc/iroh-relay.toml`:
        ```toml
        enable_relay = true
        http_bind_addr = "[::]:80"
        enable_quic_addr_discovery = true

        [tls]
        cert_mode = "LetsEncrypt"
        hostname = ["relay.yourdomain.com"]
        contact = "you@example.com"
        prod_tls = true
        cert_dir = "/var/lib/iroh-relay"
        ```
     5. Run it as a service: `iroh-relay --config-path /etc/iroh-relay.toml` (a systemd unit with `Restart=always`).
     6. In Island: Activities › Land › Your relay: `https://relay.yourdomain.com`. Friends set the same, or keep n0's; either way they reach each other.
7. **Speed, only if measured slow.** Measure the same 1 GB file over LAN TCP, iroh direct and the relay before changing anything. Several parallel connections can help long TCP paths and relays; QUIC already tunes itself, so try that only if the numbers call for it.
8. **Mac.** iroh runs on macOS as is; Land's Mac pieces already exist. CI compiles it, and someone tries it on the borrowed Mac.
9. **Ship.** ARCHITECTURE › Land, the privacy note (relays and n0's key lookup see connection metadata), the onboarding line, STATUS, and a release when Moss says.

Total: about 5 to 7 days of sessions for slices 1–5 (usable between friends from slice 3 on), then slice 6 before telling other people to use it.

## Watch out for

- **School or work Wi-Fi** often blocks the UDP that direct paths need. iroh then goes through the relay over HTTPS, so it still works, just slower.
- **Windows Firewall.** Windows' prompt ticks Private only, which also writes a Block rule for Public, and school Wi-Fi is Public. Land's card now says when the firewall keeps it out on the current network and fixes it with one UAC prompt (`src-tauri/src/firewall.rs`: drops Island's inbound rules, allows it on every profile). The first-run text says to tick both. iroh's outgoing UDP usually needs no prompt; check on the first real test.
- **Exe size.** iroh grew Island.exe from 9.4 MB to 14.1 MB (the relay server is a test-only dependency and isn't in it).
- **Other sessions edit `land.rs`.** Check `git status` and ListAgents before slice 3's refactor.
- **Never use Blip's servers or code.** This design uses open-source iroh and our own protocol; nothing of Blip's goes into this repo.
