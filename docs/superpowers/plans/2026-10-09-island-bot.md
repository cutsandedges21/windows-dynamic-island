# Island bot Implementation Plan

> **For agentic workers:** executed inline in this session (Moss is on Pro: no subagents). Steps use checkbox (`- [ ]`) syntax for tracking. Code is written straight into the repo task by task (test first), not copied here, to keep token use lean; this plan fixes the files, interfaces, tests and checks.

**Goal:** the accent-coloured bot lives in its own bubble beside the pill, reacts to every event the island knows (moods + moments), and is the AI (click it to type to the local model, or switch to Claude).

**Architecture:** a pure brain (`src/core/pet.ts`) picks the bot's mood and moment from `Activity.pet()` reports; a look table maps them to a bloub pose, a costume and a motion; `src/core/bubble.ts` draws the bubble with its own springs beside the pill; Local AI becomes the bot's chat.

**Tech stack:** TypeScript (Vite, Vitest in node), Tauri 2 / Rust overlay poll, the bloub engine in `src/fx/bot`.

**Spec:** `docs/superpowers/specs/2026-10-09-island-bot-design.md`

---

## Interfaces (fixed here so every task agrees)

```ts
// src/core/pet.ts
export type MoodId =
  | 'listening' | 'pondering' | 'talking'            // the bot's own chat (above everything)
  | 'asleep' | 'needs-you' | 'drained' | 'offline' | 'on-air' | 'vibing' | 'gaming'
  | 'thinking' | 'overheated' | 'downloading' | 'focused' | 'charging' | 'tired' | 'idle';
export const MOOD_ORDER: readonly MoodId[]; // highest first, exactly the order above

export type MomentId =
  | 'volume-up' | 'volume-down' | 'muted' | 'audio-device'
  | 'track' | 'paused' | 'played'
  | 'plugged' | 'unplugged' | 'full' | 'battery-low' | 'battery-critical'
  | 'offline' | 'online' | 'vpn-on' | 'vpn-off' | 'usb-in' | 'usb-out'
  | 'cpu-spike' | 'ram-spike' | 'call-start' | 'mic-muted'
  | 'screenshot' | 'copy' | 'download-done'
  | 'timer-start' | 'focus-start' | 'break-start' | 'timer-done'
  | 'meeting-soon' | 'rain' | 'game-start' | 'new-server'
  | 'good-news' | 'bad-news' | 'warning' | 'info' | 'payment'
  | 'claude-asks' | 'claude-done' | 'claude-error' | 'limits-reset'
  | 'answered' | 'updated' | 'yawn';

/** A moment an activity saw. `key` merges repeats (holding volume = one moment); `at` orders them. */
export interface PetMoment { id: MomentId; key: string; at: number; strength?: number }
export interface PetSignal { mood?: MoodId | null; moment?: PetMoment | null }
export interface PetInput { signals: PetSignal[]; dnd: boolean; now: number; hour: number }
export interface PetFrame { mood: MoodId; moment: PetMoment | null; startled: boolean }
export const MOMENT_MS: Record<MomentId, number>;      // 2000 to 4000
export const URGENT_MOMENTS: ReadonlySet<MomentId>;    // claude-asks, timer-done, battery-critical
export class PetBrain { update(input: PetInput): PetFrame }

// src/core/activity.ts (Activity)
pet?(now: number): PetSignal | null;

// src/fx/bot/looks.ts
export type Motion = 'breathe' | 'sway' | 'bounce' | 'hop' | 'shiver' | 'droop' | 'shake' | 'tilt' | 'stretch' | 'jolt' | 'shrink' | 'still';
export interface PetLook { state: BotState; costume: CostumeId | null; motion: Motion }
export const MOOD_LOOKS: Record<MoodId, PetLook>;
export const MOMENT_LOOKS: Record<MomentId, PetLook>;
export function lookFor(frame: PetFrame): PetLook;

// src/fx/bot/costumes.ts
export type CostumeId = string; // one entry per drawing; COSTUMES: Record<CostumeId, { svg: string }>

// src/core/layout.ts
export function bubbleSize(size: IslandSize): number;           // heightFor('compact', size)
export const BUBBLE_GAP = 6;
export function bubbleRect(pill: Rect, anchor: Anchor, d: number): Rect;

// src/fx/bot/catalog.ts
export function botColors(accent: string): { body: string; eye: string }; // eye dark on light bodies, light on dark
```

## File map

