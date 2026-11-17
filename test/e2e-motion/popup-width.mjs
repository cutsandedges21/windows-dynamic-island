// Headless check (not run by `npm test`): a pop-up hanging below the pill (Land's "file arrived")
// keeps its width while the pointer moves from the pill onto it and around it (Justin's recording:
// it narrowed and widened as the pointer moved). Logs the card's and the pill's widths every frame.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/popup-width.mjs [http://localhost:5198]
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/`);
await sleep(4500);
await page.evaluate(async () => {
  const mod = await import('/src/core/native.ts');
  const peer = { id: 'phone:abc', name: 'iPhone', os: 'ios', addr: '', port: 0 };
  const name = 'ScreenRecording_11-17-2026 16-55-59_1 (1).mp4';
  const t = (state, done) => ({ id: 't1', dir: 'in', peer, state, done, total: 12_300_000, count: 1, items: [{ name, size: 12_300_000, dir: false }], error: null, saved: state === 'done' ? [`C:/Users/x/Downloads/${name}`] : [], folder: state === 'done' ? 'C:/Users/x/Downloads' : null, expires: null, via: 'lan' });
  mod.emitLocal('land-transfer', t('sending', 6_000_000));
  setTimeout(() => mod.emitLocal('land-transfer', t('done', 12_300_000)), 300);
  window.__log = [];
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), Math.round(r.height)]; };
  const tick = () => {
    window.__log.push({ t: Math.round(performance.now()), sheet: box(document.querySelector('.sheet')), pill: box(document.querySelector('.pill')) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await sleep(1500);
console.log('before', JSON.stringify(await page.evaluate(() => window.__log.at(-1))));
const mark = (label) => page.evaluate((l) => window.__log.push({ t: Math.round(performance.now()), mark: l }), label);
const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await mark('pointer on the pill');
await page.mouse.move(pill.x, pill.y, { steps: 5 });
await sleep(700);
console.log('hovered', JSON.stringify(await page.evaluate(() => window.__log.at(-1))));
const card = await page.evaluate(() => { const e = document.querySelector('.sheet'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
if (!card) { console.log('no card'); await browser.close(); process.exit(2); }
console.log('card', JSON.stringify(card));
await mark('pointer onto the card');
for (const [fx, fy] of [[0.5, 0.3], [0.3, 0.6], [0.7, 0.8], [0.5, 0.5], [0.2, 0.4]]) {
  await page.mouse.move(card.x + card.w * fx, card.y + card.h * fy, { steps: 6 });
  await sleep(350);
}
await mark('end');
const log = await page.evaluate(() => window.__log);
let last = null;
let changes = 0;
let on = false;
for (const e of log) {
  if (e.mark) { console.log('--', e.mark); if (e.mark === 'end') break; on = true; continue; }
  const k = JSON.stringify([e.sheet?.[1], e.pill?.[1]]);
  if (on && last !== null && k !== last) { changes++; console.log(e.t, 'sheet', JSON.stringify(e.sheet), 'pill', JSON.stringify(e.pill)); }
  last = k;
}
console.log(changes ? `CARD OR PILL CHANGED WIDTH ${changes} frames` : 'the pop-up and the pill kept their width');
await browser.close();
process.exit(changes ? 1 : 0);
