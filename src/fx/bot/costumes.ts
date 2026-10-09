// Costume pieces drawn over the bot: headphones, notes, zzz, "shh", a bolt, sweat… Each is static
// SVG markup in a 32 x 32 box laid over the bot (its body spans about 3 to 29 on both axes; pieces
// may reach past the box). Neutral parts use currentColor (the pill's text colour, so they read
// on dark and light pills); `--bot-eye` is the bot's eye colour. Their animations are CSS classes
// in island.css (`.c-…`), transform and opacity only.

export type CostumeId =
  | 'headphones' | 'headphones-down' | 'notes' | 'notes-burst' | 'zzz' | 'shh' | 'waves'
  | 'speaker' | 'speaker-off' | 'bolt' | 'zap' | 'battery-low' | 'battery-empty' | 'battery-full'
  | 'sparkle' | 'sweat' | 'heat' | 'cloud-off' | 'wifi' | 'sunglasses' | 'plug' | 'bye' | 'swirl'
  | 'rec' | 'mic-off' | 'flash' | 'clipboard' | 'box' | 'arrow-down' | 'clock' | 'tomato' | 'alarm'
  | 'umbrella' | 'controller' | 'code' | 'confetti' | 'coin' | 'new' | 'yawn';

const FONT = 'Segoe UI, system-ui, sans-serif';

/** An eighth note with its head at (x, y). */
function note(x: number, y: number, fill: string, cls: string): string {
  return `<g class="${cls}" fill="${fill}"><ellipse cx="${x}" cy="${y}" rx="1.9" ry="1.45" transform="rotate(-20 ${x} ${y})"/><rect x="${x + 1.3}" y="${y - 6.4}" width="0.9" height="6.4"/><path d="M${x + 2.2} ${y - 6.4}q2.4 1.3 2.5 3.5q-1-1.5-2.5-1.8z"/></g>`;
}

/** A small battery at the top right, `level` 0..1 full. */
function battery(level: number, colour: string, cls: string): string {
  return `<g class="${cls}" transform="translate(21.5 -3.5)"><rect x="0.5" y="0.5" width="8.6" height="5" rx="1.2" fill="#14141a" stroke="currentColor" stroke-width="0.9"/><rect x="9.4" y="2" width="1.3" height="2" rx="0.4" fill="currentColor"/><rect x="1.6" y="1.6" width="${(6.4 * level).toFixed(2)}" height="2.8" rx="0.6" fill="${colour}"/></g>`;
}

/** A four-point star. */
function star(x: number, y: number, r: number, cls: string): string {
  return `<path class="${cls}" d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}z" fill="#fff6c7"/>`;
}

/** A little white speech bubble at the top right with a word in it. */
function word(text: string, fill = '#fff', ink = '#1a1a1f', width = 12): string {
  const x = 32.5 - width;
  return `<g class="c-pop"><rect x="${x}" y="-4.5" width="${width}" height="7" rx="3.5" fill="${fill}"/><text x="${x + width / 2}" y="0.7" text-anchor="middle" font-size="5" font-weight="800" font-family="${FONT}" fill="${ink}">${text}</text></g>`;
}

const SPEAKER = '<path d="M0 2.5h2l3-2.5v8l-3-2.5h-2z" fill="currentColor"/>';
const BOLT = 'l-4 6.6h3.1l-2.3 6 6.2-8h-3.3l2.6-4.6z';

const CONFETTI: Array<[string, number, number, number]> = [
  ['#ff7aa2', -9, -10, 20],
  ['#ffd34d', 10, -11, -30],
  ['#6cb0f2', -12, -2, 45],
  ['#5fd39b', 12, -3, -15],
  ['#c4a8ff', -4, -13, 70],
  ['#ff8a5b', 5, -14, -60],
];

