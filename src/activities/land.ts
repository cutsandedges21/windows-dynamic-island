// Land: send files to the other computers on this network that run Island, like AirDrop.
// Drop files on the island and it opens on Land's card: the files, the computers nearby,
// and Send. The other computer's user accepts or declines; nothing arrives without that.
// Text goes the same way: paste a link or a note in the card, pick who, Send; the other
// island shows it with Copy (and Open, for a link). Any phone gets them too: "Send to a
// phone" shows a QR code its camera opens in the browser (src-tauri/src/land/share.rs).
// Finding computers, the encryption and the transfers are Rust (src-tauri/src/land.rs);
// this keeps what the island shows: the files waiting to go, who is around, the transfers.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { baseName, bytes, clip, clock, percent, rate } from '../core/format';
import { native, type LandFriend, type LandFirewall, type LandFriendAsk, type LandPeer, type LandStaged, type LandTransfer, type RemoteFileSent, type RemotePhone, type ShareInfo, type Tried } from '../core/native';
import type { PhoneDelivery } from '../remote/hub';
import type { PetSignal } from '../core/pet';
import type { Seg } from '../core/segments';
import type { Block, Person, SheetButton, SheetRow, SheetView, Tile } from '../core/sheet';
import { platform } from '../core/platform';
import { hiddenNow } from '../core/settings';
import { BaseActivity } from './base';

type Options = { visible: boolean; name: string; anywhere: boolean; tile: boolean };

/** A transfer as the island keeps it: Rust's report, plus timing and a smoothed speed. */
export interface Live extends LandTransfer {
  since: number;
  at: number;
  speed: number;
  /** When it ended (done, declined, failed or cancelled). */
  ended: number | null;
}

/** A finished transfer stays on the pill this long. */
export const ENDED_MS = 6000;
/** The card keeps finished transfers this long, and this many. */
const KEEP_MS = 30 * 60000;
const KEEP_MAX = 6;
/** While the card is open it asks who is around this often. */
const SCAN_MS = 4000;
const FIREWALL_MS = 30_000;
/** While the card is open it asks which friends are online this often (each check dials them). */
const ONLINE_MS = 20000;
/** How long the other side has to accept (land.rs ASK_FOR). */
const ASK_MS = 120000;
/** How long a phone share works (land/share.rs SHARE_FOR). */
const SHARE_MS = 15 * 60000;
/** Land's first start says what it is this long. */
export const INTRO_MS = 15000;
/** Card lines for files and transfers before "+N more". */
const FILE_ROWS = 4;
const TRANSFER_ROWS = 4;
const ACTIVE: ReadonlySet<string> = new Set(['waiting', 'asking', 'sending', 'receiving', 'paused', 'queued']);
/** Phones paired in Settings › Your phone go by `phone:<their id>` here, apart from computers and friends. */
export const PHONE = 'phone:';
const isPhone = (id: string) => id.startsWith(PHONE);

