// Headless check (not run by `npm test`): Control Center's Music tile with lyrics on keeps the line
// being sung in the middle of its lyrics, at every size it can be given (Justin: 1x1, 1x2, 2x1, 2x2,
// and the tall ones). Each size is saved in the browser's settings, the page reloads, a song with
// synced lyrics plays and Control Center opens; logs how far the sung line's middle is from the
// lyrics box's middle.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/lyrics-tile.mjs [http://localhost:5198] [out-dir]
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const out = process.argv[3] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let failed = false;
for (const size of ['1x1', '2x1', '1x2', '2x2', '1x4', '2x4']) {
  const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${base}/`);
  await page.evaluate(async (sz) => {
    const { defaultSettings } = await import('/src/core/settings.ts');
    const s = defaultSettings();
    s.island.grid.sizes['music/music'] = sz;
    localStorage.setItem('island:settings', JSON.stringify(s));
  }, size);
  await page.reload();
  // Past the demo song (music.ts demo), which would replace this one.
  await sleep(4500);
  await page.evaluate(async () => {
    const mod = await import('/src/core/native.ts');
    const lrc = Array.from({ length: 30 }, (_, i) => `[${String(Math.floor((10 + i * 4) / 60)).padStart(2, '0')}:${String((10 + i * 4) % 60).padStart(2, '0')}.00]${i % 3 ? `Line ${i + 1}` : `Line ${i + 1}, a longer one that wraps onto two lines here`}`).join('\n');
    mod.native.httpGet = async () => ({ status: 200, body: JSON.stringify({ syncedLyrics: lrc }) });
    mod.emitLocal('media', { available: true, app: 'Spotify', appId: 'Spotify.exe', title: 'CN Tower', artist: 'PartyNextDoor', album: 'x', status: 'playing', position: 63, duration: 230, updatedAt: Date.now(), canPlay: true, canPause: true, canNext: true, canPrev: true, thumbnail: null });
  });
  await sleep(1500);
  const p = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(p.x, p.y);
  await sleep(300);
  await page.mouse.click(p.x, p.y);
  await sleep(2600);
  const r = await page.evaluate(() => {
    const tile = document.querySelector('.sheet-inner:not(.leaving) .tile.k-lyrics');
    if (!tile) return null;
    const lb = tile.querySelector('.lb').getBoundingClientRect();
    const now = tile.querySelector('.ln.now')?.getBoundingClientRect();
    return { cls: [...tile.classList].filter((c) => /^(span|rows)-/.test(c)).join(' '), box: Math.round(lb.height), off: now ? Math.round(now.top + now.height / 2 - (lb.top + lb.height / 2)) : null, line: tile.querySelector('.ln.now')?.textContent };
  });
  const ok = r && r.off !== null && Math.abs(r.off) <= 3;
  if (!ok) failed = true;
  console.log(size, ok ? 'OK' : 'OFF', JSON.stringify(r));
  if (out) await page.screenshot({ path: `${out}/lyrics-tile-${size}.png`, clip: { x: 300, y: 50, width: 680, height: 620 } });
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
