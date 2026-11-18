// Headless stillness check for Control Center (not run by `npm test`): every visible text, icon and
// picture of the card and the pill is followed frame by frame through a scenario (open a tile's card,
// go back, switch the pill's activity...). Content may fade; it may not move, not even by a part of a
// pixel once it is drawn (Justin's 2026-11-18 clip: the grid stepping half a pixel after a card closed,
// the Calendar card wobbling 1 px, the card sliding sideways when the pill changed).
//
//   node test/e2e-motion/cc-still.mjs [scenario] [http://localhost:1430]
//   scenarios: card-back (default), calendar, pill-switch
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const scenario = process.argv[2] ?? 'card-back';
const base = process.argv[3] ?? 'http://localhost:1430';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEEN = 0.9;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: Number(process.env.VW ?? 1280), height: Number(process.env.VH ?? 760) } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/`);
await sleep(3500);
const box = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
const pill = await box('.pill');
// Open Control Center from the pill, without hovering first (the pointer comes from below).
await page.mouse.move(pill.x, pill.y + 300);
if (scenario === 'unfold') {
  // Claude on the pill (scroll to it), then its hover card.
  await page.mouse.move(pill.x, pill.y, { steps: 2 });
  for (let n = 0; n < 8; n++) {
    const on = await page.evaluate(() => document.querySelector('.pill-content')?.textContent ?? '');
    if (/claude|session/i.test(on) && document) break;
    await page.mouse.wheel(0, 120);
    await sleep(700);
  }
  await page.mouse.move(pill.x, pill.y + 300);
  await sleep(600);
  await page.mouse.move(pill.x, pill.y, { steps: 2 });
  await sleep(1500);
} else {
  await page.mouse.move(pill.x, pill.y, { steps: 2 });
  await page.mouse.click(pill.x, pill.y);
  await sleep(1600);
}

await page.evaluate((SEEN) => {
  const rec = (window.__rec = { frames: [], els: {}, marks: [] });
  let next = 0;
  const t0 = performance.now();
  window.__mark = (name) => rec.marks.push([name, performance.now() - t0]);
  const isLeaf = (e) => {
    if (e instanceof SVGElement && e.tagName !== 'svg') return false;
    if (e.tagName === 'svg' || e.tagName === 'IMG' || e.tagName === 'CANVAS') return true;
    if (e.closest('svg')) return false;
    for (const n of e.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
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
    const frame = { t, seen: {} };
    for (const e of document.querySelectorAll('.sheet > .sheet-inner *, .pill-content *')) {
      if (!isLeaf(e)) continue;
      const o = eff(e);
      if (o < SEEN) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (!e.dataset.mid) {
        e.dataset.mid = String(++next);
        rec.els[e.dataset.mid] = { where: e.closest('.pill-content') ? 'pill' : 'card', label: (e.textContent || e.tagName).trim().slice(0, 24) || e.tagName };
      }
      frame.seen[e.dataset.mid] = [r.x, r.y];
    }
    rec.frames.push(frame);
    if (t < 9000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, SEEN);

const mark = (n) => page.evaluate((n) => window.__mark(n), n);
const clickSel = async (sel, name) => {
  const b = await box(sel);
  if (!b) throw new Error(`no ${sel}`);
  await mark(name);
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.click(b.x, b.y);
};
await sleep(300);
if (scenario === 'card-back' || scenario === 'calendar') {
  const tile = scenario === 'calendar' ? '.sheet .tile[data-k="island/day"]' : '.sheet .tile[data-page="0"][data-k^="reminders/"]';
  const keys = await page.evaluate(() => [...document.querySelectorAll('.sheet .tile')].map((e) => e.dataset.k));
  const t = await box(tile);
  if (!t) { console.log('tiles:', keys.join(' ')); process.exit(1); }
  await clickSel(tile, 'open card');
  await sleep(2200);
  await clickSel('.sheet .sheet-inner:not(.leaving) .sb-head.has-back > :first-child', 'back');
  await sleep(2600);
} else if (scenario === 'unfold') {
  const more = '.sheet .sheet-inner:not(.leaving) [data-action$="unfold"]';
  if (!(await box(more))) { console.log('no unfold button; card:', await page.evaluate(() => document.querySelector('.sheet .sheet-inner')?.textContent?.slice(0, 200))); process.exit(1); }
  await clickSel(more, 'unfold');
  await sleep(2000);
  await clickSel(more, 'fold');
  await sleep(2000);
} else if (scenario === 'pill-switch') {
  await mark('wheel on pill');
  await page.mouse.move(pill.x, pill.y, { steps: 2 });
  await page.mouse.wheel(0, 120);
  await sleep(2500);
  await mark('wheel back');
  await page.mouse.wheel(0, -120);
  await sleep(2500);
}
await sleep(500);
const rec = await page.evaluate(() => window.__rec);
await browser.close();

console.log(`${scenario}: ${rec.frames.length} frames; marks ${rec.marks.map(([n, t]) => `${n}@${t.toFixed(0)}`).join(', ')}`);
// Every step an element takes while it is seen in two frames in a row, grouped by moment.
const steps = [];
for (let i = 1; i < rec.frames.length; i++) {
  const a = rec.frames[i - 1];
  const b = rec.frames[i];
  for (const [id, r] of Object.entries(b.seen)) {
    const p = a.seen[id];
    if (!p) continue;
    const dx = r[0] - p[0];
    const dy = r[1] - p[1];
    if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) steps.push({ t: b.t, id, dx, dy });
  }
}
const byT = new Map();
for (const s of steps) {
  const k = Math.round(s.t);
  if (!byT.has(k)) byT.set(k, []);
  byT.get(k).push(s);
}
for (const [t, ss] of byT) {
  const where = new Set(ss.map((s) => rec.els[s.id].where));
  const dxs = ss.map((s) => s.dx);
  const dys = ss.map((s) => s.dy);
  const f = (v) => v.toFixed(2);
  console.log(`${String(t).padStart(5)}ms ${String(ss.length).padStart(3)} moved (${[...where].join('+')}) dx ${f(Math.min(...dxs))}..${f(Math.max(...dxs))} dy ${f(Math.min(...dys))}..${f(Math.max(...dys))}  e.g. "${rec.els[ss[0].id].label}"`);
  if (process.env.LIST) for (const x of ss) console.log(`        ${rec.els[x.id].label} dx ${f(x.dx)} dy ${f(x.dy)}`);
}
