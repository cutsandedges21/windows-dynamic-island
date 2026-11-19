// Browser preview only: Island's Start menu (/?start, &look=white, &q=spot types a search, &all=1 All apps).

import { native } from '../core/native';

const APPS = ['Spotify', 'Discord', 'Google Chrome', 'Notion', 'Visual Studio Code', 'Calculator', 'Photos', 'Steam', 'OneDrive', 'Paint', 'Terminal', 'Settings', 'Snipping Tool', 'Microsoft Edge', 'Word', 'Excel', 'Cursor', '7-Zip'].map((name) => ({ name, target: `C:\Apps\${name}.exe` }));

export function startPreview(emit: (event: string, payload: unknown) => void): void {
  const q = new URLSearchParams(location.search);
  document.body.style.background = 'linear-gradient(160deg,#3b4a6b,#6b4a5e 55%,#b0745a)';
  Object.assign(native as unknown as Record<string, unknown>, {
    wsApps: async () => APPS,
    startRecent: async () => [
      { name: 'Essay draft.docx', path: 'C:\Docs\Essay draft.docx', lnk: 'x', at: Date.now() - 12 * 60000 },
      { name: 'Screenshot 2026-11-18.png', path: 'C:\Pics\s.png', lnk: 'y', at: Date.now() - 3 * 3600000 },
      { name: 'Budget.xlsx', path: 'C:\Docs\Budget.xlsx', lnk: 'z', at: Date.now() - 30 * 3600000 },
      { name: 'Notes.txt', path: 'C:\Docs\Notes.txt', lnk: 'w', at: Date.now() - 4 * 86400000 },
    ],
    startUser: async () => ({ name: 'Moss', picture: null }),
  });
  const w = innerWidth;
  const h = innerHeight;
  setTimeout(() => {
    emit('start-frame', { color: q.get('look') ?? 'black', glass: 50, accent: '#6aa6e8', pins: APPS.slice(0, 12) });
    emit('start-open', { side: 'bottom', menu: [28, 28, Math.min(640, w - 56), Math.min(720, h - 56)], origin: [80, h], gen: 1 });
  }, 600);
  if (q.has('q'))
    setTimeout(() => {
      const f = document.querySelector<HTMLInputElement>('.sm-field');
      if (f) {
        f.value = q.get('q') ?? '';
        f.dispatchEvent(new Event('input'));
      }
    }, 1400);
  if (q.get('all') === '1') setTimeout(() => [...document.querySelectorAll<HTMLElement>('.sm-pill')].find((b) => b.textContent?.includes('All apps'))?.click(), 1400);
}
