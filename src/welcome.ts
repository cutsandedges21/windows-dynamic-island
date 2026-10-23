// The first-run setup, in the whole Activities window: two questions that fill the Control
// Center, then this PC and the Local AI model that suits it, then your phone, then a look at
// the result.
// The island opens it on first run (settings.general.onboarded is false); Settings › Run
// setup again opens it later.

import { CATALOG_BY_ID } from './activities/catalog';
import { bridge } from './core/bridge';
import { packGrid } from './core/grid';
import { icon } from './core/icons';
import { activeValue } from './core/models';
import { native } from './core/native';
import { applyPlan, glanceChoices, planActivities, previewCells, suggestGlance, USES, type Facts, type Plan, type Use } from './core/onboarding';
import { platform, thisComputer } from './core/platform';
import { springAnimate } from './core/renderer';
import { cloneSettings, newPhoneTopic, type Settings } from './core/settings';
import { springs } from './core/spring';
import { h } from './dom';
import { downloadingName, modelPicker, type PickerHost } from './models-ui';
import { focusPhoneSection } from './remote/settings';

export interface WelcomeHost {
  settings(): Settings;
  /** Saves `next` and tells the island. */
  save(next: Settings): void;
  /** Setup is finished or skipped. */
  done(): void;
}

const STEPS = ['hello', 'uses', 'glance', 'ai', 'phone', 'done'] as const;
type Step = (typeof STEPS)[number];

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
  facts: null as Facts | null,
};

let current: { root: HTMLElement; host: WelcomeHost } | null = null;

const facts = (): Facts => flow.facts ?? { laptop: false, claudeCode: false, platform };

export function welcomePage(host: WelcomeHost): HTMLElement {
  const root = h('div', { class: 'welcome' });
  current = { root, host };
  if (flow.city == null) flow.city = String(host.settings().activities.config.weather?.options.city ?? '');
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
  root.replaceChildren(top(host), h('div', { class: 'w-body' }, [inner]), foot(host));
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
      h('button', { class: 'btn ghost', text: 'Skip for now', title: 'Leave Local AI off. Turn it on later in Activities.', onclick: () => ((flow.ai = false), move(1)) }),
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
  flow.step = Math.max(0, Math.min(STEPS.length - 1, flow.step + by));
  const step = STEPS[flow.step];
  if (step === 'glance') suggest();
  if (step === 'ai') void checkModel();
  if (step === 'phone') void checkAccess();
  paint(true);
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
  Object.assign(flow, { step: 0, glance: null, suggestedFor: '', city: null, ai: false });
  flow.uses.clear();
}

// ---------------------------------------------------------------- screens

function content(step: Step, host: WelcomeHost): Node[] {
  switch (step) {
    case 'hello':
      return hello();
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
        h('h1', { text: `Your own AI, on ${thisComputer()}` }),
        h('p', { class: 'lead', text: `Local AI answers questions without the internet, and nothing you ask leaves this computer. Island checked ${thisComputer()} and marked the model that suits it. Click a model to download it and use it. You can switch any time in Activities › Local AI.` }),
        modelPicker(pickerHost(host), 'cards'),
      ];
    case 'phone':
      return phone(host);
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
    h('p', { class: 'lead', text: 'Island sits at the top of your screen and shows what is going on: music, downloads, timers, calls and your AI. Answer two questions and it sets itself up around you. It takes about a minute.' }),
    h('ul', { class: 'w-points' }, [
      point('grid', 'A Control Center made for you', 'Click the island for a panel of tiles, picked from your answers.'),
      point('spark', `An AI that runs on ${thisComputer()}`, 'Island checks your memory and graphics and recommends the model that suits them.'),
      point('phone', 'Works with your phone', platform === 'macos' ? "If you want, the island's notifications on your phone too." : "If you want, the island's notifications on your phone, and your phone's on the island."),
      point('settings', 'Nothing is final', 'Change any of it later in Activities and Settings.'),
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
 * Your phone, both ways, each spelled out step by step: Island's notifications pushed to the
 * ntfy app, and the phone's shown on the island through Windows' Phone Link. Turning pushes on
 * saves at once (the topic is made then), so Send a test works on this screen.
 */
function phone(host: WelcomeHost): Node[] {
  const g = host.settings().general;
  const on = g.phonePush && g.phoneTopic !== '';
  const mac = platform === 'macos';
  const toPhone = h('section', { class: 'w-card' }, [
    cardHead('send', 'Island → your phone', "Get the island's notifications on your phone, even away from your desk: Claude Code finishing, asking a question or needing your permission, a timer ending, someone sending you files with Land."),
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
        ? 'Island can send its notifications to your phone. It is optional, and you can also set it up later in Settings › Notifications.'
        : 'Island can share notifications with your phone, both ways. Both are optional, and you can also set them up later in Settings › Notifications.',
    }),
    h('div', { class: 'w-cards' }, [toPhone, fromPhone]),
    // Island on your phone: setup ends here and Settings opens on Your phone, to pair it.
    h('div', { class: 'w-note' }, [h('span', { text: 'New: see and control Island from your iPhone, anywhere.' }), h('button', { class: 'btn', text: 'Use Island from your phone', onclick: () => (focusPhoneSection(), finish(host), void native.openApp('settings')) })]),
  ];
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

function done(host: WelcomeHost): Node[] {
  const hotkey = host.settings().general.toggleHotkey;
  const downloading = downloadingName();
  return [
    h('h1', { text: 'You are all set' }),
    h('p', { class: 'lead', text: `This is your Control Center. Click the island${hotkey ? ` or press ${hotkey}` : ''} to open it, and long-press a tile to move or resize it.` }),
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
