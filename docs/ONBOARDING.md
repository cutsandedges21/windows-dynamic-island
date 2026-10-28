# First-run setup

A new install opens the Activities window on a full-window welcome page (`src/welcome.ts`), ten screens (nine on a Mac: no Workspaces yet; `welcomeSteps` in `src/core/onboarding.ts`). Settings › Startup › **Run setup again** opens it later. **Skip setup** ends it on any screen.

1. **Welcome.** What Island is, and what the next screens set up.
2. **Make it yours.** Where it sits (Top, Bottom, Left, Right), Colour (Black, White, Matte black, Matte white, Glass), Accent, Size, the bot, and **Start with Windows** (Open at login on a Mac). Each pick saves at once (`withLook`), so the real island changes while you choose; a little screen beside the choices shows the island where it sits, in its colour and accent, the bot beside it. Start with Windows is ticked on a first run (so the island and its reminders are always there) and applied when you leave the screen (`native.autostartSet`); run again, it shows what is set.
3. **What do you use this PC for?** School, Work, Coding, Gaming, Music and videos, Calls and meetings, Creating. Pick any.
4. **What do you want to see at a glance?** The tiles, ticked in advance from screen 3 (and Battery on a laptop). Weather asks for a city.
5. **Your AI, in the bot.** What the bot does with no model at all (reminders and notes in plain words: "remind me tomorrow 9am to call mom", "note: locker code 1234"), then this PC's processor, memory, graphics and free disk and every Local AI model as a card; the one `plan()` picks says **Recommended**. Clicking a card downloads it and makes it the model that answers. Skip leaves Local AI off.
6. **Your phone and Island.** First **Island on your iPhone, as an app**: the phone site (islandphone.vercel.app) as a QR code for the iPhone's Camera (`qr_code`, the same encoder as Land's share), the steps (open it, Share › Add to Home Screen, pair), and Settings › Your phone's own pairing section right there (Pair a phone, the code, paired phones). Then notifications on any phone through ntfy (a switch that makes the private topic, the steps, Send a test), and on Windows the phone's own notifications through Phone Link.
7. **Land: send files to anyone.** Set up on the spot: *Computers nearby* (Let computers nearby send me files, the name others see, and Windows Firewall checked with its one-click fix), *Friends anywhere* (Friends on other networks, your Land code with Copy, add a friend by code, Islands here to add without a code: Activities › Land's panel, `src/land-panel.ts`).
8. **Workspaces** (not on a Mac yet). What a workspace is; **Make my first workspace** finishes setup and opens Workspaces; **Notice what I work on** (off unless turned on).
9. **How to use your island.** Click it, point at it, right-click it, drop files on it, click the bot, tap Ctrl to see behind it, scroll on it, and the shortcut.
10. **You are all set.** A preview of the Control Center as the island will pack it, and Finish. Finish saves everything, opens the island on the new grid, and shows the Activities page.

The same model list, as rows with Use / Download / Resume / Cancel / Delete, sits in **Activities › Bot chat › Models** (`src/models-ui.ts`). Downloads run in Rust and carry on when the window closes. The pill shows their progress and says "Local AI is ready" at the end.

## How answers become activities

`src/core/onboarding.ts`, tested in `test/onboarding.test.ts`.

| Answer | Puts on the grid |
| --- | --- |
| Coding | Claude Code (only when Claude Code is on this PC), Local Servers |
| Gaming | Games |
| Calls and meetings | Mic & Camera |
| A glance tick | that activity's tile |
| A model picked on screen 4 | Local AI (on, no tile: the bot is its way in) |

Helpers stay switched on but off the grid unless picked: Sound, Downloads, Screenshots, Devices, Other apps, and Battery on a laptop. They still pop up for their events (the volume, a finished download, a USB drive). `grid.hidden` takes an activity id for this (`hiddenTest` in `src/core/grid.ts`), and "+" in grid edit mode brings such a tile back. Integrations with keys (GitHub, Vercel…) and Quick Actions keep whatever state they had. The grid order follows the answers; sizes and any arranged pages reset.

## First run

`settings.general.onboarded` (settings version 3). A new install starts with it off, and the island opens the welcome page at boot until Finish or **Skip setup**. Settings saved before version 3 belong to people who set Island up by hand, so the migration marks them as onboarded.
