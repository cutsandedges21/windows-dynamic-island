// The first-run setup, in the whole Activities window: make the island yours, two questions that
// fill the Control Center, the bot's AI, your phone (Island as an app on it first), Land and
// Workspaces set up on the spot, how to use the island, then a look at the result.
// The island opens it on first run (settings.general.onboarded is false); Settings › Run
// setup again opens it later.

import { CATALOG_BY_ID } from './activities/catalog';
import { segmented, toggle } from './controls';
import { bridge } from './core/bridge';
import { packGrid } from './core/grid';
import { icon } from './core/icons';
import { activeValue } from './core/models';
import { native, type LandFirewall } from './core/native';
import { applyPlan, glanceChoices, planActivities, previewCells, suggestGlance, USES, welcomeSteps, withLook, type Facts, type Look, type Plan, type Step, type Use } from './core/onboarding';
import { ctrlKey, platform, thisComputer } from './core/platform';
import { springAnimate } from './core/renderer';
import { accentColor, ACCENTS, cloneSettings, newPhoneTopic, type PillColor, type Settings } from './core/settings';
import { qrSvg } from './core/sheet';
import { springs } from './core/spring';
import { h } from './dom';
import { landPanel } from './land-panel';
import { downloadingName, modelPicker, type PickerHost } from './models-ui';
import { PHONE_SITE } from './remote/protocol';
import { phoneSection, SITE_HOST } from './remote/settings';

export interface WelcomeHost {
  settings(): Settings;
  /** Saves `next` and tells the island. */
  save(next: Settings): void;
  /** Setup is finished or skipped. */
  done(): void;
}

const STEPS = welcomeSteps(platform);

/** Where the flow is. Kept outside the page so a redraw of the window keeps the answers. */
const flow = {
  step: 0,
  uses: new Set<Use>(),
  /** The second question's ticks; null until suggested from the uses. */
  glance: null as Set<string> | null,
  /** The uses the ticks were suggested from: change the uses and they are suggested again. */
  suggestedFor: '',
  city: null as string | null,
  /** A Local AI model was picked, or one already answers. */
  ai: false,
  /** Start with Windows (Open at login on a Mac), applied when leaving "Make it yours"; null until read. */
  startup: null as boolean | null,
  facts: null as Facts | null,
};

let current: { root: HTMLElement; host: WelcomeHost } | null = null;

const facts = (): Facts => flow.facts ?? { laptop: false, claudeCode: false, platform };

export function welcomePage(host: WelcomeHost): HTMLElement {
  const root = h('div', { class: 'welcome' });
  current = { root, host };
  const s = host.settings();
  if (flow.city == null) flow.city = String(s.activities.config.weather?.options.city ?? '');
  // First run: on, so the island and its reminders are always there. Run again: as it is.
  if (flow.startup == null) flow.startup = s.general.onboarded ? s.general.startWithWindows : true;
  if (!flow.facts) void loadFacts();
  paint();
  return root;
}

/** A battery means a laptop; Claude Code counts when its program or its chats are on this PC. */
async function loadFacts(): Promise<void> {
  const [power, env] = await Promise.all([native.powerState(), native.claudeEnv()]);
  let claudeCode = Boolean(env?.claudeExe);
  if (env && !claudeCode) claudeCode = (await native.statMany([`${env.configDir}\\projects`]))[0] != null;
  flow.facts = { laptop: Boolean(power?.hasBattery), claudeCode, platform };
  if (current?.root.isConnected && STEPS[flow.step] === 'glance') paint();
}

function paint(animate = false): void {
  if (!current) return;
  const { root, host } = current;
  const step = STEPS[flow.step];
  const inner = h('div', { class: `w-inner w-${step}` }, content(step, host));
  // A redraw for a choice keeps the page where it was scrolled to.
  const scroll = animate ? 0 : (root.querySelector('.w-body')?.scrollTop ?? 0);
  const body = h('div', { class: 'w-body' }, [inner]);
  root.replaceChildren(top(host), body, foot(host));
  body.scrollTop = scroll;
  if (animate) springAnimate(inner, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], springs.content);
}

