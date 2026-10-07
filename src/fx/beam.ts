// attachBorderBeam: a light that travels along the border of a rounded element.
//
// Technique (from the Libraries.dev border-beam idea, MIT, Jakub Antalik, rebuilt for a pill):
// an overlay holds an SVG of stacked, dashed rounded-rect strokes. The strokes use
// pathLength=100, so the dash pattern is measured in percent of the perimeter and the beam keeps
// a constant speed and relative length on any rectangle, wide pill or square (a rotating conic
// gradient would crawl on the caps and race along the long edges). One CSS animation moves the
// dashes, and nothing runs in JavaScript per frame.
//
// It keeps working while the host's width, height and border-radius change every frame:
//  - the rect's x/y/width/height are CSS percentages of the overlay, so size changes follow for
//    free in the same frame (the overlay is inset:0 and inherits the host's border-radius);
//  - the corner radius cannot be a percentage, so a ResizeObserver (every size change) and a
//    MutationObserver (inline style or class changes) re-read the host's radius and publish it
//    as --rx/--ry, clamped exactly like CSS clamps overlapping radii.
//
// Cost model: nothing exists in the render tree until start(); stop() fades out then removes the
// overlay from rendering (display:none cancels the animation); while running the animation is
// paused whenever the host is detached, off screen or the page is hidden. The overlay is its own
// compositing layer (will-change: opacity), so its repaints never touch the host's content, and
// the fades are opacity transitions. Under prefers-reduced-motion it shows a calm steady ring.

import { VisibilityGate } from './visibility';

export interface BorderBeamOptions {
  /** Any CSS colour. Defaults to the island accent (var(--accent)), ember when it is unset. */
  color?: string;
  /** Thickness of the lit border in px. Default 1.6. */
  size?: number;
  /** Seconds per lap. Default 2. */
  duration?: number;
}

