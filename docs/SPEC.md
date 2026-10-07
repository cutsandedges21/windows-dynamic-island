# Windows Dynamic Island App — Complete Product Specification

Moss's product spec, saved verbatim from the build request on 2026-09-30. The
request also said: "incorporate the same features as claude-session-monitor
(Usage Clip) into the Claude portion of this project".

---

You're building a **Windows-only desktop application inspired heavily by Apple's Dynamic Island and Control Center**.

The goal is not to make a clone of one specific Apple feature. The goal is to take the **visual language, fluidity, spatial behavior, and interaction quality** of Apple's Dynamic Island and turn it into a genuinely useful system-wide experience for **any laptop owner**.

The app should feel extremely polished, responsive, fluid, and intentional. It should not feel like a random Windows utility sitting on top of the desktop.

---

# 1. Core Concept

The application has a persistent **horizontal pill-shaped Island** that sits along one edge/center of the display.

It can show information and interactions from different things happening on the computer.

Examples:

- Claude Code is working
- Music is playing
- A download is progressing
- A timer is running
- A screenshot was taken
- A call is active
- Battery is low
- A USB device was connected
- A file is transferring
- A calendar event is approaching
- CPU usage suddenly spikes
- A permission request needs attention

The Island intelligently decides what deserves to appear based on:

- whether an activity is currently happening
- activity priority
- whether the activity is enabled
- whether it should automatically surface
- how much space is available
- what other activities are currently active

The fundamental idea is:

> **The Island is an activity surface, not a notification bar.**

---

# 2. It Must Always Remain a Pill

Even at its largest size, the Island **must remain a horizontal pill**.

It should never become:

- a rectangular dashboard
- a floating window
- a giant notification panel
- a Control Center clone
- a sidebar

The maximum state can contain substantially more information, but the visual container remains a pill.

For example:

**Compact**

`● Claude Working`

**Expanded**

`● Claude Code  |  Working…  |  12m`

**Maximum**

`● Claude Code  |  Working…  |  Implementing UI  |  12m 43s`

The container itself continuously morphs between these states.

---

# 3. Responsive Widths

There should be **three Island width levels**:

- Compact
- Expanded
- Maximum

But these should **not use fixed pixel dimensions**.

The widths should be percentages of the usable display width.

Suggested defaults:

- Compact: roughly **10–14%**
- Expanded: roughly **22–30%**
- Maximum: roughly **40–50%**

These are defaults rather than hardcoded limits.

Users should be able to configure the widths.

The actual dimensions should adapt to:

- monitor resolution
- display size
- Windows scaling/DPI
- available work area
- selected monitor

So a 40% maximum Island on one monitor should naturally be different in physical size from a 40% Island on another monitor.

---

# 4. Four Possible Positions

The user can choose where the Island lives.

### Top Center

The Island sits at the top-center of the display. When it expands, it expands **downward**.

### Left Center

The Island sits around the vertical center of the left side. When it expands, it expands **to the right**.

### Right Center

The Island sits around the vertical center of the right side. When it expands, it expands **to the left**.

### Bottom Center

The Island sits at the bottom-center. When it expands, it expands **upward**.

It must account for the actual Windows work area and taskbar.

It should **not assume the taskbar is always at the bottom**.

---

# 5. Orientation Does Not Change the UI

The Island remains fundamentally the same component regardless of position.

There should **not** be a Top / Bottom / Left / Right Island implementation.

Instead, there should be **one Island engine** that understands:

- its anchor position
- its expansion direction
- its available space
- its current width
- its current activity state

The expansion direction changes, but the underlying animation system remains the same.

- Top → downward
- Bottom → upward
- Left → right
- Right → left

### Text is always upright.

If the Island is on the left or right side of the screen, the text does **not rotate**. It remains a normal horizontal UI.

---

# 6. Position Changes Should Also Animate

Changing the Island's position should not teleport it.

