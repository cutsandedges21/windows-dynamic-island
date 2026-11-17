// The music player the pill grows into on hover, laid out like an iPhone's Dynamic Island:
// the art and the track with the bars beside them, the time on either side of a scrubber,
// and rewind, play or pause, and forward, with the sound output at the end; clicking the art
// brings the app playing forward. A card block (sheet.ts), patched in place every second so
// the bars and a drag on the scrubber survive.

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
  /** What the buttons do; `seek` gets the seconds to jump to, `open` is clicking the art (the app playing comes forward). */
  actions: { prev: string; toggle: string; next: string; seek?: string; output?: string; open?: string };
  /** The output button's look: headphones or a speaker, and the device's name. */
  output?: { icon: string; tip: string };
  /** The line being sung: '' between lines, null (no space) when the song has no synced lyrics. */
  lyric?: string | null;
  /**
   * The lyrics panel beside the player, while it is open: every line of the song, and the one being
   * sung (-1 before the first), which sits a third of the way down and glides up as the song goes.
   * `note` says why there are none (still looking, or the song has none); `close` is its back arrow.
   * `split` is dragging the line between the player and the lyrics (it gets the panel's new width in
   * px), like the line between two apps side by side on Windows; `width` is where it was left.
   */
  lyrics?: { lines: string[]; at: number; note?: string; close?: string; split?: string; width?: number | null } | null;
  /** The lyrics button at the controls' start (only when the song has synced lyrics): `on` while the panel is open. */
  lyricsButton?: { action: string; on: boolean } | null;
  /** Control Center's media card: the art big over the track, the lyrics beside, on the art's colour (`tint`). */
  stage?: { tint: string | null } | null;
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
  tx.append(make('span', 'pl-t1'), make('span', 'pl-t2'), make('span', 'pl-lyric'));
  // The same bars as the pill's: the music activity paints every `.seg-bars` from the speakers.
  const bars = make('span', 'seg-bars pl-bars');
  for (let i = 0; i < 6; i++) bars.append(make('i', ''));
  top.append(art, tx, bars);

  const scrub = make('div', 'pl-scrub');
  const track = make('span', 'pl-track');
  track.append(make('i', 'pl-fill'));
  scrub.append(make('span', 'pl-time pl-now'), track, make('span', 'pl-time pl-left'));

  const ctl = make('div', 'pl-ctl');
  const gap = make('span', 'pl-gap');
  gap.append(button('pl-lyr', 'chat', 'Lyrics'));
  ctl.append(gap, button('pl-prev', 'rewind', 'Previous'), button('pl-toggle', 'pause-fill', 'Pause'), button('pl-next', 'forward', 'Next'), button('pl-out', 'headphones', 'Sound output'));
  const main = make('div', 'pl-main');
  main.append(top, scrub, ctl);
  // The lyrics panel: a window onto the song's lines, which glide up through it as they are sung.
  const panel = make('div', 'pl-ly');
  panel.hidden = true;
  const close = button('pl-ly-close', 'chevron-left', 'Close lyrics');
  const view = make('div', 'pl-ly-view');
  view.append(make('div', 'pl-ly-list'));
  const grip = make('div', 'pl-ly-grip');
  grip.title = 'Drag to make the lyrics wider or narrower';
  panel.append(close, view, make('div', 'pl-ly-note'), grip);
  e.append(main, panel);
  // Pressing either lyrics button notes where the player is, for the glide when the panel closes.
  for (const b of [ctl.querySelector('.pl-lyr'), close]) b?.addEventListener('pointerdown', () => (main.dataset.x0 = String(main.getBoundingClientRect().left)));
  wireScrub(e, track, act);
  wireGrip(e, panel, grip, act);
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
  bind(art, b.actions.open, undefined);
  e.querySelector('.pl-t1')!.textContent = b.title;
  e.querySelector('.pl-t2')!.textContent = b.artist;
  e.querySelector('.pl-t2')!.toggleAttribute('hidden', !b.artist);
  // With the panel open the line is in the panel, not under the track.
  showLyric(e.querySelector<HTMLElement>('.pl-lyric')!, b.lyrics ? null : b.lyric);
  showLyrics(e, b, bind);
  e.classList.toggle('stage', Boolean(b.stage));
  e.style.setProperty('--tint', b.stage?.tint ?? 'var(--accent)');
  const lyr = e.querySelector<HTMLElement>('.pl-lyr')!;
  lyr.hidden = !b.lyricsButton;
  lyr.classList.toggle('on', Boolean(b.lyricsButton?.on));
  lyr.title = b.lyricsButton?.on ? 'Hide lyrics' : 'Lyrics';
  bind(lyr, b.lyricsButton?.action, undefined);
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

