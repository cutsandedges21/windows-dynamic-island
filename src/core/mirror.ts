// Duplicate mode: a copy of the pill on another screen. It runs no activities;
// the island sends what it draws and this window draws the same. The window is
// click-through, so a copy is for looking at; the island itself takes clicks.

import { setReducedMotion } from './animator';
import { BorderGlow, type GlowSpec, type GlowSpeed } from './glow';
import { pillRect, tuckedRect, type Anchor, type Area, type Orientation } from './layout';
import { native, on, type Placement } from './native';
import { PillRenderer } from './renderer';
import type { Placed } from './segments';
import type { PillColor } from './settings';
import { springs } from './spring';

export interface MirrorFrame {
  sig: string;
  swap: boolean;
  bump: boolean;
  placed: Placed[];
  w: number;
  h: number;
  orient: Orientation;
  anchor: Anchor;
  edge: number;
  /** Hidden for reasons that hold on every screen (idle tucked away, hidden for a while). */
  hidden: boolean;
  /** Hide on a screen where something runs full screen. */
  fsHide: boolean;
  /** Monitor with a full-screen app in front, if any. */
  fullscreen: string | null;
  glow: GlowSpec | null;
  speed: GlowSpeed;
  accent: string;
  color: PillColor;
  reduce: boolean;
}

export async function runMirror(stage: HTMLElement): Promise<void> {
  const renderer = new PillRenderer(stage, () => {});
  const glow = new BorderGlow(stage);
  renderer.onFrame((r) => glow.place(r));
  let area: Area = { width: 1280, height: 720 };
  let monitor = '';
  let frame: MirrorFrame | null = null;
  let lastSig = '';
  let lastAnchor: Anchor | null = null;

  const draw = (immediate: boolean) => {
    const f = frame;
    if (!f) return;
    document.documentElement.style.setProperty('--accent', f.accent);
    document.documentElement.dataset.pill = f.color;
    setReducedMotion(f.reduce);
    const hidden = f.hidden || (f.fsHide && f.fullscreen === monitor);
    renderer.setOrientation(f.orient);
    renderer.setAnchor(f.anchor);
    const target = hidden ? tuckedRect(area, f.anchor, f.w, f.h) : pillRect(area, f.anchor, f.w, f.h, f.edge);
    renderer.setShell(target, { config: lastAnchor && lastAnchor !== f.anchor ? springs.travel : springs.shell, immediate });
    lastAnchor = f.anchor;
    if (f.sig !== lastSig) {
      renderer.render(f.placed, f.w, f.h, { swap: f.swap && lastSig !== '', immediate });
      lastSig = f.sig;
    }
    if (f.bump && !hidden) renderer.bump();
    if (f.speed === 'off' || hidden || !f.glow) glow.set(null);
    else {
      glow.setSpeed(f.speed);
      glow.set(f.glow);
    }
  };

  const placeAt = (p: Placement | null) => {
    if (!p) return;
    monitor = p.monitor.id;
    area = { width: p.width, height: p.height };
    document.documentElement.style.setProperty('--stage-w', `${p.width}px`);
    document.documentElement.style.setProperty('--stage-h', `${p.height}px`);
    draw(true);
  };

  await on<Placement>('mirror-placed', placeAt);
  await on<MirrorFrame>('mirror-frame', (f) => {
    const first = !frame;
    frame = f;
    draw(first);
  });
  placeAt(await native.mirrorHello());
  void native.broadcast('mirror-ready', null);
}