For example: Top → Right should cause the Island to **smoothly move to the right-side position**, using the same spring-like physical behavior as its other animations.

The entire object should feel like one physical thing moving through space.

---

# 7. The Island Should Morph as One Object

The UI should not feel like: small pill disappears → large pill appears.

Instead: the same physical object expands.

The edges should move. The content should rearrange. Icons should transition. Text should fade/morph appropriately. Spacing should interpolate. The shape should continuously change.

The entire interaction should feel like one object responding to the user.

---

# 8. Animation Philosophy

The app's animation quality is part of its identity. It should feel **extremely smooth**, similar to Apple's Dynamic Island and Control Center.

The animations should use:

- spring-like motion
- smooth interpolation
- natural acceleration/deceleration
- spatial continuity
- content morphing
- fluid reordering
- smooth resizing
- GPU-accelerated rendering where possible

The system should not rely on crude "change width → wait → change content" animations. Everything should be interpolated continuously.

---

# 9. JavaScript/TypeScript-Heavy

Preferred stack: **Tauri 2 + Rust + TypeScript**

Rust exists primarily for the Windows/native layer. TypeScript owns most of the actual product.

### Rust/native layer

Windows integration, native system information, Windows events, process integration, Claude Code communication, IPC, display information, work-area information, DPI/scaling, transparent always-on-top windows, other OS-level functionality.

### TypeScript layer

UI, Island, animations, layout, Activities, state, activity prioritization, transitions, Claude UI, music UI, settings, Activities page, interaction, module system.

The Rust layer should stay relatively thin. The product itself should primarily live in TypeScript.

---

# 10. Architecture

**Island Engine** (Position, Width, Activities) → **Layout Engine** → **Animation Engine** → **Rendered Pill**

The Island engine determines what should happen. The layout engine determines where everything belongs. The animation engine determines how it gets there. The rendered pill is the final visual result.

---

# 11. Core Application Structure

- **Core**: Island Engine, Animation Engine, Layout Engine, Event Bus, Priority Manager, Session Manager
- **Activities**: Claude, Music, Battery, Downloads, Timer, Weather, Calendar, System, Clipboard
- **Components**: Island, Pill, Activity, Activity Switcher, Overflow, Claude Input
- **Pages**: Activities, Settings
- **Native**: Claude hooks, Windows events, system integration

---

# 12. The Fundamental Abstraction: Activities

The system is built around the concept of an **Activity** — not widget, notification, application or shortcut.

An Activity represents something that is happening **now** and can potentially be surfaced through the Island (Claude is working, Spotify is playing, a download is happening, a timer is running, a call is active, a file transfer is happening).

The Island engine doesn't need to care what the Activity represents. It asks:

- Is it active?
- Is it enabled?
- How important is it?
- What should it look like compact / expanded / at maximum?
- What actions does it support?
- What events does it respond to?

---

# 13. Activity Structure Concept

Each Activity needs: unique ID, priority, enabled/disabled state, compact representation, expanded representation, maximum representation, events, actions. Every Activity follows the same contract so Claude Code, Music, Battery, Timer, Downloads, etc. all plug into the same Island system.

---

# 14. Activity Manager

A dedicated section where users control what appears on the Island. Not called Settings. Name: **Activities** (alternative: Island).

---

# 15. Activities UI

Feels somewhat like Apple Control Center customization.

- **Active**: Claude Code, Music, Battery, Downloads, Timer
- **Available**: System Stats, Weather, Calendar, Clipboard, Network

Users can enable, disable, reorder, drag, change priority, configure behavior, decide what gets surfaced.

---

# 16. Drag-and-Drop Must Be Extremely Fluid

If the user grabs Claude Code and moves it above Music, the other activities **fluidly move out of the way** — no instant snapping. The interaction should feel physical. Same for moving, removing, inserting, changing order, changing width. Like Apple Control Center.

---

# 17. Activity Priority

Examples: Claude Code → High, Calls → High, Downloads → Medium, Music → Low, Battery → Low, Weather → Low.

