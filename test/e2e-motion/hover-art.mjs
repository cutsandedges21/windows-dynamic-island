// Headless motion check (not run by `npm test`): music playing with album art, the pointer onto the
// pill (the Music card grows out of it) and off again (it shrinks back), logged per animation frame
// at 125% scale. For each frame: the pill's small art and the card's big art, each one's rect and
// how much of it shows (its opacity times its ancestors', 0 when hidden). A frame where both show,
// or the pill's art shows over the grown card, is the ghost the user saw.
//
//   npx vite --port 5198 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/hover-art.mjs [http://localhost:5198]
//
// Needs Playwright (any copy; PLAYWRIGHT points at it) and Microsoft Edge (no browser download).
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5198';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 720 } });
await page.goto(`${base}/`);
await sleep(2000);
// The demo's track has no art: play one that has (a plain coloured square).
await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#c04030';
  g.fillRect(0, 0, 64, 64);
  const native = await import('/src/core/native.ts');
  native.emitLocal('media', {
    available: true, app: 'Spotify', appId: 'Spotify.exe', title: 'Lovesong', artist: 'Adele', album: '21',
    status: 'playing', position: 33, duration: 316, updatedAt: Date.now(),
    canPlay: true, canPause: true, canNext: true, canPrev: true, thumbnail: c.toDataURL(),
  });
});
await sleep(3000);
const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const pillArt = await page.evaluate(() => !!document.querySelector('.pill-content .seg-art img'));
console.log(`pill ${JSON.stringify(pill)}, pill shows album art: ${pillArt}`);

await page.evaluate(() => {
  const rec = (window.__rec = []);
  const t0 = performance.now();
  // How much of an element shows: its opacity times every ancestor's, 0 when not visible.
  const shows = (e) => {
    if (!e) return 0;
    if (getComputedStyle(e).visibility === 'hidden') return 0;
    let o = 1;
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return 0;
      o *= +cs.opacity;
    }
    return o;
  };
  const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const tick = () => {
    const sheet = document.querySelector('.sheet');
    const small = document.querySelector('.pill-content .seg-art img');
    const big = sheet?.querySelector('.sheet-inner:not(.leaving) .pl-art img');
    rec.push({
      t: performance.now() - t0,
      morph: sheet?.classList.contains('morph') ?? false,
      cover: document.querySelector('.pill').className,
      bg: rect(sheet?.querySelector('.sheet-bg')),
      small: { r: rect(small), o: shows(small) },
      big: { r: rect(big), o: sheet && sheet.style.display !== 'none' ? shows(big) : 0 },
    });
    if (performance.now() - t0 < 3200) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await sleep(100);
await page.mouse.move(pill.x + pill.w / 2, pill.y + pill.h / 2, { steps: 2 });
await sleep(1500);
await page.mouse.move(pill.x + pill.w / 2, 600, { steps: 2 });
await sleep(1700);
const rec = await page.evaluate(() => window.__rec);
await browser.close();

const VIS = 0.04;
let both = 0;
let ghost = 0;
let prevShown = false;
let last = null;
for (const f of rec) {
  const s = f.small;
  const b = f.big;
  const shown = f.bg !== null && f.bg.w > 0 && (f.morph || f.cover.includes('covered'));
  // Log only the frames around the grow and the shrink, not the card standing still.
  const still = f.bg && last && last.bg && Math.abs(f.bg.h - last.bg.h) < 0.5 && Math.abs(s.o - last.small.o) < 0.005 && Math.abs(b.o - last.big.o) < 0.005;
  last = f;
  if ((shown || prevShown) && !still) {
    const card = f.bg ? `${f.bg.w.toFixed(0)}x${f.bg.h.toFixed(0)}` : '-';
    const sm = s.r ? `${s.r.x.toFixed(1)},${s.r.y.toFixed(1)} ${s.r.w.toFixed(0)}px o=${s.o.toFixed(2)}` : '-';
    const bg = b.r ? `${b.r.x.toFixed(1)},${b.r.y.toFixed(1)} ${b.r.w.toFixed(0)}px o=${b.o.toFixed(2)}` : '-';
    const flag = s.o > VIS && b.o > VIS ? '  << BOTH' : s.o > VIS && shown && f.cover.includes('cover-out') ? '  << pill art over card' : '';
    console.log(`${f.t.toFixed(0).padStart(5)}ms card ${card.padEnd(8)} | pill art ${sm.padEnd(32)} | card art ${bg}${flag}`);
  }
  if (s.o > VIS && b.o > VIS) both++;
  if (s.o > VIS && f.cover.includes('cover-out')) ghost++;
  prevShown = shown;
}
console.log(`\nSUMMARY frames with both arts showing: ${both}; frames with the pill's art over the grown card: ${ghost}`);
