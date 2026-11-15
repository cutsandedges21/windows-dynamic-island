// Headless stillness check for the phone's held pill (not run by `npm test`): holding the pill
// grows the PC's hover card out of it; a tap away (or on it) shrinks it back, into the pill or
// back into Control Center. Nothing a reader can see may move on screen meanwhile: every text,
// icon and picture of the card, of Control Center and of the pill is followed frame by frame; it
// may fade, but its spot must stay put while it can be seen. The shape's edges move one way only.
// Same measure as still.mjs, on the phone's ?demo page at an iPhone's size.
//
//   npx vite --config phone/vite.config.ts      (in this worktree, left running: port 1431)
//   node test/e2e-motion/phone-hold.mjs [http://localhost:1431]
//
// Needs Playwright (any copy; PLAYWRIGHT points at it) and Microsoft Edge (no browser download).
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:1431';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Seen: at least this opaque (all its ancestors counted). */
const SEEN = Number(process.env.SEEN ?? 0.06);
/** Still: moves less than this, in CSS px, from where it first showed to where it last showed. */
const STILL = Number(process.env.STILL ?? 0.5);
/** The phone's HOLD_MS (island-view.ts) and a little. */
const HOLD = 520;
/** island-view.ts HOLD_MS: the hold fires this long after the finger went down. */
const HOLD_FIRES = 450;

const browser = await chromium.launch({ channel: 'msedge', headless: true });

/**
 * `from`: what shows before ('none' or 'cc'), `held`: the card already grown before recording.
 * `act`: 'hold' (hold the pill and let go: the card stays), 'away' (tap away), 'on' (tap the card
 * where the pill is). `then`: a second move once the first is done and `after` ms have passed
 * since it began ('away' while the card still grows).
 */
