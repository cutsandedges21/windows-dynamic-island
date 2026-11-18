// Settings' live previews: small drawings that change as you change what they show. The island's
// look (colour, accent, size, blend, glow, bot), the screen with the taskbar, the border and the
// notches, how an activity shows on the island, and what an alert looks and sounds like. They draw
// from the settings alone, so they work before the island has anything to show.

import type { ActivityConfig, Settings } from './core/settings';
import { frameAvailable, NOTCH_CORNERS, ACCENTS } from './core/settings';
import type { ActivityMeta } from './activities/catalog';
import { icon } from './core/icons';
import { h } from './dom';

/** The island's colour for a preview: the taskbar's own look, else the island's. */
const lookOf = (s: Settings, own?: { color: string }) => (own && own.color !== 'island' ? own.color : s.island.color);
const accentOf = (s: Settings) => ACCENTS[s.island.accent] ?? s.island.accent;
/** The island's sizes, as island.ts scales them. */
const SIZE_K: Record<string, number> = { small: 0.86, medium: 1, large: 1.14 };
const GLOW_LAP: Record<string, string> = { slow: '8s', medium: '5s', fast: '3s' };

/** A mini pill: `look` its colour, `blend` flush with the top edge, `glow` its light (speed or off). */
function miniPill(look: string, opts: { blend: boolean; glow: string; accent: string; content: Node[]; k?: number; melt?: boolean }): HTMLElement {
  const pill = h('div', { class: `pv-pill${opts.blend ? ' blend' : ''}${opts.melt ? ' melt' : ''}`, 'data-look': look }, [
    h('i', { class: 'pv-pill-bg' }),
    ...(opts.melt ? [h('i', { class: 'pv-foot l' }), h('i', { class: 'pv-foot r' })] : []),
    h('div', { class: 'pv-pill-in' }, opts.content),
  ]);
  pill.style.setProperty('--k', String(opts.k ?? 1));
  pill.style.setProperty('--pv-accent', opts.accent);
  if (opts.glow !== 'off') {
    pill.classList.add('glowing');
    pill.style.setProperty('--lap', GLOW_LAP[opts.glow] ?? '5s');
    pill.append(h('i', { class: 'pv-glow' }, [h('i')]));
  }
  return pill;
}

/** The island as it will look: on a strip of desktop, with its colour, accent, size, blend, border, glow and bot. */
export function islandPreview(s: Settings): HTMLElement {
  const i = s.island;
  const accent = accentOf(s);
  const framed = i.frame.on && frameAvailable(i);
  const pill = miniPill(i.color, {
    blend: i.blend,
    glow: i.glow,
    accent,
    k: SIZE_K[i.size] ?? 1,
    melt: framed && i.blend,
    content: [
      h('span', { class: 'pv-ico claude', html: icon('claude') }),
      h('span', { class: 'pv-text', text: 'Working on the island' }),
      h('span', { class: 'pv-dot' }),
    ],
  });
  if (!i.blend) pill.style.marginTop = `${Math.min(18, i.edge * 0.6)}px`;
  const bot = i.bot ? h('span', { class: 'pv-bot', 'data-look': i.color }, [h('i')]) : null;
  if (bot) bot.style.setProperty('--pv-accent', accent);
  const screen = h('div', { class: `pv-screen island${framed ? ' framed' : ''}`, 'data-look': lookOf(s, i.taskbar.look) }, [
    framed ? h('i', { class: 'pv-border' }) : null,
    h('div', { class: 'pv-top' }, [bot, pill]),
    h('div', { class: 'pv-window' }, [h('i'), h('i'), h('i')]),
  ]);
  return h('div', { class: 'preview' }, [screen, h('div', { class: 'pv-caption', text: captionIsland(s) })]);
}

function captionIsland(s: Settings): string {
  const i = s.island;
  const bits = [
    i.color === 'glass' ? 'Glass' : i.color.replace('-', ' ').replace(/^./, (c) => c.toUpperCase()),
    `${i.size[0].toUpperCase()}${i.size.slice(1)}`,
    i.blend ? 'blended into the top' : 'floating',
    i.glow === 'off' ? 'no glow' : `${i.glow} glow`,
  ];
  return bits.join(' · ');
}

