# Island

A spring-animated pill at the edge of your Windows screen that shows what is happening right now: Claude Code sessions (with Allow/Deny and Continue Session right in the pill), music, downloads, timers, screenshots, the clipboard, your mic and camera, and system events.

## Run it

1. Double-click `release\Island.exe` (portable), or run the installer next to it.
2. The island appears at the top centre of your main display.
3. Right-click the island for positions, Do not disturb and Activities. The tray icon has the same, plus your Claude sessions.

## Use it

| Do | What happens |
|---|---|
| Hover the island | It grows a little to show more |
| Click it | It opens to its widest |
| Click anywhere else | It goes back to its resting size |
| Scroll on it | Cycles between the things that are happening |
| Right-click it | Positions (top, right, bottom, left), Quiet, Activities, Settings |
| `Alt+Shift+Space` | Open or close the island |
| `Alt+Shift+A` | Activities window |
| `Alt+Shift+1`–`9`, `Alt+Shift+0` | Switch to a Claude session / the one that needs you (if Usage Clip isn't holding them) |

On the left or right edge the island stands vertical. Text stays upright.

## Claude Code

Everything Usage Clip shows is here: plan limits with the pace tick, tokens this week, every running session with its status, closed chats (reopen them), and Claude app chats. Usage Clip's readings are reused while it runs, so the two apps don't fight over the usage API.

Turn on the hooks for the rest: **Activities › Claude Code › Install hooks…**. You see the exact change to `%USERPROFILE%\.claude\settings.json` first, a dated backup is made, and your own hooks stay. Then:

- **Permission requests** show in the island with **Deny / Allow**. Clicking outside the island hands the question back to the terminal.
- **Claude finished** shows with **Continue**. Type your next prompt in the pill and it goes to the same session:
  - editor chats (VS Code, Cursor, Windsurf) open with your prompt through the extension's own link;
  - terminal chats get the prompt typed into their console;
  - closed chats resume with `claude --resume` in a minimized console, and show up live again.

## Activities

**Activities** (tray, right-click menu, or `Alt+Shift+A`) is where you choose what the island shows. Drag cards between High, Medium, Low and Available, flip behaviours (Auto-show, Persistent, Interactive, Interrupt), and drag the three width handles to resize the island live.

Other programs can push their own activities: see `docs/ACTIVITY-API.md`.

## Build it

```sh
npm install
npm test               # Vitest: engine + Usage Clip's own tests on the copied logic
npm run dev            # the island in a normal browser with demo data
npm run app            # the real app with live reload
npm run release        # release\Island.exe and the installer
```

The Rust build cache goes to `%LOCALAPPDATA%\windows-dynamic-island\target`, outside OneDrive. Logs: `%LOCALAPPDATA%\Island\island.log`.

More: `docs/ARCHITECTURE.md` (how it works), `docs/SPEC.md` (the product spec), `docs/STATUS.md` (build log).
