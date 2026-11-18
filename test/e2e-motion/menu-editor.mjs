// Settings › Right-click menu: the preview is the island's size, and a row dragged onto it lands there.
// Needs Vite on 1430 (npm run app or npx vite). node test/e2e-motion/menu-editor.mjs [out-dir]
import { chromium } from 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';

const out = process.argv[2] ?? '.';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, screen: { width: 1536, height: 960 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:1430/app.html#behavior');
await page.waitForSelector('.menu-stage .mp-item');
const stage = page.locator('.menu-stage');
await stage.scrollIntoViewIfNeeded();
const info = () =>
  page.evaluate(() => {
    const p = document.querySelector('.menu-preview');
    const r = p.getBoundingClientRect();
    const items = [...p.querySelectorAll('.mp-item')].map((e) => e.dataset.id ?? 'settings');
    const rows = [...document.querySelectorAll('.me-row[data-id]')].map((e) => `${e.dataset.id}${e.classList.contains('off') ? '(off)' : ''}`);
    return { w: Math.round(r.width), h: Math.round(r.height), items: [...new Set(items)].join(' '), rows: rows.join(' ') };
  });
console.log('start', await info());
await stage.screenshot({ path: `${out}/menu-start.png` });

// Turn Quiet off, then drag its row's handle onto the preview, left of Fade.
const quiet = page.locator('.me-row[data-id="quiet"]');
await quiet.locator('.toggle, input[type=checkbox], button[role=switch]').first().click();
console.log('quiet off', await info());
const grip = quiet.locator('.me-grip');
const g = await grip.boundingBox();
const fade = await page.locator('.menu-preview .mp-item[data-id="fade"]').boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
await page.mouse.down();
for (let k = 1; k <= 12; k++) await page.mouse.move(g.x + (fade.x + 2 - g.x) * (k / 12), g.y + (fade.y + fade.height / 2 - g.y) * (k / 12));
console.log('hovering', await info(), await page.locator('.menu-stage.hot').count() ? 'stage hot' : 'stage not hot');
await stage.screenshot({ path: `${out}/menu-drag.png` });
await page.mouse.up();
console.log('dropped', await info());

// Move Activities along the preview to the front.
const act = await page.locator('.menu-preview .mp-item[data-id="activities"]').boundingBox();
const first = await page.locator('.menu-preview .mp-item').first().boundingBox();
await page.mouse.move(act.x + act.width / 2, act.y + act.height / 2);
await page.mouse.down();
for (let k = 1; k <= 12; k++) await page.mouse.move(act.x + act.width / 2 + (first.x - 4 - act.x - act.width / 2) * (k / 12), act.y + act.height / 2);
await page.mouse.up();
console.log('moved on preview', await info());
await stage.screenshot({ path: `${out}/menu-end.png` });
await browser.close();
