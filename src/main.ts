// Island window entry.

import './styles/island.css';
import './styles/player.css';
import { createRegistry } from './activities/registry';
import { Island } from './core/island';
import { runMirror } from './core/mirror';
import { catchErrors } from './core/errors';
import { emitLocal, native, windowLabel } from './core/native';
import { runWidget } from './core/widgets';
import { runDock } from './core/dock';
import { runFrame } from './core/frame';
import { workspaceEngine } from './workspaces/engine';

catchErrors(windowLabel, (line) => void native.log(line));

const stage = document.getElementById('stage')!;
if (native.demo) document.body.classList.add('demo');

// Duplicate mode: this window is a copy of the pill on another screen.
const mirror = windowLabel.startsWith('mirror-');
// A desktop widget: one tile on the desktop, drawn from what the island sends it.
const widget = windowLabel.startsWith('widget-');
// The taskbar: drawn from what the island sends it.
// The browser preview of it: /?dock (src/dev/dock.ts).
const dockPreview = native.demo && new URLSearchParams(location.search).has('dock');
const dock = windowLabel === 'dock' || dockPreview;
// The screen border and its notches; its browser preview: /?frame (src/dev/frame.ts), with &dock too.
const framePreview = native.demo && new URLSearchParams(location.search).has('frame');
const frameWin = windowLabel === 'frame' || framePreview;
// Island's Start menu (src/core/startmenu.ts); its browser preview: /?start (src/dev/start.ts).
const startPreview = native.demo && new URLSearchParams(location.search).has('start');
const startWin = windowLabel === 'start' || startPreview;
const island = mirror || widget || dock || frameWin || startWin ? null : new Island(stage, createRegistry());
if (startWin) void import('./core/startmenu').then((m) => m.runStart(stage)).catch((err) => void native.log(`start menu failed: ${String(err)}`));
if (startPreview) void import('./dev/start').then((m) => m.startPreview(emitLocal));
if (frameWin) void runFrame(stage).catch((err) => void native.log(`screen border failed: ${String(err)}`));
if (framePreview) void import('./dev/frame').then((m) => m.framePreview(emitLocal));
if (dock) void runDock(stage).catch((err) => void native.log(`taskbar failed: ${String(err)}`));
if (dockPreview) void import('./dev/dock').then((m) => m.dockPreview(emitLocal));
if (widget) void runWidget(stage).catch((err) => void native.log(`widget failed: ${String(err)}`));
if (mirror) void runMirror(stage).catch((err) => void native.log(`mirror failed: ${String(err)}`));
// Workspaces restore from here: the island lives as long as Island runs.
if (island) workspaceEngine();
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
  if (new URLSearchParams(location.search).has('widget')) void import('./dev/widget').then((m) => m.widgetPreview(stage));
  const land = new URLSearchParams(location.search).get('land');
  if (land !== null) void import('./dev/land').then((m) => m.landPreview(island, native, land));
}
