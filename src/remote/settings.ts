// Settings › Your phone (Island on your phone): pair a phone with a QR code, then the paired
// phones (Connected now or Last seen, Rename, Remove) and whether each takes notifications.
// Made once and kept for the window's life, like the Workspaces page, so a code being shown
// survives the Settings page redrawing for a settings change.

import { row, section, stacked } from '../controls';
import { clock, timeOfDay } from '../core/format';
import { native, on, type RemotePairing, type RemotePhone } from '../core/native';
import { platform } from '../core/platform';
import { qrSvg } from '../core/sheet';
import { h } from '../dom';
import { PHONE_SITE } from './protocol';

/** The phone site as the steps say it ("islandphone.vercel.app"), so a rename touches protocol.ts only. */
export const SITE_HOST = new URL(PHONE_SITE).host;

/** What to do on the iPhone, beside the code. */
export const PAIR_STEPS: readonly string[] = [
  `On your iPhone, open ${SITE_HOST} in Safari, then Share › Add to Home Screen.`,
  'Open Island from your Home Screen.',
  'Tap Scan and point it at this code.',
];

/** "Connected now", "Last seen 2:14 PM", "Last seen yesterday at 9:03 AM", "Last seen Oct 20", "Not connected yet". */
export function seenText(p: Pick<RemotePhone, 'connected' | 'lastSeen'>, now: number): string {
  if (p.connected) return 'Connected now';
  if (!p.lastSeen) return 'Not connected yet';
  const day = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(p.lastSeen)) / 86_400_000);
  if (days <= 0) return `Last seen ${timeOfDay(p.lastSeen)}`;
  if (days === 1) return `Last seen yesterday at ${timeOfDay(p.lastSeen)}`;
  return `Last seen ${new Date(p.lastSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** Under a phone's name: when it was there, and whether it takes notifications (it turns them on itself). */
export function phoneDetail(p: RemotePhone, now: number): string {
  return `${seenText(p, now)} · Notifications: ${p.push ? 'On' : 'Off'}`;
}

/** How long a code shown still works. */
export function codeLeft(expires: number, now: number): string {
  return `This code works for ${clock(Math.max(0, expires - now))} more.`;
}

let built: HTMLElement | null = null;
/** Scroll to the section next time it shows (the setup's "Use Island from your phone"). */
let wantFocus = false;

/** The section, after Notifications on every redraw of Settings. */
export function phoneSection(): HTMLElement {
  if (!built) built = build();
  else void refresh();
  if (wantFocus) {
    wantFocus = false;
    const el = built;
    requestAnimationFrame(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  return built;
}

/** Settings opens on this section next time (the setup's button). */
export function focusPhoneSection(): void {
  wantFocus = true;
}

// ---------------------------------------------------------------- the section's parts

// Made in build(), so importing this file (its tests) makes no elements.
let status!: HTMLElement;
let pairing!: HTMLElement;
let list!: HTMLElement;
let testStatus!: HTMLElement;
let pairButton!: HTMLButtonElement;
let testRow: HTMLElement | null = null;

let phones: RemotePhone[] = [];
/** The code shown now, the phones there were when it was made, and its countdown. */
let code: RemotePairing | null = null;
let before = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
let left: HTMLElement | null = null;
/** The phone being renamed, or asked about before Remove. */
let renaming: string | null = null;
let removing: string | null = null;

function build(): HTMLElement {
  status = h('p', { class: 'muted' });
  pairing = h('div');
  list = h('div', { class: 'land-friends' });
  testStatus = h('span', { class: 'muted' });
  pairButton = h('button', { class: 'btn primary', text: 'Pair a phone', onclick: () => void startPairing() });
  testRow = stacked(
    row(
      'Notifications on your phone',
      'A phone turns them on in its menu (Island from the Home Screen, iOS 16.4 or later). It then gets the moments Send to my phone sends, straight from Island; Quiet holds them.',
      h('div', { class: 'hide-choices' }, [h('button', { class: 'btn', text: 'Send a test', onclick: () => void sendTest() }), testStatus]),
    ),
  );
  testRow.hidden = true;
  const kids: Node[] = [
    h('p', { class: 'muted', text: 'See and control Island from your phone, anywhere. Encrypted end to end; nothing goes through a server of ours.' }),
    row('Pair a phone', `An iPhone, through ${SITE_HOST} on its Home Screen. There is no app to install.`, pairButton),
    pairing,
    status,
    list,
    testRow,
  ];
  if (platform === 'windows') kids.push(h('p', { class: 'muted', text: "Claude's Allow works from a phone too, unless Windows Hello is asked before Allow (Activities › Claude Code): then a phone can only Deny." }));
  void on<RemotePhone[]>('remote-phones', (l) => show(l));
  void on<{ phone: string; name: string }>('remote-paired', (p) => paired(p.name));
  void refresh();
  return section('Your phone', kids);
}

function say(text: string, tone: 'muted' | 'ok' | 'warn' = 'muted'): void {
  status.textContent = text;
  status.className = tone;
}

async function refresh(): Promise<void> {
  show(await native.remotePhones());
}

function show(next: RemotePhone[]): void {
  phones = Array.isArray(next) ? next : [];
  // Rust might tell only the island about a pairing: a phone new to the list while a code shows is that one.
  const fresh = code ? phones.find((p) => !before.has(p.id)) : undefined;
  if (fresh) paired(fresh.name);
  drawList();
}

// ---------------------------------------------------------------- pairing

async function startPairing(): Promise<void> {
  pairButton.disabled = true;
  say('Making a code…');
  const r = await native.remotePairStart(PHONE_SITE);
  pairButton.disabled = false;
  if (!r.ok) return say(r.error, 'warn');
  say('');
  code = r.value;
  before = new Set(phones.map((p) => p.id));
  drawCode();
  clearInterval(timer);
  timer = setInterval(tickCode, 1000);
}

function drawCode(): void {
  if (!code) return void pairing.replaceChildren();
  const svg = qrSvg(code.size, code.qr);
  svg.setAttribute('width', '100%');
  left = h('span', { class: 'muted' });
  pairing.replaceChildren(
    h('div', { style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin:4px 0 8px' }, [
      h('div', { style: 'width:176px;flex:none;border-radius:12px;overflow:hidden;background:#fff', title: 'Scan this with Island on your phone' }, [svg]),
      h('div', { style: 'flex:1;min-width:220px;display:grid;gap:12px' }, [
        h('ol', { class: 'w-steps' }, PAIR_STEPS.map((s) => h('li', { text: s }))),
        h('div', { class: 'hide-choices', style: 'align-items:center' }, [h('button', { class: 'btn ghost', text: 'Cancel', onclick: () => cancel() }), left]),
      ]),
    ]),
  );
  tickCode();
}

function tickCode(): void {
  if (!code) return;
  const now = Date.now();
  if (now >= code.expires) {
    stopCode();
    void native.remotePairStop();
    return say('The code ran out. Pair again for a new one.');
  }
  if (left) left.textContent = codeLeft(code.expires, now);
}

function stopCode(): void {
  code = null;
  clearInterval(timer);
  pairing.replaceChildren();
}

function cancel(): void {
  stopCode();
  void native.remotePairStop();
  say('');
}

function paired(name: string): void {
  if (!code) return;
  stopCode();
  say(`Paired with ${name}`, 'ok');
  void refresh();
}

// ---------------------------------------------------------------- the phones

function drawList(): void {
  const now = Date.now();
  list.replaceChildren(...(phones.length ? phones.map((p) => phoneRow(p, now)) : [h('p', { class: 'muted', text: 'No phone paired yet.' })]));
  if (testRow) testRow.hidden = !phones.some((p) => p.push);
}

function phoneRow(p: RemotePhone, now: number): HTMLElement {
  const redraw = (fn: () => void) => () => {
    fn();
    drawList();
  };
  if (renaming === p.id) {
    const input = h('input', { type: 'text', value: p.name, maxlength: '40', spellcheck: 'false', 'aria-label': 'Phone name' });
    const save = async () => {
      const name = input.value.trim();
      renaming = null;
      if (name && name !== p.name) await native.remoteRename(p.id, name);
      await refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
      if (e.key !== 'Escape') return;
      // Escape cancels here; it would otherwise close the window.
      e.preventDefault();
      renaming = null;
      drawList();
    });
    requestAnimationFrame(() => input.focus());
    return row('Rename', phoneDetail(p, now), h('div', { class: 'hide-choices' }, [input, h('button', { class: 'btn', text: 'Save', onclick: () => void save() }), h('button', { class: 'btn ghost', text: 'Cancel', onclick: redraw(() => (renaming = null)) })]));
  }
  if (removing === p.id) {
    const remove = async () => {
      removing = null;
      await native.remoteForget(p.id);
      say(`${p.name} was removed.`);
      await refresh();
    };
    return row(`Remove ${p.name}?`, 'It is cut off at once, and has to pair again to come back.', h('div', { class: 'hide-choices' }, [h('button', { class: 'btn danger', text: 'Remove', onclick: () => void remove() }), h('button', { class: 'btn ghost', text: 'Keep it', onclick: redraw(() => (removing = null)) })]));
  }
  return row(
    p.name,
    phoneDetail(p, now),
    h('div', { class: 'hide-choices' }, [
      h('button', { class: 'btn ghost', text: 'Rename', onclick: redraw(() => ((renaming = p.id), (removing = null))) }),
      h('button', { class: 'btn ghost', text: 'Remove', onclick: redraw(() => ((removing = p.id), (renaming = null))) }),
    ]),
  );
}

async function sendTest(): Promise<void> {
  testStatus.textContent = 'Sending…';
  const n = await native.remotePush('Island', 'Notifications from Island show up here now.', 'test', '', false);
  testStatus.textContent = n ? `Sent to ${n === 1 ? 'your phone' : `${n} phones`}.` : "It didn't go out. Check that the phone turned notifications on.";
}
