// Every workspace's programs (detect.ts programsOf), for telling its windows apart from others: what
// each app item starts is asked of Rust once per item (a shortcut's target and arguments), and the
// whole set is built again only when the workspaces change. The island's noticing and the
// Workspaces page's "In use" both read windows through this.

import { native } from '../../core/native';
import type { Workspace } from '../model';
import { programsOf, type ItemProgram, type WsPrograms } from './detect';

export class ProgramBook {
  private readonly items = new Map<string, ItemProgram>();
  private sig = '';
  private map = new Map<string, WsPrograms>();

  /** The programs of each workspace in `list` (by id); read again only when the list changed. */
  async of(list: Workspace[]): Promise<Map<string, WsPrograms>> {
    const sig = JSON.stringify(list.map((w) => [w.id, w.updatedAt, w.layout?.savedAt ?? 0, w.archived]));
    if (sig === this.sig) return this.map;
    const byItem = new Map<string, ItemProgram>();
    for (const ws of list) {
      for (const r of ws.resources) {
        if (r.kind !== 'app') continue;
        const key = `${r.path}|${ws.cwd}`;
        if (!this.items.has(key)) this.items.set(key, await native.wsProgram(r.path, ws.cwd).catch(() => null));
        byItem.set(r.id, this.items.get(key) ?? null);
      }
    }
    this.map = new Map(list.map((ws) => [ws.id, programsOf(ws, byItem)]));
    this.sig = sig;
    return this.map;
  }

  /** The programs read last (empty before the first `of`). */
  get current(): Map<string, WsPrograms> {
    return this.map;
  }
}
