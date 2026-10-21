// The music player the pill grows into on hover, laid out like an iPhone's Dynamic Island:
// the art and the track with the bars beside them, the time on either side of a scrubber,
// and rewind, play or pause, and forward, with the sound output at the end. A card block
// (sheet.ts), patched in place every second so the bars and a drag on the scrubber survive.

import { icon } from './icons';

export interface PlayerBlock {
  t: 'player';
  key: string;
  art: string | null;
  title: string;
  artist: string;
  playing: boolean;
  /** Seconds into the track and its length; null when the app playing it does not say. */
  position: number | null;
  duration: number | null;
  /** The bars' colour, from the art (artcolor.ts); null keeps the accent. */
  color: string | null;
  /** What the buttons do; `seek` gets the seconds to jump to. */
  actions: { prev: string; toggle: string; next: string; seek?: string; output?: string };
  /** The output button's look: headphones or a speaker, and the device's name. */
  output?: { icon: string; tip: string };
}

type Bind = (e: HTMLElement, action: string | undefined, arg: unknown) => void;
type Act = (action: string, arg: unknown, source: HTMLElement) => void;

/** "1:05", or "1:02:05" past an hour; a leading "−" for the time left. */
export function trackTime(secs: number, left = false): string {
  const t = Math.max(0, Math.round(secs));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  return left ? `−${body}` : body;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, glyph: string, tip: string): HTMLButtonElement {
  const b = make('button', `pl-btn ${cls}`);
  b.type = 'button';
  b.title = tip;
  b.innerHTML = icon(glyph); // static markup from icons.ts
  return b;
}

export function buildPlayer(b: PlayerBlock, bind: Bind, act: Act): HTMLElement {
  const e = make('div', 'sb sb-player');
  const top = make('div', 'pl-top');
  const art = make('span', 'pl-art');
  const tx = make('span', 'pl-tx');
  tx.append(make('span', 'pl-t1'), make('span', 'pl-t2'));
  // The same bars as the pill's: the music activity paints every `.seg-bars` from the speakers.
  const bars = make('span', 'seg-bars pl-bars');
  for (let i = 0; i < 6; i++) bars.append(make('i', ''));
  top.append(art, tx, bars);

  const scrub = make('div', 'pl-scrub');
  const track = make('span', 'pl-track');
  track.append(make('i', 'pl-fill'));
  scrub.append(make('span', 'pl-time pl-now'), track, make('span', 'pl-time pl-left'));

  const ctl = make('div', 'pl-ctl');
  ctl.append(make('span', 'pl-gap'), button('pl-prev', 'rewind', 'Previous'), button('pl-toggle', 'pause-fill', 'Pause'), button('pl-next', 'forward', 'Next'), button('pl-out', 'headphones', 'Sound output'));
  e.append(top, scrub, ctl);
  wireScrub(e, track, act);
  patchPlayer(e, b, bind);
  return e;
}

