# First-run setup

A new install opens the Activities window on a full-window welcome page (`src/welcome.ts`) with five screens. Settings › Startup › **Run setup again** opens it later.

1. **Welcome.** What Island is, in three lines.
2. **What do you use this PC for?** School, Work, Coding, Gaming, Music and videos, Calls and meetings, Creating. Pick any.
3. **What do you want to see at a glance?** Eleven tiles, ticked in advance from screen 2 (and Battery on a laptop). Weather asks for a city.
4. **Your own AI, on this PC.** This PC's processor, memory, graphics and free disk, then every Local AI model as a card. The one `plan()` picks for this PC says **Recommended**. Clicking a card downloads it and makes it the model that answers. Models too big for this PC are greyed out with what they need. Ollama's models, when Ollama runs, are listed below with **Use**. Skip leaves Local AI off.
5. **You are all set.** A preview of the Control Center as the island will pack it, and Finish. Finish saves everything, opens the island on the new grid, and shows the Activities page.

The same model list, as rows with Use / Download / Resume / Cancel / Delete, sits in **Activities › Local AI › Models** (`src/models-ui.ts`). Downloads run in Rust and carry on when the window closes. The pill shows their progress and says "Local AI is ready" at the end.

## How answers become activities

`src/core/onboarding.ts`, tested in `test/onboarding.test.ts`.

| Answer | Puts on the grid |
| --- | --- |
| Coding | Claude Code, Ask Claude (only when Claude Code is on this PC), Local Servers |
| Gaming | Games |
| Calls and meetings | Mic & Camera |
| A glance tick | that activity's tile |
| A model picked on screen 4 | Local AI |

Helpers stay switched on but off the grid unless picked: Sound, Downloads, Screenshots, Devices, Other apps, and Battery on a laptop. They still pop up for their events (the volume, a finished download, a USB drive). `grid.hidden` takes an activity id for this (`hiddenTest` in `src/core/grid.ts`), and "+" in grid edit mode brings such a tile back. Integrations with keys (GitHub, Vercel…) and Quick Actions keep whatever state they had. The grid order follows the answers; sizes reset.

## First run

`settings.general.onboarded` (settings version 3). A new install starts with it off, and the island opens the welcome page at boot until Finish or **Skip setup**. Settings saved before version 3 belong to people who set Island up by hand, so the migration marks them as onboarded.
