// Builds the phone website (Island on your phone; docs/superpowers/specs/2026-10-22-island-phone-design.md).
// The iroh endpoint in phone/wasm is Rust built for wasm32; Cargo output stays outside OneDrive.
//
//   node scripts/phone.mjs wasm      phone/wasm -> phone/web/src/link/pkg (wasm-bindgen + wasm-opt)
//   node scripts/phone.mjs dev       the site live (builds the wasm first if it's missing)
//   node scripts/phone.mjs build     the site in phone/dist
//   node scripts/phone.mjs deploy    build, then publish phone/dist on Vercel (project islandphone)
//   node scripts/phone.mjs fake      the fake island the link tests dial (native)
//   node scripts/phone.mjs e2e [msedge|webkit|both]   wasm + fake island + phone/e2e/run.mjs
//
// Tools, looked for in %LOCALAPPDATA%\windows-dynamic-island\tools (then PATH):
//   llvm\bin\clang.exe + llvm-ar.exe   ring (iroh's TLS) compiles C for wasm32 with clang
//   wbg\bin\wasm-bindgen.exe           the exact wasm-bindgen version in phone/wasm/Cargo.lock
//   binaryen\bin\wasm-opt.exe          optional size pass
// and rustup's wasm32-unknown-unknown target. Each missing one is reported with where to get it.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const exe = (name) => (win ? `${name}.exe` : name);
const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || process.env.HOME || root, win ? join('AppData', 'Local') : '.local/share');
const home = join(local, 'windows-dynamic-island');
const tools = process.env.ISLAND_TOOLS || join(home, 'tools');
const targetDir = process.env.CARGO_TARGET_DIR_PHONE || join(home, 'target-phone');
const crate = join(root, 'phone', 'wasm');
const pkg = join(root, 'phone', 'web', 'src', 'link', 'pkg');
const dist = join(root, 'phone', 'dist');
const viteConfig = join('phone', 'vite.config.ts');
const VERCEL_PROJECT = 'islandphone';

const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
// Shells inside VS Code / Cursor set this, and it turns any Electron-ish child into plain Node.
delete env.ELECTRON_RUN_AS_NODE;

function run(cmd, args, opts = {}) {
  // npm and npx are .cmd shims on Windows, which only a shell can start; the rest are real exes.
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: win && (cmd === 'npx' || cmd === 'npm'), ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function fail(lines) {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
}

/** A tool from the tools folder, else from PATH. */
function tool(rel, name) {
  const inTools = join(tools, rel, exe(name));
  if (existsSync(inTools)) return inTools;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const p = join(dir, exe(name));
    if (dir && existsSync(p)) return p;
  }
  return null;
}

/** The wasm-bindgen version Cargo.lock pins; the CLI must be exactly this one. */
function lockedWasmBindgen() {
  const lock = readFileSync(join(crate, 'Cargo.lock'), 'utf8');
  const m = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/);
  return m ? m[1] : null;
}

function checkTools() {
  const targets = spawnSync('rustup', ['target', 'list', '--installed'], { env, encoding: 'utf8' });
  if (targets.status === 0 && !targets.stdout.includes('wasm32-unknown-unknown')) {
    fail(['The wasm32 target is missing. Add it with:', '  rustup target add wasm32-unknown-unknown']);
  }
  const clang = process.env.CC_wasm32_unknown_unknown || tool(join('llvm', 'bin'), 'clang');
  const ar = process.env.AR_wasm32_unknown_unknown || tool(join('llvm', 'bin'), 'llvm-ar');
  if (!clang || !ar) {
    fail([
      'clang (and llvm-ar) for wasm32 not found. ring, iroh\'s TLS, compiles C for the browser with clang.',
      `Put them in ${join(tools, 'llvm')} (bin\\clang.exe, bin\\llvm-ar.exe, lib\\clang\\<ver>\\include), no admin needed:`,
      '  1. Download clang+llvm-<ver>-x86_64-pc-windows-msvc.tar.zst (or .tar.xz) from',
      '     https://github.com/llvm/llvm-project/releases (23.1.4 was used) into an empty folder.',
      '  2. Extract only bin/clang.exe, bin/llvm-ar.exe and lib/clang/<ver>/include into the folder above.',
      '     The .tar.zst uses a long zstd window that Windows tar refuses; Python\'s `zstandard`',
      '     (ZstdDecompressor(max_window_size=2**31)) with tarfile reads it. The .tar.xz works with tar -xJf.',
      'On a Mac: brew install llvm (Apple\'s clang has no WebAssembly backend), then set',
      '  CC_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/clang AR_wasm32_unknown_unknown=$(brew --prefix llvm)/bin/llvm-ar',
      'Or set CC_wasm32_unknown_unknown / AR_wasm32_unknown_unknown to any clang with the WebAssembly target.',
    ]);
  }
  const want = lockedWasmBindgen();
  const bindgen = tool(join('wbg', 'bin'), 'wasm-bindgen');
  const have = bindgen && spawnSync(bindgen, ['--version'], { encoding: 'utf8' }).stdout?.trim().split(' ')[1];
  if (!bindgen || have !== want) {
    fail([
      bindgen ? `wasm-bindgen ${have} found at ${bindgen}, but Cargo.lock has ${want}; they must match.` : 'wasm-bindgen (the CLI) not found.',
      'Install the matching one into the tools folder:',
      `  cargo install wasm-bindgen-cli --version ${want} --locked --root "${join(tools, 'wbg')}"`,
      '(set CARGO_TARGET_DIR outside OneDrive while it builds).',
    ]);
  }
  const wasmOpt = tool(join('binaryen', 'bin'), 'wasm-opt');
  return { clang, ar, bindgen, wasmOpt };
}

