# Island

A spring-animated pill at the edge of your screen that shows what is happening right now: Claude Code sessions (with Allow/Deny and Continue Session right in the pill), music, downloads, timers, screenshots, the clipboard, your mic and camera, and system events. Windows and Mac.

**[Download Island.exe](https://github.com/cutsandedges21/windows-dynamic-island/releases/latest/download/Island.exe)** for Windows · **[Download Island.dmg](https://github.com/cutsandedges21/windows-dynamic-island/releases/latest/download/Island.dmg)** for Mac (Apple silicon and Intel) · always the newest version

## Run it on Windows

1. Download `Island.exe` (link above) and double-click it. That one file is the whole app: no installer, nothing else to download, and it keeps itself up to date (Settings › Startup › Update automatically). The exe is not code-signed, so the first time Windows may say it protected your PC: click **More info › Run anyway**.
2. The island appears at the top centre of your main display. The first time, a short setup asks what you use the PC for, fills the Control Center from your answers, and offers a Local AI model picked for your PC's memory and graphics (`docs/ONBOARDING.md`). Settings › Run setup again repeats it.
3. Right-click the island for positions, Do not disturb and Activities. The tray icon has the same, plus your Claude sessions.

## Run it on a Mac

1. Download `Island.dmg` (link above), open it and drag **Island** to **Applications**.
2. Open Island. The first time, macOS blocks it, because Island isn't notarized by Apple yet: open **System Settings › Privacy & Security**, scroll down to **Security**, click **Open Anyway** next to Island, and confirm. If macOS says instead that Island "is damaged", run `xattr -cr /Applications/Island.app` in Terminal once, then open it again.
3. When macOS asks whether Island may find devices on your local network, allow it: Land needs it to reach your other computers.

The island sits under the menu bar. On a Mac it has Land, the bot and its chat, timers, weather, your calendar, downloads, and GitHub, Vercel and Notion; Claude Code, music, system stats and the rest are coming in the next versions. A Mac doesn't update Island by itself yet: download the new `Island.dmg` for each version.

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

On Windows (coming to the Mac). Everything Usage Clip shows is here: plan limits with the pace tick, tokens this week, every running session with its status, closed chats (reopen them), and Claude app chats. Usage Clip's readings are reused while it runs, so the two apps don't fight over the usage API.

Turn on the hooks for the rest: **Activities › Claude Code › Install hooks…**. You see the exact change to `%USERPROFILE%\.claude\settings.json` first, a dated backup is made, and your own hooks stay. Then:

- **Permission requests** show in the island with **Deny / Allow**. Clicking outside the island hands the question back to the terminal.
- **Claude's questions** show in the island when you're not looking at that chat: tap the answers and Claude carries on (in the terminal and in VS Code). Switch to the chat and it asks there instead.
- **Claude finished** shows with **Continue**. Type your next prompt in the pill and it goes to the same session:
  - editor chats (VS Code, Cursor, Windsurf) open with your prompt through the extension's own link;
  - terminal chats get the prompt typed into their console;
  - closed chats resume with `claude --resume` in a minimized console, and show up live again.

## Activities

**Activities** (tray, right-click menu, or `Alt+Shift+A`) is where you choose what the island shows. Drag cards between High, Medium, Low and Available, flip behaviours (Auto-show, Persistent, Interactive, Interrupt), and drag the three width handles to resize the island live.

Click the **bot** beside the pill to ask it anything: **Local** answers with a model on this PC (offline), **Claude** with Claude Code or an API key (**Activities › Bot chat**). **Bot chat › Models** lists this PC's specs and every model Island can download, with the one that suits the PC marked Recommended: download, switch, cancel or delete them there.

Other programs can push their own activities: see `docs/ACTIVITY-API.md`.

## Your phone

- **Island → phone.** Settings › Notifications › **Send to my phone** sends the island's notifications, plus Claude Code's finished turns, errors, questions and permission requests, to the free **ntfy** app (iPhone and Android). Install ntfy, tap **+**, paste the topic Island shows, Subscribe, then **Send a test**. The text goes through ntfy.sh, and anyone with the topic can read it, so keep it private.
- **Answer from the phone.** With **Answer Claude from my phone** on, Claude Code's permission pushes carry **Allow** and **Deny** buttons that answer on the PC.
- **Files to any phone.** Drop files on the island (or paste a link or a note in Land's card), then **Send to a phone**: scan the QR code with the phone's camera and save them from its browser. Same Wi-Fi only, for 15 minutes.
- **Phone → island.** Pair your phone once in Windows' **Phone Link** app; the **Phone** activity then shows its notifications on the island (sender and text). Windows only.

## Land

Send files, links and notes to your other computers, to friends on any network, and to any phone, like AirDrop. **Land** is the little icon at the end of the pill: click it for its card, drop files on the island, or copy something (files, a link, a note), hover the icon and press **Ctrl+V** (**Cmd+V** on a Mac): Land opens with it, ready to send. The other side accepts first, and everything is encrypted on the way. Friends: Activities › Land › Your Land code.

## Build it

```sh
npm install
npm test               # Vitest: engine + Usage Clip's own tests on the copied logic
npm run dev            # the island in a normal browser with demo data
npm run app            # the real app with live reload
npm run release        # release\Island.exe, the one file to hand out (the hook relay is built into it)
```

The Mac `.dmg` is built by GitHub Actions (`.github/workflows/macos.yml`) on every push; a Mac can't be built on Windows.

The Rust build cache goes to `%LOCALAPPDATA%\windows-dynamic-island\target`, outside OneDrive. Logs: `%LOCALAPPDATA%\Island\island.log`.

More: `docs/ARCHITECTURE.md` (how it works), `docs/SPEC.md` (the product spec), `docs/STATUS.md` (build log).