export interface BorderBeam {
  /** Fades the beam in and starts it travelling. */
  start(): void;
  /** Fades it out; afterwards it costs nothing until start() is called again. */
  stop(): void;
  /** Removes the overlay and every observer. Safe to call twice. */
  destroy(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const STYLE_ID = 'fx-beam-style';
const FADE_MS = 350;

const DEFAULT_COLOR = 'var(--accent, #e8845f)';
const DEFAULT_SIZE = 1.6;
const DEFAULT_DURATION = 2;

/** The lit stretch as a share of the whole perimeter. */
const BEAM_SHARE = 0.3;

// Each layer is a stack of dashes with the same head and growing length, which reads as a tail
// fading out behind the head. `share` scales the layer's longest dash.
const LAYERS = [
  { name: 'bloom', count: 5, share: 1, opacity: 0.2 },
  { name: 'core', count: 10, share: 1, opacity: 0.14 },
  { name: 'hot', count: 4, share: 0.4, opacity: 0.3 },
] as const;

const CSS = `
.fx-beam{position:absolute;inset:0;border-radius:inherit;pointer-events:none;overflow:hidden;display:none;opacity:0;transition:opacity ${FADE_MS}ms ease;will-change:opacity}
.fx-beam[data-on]{opacity:1}
.fx-beam svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.fx-beam rect{fill:none;stroke-linecap:round;x:calc(var(--w) / 2);y:calc(var(--w) / 2);width:calc(100% - var(--w));height:calc(100% - var(--w));rx:var(--rx,0px);ry:var(--ry,0px);stroke:var(--c);animation:fx-beam-run var(--dur) linear infinite}
.fx-beam .core rect{stroke-width:var(--w)}
.fx-beam .hot rect{stroke:var(--hot);stroke-width:var(--w)}
.fx-beam .bloom{filter:blur(2.5px)}
.fx-beam .bloom rect{stroke-width:calc(var(--w) * 3)}
.fx-beam[data-paused] rect{animation-play-state:paused}
@keyframes fx-beam-run{from{stroke-dashoffset:var(--from)}to{stroke-dashoffset:calc(var(--from) - 100)}}
@media (prefers-reduced-motion:reduce){
.fx-beam rect{animation:none;stroke-dasharray:none!important}
.fx-beam .bloom,.fx-beam .hot{display:none}
.fx-beam .core rect{stroke-opacity:.05!important}
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function buildOverlay(color: string, size: number, duration: number): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'fx-beam';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.setProperty('--c', color);
  overlay.style.setProperty('--hot', `color-mix(in srgb, ${color} 35%, white)`);
  overlay.style.setProperty('--w', `${size}px`);
  overlay.style.setProperty('--dur', `${duration}s`);

  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const layer of LAYERS) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', layer.name);
    const longest = BEAM_SHARE * 100 * layer.share;
    for (let step = 1; step <= layer.count; step++) {
      const length = (longest * step) / layer.count;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('pathLength', '100');
      rect.style.setProperty('--from', String(length));
      rect.style.strokeDasharray = `${length} ${100 - length}`;
      rect.style.strokeOpacity = String(layer.opacity);
      group.append(rect);
    }
    svg.append(group);
  }
  overlay.append(svg);
  return overlay;
}

/** A computed radius token ("15px", "50%", "999px") in px along an axis of length `basis`. */
function toPixels(token: string | undefined, basis: number): number {
  if (token === undefined) return 0;
  const value = parseFloat(token);
  if (!Number.isFinite(value)) return 0;
  return token.endsWith('%') ? (value / 100) * basis : value;
}

/**
 * The corner radii as drawn, in px. CSS scales radii down together when they would overlap
 * (border-radius: 999px on a 30px-high pill is a half-circle cap), and so does this.
 */
export function drawnCornerRadii(computedRadius: string, width: number, height: number): [number, number] {
  const [horizontal, vertical = horizontal] = computedRadius.split(' ');
  const rx = toPixels(horizontal, width);
  const ry = toPixels(vertical, height);
  const fit = Math.min(1, width / (2 * rx || 1), height / (2 * ry || 1));
  return [rx * fit, ry * fit];
}

/**
 * Adds a travelling border light to `el`. The beam starts switched off: call start().
 * `el` must not clear its own children, and gets position: relative if it was static.
 */
export function attachBorderBeam(el: HTMLElement, opts: BorderBeamOptions = {}): BorderBeam {
  const color = opts.color ?? DEFAULT_COLOR;
  const size = opts.size !== undefined && Number.isFinite(opts.size) && opts.size > 0 ? opts.size : DEFAULT_SIZE;
  const duration =
    opts.duration !== undefined && Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration : DEFAULT_DURATION;

  ensureStyles();
  const overlay = buildOverlay(color, size, duration);
  const changedPosition = getComputedStyle(el).position === 'static';
  if (changedPosition) el.style.position = 'relative';
  el.append(overlay);

  let running = false;
  let destroyed = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let gate: VisibilityGate | null = null;
  let radiusSyncQueued = false;

  /** Publishes the host's current corner radius, inset by half the stroke so the line sits inside the border. */
  const syncRadius = (): void => {
    const [rx, ry] = drawnCornerRadii(
      getComputedStyle(overlay).borderTopLeftRadius,
      overlay.clientWidth,
      overlay.clientHeight,
    );
    overlay.style.setProperty('--rx', `${Math.max(0, rx - size / 2)}px`);
    overlay.style.setProperty('--ry', `${Math.max(0, ry - size / 2)}px`);
  };

  /**
   * Style or class changes on the host: re-read next frame rather than inside the mutation
   * microtask, which would force a style flush in the middle of the island's own frame. Size
   * changes need none of this, the ResizeObserver already syncs them in the same frame.
   */
  const queueRadiusSync = (): void => {
    if (radiusSyncQueued) return;
    radiusSyncQueued = true;
    requestAnimationFrame(() => {
      radiusSyncQueued = false;
      if (running) syncRadius();
    });
  };

  const watch = (): void => {
    if (resizeObserver) return;
    resizeObserver = new ResizeObserver(syncRadius);
    resizeObserver.observe(overlay);
    mutationObserver = new MutationObserver(queueRadiusSync);
    mutationObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    gate = new VisibilityGate(el, (open) => overlay.toggleAttribute('data-paused', !open));
    overlay.toggleAttribute('data-paused', !gate.open);
  };

  const unwatch = (): void => {
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    gate?.destroy();
    resizeObserver = null;
    mutationObserver = null;
    gate = null;
  };

  return {
    start(): void {
      if (destroyed || running) return;
      running = true;
      clearTimeout(hideTimer);
      overlay.style.display = 'block';
      syncRadius();
      watch();
      // Flush the display change so the fade starts from opacity 0.
      void overlay.offsetWidth;
      overlay.setAttribute('data-on', '');
    },

    stop(): void {
      if (destroyed || !running) return;
      running = false;
      overlay.removeAttribute('data-on');
      hideTimer = setTimeout(() => {
        overlay.style.display = 'none';
        unwatch();
      }, FADE_MS + 40);
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      running = false;
      clearTimeout(hideTimer);
      unwatch();
      overlay.remove();
      if (changedPosition && el.style.position === 'relative') el.style.position = '';
    },
  };
}