function buildWasm() {
  const { clang, ar, bindgen, wasmOpt } = checkTools();
  run('cargo', ['build', '--manifest-path', join(crate, 'Cargo.toml'), '-p', 'island-phone', '--target', 'wasm32-unknown-unknown', '--profile', 'wasm-release'], {
    env: { ...env, CC_wasm32_unknown_unknown: clang, AR_wasm32_unknown_unknown: ar },
  });
  const wasm = join(targetDir, 'wasm32-unknown-unknown', 'wasm-release', 'island_phone.wasm');
  run(bindgen, ['--target', 'web', '--out-dir', pkg, wasm]);
  const out = join(pkg, 'island_phone_bg.wasm');
  if (wasmOpt) {
    // The feature flags are what rustc emits for wasm32-unknown-unknown by default (Safari 16.4+ has them all).
    const features = ['bulk-memory', 'bulk-memory-opt', 'nontrapping-float-to-int', 'sign-ext', 'reference-types', 'multivalue', 'mutable-globals', 'call-indirect-overlong'];
    run(wasmOpt, ['-Oz', ...features.map((f) => `--enable-${f}`), out, '-o', out]);
  } else {
    console.warn(
      `\nwasm-opt not found (optional: it cuts the wasm by about a third). Get binaryen-version_<n>-x86_64-windows.tar.gz from\nhttps://github.com/WebAssembly/binaryen/releases and put bin/wasm-opt.exe in ${join(tools, 'binaryen', 'bin')}.\n`,
    );
  }
  console.log(`\nphone link: ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB). Cargo output: ${targetDir}`);
}

function buildFake() {
  run('cargo', ['build', '--manifest-path', join(crate, 'Cargo.toml'), '-p', 'fake-island']);
  return join(targetDir, 'debug', exe('fake-island'));
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'wasm') {
  buildWasm();
} else if (cmd === 'dev') {
  if (!existsSync(join(pkg, 'island_phone_bg.wasm'))) buildWasm();
  run('npx', ['vite', '--config', viteConfig, ...rest]);
} else if (cmd === 'build') {
  buildWasm();
  run('npx', ['vite', 'build', '--config', viteConfig, ...rest]);
  console.log(`\nphone site: ${dist}`);
} else if (cmd === 'deploy') {
  buildWasm();
  run('npx', ['vite', 'build', '--config', viteConfig]);
  // A static upload of phone/dist to the Vercel project; nothing is built on Vercel.
  run('npx', ['vercel', 'deploy', dist, '--prod', '--yes', '--project', VERCEL_PROJECT, ...rest]);
} else if (cmd === 'fake') {
  console.log(`fake island: ${buildFake()}`);
} else if (cmd === 'e2e') {
  if (!rest.includes('--no-build')) buildWasm();
  const fake = buildFake();
  run('node', [join('phone', 'e2e', 'run.mjs'), ...rest.filter((a) => a !== '--no-build')], { env: { ...env, FAKE_ISLAND: fake } });
} else {
  fail(['usage: node scripts/phone.mjs wasm | dev | build | deploy | fake | e2e [msedge|webkit|both]']);
}
