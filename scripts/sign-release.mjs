// Signs a release so Island's self-updater installs it (src-tauri/src/updater.rs).
//
//   node scripts/sign-release.mjs keygen      makes the signing key (once, ever) and prints its
//                                             public half for UPDATE_KEY in updater.rs
//   node scripts/sign-release.mjs 0.3.0       signs release/Island.exe as version 0.3.0 and prints
//                                             the line to paste into that release's notes
//   node scripts/sign-release.mjs 0.3.0 release/Island.exe C:/tmp/Island.dmg
//                                             signs each file given (the Windows exe and the Mac
//                                             disk image): one line per file, all go in the notes
//
// The key lives outside the repository (the repo is public): %USERPROFILE%\.island\update-signing-key.pem,
// or wherever ISLAND_SIGNING_KEY points. Back it up: without it no Island can be updated again,
// only downloaded by hand.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = process.env.ISLAND_SIGNING_KEY || join(homedir(), '.island', 'update-signing-key.pem');

/** What the updater checks: the version it installs and the exact bytes, signed together. */
export function message(version, sha256hex) {
  return Buffer.from(`island-update\n${version}\n${sha256hex}`, 'utf8');
}

function publicHex(privateKey) {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('hex');
}

const arg = process.argv[2];
if (arg === 'keygen') {
  if (existsSync(keyFile)) {
    console.error(`A signing key already exists at ${keyFile}. Use that one: Islands out there trust only it.`);
    process.exit(1);
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  console.log(`Signing key saved to ${keyFile}. Back it up somewhere safe.`);
  console.log(`UPDATE_KEY = "${publicHex(privateKey)}"`);
} else if (arg && /^v?\d+\.\d+\.\d+$/.test(arg)) {
  const version = arg.replace(/^v/, '');
  if (!existsSync(keyFile)) {
    console.error(`No signing key at ${keyFile}.`);
    process.exit(1);
  }
  const privateKey = createPrivateKey(readFileSync(keyFile));
  const files = process.argv.length > 3 ? process.argv.slice(3) : [join(root, 'release', 'Island.exe')];
  const lines = files.map((file) => {
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    console.log(`Signed ${file} as ${version} (sha256 ${digest}) with key ${publicHex(privateKey).slice(0, 16)}…`);
    return `<!-- island-signature: ${sign(null, message(version, digest), privateKey).toString('base64')} -->`;
  });
  console.log('Paste these lines into the release notes (they stay invisible on GitHub):');
  for (const line of lines) console.log(line);
} else {
  console.error('Usage: node scripts/sign-release.mjs keygen | <version> [file ...]');
  process.exit(1);
}
