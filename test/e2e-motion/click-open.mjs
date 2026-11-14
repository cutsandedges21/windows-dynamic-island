// Headless motion check (not run by `npm test`): a click on the pill while a hover card is grown,
// and a click with no card, logged per animation frame at 125% scale. Reports how far the card's
// outline and its content move sideways from one frame to the next.
//
//   npx vite --port 5199 --strictPort          (in this worktree, left running)
//   node test/e2e-motion/click-open.mjs [http://localhost:5199]
//
// Needs Playwright (any copy; PLAYWRIGHT points at it) and Microsoft Edge (no browser download).
const pw = process.env.PLAYWRIGHT ?? 'file:///C:/Users/justi/projects/moss-island/phone/e2e/node_modules/playwright/index.mjs';
const { chromium } = await import(pw);
const base = process.argv[2] ?? 'http://localhost:5199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function run(hoverFirst, { opened = false, midGrow = false, leave = false } = {}) {
  const page = await browser.newPage({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 720 } });
  // The browser preview's own Claude chats (claude/index.ts demo()) show up after 2.5 s.
  await page.goto(`${base}/`);
  await sleep(4000);
  const pill = await page.evaluate(() => { const r = document.querySelector('.pill').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const at = { x: pill.x + pill.w / 2, y: pill.y + pill.h / 2 };
  if (hoverFirst) {
    await page.mouse.move(at.x, at.y, { steps: 4 });
    // Mid-grow: clicked while the card is still on its way out of the pill.
    await sleep(midGrow ? 230 : 1200);
  }
  if (opened) {
    // Open first, then the recorded click closes it.
    await page.mouse.click(at.x, at.y);
    await sleep(1500);
  }
  // Closing with the pointer off the pill: it leaves just after the click.
  const grown = await page.evaluate(() => document.querySelector('.sheet.morph') !== null);
  const under = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return `${e?.className} in ${e?.closest('[data-action]')?.dataset.action ?? 'no action'}`; }, at);
  console.log(`pointer at ${at.x.toFixed(1)},${at.y.toFixed(1)} over: ${under}`);
  await page.evaluate(() => {
    const rec = (window.__rec = []);
    const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const t0 = performance.now();
    // Every layout the pill is given, to tell a retarget from a spring.
    const r = window.island.renderer;
    const render = r.render.bind(r);
    window.__renders = [];
    r.render = (placed, w, h, opts) => { window.__renders.push({ t: performance.now() - t0, w, keys: placed.map((p) => `${p.seg.key}@${p.x.toFixed(0)}`).join(' ') }); return render(placed, w, h, opts); };
    const tick = () => {
      const sheet = document.querySelector('.sheet');
      const inners = sheet ? [...sheet.querySelectorAll(':scope > .sheet-inner')] : [];
      rec.push({
        t: performance.now() - t0,
        pill: rect(document.querySelector('.pill')),
        shown: sheet && sheet.style.display !== 'none',
        morph: sheet?.classList.contains('morph') ?? false,
        bg: rect(sheet?.querySelector('.sheet-bg')),
        // The pill's own content: each segment's spot (the leading icon must not swing back and forth).
        segs: [...document.querySelectorAll('.pill-content > .seg')].map((e) => ({ k: e.dataset.key, r: rect(e), o: +getComputedStyle(e).opacity })),
        pillO: +getComputedStyle(document.querySelector('.pill-content')).opacity,
        sheetO: sheet && sheet.style.display !== 'none' ? +getComputedStyle(sheet).opacity : 0,
        clicked: window.__clickT !== undefined && performance.now() - t0 >= window.__clickT,
        inners: inners.map((i) => ({ leaving: i.classList.contains('leaving'), first: rect(i.firstElementChild), opacity: getComputedStyle(i).opacity })),
      });
      if (performance.now() - t0 < 1800) requestAnimationFrame(tick);
    };
    addEventListener('pointerdown', () => { window.__clickT = performance.now() - t0; }, { capture: true, once: true });
    requestAnimationFrame(tick);
  });
  await sleep(80);
  await page.mouse.click(at.x, at.y);
  if (leave) await page.mouse.move(40, 710, { steps: 2 });
  await sleep(1900);
  const rec = await page.evaluate(() => window.__rec);
  for (const r of await page.evaluate(() => window.__renders)) console.log(`render ${r.t.toFixed(0)}ms w=${r.w} ${r.keys}`);
  console.log('after click: open =', await page.evaluate(() => window.island.open), 'card text:', await page.evaluate(() => document.querySelector('.sheet-inner:not(.leaving)')?.textContent?.slice(0, 60)));
  await page.close();
  return { grown, rec };
}

