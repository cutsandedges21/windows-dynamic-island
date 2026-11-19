# Morning notes for Moss (night of 11-18 → 11-19)

Everything below is pushed to `main` (each step tested: tsc + Vitest, cargo test when Rust changed,
and checked in the dev preview with screenshots in `C:/tmp/island-scripts/night/`).
The exe you run was NOT rebuilt for each step (you said don't rebuild to check).

## Done
| # | Ask | Commit | Checked how |
|---|-----|--------|-------------|
| 1 | Window previews wait for the pointer to rest (½ s) | f4dfd78 | preview: hidden at 200 ms, up at 800 ms |
| 2 | Lock in place gone; taskbar always fixed; Edit position (right-click or Settings): drag, double-click to centre, stretch ends longer / inner edge taller, Reset size, Done | 7bc908f | preview: stretched 1.0 → 1.23 tall, longer with room after the apps |
| 3 | Rise also makes room (icons grow 1.6×, neighbours spread, bar widens from its middle) | 31878c6 | preview: bar 926 → 976 px while hovering |
| 4 | Names is its own style with Font (System, Clean, Serif, Mono, Handwritten), Look (Bubble, Plain, Outline), Bold | f4dfd78 | preview of all looks |
| 5 | Styles on their own card in Settings › Taskbar | f4dfd78 | Settings screenshot |
| 7 | Switches dimmer when on | f4dfd78 | Settings screenshot |
| 8 | No rectangle round the glass slider | f4dfd78 | CSS (focus ring removed) |
| 9 | Blend into the bottom + Auto-hide live inside Hide Windows' taskbar (only shown/active when it's on, at the bottom) | f4dfd78 | Settings screenshot |
| 10 | Above Windows' taskbar when it shows, at the very bottom when hidden | (already so: work area) + #9 | code read |
| 12 | Border + notches: own Look (or like the taskbar), Auto-hide, Blend into the edge (off = notches float), Melt the ends | 378109e | preview: floating notches, auto-hide opacity 0.12 |
| 13 | Land: Open button on a received file | 6e696b4 | unit test |
| 14 | Store apps (Calculator, Photos…) show Windows' real icon + name, not a blue square / "CalculatorApp" | 6e6b9d7 | live: Calculator → "Calculator" + its icon |
| 15 | Resting notch = the whole notch small, in proportion; hover look unchanged | 8c11807 | preview rest / hover |
| 17 | Music widget takes the album colour | cb34ac0 | preview with two colours |
| 18 | Notches: drag anywhere on either side (Edit position, Done, Back to the corner), or Always movable | 5321862 | preview drag |
| 19 | App search finds every app (157 on your PC, was ~45: Chrome, Notion, Discord… were missing) | 8417489 | live list on your PC |
| 11 | Tray icons on Island's taskbar (Island's own included); click, right-click, double-click go to the app; Explorer's tray keeps working (everything is passed on to it) | 8abde6a | live on your PC: read 7 icons (Island, Speakers, Bluetooth, Phone Link…) |
| 16 | Island's own Start menu from the bar's new Start button: search every app / the web / your files, Pinned (right-click to pin), All apps A–Z, Recommended (recent files), you, Documents, File Explorer, Settings, Power (Lock, Sign out, Sleep, Restart, Shut down). Settings › Taskbar: Start opens Island's or Windows'; "The Windows key opens it too" (off by default) | 903f0d7 | preview: home, search, All apps, black + white |
| new | Island bump: open card exactly the bar's width (no bump) | 8510056 | preview: 694/694 px |
| new | Notch light grows with the notch (no delay) | 0d99d0f | preview at 120 ms |
| new | White screen when closing a window from the taskbar (Notion/Discord hide to tray, Island restored them blank) | 0de12bb | code (couldn't reproduce with Explorer/Calculator) |

## Needs you
- **#6 right-click › Settings**: right now Settings and Activities both just open the Settings window. My suggestion: make Settings open a small quick-settings card inside the island (Do not disturb, Hide, Position, Look, taskbar on/off, All settings…) and drop Activities from the menu by default. Say yes/no.
- **A new exe is needed** to see the Rust parts (app search, close fix, Store app icons, border auto-hide, tray icons, Start menu). I didn't rebuild (you said not to rebuild to check, and stopping your running Island was blocked). To get everything: `npm run release`, then start `release/Island.exe`.
- **Start menu + Windows key**: I left "The Windows key opens it too" OFF by default. Turn it on in Settings › Taskbar if you meant the keyboard key.
- Not checked in the real app yet (needs the new exe): tray clicks, Start menu window placement over the bar, Edit position's window resizing, notch dragging across the screen.
