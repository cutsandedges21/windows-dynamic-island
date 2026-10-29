// The demo's terminals (?demo): what Island's terminals look like from the phone, without a PC. A
// pretend shell shows its prompt, echoes what is typed, and on Enter answers a few commands (help,
// echo, ls, pwd, cls, exit) before a new prompt. It starts with one terminal running in the
// project folder and one that ended. The list goes out as `terms` whenever it changes, and a
// stream opened again gets the recent output first, as the PC does. fake-link.ts drives it.

import { MAX_TERMS, type IslandMsg, type TermHeader, type TermInfo } from '../../../../src/remote/protocol';
import type { Link, TermHandle } from '../link/api';
import { DEMO_FOLDERS } from './demo-data';

type TermEvents = Parameters<Link['openTerm']>[1];

/** What the fake link lends the terminals: its message out and its timers (cleared on close). */
export interface FakeTermsHost {
  emit(m: IslandMsg): void;
  later(ms: number, fn: () => void): void;
}

const HOME = 'C:\\Users\\Moss';
/** The recent output a terminal keeps for a stream that opens it again (the PC keeps 256 KiB). */
const KEEP = 64 * 1024;

interface Fake {
  info: TermInfo;
  out: string;
  line: string;
  streams: Set<TermEvents>;
}

const utf8 = new TextEncoder();

