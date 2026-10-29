// Screen: the PC's screen on this phone, through Chrome Remote Desktop. Its iPhone app left the App
// Store in September 2025, so the phone opens its website in Safari; its pages refuse to be framed,
// so it can't show inside Island. The PC's hello says whether it is set up there (`screen`):
// ready opens it (with a note the first time), anything else shows how to set it up first.

import { SCREEN_SITE, type ScreenState } from '../../../../src/remote/protocol';
import { button, h, ico, openSheet } from '../ui';

const NOTE_KEY = 'island:phone:crd-note';

function noted(): boolean {
  try {
    return localStorage.getItem(NOTE_KEY) === '1';
  } catch {
    return false;
  }
}

function note(): void {
  try {
    localStorage.setItem(NOTE_KEY, '1');
  } catch {
    /* storage off: the note shows again */
  }
}

function go(): void {
  // A same-window navigation: iOS opens it in the Home Screen app's own browser, over Island, and
  // its Done button comes back here. Google's site can't be framed (X-Frame-Options: SAMEORIGIN).
  location.href = SCREEN_SITE;
}

/** The Screen button: `state` is hello's (Chrome Remote Desktop running on the PC, stopped, not there; null: can't tell). */
export function openScreen(state: ScreenState, pc: string): void {
  if (state === 'ready' && noted()) {
    go();
    return;
  }
  const s = openSheet({ title: `See ${pc}'s screen`, sub: 'With Chrome Remote Desktop', icon: 'laptop' });
  const open = button('Open Chrome Remote Desktop', {
    icon: 'external',
    style: 'primary',
    cls: 'ph-big',
    onclick: () => {
      if (state === 'ready') note();
      s.close();
      go();
    },
  });
  if (state === 'ready') {
    s.body.append(h('p', { class: 'ph-text', text: 'Sign in with the Google account your PC uses, tap your PC, enter its PIN. Tap Done to come back to Island.' }), open);
    return;
  }
  const step = (n: number, text: string) => h('li', { class: 'ph-step' }, [h('span', { class: 'ph-step-n', text: String(n) }), h('span', { class: 'ph-step-text', text })]);
  const lead =
    state === 'off'
      ? `Chrome Remote Desktop is on ${pc}, but switched off.`
      : state === 'missing'
        ? `Chrome Remote Desktop isn't set up on ${pc} yet.`
        : `Island can't tell whether ${pc} has Chrome Remote Desktop.`;
  const pcSteps =
    state === 'off'
      ? [step(1, 'On the PC, open remotedesktop.google.com/access in Chrome.'), step(2, 'Turn remote access on for this PC.')]
      : [step(1, 'On the PC, open remotedesktop.google.com/access in Chrome.'), step(2, 'Under Set up remote access, install it.'), step(3, 'Pick a name for the PC and a PIN.')];
  s.body.append(
    h('p', { class: 'ph-text', text: lead }),
    h('div', { class: 'ph-section' }, [h('div', { class: 'ph-label', text: 'Once, on the PC' }), h('ol', { class: 'ph-steps' }, pcSteps)]),
    h('div', { class: 'ph-section' }, [
      h('div', { class: 'ph-label', text: 'On this phone' }),
      h('p', { class: 'ph-callout' }, [ico('info'), h('span', { text: 'Its iPhone app is gone from the App Store: the button below opens the website instead. Sign in with the same Google account, tap your PC, enter its PIN.' })]),
    ]),
    open,
  );
}
