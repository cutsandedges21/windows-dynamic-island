// The phone link end to end: the real Link (phone/web/src/link) in headless Edge and WebKit,
// dialing a native fake island (phone/wasm/fake-island) through n0's public relays: pairing,
// round trips, files both ways, a terminal, reconnects, removal.
//
//   node scripts/phone.mjs e2e [msedge|webkit|both]     builds the wasm and the fake island first
//   node phone/e2e/run.mjs [msedge|webkit|both]         uses what's built
//
// Needs `npm install` in phone/e2e (Playwright), Microsoft Edge, and for WebKit
// `npx playwright install webkit` with PLAYWRIGHT_BROWSERS_PATH set as below.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || here, 'AppData', 'Local');
const home = path.join(local, 'windows-dynamic-island');
const fakeExe = process.env.FAKE_ISLAND || path.join(home, 'target-phone', 'debug', process.platform === 'win32' ? 'fake-island.exe' : 'fake-island');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(home, 'tools', 'ms-playwright');
const { chromium, webkit } = await import('playwright');
const { build } = await import('vite');

// Modern Standby suspends the network when the screen goes off mid-run (a run takes minutes):
// hold the PC awake until this process ends.
if (process.platform === 'win32') {
  const keepAwake = `$k = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace W -PassThru; while ($true) { [void]$k::SetThreadExecutionState(0x80000003); Start-Sleep 20 }`;
  const awake = spawn('powershell', ['-NoProfile', '-Command', keepAwake], { stdio: 'ignore' });
  process.on('exit', () => awake.kill());
}