function top(host: WelcomeHost): HTMLElement {
  const dots = h('div', { class: 'w-dots', role: 'img', 'aria-label': `Step ${flow.step + 1} of ${STEPS.length}` }, STEPS.map((_, i) => h('i', { class: i === flow.step ? 'on' : i < flow.step ? 'past' : '' })));
  const last = flow.step === STEPS.length - 1;
  return h('div', { class: 'w-top' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-pill' }, [h('i')]), h('span', { text: 'Island' })]),
    dots,
    last ? h('span', { class: 'w-skip' }) : h('button', { class: 'w-skip', text: 'Skip setup', title: 'Keep the defaults. Run it later from Settings.', onclick: () => skip(host) }),
  ]);
}

function foot(host: WelcomeHost): HTMLElement {
  const step = STEPS[flow.step];
  const next = (text: string, go: () => void, disabled = false) => h('button', { class: 'btn primary w-next', text, disabled, onclick: go });
  const back = flow.step > 0 ? h('button', { class: 'btn ghost', text: 'Back', onclick: () => move(-1) }) : h('span');
  let ahead: HTMLElement;
  if (step === 'hello') ahead = next('Get started', () => move(1));
  else if (step === 'ai') {
    ahead = h('div', { class: 'w-actions' }, [
      h('button', { class: 'btn ghost', text: 'Skip for now', title: 'Leave Local AI off. Turn it on later in Activities › Bot chat.', onclick: () => ((flow.ai = false), move(1)) }),
      next('Continue', () => move(1), !flow.ai),
    ]);
  } else if (step === 'done') ahead = next('Finish', () => finish(host));
  else ahead = next('Continue', () => move(1));
  return h('div', { class: 'w-foot' }, [back, ahead]);
}

function refreshFoot(): void {
  if (current) current.root.querySelector('.w-foot')?.replaceWith(foot(current.host));
}

function move(by: number): void {
  if (by > 0 && STEPS[flow.step] === 'look' && current) applyStartup(current.host);
  flow.step = Math.max(0, Math.min(STEPS.length - 1, flow.step + by));
  const step = STEPS[flow.step];
  if (step === 'glance') suggest();
  if (step === 'ai') void checkModel();
  if (step === 'phone') void checkAccess();
  paint(true);
}

/** Start with Windows as ticked on "Make it yours": saved, and Windows told. */
function applyStartup(host: WelcomeHost): void {
  const on = flow.startup ?? true;
  if (host.settings().general.startWithWindows !== on) {
    const next = cloneSettings(host.settings());
    next.general.startWithWindows = on;
    host.save(next);
  }
  void native.autostartSet(on);
}

/** On reaching the AI step: a model that already answers (set up before) counts as picked. */
async function checkModel(): Promise<void> {
  if (flow.ai || !current) return;
  const option = String(current.host.settings().activities.config.local?.options.model ?? '');
  if (activeValue(await bridge.localStatus(), option) && STEPS[flow.step] === 'ai') {
    flow.ai = true;
    refreshFoot();
  }
}

/** Ticks the second question from the first answer, again whenever that answer changed. */
function suggest(): void {
  const key = [...flow.uses].sort().join(',');
  if (flow.glance && flow.suggestedFor === key) return;
  flow.glance = new Set(suggestGlance([...flow.uses], facts()));
  flow.suggestedFor = key;
}

function currentPlan(): Plan {
  return planActivities({ uses: [...flow.uses], glance: [...(flow.glance ?? [])], city: flow.city ?? '', ai: flow.ai }, facts());
}

function finish(host: WelcomeHost): void {
  if (STEPS.indexOf('look') < flow.step || STEPS[flow.step] === 'look') applyStartup(host);
  const city = flow.city ?? '';
  host.save(applyPlan(host.settings(), currentPlan(), city));
  reset();
  host.done();
}

function skip(host: WelcomeHost): void {
  const next = cloneSettings(host.settings());
  next.general.onboarded = true;
  host.save(next);
  reset();
  host.done();
}

function reset(): void {
  Object.assign(flow, { step: 0, glance: null, suggestedFor: '', city: null, ai: false, startup: null });
  flow.uses.clear();
}

// ---------------------------------------------------------------- screens