/** Everything that changes, in place: the art only when its source does, the fill without a jump. */
export function patchPlayer(e: HTMLElement, b: PlayerBlock, bind: Bind): void {
  const art = e.querySelector<HTMLElement>('.pl-art')!;
  const src = b.art ?? '';
  if (art.dataset.src !== src || !art.firstChild) {
    art.dataset.src = src;
    if (src) {
      const img = make('img', '');
      img.alt = '';
      img.decoding = 'async';
      img.src = src;
      art.replaceChildren(img);
    } else art.innerHTML = icon('music');
  }
  e.querySelector('.pl-t1')!.textContent = b.title;
  e.querySelector('.pl-t2')!.textContent = b.artist;
  e.querySelector('.pl-t2')!.toggleAttribute('hidden', !b.artist);
  e.classList.toggle('playing', b.playing);
  e.style.setProperty('--bar', b.color ?? 'var(--accent)');
  e.querySelector('.pl-bars')!.classList.toggle('active', b.playing);

  // Not interactive (Activities › Music): the player only shows.
  e.querySelector<HTMLElement>('.pl-ctl')!.hidden = !b.actions.toggle;
  const toggle = e.querySelector<HTMLElement>('.pl-toggle')!;
  const glyph = b.playing ? 'pause-fill' : 'play-fill';
  if (toggle.dataset.glyph !== glyph) {
    toggle.dataset.glyph = glyph;
    toggle.innerHTML = icon(glyph);
  }
  toggle.title = b.playing ? 'Pause' : 'Play';
  bind(toggle, b.actions.toggle, undefined);
  bind(e.querySelector<HTMLElement>('.pl-prev')!, b.actions.prev, undefined);
  bind(e.querySelector<HTMLElement>('.pl-next')!, b.actions.next, undefined);
  const out = e.querySelector<HTMLElement>('.pl-out')!;
  out.hidden = !b.actions.output;
  if (b.actions.output) {
    bind(out, b.actions.output, undefined);
    const look = b.output?.icon ?? 'headphones';
    if (out.dataset.glyph !== look) {
      out.dataset.glyph = look;
      out.innerHTML = icon(look);
    }
    out.title = b.output?.tip ?? 'Sound output';
  }

  const scrub = e.querySelector<HTMLElement>('.pl-scrub')!;
  const known = b.duration != null && b.duration > 0 && b.position != null;
  scrub.hidden = !known;
  scrub.dataset.seek = b.actions.seek ?? '';
  scrub.dataset.duration = String(b.duration ?? 0);
  if (!known || scrub.classList.contains('dragging')) return;
  showTime(e, b.position!, b.duration!, b.playing);
}

/** The time either side and the fill; a small step forward glides, anything else jumps. */
function showTime(e: HTMLElement, pos: number, dur: number, playing: boolean): void {
  const fill = e.querySelector<HTMLElement>('.pl-fill')!;
  const v = Math.max(0, Math.min(1, pos / dur));
  const was = Number(fill.dataset.v ?? -1);
  const glide = playing && v >= was && v - was < 2 / Math.max(1, dur);
  fill.style.transition = glide ? '' : 'none';
  fill.style.transform = `scaleX(${v})`;
  fill.dataset.v = String(v);
  if (!glide) void fill.offsetWidth; // the jump lands before the glide comes back
  fill.style.transition = '';
  e.querySelector('.pl-now')!.textContent = trackTime(pos);
  e.querySelector('.pl-left')!.textContent = trackTime(dur - pos, true);
}

/** Press or drag on the scrubber to move through the track; letting go jumps there. */
function wireScrub(e: HTMLElement, track: HTMLElement, act: Act): void {
  const scrub = () => e.querySelector<HTMLElement>('.pl-scrub')!;
  const at = (x: number) => {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0;
  };
  let id: number | null = null;
  track.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !scrub().dataset.seek) return;
    ev.stopPropagation();
    id = ev.pointerId;
    track.setPointerCapture(id);
    scrub().classList.add('dragging');
    const dur = Number(scrub().dataset.duration) || 0;
    showTime(e, at(ev.clientX) * dur, dur, false);
  });
  track.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== id) return;
    const dur = Number(scrub().dataset.duration) || 0;
    showTime(e, at(ev.clientX) * dur, dur, false);
  });
  const end = (ev: PointerEvent, commit: boolean) => {
    if (ev.pointerId !== id) return;
    id = null;
    scrub().classList.remove('dragging');
    const seek = scrub().dataset.seek;
    const dur = Number(scrub().dataset.duration) || 0;
    if (commit && seek && dur > 0) act(seek, Math.round(at(ev.clientX) * dur * 10) / 10, track);
  };
  track.addEventListener('pointerup', (ev) => end(ev, true));
  track.addEventListener('pointercancel', (ev) => end(ev, false));
  // The press is the scrubber's: it must not also count as a click on the card.
  track.addEventListener('click', (ev) => ev.stopPropagation());
}