async function run({ from = 'none', held = false, act = 'hold', then = null, after = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(`${base}/?demo`);
  await sleep(3000);
  const pill = await page.evaluate(() => { const r = document.querySelector('.ph-stage .pill').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const at = { x: pill.x + pill.w * 0.25, y: pill.y + pill.h / 2 };
  const away = { x: 195, y: 760 };
  const hold = async () => { await page.mouse.move(at.x, at.y); await page.mouse.down(); await sleep(HOLD); await page.mouse.up(); };
  // The demo opens on Control Center.
  if (from === 'none') { await page.mouse.click(at.x, at.y); await sleep(1200); }
  if (held) { await hold(); await sleep(1200); }
  await page.evaluate((SEEN) => {
    const rec = (window.__still = { frames: [], els: {} });
    let next = 0;
    const t0 = performance.now();
    const leafSel = '.sheet > .sheet-inner *, .pill-content *';
    const isLeaf = (e) => {
      if (e instanceof SVGElement && e.tagName !== 'svg') return false;
      if (e.tagName === 'svg' || e.tagName === 'IMG' || e.tagName === 'CANVAS') return true;
      if (e.closest('svg')) return false;
      // An element with text of its own (not only children's).
      for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
      // A painted box without children (a bar, a dot, a cover).
      if (!e.children.length) { const s = getComputedStyle(e); return s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.backgroundImage !== 'none'; }
      return false;
    };
    const decorMemo = new WeakMap();
    const decor = (e) => {
      if (decorMemo.has(e)) return decorMemo.get(e);
      let d = e.closest('.seg-bars') !== null;
      for (let n = e; !d && n && !n.classList.contains('sheet-inner') && !n.classList.contains('pill-content'); n = n.parentElement) d = n.getAnimations().some((x) => x.effect?.getComputedTiming().iterations === Infinity);
      decorMemo.set(e, d);
      return d;
    };
    const tick = () => {
      const t = performance.now() - t0;
      const memo = new Map();
      const eff = (e) => {
        if (!e || e === document.body) return 1;
        if (memo.has(e)) return memo.get(e);
        const s = getComputedStyle(e);
        const o = s.display === 'none' || s.visibility === 'hidden' ? 0 : +s.opacity * eff(e.parentElement);
        memo.set(e, o);
        return o;
      };
      const sheet = document.querySelector('.sheet');
      const shown = sheet && sheet.style.display !== 'none';
      const bg = sheet?.querySelector('.sheet-bg')?.getBoundingClientRect();
      const pr = document.querySelector('.pill').getBoundingClientRect();
      // What the card's clip leaves to see (grown and carried cards are clipped to their shape).
      const frame = { t, clicked: window.__clickT !== undefined && t >= window.__clickT, shape: shown && bg ? { x: bg.x, y: bg.y, w: bg.width, h: bg.height } : null, pill: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, seen: {}, inners: sheet && shown ? [...sheet.querySelectorAll(':scope > .sheet-inner')].map((i) => ({ old: i.classList.contains('leaving'), o: eff(i) })) : [] };
      for (const e of document.querySelectorAll(leafSel)) {
        if (!isLeaf(e)) continue;
        // Decorations that move on their own all the time (a pulsing ring, the music bars) are not content moving.
        if (decor(e)) continue;
        const o = eff(e);
        if (o < SEEN) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // Out of the card's shape: clipped away, not seen.
        const inPill = e.closest('.pill-content') !== null;
        if (!inPill && frame.shape) {
          const s = frame.shape;
          if (r.right <= s.x || r.x >= s.x + s.w || r.bottom <= s.y || r.y >= s.y + s.h) continue;
        }
        if (!e.dataset.mid) {
          e.dataset.mid = String(++next);
          const inner = e.closest('.sheet-inner');
          rec.els[e.dataset.mid] = { where: inPill ? 'pill' : 'card', label: (e.textContent || e.className?.baseVal || e.className || e.tagName).toString().trim().slice(0, 28) || e.tagName, cls: (e.className?.baseVal ?? e.className ?? '').toString().slice(0, 30), innerId: inner ? (inner.dataset.iid ??= String(Math.random()).slice(2, 8)) : '' };
        }
        frame.seen[e.dataset.mid] = [r.x, r.y, r.width, r.height, o];
      }
      rec.frames.push(frame);
      if (t < 2200) requestAnimationFrame(tick);
    };
    addEventListener('pointerdown', () => { window.__clickT = performance.now() - t0; }, { capture: true, once: true });
    requestAnimationFrame(tick);
  }, SEEN);
  await sleep(120);
  const move = async (what) => {
    if (what === 'hold') await hold();
    else if (what === 'away') await page.mouse.click(away.x, away.y);
    else await page.mouse.click(at.x, at.y);
  };
  const first = move(act);
  if (then) { await sleep(after); await first; await move(then); } else await first;
  await sleep(2000);
  const rec = await page.evaluate(() => ({ ...window.__still, clickT: window.__clickT }));
  // A hold is judged from when it is a hold: before that the finger only presses the pill in, as
  // every tap does (PillRenderer, 97 %), and nothing has started to grow.
  rec.from = act === 'hold' && !process.env.PRESS ? rec.clickT + HOLD_FIRES : rec.clickT;
  await page.close();
  return rec;
}

function report(label, rec, turns = false) {
  const frames = rec.frames.filter((f) => f.clicked && f.t >= rec.from);
  console.log(`\n== ${label}: ${frames.length} frames from ${(rec.from - rec.clickT).toFixed(0)} ms after the finger went down`);
  const rows = [];
  const hiddenMoves = [];
  const spanOf = (run) => (run.length < 2 ? -1 : Math.hypot(Math.max(...run.map((s) => s.r[0])) - Math.min(...run.map((s) => s.r[0])), Math.max(...run.map((s) => s.r[1])) - Math.min(...run.map((s) => s.r[1]))));
  for (const [id, el] of Object.entries(rec.els)) {
    // Judged while it can be seen: a piece that went out of sight (faded under the card) and came
    // back is judged on each stretch apart, and where it came back is reported on its own (a pill
    // pressed in by the finger fades out pressed and comes back at full size).
    const all = frames.map((f) => (f.seen[id] ? { t: f.t, r: f.seen[id] } : null));
    const runs = [];
    for (let i = 0; i < all.length; i++) {
      if (!all[i]) continue;
      if (i === 0 || !all[i - 1]) runs.push([]);
      runs.at(-1).push(all[i]);
    }
    for (let k = 1; k < runs.length; k++) {
      const a = runs[k - 1].at(-1).r;
      const b = runs[k][0].r;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > STILL) hiddenMoves.push({ el, d, at: runs[k][0].t });
    }
    const seen = runs.reduce((best, r) => (r.length > 1 && spanOf(r) >= spanOf(best) ? r : best), []);
    if (seen.length < 2) continue;
    let step = 0;
    let stepAt = 0;
    const xs = seen.map((s) => s.r[0]);
    const ys = seen.map((s) => s.r[1]);
    const ws = seen.map((s) => s.r[2]);
    for (let i = 1; i < seen.length; i++) {
      const d = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
      if (d > step) { step = d; stepAt = seen[i].t; }
    }
    const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const grew = Math.max(...ws) - Math.min(...ws);
    rows.push({ id, el, span, step, stepAt, grew, from: seen[0].t, to: seen.at(-1).t, dx: xs.at(-1) - xs[0], dy: ys.at(-1) - ys[0] });
  }
  // Moving is its top-left corner going somewhere; a text that changes (a clock ticking) only changes size.
  const moved = rows.filter((r) => r.span > STILL).sort((a, b) => b.span - a.span);
  for (const h of hiddenMoves) console.log(`INFO ${h.el.where} "${h.el.label}" came back into sight ${h.d.toFixed(1)} px from where it went out of sight (at ${h.at.toFixed(0)} ms), not seen moving`);
  const by = (w) => rows.filter((r) => r.el.where === w);
  for (const w of ['card', 'pill']) {
    const all = by(w);
    const bad = moved.filter((r) => r.el.where === w);
    console.log(`${bad.length ? 'FAIL' : 'PASS'} ${w} content still on screen: ${all.length - bad.length} of ${all.length} pieces never move${bad.length ? `; worst moves ${bad[0].span.toFixed(1)} px` : ''}`);
    for (const r of bad.slice(0, Number(process.env.SHOW ?? 8))) console.log(`     ${r.span.toFixed(1).padStart(6)} px (dx ${r.dx.toFixed(1)}, dy ${r.dy.toFixed(1)}; biggest step ${r.step.toFixed(1)} px at ${r.stepAt.toFixed(0)} ms; size ±${r.grew.toFixed(1)}) seen ${r.from.toFixed(0)}-${r.to.toFixed(0)} ms  [${r.el.innerId}] ${r.el.cls} "${r.el.label}"`);
  }
  // The shape: each edge moves one way only (a step back of over half a pixel is a wobble).
  const shapes = frames.filter((f) => f.shape && f.shape.w > 0).map((f) => f.shape);
  const edges = { left: (r) => r.x, right: (r) => r.x + r.w, top: (r) => r.y, bottom: (r) => r.y + r.h };
  let worst = 0;
  const parts = [];
  for (const [k, fn] of Object.entries(edges)) {
    const xs = shapes.map(fn);
    let dir = 0;
    let back = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (Math.abs(d) < 0.01) continue;
      if (dir && Math.sign(d) !== dir) back = Math.max(back, Math.abs(d));
      else if (Math.abs(d) > 0.5) dir = Math.sign(d);
    }
    worst = Math.max(worst, back);
    parts.push(`${k} ${xs[0]?.toFixed(1)}→${xs.at(-1)?.toFixed(1)} back ${back.toFixed(2)}`);
  }
  // (A carry that turns round takes its edges back the way they came: not judged.)
  if (turns) worst = 0;
  else console.log(`${worst <= 0.5 ? 'PASS' : 'FAIL'} shape edges one way only: ${parts.join(', ')}`);
  // The two contents crossing over: never both clearly there (a double image), never an empty card.
  let both = 0;
  let empty = 0;
  let low = 9;
  for (const f of frames) {
    if (!f.inners.some((i) => i.old)) continue;
    const o = Math.max(0, ...f.inners.filter((i) => i.old).map((i) => i.o));
    const n = Math.max(0, ...f.inners.filter((i) => !i.old).map((i) => i.o));
    if (o > 0.5 && n > 0.5) both++;
    if (o + n < 0.6) empty++;
    low = Math.min(low, o + n);
  }
  console.log(`${both === 0 && empty <= 1 ? 'PASS' : 'FAIL'} contents cross over: both over half there in ${both} frames, card empty in ${empty} frames (lowest sum ${low === 9 ? '-' : low.toFixed(2)})`);
  if (process.env.PILLS) for (const f of frames) console.log(`${f.t.toFixed(0).padStart(5)}ms ${Object.entries(f.seen).filter(([id]) => rec.els[id].where === 'pill').map(([id, r]) => `${rec.els[id].cls || rec.els[id].label} ${r[0].toFixed(1)},${r[1].toFixed(1)} ${r[2].toFixed(1)} o${r[4].toFixed(2)}`).join(' | ')}`);
  if (process.env.VERBOSE) for (const f of frames.slice(0, Number(process.env.VERBOSE) || 40)) console.log(`${f.t.toFixed(0).padStart(5)}ms shape ${f.shape ? `${f.shape.x.toFixed(1)},${f.shape.y.toFixed(1)} ${f.shape.w.toFixed(1)}x${f.shape.h.toFixed(1)}` : '-'} pill ${f.pill.x.toFixed(1)},${f.pill.y.toFixed(1)} ${f.pill.w.toFixed(1)}x${f.pill.h.toFixed(1)} seen ${Object.keys(f.seen).length} inners ${f.inners.map((i) => `${i.old ? 'old' : 'new'} ${i.o.toFixed(2)}`).join(' ')}`);
  return { moved: moved.length, worst: moved[0]?.span ?? 0, edge: worst, both, empty };
}

const runs = {
  grow: ['hold the pill: its card grows out of it', { act: 'hold' }],
  shrink: ['tap away: back into the pill', { held: true, act: 'away' }],
  tapOn: ['tap the card where the pill is: back into the pill', { held: true, act: 'on' }],
  ccHold: ['hold over Control Center: it folds into the card', { from: 'cc', act: 'hold' }],
  ccBack: ['tap away: Control Center comes back', { from: 'cc', held: true, act: 'away' }],
  // The demo answers 60 ms after it is asked (fake-link.ts), so the card starts at 450 + 60 ms:
  // these tap away 150 ms into its move (as still.mjs turns the PC's round at 150 ms).
  flipGrow: ['tap away while it grows (turns back)', { act: 'hold', then: 'away', after: 660 }, true],
  flipCc: ['tap away while Control Center folds into it', { from: 'cc', act: 'hold', then: 'away', after: 660 }, true],
};
const which = (process.env.ONLY ?? Object.keys(runs).join(',')).split(',');
const out = {};
for (const k of which) {
  const [label, opts, turns] = runs[k];
  out[k] = report(label, await run(opts), turns);
}
await browser.close();
console.log('\nSUMMARY (pieces that move | worst px | shape edge step back px | double-content frames | empty frames)');
for (const [k, r] of Object.entries(out)) console.log(`${k.padEnd(9)} ${String(r.moved).padStart(3)} | ${r.worst.toFixed(1).padStart(6)} | ${r.edge.toFixed(2)} | ${r.both} | ${r.empty}`);
