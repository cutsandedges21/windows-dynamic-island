// Panels on a workspace's page that come with restoring: the restore as it goes (with the
// question it asks, answered right here or on the island), the last few restores, and the
// window layout (drawn small, each window switchable, saved again or put back now).

import { agoText } from '../core/format';
import { icon } from '../core/icons';
import { native } from '../core/native';
import { platform } from '../core/platform';
import { toggle } from '../controls';
import { h } from '../dom';
import type { Ctx } from './ctx';
import { captureLayout, itemFor, planPlacement, programNames } from './layout';
import { appName, KIND_META, wsColor, type RestoreRun, type WindowLayout, type Workspace } from './model';
import { jobSummary, type Job, type JobStep } from './restore';
import { confirmBox, pickBox, toast } from './ui';

const STATE_WORDS: Record<JobStep['state'], string> = {
  waiting: 'Waiting',
  asking: 'Asks first',
  opening: 'Opening…',
  done: 'Done',
  skipped: 'Skipped',
  failed: "Didn't open",
  cancelled: 'Stopped',
};

// ------------------------------------------------------------------ a restore as it goes

export function jobPanel(ctx: Ctx, job: Job): HTMLElement {
  const running = job.state === 'running';
  const rows = job.steps.flatMap((s, i) => {
    const kind = s.kind === 'layout' ? 'window' : KIND_META[s.kind].icon;
    const li = h('li', { class: `ws-step st-${s.state}` }, [
      h('span', { class: 'ws-step-n', text: String(i + 1) }),
      h('span', { class: 'ws-kind', html: icon(kind) }),
      h('div', { class: 'ws-step-text' }, [
        h('div', { class: 'ws-step-title', text: s.label }),
        s.why ? h('div', { class: s.state === 'failed' ? 'ws-step-why' : 'ws-step-note', text: s.why }) : null,
      ]),
      h('span', { class: 'ws-state', text: STATE_WORDS[s.state] }),
    ]);
    if (s.state !== 'asking') return [li];
    const ask = h('div', { class: 'ws-ask' }, [
      h('div', { text: s.kind === 'command' ? 'Run this command?' : `Open ${s.label}?` }),
      s.detail ? h('pre', { text: s.detail }) : null,
      h('div', { class: 'hide-choices' }, [
        h('button', { class: 'btn primary sm', type: 'button', text: s.kind === 'command' ? 'Run it' : 'Open it', 'data-focus': 'ask:yes', onclick: () => ctx.answer(s.id, 'yes') }),
        h('button', { class: 'btn sm', type: 'button', text: 'Skip', onclick: () => ctx.answer(s.id, 'skip') }),
        h('button', { class: 'btn sm ghost', type: 'button', text: 'Stop restoring', onclick: () => ctx.answer(s.id, 'stop') }),
      ]),
    ]);
    return [li, ask];
  });
  const failed = job.steps.some((s) => s.state === 'failed');
  const foot = h('div', { class: 'ws-job-foot' }, [
    h('span', { class: 'grow', text: running ? `Restoring · ${jobSummary(job)}` : jobSummary(job) }),
    running ? h('button', { class: 'btn sm ghost', type: 'button', text: 'Stop', onclick: () => ctx.cancel() }) : null,
    !running && failed ? h('button', { class: 'btn sm primary', type: 'button', text: 'Try again', title: 'Only what didn’t open', onclick: () => ctx.retry() }) : null,
    !running
      ? h('button', {
          class: 'btn sm ghost',
          type: 'button',
          text: 'Close',
          onclick: () => {
            ctx.ui.jobClosed = job.id;
            ctx.paint();
          },
        })
      : null,
  ]);
  return h('section', { class: 'ws-panel ws-job' }, [h('h2', { text: running ? 'Restoring' : 'Last restore' }), h('ol', { class: 'ws-steps' }, rows), foot]);
}

// ------------------------------------------------------------------ history