/** "Moss's MacBook Air" → "MM", "DESKTOP-K2L3M4" → "DK", "studio" → "ST". */
export function initials(name: string): string {
  const words = name.replace(/['’]s\b/g, '').split(/[\s\-_.]+/).filter(Boolean);
  if (!words.length) return '?';
  const pick = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return pick.toUpperCase();
}

/** A steady avatar colour for a device id. */
export function hueOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function osLabel(os: string): string {
  return os === 'windows' ? 'Windows' : os === 'macos' ? 'Mac' : os === 'linux' ? 'Linux' : '';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The longest text one send carries (land/transfer.rs MAX_TEXT). */
export const MAX_TEXT = 20_000;

/** One web address and nothing else: it can be opened. */
export function isLink(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/** "photo.jpg", "Trip", "3 files", or for text "a link" / "a note". */
export function what(t: Pick<LandTransfer, 'items' | 'count' | 'text'>): string {
  if (t.text) return isLink(t.text) ? 'a link' : 'a note';
  if (t.items.length === 1) return t.items[0].name;
  return plural(t.count, 'file');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class LandActivity extends BaseActivity {
  private me: { id: string; name: string; visible: boolean } | null = null;
  private error: string | null = null;
  private peers: LandPeer[] = [];
  private staged: LandStaged[] = [];
  /** Text to send instead of files (pasted or typed in the card). */
  private stagedText: string | null = null;
  /** What a phone can fetch right now: its QR code, and what it opened. */
  private share: (ShareInfo & { opened: number; last: string | null }) | null = null;
  /** Devices picked to send to. */
  private readonly picked = new Set<string>();
  private readonly transfers = new Map<string, Live>();
  /** Friends on other networks (src-tauri/src/anywhere.rs). */
  private friends: LandFriend[] = [];
  /** Which friends answered the last check; null before the first. */
  private online: Set<string> | null = null;
  private lastOnline = 0;
  /** Islands asking to be friends, waiting for this user; when each arrived. */
  private readonly friendAsks = new Map<string, LandFriendAsk & { since: number }>();
  /** Something to say on the card for a moment (why a send did not start). */
  private note: { text: string; at: number; good?: boolean } | null = null;
  private lastScan = 0;
  /** Windows Firewall's word on this network, checked when the card opens (at most every 30 s). */
  private firewall: LandFirewall | null = null;
  /** Islands at the same place found over the internet (Wi-Fi that keeps devices apart): Add only. */
  private place: LandPeer[] = [];
  /** Place Islands asked to be friends, waiting for their answer. */
  private befriending = new Set<string>();
  private lastFirewall = 0;
  private fixing = false;
  /** Land's first start here: when the island said what it is (the system asks about the network at the same time). */
  private introAt = 0;
  /** Paired phones connected now (Island on your phone): they get files and text too. */
  private phones: LandPeer[] = [];
  /** Numbers what goes to and comes from phones (they have no transfer ids of Rust's). */
  private phoneSeq = 0;
  private demoTimers: Array<ReturnType<typeof setTimeout>> = [];

  constructor() {
    super('land');
  }

  protected async init(): Promise<void> {
    this.listen<LandPeer[]>('land-peers', (list) => this.onPeers(list));
    this.listen<LandPeer[]>('land-place', (list) => this.onPlace(list));
    this.listen<LandTransfer>('land-transfer', (t) => this.onTransfer(t));
    this.listen<LandFriendAsk>('land-friend-ask', (a) => this.onFriendAsk(a));
    this.listen<LandFriend[]>('land-friends', (list) => this.onFriends(list));
    this.listen<{ state: string; name?: string; opened?: number }>('land-share', (e) => this.onShare(e));
    this.listen<RemotePhone[]>('remote-phones', (list) => this.onPhones(list));
    this.listen<RemoteFileSent>('remote-file-sent', (e) => this.onPhoneSent(e));
    // Phones connected already; later the list comes as 'remote-phones' (a native layer without them gives none).
    void native.remotePhones?.().then((list) => this.alive && this.onPhones(list));
    this.every(1000, () => this.tick());
    if (native.demo) {
      this.me = { id: 'demo', name: 'This PC', visible: true };
      this.onPeers(DEMO_PEERS);
      return;
    }
    await this.connect();
  }

  override dispose(): void {
    for (const t of this.demoTimers.splice(0)) clearTimeout(t);
    if (!native.demo) void native.landStop();
  }

  reconfigure(): void {
    if (!native.demo) void this.connect();
  }

  private opts(): Options {
    const o = this.ctx.options<Partial<Options>>();
    return { visible: o.visible !== false, name: typeof o.name === 'string' ? o.name : '', anywhere: o.anywhere !== false, tile: o.tile === true };
  }

  private async connect(): Promise<void> {
    const o = this.opts();
    const r = await native.landStart(o.name.trim() || null, o.visible, o.anywhere);
    if (!this.alive) return;
    if (r.ok) {
      this.me = { id: r.value.id, name: r.value.name, visible: r.value.visible };
      this.error = null;
      this.friends = [...(r.value.friends ?? [])];
      this.onPeers(r.value.peers);
      // Windows asks to let Island through the firewall (a Mac, to find devices on the network)
      // right now: the island says why.
      if (r.value.fresh) {
        this.introAt = Date.now();
        this.ctx.surface({ key: 'intro', ms: INTRO_MS, level: 'expanded' });
      }
    } else {
      this.me = null;
      this.error = r.error;
      this.ctx.log('could not start:', r.error);
    }
    this.ctx.update();
  }

  // ---------------------------------------------------------------- what Rust reports

  private onPeers(list: LandPeer[]): void {
    this.peers = [...list];
    this.unpickGone();
    this.ctx.update();
  }

  private onFriends(list: LandFriend[]): void {
    this.friends = [...list];
    this.unpickGone();
    this.ctx.update();
  }

  /** Paired phones as Rust lists them: the connected ones are targets. */
  private onPhones(list: RemotePhone[]): void {
    const next = (Array.isArray(list) ? list : []).filter((p) => p.connected).map((p): LandPeer => ({ id: `${PHONE}${p.id}`, name: p.name, os: 'phone' }));
    if (next.length === this.phones.length && next.every((p, i) => p.id === this.phones[i].id && p.name === this.phones[i].name)) return;
    this.phones = next;
    this.unpickGone();
    this.ctx.update();
  }

  /** Someone who left the list is no longer picked. */
  private unpickGone(): void {
    for (const id of [...this.picked]) if (!this.everyone().some((p) => p.id === id)) this.picked.delete(id);
  }

  /** Who can get files: the computers nearby, then the friends on other networks, then your
   * phones. A friend who is nearby shows once, as the computer nearby (its announced key is the
   * friend's id), so a send goes the fast way. */
  private everyone(): LandPeer[] {
    const near = new Set(this.peers.flatMap((p) => (p.anywhere ? [p.id, p.anywhere] : [p.id])));
    return [...this.peers, ...this.friends.filter((f) => !near.has(f.id)).map((f) => ({ id: f.id, name: f.name, os: '' })), ...this.phones];
  }

  /** A friend's id, or a computer nearby whose announced key is a friend's. */
  private isFriend(id: string): boolean {
    const key = this.peers.find((p) => p.id === id)?.anywhere ?? id;
    return this.friends.some((f) => f.id === key);
  }

  /** Dials each friend (3 s each, in Rust) to see who is online; at most every ONLINE_MS while the card is open. */
  private async checkOnline(): Promise<void> {
    if (native.demo || !this.friends.length) return;
    this.lastOnline = Date.now();
    const ids = await native.landFriendsOnline();
    if (!this.alive) return;
    this.online = new Set(ids);
    this.ctx.update();
  }

  private onTransfer(t: LandTransfer): void {
    const now = Date.now();
    const prev = this.transfers.get(t.id);
    const live: Live = { ...t, since: prev?.since ?? now, at: now, speed: prev?.speed ?? 0, ended: prev?.ended ?? null };
    if (prev && t.done > prev.done) {
      const dt = (now - prev.at) / 1000;
      if (dt >= 0.05) {
        const instant = (t.done - prev.done) / dt;
        live.speed = prev.speed > 0 ? prev.speed * 0.7 + instant * 0.3 : instant;
      } else live.at = prev.at;
    }
    if (!ACTIVE.has(t.state) && live.ended === null) live.ended = now;
    this.transfers.set(t.id, live);
    if (t.state === 'asking' && prev?.state !== 'asking') this.asked(live);
    if (live.ended === now) this.finished(live);
    this.prune(now);
    this.ctx.update();
  }

  /** Someone wants to send files here: the island asks (urgent), and Windows too. */
  private asked(t: Live): void {
    // The island is hidden for a while: nobody would see the question, so the answer is no.
    if (hiddenNow(this.ctx.settings().island, Date.now())) {
      void native.landAnswer(t.id, false);
      return;
    }
    this.ctx.alert('shake');
    if (t.text) this.ctx.notify(`${t.peer.name} sent you ${what(t)}`, `${clip(t.text.replace(/\s+/g, ' '), 120)} · Copy it in the island.`);
    else this.ctx.notify(`${t.peer.name} wants to send you files`, `${what(t)} · ${bytes(t.total)}. Accept or decline in the island.`);
  }

  /** Someone asks to be friends: the island asks (urgent), and Windows too; later events clear it. */
  private onFriendAsk(a: LandFriendAsk): void {
    if (a.state !== 'asking') {
      this.friendAsks.delete(a.id);
      this.ctx.update();
      return;
    }
    // The island is hidden for a while: nobody would see the question, so the answer is no.
    if (hiddenNow(this.ctx.settings().island, Date.now())) {
      void native.landFriendAnswer(a.id, 'no');
      return;
    }
    this.friendAsks.set(a.id, { ...a, since: Date.now() });
    this.ctx.alert('shake');
    this.ctx.notify(`${a.from.name} wants to be friends`, 'Friends can send each other files from anywhere. Answer in the island.');
    this.ctx.update();
  }

  /** A phone opened a shared file, or the share ended. */
  private onShare(e: { state: string; name?: string; opened?: number }): void {
    if (!this.share) return;
    if (e.state === 'ended') this.share = null;
    else if (e.state === 'opened') {
      this.share.opened = e.opened ?? this.share.opened + 1;
      this.share.last = e.name ?? null;
      this.saw('land-sent', 'land:phone');
    }
    this.ctx.update();
  }

  private finished(t: Live): void {
    // Declining one yourself needs no announcement.
    if (t.dir === 'in' && t.state === 'declined' && t.error === 'Declined.') return;
    this.ctx.surface({ key: `end:${t.id}`, ms: ENDED_MS, level: 'expanded' });
    if (t.state === 'done') this.saw(t.dir === 'out' ? 'land-sent' : 'land-received', `land:${t.id}`);
    else if (t.state === 'failed') this.saw('bad-news', `land:${t.id}`);
  }

  private prune(now: number): void {
    const ended = [...this.transfers.values()].filter((t) => t.ended !== null).sort((a, b) => b.ended! - a.ended!);
    ended.forEach((t, i) => {
      if (i >= KEEP_MAX || now - t.ended! > KEEP_MS) this.transfers.delete(t.id);
    });
  }

  private tick(): void {
    const now = Date.now();
    if (this.share && now >= this.share.expires) {
      this.share = null;
      this.ctx.update();
    }
    if (this.note && now - this.note.at > 8000) {
      this.note = null;
      this.ctx.update();
    }
    // While the card is open, keep the list of devices fresh, and who of the friends is online.
    if (this.ctx.cardOpen?.() && now - this.lastScan >= SCAN_MS) void this.scan();
    if (this.ctx.cardOpen?.() && now - this.lastFirewall >= FIREWALL_MS) void this.checkFirewall();
    if (this.ctx.cardOpen?.() && this.friends.length && now - this.lastOnline >= ONLINE_MS) void this.checkOnline();
  }

  private async checkFirewall(): Promise<void> {
    this.lastFirewall = Date.now();
    if (native.demo || platform === 'macos') return;
    const f = await native.landFirewall();
    const changed = f.state !== this.firewall?.state || f.network !== this.firewall?.network;
    this.firewall = f;
    if (this.alive && changed) this.ctx.update();
  }

  private async scan(): Promise<void> {
    this.lastScan = Date.now();
    if (native.demo) return;
    const list = await native.landScan();
    const same = list.length === this.peers.length && list.every((p, i) => p.id === this.peers[i].id && p.name === this.peers[i].name);
    if (this.alive && !same) this.onPeers(list);
    if (this.alive) this.onPlace(await native.landPlace());
  }

  private onPlace(list: LandPeer[]): void {
    const same = list.length === this.place.length && list.every((p, i) => p.id === this.place[i].id && p.name === this.place[i].name);
    if (same) return;
    this.place = [...list];
    this.ctx.update();
  }

  /** Place Islands still worth showing: not on the network list, not friends already. */
  private strangersHere(): LandPeer[] {
    const near = new Set(this.peers.map((p) => p.id));
    const friends = new Set(this.friends.map((f) => f.id));
    return this.place.filter((p) => !near.has(p.id) && !(p.anywhere && friends.has(p.anywhere)));
  }

  // ---------------------------------------------------------------- views of the state

  /** An offer waiting for this user (the oldest first). */
  private asking(): Live | null {
    let best: Live | null = null;
    for (const t of this.transfers.values()) if (t.state === 'asking' && (!best || t.since < best.since)) best = t;
    return best;
  }

  /** A friend request waiting for this user (the oldest first). */
  private friendAsking(): (LandFriendAsk & { since: number }) | null {
    let best: (LandFriendAsk & { since: number }) | null = null;
    for (const a of this.friendAsks.values()) if (!best || a.since < best.since) best = a;
    return best;
  }

  /** The transfer the pill follows: the one that started first. */
  private lead(): Live | null {
    let best: Live | null = null;
    // A send waiting for a friend who is away can wait days: it stays in the card, off the pill.
    for (const t of this.transfers.values()) if (ACTIVE.has(t.state) && t.state !== 'asking' && t.state !== 'queued' && (!best || t.since < best.since)) best = t;
    return best;
  }

  private waitingCount(): number {
    let n = 0;
    for (const t of this.transfers.values()) if (t.state === 'queued') n++;
    return n;
  }

  private justEnded(now: number): Live | null {
    let best: Live | null = null;
    for (const t of this.transfers.values()) {
      if (t.ended === null || now - t.ended > ENDED_MS) continue;
      if (t.dir === 'in' && t.state === 'declined' && t.error === 'Declined.') continue;
      if (!best || t.ended > best.ended!) best = t;
    }
    return best;
  }

  /** Who Send goes to: the ones picked, or the only one there is. */
  private targets(): LandPeer[] {
    const all = this.everyone();
    const picked = all.filter((p) => this.picked.has(p.id));
    if (picked.length) return picked;
    return all.length === 1 ? [all[0]] : [];
  }

  private stagedFiles(): number {
    return this.staged.reduce((n, s) => n + s.files, 0);
  }

  private stagedBytes(): number {
    return this.staged.reduce((n, s) => n + s.size, 0);
  }

  private frac(t: Live): number | null {
    if (t.state === 'waiting' || t.state === 'queued') return null;
    return t.total > 0 ? t.done / t.total : 1;
  }

  private progressText(t: Live): string {
    // A file to a phone reports only its end: it is "Sending" until then.
    if (t.state === 'waiting' && isPhone(t.peer.id)) return 'Sending';
    if (t.state === 'waiting' || t.state === 'queued') return 'Waiting';
    if (t.state === 'paused') return 'Paused';
    return percent(this.frac(t) ?? 0);
  }

  private endText(t: Live): string {
    const name = t.peer.name;
    if (t.state === 'done') return t.dir === 'out' ? `Sent to ${name}` : `${cap(what(t))} from ${name}`;
    return t.error ?? (t.state === 'declined' ? `${name} declined` : t.state === 'cancelled' ? 'Cancelled' : 'Failed');
  }

  // ---------------------------------------------------------------- the pill

  status(): ActivityStatus {
    const ask = this.asking();
    if (ask) {
      return {
        active: true,
        weight: 'foreground',
        urgent: { key: `ask:${ask.id}`, level: 'maximum' },
        summary: `${ask.peer.name} wants to send ${what(ask)}`,
        beam: { tone: 'accent', motion: 'pulse', urgent: true },
      };
    }
    const fr = this.friendAsking();
    if (fr) {
      return {
        active: true,
        weight: 'foreground',
        urgent: { key: `friend:${fr.id}`, level: 'maximum' },
        summary: `${fr.from.name} wants to be friends`,
        beam: { tone: 'accent', motion: 'pulse', urgent: true },
      };
    }
    const lead = this.lead();
    if (lead) {
      const f = this.frac(lead);
      return {
        active: true,
        weight: 'foreground',
        summary: `${lead.dir === 'out' ? 'To' : 'From'} ${lead.peer.name} · ${this.progressText(lead)}`,
        beam: f === null ? { tone: 'accent', motion: 'orbit' } : { tone: 'accent', motion: 'progress', value: f },
      };
    }
    const end = this.justEnded(Date.now());
    if (end) return { active: true, weight: 'foreground', summary: this.endText(end) };
    if (this.introducing(Date.now())) return { active: true, weight: 'foreground', summary: 'Land is on' };
    if (this.share) return { active: true, weight: 'background', summary: 'Sharing with a phone' };
    // Always on the pill as a little icon (Moss): hover it and press Ctrl+V to send what you copied.
    if (this.me || native.demo) return { active: true, weight: 'background', chipOnly: true, summary: 'Land · hover here and press Ctrl+V to send what you copied' };
    return { active: false };
  }

  chip(): ChipView | null {
    const ask = this.asking();
    if (ask) return { icon: 'land', label: clip(ask.peer.name, 14), tone: 'accent', pulse: true };
    const fr = this.friendAsking();
    if (fr) return { icon: 'user', label: clip(fr.from.name, 14), tone: 'accent', pulse: true };
    const lead = this.lead();
    if (lead) return { icon: lead.dir === 'out' ? 'upload' : 'download', label: this.progressText(lead), tone: 'accent' };
    if (this.share) return { icon: 'phone', label: clock(Math.max(0, this.share.expires - Date.now())), tone: 'accent' };
    // At rest: the icon alone; a click opens Land's card.
    if (this.me || native.demo) return { icon: 'land', label: '', tone: 'muted', action: 'card' };
    return null;
  }

  render(env: RenderEnv): Seg[] {
    const compact = env.level === 'compact' || env.level === 'idle';
    const ask = this.asking();
    if (ask) {
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: 'land', tone: 'accent', anim: 'pulse', prio: 0 },
        { t: 'text', key: 'who', text: ask.peer.name, weight: 'semibold', prio: 1, min: 50 },
      ];
      if (compact) return segs;
      if (!env.vertical) segs.push({ t: 'text', key: 'what', text: ask.text ? `sent you ${what(ask)}` : `wants to send ${what(ask)}`, tone: 'muted', prio: 4, min: 60 });
      segs.push({ t: 'button', key: 'no', icon: 'x', label: env.vertical ? undefined : 'Decline', action: 'decline', arg: ask.id, style: 'secondary', side: 'end', prio: 2, tip: 'Decline' });
      if (ask.text) segs.push({ t: 'button', key: 'yes', icon: 'copy', label: env.vertical ? undefined : 'Copy', action: 'accept-copy', arg: ask.id, style: 'primary', side: 'end', prio: 1, tip: 'Copy it' });
      else segs.push({ t: 'button', key: 'yes', icon: 'check', label: env.vertical ? undefined : 'Accept', action: 'accept', arg: ask.id, style: 'primary', side: 'end', prio: 1, tip: 'Accept: save to Downloads' });
      return segs;
    }

    const fr = this.friendAsking();
    if (fr) {
      const segs: Seg[] = [
        { t: 'icon', key: 'icon', icon: 'user', tone: 'accent', anim: 'pulse', prio: 0 },
        { t: 'text', key: 'who', text: fr.from.name, weight: 'semibold', prio: 1, min: 50 },
      ];
      if (compact) return segs;
      if (!env.vertical) segs.push({ t: 'text', key: 'what', text: 'wants to be friends', tone: 'muted', prio: 4, min: 60 });
      segs.push(
        { t: 'button', key: 'no', icon: 'x', label: env.vertical ? undefined : 'Not now', action: 'friend-no', arg: fr.id, style: 'secondary', side: 'end', prio: 2, tip: 'Not now' },
        { t: 'button', key: 'yes', icon: 'plus', label: env.vertical ? undefined : 'Add', action: 'friend-add', arg: fr.id, style: 'primary', side: 'end', prio: 1, tip: 'Add: you can send each other files from anywhere' },
      );
      return segs;
    }

    const lead = this.lead();
    if (lead) {
      const icon: Seg =
        lead.state === 'paused'
          ? { t: 'icon', key: 'icon', icon: 'pause', tone: 'muted', prio: 0 }
          : { t: 'icon', key: 'icon', icon: lead.dir === 'out' ? 'upload' : 'download', tone: 'accent', anim: 'bob', prio: 0 };
      const pct: Seg = { t: 'text', key: 'pct', text: this.progressText(lead), weight: 'semibold', side: 'end', prio: 0 };
      if (compact) return [icon, pct];
      const segs: Seg[] = [
        icon,
        { t: 'text', key: 'who', text: `${lead.dir === 'out' ? 'To' : 'From'} ${lead.peer.name}`, weight: 'semibold', prio: 2, min: 60 },
        { t: 'progress', key: 'bar', value: this.frac(lead), tone: 'accent', w: env.level === 'maximum' ? 140 : 80, side: 'center', prio: 5 },
        pct,
      ];
      if (env.level === 'maximum' && !env.vertical && lead.speed >= 1 && lead.state !== 'waiting') segs.push({ t: 'text', key: 'speed', text: rate(lead.speed), tone: 'muted', size: 'sm', side: 'end', prio: 6 });
      if (env.interactive && !compact) segs.push({ t: 'button', key: 'stop', icon: 'x', action: 'cancel', arg: lead.id, style: 'ghost', side: 'end', prio: 7, tip: 'Cancel' });
      return segs;
    }

    const end = this.justEnded(env.now);
    if (!end && !this.introducing(env.now) && this.share) {
      const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: 'phone', tone: 'accent', prio: 0 }];
      if (env.vertical) return segs;
      segs.push({ t: 'text', key: 'share', text: compact ? 'Phone' : 'Sharing with a phone', weight: 'semibold', prio: 1 });
      if (!compact) {
        segs.push({ t: 'text', key: 'left', text: clock(Math.max(0, this.share.expires - env.now)), tone: 'muted', side: 'end', prio: 3 });
        if (env.interactive) segs.push({ t: 'button', key: 'qr', icon: 'land', label: env.level === 'maximum' ? 'Show code' : undefined, action: 'card', style: 'secondary', side: 'end', prio: 2, tip: 'Show the QR code' });
      }
      return segs;
    }
    if (!end && this.introducing(env.now)) {
      const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: 'land', tone: 'accent', prio: 0 }];
      if (env.vertical) return segs;
      segs.push({ t: 'text', key: 'intro', text: 'Land is on', weight: 'semibold', prio: 1 });
      if (!compact) segs.push({ t: 'text', key: 'how', text: 'drop files here to send them', tone: 'muted', prio: 4, min: 80 });
      return segs;
    }
    if (!end) {
      // At rest Land is its icon; it is the pill's own content only when nothing else is on it.
      if (!this.me && !native.demo) return [];
      const rest: Seg[] = [{ t: 'icon', key: 'rest', icon: 'land', tone: 'muted', prio: 0, tip: 'Land' }];
      if (!compact && !env.vertical) rest.push({ t: 'text', key: 'hint', text: 'Ctrl+V here to send what you copied', tone: 'muted', size: 'sm', prio: 3, min: 80 });
      return rest;
    }
    const good = end.state === 'done';
    const segs: Seg[] = [
      { t: 'icon', key: 'icon', icon: good ? 'check' : end.state === 'cancelled' ? 'x' : 'alert', tone: good ? 'good' : end.state === 'cancelled' ? 'muted' : 'bad', prio: 0 },
      { t: 'text', key: 'end', text: this.endText(end), weight: 'semibold', prio: 1, min: 60 },
    ];
    if (compact || !good || end.dir !== 'in' || !end.saved.length) return segs;
    if (end.saved.length === 1 && end.items.length === 1 && !end.items[0].dir) {
      segs.push({ t: 'button', key: 'open', icon: 'external', label: env.vertical ? undefined : 'Open', action: 'open', arg: end.saved[0], style: 'primary', side: 'end', prio: 2, tip: 'Open' });
    }
    segs.push({ t: 'button', key: 'show', icon: 'folder', label: env.vertical || env.level !== 'maximum' ? undefined : 'Show', action: 'show', arg: end.saved[0], style: 'secondary', side: 'end', prio: 3, tip: 'Show in folder' });
    return segs;
  }

  /** Receiving: an arrow drops over the bot; sending: one goes up; an offer: it waves at you. */
  override pet(): PetSignal {
    const lead = this.lead();
    const moving = lead && lead.state !== 'paused' ? lead : null;
    const mood = this.asking() || this.friendAsking() ? 'needs-you' : moving ? (moving.dir === 'out' ? 'uploading' : 'downloading') : null;
    return { mood, moment: this.petMoment };
  }

  // ---------------------------------------------------------------- Control Center

  tile(env: SheetEnv): Tile | null {
    void env;
    // Land's place is the icon on the pill; the tile only for those who switch it on.
    if (!this.opts().tile) return null;
    const lead = this.lead();
    if (lead) {
      const f = this.frac(lead);
      return {
        key: 'land',
        tone: 'accent',
        action: 'card',
        tip: 'Land',
        body: { k: 'stat', icon: lead.dir === 'out' ? 'upload' : 'download', label: `${lead.dir === 'out' ? 'To' : 'From'} ${clip(lead.peer.name, 16)}`, value: this.progressText(lead), sub: lead.speed >= 1 ? rate(lead.speed) : bytes(lead.total), progress: f },
      };
    }
    const n = this.peers.length;
    const files = this.stagedFiles();
    const waiting = this.waitingCount();
    const value = this.share ? 'Sharing with a phone' : files ? `${plural(files, 'file')} ready` : this.stagedText ? 'Text ready' : this.error ? 'Off' : waiting ? `${waiting} waiting` : n ? `${n} nearby` : 'No one nearby';
    return { key: 'land', tone: 'accent', action: 'card', tip: 'Send files to a computer nearby', body: { k: 'stat', icon: 'land', label: 'Land', value, sub: files ? 'Pick a device' : 'Drop files on the island' } };
  }

  sheet(env: SheetEnv): SheetView | null {
    if (env.reason === 'urgent') {
      const ask = this.asking();
      if (ask) return this.askCard(ask, env);
      const fr = this.friendAsking();
      return fr ? this.friendCard(fr, env) : null;
    }
    if (env.reason === 'open') return this.card(env);
    if (env.reason === 'surfaced') return env.surfaced === 'intro' && this.introducing(env.now) ? this.introCard() : this.endCard(env.now);
    return null;
  }

  /** Someone sent text: what it says, and Copy, Open (a link) or Decline. */
  private textCard(t: Live, text: string, env: SheetEnv): SheetView {
    const link = isLink(text);
    const blocks: Block[] = [
      { t: 'head', key: 'head', icon: 'land', tone: 'accent', title: `${t.peer.name} sent you ${what(t)}`, sub: osLabel(t.peer.os) || undefined },
      { t: 'text', key: 'text', text, bubble: true, lines: 8 },
    ];
    if (t.expires) blocks.push({ t: 'countdown', key: 'left', until: t.expires, total: ASK_MS, tone: 'accent' });
    if (env.interactive) {
      const items: SheetButton[] = [{ key: 'no', label: 'Decline', icon: 'x', action: 'decline', arg: t.id, style: 'secondary' }];
      if (link) items.push({ key: 'open', label: 'Open', icon: 'external', action: 'accept-open', arg: t.id, style: 'secondary' });
      items.push({ key: 'yes', label: 'Copy', icon: 'copy', action: 'accept-copy', arg: t.id, style: 'primary' });
      blocks.push({ t: 'buttons', key: 'answer', align: 'fill', items });
    }
    blocks.push({ t: 'text', key: 'where', text: 'Sent encrypted. Nothing is copied or opened until you choose.', tone: 'dim', size: 'sm' });
    return { key: `ask/${t.id}`, blocks };
  }

  /** Someone wants to send files here: who, what, and Accept or Decline. */
  private askCard(t: Live, env: SheetEnv): SheetView {
    if (t.text) return this.textCard(t, t.text, env);
    const blocks: Block[] = [{ t: 'head', key: 'head', icon: 'land', tone: 'accent', title: `${t.peer.name} wants to send you`, sub: `${what(t)} · ${bytes(t.total)}` }];
    const rows: SheetRow[] = t.items.slice(0, FILE_ROWS).map((it, i) => ({
      key: `f${i}`,
      icon: it.dir ? 'folder' : 'file',
      title: it.name,
      detail: it.dir ? `${plural(it.files, 'file')} · ${bytes(it.size)}` : bytes(it.size),
    }));
    const shown = t.items.slice(0, FILE_ROWS).reduce((n, it) => n + it.files, 0);
    if (t.count > shown) rows.push({ key: 'more', title: `and ${plural(t.count - shown, 'more file')}`, tone: 'muted' });
    if (rows.length > 1 || t.items[0]?.dir) blocks.push({ t: 'rows', key: 'files', items: rows });
    if (t.expires) blocks.push({ t: 'countdown', key: 'left', until: t.expires, total: ASK_MS, tone: 'accent' });
    if (env.interactive) {
      blocks.push({
        t: 'buttons',
        key: 'answer',
        align: 'fill',
        items: [
          { key: 'no', label: 'Decline', icon: 'x', action: 'decline', arg: t.id, style: 'secondary' },
          { key: 'yes', label: 'Accept', icon: 'download', action: 'accept', arg: t.id, style: 'primary' },
        ],
      });
    }
    blocks.push({ t: 'text', key: 'where', text: 'Saved to Downloads. Sent encrypted, and only over this network.', tone: 'dim', size: 'sm' });
    return { key: `ask/${t.id}`, blocks };
  }

  /** Someone asks to be friends: who, what that means, and Block, Not now or Add. */
  private friendCard(a: LandFriendAsk, env: SheetEnv): SheetView {
    const os = osLabel(a.from.os);
    const blocks: Block[] = [{ t: 'head', key: 'head', icon: 'user', tone: 'accent', title: `${a.from.name} wants to be friends`, sub: os ? `${os} · on any network` : 'On any network' }];
    blocks.push({ t: 'text', key: 'what', text: 'Friends can send each other files from anywhere. Each send still waits for your Accept.', size: 'sm' });
    if (a.expires) blocks.push({ t: 'countdown', key: 'left', until: a.expires, total: ASK_MS, tone: 'accent' });
    if (env.interactive) {
      blocks.push({
        t: 'buttons',
        key: 'answer',
        align: 'fill',
        items: [
          { key: 'block', label: 'Block', icon: 'stop', action: 'friend-block', arg: a.id, style: 'secondary' },
          { key: 'no', label: 'Not now', icon: 'x', action: 'friend-no', arg: a.id, style: 'secondary' },
          { key: 'yes', label: 'Add', icon: 'plus', action: 'friend-add', arg: a.id, style: 'primary' },
        ],
      });
    }
    blocks.push({ t: 'text', key: 'only', text: 'Only add people you know. Not now holds their requests for 10 minutes; Block stops them for good.', tone: 'dim', size: 'sm' });
    return { key: `friend/${a.id}`, blocks };
  }

  private introducing(now: number): boolean {
    return this.introAt > 0 && now - this.introAt < INTRO_MS;
  }

  /** Land's first start: what it does, and why the system is asking about the network right now. */
  private introCard(): SheetView {
    const ask =
      platform === 'macos'
        ? 'Your Mac asks whether Island may find devices on your network. Allow it so your computers can see each other.'
        : 'Windows asks to let Island through the firewall. Tick both Private and Public, then Allow: school and café Wi-Fi counts as Public.';
    return {
      key: 'intro',
      blocks: [
        { t: 'head', key: 'head', icon: 'land', tone: 'accent', title: 'Land is on', sub: 'Send files to your computers nearby' },
        { t: 'text', key: 'how', text: 'Drag files onto the island, pick a computer, Send. The other one needs Island open on the same network, and accepts first.', size: 'sm' },
        { t: 'text', key: 'ask', text: ask, tone: 'muted', size: 'sm' },
      ],
    };
  }

  /** A finished transfer's card: what arrived, one click from opening. */
  private endCard(now: number): SheetView | null {
    const t = this.justEnded(now);
    if (t?.dir === 'in' && t.state === 'done' && t.text && isPhone(t.peer.id)) return this.phoneTextCard(t, t.text);
    if (!t || t.dir !== 'in' || t.state !== 'done' || !t.saved.length) return null;
    const rows: SheetRow[] = t.saved.slice(0, FILE_ROWS).map((p) => ({ key: p, icon: 'file', title: baseName(p), action: 'open', arg: p, tip: 'Open' }));
    return {
      key: `end/${t.id}`,
      blocks: [
        { t: 'head', key: 'head', icon: 'check', tone: 'good', title: `${what(t)} from ${t.peer.name}`, sub: `${bytes(t.total)} · in Downloads` },
        { t: 'rows', key: 'saved', items: rows },
        { t: 'buttons', key: 'act', items: [{ key: 'show', label: 'Show in folder', icon: 'folder', action: 'show', arg: t.saved[0], style: 'secondary' }] },
      ],
    };
  }

  /** Text a phone sent: on the clipboard already; Open for a link. */
  private phoneTextCard(t: Live, text: string): SheetView {
    const items: SheetButton[] = [{ key: 'copy', label: 'Copy again', icon: 'copy', action: 'copy-text', arg: t.id, style: 'secondary' }];
    if (isLink(text)) items.push({ key: 'open', label: 'Open', icon: 'external', action: 'open-text', arg: t.id, style: 'primary' });
    return {
      key: `end/${t.id}`,
      blocks: [
        { t: 'head', key: 'head', icon: 'phone', tone: 'accent', title: `${t.peer.name} sent you ${what(t)}`, sub: 'Copied to the clipboard' },
        { t: 'text', key: 'text', text, bubble: true, lines: 8 },
        { t: 'buttons', key: 'act', align: 'fill', items },
      ],
    };
  }

  /** Sharing with a phone: the code to scan, the address, what was opened, and Stop. */
  private shareCard(s: NonNullable<LandActivity['share']>, env: SheetEnv): SheetView {
    const what = s.count ? `${plural(s.count, 'file')} · ${bytes(s.bytes)}` : 'A note';
    const blocks: Block[] = [
      { t: 'head', key: 'head', icon: 'phone', tone: 'accent', title: 'Scan with your phone', sub: `${what} · works for 15 minutes`, buttons: [{ key: 'back', icon: 'grid', action: 'island:card-close', style: 'ghost', tip: 'Control Center' }] },
      { t: 'qr', key: 'qr', size: s.size, cells: s.qr, caption: s.url },
      { t: 'countdown', key: 'left', until: s.expires, total: SHARE_MS, tone: 'accent' },
      { t: 'text', key: 'how', text: "Point the phone's camera at the code and tap the link. The phone must be on the same Wi-Fi as this computer.", tone: 'muted', size: 'sm' },
    ];
    if (s.opened) blocks.push({ t: 'text', key: 'opened', text: s.last ? `A phone opened ${s.last}.` : 'A phone opened it.', tone: 'good', size: 'sm' });
    if (env.interactive) blocks.push({ t: 'buttons', key: 'stop', align: 'fill', items: [{ key: 'stop', label: 'Stop sharing', icon: 'stop', action: 'share-stop', style: 'secondary' }] });
    blocks.push({ t: 'text', key: 'note', text: "Not on the phone? Some Wi-Fi (schools, cafés) keeps devices from seeing each other. Anyone on this Wi-Fi who knows the address could open it too, so stop once it's done.", tone: 'dim', size: 'sm' });
    return { key: 'share', wide: true, blocks };
  }

  /** The Land card in the open island: the files, who is nearby, Send, and the transfers. */
  private card(env: SheetEnv): SheetView {
    if (this.share && this.share.expires > env.now) return this.shareCard(this.share, env);
    const files = this.stagedFiles();
    const size = this.stagedBytes();
    const n = this.peers.length;
    const sub = files ? `${plural(files, 'file')} · ${bytes(size)}` : this.stagedText ? `${cap(what({ items: [], count: 0, text: this.stagedText }))} to send` : n ? `${plural(n, 'computer')} nearby` : 'Send files to a computer nearby';
    const head: Block = {
      t: 'head',
      key: 'head',
      icon: 'land',
      tone: 'accent',
      title: 'Land',
      sub,
      buttons: [
        ...(this.staged.length || this.stagedText ? [{ key: 'clear', icon: 'x', action: 'clear', style: 'ghost' as const, tip: this.stagedText ? 'Remove the text' : 'Remove the files' }] : []),
        { key: 'back', icon: 'grid', action: 'island:card-close', style: 'ghost' as const, tip: 'Control Center' },
      ],
    };
    const blocks: Block[] = [head];

    if (this.staged.length) {
      const rows: SheetRow[] = this.staged.slice(0, FILE_ROWS).map((s) => ({
        key: s.path,
        icon: s.dir ? 'folder' : 'file',
        tone: s.error ? 'bad' : undefined,
        title: s.name,
        detail: s.error ?? (s.dir ? `${plural(s.files, 'file')} · ${bytes(s.size)}` : bytes(s.size)),
        button: { key: 'rm', icon: 'x', action: 'unstage', arg: s.path, style: 'ghost', tip: 'Remove' },
      }));
      if (this.staged.length > FILE_ROWS) rows.push({ key: 'more', title: `and ${plural(this.staged.length - FILE_ROWS, 'more item')}`, tone: 'muted' });
      blocks.push({ t: 'rows', key: 'files', items: rows });
    } else if (this.stagedText) {
      const link = isLink(this.stagedText);
      blocks.push({ t: 'rows', key: 'files', items: [{ key: 'text', icon: link ? 'globe' : 'edit', title: clip(this.stagedText.replace(/\s+/g, ' '), 90), detail: link ? 'Link' : `Note · ${plural(this.stagedText.length, 'character')}`, button: { key: 'rm', icon: 'x', action: 'clear', style: 'ghost', tip: 'Remove' } }] });
    } else {
      blocks.push({ t: 'text', key: 'hint', text: 'Drag files or folders onto the island, or paste a link or a note below, then pick who gets it.', tone: 'muted', size: 'sm' });
      blocks.push({ t: 'input', key: 'text', placeholder: 'Paste a link or type a note, then Enter', action: 'stage-text' });
    }

    const targets = new Set(this.targets().map((p) => p.id));
    const all = this.everyone();
    const people: Person[] = all.map((p) => this.person(p, targets.has(p.id), env.now));
    // Here, but the Wi-Fi keeps devices apart: they can be added, then files go through Land anywhere.
    for (const p of this.strangersHere()) {
      const asking = this.befriending.has(p.id);
      people.push({ key: `place/${p.id}`, name: p.name, sub: asking ? 'Asked…' : 'Here · tap to add', badge: 'plus', initials: initials(p.name), hue: hueOf(p.id), action: 'befriend', arg: p.id, tip: `${p.name} is here, but this Wi-Fi keeps computers apart. Add them as a friend to send files.` });
    }
    const empty = this.error
      ? `Land is off: ${this.error}`
      : 'Looking for computers nearby. The other one needs Island open, on the same network. Friends on other networks show here too once you add them (Activities › Land).';
    blocks.push({ t: 'people', key: 'peers', items: people, empty });
    blocks.push(...this.firewallBlocks(env));

    if (this.staged.length || this.stagedText) {
      const bad = this.staged.some((s) => s.error);
      const count = targets.size;
      const pick = this.friends.length || this.phones.length ? 'Pick who gets them' : 'Pick a computer';
      const label = count > 1 ? `Send to ${count} ${[...targets].some(isPhone) ? 'devices' : 'computers'}` : count === 1 ? `Send to ${clip(all.find((p) => targets.has(p.id))!.name, 22)}` : all.length ? pick : 'Send';
      blocks.push({ t: 'buttons', key: 'send', align: 'fill', items: [{ key: 'send', label, icon: 'send', action: 'send', style: 'primary', disabled: !env.interactive || bad || count === 0 }] });
      // Any phone, no app: a QR code its camera opens.
      blocks.push({ t: 'buttons', key: 'phone', align: 'fill', items: [{ key: 'phone', label: 'Send to a phone', icon: 'phone', action: 'share-phone', style: 'secondary', disabled: !env.interactive || bad || native.demo }] });
    }
    if (this.note) blocks.push({ t: 'text', key: 'note', text: this.note.text, tone: this.note.good ? 'good' : 'bad', size: 'sm' });

    const list = [...this.transfers.values()].sort((a, b) => b.since - a.since).slice(0, TRANSFER_ROWS);
    if (list.length) blocks.push({ t: 'rows', key: 'transfers', items: list.map((t) => this.transferRow(t)) });

    if (this.me) {
      const me = `Others see this computer as “${this.me.name}”.`;
      blocks.push({ t: 'text', key: 'me', text: this.me.visible ? me : `${me} It doesn't take files (Activities › Land).`, tone: 'dim', size: 'sm' });
    }
    return { key: 'card', wide: true, blocks };
  }

  /** Windows Firewall keeping this network out: why, and the one-click fix. */
  private firewallBlocks(env: SheetEnv): Block[] {
    const f = this.firewall;
    if (!f || (f.state !== 'blocked' && f.state !== 'block-all')) return [];
    const where = f.network === 'public' ? 'public networks (like school or café Wi-Fi)' : `${f.network} networks`;
    if (f.state === 'block-all') {
      return [{ t: 'text', key: 'fw', text: `Windows Firewall blocks all incoming connections on ${where}, so computers here can't find this one. Turn that off in Windows Security › Firewall.`, tone: 'bad', size: 'sm' }];
    }
    return [
      { t: 'text', key: 'fw', text: `Windows Firewall keeps Island out on ${where}, so computers here can't find this one.`, tone: 'bad', size: 'sm' },
      { t: 'buttons', key: 'fw-fix', align: 'fill', items: [{ key: 'fix', label: this.fixing ? 'Waiting for Windows…' : 'Allow Island on every network', icon: 'shield', action: 'firewall-fix', style: 'secondary', disabled: !env.interactive || this.fixing }] },
    ];
  }

  private person(p: LandPeer, selected: boolean, now: number): Person {
    const nearby = this.peers.some((x) => x.id === p.id);
    const friend = this.isFriend(p.id);
    const out: Person = isPhone(p.id)
      ? { key: p.id, name: p.name, sub: 'Phone', badge: 'phone', initials: initials(p.name), hue: hueOf(p.id), selected, action: 'pick', arg: p.id, tip: `${p.name} · your phone, wherever it is` }
      : friend && !nearby
        ? { key: p.id, name: p.name, sub: this.friendStatus(p.id), badge: 'globe', initials: initials(p.name), hue: hueOf(p.id), selected, action: 'pick', arg: p.id, tip: `${p.name} · a friend, on any network` }
        : { key: p.id, name: p.name, sub: osLabel(p.os) || undefined, initials: initials(p.name), hue: hueOf(p.id), selected, action: 'pick', arg: p.id, tip: osLabel(p.os) ? `${p.name} · ${osLabel(p.os)}` : p.name };
    // A friend who is nearby: the friend mark, and the fast way.
    if (friend && nearby) {
      out.badge = 'globe';
      out.tip = `${p.name} · a friend, on this network`;
    }
    // Its latest send from here shows on its avatar: a ring while it goes, then how it went.
    let t: Live | null = null;
    for (const x of this.transfers.values()) if (x.dir === 'out' && x.peer.id === p.id && (!t || x.since > t.since)) t = x;
    if (!t) return out;
    if (ACTIVE.has(t.state)) {
      out.progress = this.frac(t);
      out.sub = t.state === 'waiting' ? `${this.progressText(t)}…` : t.state === 'queued' ? 'Sends when online' : this.progressText(t);
      out.tone = 'accent';
    } else if (t.ended !== null && now - t.ended < 10000) {
      const ok = t.state === 'done';
      out.badge = ok ? 'check' : 'x';
      out.tone = ok ? 'good' : 'bad';
      out.sub = ok ? 'Sent' : t.state === 'declined' ? 'Declined' : t.state === 'cancelled' ? 'Cancelled' : 'Failed';
    }
    return out;
  }

  /** Before the first check: "Friend"; then whether it answered. */
  private friendStatus(id: string): string {
    if (!this.online) return 'Friend';
    return this.online.has(id) ? 'Online' : 'Not online';
  }

  private transferRow(t: Live): SheetRow {
    const to = t.dir === 'out' ? `To ${t.peer.name}` : `From ${t.peer.name}`;
    // A friend's transfer says whether it runs straight between the two computers or through a relay.
    const how = t.via === 'relay' ? ' · through a relay' : t.via === 'direct' ? ' · direct' : '';
    let detail: string;
    if (t.state === 'waiting') detail = isPhone(t.peer.id) ? `Sending to ${t.peer.name}…` : `Waiting for ${t.peer.name} to accept`;
    else if (t.state === 'queued') detail = `Sends when ${t.peer.name} is online`;
    else if (t.state === 'asking') detail = 'Waiting for your answer';
    else if (t.state === 'sending' || t.state === 'receiving') detail = `${percent(this.frac(t) ?? 0)} · ${bytes(t.done)} of ${bytes(t.total)}${t.speed >= 1 ? ` · ${rate(t.speed)}` : ''}${how}`;
    // The connection dropped after Accept: what arrived is kept, and it goes on by itself.
    else if (t.state === 'paused') detail = `${percent(this.frac(t) ?? 0)} · ${t.error ?? 'Paused'}`;
    else if (t.state === 'done' && t.text) detail = t.dir === 'out' ? 'Sent' : 'Received';
    else if (t.state === 'done') detail = t.dir === 'out' ? `Sent · ${bytes(t.total)}` : 'Saved to Downloads';
    else detail = t.error ?? t.state;
    const active = ACTIVE.has(t.state);
    const row: SheetRow = {
      key: t.id,
      icon: t.dir === 'out' ? 'upload' : 'download',
      tone: t.state === 'done' ? 'good' : active ? 'accent' : 'bad',
      title: `${to} · ${what(t)}`,
      detail,
    };
    if (t.state === 'asking') row.button = { key: 'no', icon: 'x', action: 'decline', arg: t.id, style: 'ghost', tip: 'Decline' };
    else if (active) row.button = { key: 'stop', icon: 'x', action: 'cancel', arg: t.id, style: 'ghost', tip: 'Cancel' };
    else if (t.dir === 'in' && t.state === 'done' && t.saved.length) {
      row.action = 'show';
      row.arg = t.saved[0];
      row.tip = 'Show in folder';
    } else if (t.dir === 'in' && t.state === 'done' && t.text) {
      // Text that came: a link opens, a note is copied again.
      row.action = isLink(t.text) ? 'open-text' : 'copy-text';
      row.arg = t.id;
      row.tip = isLink(t.text) ? 'Open the link' : 'Copy it again';
    }
    return row;
  }

  // ---------------------------------------------------------------- files dropped on the island

  accepts(): string | null {
    return this.me || native.demo ? 'Drop to send with Land' : null;
  }

  drop(paths: string[]): boolean {
    if (!this.me && !native.demo) return false;
    // One thing at a time: dropped files take the place of text waiting to go, and of a share.
    this.stagedText = null;
    if (this.share) {
      this.share = null;
      void native.landShareStop();
    }
    void this.stage(paths);
    this.ctx.openCard?.();
    void this.scan();
    void this.checkOnline();
    return true;
  }

  private async stage(paths: string[]): Promise<void> {
    const fresh = paths.filter((p) => !this.staged.some((s) => s.path === p));
    if (!fresh.length) return;
    const got = await native.landStage(fresh);
    if (!this.alive) return;
    for (const s of got) if (!this.staged.some((x) => x.path === s.path)) this.staged.push(s);
    this.note = null;
    this.ctx.update();
  }

  // ---------------------------------------------------------------- actions

  async action(name: string, arg?: unknown): Promise<void> {
    const id = typeof arg === 'string' ? arg : '';
    switch (name) {
      case 'card':
        this.ctx.openCard?.();
        void this.scan();
        void this.checkOnline();
        break;
      case 'pick': {
        const all = this.everyone();
        if (this.picked.has(id)) this.picked.delete(id);
        else if (all.some((p) => p.id === id)) {
          // With only one there it is already the target; a tap on it keeps it.
          if (all.length === 1 && !this.picked.size) break;
          this.picked.add(id);
        }
        break;
      }
      case 'unstage':
        this.staged = this.staged.filter((s) => s.path !== id);
        break;
      case 'clear':
        this.staged = [];
        this.stagedText = null;
        this.note = null;
        break;
      case 'share-phone': {
        const paths = this.staged.filter((s) => !s.error).map((s) => s.path);
        if (!paths.length && !this.stagedText) break;
        const r = await native.landShareStart(paths, paths.length ? null : this.stagedText);
        if (!this.alive) return;
        if (r.ok) {
          this.share = { ...r.value, opened: 0, last: null };
          this.note = null;
        } else this.note = { text: r.error, at: Date.now() };
        break;
      }
      case 'share-stop':
        this.share = null;
        void native.landShareStop();
        break;
      case 'paste': {
        // Ctrl+V on Land's icon: what was copied goes to Land's card, ready to send.
        const pasted = await native.clipboardPaste();
        if (!this.alive) return;
        if (this.share) {
          this.share = null;
          void native.landShareStop();
        }
        if (pasted.files.length) {
          this.stagedText = null;
          this.staged = [];
          await this.stage(pasted.files);
        } else if (pasted.text?.trim()) {
          await this.action('stage-text', pasted.text);
        } else {
          this.note = { text: 'Nothing to send yet: copy a link, a note or files, then hover Land and press Ctrl+V.', at: Date.now() };
        }
        this.ctx.openCard?.();
        void this.scan();
        void this.checkOnline();
        break;
      }
      case 'stage-text': {
        const text = typeof arg === 'string' ? arg.trim() : '';
        if (!text) break;
        if (text.length > MAX_TEXT) {
          this.note = { text: `That is more than ${MAX_TEXT.toLocaleString('en-US')} characters. Send it as a file instead.`, at: Date.now() };
          break;
        }
        // One thing at a time: text takes the place of files waiting to go.
        this.staged = [];
        this.stagedText = text;
        this.note = null;
        void this.scan();
        void this.checkOnline();
        break;
      }
      case 'send':
        await this.send();
        break;
      case 'accept':
      case 'decline':
        if (native.demo) this.demoAnswer(id, name === 'accept');
        else await native.landAnswer(id, name === 'accept');
        break;
      case 'accept-copy':
      case 'accept-open': {
        // Text: taking it is copying (or opening) it.
        const text = this.transfers.get(id)?.text;
        if (!text) break;
        if (!native.demo) await native.landAnswer(id, true);
        if (name === 'accept-open' && isLink(text)) void native.openUrl(text.trim());
        else void native.clipboardSetText(text);
        break;
      }
      case 'copy-text':
      case 'open-text': {
        // Text that came already (a phone's, or one taken from another computer).
        const text = this.transfers.get(id)?.text;
        if (!text) break;
        if (name === 'open-text' && isLink(text)) void native.openUrl(text.trim());
        else void native.clipboardSetText(text);
        break;
      }
      case 'cancel':
        if (!native.demo) await native.landCancel(id);
        break;
      case 'befriend': {
        if (!id || this.befriending.has(id)) return;
        this.befriending.add(id);
        this.ctx.update();
        const p = this.place.find((x) => x.id === id);
        const r = await native.landFriendAddNearby(id);
        this.befriending.delete(id);
        this.note = r.ok ? { text: `${r.value.name} is your friend now: pick them to send.`, at: Date.now(), good: true } : { text: r.error, at: Date.now() };
        if (r.ok) this.friends = [...this.friends.filter((f) => f.id !== r.value.id), r.value];
        else if (p) this.ctx.log('befriend failed:', p.name, r.error);
        break;
      }
      case 'friend-add':
      case 'friend-no':
      case 'friend-block':
        if (!native.demo) await native.landFriendAnswer(id, name === 'friend-add' ? 'add' : name === 'friend-block' ? 'block' : 'no');
        this.friendAsks.delete(id);
        break;
      case 'open':
        if (id) void native.open(id);
        break;
      case 'show':
        if (id) void native.reveal(id);
        break;
      case 'firewall-fix': {
        if (this.fixing) return;
        this.fixing = true;
        this.ctx.update();
        const r = await native.landFirewallFix();
        this.fixing = false;
        if (r.ok) {
          this.firewall = r.value;
          this.lastFirewall = Date.now();
          if (r.value.state === 'ok') void this.scan();
        } else this.note = { text: r.error, at: Date.now() };
        break;
      }
      default:
        return;
    }
    this.ctx.update();
  }

  /** Every picked computer gets the files (or the text); the list empties once they are on their way. */
  private async send(): Promise<void> {
    const to = this.targets();
    if (this.stagedText) return this.sendText(to, this.stagedText);
    const paths = this.staged.filter((s) => !s.error).map((s) => s.path);
    if (!to.length || !paths.length) return;
    if (native.demo) {
      for (const p of to) this.demoSend(p, this.staged);
      this.staged = [];
      return;
    }
    const failures: string[] = [];
    for (const p of to) {
      const r = isPhone(p.id) ? await this.sendToPhone(p) : await native.landSend(p.id, paths);
      if (!r.ok) failures.push(to.length > 1 ? `${p.name}: ${r.error}` : r.error);
    }
    if (!this.alive) return;
    if (failures.length) this.note = { text: failures.join(' '), at: Date.now() };
    if (failures.length < to.length) this.staged = [];
  }

  private async sendText(to: LandPeer[], text: string): Promise<void> {
    if (!to.length || native.demo) return;
    const failures: string[] = [];
    for (const p of to) {
      const r = isPhone(p.id) ? await this.textToPhone(p, text) : await native.landSendText(p.id, text);
      if (!r.ok) failures.push(to.length > 1 ? `${p.name}: ${r.error}` : r.error);
    }
    if (!this.alive) return;
    if (failures.length) this.note = { text: failures.join(' '), at: Date.now() };
    if (failures.length < to.length) this.stagedText = null;
  }

  // ---------------------------------------------------------------- your phones (Island on your phone)

  /** Each file to a paired phone on its own stream (src-tauri/src/remote); its avatar circles until the phone has it. */
  private async sendToPhone(p: LandPeer): Promise<Tried<null>> {
    const all = this.staged.filter((s) => !s.error);
    const files = all.filter((s) => !s.dir);
    if (!files.length) return { ok: false, error: 'A phone takes files, not folders.' };
    let started = 0;
    let error = '';
    for (const f of files) {
      const r = await native.remoteSendFile(p.id.slice(PHONE.length), f.path);
      if (!this.alive) break;
      if (!r.ok) {
        error = r.error;
        continue;
      }
      started++;
      this.onTransfer({ id: `phone-out-${++this.phoneSeq}`, dir: 'out', peer: p, state: 'waiting', done: 0, total: f.size, count: 1, items: [{ name: f.name, size: f.size, files: 1, dir: false }], error: null, saved: [], folder: null, expires: null });
    }
    if (started && files.length < all.length) this.note = { text: 'Folders stayed here: a phone takes files only.', at: Date.now() };
    return started ? { ok: true, value: null } : { ok: false, error: error || `${p.name} didn't take it.` };
  }

  /** Text or a link to a paired phone: one line, shown there with Copy (and Open). */
  private async textToPhone(p: LandPeer, text: string): Promise<Tried<null>> {
    const ok = await native.remoteSend(p.id.slice(PHONE.length), { t: 'text', text, from: this.computerName() ?? (platform === 'macos' ? 'Mac' : 'PC') });
    if (!ok) return { ok: false, error: `${p.name} isn't connected right now.` };
    this.onTransfer({ id: `phone-out-${++this.phoneSeq}`, dir: 'out', peer: p, state: 'done', done: text.length, total: text.length, count: 0, items: [], error: null, saved: [], folder: null, expires: null, text });
    return { ok: true, value: null };
  }

  /** A file reached a phone, or didn't: the oldest of that name still going there. */
  private onPhoneSent(e: RemoteFileSent): void {
    if (!e || typeof e.phone !== 'string') return;
    const peer = `${PHONE}${e.phone}`;
    const going = [...this.transfers.values()].filter((t) => t.dir === 'out' && t.peer.id === peer && ACTIVE.has(t.state)).sort((a, b) => a.since - b.since);
    const t = going.find((x) => x.items[0]?.name === e.name) ?? going[0];
    if (!t) return;
    this.onTransfer({ ...t, state: e.ok ? 'done' : 'failed', done: e.ok ? t.total : t.done, error: e.ok ? null : e.error || `${t.peer.name} didn't get it` });
  }

  /**
   * What a phone sent (src/remote/hub.ts): text already on the clipboard, or a file Rust saved to
   * Downloads. Shown like what another computer sent, with the phone's name.
   */
  fromPhone(item: PhoneDelivery): void {
    const peer: LandPeer = { id: `${PHONE}${item.phone}`, name: item.from, os: 'phone' };
    const base = { dir: 'in' as const, peer, state: 'done' as const, error: null, folder: null, expires: null };
    if (item.kind === 'text') this.onTransfer({ ...base, id: `phone-in-${++this.phoneSeq}`, done: item.text.length, total: item.text.length, count: 0, items: [], saved: [], text: item.text });
    else this.onTransfer({ ...base, id: `phone-in-${item.id || ++this.phoneSeq}`, done: item.size, total: item.size, count: 1, items: [{ name: item.name, size: item.size, files: 1, dir: false }], saved: [item.path] });
  }

  /** The name other computers see this one by; phones are greeted with it too. Null while Land is off. */
  computerName(): string | null {
    return this.me?.name ?? null;
  }

  // ---------------------------------------------------------------- browser preview

  private demoSend(p: LandPeer, staged: LandStaged[]): void {
    const id = `demo-${Date.now()}-${p.id}`;
    const total = staged.reduce((n, s) => n + (s.size || 2_400_000), 0);
    const base: LandTransfer = {
      id,
      dir: 'out',
      peer: p,
      state: 'waiting',
      done: 0,
      total,
      count: staged.length,
      items: staged.map((s) => ({ name: s.name, size: s.size || 2_400_000, files: 1, dir: false })),
      error: null,
      saved: [],
      folder: null,
      expires: null,
    };
    this.onTransfer(base);
    const later = (ms: number, t: Partial<LandTransfer>) => this.demoTimers.push(setTimeout(() => this.alive && this.onTransfer({ ...base, ...t }), ms));
    for (let i = 1; i <= 10; i++) later(1500 + i * 300, { state: 'sending', done: (total * i) / 10 });
    later(5000, { state: 'done', done: total });
  }

  private demoAnswer(id: string, accept: boolean): void {
    const t = this.transfers.get(id);
    if (!t) return;
    this.onTransfer({ ...t, state: accept ? 'receiving' : 'declined', error: accept ? null : 'Declined.', expires: null });
    if (accept) this.demoTimers.push(setTimeout(() => this.alive && this.onTransfer({ ...t, state: 'done', done: t.total, saved: ['C:\\Users\\you\\Downloads\\Trip'], expires: null }), 2500));
  }

  /** The preview's incoming offer (src/dev/fill.ts). */
  demoOffer(): void {
    this.onTransfer({
      id: 'demo-in',
      dir: 'in',
      peer: DEMO_PEERS[1],
      state: 'asking',
      done: 0,
      total: 48_300_000,
      count: 14,
      items: [
        { name: 'Trip', size: 46_100_000, files: 13, dir: true },
        { name: 'itinerary.pdf', size: 2_200_000, files: 1, dir: false },
      ],
      error: null,
      saved: [],
      folder: null,
      expires: Date.now() + ASK_MS,
    });
  }
}

const DEMO_PEERS: LandPeer[] = [
  { id: '1f2e3d4c5b6a7980', name: 'Studio PC', os: 'windows' },
  { id: 'a1b2c3d4e5f60718', name: "Moss's MacBook Air", os: 'macos' },
  { id: '0badc0ffee123456', name: 'LAB-DESKTOP-07', os: 'windows' },
];