function content(step: Step, host: WelcomeHost): Node[] {
  switch (step) {
    case 'hello':
      return hello();
    case 'look':
      return look(host);
    case 'uses':
      return [
        h('h1', { text: `What do you use ${thisComputer()} for?` }),
        h('p', { class: 'lead', text: 'Pick all that fit. Island fills your Control Center from this, the panel that opens when you click it.' }),
        h('div', { class: 'w-options' }, USES.map((u) => option(u.icon, u.label, u.sub, flow.uses.has(u.id), (on) => (on ? flow.uses.add(u.id) : flow.uses.delete(u.id))))),
      ];
    case 'glance': {
      const ticks = flow.glance ?? new Set<string>();
      return [
        h('h1', { text: 'What do you want to see at a glance?' }),
        h('p', { class: 'lead', text: 'Ticked from your answer. Each one becomes a tile in your Control Center.' }),
        h('div', { class: 'w-options compact' }, glanceChoices(facts()).map((g) =>
          option(g.icon, g.label, undefined, ticks.has(g.id), (on) => {
            if (on) ticks.add(g.id);
            else ticks.delete(g.id);
            if (g.id === 'weather') paint();
          }),
        )),
        ticks.has('weather') ? cityField() : null,
      ].filter((n): n is HTMLElement => n != null);
    }
    case 'ai':
      return [
        h('h1', { text: 'Your AI, in the bot' }),
        h('p', { class: 'lead', text: `Click the bot beside the island and ask it anything. Local AI answers on ${thisComputer()} without the internet, and nothing you ask leaves it. Island checked ${thisComputer()} and marked the model that suits it: click a model to download it. You can switch any time in Activities › Bot chat.` }),
        botCard(),
        modelPicker(pickerHost(host), 'cards'),
      ];
    case 'phone':
      return phone(host);
    case 'land':
      return land(host);
    case 'workspaces':
      return workspaces(host);
    case 'tour':
      return tour(host);
    case 'done':
      return done(host);
  }
}

function hello(): Node[] {
  const point = (ic: string, title: string, text: string) => h('li', {}, [h('span', { class: 'w-point-icon', html: icon(ic) }), h('div', {}, [h('b', { text: title }), h('span', { class: 'muted', text })])]);
  return [
    h('div', { class: 'w-art', 'aria-hidden': 'true' }, [
      h('div', { class: 'w-pill' }, [h('span', { class: 'w-pill-dot' }), h('span', { class: 'w-pill-text', text: 'Island' }), h('span', { class: 'w-pill-bars' }, [h('i'), h('i'), h('i'), h('i'), h('i')])]),
    ]),
    h('h1', { text: 'Welcome to Island' }),
    h('p', { class: 'lead', text: 'Island sits at the edge of your screen and shows what is going on: music, calls, downloads, timers, reminders and your AI. A few screens set it up around you, in about two minutes.' }),
    h('ul', { class: 'w-points' }, [
      point('settings', 'Make it yours', 'Its colour, its place on the screen, its size and a little bot.'),
      point('grid', 'A Control Center made for you', 'Click the island for a panel of tiles, picked from your answers.'),
      point('chat', 'A bot that helps', `Ask it anything with an AI that runs on ${thisComputer()}, and have it remind you or take notes.`),
      point('phone', 'Island on your phone', 'An app on your iPhone\'s Home Screen: your island, its notifications and your files, anywhere.'),
      point('land', 'Send files to anyone', 'Drop files on the island for a computer nearby, a friend anywhere or your phone.'),
      ...(STEPS.includes('workspaces') ? [point('pulse', 'Workspaces', 'Everything you open for school, a game or a project, back in one click.')] : []),
    ]),
  ];
}

/** A choice that ticks on and off in place, without redrawing the page. */
function option(ic: string, label: string, sub: string | undefined, on: boolean, change: (on: boolean) => void): HTMLElement {
  const el = h('button', { class: `w-option${on ? ' on' : ''}`, 'aria-pressed': String(on) }, [
    h('span', { class: 'w-option-icon', html: icon(ic) }),
    h('span', { class: 'w-option-text' }, [h('b', { text: label }), sub ? h('span', { text: sub }) : null]),
    h('span', { class: 'w-tick', html: icon('check') }),
  ]);
  el.addEventListener('click', () => {
    const next = !el.classList.contains('on');
    el.classList.toggle('on', next);
    el.setAttribute('aria-pressed', String(next));
    springAnimate(el, [{ transform: 'scale(0.97)' }, { transform: 'none' }], springs.bouncy);
    change(next);
  });
  return el;
}