function hexId(): string {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function prompt(t: TermInfo): string {
  if (t.shell === 'cmd') return `${t.cwd}>`;
  if (t.shell === 'bash') {
    const unix = t.cwd.replace(/^C:\\Users\\Moss/i, '~').replace(/\\/g, '/');
    return `\x1b[32mmoss@MossLaptop\x1b[0m \x1b[35mMINGW64\x1b[0m \x1b[33m${unix}\x1b[0m\r\n$ `;
  }
  return `PS ${t.cwd}> `;
}

function folderOf(path: string): string {
  return path.split('\\').filter(Boolean).pop() ?? path;
}

export class FakeTerms {
  private readonly terms: Fake[] = [];
  /** Terminals allowed from phones (?demo&noterm: not). */
  allowed: boolean;

  constructor(
    private readonly host: FakeTermsHost,
    opts: { allowed?: boolean; now?: number } = {},
  ) {
    this.allowed = opts.allowed ?? true;
    const now = opts.now ?? Date.now();
    const island: TermInfo = { id: 'a1b2c3d4', title: 'windows-dynamic-island', cwd: DEMO_FOLDERS[0], shell: 'powershell', pid: 21480, started: now - 25 * 60_000, exit: null, attached: 0, claude: false };
    const tests: TermInfo = { id: 'e5f6a7b8', title: 'npm test', cwd: DEMO_FOLDERS[1], shell: 'powershell', pid: 18764, started: now - 50 * 60_000, exit: 0, attached: 0, claude: false };
    this.terms.push(
      {
        info: island,
        out: `${prompt(island)}git status\r\nOn branch main\r\nYour branch is up to date with 'origin/main'.\r\n\r\nnothing to commit, working tree clean\r\n${prompt(island)}`,
        line: '',
        streams: new Set(),
      },
      {
        info: tests,
        out: `${prompt(tests)}npm test\r\n\r\n\x1b[1m RUN \x1b[0m v5.0.5\r\n\r\n \x1b[32m✓\x1b[0m test/planner.test.ts (24 tests)\r\n \x1b[32m✓\x1b[0m test/model.test.ts (61 tests)\r\n\r\n\x1b[2m Test Files \x1b[0m \x1b[1;32m12 passed\x1b[0m (12)\r\n\x1b[2m      Tests \x1b[0m \x1b[1;32m148 passed\x1b[0m (148)\r\n`,
        line: '',
        streams: new Set(),
      },
    );
  }

  list(): TermInfo[] {
    return this.terms.map((t) => ({ ...t.info, attached: t.streams.size }));
  }

  /** The `terms` line, as the PC sends it on `term-list` and whenever the list changes. */
  sendList(): void {
    this.host.emit({ t: 'terms', items: this.list(), allowed: this.allowed });
  }

  /** A terminal stream: a new terminal (`id` null) or one that runs already. */
  open(header: TermHeader, on: TermEvents): Promise<TermHandle> {
    return new Promise((resolve, reject) => {
      this.host.later(140, () => {
        if (!this.allowed) return reject(new Error('Turned on in Settings › Your phone on the PC'));
        let t: Fake | undefined;
        let fresh = false;
        if (header.id === null) {
          if (this.terms.length >= MAX_TERMS) return reject(new Error(`${MAX_TERMS} terminals are open already: end one first.`));
          const cwd = header.cwd || HOME;
          const shell = header.shell ?? 'powershell';
          const info: TermInfo = { id: hexId(), title: folderOf(cwd), cwd, shell, pid: 20000 + Math.floor(Math.random() * 9000), started: Date.now(), exit: null, attached: 0, claude: false };
          t = { info, out: '', line: '', streams: new Set() };
          this.terms.push(t);
          fresh = true;
        } else {
          t = this.terms.find((x) => x.info.id === header.id);
          if (!t) return reject(new Error("That terminal isn't there any more."));
        }
        const term = t;
        let open = true;
        term.streams.add(on);
        const handle: TermHandle = {
          id: term.info.id,
          title: term.info.title,
          write: (data) => {
            if (open && term.info.exit === null) this.input(term, typeof data === 'string' ? data : new TextDecoder().decode(data));
          },
          resize: () => undefined,
          close: () => {
            if (!open) return;
            open = false;
            term.streams.delete(on);
          },
        };
        resolve(handle);
        // As the PC: the recent output first, then whatever comes.
        this.host.later(0, () => {
          if (!open) return;
          if (term.out) on.data(utf8.encode(term.out));
          if (term.info.exit !== null) {
            on.exit(term.info.exit);
            open = false;
            term.streams.delete(on);
            on.closed();
          } else if (fresh) {
            this.print(term, `\x1b[2mThe demo's terminal: nothing runs on a PC. Type help.\x1b[0m\r\n\r\n${prompt(term.info)}`);
          }
        });
        if (fresh) this.sendList();
      });
    });
  }

  /** `term-kill`: ends it (if it runs) and takes it off the list. */
  kill(id: string): void {
    const i = this.terms.findIndex((x) => x.info.id === id);
    if (i < 0) return;
    const [t] = this.terms.splice(i, 1);
    this.end(t, t.info.exit === null ? 1 : t.info.exit);
    this.sendList();
  }

  /** The link went: every stream with it (the terminals keep running). */
  dropStreams(): void {
    for (const t of this.terms) {
      const streams = [...t.streams];
      t.streams.clear();
      for (const on of streams) on.closed();
    }
  }

  private print(t: Fake, text: string): void {
    t.out = (t.out + text).slice(-KEEP);
    const bytes = utf8.encode(text);
    for (const on of t.streams) on.data(bytes);
  }

  private end(t: Fake, code: number): void {
    t.info.exit = code;
    const streams = [...t.streams];
    t.streams.clear();
    for (const on of streams) {
      on.exit(code);
      on.closed();
    }
  }

  private input(t: Fake, data: string): void {
    // Arrows and other keys with ESC: the demo's prompt has no history to move through.
    const keys = data.replace(/\x1b\[200~|\x1b\[201~/g, '').replace(/\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g, '');
    for (const ch of keys) {
      if (t.info.exit !== null) return;
      if (ch === '\r' || ch === '\n') {
        const cmd = t.line.trim();
        t.line = '';
        this.print(t, '\r\n');
        this.run(t, cmd);
      } else if (ch === '\x7f' || ch === '\b') {
        if (!t.line) continue;
        t.line = t.line.slice(0, -1);
        this.print(t, '\b \b');
      } else if (ch === '\x03') {
        t.line = '';
        this.print(t, `^C\r\n${prompt(t.info)}`);
      } else if (ch === '\x0c') {
        this.print(t, `\x1b[2J\x1b[H${prompt(t.info)}${t.line}`);
      } else if (ch >= ' ') {
        t.line += ch;
        this.print(t, ch);
      }
    }
  }

  private run(t: Fake, cmd: string): void {
    const [word = '', ...rest] = cmd.split(/\s+/);
    const arg = rest.join(' ');
    let out = '';
    switch (word.toLowerCase()) {
      case '':
        break;
      case 'help':
        out = 'This is the demo: nothing runs on a PC. Try echo, ls, pwd, cls, exit.\r\n';
        break;
      case 'echo':
        out = `${arg}\r\n`;
        break;
      case 'ls':
      case 'dir':
        out = '\x1b[34mdocs\x1b[0m  \x1b[34mphone\x1b[0m  \x1b[34msrc\x1b[0m  \x1b[34msrc-tauri\x1b[0m  \x1b[34mtest\x1b[0m  package.json  README.md\r\n';
        break;
      case 'pwd':
      case 'cd':
        out = `${t.info.cwd}\r\n`;
        break;
      case 'cls':
      case 'clear':
        this.print(t, `\x1b[2J\x1b[3J\x1b[H${prompt(t.info)}`);
        return;
      case 'exit':
        this.end(t, 0);
        this.sendList();
        return;
      case 'claude':
        out = 'In the real app, Claude would start here, on your PC.\r\n';
        break;
      default:
        out = `${word}: not in the demo. Type help.\r\n`;
    }
    this.print(t, `${out}${prompt(t.info)}`);
  }
}
