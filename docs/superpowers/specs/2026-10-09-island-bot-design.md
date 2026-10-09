# Island's bot: a pet that lives beside the pill

Status: designed with Moss on 2026-10-09 (brainstorming, all four sections approved). Moss waived the written-spec review; build starts right away.

## Goal

A small, cute character that is always on screen, lives on the island, reacts to everything the island already knows about (music, volume, battery, network, Claude, timers…) and is the AI: click it to talk to the local model. Like Taby (a little character in the Mac notch), but Island's own.

## Decisions

| Question | Choice |
|---|---|
| Character | The bot that already exists (`src/fx/bot`, the bloub engine), body in the user's **Accent** colour, eyes dark or light for contrast |
| Where | Its **own round bubble beside the pill**, like iPhone's second island |
| Building approach | Bubble + bot engine + a costume layer + a pure mood brain |
| The AI | The bot **is** Local AI: click it to type to it. A **Local \| Claude** switch asks Claude instead; Ask Claude keeps its own tile too |
| Talking | Typing. Voice in or out may come later as its own step |

## 1. Look and place

- A round bubble as tall as the compact pill (36 px at Medium size; it follows the Size setting), the bot about 24 px inside it.
- **Left of the pill**, a small gap between them. With the island on the left or right screen edge, it sits **above** the pill.
- Always there, whatever the pill does: compact, expanded, or open on Control Center. When nothing is happening it sits next to today's small idle pill: tap the pill for Control Center, tap the bot to talk.
- The bubble wears the pill colour (Black, White, Matte black, Matte white, Glass). The bot's body is the accent (sky, ember, rose, mint, violet, gold, white or a custom colour); its eyes are dark on light bodies and light on dark ones. A white accent on a white pill turns dark, as `accentColor()` already does.
- Everyday life: breathes, blinks every 3 to 6 s, glances a little to the side now and then. Its eyes rest in the middle, looking at you; only a pointer within about 110 px of the bot pulls them, and only a little (Moss, while building: "it should be in the middle mostly").
- Hides with the island in full-screen apps (until the follow-up below changes that). Duplicate copies on other screens show the bubble too.
- Settings › Appearance › **Bot** (on by default). Off: no bubble, and the Local AI tile comes back to Control Center.

## 2. What it reacts to

Two layers: a **mood** that lasts while something is true, and **moments**, 2 to 4 s reactions played on top before it returns to the mood.

### Moods (one at a time, highest first)

| While… | The bot |
|---|---|
| Quiet (Do not disturb) is on | sleeps: eyes shut, slow breathing, "z z Z" drifting up |
| Something needs you (Claude asks, timer done, meeting starting now) | bounces for attention, blue dot on its head |
| Battery critical (≤10%) and not charging | drained: squashed, heavy eyelids, tiny red empty battery |
| Offline | lost: looks around, grey cloud with a slash |
| Mic or camera in use | on air: red dot, sits still and attentive |
| Music playing | vibing: headphones, happy eyes, sways, notes float up |
| A game running | gamer: tiny controller, eyes locked forward |
| Claude working, or the bot's own chat thinking | three pulsing dots |
| CPU or RAM maxed | overheated: sweat drops, heat squiggles |
| Downloading | a little arrow bobbing above it |
| Focus timer running | focused: narrowed eyes |
| Charging | lightning bolt above it, cosy glow |
| Battery low (≤20%) and not charging | tired: yawns now and then |
| Nothing | breathes, blinks, glances around, eyes follow the mouse; after 11 pm it yawns now and then |

### Moments (2 to 4 s)

| When… | The bot |
|---|---|
| Volume up | eyes widen, bounces up, sound waves pulse out (a bigger jump bounces higher) |
| Volume down | shrinks, eyes shut, "shh" in a tiny bubble |
| Muted | "shh" and a crossed-out speaker |
| Headphones or speaker switched | "ooh" eyes, the device icon pops up |
| New track | hops, burst of notes |
| Music paused / played | headphones slide down around its neck / back on |
| Plugged in | a bolt zaps into it, happy jolt |
| Unplugged | little shiver |
| Reaches 100% while plugged in | proud wink, full green battery, sparkles |
| Battery warning at 20% / 10% | yawn and sweat drop / shakes, red battery flash |
| Goes offline / back online | droops / perks up with wifi waves |
| VPN on / off | tiny sunglasses on / off |
| USB drive in / out | "ooh" with a plug / waves bye |
| CPU spike / RAM spike | sweats / dizzy swirl eyes |
| Call starts / mic muted | snaps attentive / "shh" with a crossed-out mic |
| Screenshot | camera flash, eyes squeezed shut |
| Copy | catches a tiny clipboard, nods |
| Download finished | catches a falling box, sparkle |
| Timer started / focus started / break started | determined look / narrowed eyes / big stretch |
| Timer done | jumps and rings like an alarm |
| Meeting soon | glances at a tiny clock |
| Rain coming | tiny umbrella, drops |
| Game launched | controller appears, ready stance |
| New local server | "ooh" with a `</>` tag |
| Good news (CI passed, workflow ran, email delivered, external item marked good) | cheers with confetti |
| Bad news (CI failed, email bounced, external item marked bad) | "!" and a shake |
| Warning (delivery delayed, booking cancelled) | worried, sweat drop |
| Info (new booking, review requested) | curious head tilt, blue dot |
| Payment received (Stripe) | a coin bounces in |
| Claude finishes / hits an error / limits reset | wink / "!" / big refreshed stretch |
| Island updated | "new!" sparkle |