function cityField(): HTMLElement {
  const input = h('input', { type: 'text', value: flow.city ?? '', placeholder: 'Your city, such as Montreal', spellcheck: 'false', 'aria-label': 'City for the weather' });
  input.addEventListener('input', () => (flow.city = input.value));
  return h('label', { class: 'w-city' }, [h('span', { html: `${icon('cloud-sun')}<span>Weather for</span>` }), input]);
}

// ---------------------------------------------------------------- make it yours

const COLORS: Array<[PillColor, string]> = [
  ['black', 'Black'],
  ['white', 'White'],
  ['matte-black', 'Matte black'],
  ['matte-white', 'Matte white'],
  ['glass', 'Glass'],
];

/** The look saves at once, so the real island changes while you pick; the preview shows it too. */
function look(host: WelcomeHost): Node[] {
  const i = host.settings().island;
  const set = (patch: Partial<Look>) => {
    host.save(withLook(host.settings(), patch));
    paint();
  };
  const colors = h('div', { class: 'w-colors' }, COLORS.map(([c, label]) =>
    h('button', { class: `w-color${i.color === c ? ' on' : ''}`, 'aria-pressed': String(i.color === c), onclick: () => set({ color: c }) }, [h('span', { class: `w-swatch-pill c-${c}` }), h('span', { text: label })]),
  ));
  const accents = h('div', { class: 'swatches' }, Object.entries(ACCENTS).map(([name, color]) =>
    h('button', { class: `swatch${i.accent === name ? ' on' : ''}`, title: name, 'aria-label': name, style: `--c:${color}`, onclick: () => set({ accent: name }) }),
  ));
  const where = segmented(i.anchor, [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']], (v) => set({ anchor: v }));
  const size = segmented(i.size, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], (v) => set({ size: v }));
  const row = (title: string, help: string | null, control: Node) =>
    h('div', { class: 'w-look-row' }, [h('div', { class: 'w-look-text' }, [h('b', { text: title }), help ? h('span', { class: 'muted', text: help }) : null]), control]);
  const mac = platform === 'macos';
  return [
    h('h1', { text: 'Make it yours' }),
    h('p', { class: 'lead', text: 'Your island changes as you pick, so watch it on your screen. All of this is in Settings too.' }),
    h('div', { class: 'w-look-grid' }, [
      lookPreview(i),
      h('div', { class: 'w-look-rows' }, [
        row('Where it sits', 'On the left or the right it stands up.', where),
        row('Colour', null, colors),
        row('Accent', 'Its light, the bot and the highlights.', accents),
        row('Size', null, size),
        row('The bot', 'A little bot beside the island. Click it to ask anything, set reminders and take notes.', toggle(i.bot, (v) => set({ bot: v }))),
        row(mac ? 'Open at login' : 'Start with Windows', 'So the island and your reminders are there whenever you are.', toggle(flow.startup ?? true, (v) => (flow.startup = v))),
      ]),
    ]),
  ];
}

/** A little screen with the island where it sits, in its colour, accent and size, the bot beside it. */
function lookPreview(i: Settings['island']): HTMLElement {
  const vertical = i.anchor === 'left' || i.anchor === 'right';
  const pill = h('span', { class: `w-mini-pill c-${i.color}` }, [h('i', { class: 'w-mini-dot' }), h('i', { class: 'w-mini-bars' }, [h('b'), h('b'), h('b')])]);
  const bot = i.bot ? h('span', { class: 'w-mini-bot' }, [h('i'), h('i')]) : null;
  return h('div', { class: `w-screen at-${i.anchor} size-${i.size}${vertical ? ' vertical' : ''}`, style: `--acc:${accentColor(i)}`, 'aria-hidden': 'true' }, [
    h('div', { class: 'w-mini-windows' }, [h('i'), h('i')]),
    h('div', { class: 'w-mini' }, [bot, pill]),
  ]);
}

// ---------------------------------------------------------------- the bot

/** What the bot does without any model: reminders and notes, typed in plain words. */
function botCard(): HTMLElement {
  const says = ['remind me tomorrow 9am to call mom', 'remind me in 20 min to stretch', 'note: locker code 1234', 'what are my reminders?'];
  return h('section', { class: 'w-card w-bot' }, [
    cardHead('bell', 'Reminders and notes, right away', 'The bot sets them itself, no model needed. Type things like:'),
    h('div', { class: 'w-says' }, says.map((t) => h('code', { text: t }))),
    h('p', {
      class: 'w-fine',
      text:
        platform === 'macos'
          ? 'A reminder shows on the island at its time. Anything without a time is kept as a note, in Reminders › Notes.'
          : 'A reminder shows on the island at its time, and Windows shows it too, even when Island is closed. Anything without a time is kept as a note, in Reminders › Notes.',
    }),
  ]);
}

/** The AI step's picks save straight away: the download starts on the click. */
function pickerHost(host: WelcomeHost): PickerHost {
  return {
    option: () => String(host.settings().activities.config.local?.options.model ?? ''),
    choose: (value) => {
      const next = cloneSettings(host.settings());
      const local = next.activities.config.local;
      if (local) {
        local.options.model = value;
        local.enabled = true;
      }
      host.save(next);
      flow.ai = true;
      refreshFoot();
    },
  };
}

// ---------------------------------------------------------------- your phone

/** Whether Windows lets Island read notifications (Phone Link's arrive that way); '' until asked. */
let phoneAccess = '';

async function checkAccess(): Promise<void> {
  if (platform === 'macos') return;
  const access = await native.phoneLinkAccess();
  if (access === phoneAccess) return;
  phoneAccess = access;
  if (STEPS[flow.step] === 'phone') paint();
}

/**
 * Your phone. First Island as an app on the iPhone (the phone site added to the Home Screen),
 * paired right here with Settings' own pairing section; then notifications on any phone through
 * ntfy, and the phone's own notifications on the island through Windows' Phone Link. Turning
 * pushes on saves at once (the topic is made then), so Send a test works on this screen.
 */
function phone(host: WelcomeHost): Node[] {
  const g = host.settings().general;
  const on = g.phonePush && g.phoneTopic !== '';
  const mac = platform === 'macos';
  const app = h('section', { class: 'w-card w-app' }, [
    cardHead(
      'phone',
      'Island on your iPhone, as an app',
      `Your island on your phone, wherever you are: see it, open its cards and press its buttons, send files both ways and get its notifications. It is a website you add to your Home Screen, ${SITE_HOST}, so there is nothing to install from the App Store.`,
    ),
    h('div', { class: 'w-app-row' }, [
      siteQr(),
      h('ol', { class: 'w-steps' }, [
        stepItem(`Open ${SITE_HOST} on your iPhone.`, 'Point the Camera at this code, or type the address in Safari.'),
        stepItem('Tap Share, then Add to Home Screen.', 'Island is an app on your Home Screen now. Open it from there.'),
        stepItem('Pair it with this computer.', 'Click Pair a phone below, then tap Scan in the app and point it at the code that shows.'),
      ]),
    ]),
    phoneSection(),
  ]);
  const toPhone = h('section', { class: 'w-card' }, [
    cardHead('send', 'Notifications on any phone', "The island's notifications through the free ntfy app, on an iPhone or Android, without pairing: Claude Code finishing, asking a question or needing your permission, a timer ending, a reminder, files sent to you with Land."),
    option('bell', 'Send notifications to my phone', on ? 'On. Now do these steps on your phone:' : 'Free, with the ntfy app.', on, (v) => setPhonePush(host, v)),
    on ? ntfySteps(g.phoneTopic) : null,
  ]);
  const fromPhone = mac
    ? null
    : h('section', { class: 'w-card' }, [
        cardHead('phone', 'Your phone → Island', "See your phone's notifications on the island: who a message is from and what it says. Windows' Phone Link app brings them over from your phone and Island shows them, so there is nothing to switch on here."),
        phoneLinkSteps(),
      ]);
  return [
    h('h1', { text: 'Your phone and Island' }),
    h('p', {
      class: 'lead',
      text: mac
        ? 'Use Island from your iPhone, and get its notifications there. All optional, and all in Settings too (Your phone, Notifications).'
        : "Use Island from your iPhone, get its notifications on any phone, and see your phone's on the island. All optional, and all in Settings too (Your phone, Notifications).",
    }),
    h('div', { class: 'w-cards' }, [app, toPhone, fromPhone]),
  ];
}

/** The phone site's address as a QR code, for the iPhone's Camera. */
function siteQr(): HTMLElement {
  const box = h('div', { class: 'w-qr', title: `Point your iPhone's Camera here to open ${SITE_HOST}` }, [h('span', { class: 'w-qr-text', text: SITE_HOST })]);
  void native.qrCode(PHONE_SITE).then((q) => {
    if (!q) return;
    const svg = qrSvg(q.size, q.qr);
    svg.setAttribute('width', '100%');
    box.replaceChildren(svg);
  });
  return box;
}

function cardHead(ic: string, title: string, text: string): HTMLElement {
  return h('div', { class: 'w-card-head' }, [h('span', { class: 'w-point-icon', html: icon(ic) }), h('div', {}, [h('b', { text: title }), h('p', { class: 'muted', text })])]);
}

/** One numbered step: what to do in bold, then how. */
function stepItem(what: string, how: string, extra: Node | null = null): HTMLElement {
  return h('li', {}, [h('b', { text: what }), h('span', { class: 'muted', text: ` ${how}` }), extra]);
}

/** Turning pushes on makes the topic and saves at once. */
function setPhonePush(host: WelcomeHost, on: boolean): void {
  const next = cloneSettings(host.settings());
  next.general.phonePush = on;
  if (on && !next.general.phoneTopic) next.general.phoneTopic = newPhoneTopic();
  host.save(next);
  paint();
}

function ntfySteps(topic: string): HTMLElement {
  const status = h('span', { class: 'w-status muted' });
  const say = (text: string) => (status.textContent = text);
  const copy = h('button', { class: 'btn', text: 'Copy', title: 'Copy the topic', onclick: () => void native.clipboardSetText(topic).then((ok) => say(ok ? 'Copied.' : '')) });
  const test = h('button', {
    class: 'btn primary',
    text: 'Send a test',
    onclick: () => {
      say('Sending…');
      void native.phonePush(topic, 'Island', 'Your phone is connected. Island notifications show up here now.').then((ok) => say(ok ? 'Sent. It should show on your phone within a few seconds.' : 'Could not reach ntfy.sh. Check the internet connection.'));
    },
  });
  return h('div', { class: 'w-card-body' }, [
    h('ol', { class: 'w-steps' }, [
      stepItem('Install ntfy on your phone.', 'It is free: search "ntfy" in the App Store or Google Play.'),
      stepItem('Open ntfy, tap +, type this topic and tap Subscribe.', 'Type it exactly, it is your private address.', h('div', { class: 'w-topic' }, [h('code', { text: topic }), copy])),
      stepItem('Allow notifications', 'when ntfy asks, or the pushes stay silent.'),
      stepItem('Check that it works.', 'A push should arrive on your phone.', h('div', { class: 'w-test' }, [test, status])),
    ]),
    h('p', { class: 'w-fine', text: 'Pushes go through ntfy.sh, a free notification service. Anyone who knows the topic can read them, so keep it to yourself. Claude Code\'s can be turned off in Activities › Claude Code.' }),
  ]);
}

function phoneLinkSteps(): HTMLElement {
  const blocked = phoneAccess === 'denied' || phoneAccess === 'unspecified';
  return h('div', { class: 'w-card-body' }, [
    h('ol', { class: 'w-steps' }, [
      stepItem('Open Phone Link and pair your phone.', 'It comes with Windows and works with iPhone and Android.', h('div', { class: 'w-test' }, [h('button', { class: 'btn', text: 'Open Phone Link', onclick: () => void native.open('ms-phone://') })])),
      stepItem('Let it share notifications.', "Phone Link walks you through it. On an iPhone it asks you to let this PC show notifications, in the iPhone's Bluetooth settings."),
      stepItem('That is all.', 'New notifications from your phone show on the island for a few seconds.'),
    ]),
    blocked
      ? h('div', { class: 'w-warn' }, [
          h('span', { text: "Windows doesn't let apps read notifications right now, so Island can't see Phone Link's. Turn on notification access in Windows Settings." }),
          h('button', { class: 'btn', text: 'Open Windows Settings', onclick: () => void native.open('ms-settings:privacy-notifications') }),
        ])
      : null,
  ]);
}

// ---------------------------------------------------------------- Land

/** Land, set up on the spot: computers nearby (with Windows Firewall checked), and friends anywhere by code. */
function land(host: WelcomeHost): Node[] {
  const opts = host.settings().activities.config.land?.options ?? {};
  const setOpt = (key: string, value: unknown) => {
    const next = cloneSettings(host.settings());
    const cfg = next.activities.config.land;
    if (!cfg) return;
    cfg.options[key] = value;
    host.save(next);
  };
  const name = h('input', { type: 'text', value: String(opts.name ?? ''), placeholder: "This computer's own name", spellcheck: 'false', 'aria-label': 'Name others see' });
  name.addEventListener('change', () => setOpt('name', name.value.trim()));
  const firewall = h('div');
  if (platform !== 'macos') void native.landFirewall().then((f) => firewall.replaceChildren(...firewallNote(f, firewall)));
  return [
    h('h1', { text: 'Land: send files to anyone' }),
    h('p', {
      class: 'lead',
      text: 'Drop files on the island to send them, like AirDrop: to a computer nearby, a friend anywhere or your phone. Or point at the Land icon on the pill and press Ctrl+V to send what you copied. The other side accepts first, and everything is encrypted on the way.',
    }),
    h('div', { class: 'w-cards' }, [
      h('section', { class: 'w-card' }, [
        cardHead('wifi', 'Computers nearby', 'On the same network, they see this computer and can offer it files. You accept each one.'),
        option('land', 'Let computers nearby send me files', 'You still accept each one.', opts.visible !== false, (v) => setOpt('visible', v)),
        h('label', { class: 'w-city' }, [h('span', { html: `${icon('laptop')}<span>Name others see</span>` }), name]),
        firewall,
      ]),
      h('section', { class: 'w-card w-friends' }, [
        cardHead('globe', 'Friends anywhere', 'At school, at home or across the world: swap codes once, then send to each other any time. Both need Island open.'),
        option('globe', 'Friends on other networks', 'Islands find each other through free relays, which never see your files.', opts.anywhere !== false, (v) => setOpt('anywhere', v)),
        landPanel(),
      ]),
    ]),
  ];
}

/** Windows Firewall keeping this network out, as the Land card says it, with its one-click fix. */
function firewallNote(f: LandFirewall, box: HTMLElement): HTMLElement[] {
  if (f.state !== 'blocked' && f.state !== 'block-all') return [];
  const where = f.network === 'public' ? 'public networks (like school or café Wi-Fi)' : `${f.network} networks`;
  if (f.state === 'block-all') return [h('div', { class: 'w-warn' }, [h('span', { text: `Windows Firewall blocks all incoming connections on ${where}, so computers here can't find this one. Turn that off in Windows Security › Firewall.` })])];
  const fix = h('button', { class: 'btn', text: 'Allow Island on every network' });
  fix.addEventListener('click', async () => {
    fix.disabled = true;
    fix.textContent = 'Waiting for Windows…';
    const r = await native.landFirewallFix();
    if (r.ok) box.replaceChildren(...firewallNote(r.value, box));
    else {
      fix.disabled = false;
      fix.textContent = 'Allow Island on every network';
    }
  });
  return [h('div', { class: 'w-warn' }, [h('span', { text: `Windows Firewall keeps Island out on ${where}, so computers here can't find this one.` }), fix])];
}

// ---------------------------------------------------------------- Workspaces

function workspaces(host: WelcomeHost): Node[] {
  const notice = host.settings().activities.config.workspaces?.options.notice === true;
  const setNotice = (v: boolean) => {
    const next = cloneSettings(host.settings());
    const cfg = next.activities.config.workspaces;
    if (!cfg) return;
    cfg.options.notice = v;
    host.save(next);
  };
  return [
    h('h1', { text: 'Workspaces' }),
    h('p', {
      class: 'lead',
      text: 'A workspace is everything you open for one thing (school, a game, a project): apps, folders, websites and even where the windows sit. Save it once, then bring it all back in one click, from the island, its right-click menu or Control Center.',
    }),
    h('div', { class: 'w-cards' }, [
      h('section', { class: 'w-card' }, [
        cardHead('grid', 'Your first workspace', 'Name it, add what it opens, and save where your windows are right now. It takes a minute.'),
        h('div', { class: 'w-test' }, [
          h('button', { class: 'btn primary', text: 'Make my first workspace', onclick: () => (finish(host), void native.openApp('workspaces')) }),
          h('span', { class: 'muted', text: 'Finishes setup and opens Workspaces.' }),
        ]),
      ]),
      h('section', { class: 'w-card' }, [
        cardHead('pulse', 'Notice what I work on', 'Island watches which programs and projects you use, so it can offer to make them a workspace, show a workspace\'s next step when you switch to it, and ask where you stopped.'),
        option('pulse', 'Notice what I work on', 'What it notices stays on this computer.', notice, setNotice),
      ]),
    ]),
  ];
}

// ---------------------------------------------------------------- how to use it

function tour(host: WelcomeHost): Node[] {
  const hotkey = host.settings().general.toggleHotkey;
  const gesture = (ic: string, title: string, text: string) => h('li', {}, [h('span', { class: 'w-point-icon', html: icon(ic) }), h('div', {}, [h('b', { text: title }), h('span', { class: 'muted', text })])]);
  return [
    h('h1', { text: 'How to use your island' }),
    h('p', { class: 'lead', text: 'Try these on your island now.' }),
    h('ul', { class: 'w-moves' }, [
      gesture('grid', 'Click it', 'Opens Control Center, your tiles. Hold a tile to move it or change its size.'),
      gesture('eye', 'Point at it', "Shows more about what it says: your chats, your phone's notifications. With music playing, the pill grows into a player."),
      gesture('more', 'Right-click it', 'Your menu: where it sits, Quiet, Hide, Reminders, Workspaces. Pick what it holds in Settings › Behavior.'),
      gesture('land', 'Drop files on it', 'Land sends them to a computer nearby, a friend anywhere or your phone.'),
      gesture('chat', 'Click the bot', 'Ask anything, or say “remind me tomorrow 9am to…” or “note: …”.'),
      gesture('keyboard', `Tap ${ctrlKey()} while pointing at it`, 'It fades, and your clicks go to whatever is behind it.'),
      gesture('arrow-down', 'Scroll on it', 'Goes through what is going on, when there is more than one thing.'),
      hotkey ? gesture('keyboard', hotkey, 'Opens the island from anywhere.') : null,
    ]),
  ];
}

// ---------------------------------------------------------------- done

function done(host: WelcomeHost): Node[] {
  const hotkey = host.settings().general.toggleHotkey;
  const downloading = downloadingName();
  return [
    h('h1', { text: 'You are all set' }),
    h('p', { class: 'lead', text: `This is your Control Center. Click the island${hotkey ? ` or press ${hotkey}` : ''} to open it, and hold a tile to move or resize it.` }),
    preview(currentPlan()),
    downloading ? h('p', { class: 'w-note', html: `${icon('download')}<span>${downloading} is still downloading. It keeps going after you finish, and the island tells you when Local AI is ready.</span>` }) : h('span'),
  ];
}

/** The grid as the island will lay it out (the island's own day tile first), first page only. */
function preview(plan: Plan): HTMLElement {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const items = [{ key: 'island/day', w: 1, h: 1 }, ...plan.picked.map((id) => ({ key: id, ...previewCells(id) }))];
  const slots = packGrid(items, 4, 4);
  const first = slots.filter((s) => s.page === 0);
  const grid = h('div', { class: 'w-grid' });
  for (const s of first) {
    const meta = CATALOG_BY_ID.get(s.key);
    const tile = h('div', { class: `w-tile${meta ? '' : ' day'}` }, [h('span', { class: 'w-tile-icon', html: icon(meta?.icon ?? 'sun') }), h('span', { class: 'w-tile-name', text: meta?.name ?? today })]);
    tile.style.gridColumn = `${s.col + 1} / span ${s.w}`;
    tile.style.gridRow = `${s.row + 1} / span ${s.h}`;
    grid.append(tile);
  }
  grid.style.gridTemplateRows = `repeat(${Math.max(1, ...first.map((s) => s.row + s.h))}, 66px)`;
  const more = slots.length - first.length;
  return h('div', { class: 'w-preview' }, [
    grid,
    more > 0 ? h('div', { class: 'muted w-more', text: `+${more} more on the next page` }) : null,
    plan.picked.length ? null : h('div', { class: 'muted w-more', text: 'Nothing picked, so it only shows today. Add tiles any time in Activities.' }),
  ]);
}