| File | Change |
|---|---|
| `src/core/pet.ts` | new: the brain |
| `src/fx/bot/looks.ts`, `src/fx/bot/costumes.ts` | new: look table, costume drawings |
| `src/core/bubble.ts` | new: the bubble view (springs, bot, costume layer, eyes following the pointer) |
| `src/dev/pet.ts` | new: `/?pet` preview that plays every mood and moment |
| `src/core/layout.ts` | `bubbleSize`, `bubbleRect` |
| `src/core/island.ts` | bubble placement, hit rect, click → chat, brain feed, mirror frames |
| `src/core/mirror.ts` | draws the bubble on Duplicate copies |
| `src/core/activity.ts` | `pet?()` |
| `src/activities/*.ts` | each reports its mood and moments |
| `src/activities/local.ts` | the bot's chat: Local \| Claude, setup card, persona, tile hidden while the bot is on |
| `src/activities/claude/index.ts`, `src/activities/catalog.ts`, `src/core/segments.ts`, `src/core/renderer.ts` | the in-pill avatar removed (dot and mark back, `avatar` option and `bot` segment gone) |
| `src/core/settings.ts`, `src/app.ts` | `island.bot` + Settings › Appearance › Bot |
| `src/styles/island.css` | bubble, costume and motion styles; `.bubble-bg` joins the pill colour rules |
| `src-tauri/src/overlay.rs`, `src/core/native.ts` | `pointer` event near the island |
| tests | `test/pet.test.ts` (new), `test/layout-bubble.test.ts` (new), `test/fx-bot-avatar.test.ts`, `test/activities.test.ts`, `test/claude-island.test.ts`, `test/local.test.ts`, `test/platform.test.ts` |

## Slice 1: the bubble with a living bot

- [ ] **Task 1: take the avatar out of the pill.** Claude views lead with `dot` / `MARK` again (`face()`, `moodOf`, `moodOfAll` removed), the `avatar` option leaves the catalog and `Options`, the `bot` segment leaves `segments.ts` and `renderer.ts` (its skin observer moves to the bubble). Tests: the claude-island avatar block is replaced by "Claude views lead with the dot"; run `npx vitest run`, `npx tsc --noEmit`.
- [ ] **Task 2: the Bot setting.** `island.bot: boolean` (default true, checked in `migrate`), Settings › Appearance › "Bot" row ("A little bot beside the pill. Click it to talk to it."). Test in `test/engine.test.ts`: default true, a saved `false` survives, junk becomes true.
- [ ] **Task 3: where the bubble goes.** `bubbleSize`, `BUBBLE_GAP`, `bubbleRect` in `layout.ts`: top → left of the pill, top-aligned; bottom → left, bottom-aligned; left → above, left-aligned; right → above, right-aligned. Test `test/layout-bubble.test.ts`: all four anchors at idle and maximum sizes, never overlapping the pill, always the gap apart.
- [ ] **Task 4: the bot's colours.** `botColors(accent)`: body = accent; eye `#17120e` when the body's relative luminance > 0.35, else `#fbf3e6`. Tests: sky, gold, white get dark eyes; `#1c1c1e` (white accent on a white pill) gets light eyes.
- [ ] **Task 5: the bubble view.** `BubbleView` in `src/core/bubble.ts`: `.bubble > .bubble-bg + .bubble-bot (BotAvatar) + .bubble-costume`; springs x, y, o, s; `place(rect, {immediate, hidden})`, `colours(accent)`, `lookAt(point | null)` (engine `setLook`: yaw/pitch from the vector to the pointer, mix 1, wander 0; null → mix 0, wander 1), `onClick(cb)`, `onHover(cb)`; idle life: CSS breathe, the engine's blinks, a small random glance every 8 to 20 s when no pointer is near. CSS: `.bubble`, `.bubble-bg` added to every `:is(.pill-bg, .sheet-bg)` colour rule, glass shadow.
- [ ] **Task 6: the island places it.** In `compose`: `bot = settings.island.bot`; the bubble's target comes from the *untucked* pill rect (`pillRect` of the current size) so it stays when the idle pill hides; it hides only when the bot is off, while moving between screens, or when the island hides in full screen. `publishHit` adds the bubble rect. The document `pointerdown` dismiss ignores `.bubble`. A click sends `island:bot` (Task 14 wires it to the chat; until then it opens Local AI's `ask`). `MirrorFrame` gets `bot: { rect, accent } | null`; `mirror.ts` draws a non-interactive `BubbleView`.
- [ ] **Task 7: eyes follow the mouse.** `overlay.rs`: when `gap <= 220` px emit `pointer` `{x, y}` (CSS px in the window), at most every 50 ms and only when it moved; once `null` when it goes beyond. `native.ts`: `on('pointer')` typing; the browser mock forwards `pointermove` on the window. Island → `bubble.lookAt`. `cargo test --lib`, `cargo clippy` (no new warnings).
- [ ] **Check and commit:** tsc, Vitest, cargo test; `/?fill` preview in headless Edge on all four anchors and the white pill; commit "Bot: its own bubble beside the pill".

## Slice 2: moods

