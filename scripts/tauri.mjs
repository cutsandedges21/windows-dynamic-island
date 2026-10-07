// Runs the Tauri CLI with the Cargo build cache outside OneDrive, and builds the
// hook relay first so the app can ship and install it.
//
//   node scripts/tauri.mjs dev       live app (vite + cargo debug)
//   node scripts/tauri.mjs build     installer + exe
//   node scripts/tauri.mjs release   one self-contained exe in release/ (no installer)
//   node scripts/tauri.mjs hook      only the hook relay
//   node scripts/tauri.mjs <args>    anything else goes straight to the CLI

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || root, 'AppData', 'Local');
// OneDrive would try to sync gigabytes of build output; keep it in LocalAppData.
const targetDir = process.env.CARGO_TARGET_DIR || join(local, 'windows-dynamic-island', 'target');
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
// Shells inside VS Code / Cursor set this, and it turns any Electron-ish child into plain Node.
delete env.ELECTRON_RUN_AS_NODE;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function buildHook(profile = 'release') {
  run('cargo', ['build', '-p', 'island-hook', ...(profile === 'release' ? ['--release'] : [])]);
  const built = join(targetDir, profile, 'island-hook.exe');
  if (!existsSync(built)) {
    console.error(`island-hook.exe was not produced at ${built}`);
    process.exit(1);
  }
  // tauri.conf.json bundles src-tauri/bin/island-hook.exe as a resource.
  const binDir = join(root, 'src-tauri', 'bin');
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, 'island-hook.exe');
  const same = existsSync(dest) && statSync(dest).size === statSync(built).size && statSync(dest).mtimeMs >= statSync(built).mtimeMs;
  if (!same) copyFileSync(built, dest);
  return dest;
}

const tauriCli = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'hook') {
  console.log(`hook relay: ${buildHook()}`);
} else if (cmd === 'dev') {
  buildHook();
  run(tauriCli, ['dev', ...rest]);
} else if (cmd === 'build') {
  buildHook();
  run('npm', ['run', 'build:web']);
  run(tauriCli, ['build', ...rest]);
} else if (cmd === 'release') {
  // One file to hand out: Island.exe carries the hook relay (build.rs), so no installer.
  buildHook();
  run('npm', ['run', 'build:web']);
  run(tauriCli, ['build', '--no-bundle', ...rest]);
  const out = join(root, 'release');
  mkdirSync(out, { recursive: true });
  // Older releases also shipped these; leave only the exe (and a running Island.old.exe).
  for (const f of readdirSync(out)) {
    if (f === 'island-hook.exe' || f.endsWith('-setup.exe')) rmSync(join(out, f), { force: true });
  }
  copyFileSync(join(targetDir, 'release', 'island.exe'), join(out, 'Island.exe'));
  console.log(`\nrelease/Island.exe is the whole app. Cargo output: ${targetDir}`);
} else {
  run(tauriCli, [cmd, ...rest].filter(Boolean));
}