export function runSummary(run: RestoreRun): string {
  const done = run.steps.filter((s) => s.status === 'done').length;
  const failed = run.steps.filter((s) => s.status === 'failed').length;
  if (run.outcome === 'cancelled') return `Stopped after ${done} of ${run.steps.length}`;
  if (!failed) return run.steps.length === 1 ? 'Opened' : `All ${done} opened`;
  return `${done} of ${run.steps.length} opened`;
}

export function historyPanel(ws: Workspace): HTMLElement | null {
  if (!ws.history.length) return null;
  return h('section', { class: 'ws-panel' }, [
    h('h2', { text: 'Recent restores' }),
    h(
      'div',
      { class: 'ws-runs' },
      ws.history.slice(0, 5).map((run) => {
        const fails = run.steps.filter((s) => s.status === 'failed');
        const failText = fails.slice(0, 2).map((f) => `${f.label}: ${f.why}`).join(' · ') + (fails.length > 2 ? ` · +${fails.length - 2} more` : '');
        return h('div', { class: 'ws-run' }, [
          h('span', { class: `ws-dot ${run.outcome}` }),
          h('span', { text: runSummary(run) }),
          h('span', { class: 'ws-run-when', text: agoText(Date.now() - run.at) }),
          fails.length ? h('div', { class: 'ws-run-fail', text: failText }) : null,
        ]);
      }),
    ),
  ]);
}

// ------------------------------------------------------------------ window layout

const screenName = (n: string) => (n.length > 22 ? `${n.slice(0, 21)}…` : n);

/** The saved layout drawn small: the screens as they were, the windows on them. */
export function layoutMap(layout: WindowLayout, color: string): HTMLElement {
  const rects = layout.monitors.length ? layout.monitors.map((m) => m.bounds) : layout.windows.map((w) => w.rect);
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const W = Math.max(1, Math.max(...rects.map((r) => r.x + r.width)) - minX);
  const H = Math.max(1, Math.max(...rects.map((r) => r.y + r.height)) - minY);
  const pos = (r: { x: number; y: number; width: number; height: number }) =>
    `left:${((r.x - minX) / W) * 100}%;top:${((r.y - minY) / H) * 100}%;width:${(r.width / W) * 100}%;height:${(r.height / H) * 100}%`;
  const map = h('div', { class: 'ws-map', style: `aspect-ratio:${W} / ${H};--wc:${color}` });
  for (const m of layout.monitors) map.append(h('div', { class: 'ws-map-screen', style: pos(m.bounds) }, [h('span', { text: screenName(m.name) })]));
  for (const w of layout.windows) {
    const screen = layout.monitors.find((m) => m.id === w.monitor);
    const r = w.state === 'maximized' && screen ? screen.work : w.rect;
    map.append(h('div', { class: `ws-map-win${w.enabled ? '' : ' off'}${w.state === 'maximized' ? ' max' : ''}`, style: pos(r), title: `${appName(w.exe)}: ${w.title}`, text: appName(w.exe) }));
  }
  return map;
}

/** Asks which open windows belong to the workspace, then saves where they are. */
export async function saveLayout(ctx: Ctx, ws: Workspace): Promise<void> {
  const live = await native.wsWindows();
  if (!live.ok) return toast(live.error);
  const monitors = await native.monitors();
  const picked = await pickBox({
    title: 'Which windows are part of it?',
    text: 'Their places are saved now, on these screens; restoring puts them back. The windows of its apps are ticked.',
    several: true,
    yes: 'Save',
    empty: 'No app windows are open.',
    load: async () =>
      live.value.map((w) => ({
        key: String(w.hwnd),
        title: w.title,
        detail: `${appName(w.exe)}${w.state === 'normal' ? '' : ` · ${w.state}`}`,
        icon: 'window',
        on: itemFor(w.exe, ws.resources) !== null,
      })),
  });
  if (!picked || !picked.keys.length) return;
  const chosen = live.value.filter((w) => picked.keys.includes(String(w.hwnd)));
  const layout = captureLayout(chosen, monitors, ws.resources);
  if (await ctx.store.update(ws.id, { layout })) toast(`Saved where ${chosen.length} ${chosen.length === 1 ? 'window is' : 'windows are'}.`);
}

