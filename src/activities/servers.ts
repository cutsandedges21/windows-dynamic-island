// Local servers: dev servers listening on localhost (Node, Python, Bun…), with
// an Open-in-browser button when a new one starts.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { native } from '../core/native';
import type { Seg } from '../core/segments';
import type { SheetRow, Tile } from '../core/sheet';
import { BaseActivity } from './base';

type Server = { port: number; proc: string; since: number };

const DEV_RUNTIMES = new Set([
  'node.exe', 'bun.exe', 'deno.exe', 'python.exe', 'pythonw.exe', 'java.exe', 'javaw.exe',
  'dotnet.exe', 'ruby.exe', 'php.exe', 'go.exe', 'uvicorn.exe', 'cargo.exe',
]);
const SCAN_MS = 5000;
const NEW_MS = 4000;

export class ServersActivity extends BaseActivity {
  private servers = new Map<number, Server>();
  private scanned = false;

  constructor() {
    super('servers');
  }

  protected init(): void {
    this.every(SCAN_MS, () => void this.scan(), true);
  }

  private async scan(): Promise<void> {
    const rows = await native.ports();
    if (!this.alive) return;
    const next = new Map<number, Server>();
    for (const r of rows) {
      const proc = String(r.process ?? '').toLowerCase();
      if (r.port < 1024 || !DEV_RUNTIMES.has(proc) || next.has(r.port)) continue; // one entry per port (IPv4 and IPv6 both listen)
      next.set(r.port, this.servers.get(r.port) ?? { port: r.port, proc: proc.replace(/\.exe$/, ''), since: Date.now() });
    }
    const fresh = [...next.values()].filter((s) => !this.servers.has(s.port));
    this.servers = next;
    // The first scan only learns what is already running.
    if (this.scanned && fresh.length) this.ctx.surface({ key: `port-${fresh[fresh.length - 1].port}`, ms: NEW_MS, level: 'expanded' });
    this.scanned = true;
    this.ctx.update();
  }

  /** Newest first. */
  private list(): Server[] {
    return [...this.servers.values()].sort((a, b) => b.since - a.since || a.port - b.port);
  }

  status(): ActivityStatus {
    const [top] = this.list();
    if (!top) return { active: false };
    const n = this.servers.size;
    return { active: true, weight: 'background', summary: n === 1 ? `:${top.port} ${top.proc}` : `${n} local servers` };
  }

  chip(): ChipView | null {
    const [top] = this.list();
    return top ? { icon: 'server', label: this.servers.size === 1 ? `:${top.port}` : `${this.servers.size} servers`, tone: 'good' } : null;
  }

  /** The newest servers, each one tap from its page. A fourth would not fit the cell, so it folds into "+N more". */
  tile(env: SheetEnv): Tile | null {
    const list = this.list();
    if (!list.length) return null;
    const row = (s: Server): SheetRow => ({ key: String(s.port), title: `localhost:${s.port} · ${s.proc}`, action: env.interactive ? 'open' : undefined, arg: s.port, tip: env.interactive ? `Open localhost:${s.port}` : undefined });
    const rows = list.length <= 3 ? list.map(row) : [...list.slice(0, 2).map(row), { key: 'more', title: `+${list.length - 2} more` }];
    // Two rows fit in one cell height; only a longer list needs the tall cell.
    return { key: 'servers', rows: rows.length > 2 ? 2 : 1, body: { k: 'list', icon: 'server', label: 'Local servers', rows } };
  }

  render(env: RenderEnv): Seg[] {
    const list = this.list();
    const top = list[0];
    if (!top) return [];
    const icon: Seg = { t: 'icon', key: 'icon', icon: 'server', tone: 'good', prio: 0 };
    const compact = env.level === 'compact' || env.level === 'idle';

    if (env.vertical) {
      const segs: Seg[] = [icon, { t: 'text', key: 'port', text: String(top.port), size: 'sm', weight: 'semibold', prio: 0 }];
      if (!compact) segs.push(this.openButton(top, env));
      return segs;
    }
    if (compact) return [icon, { t: 'text', key: 'port', text: list.length === 1 ? `:${top.port}` : `${list.length} servers`, weight: 'semibold', prio: 0 }];

    if (env.level === 'expanded') {
      return [
        icon,
        { t: 'text', key: 'port', text: `localhost:${top.port}`, weight: 'semibold', prio: 0, min: 80 },
        { t: 'text', key: 'proc', text: top.proc, tone: 'muted', prio: 4 },
        this.openButton(top, env),
      ];
    }
    // Maximum: one chip per server.
    return [
      icon,
      { t: 'text', key: 'count', text: list.length === 1 ? '1 server' : `${list.length} servers`, tone: 'muted', prio: 6 },
      ...list.map((s, i): Seg => ({ t: 'chip', key: `s${s.port}`, label: `:${s.port} ${s.proc}`, icon: 'external', action: 'open', arg: s.port, tone: 'good', side: 'end', prio: 2 + i, tip: `Open localhost:${s.port}` })),
    ];
  }

  private openButton(s: Server, env: RenderEnv): Seg {
    return { t: 'button', key: 'open', icon: 'external', label: env.vertical ? undefined : 'Open', action: 'open', arg: s.port, style: 'primary', side: 'end', prio: 1, tip: `Open localhost:${s.port}` };
  }

  action(name: string, arg: unknown): void {
    const port = Number(arg);
    if (name !== 'open' || !Number.isInteger(port) || port < 1024 || port > 65535) return;
    void native.open(`http://localhost:${port}`);
    this.ctx.close();
  }
}