/** The lyrics panel: the song's lines (rebuilt only for a new song), the sung one lit and glided to a third of the way down. */
function showLyrics(e: HTMLElement, b: PlayerBlock, bind: Bind): void {
  const panel = e.querySelector<HTMLElement>('.pl-ly')!;
  const ly = b.lyrics;
  // Closing: the card narrows around the player, which would land in its new place at once; it
  // glides there from where it was instead, as it glides aside when the panel opens.
  const main = e.querySelector<HTMLElement>('.pl-main')!;
  const closing = !ly && !panel.hidden && e.isConnected && !e.classList.contains('stage');
  // Where it was when the button was pressed: by this patch the card has already taken its new width.
  const x0 = Number(main.dataset.x0);
  delete main.dataset.x0;
  panel.hidden = !ly;
  e.classList.toggle('lyrics-open', Boolean(ly));
  if (closing && Number.isFinite(x0)) {
    const dx = x0 - main.getBoundingClientRect().left;
    if (Math.abs(dx) > 0.5) main.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }

  if (!ly) {
    panel.style.flexBasis = '';
    return;
  }

  // Where the line between player and lyrics was left (not while it is being dragged).
  panel.dataset.split = ly.split ?? '';
  if (!panel.dataset.dragging) panel.style.flexBasis = ly.width ? `${ly.width}px` : '';
  const closer = panel.querySelector<HTMLElement>('.pl-ly-close')!;
  closer.hidden = !ly.close;
  bind(closer, ly.close, undefined);
  const note = panel.querySelector<HTMLElement>('.pl-ly-note')!;
  note.textContent = ly.lines.length ? '' : (ly.note ?? '');
  note.hidden = Boolean(ly.lines.length);
  const list = panel.querySelector<HTMLElement>('.pl-ly-list')!;
  const sig = ly.lines.join('\n');
  if (list.dataset.sig !== sig) {
    list.dataset.sig = sig;
    list.replaceChildren(...ly.lines.map((text) => make('div', `pl-ly-line${text ? '' : ' gap'}`, text || '♪')));
    list.style.transition = 'none';
    list.dataset.at = '';
  }
  const at = Math.min(ly.at, ly.lines.length - 1);
  // Placed again when the line moves on, or when the panel's width changed (its split was dragged: the lines wrap anew).
  const placed = `${at}|${panel.querySelector<HTMLElement>('.pl-ly-view')!.clientWidth}`;
  if (list.dataset.at === placed) return;
  list.dataset.at = placed;
  const rows = Array.from(list.children) as HTMLElement[];
  rows.forEach((r, i) => {
    r.classList.toggle('now', i === at);
    r.classList.toggle('past', i < at);
  });
  // Laid out already (the panel is in the card): the sung line a third of the way down the window.
  const view = panel.querySelector<HTMLElement>('.pl-ly-view')!;
  // Not laid out yet (the card is being built): the next patch, a second on, places it.
  if (!view.clientHeight) {
    list.dataset.at = '';
    return;
  }
  const line = rows[Math.max(0, at)];
  const y = line ? line.offsetTop + line.offsetHeight / 2 - view.clientHeight / 3 : 0;
  list.style.transform = `translateY(${-Math.max(0, Math.round(y))}px)`;
  if (list.style.transition === 'none') {
    void list.offsetWidth;
    list.style.transition = '';
  }
}

/** The sung line, cross-faded when it changes; no space at all without lyrics. */

function showLyric(box: HTMLElement, line: string | null | undefined): void {
  box.hidden = line == null;
  const text = line ?? '';
  if (box.dataset.text === text) return;
  box.dataset.text = text;
  if (box.hidden) {
    box.replaceChildren();
    return;
  }
  for (const old of Array.from(box.children)) {
    old.classList.add('out');
    setTimeout(() => old.remove(), 400);
  }
  box.append(make('span', '', text));
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

/** The narrowest the lyrics and the player get when the line between them is dragged. */
const LYRICS_MIN = 200;
// The player squeezes to its art, title and buttons (player.css drops the bars and chips under 250 px).
const PLAYER_MIN = 200;
/** How close to the card's middle the line has to come to snap onto it, px. */
const SPLIT_SNAP = 22;

/**
 * Dragging the line between the player and the lyrics: the lyrics get wider or narrower and the
 * player takes the rest, the card keeping its width (like two apps side by side on Windows).
 * Letting go tells the activity, which keeps the split until the lyrics close.
 */
function wireGrip(e: HTMLElement, panel: HTMLElement, grip: HTMLElement, act: Act): void {
  let id: number | null = null;
  let x0 = 0;
  let w0 = 0;
  let w = 0;
  const widthAt = (x: number) => {
    const gap = parseFloat(getComputedStyle(panel).marginLeft) || 0;
    const most = e.clientWidth - gap - PLAYER_MIN;
    const want = Math.max(LYRICS_MIN, Math.min(most, w0 - (x - x0)));
    // Near the middle the line snaps onto it, like a magnet (Justin), and lets go once pulled past.
    const middle = e.clientWidth / 2;
    const snapped = Math.abs(want - middle) <= SPLIT_SNAP && middle >= LYRICS_MIN && middle <= most;
    e.classList.toggle('split-middle', snapped);
    return Math.round(snapped ? middle : want);
  };
  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !panel.dataset.split) return;
    ev.stopPropagation();
    ev.preventDefault();
    id = ev.pointerId;
    grip.setPointerCapture(id);
    x0 = ev.clientX;
    w0 = w = panel.getBoundingClientRect().width;
    panel.dataset.dragging = '1';
    e.classList.add('splitting');
    // The card stays open and keeps the pointer, past its edges too, till the line is let go.
    e.dispatchEvent(new CustomEvent('island-hold', { bubbles: true, detail: true }));
  });
  grip.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== id) return;
    w = widthAt(ev.clientX);
    panel.style.flexBasis = `${w}px`;
  });
  const end = (ev: PointerEvent, commit: boolean) => {
    if (ev.pointerId !== id) return;
    id = null;
    delete panel.dataset.dragging;
    e.classList.remove('splitting', 'split-middle');
    e.dispatchEvent(new CustomEvent('island-hold', { bubbles: true, detail: false }));
    const split = panel.dataset.split;
    if (!commit) panel.style.flexBasis = `${w0}px`;
    else if (split) act(split, w, grip);
  };
  grip.addEventListener('pointerup', (ev) => end(ev, true));
  grip.addEventListener('pointercancel', (ev) => end(ev, false));
  // The press is the line's: it must not also count as a click on the card.
  grip.addEventListener('click', (ev) => ev.stopPropagation());
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
