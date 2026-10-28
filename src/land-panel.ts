// Land anywhere's people: this Island's code to give friends, adding a friend by their code, the
// friends (Remove, Block), and Islands here to add without a code. In Activities › Land and the
// first-run setup.

import { row, stacked } from './controls';
import { native, type LandFriend } from './core/native';
import { h } from './dom';

/** Land anywhere: this Island's code to give friends, adding a friend by their code, and the friends. */
export function landPanel(): HTMLElement {
  const status = h('p', { class: 'muted', text: '' });
  const code = h('div', { class: 'hide-choices' }, [h('span', { class: 'muted', text: 'Loading…' })]);
  const list = h('div', { class: 'land-friends' });
  const input = h('input', { type: 'text', placeholder: 'Paste a friend’s Land code', spellcheck: 'false' });
  const add = h('button', { class: 'btn', text: 'Add' });

  const nearby = h('div', { class: 'land-friends' });
  const fill = async (): Promise<void> => {
    const friends = await native.landFriends();
    list.replaceChildren(...(friends.length ? friends.map(friendRow) : [h('p', { class: 'muted', text: 'No friends yet. Send your code to someone, or paste theirs above.' })]));
    // Islands on this network that can be added without a code (they announced their key, signed).
    const known = new Set(friends.map((f) => f.id));
    const near = await native.landScan();
    const nearIds = new Set(near.map((p) => p.id));
    // Islands here that the Wi-Fi keeps apart, found over the internet (Land's place topic).
    const here = (await native.landPlace()).filter((p) => !nearIds.has(p.id)).map((p) => ({ ...p, here: true }));
    const addable = [...near, ...here].filter((p) => p.anywhere && !known.has(p.anywhere));
    nearby.replaceChildren(...addable.map((p) =>
      row(p.name, 'here' in p ? 'Here, but this Wi-Fi keeps computers apart: add without a code' : 'On this network: add without a code', h('button', { class: 'btn ghost', text: 'Add as friend', onclick: async () => {
        status.textContent = `Asking ${p.name}… They answer on their island.`;
        const r = await native.landFriendAddNearby(p.id);
        status.textContent = r.ok ? `${r.value.name} is your friend now.` : r.error;
        void fill();
      } })),
    ));
  };
  // Answers to the scan arrive over a few seconds.
  setTimeout(() => void (nearby.isConnected && fill()), 2500);
  const friendRow = (f: LandFriend): HTMLElement =>
    row(f.name, `Added ${new Date(f.added).toLocaleDateString()}`, h('div', { class: 'hide-choices' }, [
      h('button', { class: 'btn ghost', text: 'Remove', title: 'They are not told. Add them again with their code.', onclick: async () => { await native.landFriendRemove(f.id, false); void fill(); } }),
      h('button', { class: 'btn ghost', text: 'Block', title: 'Removes them and turns away their requests from now on.', onclick: async () => { await native.landFriendRemove(f.id, true); void fill(); } }),
    ]));
  add.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    add.disabled = true;
    status.textContent = 'Asking… They answer on their island.';
    const r = await native.landFriendAdd(text);
    add.disabled = false;
    if (r.ok) {
      status.textContent = `${r.value.name} is your friend now.`;
      input.value = '';
      void fill();
    } else status.textContent = r.error;
  });
  void (async () => {
    const me = await native.landMe();
    if (!me.ok) return code.replaceChildren(h('span', { class: 'warn', text: me.error }));
    const copy = h('button', { class: 'btn ghost', text: 'Copy', onclick: () => { void native.clipboardSetText(me.value.code); status.textContent = 'Copied. Send it to a friend.'; } });
    code.replaceChildren(h('code', { class: 'land-code', text: me.value.code }), copy);
  })();
  void fill();

  return h('div', { class: 'local-panel' }, [
    h('h3', { text: 'Friends on other networks' }),
    stacked(row('Your Land code', 'Send it to friends you trust. They paste it into their Island to ask to be friends, and you answer on your island.', code)),
    stacked(row('Add a friend', 'Paste the code a friend sent you. Their island asks them; this waits up to 2 minutes for the answer. Both need Island open, with Friends on other networks on.', h('div', { class: 'hide-choices' }, [input, add]))),
    status,
    list,
    nearby,
  ]);
}