/** Puts the saved windows back without opening anything. */
export async function placeNow(ws: Workspace): Promise<void> {
  if (!ws.layout) return;
  const live = await native.wsWindows();
  if (!live.ok) return toast(live.error);
  const plan = planPlacement(ws.layout, live.value, await native.monitors());
  if (!plan.places.length) return toast(`None of its windows are open${plan.missing.length ? ` (${programNames(plan.missing)})` : ''}.`);
  const r = await native.wsPlace(plan.places.map((p) => ({ hwnd: p.hwnd, rect: p.rect, state: p.state })));
  if (!r.ok) return toast(r.error);
  const ok = r.value.filter((x) => x.ok).length;
  const why = r.value.find((x) => !x.ok)?.why;
  const parts = [`Put ${ok} of ${plan.places.length + plan.missing.length} windows back.`, plan.missing.length ? `Not open: ${programNames(plan.missing)}.` : '', why ?? '', ...plan.notes];
  toast(parts.filter(Boolean).join(' '));
}

export function layoutPanel(ctx: Ctx, ws: Workspace, readOnly: boolean): HTMLElement {
  const head = h('h2', { text: 'Window layout' });
  if (platform === 'macos') return h('section', { class: 'ws-panel' }, [head, h('p', { class: 'muted', text: 'Window layouts come to the Mac later.' })]);
  const layout = ws.layout;
  const save = h('button', { class: 'btn sm', type: 'button', text: layout ? 'Save again…' : 'Save the layout…', disabled: readOnly || !native.isTauri, onclick: () => void saveLayout(ctx, ws) });
  if (!layout || !layout.windows.length) {
    return h('section', { class: 'ws-panel' }, [
      head,
      h('p', { class: 'muted', text: 'None saved. Put this work’s windows where you like them, then save: restoring puts each one back, on the same screen if it’s still connected.' }),
      save,
    ]);
  }
  const screens = new Set(layout.windows.map((w) => w.monitor)).size;
  const sub = `${layout.windows.length} ${layout.windows.length === 1 ? 'window' : 'windows'}${screens > 1 ? ` on ${screens} screens` : ''} · saved ${agoText(Date.now() - layout.savedAt)}`;
  const wins = layout.windows.map((w) => {
    const on = toggle(w.enabled, (v) => {
      const next = structuredClone(layout);
      next.windows.find((x) => x.id === w.id)!.enabled = v;
      void ctx.store.update(ws.id, { layout: next });
    }, `Put ${appName(w.exe)} back`);
    if (readOnly) (on as HTMLButtonElement).disabled = true;
    return h('div', { class: 'ws-win' }, [h('div', { class: 'ws-win-text' }, [h('b', { text: appName(w.exe) }), h('span', { text: `${w.title}${w.state === 'normal' ? '' : ` · ${w.state}`}` })]), on]);
  });
  const auto = toggle(ws.prefs.placeWindows, (v) => void ctx.store.update(ws.id, { prefs: { ...ws.prefs, placeWindows: v } }), 'Put windows back when restoring');
  const remove = h('button', {
    class: 'btn sm ghost danger',
    type: 'button',
    text: 'Remove',
    disabled: readOnly,
    onclick: async () => {
      const sure = await confirmBox({ title: 'Remove the saved layout?', text: 'Restoring will open things without moving windows. The windows themselves stay where they are.', yes: 'Remove', danger: true });
      if (sure) void ctx.store.update(ws.id, { layout: null });
    },
  });
  return h('section', { class: 'ws-panel' }, [
    head,
    h('p', { class: 'muted', text: sub }),
    layoutMap(layout, wsColor(ws, ctx.accent())),
    h('div', { class: 'ws-win' }, [h('div', { class: 'ws-win-text' }, [h('b', { text: 'Put them back when restoring' })]), auto]),
    h('div', { class: 'ws-wins' }, wins),
    h('div', { class: 'hide-choices', style: 'margin-top:10px' }, [
      h('button', { class: 'btn sm primary', type: 'button', text: 'Put them back now', disabled: !native.isTauri, onclick: () => void placeNow(ws) }),
      save,
      remove,
    ]),
  ]);
}
