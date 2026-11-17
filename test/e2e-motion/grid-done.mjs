// Headless check (not run by `npm test`): Control Center in edit mode keeps Reset layout and Done
// inside the card, whatever the screen height. Opens the grid, enters editing, hides a few tiles so
// the tray fills, and logs the Done button's box against the card's for each window height.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/grid-done.mjs [http://localhost:5198] [out-dir]
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const out = process.argv[3] ?? '.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let failed = false;
for (const height of [560, 700, 900]) {
  const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${base}/`);
  await sleep(2200);
  const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(pill.x, pill.y);
  await sleep(300);
  await page.mouse.click(pill.x, pill.y);
  await sleep(1400);
  // Long-press a tile: edit mode.
  const t = await page.evaluate(() => { const e = document.querySelector('.sheet-inner:not(.leaving) .tile'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  await sleep(900);
  await page.mouse.up();
  await sleep(1200);
  const before = await page.evaluate(() => ({ grid: document.querySelectorAll('.sheet-inner:not(.leaving) .sb-tiles .page .tile').length, tray: [...document.querySelectorAll('.sheet-inner:not(.leaving) .sb-tiles .tile.hidden-tile')].length }));
  // Hide tiles until the tray holds several (it grows the content past the card).
  for (let i = 0; i < 4; i++) {
    // The tiles jiggle, so click through the page rather than wait for them to stand still.
    const hid = await page.evaluate(() => { const x = document.querySelector('.sheet-inner:not(.leaving) .sb-tiles.editing .page .tile .tile-x'); x?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); x?.click(); return Boolean(x); });
    if (!hid) break;
    await sleep(500);
  }
  await sleep(900);
  const r = await page.evaluate(() => {
    const box = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    const inner = document.querySelector('.sheet-inner:not(.leaving)');
    const done = inner?.querySelector('[data-action$="grid-done"]');
    const sheet = document.querySelector('.sheet');
    return { editing: Boolean(inner?.querySelector('.sb-tiles.editing')), overflows: inner ? inner.scrollHeight > inner.clientHeight + 1 : null, sheet: box(sheet), inner: box(inner), done: box(done) };
  });
  const sheetBottom = Math.min(r.sheet?.bottom ?? 0, r.inner?.bottom ?? 0);
  const ok = r.editing && r.done && r.done.bottom <= sheetBottom + 0.5 && r.done.top >= (r.sheet?.top ?? 0);
  if (!ok) failed = true;
  console.log(`h=${height}`, ok ? 'OK' : 'HIDDEN', JSON.stringify(r));
  await page.screenshot({ path: `${out}/grid-done-${height}.png` });
  // Reset layout: back to how the grid was before this edit (Justin), not the default.
  const changed = await page.evaluate(() => ({ grid: document.querySelectorAll('.sheet-inner:not(.leaving) .sb-tiles .page .tile').length, tray: [...document.querySelectorAll('.sheet-inner:not(.leaving) .sb-tiles .tile.hidden-tile')].length }));
  await page.evaluate(() => document.querySelector('.sheet-inner:not(.leaving) [data-action$="grid-reset"]').click());
  await sleep(900);
  const after = await page.evaluate(() => ({ grid: document.querySelectorAll('.sheet-inner:not(.leaving) .sb-tiles .page .tile').length, tray: [...document.querySelectorAll('.sheet-inner:not(.leaving) .sb-tiles .tile.hidden-tile')].length }));
  const back = after.grid === before.grid && after.tray === before.tray && changed.tray > before.tray;
  if (!back) failed = true;
  console.log(`  reset: before ${JSON.stringify(before)} changed ${JSON.stringify(changed)} after ${JSON.stringify(after)}`, back ? 'OK' : 'NOT BACK');
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