/** The screen with the taskbar on its side, the border and the notches where they sit. */
export function screenPreview(s: Settings): HTMLElement {
  const i = s.island;
  const t = i.taskbar;
  const accent = accentOf(s);
  const look = lookOf(s, t.look);
  const framed = i.frame.on && frameAvailable(i);
  const zoom = { small: 0.84, medium: 1, large: 1.18 }[t.size] ?? 1;
  const bar = t.on
    ? h('div', { class: `pv-bar side-${t.side}${t.edge ? ' edge' : ''}${t.edge && t.melt ? ' melt' : ''}`, 'data-look': look }, [
        h('i', { class: 'pv-bar-bg' }),
        ...(t.edge && t.melt ? [h('i', { class: 'pv-foot a' }), h('i', { class: 'pv-foot b' })] : []),
        h('div', { class: 'pv-bar-in' }, [h('i', { class: 'start' }), h('i'), h('i', { class: 'on' }), h('i'), h('i'), h('b'), h('i', { class: 'clock' })]),
      ])
    : null;
  bar?.style.setProperty('--z', String(zoom));
  bar?.style.setProperty('--pv-accent', accent);
  const notch = (kind: 'sites' | 'shelf', c: { on: boolean; corner: string; size: string }, before: number) => {
    if (!c.on) return null;
    const n = h('div', { class: `pv-notch n-${kind} at-${c.corner}`, 'data-look': look }, [
      h('i', { class: 'pv-notch-bg' }),
      h('div', { class: 'pv-notch-in' }, kind === 'sites' ? [h('i', { class: 's1' }), h('i', { class: 's2' }), h('i', { class: 's3' })] : [h('span', { html: icon('shelf') })]),
    ]);
    n.style.setProperty('--nz', String({ small: 0.7, medium: 0.84, large: 1 }[c.size] ?? 0.7));
    n.style.setProperty('--before', `${before}px`);
    return n;
  };
  const sameCorner = i.frame.sites.on && i.frame.shelf.on && i.frame.sites.corner === i.frame.shelf.corner;
  const pill = miniPill(i.color, { blend: i.blend, glow: 'off', accent, k: 0.8, melt: framed && i.blend, content: [h('span', { class: 'pv-dot' }), h('span', { class: 'pv-text', text: '4:32' })] });
  const screen = h('div', { class: `pv-screen desk${framed ? ' framed' : ''}`, 'data-look': look }, [
    framed ? h('i', { class: 'pv-border' }) : null,
    h('div', { class: 'pv-top' }, [pill]),
    bar,
    notch('sites', i.frame.sites, 0),
    notch('shelf', i.frame.shelf, sameCorner ? 46 : 0),
  ]);
  const where = t.on ? `Taskbar on the ${t.side}${t.edge ? (t.melt ? ', melted into the edge' : ', on the edge') : ', floating'}` : 'No taskbar';
  const extra = [framed ? 'screen border' : null, i.frame.sites.on ? 'Websites notch' : null, i.frame.shelf.on ? 'Shelf notch' : null].filter(Boolean).join(', ');
  return h('div', { class: 'preview' }, [screen, h('div', { class: 'pv-caption', text: extra ? `${where} · ${extra}` : where })]);
}

/** One line of what an activity shows, for its preview. */
const SAMPLES: Record<string, string> = {
  claude: 'Implementing the island UI · 12m',
  codex: 'Codex · refactoring tests',
  cursor: 'Cursor agent · 3 files',
  antigravity: 'Antigravity · thinking',
  music: 'Blinding Lights · The Weeknd',
  timer: '4:32 left',
  battery: '76% · charging',
  downloads: 'report.pdf · 2.4 MB of 8 MB',
  weather: '10° · Cloudy',
  calendar: 'Calculus in 15 min',
  reminders: 'Call mom · 6:00 PM',
  phone: 'Aliyah: are you coming?',
  clipboard: 'Copied',
  system: 'CPU 13% · RAM 42%',
  network: '↓ 7.8 MB/s',
  land: 'photos.zip from MossLaptop',
  shelf: '3 files on the Shelf',
  workspaces: 'School/Class · 54 min today',
};

/** How an activity shows on the island: the pill with its icon and a sample, and what it does, lit. */
export function activityPreview(meta: ActivityMeta, c: ActivityConfig, s: Settings): HTMLElement {
  const accent = accentOf(s);
  const sample = SAMPLES[meta.id] ?? meta.name;
  const pill = miniPill(s.island.color, {
    blend: s.island.blend,
    glow: c.enabled && (meta.id === 'claude' || meta.id === 'codex' || meta.id === 'cursor') ? s.island.glow : 'off',
    accent,
    content: [h('span', { class: `pv-ico ${meta.id}`, html: icon(meta.icon) }), h('span', { class: 'pv-text', text: sample })],
  });
  if (!c.enabled) pill.classList.add('dim');
  const lit = (on: boolean, label: string) => h('span', { class: `pv-chip${on ? ' on' : ''}`, text: label });
  const chips = h('div', { class: 'pv-chips' }, [
    lit(c.autoShow, 'Pops open'),
    lit(c.persistent, 'Stays on the pill'),
    lit(c.interactive, 'Buttons work'),
    lit(c.interrupt, 'Can interrupt'),
  ]);
  const screen = h('div', { class: 'pv-screen island small', 'data-look': s.island.color }, [h('div', { class: 'pv-top' }, [pill])]);
  return h('div', { class: 'preview' }, [screen, chips]);
}

/** What an alert looks like: the island pulsing and Windows' notification, with buttons that play the chimes. */
export function alertPreview(s: Settings, play: (kind: 'done' | 'attention') => void): HTMLElement {
  const accent = accentOf(s);
  const g = s.general;
  const pill = miniPill(s.island.color, {
    blend: s.island.blend,
    glow: s.island.glow === 'off' ? 'off' : 'fast',
    accent,
    content: [h('span', { class: 'pv-ico claude', html: icon('claude') }), h('span', { class: 'pv-text', text: 'Claude needs you' })],
  });
  pill.classList.add('pulse');
  const toast = g.notifications
    ? h('div', { class: 'pv-toast' }, [h('span', { class: 'pv-toast-ico', html: icon('bell') }), h('div', {}, [h('b', { text: 'Island' }), h('span', { text: 'Claude is waiting for your answer.' })])])
    : null;
  const phone = g.phonePush ? h('div', { class: 'pv-phone' }, [h('span', { html: icon('phone') }), h('span', { text: 'Also on your phone' })]) : null;
  const screen = h('div', { class: 'pv-screen alert', 'data-look': s.island.color }, [h('div', { class: 'pv-top' }, [pill]), toast, phone]);
  const tryIt = h('div', { class: 'pv-try' }, [
    h('button', { class: 'btn', html: `${icon('check')}<span>Play “finished”</span>`, onclick: () => play('done') }),
    h('button', { class: 'btn', html: `${icon('alert')}<span>Play “needs you”</span>`, onclick: () => play('attention') }),
  ]);
  return h('div', { class: 'preview' }, [screen, g.sounds ? tryIt : h('div', { class: 'pv-caption', text: 'Sounds are off: alerts are silent.' })]);
}

export { NOTCH_CORNERS };
