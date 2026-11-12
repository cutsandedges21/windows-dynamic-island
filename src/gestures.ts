// Every gesture the island answers to, in words, for the Controls page (src/app.ts). Kept as data,
// apart from the page, so each line can be checked against what the island really does
// (test/gestures.test.ts) and a Mac never lists what only Windows has.

import { ctrlKey, type Platform } from './core/platform';
import type { Settings } from './core/settings';

/** One line: what to do, and what happens. */
export type Gesture = [how: string, what: string];

export interface GestureGroup {
  title: string;
  items: Gesture[];
}

export function gestureGroups(s: Settings, on: Platform): GestureGroup[] {
  const mac = on === 'macos';
  const ctrl = ctrlKey(on);
  // Rust holds the paste shortcut for Land's icon: Cmd+V on a Mac (overlay.rs paste_shortcut).
  const paste = mac ? 'Cmd+V' : 'Ctrl+V';
  const tray = mac ? 'the menu bar icon' : 'the tray icon';
  const key = s.general.toggleHotkey;
  // Without Hide in the right-click menu, the tray still has it (as Settings › Behavior says).
  const hideHow = s.island.menu.hide ? 'Right click › Hide' : `${mac ? 'Menu bar icon' : 'Tray icon'} › Hide island`;
  const windowsOnly = (items: Gesture[]): Gesture[] => (mac ? [] : items);
  return [
    {
      title: 'On the island',
      items: [
        ['Point at it', "Shows more: a card grows out of it, or the pill widens (Settings › Appearance › When pointed at). Claude's card opens for more with its ⌄ button, or can hang below the pill instead."],
        ['Left click', 'Opens your Control Center. Click again to close it.'],
        ['Right click', 'Opens the menu: what you keep in it (Settings › Behavior › Right-click menu), and Settings. Right-click again to close it.'],
        ['Scroll', 'Switches to the next or previous activity. One flick on a touchpad is one switch.'],
        [`Tap ${ctrl} over it`, 'Peek: it fades and your clicks go through to what is behind, until the pointer moves away (Settings › Behavior › Peek behind).'],
        ['Click a chip', 'Brings that activity to the front (the small icons beside the main one). +N lists the rest.'],
        ['Click the moon', 'Turns Quiet off. The moon sits at the end of the pill while Quiet is on.'],
        ['Click outside, or Esc', 'Closes whatever is open and shrinks it back.'],
        ['Drop files on it', 'Land opens with them, to send to a computer nearby.'],
        [`Point at Land's icon, press ${paste}`, 'Land opens with what you copied, ready to send.'],
        ['Click the bot', 'Opens a bar under it to ask Local AI, or Claude. Click away or press Esc to close it.'],
      ],
    },
    {
      title: 'Hide and show',
      items: [
        [hideHow, 'The pill and the bot leave the screen for 30 minutes, 1 hour, 3 hours, until tomorrow morning or until you show it. Also in Settings › Behavior.'],
        ['Bring it back', `${key ? `Press ${key}, or use` : 'Use'} ${tray} › Show island, or Settings › Behavior › Show it now.`],
      ],
    },
    {
      title: 'In the Control Center',
      items: [
        ['Long-press a tile', 'Arrange: drag a tile to move it, drag its corner to resize it, − takes it off the grid and + puts it back. Reset layout starts over; Done keeps it.'],
        ['Scroll', 'Turns one page of tiles.'],
        ['Click a tile', 'Runs it: mute the speakers, play and pause, start a timer.'],
      ],
    },
    {
      title: 'In activities',
      items: [
        ['Timer: scroll a box', 'Over the hours, minutes or seconds: down adds, up takes away.'],
        ['Timer: click a box', 'Type the time yourself, HH MM SS. Enter sets it.'],
        // Top apps, Snipping Tool and the player's jump are Windows' (not on a Mac yet).
        ...windowsOnly([
          ['Music: click the album art', 'Jumps to the app that is playing, or the browser tab it plays in.'],
          ['System Stats: click a bar', 'Lists the five apps using the most of it.'],
          ['System Controls: Screenshot, Record', 'Drag over an area for Snipping Tool to capture or record it.'],
          ['System Controls: Battery saver', 'Shows whether it is on; click it to switch it in Windows Settings (on a laptop).'],
        ]),
      ],
    },
  ];
}
