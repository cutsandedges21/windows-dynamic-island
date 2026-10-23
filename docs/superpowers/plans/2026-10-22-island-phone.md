# Island on your phone: implementation plan

> **For agentic workers:** this plan was executed as four parallel tracks (Moss: "use subagents to
> make this go much faster"), each owning its own files, then integrated by the coordinating
> session. Steps use checkbox (`- [ ]`) syntax for tracking. No commits unless Moss asks.

**Goal:** a website (islandphone.vercel.app, a Home Screen web app on the iPhone) that shows the
island live and controls it from anywhere, in three phases: live island, phone ↔ PC, push
notifications.

**Architecture:** the phone draws the island's own `MirrorFrame` and `SheetView`s with the
island's own renderers and sends taps back as the same action strings. The phone runs iroh 1.3 as
WebAssembly (relay-only through n0's relays, end to end encrypted) and dials an iroh endpoint the
island keeps for phones (ALPN `island-phone/1`). Spec:
`docs/superpowers/specs/2026-10-22-island-phone-design.md`.

**Tech stack:** Rust (Tauri 2.12, iroh 1.3, tokio, reqwest, RustCrypto for Web Push), TypeScript
(plain DOM, Vite 7, Vitest 5), wasm-bindgen 0.2.129, LLVM clang for ring on wasm32, Vercel static
hosting.

---

## Shared contracts (written before the tracks started)

- [x] `src/remote/protocol.ts`: messages, constants, `PHONE_SITE`, pairing payload
  encode/decode, `readPhoneMsg`/`readIslandMsg`, `actionsIn` (the allowlist source). Tests:
  `test/remote-protocol.test.ts` (6).
- [x] `phone/web/src/link/api.ts`: the `Link` interface between the phone's connection and its UI.
- [x] Pairing payload test vector (TypeScript and Rust must both produce it): JSON
  `{"v":1,"id":"k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0","relays":["https://use1-1.relay.n0.iroh.iroh.link/"],"code":"0123456789abcdef0123456789abcdef","name":"Moss’s Laptop"}`
  → `eyJ2IjoxLCJpZCI6ImszbTl4cTdkMXc1eWh6OGM0YjJuNnAwcnRmYTNlN2dqOXN2NW91MWxxeHcyeTR6NmM4ZDAiLCJyZWxheXMiOlsiaHR0cHM6Ly91c2UxLTEucmVsYXkubjAuaXJvaC5pcm9oLmxpbmsvIl0sImNvZGUiOiIwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsIm5hbWUiOiJNb3Nz4oCZcyBMYXB0b3AifQ`.

## The browser spike (2026-10-22, before the build)

iroh 1.3.0 compiled to wasm32 in Edge 155 and Playwright WebKit dialed a native iroh 1.3.0 peer
through n0's relay: 27 of 27 runs passed; connect 250–480 ms, steady round trip 54–58 ms (Edge)
and 78–92 ms (WebKit), server pushes all arrived; dialing by EndpointId alone works through
`https://dns.iroh.link/pkarr/<id>` (CORS fine). Recipe: lockfile seeded from Island's (pins the
iroh crates to 1.3.0; otherwise siblings resolve to 1.4.x); browser crate `iroh` with
`default-features = false, features = ["tls-ring"]`, `ring` with `wasm32_unknown_unknown_js`;
`Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Custom(<n0 prod relay map, trailing
dots stripped>))`; clang 23.1.4 from the official LLVM Windows archive (bin/clang.exe,
bin/llvm-ar.exe, lib/clang/23/include) via `CC_wasm32_unknown_unknown`/`AR_wasm32_unknown_unknown`;
`wasm-bindgen-cli 0.2.129 --target web`; `wasm-opt -Oz`. Sizes: wasm 2.58 MB raw, 1.10 MB gzip
(0.85 MB brotli), JS glue 47 KB. A QUIC stream appears to the accepting side only after the opener
writes: the phone writes its first line at once. Spike files: `C:\tmp\iroh-phone-spike`.

## Track A: Rust, island side (`src-tauri/src/remote/**`, lib.rs, Cargo.toml)

- [ ] Phase 1: phones.json; pairing codes and payload (test vector); own endpoint
  (`presets::N0`, key `phone-endpoint.key`, ALPN `island-phone/1`); handshake (pair/hi/denied,
  10 s); session reader/writer with the coalescing outbox; commands `remote_pair_start/stop`,
  `remote_phones`, `remote_rename`, `remote_forget`, `remote_send`; events `remote-phones`,
  `remote-paired`, `remote-msg`; integration test over a local relay.
- [ ] Phase 2: files phone → Downloads (Land's naming and mark), `remote-file`;
  `remote_send_file` PC → phone, `remote-file-sent`.
- [ ] Phase 3: VAPID key, `remote_vapid`, `remote_push` (RFC 8291 + 8292), RFC 8291 test vector.
- Check: `cargo test --lib`, clippy `-D warnings`, with `CARGO_TARGET_DIR` outside OneDrive.

## Track B: TypeScript, island side (`src/remote/**`, island.ts hooks, native.ts, Settings, land.ts)

- [ ] Phase 1: `PhoneHub` (hello, pill, views ≤ 8/s on change, nav, allowlist, Allow rule);
  island.ts `phoneView`/`phoneAction` and the frame/bot feed; Settings › Your phone (pair QR,
  phones list); welcome.ts line; `test/remote-hub.test.ts`.
- [ ] Phase 2: text/files from phones shown like Land's deliveries; `clip-get`; `lock`; phones as
  Land targets.
- [ ] Phase 3: `hello.vapid`; `toPhone` also pushes to phones; Settings per-phone notifications.
- Check: `npx tsc --noEmit`, `npx vitest run`, the /?fill preview.

## Track C: the phone's link (`phone/wasm/**`, `phone/web/src/link/**`, `phone/e2e/**`, `scripts/phone.mjs`)

- [ ] Toolchain kept in `%LOCALAPPDATA%\windows-dynamic-island\tools` (llvm, wbg); wasm target dir
  `%LOCALAPPDATA%\windows-dynamic-island\target-phone`.
- [ ] `scripts/phone.mjs wasm|dev|build|deploy`; root `Cargo.toml` excludes `phone`.
- [ ] wasm crate (endpoint from a stored key, connect with pkarr fallback, lines, files, close);
  `link/index.ts` implementing `Link` (states, pair, open, backoff, ping, visibility, files).
- [ ] A native fake island and `phone/e2e/run.mjs` in Edge and WebKit; later the same against the
  real Island.

## Track D: the phone site (`phone/web/**` except link, `phone/vite.config.ts`, `phone/tsconfig.json`, package.json `phone:*`)

- [ ] Vite config, tsconfig, `?demo` fake link with realistic frames.
- [ ] Screens: Add to Home Screen, pair (scan/paste), offline, the island (pill, bot, card/grid,
  back, bottom bar, toasts), PWA manifest + icons + service worker, `vercel.json` headers.
- [ ] Phase 2 UI: Send (files, text, paste), Clipboard, incoming text/files, Lock PC.
- [ ] Phase 3 UI: Notifications on/off, service worker push and click → `?open=<activity>`.
- [ ] Tests `test/phone-*.test.ts`; screenshots in headless Edge at 390×844.

## Integration (coordinating session)

- [ ] Real Island (debug build) + phone site in headless Edge and WebKit through n0: pair from
  Settings, pill and grid show, a tile tap acts, a fake permission card (island-hook test JSON) is
  answered from the phone, a file goes both ways.
- [ ] `npx vercel deploy` as project `islandphone` → https://islandphone.vercel.app; check the
  live site loads the wasm and pairs.
- [ ] Release build of Island.exe, swap it in (local only; Moss: "later", together with this).
- [ ] Docs: ARCHITECTURE › Phone, STATUS entry, README line, THIRD_PARTY_NOTICES.
- [ ] Moss on the iPhone: Add to Home Screen, pair, the phase 1–3 checks.
