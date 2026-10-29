// Settings › Your phone (Island on your phone): pair a phone with a QR code, then the paired
// phones (Connected now or Last seen, Rename, Remove) and whether each takes notifications,
// Terminal from your phone with the terminals open now (End), and Chrome Remote Desktop.
// Made once and kept for the window's life, like the Workspaces page, so a code being shown
// survives the Settings page redrawing for a settings change.

import { row, section, stacked, toggle } from '../controls';
import { clock, timeOfDay } from '../core/format';
import { native, on, type RemotePairing, type RemotePhone } from '../core/native';
import { platform } from '../core/platform';
import type { Settings } from '../core/settings';
import { qrSvg } from '../core/sheet';
import { h } from '../dom';
import { termAllowed } from './hub';
import { PHONE_SITE, SCREEN_SITE, type ScreenState, type TermInfo } from './protocol';

/** What the Settings page gives the section: the settings it edits (Terminal from your phone), and saving them. */
export interface PhoneSettingsHost {
  settings(): Settings;
  save(): void;
}

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

/** Under Terminal from your phone: what it allows, and why phones get none while Windows Hello guards Allow. */
export function termHelp(s: Pick<Settings, 'general' | 'activities'>): string {
  const what = 'A paired phone can open a terminal on this PC and run any command.';
  return s.general.phoneTerminal && !termAllowed(s) ? `${what} Off for phones while Windows Hello is asked before Allow (Activities › Claude Code).` : what;
}

/** Under a terminal's title: who started it, whether it runs, and where. */
export function termDetail(t: TermInfo): string {
  const state = t.exit === null ? `Running since ${timeOfDay(t.started)}` : `Ended, exit code ${t.exit}`;
  return [t.claude ? 'Claude chat' : null, state, t.attached ? 'Open on your phone' : null, t.cwd].filter(Boolean).join(' · ');
}

/** The Chrome Remote Desktop row: its state, what to do, and the button. */
export function screenWords(state: ScreenState): { title: string; help: string; button: string } {
  const steps = 'Set it up opens remotedesktop.google.com/access: Set up remote access, install it, pick a name and a PIN.';
  switch (state) {
    case 'ready':
      return { title: 'Chrome Remote Desktop: ready', help: "Your phone's Screen button opens it: sign in with the same Google account, tap this PC, enter its PIN.", button: 'Open' };
    case 'off':
      return { title: 'Chrome Remote Desktop: not set up', help: `It is installed but turned off. ${steps}`, button: 'Set it up' };
    case 'missing':
      return { title: 'Chrome Remote Desktop: not set up', help: `See and use this screen from your phone. ${steps}`, button: 'Set it up' };
    default:
      return { title: 'Chrome Remote Desktop', help: `See and use this screen from your phone. ${steps}`, button: 'Set it up' };
  }
}

let built: HTMLElement | null = null;
/** Scroll to the section next time it shows (the setup's "Use Island from your phone"). */
let wantFocus = false;
/** The Settings page's settings, given on every redraw. */
let host: PhoneSettingsHost | null = null;

/** The section, after Notifications on every redraw of Settings. */
export function phoneSection(given?: PhoneSettingsHost): HTMLElement {
  if (given) host = given;
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
let termBox!: HTMLElement;
let screenBox!: HTMLElement;
/** The terminals as Rust last listed them. */
let terms: TermInfo[] = [];

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
  termBox = h('div');
  screenBox = h('div');
  const kids: Node[] = [
    h('p', { class: 'muted', text: 'See and control Island from your phone, anywhere. Encrypted end to end; nothing goes through a server of ours.' }),
    row('Pair a phone', `An iPhone, through ${SITE_HOST} on its Home Screen. There is no app to install.`, pairButton),
    pairing,
    status,
    list,
    testRow,
    termBox,
    screenBox,
  ];
  if (platform === 'windows') kids.push(h('p', { class: 'muted', text: "Claude's Allow works from a phone too, unless Windows Hello is asked before Allow (Activities › Claude Code): then a phone can only Deny." }));
  void on<RemotePhone[]>('remote-phones', (l) => show(l));
  void on<{ phone: string; name: string }>('remote-paired', (p) => paired(p.name));
  void on<TermInfo[]>('term-changed', (l) => showTerms(l));
  // Terminals open and end from the phone meanwhile: the list keeps up while Settings shows.
  setInterval(() => {
    if (built?.isConnected && document.visibilityState === 'visible') void refreshTerms();
  }, 4000);
  void refresh();
  return section('Your phone', kids);
}

function say(text: string, tone: 'muted' | 'ok' | 'warn' = 'muted'): void {
  status.textContent = text;
  status.className = tone;
}

async function refresh(): Promise<void> {
  drawTerms();
  void refreshTerms();
  void native.screenState().then(drawScreen);
  show(await native.remotePhones());
}

// ---------------------------------------------------------------- terminals and the screen

async function refreshTerms(): Promise<void> {
  showTerms(await native.termList());
}

function showTerms(next: unknown): void {
  terms = Array.isArray(next) ? (next as TermInfo[]) : [];
  drawTerms();
}

/** Terminal from your phone, then every terminal open now with End (an ended one: Remove). */
function drawTerms(): void {
  if (!termBox) return;
  const kids: Node[] = [];
  const s = host?.settings();
  if (s) {
    const r = row(
      'Terminal from your phone',
      termHelp(s),
      toggle(s.general.phoneTerminal, (v) => {
        s.general.phoneTerminal = v;
        host?.save();
        // Only the words change: the switch keeps its motion.
        const help = r.querySelector('.row-help');
        if (help) help.textContent = termHelp(s);
      }),
    );
    kids.push(r);
  }
  for (const t of terms) {
    const end = h('button', { class: 'btn ghost', text: t.exit === null ? 'End' : 'Remove' });
    end.addEventListener('click', async () => {
      end.disabled = true;
      const r = await native.termKill(t.id);
      if (!r.ok) say(`Couldn't end ${t.title}: ${r.error}`, 'warn');
      await refreshTerms();
    });
    kids.push(row(t.title || 'Terminal', termDetail(t), end));
  }
  termBox.replaceChildren(...kids);
}

/** Chrome Remote Desktop: ready, or not set up with the button that sets it up. */
function drawScreen(state: ScreenState): void {
  const w = screenWords(state);
  const open = h('button', { class: state === 'ready' ? 'btn ghost' : 'btn', text: w.button, onclick: () => void native.openUrl(SCREEN_SITE) });
  screenBox.replaceChildren(row(w.title, w.help, open));
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
