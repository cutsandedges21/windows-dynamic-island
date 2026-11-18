// Headless check for a late snap (not run by `npm test`): after Control Center comes back from a tile's
// card, or a card opens, the card is screenshotted every 60 ms; once its animations are over nothing
// may change any more. Justin's 2026-11-18 clip showed the whole grid stepping half a pixel ~0.6 s after
// (an animated layer going away), and the Calendar card doing the same.
//
//   node test/e2e-motion/settle-snap.mjs [out-dir] [http://localhost:1430]
// Writes snap-<step>-<n>.png into out-dir; compare them with any image diff (scripts in the job's tmp).
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const out = process.argv[2] ?? '.';
const base = process.argv[3] ?? 'http://localhost:1430';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 760 } });
await page.goto(`${base}/`);
await sleep(3500);
const box = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: { x: r.x, y: r.y, width: r.width, height: r.height } }; }, sel);
const pill = await box('.pill');
await page.mouse.move(pill.x, pill.y + 300);
await page.mouse.move(pill.x, pill.y, { steps: 2 });
await page.mouse.click(pill.x, pill.y);
await sleep(1600);
const shots = async (step) => {
  const clip = (await box('.sheet .sheet-bg')).r;
  for (let n = 0; n < 26; n++) {
    await page.screenshot({ path: `${out}/snap-${step}-${String(n).padStart(2, '0')}.png`, clip, animations: 'allow' });
    await sleep(60);
  }
};
const t = await box('.sheet .tile[data-page="0"][data-k^="reminders/"]');
await page.mouse.move(t.x, t.y, { steps: 3 });
await page.mouse.click(t.x, t.y);
await shots('open');
await sleep(800);
const back = await box('.sheet .sheet-inner:not(.leaving) .sb-head.has-back > :first-child');
await page.mouse.click(back.x, back.y);
await shots('back');
await browser.close();
