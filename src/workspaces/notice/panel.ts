// Activities › Workspaces, under its options: what "Notice what I work on" keeps and where, what
// you worked on today (with "Make a workspace" for projects that have none), Forget everything.

import { native } from '../../core/native';
import { h } from '../../dom';
import { readDoc } from '../model';
import { leaveSeed } from '../seed';
import { contextName, contexts, dayStart, duration, readTrail, type Context } from './model';

export interface NoticeHost {
  ask<T>(target: string, cmd: string, arg?: unknown): Promise<T | null>;
  /** Opens the Workspaces page (it picks up a seed left for it). */
  openWorkspaces(): void;
}

export function noticePanel(host: NoticeHost): HTMLElement {
  const list = h('div', { class: 'mini-list' }, [h('p', { class: 'muted', text: 'Loading…' })]);
  const fill = async (): Promise<void> => {
    // The running activity knows the last minute too; switched off, the file says what's kept.
    const today = (await host.ask<Context[]>('workspaces', 'today')) ?? contexts(readTrail(await native.noticeLoad()).spans, dayStart(Date.now()));
    const names = new Map(readDoc((await native.wsLoad())?.doc).doc.workspaces.map((w) => [w.id, w.name]));
    if (!today.length) {
      list.replaceChildren(h('p', { class: 'muted', text: 'Nothing yet today. With Notice what I work on switched on (above), what you work on shows here.' }));
      return;
    }
    list.replaceChildren(
      ...today.slice(0, 12).map((c) => {
        const name = contextName(c, c.ws ? names.get(c.ws) : undefined);
        const make = !c.ws
          ? h('button', {
              class: 'btn ghost',
              type: 'button',
              text: 'Make a workspace',
              onclick: () => {
                leaveSeed({ name, description: 'Started from what Island noticed you work on.', apps: c.apps.filter((a) => /\.exe$/i.test(a)).slice(0, 4) });
                host.openWorkspaces();
              },
            })
          : null;
        return h('div', { class: 'mini' }, [h('span', { text: `${name}${c.ws ? ' (workspace)' : ''}` }), h('span', { class: 'muted', text: duration(c.ms) }), make]);
      }),
    );
  };
  const forget = h('button', {
    class: 'btn danger',
    type: 'button',
    text: 'Forget everything',
    onclick: async () => {
      if ((await host.ask<boolean>('workspaces', 'forget')) === null) await native.noticeForget();
      void fill();
    },
  });
  void fill();
  return h('div', { class: 'local-panel' }, [
    h('h3', { text: 'What you worked on today' }),
    list,
    h('p', {
      class: 'muted',
      text: 'With Notice what I work on on, Island reads which app window is in front every few seconds. It keeps what it works out (the program, the project and file names, which workspace) in recent-work.json on this PC for the days set above, then forgets it. Nothing leaves this computer, and time away from the keyboard isn’t counted.',
    }),
    h('div', { class: 'hook-actions' }, [forget]),
  ]);
}