Music is playing. Then a download starts. Then Claude requests permission. The Island temporarily prioritizes Claude's permission request; after the interaction it returns to the download or music activity.

---

# 18. Context-Aware Island

Surface what is relevant **right now**:

1. Music starts → Island shows music
2. Headphones connect → Island briefly reflects the connection
3. A download begins → download becomes visible
4. Claude Code starts working → Claude becomes the primary activity
5. Claude asks for permission → permission UI takes priority
6. Claude finishes → Island shows completion
7. Island returns to whatever was previously active

---

# 19. Space Budget

The Island has a maximum width and never keeps expanding because too many activities are enabled: `Claude | Music | Battery | ⋯`. The rest go into an overflow menu; clicking `⋯` reveals the other active activities. Customization should never destroy the pill.

---

# 20. Width Resizing

The three width levels are interactively configurable: the user drags a control between the configured width levels. As the width changes the pill continuously morphs, content rearranges, spacing changes, text adapts, components transition. It does not jump between presets.

---

# 21. Claude Code Integration

A major flagship integration, but **not the identity of the application**. Useful to normal laptop users even without Claude Code.

---

# 22. Reusing the Existing Claude Implementation

Reference: **Coucou** — `Louis-CFM/coucou` (Tauri 2, Rust, TypeScript, Claude Code hooks, Windows support, transparent always-on-top UI, named-pipe communication, Claude Code session handling). MIT licensed code may be reused; the Mochi character, sounds, media and related assets are restricted and must not be copied. Reuse appropriate technical code and concepts; build our own product and visual identity.

---

# 23. Claude Code Inside the Island

**Continue Claude Code sessions directly from the Island.**

Compact `● Claude Code Working…` → Expanded `● Claude Code | Working… | 12m` → Maximum `● Claude Code | Working… | Implementing UI | 12m 43s`.

When Claude finishes: `✓ Claude finished | Continue Session`. The user presses Continue Session, the Island transforms into an inline input, the user types the next prompt and sends it, Claude resumes the same session. The user never leaves what they're doing.

---

# 24. Claude States

idle, thinking, writing, running command, waiting for input, permission required, error, completed.

# 25. Claude Information

project, session, current operation, elapsed time, recent activity, current tool, status, completion, errors, permission requests.

# 26. Multiple Claude Sessions

Support multiple simultaneous sessions (Schedule Matcher, Mossimo Studios, NASA project…). Compact indicator `Claude ×3`; expanded lets the user pick: Schedule Matcher — Working, Mossimo — Waiting, NASA — Running.

# 27. Claude Permission Requests

Appear directly inside the Island with Allow / Deny, without switching windows.

# 28. Claude Completion

`✓ Claude finished` with **Continue Session**.

# 29. Optional Terminal Fallback

The Island can still open the terminal/session normally.

---

# 30. System Activities

Battery, Volume, Brightness, Bluetooth, Wi-Fi, Downloads, File transfers, Screenshots, Clipboard, Notifications, USB devices — native parts of the Island.

# 31. Communication Activities

Calls, Discord, Microsoft Teams, messages, microphone, camera. Inline actions where technically possible: mute, unmute, answer, decline, reply, camera toggle.

# 32. Productivity Activities

Timer, Stopwatch, Focus mode, Calendar, Reminders, Weather. `🍅 Focus | 18:42`, `Calendar | Meeting in 10m`.

# 33. Media Activities

Currently playing media, title, artist, album, progress, play/pause, previous, next, volume. Spotify, YouTube, Apple Music, local media — through Windows media controls rather than per-app integrations. `🎵 SICKO MODE | ━━━━━ | ▶`

# 34. Developer Activities

Terminal processes, Git status, build status, local servers, CPU, GPU, RAM, temperature. `CPU 42% | RAM 11.4GB | GPU 67% | 64°C` — but not constantly.

# 35. Event-Driven System Stats

