// Headless check (not run by `npm test`): the Shelf card's x closes the island straight to its pill
// (Justin: it went into the pill's hover card, the pointer being still where the card was). The
// pointer stays on the x after the click; the card must go and no hover card may grow in its place.
// What moves while it closes is printed, to compare with a tap outside (AWAY=1): it should be the same.
//
//   npx vite --port 5199 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/shelf-close.mjs [http://localhost:5199]
//
// Needs Playwright (any copy; PLAYWRIGHT points at it) and Microsoft Edge (no browser download).
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Seen: at least this opaque (all its ancestors counted). */
const SEEN = 0.06;
/** Still: moves less than this, in CSS px, from where it first showed to where it last showed. */
const STILL = 0.5;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 720 } });
await page.goto(`${base}/`);
await sleep(4000);
const rect = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);

// Open Control Center, then the Shelf's card from its tile.
const pill = await rect('.pill');
await page.mouse.move(pill.x, pill.y, { steps: 4 });
await sleep(1200);
await page.mouse.click(pill.x, pill.y);
await sleep(1500);
// (Its tile can be on another page of the grid, off screen: clicked where it is.)
const opened = await page.evaluate(() => { const e = document.querySelector('.sheet [title="Open the Shelf"]'); e?.click(); return Boolean(e); });
if (!opened) throw new Error('no Shelf tile in Control Center');
await sleep(1500);
const x = await rect('.sheet [title="Close"]');
if (!x) throw new Error('no x on the Shelf card');
await page.mouse.move(x.x, x.y, { steps: 4 });
await sleep(600);

await page.evaluate((SEEN) => {
  const rec = (window.__rec = { frames: [], els: {} });
  let next = 0;
  const t0 = performance.now();
  const eff = (e) => (!e || e === document.body ? 1 : (getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden' ? 0 : +getComputedStyle(e).opacity * eff(e.parentElement)));
  const leaf = (e) => {
    if (e instanceof SVGElement && e.tagName !== 'svg') return false;
    if (e.tagName === 'svg' || e.tagName === 'IMG') return true;
    if (e.closest('svg')) return false;
    for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  };
  const tick = () => {
    const t = performance.now() - t0;
    const sheet = document.querySelector('.sheet');
    const bg = sheet?.querySelector('.sheet-bg')?.getBoundingClientRect();
    const shown = sheet && sheet.style.display !== 'none' && eff(sheet) > 0.01;
    const frame = { t, clicked: window.__clickT !== undefined && t >= window.__clickT, shape: shown && bg ? { w: bg.width, h: bg.height } : null, seen: {} };
    for (const e of document.querySelectorAll('.sheet > .sheet-inner *, .pill-content *')) {
      if (!leaf(e) || e.closest('.seg-bars')) continue;
      const o = eff(e);
      if (o < SEEN) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (!e.dataset.sid) {
        e.dataset.sid = String(++next);
        rec.els[e.dataset.sid] = `${e.closest('.pill-content') ? 'pill' : 'card'}: ${(e.textContent || '').trim().slice(0, 28) || e.tagName}`;
      }
      frame.seen[e.dataset.sid] = [r.x, r.y];
    }
    rec.frames.push(frame);
    if (t < 1800) requestAnimationFrame(tick);
  };
  addEventListener('pointerdown', () => { window.__clickT = performance.now() - t0; }, { capture: true, once: true });
  requestAnimationFrame(tick);
}, SEEN);
await sleep(120);
// AWAY=1: a tap outside instead, the way the island already closed (to compare with).
if (process.env.AWAY) await page.mouse.click(40, 700);
else await page.mouse.click(x.x, x.y);
await sleep(2000);
const rec = await page.evaluate(() => window.__rec);
await browser.close();

const frames = rec.frames.filter((f) => f.clicked);
let fails = 0;
const check = (ok, text) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
};
// Gone: the card ends hidden, and no card grew back after it began to shrink (a hover card).
const sizes = frames.map((f) => (f.shape ? f.shape.w * f.shape.h : 0));
let regrew = 0;
for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[i - 1] + 1) regrew = Math.max(regrew, sizes[i] - sizes[i - 1]);
check(sizes.at(-1) === 0, `the island ends at its pill, no card under it (last card ${frames.at(-1)?.shape ? `${frames.at(-1).shape.w.toFixed(0)}x${frames.at(-1).shape.h.toFixed(0)}` : 'none'})`);
check(regrew === 0, `no card grows after the click (biggest growth in a frame ${regrew.toFixed(0)} px²)`);
// Still: every piece of the card's content stays where it first showed while it can be seen.
const moved = { card: [], pill: [] };
for (const [id, label] of Object.entries(rec.els)) {
  const seen = frames.filter((f) => f.seen[id]).map((f) => f.seen[id]);
  if (seen.length < 2) continue;
  const xs = seen.map((s) => s[0]);
  const ys = seen.map((s) => s[1]);
  const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (span > STILL) moved[label.startsWith('pill') ? 'pill' : 'card'].push(`${span.toFixed(1)} px "${label}"`);
}
// The card leaving and the open pill going back to its resting layout move as on any close to the
// pill (a tap outside, AWAY=1; still.mjs closeOff): told, to compare with AWAY=1, not judged here.
for (const w of ['card', 'pill']) console.log(`INFO ${w} content moving while the island closes: ${moved[w].length}${moved[w].length ? ` (${moved[w].slice(0, 3).join(', ')})` : ''}`);
process.exit(fails ? 1 : 0);
