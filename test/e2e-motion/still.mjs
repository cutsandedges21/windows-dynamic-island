// Headless stillness check (not run by `npm test`): on a click that opens (or closes) the island from
// a grown hover card, nothing a reader can see may move on screen. Every visible piece of content
// (each text, icon and picture of the card that leaves, of the card that arrives and of the pill)
// is followed frame by frame; it may fade, but its spot on screen must stay put while it can be seen.
// The shape (the card's edges) may move, each edge one way only.
//
//   npx vite --port 5199 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/still.mjs [http://localhost:5199]
//
// Needs Playwright (any copy; PLAYWRIGHT points at it) and Microsoft Edge (no browser download).
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Seen: at least this opaque (all its ancestors counted). */
const SEEN = Number(process.env.SEEN ?? 0.06);
/** Still: moves less than this, in CSS px, from where it first showed to where it last showed. */
const STILL = Number(process.env.STILL ?? 0.5);

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function run({ hover = true, opened = false, midGrow = false, leave = false, scale = 1.25 } = {}) {
  const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 1280, height: 720 } });
  await page.goto(`${base}/`);
  await sleep(4000);
  const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const at = { x: pill.x + pill.w / 2, y: pill.y + pill.h / 2 };
  if (hover) {
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await sleep(midGrow ? 230 : 1200);
  }
  if (opened) {
    await page.mouse.click(at.x, at.y);
    await sleep(1500);
  }
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
      if (t < 1500) requestAnimationFrame(tick);
    };
    addEventListener('pointerdown', () => { window.__clickT = performance.now() - t0; }, { capture: true, once: true });
    requestAnimationFrame(tick);
  }, SEEN);
  await sleep(120);
  await page.mouse.click(at.x, at.y);
  if (leave) await page.mouse.move(40, 710, { steps: 2 });
  await sleep(1700);
  const rec = await page.evaluate(() => window.__still);
  await page.close();
  return rec;
}

function report(label, rec) {
  const frames = rec.frames.filter((f) => f.clicked);
  console.log(`\n== ${label}: ${frames.length} frames after the click`);
  const rows = [];
  for (const [id, el] of Object.entries(rec.els)) {
    const seen = frames.filter((f) => f.seen[id]).map((f) => ({ t: f.t, r: f.seen[id] }));
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
  console.log(`${worst <= 0.5 ? 'PASS' : 'FAIL'} shape edges one way only: ${parts.join(', ')}`);
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
  if (process.env.VERBOSE) for (const f of frames.slice(0, 40)) console.log(`${f.t.toFixed(0).padStart(5)}ms shape ${f.shape ? `${f.shape.x.toFixed(1)},${f.shape.y.toFixed(1)} ${f.shape.w.toFixed(1)}x${f.shape.h.toFixed(1)}` : '-'} pill ${f.pill.x.toFixed(1)},${f.pill.y.toFixed(1)} ${f.pill.w.toFixed(1)}x${f.pill.h.toFixed(1)} seen ${Object.keys(f.seen).length}`);
  return { moved: moved.length, worst: moved[0]?.span ?? 0, edge: worst, both, empty };
}

const which = (process.env.ONLY ?? 'open,midGrow,closeOn,closeOff,plain').split(',');
const out = {};
if (which.includes('open')) out.open = report('click on a grown hover card (opens the island)', await run());
if (which.includes('midGrow')) out.midGrow = report('click while the hover card is still growing', await run({ midGrow: true }));
if (which.includes('closeOn')) out.closeOn = report('click to close, pointer stays on the pill', await run({ opened: true }));
if (which.includes('closeOff')) out.closeOff = report('click to close, pointer leaves', await run({ opened: true, leave: true }));
if (which.includes('plain')) out.plain = report('click with no hover card', await run({ hover: false }));
await browser.close();
console.log('\nSUMMARY (pieces that move | worst px | shape edge step back px | double-content frames | empty frames)');
for (const [k, r] of Object.entries(out)) console.log(`${k.padEnd(9)} ${String(r.moved).padStart(3)} | ${r.worst.toFixed(1).padStart(6)} | ${r.edge.toFixed(2)} | ${r.both} | ${r.empty}`);
