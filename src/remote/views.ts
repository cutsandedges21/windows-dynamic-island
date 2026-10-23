// What a phone is shown and what it may press (src/remote/hub.ts). The island's own cards and
// pill go to phones as they are, except Claude's Allow while Windows Hello guards it; a tap from
// a phone runs only if it matches something it was shown, argument and all, so a phone can't
// make up a press (Land's Open with a path of its own, say).

import type { ActivityStatus } from '../core/activity';
import type { MirrorFrame } from '../core/mirror';
import type { Block, SheetButton, SheetRow, SheetView, TileBody } from '../core/sheet';

/** Claude's Allow: with Windows Hello asked before Allow, phones never get it or press it. */
export const HELLO_GUARDED: readonly string[] = ['act:claude:allow'];

/** Every action shown, with the arguments it was shown with (as JSON); ANY for typed text and seeking. */
export type Pressables = Map<string, Set<string>>;

/** Stands for "any argument": JSON never comes out as a bare `*`. */
const ANY = '*';

function argKey(arg: unknown): string {
  try {
    return JSON.stringify(arg ?? null) ?? 'null';
  } catch {
    return 'null';
  }
}

/**
 * What a view or pill offers to press. Buttons, rows, tiles, choices and avatars carry their
 * argument; an input sends what is typed and a player's seek a time, so those take any.
 */
export function pressables(value: unknown, out: Pressables = new Map()): Pressables {
  const add = (action: unknown, arg: string) => {
    if (typeof action !== 'string' || !action) return;
    let set = out.get(action);
    if (!set) out.set(action, (set = new Set()));
    set.add(arg);
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o.t === 'input') {
      add(o.action, ANY);
      add(o.engage, argKey(null));
      add(o.cancel, argKey(null));
    } else if (o.t === 'player' && typeof o.actions === 'object' && o.actions !== null) {
      for (const [k, a] of Object.entries(o.actions)) add(a, k === 'seek' ? ANY : argKey(null));
    } else if ('action' in o) add(o.action, argKey(o.arg));
    for (const x of Object.values(o)) if (typeof x === 'object' && x !== null) walk(x);
  };
  walk(value);
  return out;
}

/** Whether `action` with `arg` is one of the presses that were shown. */
export function mayPress(shown: Pressables, action: string, arg: unknown): boolean {
  const set = shown.get(action);
  return set !== undefined && (set.has(ANY) || set.has(argKey(arg)));
}

/** A card with nothing left that presses one of `blocked`: its buttons go, rows and tiles stay but do nothing. */
export function stripActions(view: SheetView, blocked: ReadonlySet<string>): SheetView {
  if (!blocked.size) return view;
  const ok = (a: string | undefined) => !a || !blocked.has(a);
  const buttons = (list: SheetButton[]) => list.filter((b) => ok(b.action));
  const row = (r: SheetRow): SheetRow => ({ ...r, action: ok(r.action) ? r.action : undefined, button: r.button && ok(r.button.action) ? r.button : undefined });
  const body = (b: TileBody): TileBody => (b.k === 'media' || b.k === 'actions' ? { ...b, buttons: buttons(b.buttons) } : b.k === 'list' ? { ...b, rows: b.rows.map(row) } : b);
  const blocks = view.blocks.flatMap((b): Block[] => {
    switch (b.t) {
      case 'head':
        return [b.buttons ? { ...b, buttons: buttons(b.buttons) } : b];
      case 'buttons': {
        const items = buttons(b.items);
        return items.length ? [{ ...b, items }] : [];
      }
      case 'input':
        return ok(b.action) ? [ok(b.engage) ? b : { ...b, engage: undefined }] : [];
      case 'rows':
        return [{ ...b, items: b.items.map(row) }];
      case 'choices':
        return [{ ...b, items: b.items.filter((c) => ok(c.action)) }];
      case 'people':
        return [{ ...b, items: b.items.map((p) => (ok(p.action) ? p : { ...p, action: undefined })) }];
      case 'tiles':
        return [{ ...b, items: b.items.map((t) => ({ ...t, action: ok(t.action) ? t.action : undefined, body: body(t.body) })) }];
      case 'player': {
        const a = b.actions;
        const keep = (x: string | undefined) => (ok(x) ? x : '');
        return [{ ...b, actions: { prev: keep(a.prev)!, toggle: keep(a.toggle)!, next: keep(a.next)!, seek: keep(a.seek), output: keep(a.output) } }];
      }
      default:
        return [b];
    }
  });
  return { ...view, blocks };
}

/** The pill without segments that press one of `blocked` (none do today; the rule holds anyway). */
export function stripPill(frame: MirrorFrame, blocked: ReadonlySet<string>): MirrorFrame {
  if (!blocked.size) return frame;
  const placed = frame.placed.filter((p) => !('action' in p.seg && typeof p.seg.action === 'string' && blocked.has(p.seg.action)));
  return placed.length === frame.placed.length ? frame : { ...frame, placed };
}

/** Activities with an urgent card waiting that nobody tapped away, in the user's order: a phone shows these first. */
export function urgentIds(order: readonly string[], statuses: ReadonlyMap<string, ActivityStatus>, dismissed: ReadonlySet<string>): string[] {
  return order.filter((id) => {
    const u = statuses.get(id)?.urgent;
    return u != null && !dismissed.has(`${id}:${u.key}`);
  });
}
