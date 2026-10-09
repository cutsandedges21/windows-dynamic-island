// One version everywhere: the exe takes tauri.conf.json's, the crates the workspace's, and the
// Settings page shows package.json's. A release that bumps only some of them fails here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('version', () => {
  it('is the same in package.json, tauri.conf.json and the Cargo workspace', () => {
    const pkg = JSON.parse(read('package.json')).version as string;
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')).version as string;
    const cargo = /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(read('Cargo.toml'))?.[1];
    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(tauri).toBe(pkg);
    expect(cargo).toBe(pkg);
    expect(__APP_VERSION__).toBe(pkg);
  });
});
