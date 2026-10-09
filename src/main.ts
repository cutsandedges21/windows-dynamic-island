// Island window entry.

import './styles/island.css';
import { createRegistry } from './activities/registry';
import { Island } from './core/island';
import { runMirror } from './core/mirror';
import { emitLocal, native, windowLabel } from './core/native';

const stage = document.getElementById('stage')!;
if (native.demo) document.body.classList.add('demo');

// Duplicate mode: this window is a copy of the pill on another screen.
const mirror = windowLabel.startsWith('mirror-');
const island = mirror ? null : new Island(stage, createRegistry());
if (mirror) void runMirror(stage).catch((err) => void native.log(`mirror failed: ${String(err)}`));
island?.boot().catch((err) => {
  console.error('island failed to boot', err);
  void native.log(`boot failed: ${String(err)}`);
});

// Handy in devtools and for automated checks.
(window as unknown as { island: Island | null }).island = island;
// The browser preview only: lets a check feed the island realistic data.
if (native.demo && island) {
  Object.assign(window, { native, emitLocal });
  if (new URLSearchParams(location.search).has('fill')) void import('./dev/fill').then((m) => m.fillPreview(island, native, emitLocal));
  if (new URLSearchParams(location.search).has('pet')) void import('./dev/pet').then((m) => m.petPreview());
}
