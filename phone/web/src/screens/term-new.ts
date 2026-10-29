// The + on the terminal screen: where a new terminal starts (Home, a folder Claude worked in, any
// path) and, on a Windows PC, which shell runs in it. The shell picked last is kept on this phone.

import { SHELLS, folderName, isShell, type ShellId } from '../term';
import { button, h, ico, openSheet } from '../ui';

const SHELL_KEY = 'island:phone:term-shell';

export interface NewTerm {
  /** Null: the user's home folder on the PC. */
  cwd: string | null;
  /** Null: the PC's default shell (a Mac's own). */
  shell: ShellId | null;
}

function savedShell(): ShellId {
  try {
    const v = localStorage.getItem(SHELL_KEY);
    return isShell(v) ? v : 'powershell';
  } catch {
    return 'powershell';
  }
}

function saveShell(shell: ShellId): void {
  try {
    localStorage.setItem(SHELL_KEY, shell);
  } catch {
    /* storage off: PowerShell next time */
  }
}

export function openNewTerm(opts: { pc: string; folders: readonly string[]; platform: 'windows' | 'macos'; open(t: NewTerm): void }): void {
  const s = openSheet({ title: 'New terminal', sub: `On ${opts.pc}`, icon: 'terminal' });
  const windows = opts.platform === 'windows';
  let cwd: string | null = null;
  let shell = savedShell();

  const field = h('input', {
    class: 'ph-field',
    type: 'text',
    placeholder: windows ? 'C:\\Users\\you\\project' : '~/project',
    autocapitalize: 'off',
    autocorrect: 'off',
    autocomplete: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    'aria-label': 'Any folder',
  }) as HTMLInputElement;

  const picks: Array<{ el: HTMLButtonElement; path: string | null }> = [];
  const mark = () => {
    const typed = field.value.trim() !== '';
    for (const p of picks) p.el.classList.toggle('on', !typed && p.path === cwd);
  };
  const pick = (label: string, sub: string | null, path: string | null) => {
    const el = h('button', { class: 'ph-pick', type: 'button' }, [
      ico(path === null ? 'user' : 'folder'),
      h('span', { class: 'ph-pick-text' }, [h('span', { class: 'ph-pick-title', text: label }), sub ? h('span', { class: 'ph-pick-sub', text: sub }) : null]),
      ico('check', 'ph-ico ph-pick-check'),
    ]);
    el.addEventListener('click', () => {
      cwd = path;
      field.value = '';
      mark();
    });
    picks.push({ el, path });
    return el;
  };

  const go = () => {
    const typed = field.value.trim();
    if (windows) saveShell(shell);
    s.close();
    opts.open({ cwd: typed || cwd, shell: windows ? shell : null });
  };
  field.addEventListener('input', mark);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });

  const chips = SHELLS.map((x) => {
    const b = h('button', { class: `ph-chip${x.id === shell ? ' on' : ''}`, type: 'button', 'aria-pressed': String(x.id === shell) }, [h('span', { text: x.label })]);
    b.addEventListener('click', () => {
      shell = x.id;
      chips.forEach((c, i) => {
        const on = SHELLS[i].id === shell;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', String(on));
      });
    });
    return b;
  });

  s.body.append(
    h('div', { class: 'ph-section' }, [
      h('div', { class: 'ph-label', text: 'Folder' }),
      h('div', { class: 'ph-picks' }, [pick('Home', null, null), ...opts.folders.map((f) => pick(folderName(f), f, f))]),
      field,
    ]),
    ...(windows ? [h('div', { class: 'ph-section' }, [h('div', { class: 'ph-label', text: 'Shell' }), h('div', { class: 'ph-chips' }, chips)])] : []),
    button('Open', { icon: 'terminal', style: 'primary', cls: 'ph-big', onclick: go }),
  );
  mark();
}
