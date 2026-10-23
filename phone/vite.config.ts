import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// The phone website (Island on your phone): a static site from phone/web, built into phone/dist
// and hosted on Vercel. It draws with the island's own renderers and CSS from ../src, hence the
// repo root in server.fs.allow. scripts/phone.mjs drives it (dev, build, deploy); for the UI alone,
// `npx vite --config phone/vite.config.ts` and open http://localhost:1431/?demo.

const repo = resolve(__dirname, '..');
const { version } = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  root: resolve(__dirname, 'web'),
  publicDir: resolve(__dirname, 'web/public'),
  // Relative URLs: the same build works at the site's root and under any path.
  base: './',
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 1431,
    strictPort: true,
    fs: { allow: [repo] },
  },
  preview: { port: 1431, strictPort: true },
  build: {
    target: 'es2022',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
  worker: { format: 'es' },
});