const RAW: Record<CostumeId, string> = {
  headphones:
    '<g class="c-headphones"><path d="M3.6 18C3.6 3.2 28.4 3.2 28.4 18" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><rect x="0.4" y="14" width="5" height="9" rx="2.5" fill="#ff7aa2"/><rect x="26.6" y="14" width="5" height="9" rx="2.5" fill="#ff7aa2"/></g>',
  'headphones-down':
    '<g class="c-slide-down"><path d="M4.5 25C4.5 34.5 27.5 34.5 27.5 25" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="1.6" y="23" width="5" height="8" rx="2.5" fill="#ff7aa2"/><rect x="25.4" y="23" width="5" height="8" rx="2.5" fill="#ff7aa2"/></g>',
  notes: note(27, 6, '#ffd27a', 'c-float c-n1') + note(2.5, 9, '#9fe3ff', 'c-float c-n2'),
  'notes-burst': note(26, 8, '#ffd27a', 'c-burst c-b1') + note(4, 8, '#9fe3ff', 'c-burst c-b2') + note(15, 2, '#ff9fd0', 'c-burst c-b3'),
  zzz:
    '<g fill="none" stroke="#cfd3ff" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"><path class="c-z c-z1" d="M22.5 8.5h2.6l-2.6 3h2.6"/><path class="c-z c-z2" d="M25.5 4.5h3.2l-3.2 3.7h3.2"/><path class="c-z c-z3" d="M28.8 0h3.8l-3.8 4.4h3.8"/></g>',
  shh: `<g class="c-pop"><path d="M21-4.5h10a3.6 3.6 0 0 1 0 7.2h-6.5l-2.6 2.4v-2.4h-0.9a3.6 3.6 0 0 1 0-7.2z" fill="#fff"/><text x="26" y="0.6" text-anchor="middle" font-size="5.2" font-weight="800" font-family="${FONT}" fill="#1a1a1f">shh</text></g>`,
  waves:
    '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path class="c-wave c-w1" d="M29.5 12.5q2.6 3.5 0 7"/><path class="c-wave c-w2" d="M32 10q4 6 0 12"/></g>',
  speaker: `<g class="c-pop" transform="translate(22 -4)">${SPEAKER}<path d="M6.6 1.6q1.6 2.4 0 4.8M8.4 0.2q2.7 3.8 0 7.6" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></g>`,
  'speaker-off': `<g class="c-pop" transform="translate(22 -4)">${SPEAKER}<path d="M6.5 2l3 3.5m0-3.5l-3 3.5" stroke="#ff6b6b" stroke-width="1.3" stroke-linecap="round"/></g>`,
  bolt: `<path class="c-glow" d="M27.5-3.5${BOLT}" fill="#ffd34d" stroke="#b8860b" stroke-width="0.4" stroke-linejoin="round"/>`,
  zap: '<path class="c-zap" d="M18-6l-5.5 9h4.2l-3.2 8.5 8.5-11h-4.6l3.6-6.5z" fill="#ffd34d" stroke="#b8860b" stroke-width="0.5" stroke-linejoin="round"/>',
  'battery-low': battery(0.25, '#ffb34d', 'c-pop'),
  'battery-empty': battery(0.12, '#ff5a52', 'c-blink'),
  'battery-full': battery(1, '#5fd39b', 'c-pop'),
  sparkle: star(28, 3, 3, 'c-twinkle c-t1') + star(3, 7, 2.2, 'c-twinkle c-t2') + star(26, 28, 2, 'c-twinkle c-t3'),
  sweat: '<path class="c-sweat" d="M5.2 5.5q-2.6 3.6 0 5.1q2.6-1.5 0-5.1z" fill="#8fd3ff"/>',
  heat:
    '<g fill="none" stroke="#ff8a5b" stroke-width="1.1" stroke-linecap="round"><path class="c-steam c-s1" d="M11 0q-1.2-1.8 0-3.6q1.2-1.8 0-3.6"/><path class="c-steam c-s2" d="M16-0.5q-1.2-1.8 0-3.6q1.2-1.8 0-3.6"/><path class="c-steam c-s3" d="M21 0q-1.2-1.8 0-3.6q1.2-1.8 0-3.6"/></g>',
  'cloud-off':
    '<g class="c-drift" transform="translate(19 -5)"><path d="M3 7.5h7.2a2.6 2.6 0 0 0 0-5.2a3.6 3.6 0 0 0-6.8-0.6a2.9 2.9 0 0 0-0.4 5.8z" fill="#9aa3b2"/><path d="M1.5 0.8l10 8" stroke="#ff6b6b" stroke-width="1.2" stroke-linecap="round"/></g>',
  wifi: '<g class="c-pop" transform="translate(16 1)" fill="none" stroke="#5fd39b" stroke-width="1.4" stroke-linecap="round"><path d="M-6-2.5a8.5 8.5 0 0 1 12 0"/><path d="M-3.6 0a5 5 0 0 1 7.2 0"/><circle cx="0" cy="2.4" r="0.9" fill="#5fd39b" stroke="none"/></g>',
  sunglasses:
    '<g class="c-drop-in"><path d="M7 12.6h18" stroke="#0d0d10" stroke-width="1.1"/><rect x="7.5" y="11.6" width="7.4" height="5.2" rx="2.2" fill="#0d0d10"/><rect x="17.1" y="11.6" width="7.4" height="5.2" rx="2.2" fill="#0d0d10"/><path d="M9 12.9h2" stroke="#fff" stroke-opacity=".5" stroke-width=".7" stroke-linecap="round"/></g>',
  plug: '<g class="c-pop" transform="translate(23 -5)"><rect x="1.5" y="5" width="5" height="5" rx="1" fill="currentColor"/><rect x="2.5" y="1.5" width="3" height="4" fill="#9aa3b2"/><path d="M4 10v2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></g>',
  bye: word('bye'),
  swirl:
    '<g class="c-spin" transform="translate(16 -1)"><path d="M-3.5 0a3.5 3.5 0 1 0 7 0a2.4 2.4 0 1 0-4.8 0a1.2 1.2 0 1 0 2.4 0" fill="none" stroke="#c4a8ff" stroke-width="1.1" stroke-linecap="round"/></g>',
  rec: '<circle class="c-rec" cx="4" cy="3.5" r="2.4" fill="#ff4d4d"/>',
  'mic-off':
    '<g class="c-pop" transform="translate(24 -5)"><rect x="1.6" y="0" width="3.4" height="6" rx="1.7" fill="currentColor"/><path d="M0.4 4.2a2.9 2.9 0 0 0 5.8 0M3.3 7.2v1.8" fill="none" stroke="currentColor" stroke-width="0.9" stroke-linecap="round"/><path d="M-0.5 0l7.6 8.6" stroke="#ff6b6b" stroke-width="1.2" stroke-linecap="round"/></g>',
  flash: '<circle class="c-flash" cx="16" cy="16" r="19" fill="#fff"/>',
  clipboard:
    '<g class="c-catch" transform="translate(22 -4)"><rect x="0.5" y="1.2" width="7.6" height="9.4" rx="1.4" fill="#f4efe6" stroke="currentColor" stroke-width="0.6"/><rect x="2.4" y="0" width="3.8" height="2.4" rx="0.8" fill="#9aa3b2"/><path d="M2.2 5h4.2M2.2 7.2h3" stroke="#9aa3b2" stroke-width="0.8" stroke-linecap="round"/></g>',
  box: '<g class="c-fall" transform="translate(12 -6)"><path d="M0 2.4l4-2.4 4 2.4v5l-4 2.4-4-2.4z" fill="#d9a066"/><path d="M0 2.4l4 2.4 4-2.4M4 4.8v5" fill="none" stroke="#8a5a2b" stroke-width="0.7"/></g>',
  'arrow-down':
    '<g class="c-bob" transform="translate(16 -2)"><path d="M0-4v6.5M-3 0l3 3.2 3-3.2" fill="none" stroke="#6cb0f2" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></g>',
  clock:
    '<g class="c-pop" transform="translate(27 0)"><circle r="4.2" fill="#f4efe6" stroke="currentColor" stroke-width="0.8"/><path d="M0-2.5v2.6l1.8 1.2" fill="none" stroke="#1a1a1f" stroke-width="0.9" stroke-linecap="round"/></g>',
  tomato:
    '<g class="c-pop" transform="translate(27 0)"><circle r="3.8" fill="#ff5a4e"/><path d="M-1.8-3.6l1.8 1.2 1.8-1.2M0-2.4v-1.6" fill="none" stroke="#3fae5a" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><circle cx="-1.3" cy="-1" r="0.8" fill="#fff" fill-opacity=".5"/></g>',
  alarm:
    '<g class="c-ring" transform="translate(16 -2)"><circle r="4.4" fill="#ffd34d" stroke="#b8860b" stroke-width="0.6"/><path d="M0-2.6v2.6l1.6 1" fill="none" stroke="#1a1a1f" stroke-width="0.9" stroke-linecap="round"/><path d="M-6.5-3.5l-2-1.6M6.5-3.5l2-1.6M-7 0h-2.4M7 0h2.4" stroke="#ffd34d" stroke-width="1" stroke-linecap="round"/></g>',
  umbrella:
    '<g class="c-drop-in"><path d="M4 6.5a12 7.5 0 0 1 24 0q-2-1.6-4 0q-2-1.6-4 0q-2-1.6-4 0q-2-1.6-4 0q-2-1.6-4 0q-2-1.6-4 0z" fill="#7b8cff"/><path d="M16-1v1.5" stroke="#7b8cff" stroke-width="1.2" stroke-linecap="round"/></g><g stroke="#8fd3ff" stroke-width="0.9" stroke-linecap="round"><path class="c-rain c-r1" d="M1.5 9l-0.6 1.8"/><path class="c-rain c-r2" d="M30.5 11l-0.6 1.8"/><path class="c-rain c-r3" d="M0.5 16l-0.6 1.8"/></g>',
  controller:
    '<g class="c-pop" transform="translate(16 25.5)"><path d="M-6-2.6h12a3.4 3.4 0 0 1 3.1 4.7l-1 2.3a1.8 1.8 0 0 1-3 .3l-1.7-2h-6.8l-1.7 2a1.8 1.8 0 0 1-3-.3l-1-2.3a3.4 3.4 0 0 1 3.1-4.7z" fill="#2d2d36" stroke="currentColor" stroke-width="0.6"/><path d="M-5.6 0.2h2.6M-4.3-1.1v2.6" stroke="#cfd3ff" stroke-width="0.8" stroke-linecap="round"/><circle cx="4" cy="-0.6" r="0.7" fill="#ff7aa2"/><circle cx="5.6" cy="0.8" r="0.7" fill="#6cb0f2"/></g>',
  code: `<g class="c-pop"><rect x="20" y="-4.5" width="12.5" height="7" rx="2" fill="#2d2d36"/><text x="26.25" y="0.7" text-anchor="middle" font-size="5.2" font-weight="700" font-family="Consolas, monospace" fill="#7ee0a1">&lt;/&gt;</text></g>`,
  confetti: CONFETTI.map(([c, dx, dy, r], i) => `<rect class="c-confetti" style="--dx:${dx}px;--dy:${dy}px;--r:${r}deg;animation-delay:${i * 30}ms" x="15" y="12" width="2.2" height="3.2" rx="0.5" fill="${c}"/>`).join(''),
  coin: `<g class="c-coin" transform="translate(26 -2)"><circle r="4" fill="#ffd34d" stroke="#b8860b" stroke-width="0.7"/><text y="1.9" text-anchor="middle" font-size="5.4" font-weight="800" font-family="${FONT}" fill="#8a5a00">$</text></g>`,
  new: word('new!', '#ff7aa2', '#fff', 12.5),
  yawn: '<ellipse class="c-yawn" cx="16" cy="21.5" rx="2.4" ry="3" fill="var(--bot-eye, #17120e)"/>',
};

/**
 * A CSS animation's transform replaces an element's transform attribute, so a piece placed with
 * one is moved inside an outer group that keeps its place, the animation on the inner group.
 */
function placed(svg: string): string {
  const m = /^<g class="([^"]+)" transform="([^"]+)"/.exec(svg);
  return m ? `<g transform="${m[2]}"><g class="${m[1]}"${svg.slice(m[0].length)}</g>` : svg;
}

export const COSTUMES = Object.fromEntries(Object.entries(RAW).map(([id, svg]) => [id, placed(svg)])) as Record<CostumeId, string>;
