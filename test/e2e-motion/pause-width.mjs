// Headless check (not run by `npm test`): the music player the pill grows into keeps its size when
// the song is paused or played, and when a button on it is pressed (Justin's recording: pausing
// widened the card). Logs the card's and the pill's boxes every frame around each change.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/pause-width.mjs [http://localhost:5198]
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/`);
// Past the demo song (music.ts demo), which would replace this one.
await sleep(4500);
await page.evaluate(async () => {
  const mod = await import('/src/core/native.ts');
  const lrc = Array.from({ length: 30 }, (_, i) => `[${String(Math.floor((10 + i * 4) / 60)).padStart(2, '0')}:${String((10 + i * 4) % 60).padStart(2, '0')}.00]Line ${i + 1} of the song`).join('\n');
  mod.native.httpGet = async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: lrc }) });
  const song = (status) => ({
    available: true, app: 'Spotify', appId: 'Spotify.exe', title: 'The Color Violet', artist: 'Tory Lanez', album: 'Memories Don’t Die',
    status, position: 90, duration: 230, updatedAt: Date.now(), canPlay: true, canPause: true, canNext: true, canPrev: true, thumbnail: null,
  });
  window.__song = (status) => mod.emitLocal('media', song(status));
  // The button presses: the song's state flips as Windows would report it.
  mod.native.mediaControl = async (name) => { if (name === 'toggle') window.__song(window.__playing ? 'paused' : 'playing'); window.__playing = !window.__playing; return true; };
  mod.native.mediaState = async () => song(window.__playing ? 'playing' : 'paused');
  window.__playing = true;
  window.__song('playing');
  window.__log = [];
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), Math.round(r.height)]; };
  const tick = () => {
    window.__log.push({ t: Math.round(performance.now()), sheet: box(document.querySelector('.sheet')), pill: box(document.querySelector('.pill')) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await sleep(1500);
const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(pill.x, pill.y);
await sleep(1600);

const mark = (label) => page.evaluate((l) => window.__log.push({ t: Math.round(performance.now()), mark: l }), label);
const press = async (sel, label) => {
  const b = await page.evaluate((s) => { const e = document.querySelector(`.sheet-inner:not(.leaving) ${s}`); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
  if (!b) return console.log('no', sel);
  await mark(label);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.click(b.x, b.y);
  await sleep(1400);
};
await press('.pl-toggle', 'pause');
await press('.pl-toggle', 'play');
await press('.pl-next', 'next');

const log = await page.evaluate(() => window.__log);
// Every change of size while the pointer stays on the card, after it has grown.
let last = null;
let changes = 0;
const settled = log.findIndex((e) => e.mark);
for (const [i, e] of log.entries()) {
  if (e.mark) { console.log('--', e.mark); continue; }
  // The pill under the card too: raised under it (a surfaced pause), it widened the card on a wide pill.
  const k = JSON.stringify([e.sheet, e.pill?.[1]]);
  if (i > settled && last !== null && k !== last) { changes++; console.log(e.t, 'sheet', k, 'pill', JSON.stringify(e.pill)); }
  last = k;
}
console.log(changes ? `CARD OR PILL CHANGED SIZE ${changes} frames` : 'card and the pill under it kept their size');
await browser.close();
process.exit(changes ? 1 : 0);
