// BotView: the <svg> of one bot and the code that paints an engine frame into it.
// The structure follows bloub's BloubBot.vue template, built once and updated in place:
// the eyes are real holes in a masked body (so a narrow silhouette clips them for free),
// with an opaque eye-coloured copy of the body underneath so nothing behind shows through.

import { NOTIF_BLUE, type ArcRender, type DotRender } from './decor';
import type { BotFrame } from './engine';
import { DEMI_VIEWBOX, RAYON } from './repere';
import { mixHex } from './skins';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Half the side of the viewBox. The resting body (radius RAYON = 100, up to 115 for a squircle)
 * nearly fills it, so `size` means "about the size of the bot". Orbit rings and particles reach
 * 140 and spill past the box: the svg is overflow: visible, so a parent that clips will clip them.
 */
export const VIEW_HALF = 120;

let nextViewId = 0;

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function set(element: Element, name: string, value: string | number): void {
  element.setAttribute(name, String(value));
}

function setVisible(element: Element, visible: boolean): void {
  if (visible) element.removeAttribute('display');
  else element.setAttribute('display', 'none');
}

/** Items reused from frame to frame: a frame says how many to show, the rest are hidden. */
class Pool<T> {
  private readonly items: T[] = [];
  private shown = 0;

  constructor(
    private readonly make: (index: number) => T,
    private readonly toggle: (item: T, visible: boolean) => void,
  ) {}

  /** Shows the first `count` items (creating the missing ones) and returns all of them. */
  show(count: number): T[] {
    while (this.items.length < count) this.items.push(this.make(this.items.length));
    for (let i = count; i < this.shown; i++) this.toggle(this.items[i]!, false);
    for (let i = this.shown; i < count; i++) this.toggle(this.items[i]!, true);
    this.shown = count;
    return this.items;
  }
}

/** One orbit ring: a gradient and the two halves of its path (behind and in front of the body). */
interface ArcView {
  gradient: SVGLinearGradientElement;
  stops: SVGStopElement[];
  back: SVGPathElement;
  front: SVGPathElement;
}

export class BotView {
  readonly svg: SVGSVGElement;

  private readonly defs: SVGDefsElement;
  private readonly maskBody: SVGPathElement;
  private readonly maskNotch: SVGCircleElement;
  private readonly arcsBack: SVGGElement;
  private readonly body: SVGGElement;
  private readonly underlay: SVGPathElement;
  private readonly inkRect: SVGRectElement;
  private readonly dotsLayer: SVGGElement;
  private readonly notif: SVGCircleElement;
  private readonly arcsFront: SVGGElement;

  private readonly eyes: Pool<SVGPathElement>;
  private readonly dotCircles: Pool<SVGCircleElement>;
  private readonly dotShapes: Pool<SVGPathElement>;
  private readonly arcs: Pool<ArcView>;

  private dotsBehind = false;

  constructor(size: number, ink: string, eye: string) {
    const id = `bot${nextViewId++}`;
    const span = VIEW_HALF * 2;
    this.svg = svgElement('svg', {
      width: size,
      height: size,
      viewBox: `${-VIEW_HALF} ${-VIEW_HALF} ${span} ${span}`,
      'aria-hidden': 'true',
      focusable: 'false',
      style: 'display:block;overflow:visible',
    });

    // The mask: white body, black eyes and black notch for the notification dot.
    const mask = svgElement('mask', {
      id: `${id}-mask`,
      maskUnits: 'userSpaceOnUse',
      x: -DEMI_VIEWBOX,
      y: -DEMI_VIEWBOX,
      width: DEMI_VIEWBOX * 2,
      height: DEMI_VIEWBOX * 2,
    });
    this.maskBody = svgElement('path', { fill: '#fff' });
    this.maskNotch = svgElement('circle', { fill: '#000', display: 'none' });
    mask.append(this.maskBody);
    mask.append(this.maskNotch);
    this.eyes = new Pool(() => mask.appendChild(svgElement('path', { fill: '#000' })), setVisible);
    this.defs = svgElement('defs');
    this.defs.append(mask);

    // Layers, back to front: rings behind the body, body, particles, notification dot, rings in front.
    const ringStyle = { fill: 'none', 'stroke-linecap': 'round' };
    this.arcsBack = svgElement('g', ringStyle);
    this.underlay = svgElement('path', { fill: eye });
    this.inkRect = svgElement('rect', {
      x: -DEMI_VIEWBOX,
      y: -DEMI_VIEWBOX,
      width: DEMI_VIEWBOX * 2,
      height: DEMI_VIEWBOX * 2,
      fill: ink,
    });
    const masked = svgElement('g', { mask: `url(#${id}-mask)` });
    masked.append(this.inkRect);
    this.body = svgElement('g');
    this.body.append(this.underlay, masked);
    this.dotsLayer = svgElement('g');
    this.notif = svgElement('circle', { fill: NOTIF_BLUE, display: 'none' });
    this.arcsFront = svgElement('g', ringStyle);
    this.svg.append(this.defs, this.arcsBack, this.body, this.dotsLayer, this.notif, this.arcsFront);

    this.dotCircles = new Pool(() => this.dotsLayer.appendChild(svgElement('circle')), setVisible);
    this.dotShapes = new Pool(() => this.dotsLayer.appendChild(svgElement('path')), setVisible);
    this.arcs = new Pool(
      (index) => this.makeArc(`${id}-arc${index}`),
      (arc, visible) => {
        setVisible(arc.back, visible);
        setVisible(arc.front, visible);
      },
    );
  }