const which = process.argv[2] || 'both';
const PORT = 8788;
const dist = path.join(here, 'dist');
const stateDir = path.join(here, 'state');
const failures = [];
const log = (...a) => console.log(...a);
const round = (x) => Math.round(x);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function check(ok, what) {
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

// ------------------------------------------------------------------ the page

await build({
  root: path.join(here, 'page'),
  base: './',
  configFile: false,
  logLevel: 'warn',
  build: { outDir: dist, emptyOutDir: true, target: 'es2022' },
});
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${PORT}/`;

// ------------------------------------------------------------------ the fake island

const fakeEvents = [];
let fake = null;

function startFake() {
  const t0 = Date.now();
  const p = spawn(fakeExe, [stateDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const me = { p, exited: false };
  me.ready = new Promise((resolve, reject) => {
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('READY ')) resolve({ ...JSON.parse(line.slice(6)), startMs: Date.now() - t0 });
        else if (line.startsWith('EVENT ')) fakeEvents.push({ ...JSON.parse(line.slice(6)), at: Date.now() });
      }
    });
    p.on('exit', (c) => {
      me.exited = true;
      reject(new Error(`fake island exited (${c})`));
    });
    setTimeout(() => reject(new Error('fake island not online in 40 s')), 40_000);
  });
  me.ready.catch(() => undefined);
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));
  return me;
}

async function stopFake(how) {
  const f = fake;
  fake = null;
  if (!f || f.exited) return;
  const gone = new Promise((r) => f.p.on('exit', r));
  if (how === 'quit') f.p.stdin.write('quit\n');
  else f.p.kill();
  await gone;
}

function waitFake(pred, timeoutMs, from = 0) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = fakeEvents.slice(from).find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timed out waiting for the fake island'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** The pairing payload with another code (for the wrong-code check). */
function wrongCode(pair) {
  const json = JSON.parse(Buffer.from(pair, 'base64url').toString('utf8'));
  json.code = 'ffffffffffffffffffffffffffffffff';
  return Buffer.from(JSON.stringify(json)).toString('base64url');
}

// ------------------------------------------------------------------ one browser

async function runBrowser(name, island) {
  log(`\n=== ${name} ===`);
  const browser = name === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'msedge' });
  const r = { browser: name };
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log(`  [${name} pageerror] ${e}`));
    page.on('console', (m) => m.type() === 'error' && log(`  [${name} console.error] ${m.text()}`));
    const tLoad = Date.now();
    await page.goto(URL_);
    const phoneId = await page.evaluate(() => window.t.ready);
    r.loadMs = Date.now() - tLoad;

    // Pair (first line `pair`), then the session's first messages.
    const pair = await page.evaluate((p) => window.t.pair(p), island.pair);
    check(pair.saved.name === 'FakeIsland' && pair.saved.id === island.id, `${name}: paired, saved island ${JSON.stringify(pair.saved.name)}`);
    const first = await waitFake((e) => e.e === 'first' && e.phone === phoneId, 5_000);
    check(first.mode === 'pair' && !first.denied && first.name === 'TestPhone', `${name}: island saw pair from this phone's id`);
    r.pairMs = round(pair.ms);
    r.pairToHelloMs = round(pair.helloMs);

    const rtts = await page.evaluate(() => window.t.rtt(10));
    r.rttMedianMs = median(rtts);
    r.rtts = rtts;
    check(rtts.length === 10, `${name}: 10 round trips, median ${r.rttMedianMs} ms`);

    // Phone -> PC: 2 MiB, checked by hash on the island's side.
    let from = fakeEvents.length;
    const up = await page.evaluate(() => window.t.upload(2 * 1024 * 1024));
    const fin = await waitFake((e) => e.e === 'file-in' && e.phone === phoneId, 10_000, from);
    check(up.name === 'from-phone.bin' && fin.sha256 === up.sha256 && fin.size === 2 * 1024 * 1024 && up.lastProgress === 1, `${name}: file to the PC arrived whole (${up.progressCalls} progress calls)`);
    r.upload2MiBMs = round(up.ms);

    // PC -> phone: 1 MiB, checked by hash on the phone's side.
    from = fakeEvents.length;
    const down = await page.evaluate(() => window.t.download(1024 * 1024));
    const fout = await waitFake((e) => e.e === 'file-out', 10_000, from);
    check(down.sha256 === fout.sha256 && down.size === 1024 * 1024 && /file-ok/.test(fout.reply), `${name}: file from the PC arrived whole and was answered file-ok`);
    r.download1MiBMs = round(down.ms);

    // A terminal on the PC, over its own stream of frames.
    from = fakeEvents.length;
    const term = await page.evaluate(() => window.t.term());
    const opened = await waitFake((e) => e.e === 'term-open' && e.id === term.id, 5_000, from);
    check(opened.cols === 80 && opened.rows === 24 && term.title === 'Fake shell', `${name}: terminal ${term.id} opened in ${round(term.openMs)} ms`);
    check(term.titleAfter === 'Build', `${name}: typed into it, echoed in ${round(term.echoMs)} ms; its title changed`);
    const resized = await waitFake((e) => e.e === 'term-resize' && e.id === term.id, 5_000, from);
    check(resized.cols === 100 && resized.rows === 30, `${name}: terminal resized to 100x30`);
    const detached = await waitFake((e) => e.e === 'term-detach' && e.id === term.id, 5_000, from);
    check(detached.inBytes === 'echo hi\r'.length + 'title Build\r'.length + 150 * 1024 && term.closedAfterClose === 0, `${name}: a 150 KiB paste went whole; close() ended only the stream (${detached.why})`);
    const attached = await waitFake((e) => e.e === 'term-attach' && e.id === term.id, 5_000, from);
    check(term.reattachedId === term.id && term.reattachedTitle === 'Build' && attached.replay > 150 * 1024, `${name}: opened it again, ${attached.replay} bytes of its output replayed`);
    check(JSON.stringify(term.exits) === '[0]' && term.closedTimes === 1, `${name}: exit 0, then closed once`);
    check(term.unknown === "That terminal isn't open anymore.", `${name}: an unknown terminal -> ${JSON.stringify(term.unknown)}`);
    const listed = term.terms.items.find((i) => i.id === term.id);
    check(term.terms.allowed === true && listed && listed.exit === 0 && listed.title === 'Build', `${name}: term-list -> terms (${term.terms.items.length})`);

    // A reload: same key, `hi` this time.
    await page.reload();
    await page.evaluate(() => window.t.ready);
    from = fakeEvents.length;
    const open = await page.evaluate((s) => window.t.open(s), pair.saved);
    const hi = await waitFake((e) => e.e === 'first' && e.phone === phoneId, 5_000, from);
    check(hi.mode === 'hi' && !hi.denied, `${name}: reconnected with hi after a reload`);
    r.hiOnlineMs = round(open.onlineMs);
    r.hiHelloMs = round(open.helloMs);
    const rtts2 = await page.evaluate(() => window.t.rtt(3));
    check(rtts2.length === 3, `${name}: round trips after hi`);

    if (name === 'msedge' || process.env.E2E_HIDDEN) {
      // Hidden: dropped after HIDDEN_CLOSE_MS (30 s), back when shown.
      from = fakeEvents.length;
      const tHide = Date.now();
      await page.evaluate(() => window.t.setHidden(true));
      await waitFake((e) => e.e === 'closed' && e.phone === phoneId, 40_000, from);
      r.hiddenClosedAfterMs = Date.now() - tHide;
      check((await page.evaluate(() => window.t.state().s)) === 'idle', `${name}: hidden page dropped its connection after ${r.hiddenClosedAfterMs} ms`);
      const tShow = Date.now();
      await page.evaluate(() => window.t.setHidden(false));
      await page.evaluate(() => window.t.waitState('online', 30_000));
      r.shownOnlineMs = Date.now() - tShow;
      check(true, `${name}: shown again, online in ${r.shownOnlineMs} ms`);
    }

    // The island quits cleanly, then comes back.
    let t0 = Date.now();
    await stopFake('quit');
    await page.evaluate(() => window.t.waitState('offline', 60_000));
    r.offlineAfterQuitMs = Date.now() - t0;
    t0 = Date.now();
    fake = startFake();
    const again = await fake.ready;
    await page.evaluate(() => window.t.waitState('online', 60_000));
    r.onlineAfterRestartMs = Date.now() - t0;
    r.fakeOnlineMs = again.startMs;
    check((await page.evaluate(() => window.t.rtt(2))).length === 2, `${name}: offline ${r.offlineAfterQuitMs} ms after the island quit; online ${r.onlineAfterRestartMs} ms after it restarted`);

    // The island dies (no goodbye), then comes back.
    t0 = Date.now();
    await stopFake('kill');
    await page.evaluate(() => window.t.waitState('offline', 60_000));
    r.offlineAfterKillMs = Date.now() - t0;
    t0 = Date.now();
    fake = startFake();
    await fake.ready;
    await page.evaluate(() => window.t.waitState('online', 60_000));
    r.onlineAfterKillRestartMs = Date.now() - t0;
    check((await page.evaluate(() => window.t.rtt(2))).length === 2, `${name}: offline ${r.offlineAfterKillMs} ms after the island died; online ${r.onlineAfterKillRestartMs} ms after it restarted`);

    // Removed on the PC: `bye`, and the link stops.
    await page.evaluate(() => window.t.send({ t: 'act', action: 'act:test:remove' }));
    await page.evaluate(() => window.t.waitState('removed', 10_000));
    check(true, `${name}: removed by the PC -> state removed`);

    // A phone the island doesn't know, and a wrong code.
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(URL_);
    await p2.evaluate(() => window.t.ready);
    await p2.evaluate((s) => window.t.open(s, 30_000).catch(() => undefined), { ...pair.saved });
    const denied = await p2.evaluate(() => window.t.waitState('denied', 30_000).then(() => window.t.state()));
    check(denied.s === 'denied' && denied.why === 'unknown', `${name}: unknown phone -> denied unknown`);
    const wrong = await p2.evaluate((p) => window.t.pairError(p), wrongCode(island.pair));
    check(wrong && wrong.why === 'code' && wrong.state.s === 'denied' && wrong.state.why === 'code', `${name}: wrong code -> denied code (${wrong && wrong.error})`);
    await ctx2.close();
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    log(`  FAIL ${name}: ${e.stack || e}`);
  } finally {
    await browser.close();
  }
  return r;
}

// ------------------------------------------------------------------ run

fs.rmSync(stateDir, { recursive: true, force: true });
fake = startFake();
const island = await fake.ready;
log(`fake island ${island.id} online in ${island.startMs} ms via ${island.relays.join(' ')}`);
const results = [];
for (const name of which === 'both' ? ['msedge', 'webkit'] : [which]) {
  if (!fake) {
    fake = startFake();
    await fake.ready;
  }
  results.push(await runBrowser(name, island));
}
await stopFake('quit');
server.close();
log('\nRESULTS');
for (const r of results) log(JSON.stringify(r));
log(failures.length ? `\n${failures.length} FAILED:\n  ${failures.join('\n  ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
