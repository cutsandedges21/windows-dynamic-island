// Headless look at the lyrics (not run by `npm test`): a song with synced lyrics plays, the pointer
// grows the pill into the player, its lyrics button opens the panel beside it (shot), the panel's
// arrow closes it; then Control Center's Music tile opens the lyrics card (shot). Logs the player's
// left edge and width before and after the panel opens: the player itself must not move.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/lyrics.mjs [http://localhost:5198] [out-dir]
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const out = process.argv[3] ?? '.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/`);
await sleep(2000);
await page.evaluate(async () => {
  const lrc = Array.from({ length: 40 }, (_, i) => `[00:${String(20 + i * 3).padStart(2, '0').slice(-2)}.00]${i % 7 === 6 ? '' : `Line number ${i + 1} of this song, sung here`}`)
    .map((l, i) => l.replace(/^\[00:(\d\d)/, () => `[${String(Math.floor((20 + i * 3) / 60)).padStart(2, '0')}:${String((20 + i * 3) % 60).padStart(2, '0')}`))
    .join('\n');
  const native = (await import('/src/core/native.ts')).native;
  native.httpGet = async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: lrc }) });
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#3060c0';
  g.fillRect(0, 0, 64, 64);
  (await import('/src/core/native.ts')).emitLocal('media', {
    available: true, app: 'Spotify', appId: 'Spotify.exe', title: 'Paper Sky', artist: 'Lumen Coast', album: 'Summer',
    status: 'playing', position: 50, duration: 240, updatedAt: Date.now(),
    canPlay: true, canPause: true, canNext: true, canPrev: true, thumbnail: c.toDataURL(),
  });
});
await sleep(2500);
const box = async (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, w: Math.round(r.width * 10) / 10 }; }, sel);
const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(pill.x, pill.y);
await sleep(1500);
const before = await box('.sheet-inner:not(.leaving) .pl-top');
console.log('player before', JSON.stringify(before), 'lyrics button shows:', await page.evaluate(() => !document.querySelector('.pl-lyr')?.hidden));
await page.click('.pl-lyr');
await sleep(1600);
const after = await box('.sheet-inner:not(.leaving) .pl-top');
console.log('player after', JSON.stringify(after), 'panel lines:', await page.evaluate(() => document.querySelectorAll('.pl-ly-line').length), 'now:', await page.evaluate(() => document.querySelector('.pl-ly-line.now')?.textContent));
await page.screenshot({ path: `${out}/lyrics-hover.png`, clip: { x: 200, y: 0, width: 880, height: 300 } });
await sleep(3500);
await page.screenshot({ path: `${out}/lyrics-hover2.png`, clip: { x: 200, y: 0, width: 880, height: 300 } });
await page.click('.pl-ly-close');
await sleep(1200);
console.log('after close', JSON.stringify(await box('.sheet-inner:not(.leaving) .pl-top')), 'panel hidden:', await page.evaluate(() => document.querySelector('.sheet-inner:not(.leaving) .pl-ly')?.hidden));
await page.mouse.move(640, 700);
await sleep(1500);
// Control Center, then the Music tile's lyrics button.
await page.mouse.move(pill.x, pill.y);
await sleep(300);
await page.mouse.click(pill.x, pill.y);
await sleep(1500);
const tileBtn = await page.$('.tile [data-action$="lyrics-card"]');
console.log('tile lyrics button:', Boolean(tileBtn));
await page.screenshot({ path: `${out}/lyrics-cc.png` });
if (tileBtn) {
  await tileBtn.click();
  await sleep(1800);
  await page.screenshot({ path: `${out}/lyrics-stage.png` });
}
await browser.close();
