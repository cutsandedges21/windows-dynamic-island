// Headless check (not run by `npm test`): Control Center's brightness slider follows the pointer for
// the whole drag, across half (its icon changes there) and while the level read back lags behind
// (Justin's recording: the fill stopped following and jumped). Drags it top to bottom and back.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/hub-slider.mjs [http://localhost:5198]
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/`);
await sleep(4500);
// Windows answers slowly: the level read back is the one asked for 400 ms ago.
await page.evaluate(async () => {
  const mod = await import('/src/core/native.ts');
  let level = 80;
  mod.native.brightnessGet = async () => level;
  mod.native.brightnessSet = (p) => new Promise((r) => setTimeout(() => { level = p; mod.emitLocal('brightness', p); r(true); }, 400));
  mod.emitLocal('brightness', level);
});
const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(pill.x, pill.y);
await sleep(600);
await page.mouse.click(pill.x, pill.y);
await sleep(2500);
// The slider's tile can sit on another page of the grid: scroll to it.
for (let i = 0; i < 4; i++) {
  const off = await page.evaluate(() => { const t = document.querySelector('.hs[data-key="brightness"]'); const s = document.querySelector('.sheet'); if (!t || !s) return false; const a = t.getBoundingClientRect(); const b = s.getBoundingClientRect(); return a.left < b.left || a.right > b.right; });
  if (!off) break;
  const c = await page.evaluate(() => { const b = document.querySelector('.sheet').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(c.x, c.y, { steps: 5 });
  await page.mouse.wheel(0, 120);
  await sleep(900);
}
const r = await page.evaluate(() => {
  const t = document.querySelector('.hs[data-key="brightness"]');
  if (!t) return null;
  t.id = 'probe-track';
  const b = t.getBoundingClientRect();
  return { x: b.x + b.width / 2, top: b.top, h: b.height };
});
console.log('track', JSON.stringify(r), JSON.stringify(await page.evaluate(() => { const e = document.querySelector('.sheet'); const b = e?.getBoundingClientRect(); return b && [b.x, b.y, b.width, b.height]; })));
if (!r) { console.log('no brightness slider'); await browser.close(); process.exit(2); }
await page.mouse.move(r.x, r.top + 4, { steps: 8 });
await sleep(300);
await page.mouse.down();
let bad = 0;
const path = [];
for (let i = 0; i <= 30; i++) path.push(i / 30);
for (let i = 30; i >= 0; i--) path.push(i / 30);
for (const f of path) {
  const y = r.top + 4 + (r.h - 8) * f;
  await page.mouse.move(r.x, y);
  await sleep(40);
  const s = await page.evaluate(() => {
    const t = document.querySelector('.hs[data-key="brightness"]');
    return { same: t?.id === 'probe-track', v: t ? Number(getComputedStyle(t).getPropertyValue('--v')) : null };
  });
  const want = 1 - f;
  if (!s.same || s.v === null || Math.abs(s.v - want) > 0.06) { bad++; console.log(`at ${want.toFixed(2)}: fill ${s.v?.toFixed(2)}${s.same ? '' : ' (slider rebuilt)'}`); }
}
await page.mouse.up();
await sleep(300);
const after = await page.evaluate(() => { const t = document.querySelector('.hs[data-key="brightness"]'); return t ? Number(getComputedStyle(t).getPropertyValue('--v')).toFixed(2) : 'no slider (the island closed)'; });
console.log('after letting go', after);
console.log(bad ? `FILL LEFT THE POINTER ${bad} times` : 'the fill followed the pointer all the way');
await browser.close();
process.exit(bad ? 1 : 0);