### Rules

- Quiet mutes moments; the bot stays asleep. Urgent ones (Claude asks, timer done, battery critical) startle it awake briefly.
- Fast repeats merge: holding the volume key is one long bounce, not twenty.
- Windows "reduce motion": still poses only.

## 3. Talking to it

Changed while building (Moss: the island must not open, nor Control Center): talking happens in a **thin bar** of its own, option A of two mocked (B, the bot stretching into the bar, may come later; the bar's place is one function, `chatBarRect`).

- Click the bot: a thin bar appears under the bot and the pill, from the bot's left edge to the pill's right edge (on a side edge it reaches inward from beside the bot). The island itself does not change. Esc or a click elsewhere closes the bar and keeps the chat.
- The bot listens while you type, ponders (three pulsing dots) while the model thinks, bobs while it writes, and winks at the answer. The answer appears in a card past the bar, the bar's width: Copy, New chat, the model's name; the bar takes the follow-up.
- A **Local | Claude** switch in the bar. Local (Ollama, or Island's own model) is the default. Claude uses Ask Claude's backend choice (Claude Code login or API key), nothing new to set up. The card says which one answered. Follow-ups keep the same brain; a new chat starts on Local.
- No local model yet: clicking the bot shows "I need a brain first" with the recommended model, its download size and Set up, plus "Ask Claude instead" when Ask Claude can answer. While it downloads, the bot shows its downloading mood.
- It already gets what Island sees (time, music, battery, the window in front) in its system prompt; the prompt also tells it that it is the little bot on the user's island and to keep answers short and friendly.
- Control Center drops the Local AI tile while the bot is on. Ask Claude keeps its tile; the model picker stays in Activities › Local AI. The Claude Code pill goes back to its status dot and mark (the in-pill avatar and its Avatar option go away).

## 4. How it is built

| Piece | Job |
|---|---|
| `src/core/pet.ts` | The brain, pure: takes every activity's report and returns what the bot shows now (winning mood, moment on top). Priorities, durations, merging and the Quiet rules are data here. |
| `Activity.pet?()` | New optional method on the Activity contract (like `chip()`, `tile()`): each activity reports its own mood and latest moment. |
| `src/fx/bot/costumes.ts` + CSS | The costume layer: small SVGs (headphones, notes, zzz, "shh", bolt, sweat drops, umbrella, confetti…) animated with CSS transform and opacity only, so an always-visible bot stays cheap. |
| `src/fx/bot/looks.ts` | One table: every mood and moment → bot pose (a bloub state), costume and motion (sway, bounce, shiver, droop). |
| `src/core/bubble.ts` | The bubble on screen: its own springs riding beside the pill, holding the bot and costume, coloured by accent and pill colour. |
| Rust overlay poll | Sends the mouse position (about 20 per second) only while the pointer is near the bot, so its eyes can follow it. |

- `island.ts` places the bubble (`layout.ts` gets the bubble's rectangle for each anchor and level), publishes it as its own hit rectangle (`setHit` already takes several), sends a click on it to the chat, and puts the bot's look in Duplicate frames.
- Local AI becomes the bot's chat; its Claude switch reuses `pickBackend` and `bridge.askClaude` from Ask Claude.
- If something fails: a missing costume is skipped, no model shows the "I need a brain" card, the bot never blocks the pill.

### Testing

- Vitest: every mood and moment has a look and its costume exists; priorities; moment merging; the Quiet rules; the eye colour contrast; the bubble's place on all four edges and every level; each activity's `pet()` for its events; the chat's Local and Claude routes with a fake native layer.
- A browser preview page that plays every reaction, checked by screenshot in headless Edge.
- On the real overlay: volume, music and Quiet.

## Build order

1. The bubble with a living bot (accent colour, idle life, calm eyes, clicks, the Bot setting, Claude's pill back to its dot).
2. The chat (moved up while building: Moss was trying the click): the bar, Local AI moved into the bot, the Local | Claude switch, the setup card, the Control Center tile hidden.
3. Moods.
4. Every moment.
5. Follow-up (Moss, same day): the island always on top and always showing, full-screen apps and videos included. Exclusive full-screen games draw over every window, so nothing can show there; videos and borderless full-screen are fine.

## Later, not in this build

- Talking to it by voice, and it talking back.
- The bubble splitting off the pill like liquid (the unused goo filter in `src/fx/gooey.ts`); it would lose the Matte and Glass looks, so only as polish.
- A name for the bot ("Bot" for now).