Normally quiet; CPU suddenly spikes to 100% → the Island surfaces it. Users who want constant stats can enable that.

# 36. Network Activities

Download/upload speed, latency, VPN status, Wi-Fi state, connection drops, active transfers. `↓ 82 MB/s | ↑ 12 MB/s`, `Downloading project.zip | 64%`.

# 37. Clipboard Activity

`Copied: https://...` — recopy, reopen clipboard history, inspect.

# 38. Screenshot Activity

`Screenshot captured` — Copy, Open, Edit, without a giant notification.

# 39. Downloads and File Transfers

`↓ project.zip | 64% | 2m` — expanded shows file name, percentage, speed, remaining time, source, pause/cancel where supported.

# 40. Quick Actions

Optional: mute, focus, screenshot, Bluetooth, Wi-Fi, lock. Not a full OS control panel.

# 41. Optional AI Command Surface

Possible future feature ("How much longer is my download?", "Start a 25 minute timer"). Not central; the core works without it.

# 42. Activities Should Eventually Be Extensible

Design for third-party/user-created Activities — an Activity API / Plugin API. The Island engine loads Activities that follow the Activity system.

# 43. Settings Are Separate From Activities

**Activities** controls what appears, enabled, order, priority, behavior, automatic surfacing, activity-specific options. **Settings** controls appearance, behavior, startup, privacy, notifications, keyboard shortcuts, about, other global configuration.

# 44. Activity Behavior Controls

Auto-show, Persistent, Interactive, Interrupt, Priority.

# 45. Multi-Monitor Support

Primary display, current display, specific display, follow active display. Understand each monitor's resolution, DPI/scaling, usable work area, taskbar location, orientation, boundaries.

# 46. Windows Work Area

The bottom-center Island sits **above the actual taskbar/work-area boundary**, wherever the taskbar is.

# 47. Rendering Performance

JavaScript orchestrates state and behavior; the WebView's rendering system and GPU handle expensive visual work. Avoid unnecessary DOM manipulation, layout recalculation, reflows, repaint-heavy effects, excessive state updates.

# 48. The Animation Engine Should Be Universal

It understands position, size, expansion vector, interpolation, spring behavior, opacity, spacing, content transitions — and drives the whole product.

# 49. Orientation-Agnostic Layout

An orientation/expansion vector, not four implementations. The UI itself remains horizontal.

# 50. Island as a Physical Object

It expands, contracts, moves, reorders, changes content, gains and loses priority, changes position — always the **same object**.

# 51. Example Full User Experience

Compact `●` → music starts `🎵 SICKO MODE` → settles to compact music → download `↓ project.zip | 12%` → Claude `● Claude Working…` → user expands `● Claude Code | Working… | Building UI | 3m` → permission `Claude Code | Allow command? | Allow | Deny` → Allow → `✓ Claude finished | Continue` → inline input → Claude resumes → back to download/music.

# 52. The Product Should Work Without Claude

Not "Claude Code Dynamic Island for Windows" but **a universal activity layer for Windows laptops**.

# 53. Apple Inspiration

Dynamic Island, Control Center, Apple's animation quality, spatial continuity, simplicity, interaction design — with its own identity.

# 54. Core Design Principles

1. One physical object
2. Never become a dashboard
3. Responsive sizing
4. Orientation independent
5. Text always stays upright
6. Context-aware
7. Activity-based
8. User controlled
9. Fluid customization
10. Native integration
11. TypeScript-first product layer
12. Extensible
13. Claude as a flagship, not the identity
14. Performance is a feature

# 55. The Overall Vision

A **Windows activity layer** that sits quietly on the desktop until something meaningful happens — Claude interface, music controller, download tracker, timer, call controller, screenshot notification, system monitor, productivity surface, network indicator, notification/action surface — all expressed through the **same persistent pill**.

**Activities → Priority → Layout → Animation → Island**, with **Tauri 2 + Rust + TypeScript** as the Windows foundation and a spring-driven UI as the experience.