function report(label, { grown, rec }) {
  console.log(`\n== ${label} (hover card grown before click: ${grown}), ${rec.length} frames`);
  let maxBg = 0;
  let maxContent = 0;
  let back = 0;
  let where = '';
  for (let i = 1; i < rec.length; i++) {
    const a = rec[i - 1];
    const b = rec[i];
    // The card's outline: its centre should not move sideways (it widens about the pill's centre).
    // While the card widens its edges only move outward: any step back is a wobble.
    if (a.bg && b.bg && a.shown && b.shown && !a.morph && !b.morph && b.bg.w >= a.bg.w) back = Math.max(back, b.bg.x - a.bg.x, a.bg.x + a.bg.w - (b.bg.x + b.bg.w));
    if (a.bg && b.bg && a.shown && b.shown) maxBg = Math.max(maxBg, Math.abs(b.bg.x + b.bg.w / 2 - (a.bg.x + a.bg.w / 2)));
    // Each piece of content (old fading out, new fading in): its left edge from frame to frame.
    // The content showing before the click becomes the old one on the click frame: followed across it.
    const swap = !a.inners.some((x) => x.leaving) && b.inners.some((x) => x.leaving);
    const pairs = [
      [swap ? a.inners.find((x) => !x.leaving) : a.inners.find((x) => x.leaving), b.inners.find((x) => x.leaving)],
      [swap ? null : a.inners.find((x) => !x.leaving), b.inners.find((x) => !x.leaving)],
    ];
    for (const [pa, pb] of pairs) {
      if (!pa?.first || !pb?.first) continue;
      const dx = Math.abs(pb.first.x - pa.first.x);
      if (dx > maxContent) where = `${b.t.toFixed(0)}ms ${pa.first.x.toFixed(2)} -> ${pb.first.x.toFixed(2)}`;
      maxContent = Math.max(maxContent, dx);
    }
  }
  // From the click on, while the card is on screen: its shape, and its two contents' opacity.
  const post = rec.filter((f) => f.clicked && f.shown && f.bg && f.bg.w > 0);
  const eff = (f, leaving) => f.inners.filter((x) => x.leaving === leaving).reduce((m, x) => Math.max(m, +x.opacity), 0) * f.sheetO;
  const edges = { left: (r) => r.x, right: (r) => r.x + r.w, top: (r) => r.y, bottom: (r) => r.y + r.h };
  const edgeSwing = Object.fromEntries(Object.entries(edges).map(([k, fn]) => {
    const xs = post.map((f) => fn(f.bg));
    let worst = 0;
    // A step against the way the edge last really moved (a step over half a pixel): sub-pixel
    // rounding steps (under half a pixel) do not set the way, but count if they go against it.
    let dir = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (Math.abs(d) < 0.01) continue;
      if (dir && Math.sign(d) !== dir) worst = Math.max(worst, Math.abs(d));
      else if (Math.abs(d) > 0.5) dir = Math.sign(d);
    }
    return [k, worst];
  }));
  let both = 0;
  let empty = 0;
  let minSum = 9;
  let drift = 0;
  for (let i = 0; i < post.length; i++) {
    const f = post[i];
    const o = eff(f, true);
    const n = eff(f, false);
    if (o > 0.5 && n > 0.5) both++;
    if (f.sheetO > 0.5) { minSum = Math.min(minSum, o + n); if (o + n < 0.6) empty++; }
    const a = post[i - 1];
    const na = a?.inners.find((x) => !x.leaving);
    const nb = f.inners.find((x) => !x.leaving);
    if (na?.first && nb?.first && a.inners.some((x) => x.leaving) === f.inners.some((x) => x.leaving) && na.first.w === nb.first.w) {
      const off = (g, r) => [g.x + g.w / 2 - (r.x + r.w / 2), g.y - r.y];
      const [ax, ay] = off(na.first, a.bg);
      const [bx, by] = off(nb.first, f.bg);
      drift = Math.max(drift, Math.abs(bx - ax), Math.abs(by - ay));
    }
  }
  for (const f of rec.slice(0, Number(process.env.FRAMES ?? 40))) {
    const ins = f.inners.map((i) => `${i.leaving ? 'old' : 'new'}@${i.first ? i.first.x.toFixed(2) : '-'}/${(+i.opacity).toFixed(2)}`).join(' ');
    const shape = f.bg ? `${f.bg.x.toFixed(1)},${f.bg.y.toFixed(1)} ${f.bg.w.toFixed(1)}x${f.bg.h.toFixed(1)}` : '-';
    console.log(`${f.t.toFixed(0).padStart(5)}ms${f.clicked ? '*' : ' '}shape ${shape} old ${eff(f, true).toFixed(2)} new ${eff(f, false).toFixed(2)} pillO ${f.pillO.toFixed(2)}`);
    if (process.env.VERBOSE) console.log(`${f.t.toFixed(0).padStart(5)}ms pill x=${f.pill.x.toFixed(2)} w=${f.pill.w.toFixed(2)} | card ${f.morph ? 'M' : ' '} x=${f.bg ? f.bg.x.toFixed(2) : '-'} w=${f.bg ? f.bg.w.toFixed(2) : '-'} cx=${f.bg ? (f.bg.x + f.bg.w / 2).toFixed(2) : '-'} | ${ins} | pill o=${f.pillO.toFixed(2)} ${f.segs.filter((g) => g.r && g.o > 0.05).slice(0, 4).map((g) => `${g.k}@${g.r.x.toFixed(1)}`).join(' ')}`);
  }
  // The pill's leading segment (as it lands): on screen and against the pill's left edge, how far it
  // ever steps back against the way it is going, and the spread of its distance to the edge.
  const last = rec.at(-1).segs.filter((g) => g.r && g.o > 0.05).sort((p, q) => p.r.x - q.r.x)[0];
  // From the click on: before it the pill may still be settling under a growing card (unseen).
  const series = rec.filter((f) => f.clicked).map((f) => ({ f, g: f.segs.find((g) => g.k === last?.k && g.r && g.o > 0.05) })).filter((e) => e.g);
  const swing = (xs) => {
    const dir = Math.sign(xs.at(-1) - xs[0]) || 1;
    let worst = 0;
    for (let i = 1; i < xs.length; i++) worst = Math.max(worst, -dir * (xs[i] - xs[i - 1]));
    return worst;
  };
  const abs = series.map((e) => e.g.r.x);
  const rel = series.map((e) => e.g.r.x - e.f.pill.x);
  const pillBack = abs.length ? swing(abs) : 0;
  const edgeBack = rel.length ? swing(rel) : 0;
  console.log(`pill content '${last?.k}': x ${abs[0]?.toFixed(1)} -> ${abs.at(-1)?.toFixed(1)}, steps back ${pillBack.toFixed(2)} px; to the pill's edge ${Math.min(...rel).toFixed(1)}..${Math.max(...rel).toFixed(1)} px, steps back ${edgeBack.toFixed(2)} px`);
  console.log(`max per-frame sideways move: card centre ${maxBg.toFixed(2)} px (edge stepping back ${back.toFixed(2)} px), content ${maxContent.toFixed(2)} px (${where})`);
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  const worstEdge = Math.max(...Object.values(edgeSwing));
  console.log(`${ok(worstEdge <= 0.5)} shape edges monotonic: worst step back ${worstEdge.toFixed(2)} px (${Object.entries(edgeSwing).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')})`);
  console.log(`${ok(both === 0)} old and new both over 0.5: ${both} frames`);
  console.log(`${ok(empty <= 1)} empty card (old+new < 0.6): ${empty} frames, lowest sum ${minSum === 9 ? '-' : minSum.toFixed(2)}`);
  console.log(`${ok(pillBack <= 0.5)} pill content x monotonic: steps back ${pillBack.toFixed(2)} px`);
  console.log(`${ok(drift <= 1)} card content against the shape: drifts ${drift.toFixed(2)} px per frame at most`);
  return { maxBg, maxContent, pillBack, edgeBack, worstEdge, both, empty, minSum, drift };
}

const a = report('click on a grown hover card', await run(true));
const b = report('click with no hover card', await run(false));
const c = report('click while the hover card is still growing', await run(true, { midGrow: true }));
const d = report('click to close the open island, pointer on the pill', await run(true, { opened: true }));
const e = report('click to close the open island, pointer leaves', await run(true, { opened: true, leave: true }));
await browser.close();
console.log('\nSUMMARY (edge step back px | both>0.5 frames | empty frames | lowest sum | pill back px | content drift px)');
for (const [k, r] of Object.entries({ grown: a, plain: b, midGrow: c, closeOn: d, closeOff: e })) console.log(`${k.padEnd(8)} ${r.worstEdge.toFixed(2)} | ${r.both} | ${r.empty} | ${r.minSum === 9 ? '-' : r.minSum.toFixed(2)} | ${r.pillBack.toFixed(2)} | ${r.drift.toFixed(2)}`);
