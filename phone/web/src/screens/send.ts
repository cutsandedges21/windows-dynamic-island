// Send (phase 2): photos and files to the PC's Downloads, one after another with their progress,
// and text or a link to the PC's clipboard (shown on the island too).

import { MAX_UPLOAD } from '../../../../src/remote/protocol';
import { fileSize } from '../format';
import type { Link } from '../link/api';
import { button, h, openSheet, toast } from '../ui';

export function openSend(link: Link, pc: string): void {
  const s = openSheet({ title: `Send to ${pc}`, icon: 'upload' });
  let open = true;
  void s.closed.then(() => (open = false));

  const input = h('input', { type: 'file', multiple: true, class: 'ph-file-input' }) as HTMLInputElement;
  const list = h('div', { class: 'ph-files' });
  const queue: Array<() => Promise<void>> = [];
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    while (queue.length) await queue.shift()!();
    running = false;
  };
  const add = (file: File) => {
    const bar = h('i', {});
    const status = h('span', { class: 'ph-file-status', text: 'Waiting…' });
    const row = h('div', { class: 'ph-file' }, [
      h('div', { class: 'ph-file-top' }, [h('span', { class: 'ph-file-name', text: file.name }), h('span', { class: 'ph-file-size', text: fileSize(file.size) })]),
      h('div', { class: 'ph-progress' }, [bar]),
      status,
    ]);
    list.append(row);
    if (file.size > MAX_UPLOAD) {
      row.classList.add('bad');
      status.textContent = 'Too big: 2 GB at most';
      return;
    }
    queue.push(async () => {
      status.textContent = 'Sending…';
      try {
        const { name } = await link.sendFile(file, (p) => (bar.style.transform = `scaleX(${Math.max(0, Math.min(1, p))})`));
        bar.style.transform = 'scaleX(1)';
        row.classList.add('good');
        status.textContent = `Saved as ${name}`;
        if (!open) toast(`${name} is on ${pc}`, 'good');
      } catch (err) {
        row.classList.add('bad');
        status.textContent = err instanceof Error && err.message ? err.message : "Couldn't send it";
        if (!open) toast(`${file.name} didn't send`, 'bad');
      }
    });
    void pump();
  };
  input.addEventListener('change', () => {
    for (const f of Array.from(input.files ?? [])) add(f);
    input.value = '';
  });

  const ta = h('textarea', { class: 'ph-textarea', rows: '3', placeholder: 'Text or a link…' }) as HTMLTextAreaElement;
  const sendText = () => {
    const text = ta.value;
    if (!text.trim()) return toast('Type or paste something first', 'info');
    if (link.send({ t: 'text', text })) {
      ta.value = '';
      toast(`Sent to ${pc}'s clipboard`, 'good');
    } else toast('Not connected', 'bad');
  };

  s.body.append(
    h('div', { class: 'ph-section' }, [
      h('div', { class: 'ph-label', text: 'Photos & files' }),
      h('p', { class: 'ph-small', text: 'They go to Downloads on your PC.' }),
      button('Choose photos or files', { icon: 'image', style: 'primary', cls: 'ph-big', onclick: () => input.click() }),
      input,
      list,
    ]),
    h('div', { class: 'ph-section' }, [
      h('div', { class: 'ph-label', text: 'Text or a link' }),
      h('p', { class: 'ph-small', text: "It goes on your PC's clipboard and shows on the island." }),
      ta,
      h('div', { class: 'ph-row' }, [
        button('Paste from this phone', {
          icon: 'clipboard',
          style: 'ghost',
          onclick: async () => {
            try {
              ta.value = await navigator.clipboard.readText();
              if (!ta.value) toast("This phone's clipboard is empty", 'info');
            } catch {
              toast("Couldn't read this phone's clipboard", 'bad');
            }
          },
        }),
        button('Send', { icon: 'send', style: 'primary', onclick: sendText }),
      ]),
    ]),
  );
}
