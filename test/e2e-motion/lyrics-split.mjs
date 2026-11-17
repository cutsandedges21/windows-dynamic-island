// Headless check (not run by `npm test`): the line between Music's player and its lyrics panel drags
// like the line between two apps side by side on Windows. Drags it left then right, and checks that
// the card keeps its width, the lyrics follow the pointer, the player takes the rest, the split stays
// through the next updates, and closing and reopening the lyrics brings the usual split back.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/lyrics-split.mjs [http://localhost:5198] [out-dir]
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const out = process.argv[3] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/`);
// Past the demo song (music.ts demo), which would replace this one.
await sleep(4500);
await page.evaluate(async () => {
  const mod = await import('/src/core/native.ts');
  const lrc = Array.from({ length: 30 }, (_, i) => `[${String(Math.floor((10 + i * 4) / 60)).padStart(2, '0')}:${String((10 + i * 4) % 60).padStart(2, '0')}.00]Line ${i + 1}, sung over a few words here`).join('\n');
  mod.native.httpGet = async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: lrc }) });
  mod.emitLocal('media', { available: true, app: 'Spotify', appId: 'Spotify.exe', title: 'CN Tower', artist: 'PartyNextDoor', album: 'x', status: 'playing', position: 63, duration: 230, updatedAt: Date.now(), canPlay: true, canPause: true, canNext: true, canPrev: true, thumbnail: null });
});
await sleep(1500);
const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(pill.x, pill.y);
await sleep(1500);
await page.click('.pl-lyr');
await sleep(1400);
const look = () => page.evaluate(() => {
  const w = (s) => Math.round(document.querySelector(`.sheet-inner:not(.leaving) ${s}`)?.getBoundingClientRect().width ?? -1);
  return { card: Math.round(document.querySelector('.sheet').getBoundingClientRect().width), main: w('.pl-main'), lyrics: w('.pl-ly') };
});
const grip = () => page.evaluate(() => { const r = document.querySelector('.sheet-inner:not(.leaving) .pl-ly-grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const drag = async (dx) => {
  const g = await grip();
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x + dx / 2, g.y, { steps: 5 });
  await page.mouse.move(g.x + dx, g.y, { steps: 5 });
  await page.mouse.up();
  await sleep(1300);
};
let failed = false;
const check = (label, ok, v) => { if (!ok) failed = true; console.log(label, ok ? 'OK' : 'WRONG', JSON.stringify(v)); };

const start = await look();
check('opened', start.lyrics > 0, start);
await drag(-60);
const wider = await look();
check('dragged left 60', wider.card === start.card && Math.abs(wider.lyrics - start.lyrics - 60) <= 2 && wider.main < start.main, wider);
if (out) await page.screenshot({ path: `${out}/lyrics-split-wide.png`, clip: { x: 200, y: 0, width: 880, height: 300 } });
await sleep(2000);
check('stays after updates', JSON.stringify(await look()) === JSON.stringify(wider), await look());
await drag(400);
const narrow = await look();
check('dragged right 400 (stops at the narrowest)', narrow.card === start.card && narrow.lyrics >= 199 && narrow.lyrics <= 202, narrow);
if (out) await page.screenshot({ path: `${out}/lyrics-split-narrow.png`, clip: { x: 200, y: 0, width: 880, height: 300 } });
await page.click('.sheet-inner:not(.leaving) .pl-ly-close');
await sleep(1200);
// The card narrowed away from the pointer: back onto it.
await page.mouse.move(640, 600, { steps: 4 });
await sleep(1200);
await page.mouse.move(pill.x, pill.y, { steps: 4 });
await sleep(1200);
await sleep(800);
await page.click('.sheet-inner:not(.leaving) .pl-lyr');
await sleep(1400);
const again = await look();
check('closed and reopened: the usual split', JSON.stringify(again) === JSON.stringify(start), again);
// Near the middle the line snaps onto it (a magnet), and further off it goes where it is put.
const middle = await page.evaluate(() => Math.round(document.querySelector('.sheet-inner:not(.leaving) .sb-player').clientWidth / 2));
await drag(5);
const snapped = await look();
check(`dragged 5 right near the middle: snapped to it (${middle})`, Math.abs(snapped.lyrics - middle) <= 1, snapped);
await drag(-40);
const off = await look();
check('dragged 40 left: let go of the middle', Math.abs(off.lyrics - middle - 40) <= 2, off);
await browser.close();
process.exit(failed ? 1 : 0);