- [ ] **Task 8: the brain.** `src/core/pet.ts` as fixed above. `PetBrain.update`: the winning mood is the first of `MOOD_ORDER` any signal reports (`dnd` adds `asleep`, nothing → `idle`); a moment newer than the one playing replaces it, the same key extends it (merge, no restart), it ends after `MOMENT_MS`; in Quiet only `URGENT_MOMENTS` play and set `startled`; after 23:00 and before 05:00 an idle bot gets a `yawn` moment every 2 to 4 minutes. Tests `test/pet.test.ts`: order, Quiet, merge, expiry, startle, yawn timing (injected clock).
- [ ] **Task 9: looks and costumes for moods.** `MOOD_LOOKS` (asleep → sleep pose + `zzz` + breathe; needs-you → notify + bounce; drained → idle + `battery-empty` + droop; offline → idle + `cloud-off` + tilt; on-air → wide + `rec` + still; vibing → wink pose + `headphones` + `notes` + sway; gaming → wide + `controller`; thinking/pondering → thinking; talking → idle + bounce; overheated → idle + `sweat` + shiver; downloading → idle + `arrow-down`; focused → idle + `tomato`; charging → idle + `bolt` + breathe; tired → idle + `yawn` breath; listening → wide; idle → idle + breathe). Costume drawings in `costumes.ts`, keyframes in `island.css` (transform and opacity only; `.reduce` disables them). Test (`test/fx-bot-avatar.test.ts`): every mood and moment has a look; every costume a look names exists.
- [ ] **Task 10: activities report moods.** `pet()` on music, game, claude, ask, local, system, downloads, timer, calendar, calls, network, battery. Tests in `test/activities.test.ts` for music (vibing while playing), battery (charging, tired ≤20, drained ≤10), network (offline), timer (focused, needs-you when done).
- [ ] **Task 11: the island feeds the brain.** Each `compose` (and the 1 s tick) collects `pet()` from running activities, adds Quiet, runs `PetBrain`, and hands `lookFor(frame)` to the bubble (state via `setState`, costume swap, motion class). `/?pet` preview lists every mood and moment as buttons and plays them. Screenshots of every mood in headless Edge. Commit "Bot: moods".

## Slice 3: moments

- [ ] **Task 12: activities report moments.** sound (volume up/down with strength, muted, device), music (track, paused, played), battery (plugged, unplugged, full at 100% while plugged, low and critical warnings), network (offline, online, vpn on/off), devices (usb in/out), system (cpu and ram spikes), calls (call start, mic muted), screenshots, clipboard, downloads (done), timer (start, focus, break, done), calendar (soon), weather (rain), game (start), servers (new port), integrations base (good/bad/warning/info by tone; Stripe payment → payment), external (by tone), claude (asks, done, error, limits reset), local (answered), island (updated, from the updater's notice). Tests for sound, battery and integrations.
- [ ] **Task 13: moment looks.** `MOMENT_LOOKS` per the spec table (sound waves, shh bubble, crossed speaker, device pop, notes burst, headphones down, zap, shiver, full battery + sparkle, yawn + sweat, red battery flash, wifi waves, sunglasses, plug, wave, sweat, swirl eyes, rec, crossed mic, camera flash, clipboard, box, determined, stretch, alarm, clock, umbrella, controller, `</>`, confetti, bang + shake, worried sweat, tilt + dot, coin, wink, refreshed stretch, "new!" sparkle). Preview screenshots of every moment. Commit "Bot: moments".

## Slice 4: the chat

- [ ] **Task 14: Local AI is the bot.** With `island.bot` on: Local AI's `tile()` returns null, `home()` returns nothing; `island:bot` makes Local AI primary and runs `ask` (or `setup` card when no model); compose placeholder "Ask me anything…"; card head icon `bot` (new icon in `icons.ts`), title "Bot", sub = model; the system prompt gains "You are the little bot that lives on the user's island…". Tests in `test/local.test.ts`.
- [ ] **Task 15: Local | Claude.** A `brain` chip in the compose row toggles `local` / `claude`; `claude` sends through `pickBackend(askOptions.backend, await bridge.askBackends())` + `bridge.askClaude`; the card sub says "via Claude"; follow-ups keep the brain; `new` resets to local. Tests with a fake bridge.
- [ ] **Task 16: no model yet.** The bot's click shows a "I need a brain first" card: recommended model, download size, Set up; "Ask Claude instead" when a backend exists. Tests.
- [ ] **Check, commit, docs:** tsc, Vitest, cargo; preview; rebuild `release/Island.exe` and restart Island; on the real overlay try volume, music and Quiet; STATUS entry, ARCHITECTURE (bot section), memory. Commit "Bot: the chat".

## Slice 5: follow-up, always on top

- [ ] **Task 17:** the island always showing, full-screen apps and videos included: `hideInFullscreen` defaults off and is turned off once for existing settings (settings version bump), and the overlay re-asserts topmost when a full-screen window comes to the front. Check with a browser video in full screen (screen capture). Commit.