  /** Changes the two colours without touching the geometry. */
  paint(ink: string, eye: string): void {
    set(this.inkRect, 'fill', ink);
    set(this.underlay, 'fill', eye);
  }

  /** Draws one engine frame. `ink` and `eye` tint the particles that fade into the background. */
  render(frame: BotFrame, ink: string, eye: string): void {
    set(this.maskBody, 'd', frame.bodyPath);
    set(this.underlay, 'd', frame.bodyPath);
    set(this.body, 'opacity', frame.bodyAlpha);

    const holes = this.eyes.show(frame.eyes.length);
    frame.eyes.forEach((frameEye, i) => {
      const hole = holes[i]!;
      set(hole, 'd', frameEye.d);
      set(hole, 'transform', frameEye.matrix);
      set(hole, 'opacity', frameEye.alpha);
    });

    this.paintNotification(frame);
    this.placeDots(frame.dotsBehind);
    this.paintDots(frame.dots, ink, eye);

    const arcViews = this.arcs.show(frame.arcs.length);
    frame.arcs.forEach((arc, i) => this.paintArc(arcViews[i]!, arc));
  }

  private paintNotification(frame: BotFrame): void {
    const { notif, notch } = frame;
    setVisible(this.notif, notif !== null);
    setVisible(this.maskNotch, notch !== null);
    if (notif) {
      set(this.notif, 'cx', notif.x);
      set(this.notif, 'cy', notif.y);
      set(this.notif, 'r', notif.r);
    }
    if (notch) {
      set(this.maskNotch, 'cx', notch.x);
      set(this.maskNotch, 'cy', notch.y);
      set(this.maskNotch, 'r', notch.r);
    }
  }

  /** Particles of the burst pass behind the body, everything else in front of it. */
  private placeDots(behind: boolean): void {
    if (behind === this.dotsBehind) return;
    this.dotsBehind = behind;
    this.svg.insertBefore(this.dotsLayer, behind ? this.body : this.notif);
  }

  private paintDots(dots: DotRender[], ink: string, eye: string): void {
    const plain = dots.filter((dot) => dot.d === undefined);
    const shaped = dots.filter((dot) => dot.d !== undefined);
    const circles = this.dotCircles.show(plain.length);
    const paths = this.dotShapes.show(shaped.length);

    plain.forEach((dot, i) => {
      const circle = circles[i]!;
      set(circle, 'cx', dot.x);
      set(circle, 'cy', dot.y);
      set(circle, 'r', dot.r);
      set(circle, 'fill', dotFill(dot, ink, eye));
      set(circle, 'opacity', dot.opacity);
    });
    // A shaped dot (the teardrop under the slanted "!") is in ball-radius units, centred on the origin.
    shaped.forEach((dot, i) => {
      const path = paths[i]!;
      set(path, 'd', dot.d!);
      set(path, 'transform', `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`);
      set(path, 'fill', dotFill(dot, ink, eye));
      set(path, 'opacity', dot.opacity);
    });
  }

  private makeArc(gradientId: string): ArcView {
    const gradient = svgElement('linearGradient', { id: gradientId, gradientUnits: 'userSpaceOnUse' });
    this.defs.append(gradient);
    const stroke = { stroke: `url(#${gradientId})` };
    const back = svgElement('path', stroke);
    const front = svgElement('path', stroke);
    this.arcsBack.append(back);
    this.arcsFront.append(front);
    return { gradient, stops: [], back, front };
  }

  private paintArc(view: ArcView, arc: ArcRender): void {
    const { grad } = arc;
    set(view.gradient, 'x1', grad.x1);
    set(view.gradient, 'y1', grad.y1);
    set(view.gradient, 'x2', grad.x2);
    set(view.gradient, 'y2', grad.y2);
    while (view.stops.length < grad.stops.length) {
      const stop = svgElement('stop');
      view.gradient.append(stop);
      view.stops.push(stop);
    }
    grad.stops.forEach((color, i) => {
      set(view.stops[i]!, 'offset', grad.stops.length > 1 ? i / (grad.stops.length - 1) : 0);
      set(view.stops[i]!, 'stop-color', color);
    });
    for (const [half, path] of [[view.back, arc.back], [view.front, arc.front]] as const) {
      set(half, 'd', path);
      set(half, 'stroke-width', arc.width);
      set(half, 'opacity', arc.opacity);
    }
  }
}

/** A dot is the body colour unless the state says otherwise; `depth` fades particles into the background. */
function dotFill(dot: DotRender, ink: string, eye: string): string {
  if (dot.color !== undefined) return dot.color;
  return dot.depth === undefined ? ink : mixHex(eye, ink, dot.depth);
}
