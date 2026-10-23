// More: switch between paired PCs, pair another, notifications (phase 3), remove this PC.

import { lastSeenText } from '../format';
import type { LinkState, SavedIsland } from '../link/api';
import type { PushState } from '../push';
import { button, h, ico, openSheet, spinner } from '../ui';

export interface MenuHooks {
  islands: SavedIsland[];
  current: SavedIsland;
  state: LinkState;
  version: string;
  demo: boolean;
  switchTo(id: string): void;
  pairAnother(): void;
  remove(): void;
  push: { state(): Promise<PushState>; set(on: boolean): Promise<void> };
}

export function openMenu(m: MenuHooks): void {
  const s = openSheet({ title: m.current.name, sub: m.state.s === 'online' ? 'Connected' : `Last seen ${lastSeenText(m.current.lastSeen, Date.now())}`, icon: 'laptop' });

  const pcs =
    m.islands.length > 1
      ? h('div', { class: 'ph-section' }, [
          h('div', { class: 'ph-label', text: 'Your PCs' }),
          ...m.islands.map((x) => {
            const on = x.id === m.current.id;
            const b = h('button', { class: `ph-saved-row${on ? ' on' : ''}`, type: 'button' }, [ico('laptop'), h('span', { text: x.name }), on ? ico('check') : ico('chevron-right')]);
            b.addEventListener('click', () => {
              s.close();
              if (!on) m.switchTo(x.id);
            });
            return b;
          }),
        ])
      : null;

  const pushBox = h('div', { class: 'ph-push' }, [spinner()]);
  const drawPush = async () => {
    let st: PushState;
    try {
      st = await m.push.state();
    } catch {
      st = { kind: 'unsupported', text: "Couldn't check notifications." };
    }
    const toggle =
      st.kind === 'on' || st.kind === 'off'
        ? button(st.kind === 'on' ? 'Turn off' : 'Turn on', {
            icon: st.kind === 'on' ? 'x' : 'bell',
            style: st.kind === 'on' ? 'secondary' : 'primary',
            onclick: async () => {
              pushBox.replaceChildren(spinner());
              try {
                await m.push.set(st.kind === 'off');
              } catch (err) {
                pushBox.replaceChildren(h('p', { class: 'ph-error', text: err instanceof Error ? err.message : String(err) }));
                setTimeout(() => void drawPush(), 2500);
                return;
              }
              void drawPush();
            },
          })
        : null;
    pushBox.replaceChildren(h('div', { class: 'ph-push-row' }, [h('div', { class: 'ph-push-text' }, [h('div', { class: 'ph-push-title', text: st.kind === 'on' ? 'Notifications on' : 'Notifications' }), h('div', { class: 'ph-small', text: st.text })]), toggle]));
  };
  void drawPush();

  s.body.append(
    ...(pcs ? [pcs] : []),
    h('div', { class: 'ph-section' }, [h('div', { class: 'ph-label', text: 'Notifications' }), pushBox]),
    h('div', { class: 'ph-section ph-stack' }, [
      button('Pair another PC', {
        icon: 'plus',
        style: 'secondary',
        onclick: () => {
          s.close();
          m.pairAnother();
        },
      }),
      button(`Remove ${m.current.name}`, {
        icon: 'x',
        style: 'danger',
        onclick: () => {
          s.close();
          m.remove();
        },
      }),
    ]),
    h('p', { class: 'ph-small ph-center', text: `Island ${m.version}${m.demo ? ' · demo' : ''}` }),
  );
}
