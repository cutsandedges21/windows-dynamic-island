import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// The release routine bumps package.json with the exe (test/version.test.ts keeps them equal).
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// The Mac build (macos.yml sets ISLAND_MAC=1). A Mac draws Island with its own Safari engine, which on
// macOS 12 (the oldest Island runs on) is Safari 15: there the code and the CSS are lowered for it
// (nesting, -webkit- prefixes, regex features it can't parse). Without the variable, nothing changes.
const mac = process.env.ISLAND_MAC === '1';

/**
 * The Mac build only: what Safari 15 lacks (src/mac/compat.ts) goes in front of each page's code, and
 * the one regex it can't read is swapped for the same thing done by hand. The build stops if another
 * lookbehind turns up, so a Mac never gets a page that won't load.
 */
function macCompat(): Plugin {
  const pages = /[\\/]src[\\/](main|app)\.ts$/;
  // src/activities/claude-status/estimate.ts: everything before the first lone `|`.
  const lonePipe = 'c.split(/(?<!\\|)\\|(?!\\|)/)[0]';
  return {
    name: 'island-mac-compat',
    enforce: 'pre',
    transform(code, id) {
      if (pages.test(id)) return `import './mac/compat';\n${code}`;
      if (code.includes(lonePipe)) {
        return code.split(lonePipe).join('(globalThis as unknown as { __islandBeforeLonePipe(s: string): string }).__islandBeforeLonePipe(c)');
      }
      return null;
    },
    generateBundle(_, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && /\(\?<[=!]/.test(chunk.code)) {
          this.error(`${name} uses a regex lookbehind, which Safari 15 (macOS 12) can't read: give it a Mac way round in vite.config.ts (macCompat)`);
        }
      }
    },
  };
}

// Two pages: index.html is the island overlay, app.html the Activities + Settings window.
export default defineConfig({
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: mac ? [macCompat()] : [],
  server: {
    port: 1430,
    strictPort: true,
    // phone/dist too: building the phone site reloaded the island mid-session, and it did not come back.
    watch: { ignored: ['**/src-tauri/**', '**/hook/**', '**/release/**', '**/phone/dist/**'] },
  },
  build: {
    target: mac ? ['es2022', 'safari15'] : 'es2022',
    ...(mac ? { cssTarget: ['safari15'] } : {}),
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        island: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
