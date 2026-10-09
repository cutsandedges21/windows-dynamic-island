// Local AI: ask a model that runs on this PC. The question never leaves the computer and
// it works offline. The model is one of Island's own (downloaded from Activities › Local
// AI or the welcome screen) or Ollama's (src-tauri/src/local.rs). The answer streams into
// the pill while it is written, and Stop really stops the model, so a question you gave up
// on does not keep the CPU busy. Violet, not orange: orange is Claude's alone.

import type { ActivityStatus, ChipView, RenderEnv, SheetEnv } from '../core/activity';
import { bridge, type Bundled, type ChatTurn, type DeviceInfo, type LocalDelta, type LocalStatus, type SetupEnd, type SetupProgress } from '../core/bridge';
import { bytes, clip, plainText, rate } from '../core/format';
import { chooseBackend } from '../core/models';
import { native, type Agenda, type AudioState, type MediaState, type NetSample, type PowerState, type SysSample } from '../core/native';
import { platform, thisComputer } from '../core/platform';
import type { Seg } from '../core/segments';
import type { SheetButton, SheetView, Tile } from '../core/sheet';
import { trimHistory } from './ask';
import { BaseActivity } from './base';

// Model choice lives in core/models.ts, shared with the model picker; these stay importable from here.
export { chooseBackend, NO_SERVER, pickModel, SET_UP_FIRST, SUGGESTED_MODEL } from '../core/models';

type Phase = 'idle' | 'setup' | 'compose' | 'thinking' | 'streaming' | 'answer' | 'error';

/** How long "Local AI is ready" stays after setup. */
const READY_MS = 6000;
/** The first guess at how long an answer takes, before this PC has answered anything. */
const FIRST_ESTIMATE = 8000;
/** How much each new answer moves the estimate. */
const LEARN = 0.3;

/**
 * The wait bar: how full it is and the seconds left, from how long answers have taken on
 * this PC. No model can say beforehand how long it will be, so once the estimate runs out
 * the bar says "Almost done…" rather than show a number that is wrong.
 */
export function countdown(elapsed: number, estimate: number): { value: number | null; text: string } {
  const left = estimate - elapsed;
  if (left <= 500) return { value: null, text: 'Almost done…' };
  return { value: Math.min(0.97, Math.max(0, elapsed / estimate)), text: `~${Math.ceil(left / 1000)} s` };
}
/** How often to look for the local server while nothing is happening. */
const STATUS_EVERY = 30_000;
const COPIED_MS = 1800;

/** Opening the input loads the model at most this often (Rust asks Ollama to keep it 30 minutes). */
const WARM_EVERY = 60_000;
/** How long to wait for the PC's facts; anything slower is left out of the question. */
const FACTS_WAIT = 1500;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const gbText = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** What to show of the model's text: its thinking is hidden, markdown flattened. */
export function visibleAnswer(raw: string): string {
  const text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '');
  return plainText(text);
}

/** What Island can see on the PC, read just before a question goes to the model. */
export interface DeviceSnapshot {
  info?: DeviceInfo | null;
  power?: PowerState | null;
  sys?: SysSample | null;
  net?: NetSample | null;
  audio?: AudioState | null;
  media?: MediaState | null;
  agenda?: Agenda | null;
  dnd?: boolean | null;
  /** Title of the window in front. */
  window?: string | null;
}

const gb = (n: number) => `${Math.round(n / 2 ** 30)} GB`;
const hours = (secs: number) => {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
// English on purpose: the model reads these, whatever language Windows is set to.
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const dayOf = (ms: number, now: Date) => {
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' : new Date(ms).toLocaleDateString('en-US', { weekday: 'long' });
};

/** One line per thing Island can see on this PC, for the model's system prompt. Missing parts are left out. */
export function deviceFacts(s: DeviceSnapshot, now: Date): string {
  const lines: string[] = [];
  const add = (label: string, text: string | null | undefined) => {
    if (text) lines.push(`- ${label}: ${text}`);
  };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  add('Time', `${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ${clock(now.getTime())}${zone ? ` (${zone})` : ''}`);

  const i = s.info;
  if (i) {
    add(platform === 'macos' ? 'This Mac' : 'This PC', [i.computer, i.os, i.user && `signed in as ${i.user}`, i.uptimeSecs > 0 && `up ${hours(i.uptimeSecs)}`].filter(Boolean).join(', '));
    add('Processor', i.cpu && `${i.cpu}${i.threads ? `, ${i.threads} threads` : ''}`);
    add('Disks', i.drives.map((d) => `${d.root.replace(/\\$/, '')} ${gb(d.free)} free of ${gb(d.total)}`).join('; '));
  }
  const sys = s.sys;
  if (sys) {
    const gpu = sys.gpu != null ? `, GPU ${Math.round(sys.gpu)}%` : '';
    const mem = sys.memTotal > 0 ? `, memory ${bytes(sys.memUsed)} of ${bytes(sys.memTotal)} used` : '';
    const top = sys.top ? `, busiest app ${sys.top.name} (${Math.round(sys.top.cpu)}% CPU)` : '';
    add('Load', `CPU ${Math.round(sys.cpu)}%${gpu}${mem}${top}`);
  }
  const p = s.power;
  if (p && !p.hasBattery) add('Power', 'plugged in, no battery');
  if (p?.hasBattery) {
    const state = p.charging ? 'charging' : p.ac ? 'plugged in, not charging' : 'on battery';
    const left = p.secondsLeft ? `, about ${hours(p.secondsLeft)} left` : '';
    add('Battery', `${p.percent ?? '?'}%, ${state}${p.saver ? ', battery saver on' : ''}${left}`);
  }
  const n = s.net;
  if (n) {
    const link = n.wifi ? `Wi-Fi "${n.name ?? ''}"` : n.name ? `wired (${n.name})` : 'wired';
    add('Network', n.connected ? [link, n.internet ? 'internet works' : 'no internet', n.vpn && 'VPN on', `down ${rate(n.rxBps)}, up ${rate(n.txBps)}`].filter(Boolean).join(', ') : 'offline');
  }
  const a = s.audio;
  if (a) {
    add('Volume', `${Math.round(a.volume * 100)}%${a.muted ? ', muted' : ''}${a.device ? `, playing through ${a.device}` : ''}`);
    add('Microphone', a.micDevice && `${a.micDevice}${a.micMuted ? ', muted' : ''}`);
  }
  const m = s.media;
  if (m?.available && m.title && (m.status === 'playing' || m.status === 'paused')) {
    add(m.status === 'playing' ? 'Playing' : 'Paused', `"${m.title}"${m.artist ? ` by ${m.artist}` : ''}${m.app ? ` (${m.app})` : ''}`);
  }
  add('Window in front', s.window);
  if (s.dnd != null) add('Do Not Disturb', s.dnd ? 'on' : 'off');
  if (s.agenda?.ok) {
    const next = s.agenda.events.filter((e) => e.end >= now.getTime()).slice(0, 6);
    add('Calendar', next.length ? next.map((e) => `${dayOf(e.start, now)} ${e.allDay ? 'all day' : clock(e.start)} ${e.title}`).join('; ') : 'nothing in the next two days');
  }
  return lines.join('\n');
}

/** `p`, or null if it fails or takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(null)),
    );
  });
}

/** Reads what Island can see on the PC. Anything slow or failing is simply left out. */
async function readDevice(): Promise<DeviceSnapshot> {
  const w = <T>(p: Promise<T>) => within(p, FACTS_WAIT);
  const [info, power, sys, net, audio, media, agenda, dnd, front, windows] = await Promise.all([
    w(bridge.localDeviceInfo()),
    w(native.powerState()),
    w(native.sysSample(true)),
    w(native.netSample()),
    w(native.audioState()),
    w(native.mediaState()),
    w(native.agendaRead(0, 2)),
    w(native.dndGet()),
    w(native.foreground()),
    w(native.winEnum()),
  ]);
  // While its input has focus the island itself is in front; then the topmost app window is the one meant.
  const rows = Array.isArray(windows) ? windows : [];
  const window = (rows.find((r) => r.hwnd === front) ?? rows[0])?.title ?? null;
  return { info, power, sys, net, audio, media, agenda, dnd, window };
}

let lastId = 0;
/** Rust keys Stop by this id; it stays unique when the window reloads mid-answer. */
function nextId(): number {
  lastId = Math.max(lastId + 1, Date.now());
  return lastId;
}

export class LocalActivity extends BaseActivity {
  private phase: Phase = 'idle';
  private history: ChatTurn[] = [];
  private answer = '';
  private error = '';
  private model = '';
  /** The question Rust is answering (its id), or 0. */
  private asking = 0;
  /** Bumps on every question, Stop and New chat, so a late reply to an old one is ignored. */
  private turn = 0;
  /** One card per question, kept from the first words to the end so it is patched, not rebuilt. */
  private cardKey = '';
  /** The user tapped away while waiting: keep working, and come back with the answer. */
  private waitDismissed = false;
  private copiedAt = 0;
  /** The local server answered the last check. */
  private available = false;
  private warmedAt = -Infinity;
  /** Island's own runtime, as of the last check. */
  private bundled: Bundled | null = null;
  private progress: SetupProgress | null = null;
  /** The download under way was started from this activity's tile, so its failure is shown here. */
  private ownSetup = false;
  private readyUntil = 0;
  /** When the question being answered was sent, and how long its answer should take. */
  private startedAt = 0;
  private estimate = FIRST_ESTIMATE;
  /** Backend and model of the last question, the key answer times are learned under. */
  private lastKey = '';
  private learned = new Map<string, number>();

  constructor() {
    super('local');
  }

  protected init(): void {
    this.listen<LocalDelta>('local-delta', (p) => this.onDelta(p));
    this.listen<SetupProgress>('local-setup', (p) => {
      this.progress = p;
      // A download started from Activities or the welcome screen shows here too, unless a question is going on.
      if (this.phase === 'idle') this.phase = 'setup';
      this.ctx.update();
    });
    this.listen<SetupEnd>('local-setup-end', (e) => void this.setupEnded(e));
    this.every(STATUS_EVERY, () => void this.refresh(), true);
    // The wait bar moves while a question is out.
    this.every(500, () => {
      if (this.phase === 'thinking' || this.phase === 'streaming') this.ctx.update();
    });
  }

  protected override dispose(): void {
    // Closing the activity ends the chat and stops the model: nothing is kept.
    this.stopAsking();
    this.history = [];
    this.phase = 'idle';
  }

  private async refresh(): Promise<LocalStatus | null> {
    const status = await bridge.localStatus();
    if (!this.alive) return null;
    this.bundled = status.bundled ?? null;
    // A download outlives the window that started it: show one under way, drop one that ended unseen.
    if (status.bundled?.settingUp && this.phase === 'idle') this.phase = 'setup';
    else if (!status.bundled?.settingUp && this.phase === 'setup' && !this.ownSetup) this.phase = 'idle';
    this.setAvailable(status.running || !!status.bundled?.installed);
    return status;
  }

  /** Loads the model while the question is typed, so the answer does not wait seconds for it. */
  private async warm(): Promise<void> {
    if (Date.now() - this.warmedAt < WARM_EVERY) return;
    this.warmedAt = Date.now();
    const status = await this.refresh();
    if (!status) return;
    const pick = chooseBackend(status, this.ctx.options<{ model?: string }>().model);
    if ('model' in pick) void bridge.localWarm(pick.model, pick.backend);
    else this.warmedAt = -Infinity; // nothing to load yet: try again next time
  }

  /** How long an answer from this backend and model has taken on this PC, as far as Island knows. */
  private estimateFor(key: string): number {
    const saved = this.ctx.options<{ timings?: Record<string, number> }>().timings?.[key];
    return this.learned.get(key) ?? (typeof saved === 'number' && saved > 0 ? saved : FIRST_ESTIMATE);
  }

  private learn(key: string, ms: number): void {
    const next = Math.round(this.estimateFor(key) * (1 - LEARN) + ms * LEARN);
    this.learned.set(key, next);
    const timings = this.ctx.options<{ timings?: Record<string, number> }>().timings ?? {};
    this.ctx.setOptions?.({ timings: { ...timings, [key]: next } });
  }

  private setAvailable(available: boolean): void {
    if (available === this.available) return;
    this.available = available;
    this.ctx.update();
  }

  // ---------------------------------------------------------------- state

  status(): ActivityStatus {
    const busy = { tone: 'violet' as const, motion: 'orbit' as const };
    switch (this.phase) {
      case 'setup': {
        const value = this.setupShare();
        return { active: true, weight: 'foreground', summary: `Setting up Local AI${value == null ? '' : ` · ${Math.round(value * 100)}%`}`, beam: { tone: 'violet', motion: 'progress', value: value ?? 0 } };
      }
      case 'compose':
        return { active: true, weight: 'foreground', urgent: { key: 'local-input', level: 'maximum' }, summary: 'Local AI' };
      case 'thinking':
        return { active: true, weight: 'foreground', urgent: this.waitDismissed ? null : { key: `local-wait-${this.turn}`, level: 'expanded' }, summary: 'Thinking…', beam: busy };
      case 'streaming':
        return { active: true, weight: 'foreground', urgent: this.waitDismissed ? null : { key: `local-stream-${this.turn}`, level: 'maximum' }, summary: clip(oneLine(this.answer), 60), beam: busy };
      case 'answer':
        return { active: true, weight: 'foreground', urgent: { key: `local-answer-${this.turn}`, level: 'maximum' }, summary: clip(oneLine(this.answer), 60) };
      case 'error':
        return { active: true, weight: 'foreground', urgent: { key: `local-error-${this.turn}`, level: 'expanded' }, summary: clip(this.error, 60) };
      default:
        return Date.now() < this.readyUntil ? { active: true, weight: 'background', summary: 'Local AI is ready' } : { active: false };
    }
  }

  /** How much of the setup download is done, 0..1, or null before the first numbers. */
  private setupShare(): number | null {
    const p = this.progress;
    return p && p.total > 0 ? Math.min(1, p.done / p.total) : null;
  }

  /** The tile's Set up: downloads the model recommended for this PC. */
  private async setup(): Promise<void> {
    if (this.phase === 'setup') return;
    this.phase = 'setup';
    this.progress = null;
    this.ownSetup = true;
    this.ctx.update();
    const started = await bridge.localSetup();
    // Once it has begun, its progress and its end arrive as events.
    if (!this.alive || started.ok) return;
    this.ownSetup = false;
    this.phase = 'idle';
    this.fail(started.error);
  }

  /** A download ended, wherever it was started: say Local AI is ready, or why it is not. */
  private async setupEnded(e: SetupEnd): Promise<void> {
    const mine = this.ownSetup;
    this.ownSetup = false;
    this.progress = null;
    if (this.phase === 'setup') this.phase = 'idle';
    await this.refresh();
    if (!this.alive) return;
    if (e.ok && this.phase === 'idle') {
      this.readyUntil = Date.now() + READY_MS;
      this.ctx.surface({ key: `local-ready-${this.turn}`, level: 'expanded', ms: READY_MS });
    } else if (!e.ok && !e.cancelled && mine) {
      // A download started in the Activities window shows its failure there instead.
      return this.fail(e.error || 'The download failed.');
    }
    this.ctx.update();
  }

  chip(): ChipView | null {
    if (this.phase === 'thinking') return { icon: 'spark', label: 'Thinking…', tone: 'violet', pulse: true };
    if (this.phase === 'streaming') return { icon: 'spark', label: 'Writing…', tone: 'violet', pulse: true };
    if (this.phase === 'answer') return { icon: 'spark', label: 'Answered', tone: 'good' };
    return null;
  }

  /** The user tapped away from an urgent moment. */
  dismiss(key: string): void {
    if (key.startsWith('local-wait') || key.startsWith('local-stream')) {
      this.waitDismissed = true;
    } else if ((key === 'local-input' && this.phase === 'compose') || (key.startsWith('local-answer') && this.phase === 'answer') || (key.startsWith('local-error') && this.phase === 'error')) {
      this.endMoment();
    }
    this.ctx.update();
  }

  private lastQuestion(): string {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].role === 'user') return this.history[i].content;
    return '';
  }

  /** Back to rest. A question that never got an answer leaves the chat with it. */
  private endMoment(): void {
    if (this.history.at(-1)?.role === 'user') this.history.pop();
    this.phase = 'idle';
  }

  /** Tells Rust to stop the answer being written, if there is one; its reply will be ignored. */
  private stopAsking(): void {
    if (this.asking) void bridge.localCancel(this.asking);
    this.asking = 0;
    this.turn += 1;
  }

  // ---------------------------------------------------------------- asking

  private async send(text: string): Promise<void> {
    const question = text.trim();
    if (!question || this.phase === 'thinking' || this.phase === 'streaming') return;
    this.history = trimHistory([...this.history, { role: 'user', content: question }]);
    const turn = ++this.turn;
    this.phase = 'thinking';
    this.answer = '';
    this.cardKey = `local-card-${turn}`;
    this.waitDismissed = false;
    this.startedAt = Date.now();
    this.estimate = this.estimateFor(this.lastKey);
    this.ctx.update();

    const [status, device] = await Promise.all([this.refresh(), readDevice()]);
    if (!status || !this.alive || turn !== this.turn) return; // stopped, or a new chat began
    const pick = chooseBackend(status, this.ctx.options<{ model?: string }>().model);
    if ('error' in pick) return this.fail(pick.error);
    this.lastKey = `${pick.backend}:${pick.model}`;
    this.estimate = this.estimateFor(this.lastKey);

    this.model = pick.label;
    const id = (this.asking = nextId());
    const reply = await bridge.localAsk(id, pick.model, [...this.history], deviceFacts(device, new Date()), pick.backend);
    if (!this.alive || turn !== this.turn) return;
    this.asking = 0;
    const answer = reply.ok && reply.text ? visibleAnswer(reply.text) : '';
    if (answer) {
      this.learn(this.lastKey, Date.now() - this.startedAt);
      this.keep(answer);
      this.ctx.surface({ key: `local-answer-${this.turn}`, level: 'maximum', ms: 8000 });
    } else {
      this.fail(reply.error || 'The model sent no answer.');
    }
    this.ctx.update();
  }

  private onDelta(p: LocalDelta): void {
    if (!this.asking || p?.id !== this.asking) return;
    this.answer = visibleAnswer(p.text);
    // While a reasoning model thinks, nothing is visible yet: it stays on "Thinking…".
    if (this.answer && this.phase === 'thinking') this.phase = 'streaming';
    this.ctx.update();
  }

  private keep(answer: string): void {
    this.history = trimHistory([...this.history, { role: 'assistant', content: answer }]);
    this.answer = answer;
    this.phase = 'answer';
  }

  private fail(why: string): void {
    this.error = why;
    this.phase = 'error';
    this.ctx.surface({ key: `local-error-${this.turn}`, level: 'expanded', ms: 6000 });
    this.ctx.update();
  }

  async action(name: string, arg: unknown): Promise<void> {
    switch (name) {
      case 'ask':
        if (this.phase === 'thinking' || this.phase === 'streaming') {
          this.waitDismissed = false;
        } else {
          this.phase = 'compose';
          void this.warm();
        }
        this.ctx.open();
        break;
      case 'send':
        await this.send(typeof arg === 'string' ? arg : '');
        return;
      case 'setup':
        await this.setup();
        return;
      case 'stop': {
        // What was written so far stays as the answer; with nothing written, the moment ends.
        const partial = this.phase === 'streaming' ? this.answer : '';
        this.stopAsking();
        if (partial) {
          this.keep(partial);
        } else {
          this.endMoment();
          this.ctx.close();
        }
        break;
      }
      case 'retry': {
        const again = this.lastQuestion();
        if (this.history.at(-1)?.role === 'user') this.history.pop();
        this.phase = 'idle';
        await this.send(again);
        return;
      }
      case 'cancel':
        if (this.phase === 'thinking' || this.phase === 'streaming') this.stopAsking();
        this.endMoment();
        this.ctx.close();
        break;
      case 'new':
        this.stopAsking();
        this.history = [];
        this.answer = '';
        this.error = '';
        this.phase = 'compose';
        this.ctx.open();
        break;
      case 'copy':
        if (this.answer) {
          void native.clipboardSetText(this.answer);
          this.copiedAt = Date.now();
          this.later(COPIED_MS, () => this.ctx.update());
        }
        break;
    }
    this.ctx.update();
  }

  // ---------------------------------------------------------------- view

  /** A starter for the open, idle island, while a local server is running. */
  home(): Seg[] {
    // Another model downloading in the background does not stop the one that is ready.
    if ((this.phase !== 'idle' && this.phase !== 'setup') || !this.available) return [];
    return [{ t: 'button', key: 'local', icon: 'spark', label: 'Local AI', action: 'ask', style: 'secondary', prio: 5, tip: `Ask the model on ${thisComputer()}` }];
  }

  render(env: RenderEnv): Seg[] {
    const roomy = env.level === 'expanded' || env.level === 'maximum';
    const label = (text: string) => (env.vertical ? undefined : text);
    switch (this.phase) {
      case 'setup': {
        const value = this.setupShare();
        const what = this.progress?.stage === 'runtime' ? 'Getting the runtime' : 'Downloading the model';
        const segs: Seg[] = [
          { t: 'icon', key: 'icon', icon: 'download', tone: 'violet', anim: 'pulse', prio: 0 },
          { t: 'text', key: 'status', text: roomy && !env.vertical ? what : 'Setting up', weight: 'semibold', prio: 0 },
        ];
        if (!env.vertical) segs.push({ t: 'progress', key: 'bar', value, tone: 'violet', w: env.level === 'maximum' ? 140 : 80, side: 'center', prio: 3 });
        if (value != null) segs.push({ t: 'text', key: 'share', text: `${Math.round(value * 100)}%`, tone: 'muted', side: 'end', prio: 2 });
        return segs;
      }
      case 'compose':
        return [
          { t: 'icon', key: 'icon', icon: 'spark', tone: 'violet', prio: 0 },
          { t: 'input', key: 'prompt', placeholder: this.history.length ? 'Follow up…' : 'Ask Local AI…', action: 'send', cancel: 'cancel', prio: 0, min: 220 },
          { t: 'button', key: 'cancel', icon: 'x', action: 'cancel', style: 'ghost', side: 'end', prio: 1, tip: 'Cancel (Esc)' },
        ];
      // The answer itself only ever goes on the card: the pill just says where it is at.
      case 'thinking':
      case 'streaming': {
        const writing = this.phase === 'streaming';
        const segs: Seg[] = [
          { t: 'icon', key: 'icon', icon: 'spark', tone: 'violet', anim: 'pulse', prio: 0 },
          { t: 'text', key: 'status', text: writing ? 'Writing…' : 'Thinking…', weight: 'semibold', prio: 0 },
        ];
        if (!env.vertical) {
          const wait = countdown(Date.now() - this.startedAt, this.estimate);
          segs.push(
            { t: 'progress', key: 'wait', value: wait.value, tone: 'violet', w: env.level === 'maximum' ? 120 : 70, side: 'center', prio: 2 },
            { t: 'text', key: 'left', text: wait.text, tone: 'muted', prio: 1 },
          );
        }
        if (!writing && roomy && !env.vertical) segs.push({ t: 'text', key: 'question', text: clip(oneLine(this.lastQuestion()), 90), tone: 'muted', prio: 4, min: 60 });
        if (roomy) segs.push({ t: 'button', key: 'stop', icon: 'stop', label: label('Stop'), action: 'stop', style: 'secondary', side: 'end', prio: 1, tip: 'Stop the model' });
        return segs;
      }
      case 'answer':
        return [
          { t: 'icon', key: 'icon', icon: 'spark', tone: 'violet', prio: 0 },
          { t: 'text', key: 'ready', text: 'Answered', weight: 'semibold', prio: 0 },
        ];
      case 'error': {
        const segs: Seg[] = [{ t: 'icon', key: 'icon', icon: 'alert', tone: 'warn', prio: 0 }];
        if (!env.vertical) segs.push({ t: 'text', key: 'error', text: clip(this.error, 160), prio: 1, min: 80, tip: this.error });
        if (roomy) {
          segs.push(
            { t: 'button', key: 'retry', icon: 'refresh', label: label('Retry'), action: 'retry', style: 'secondary', side: 'end', prio: 1, tip: 'Ask again' },
            { t: 'button', key: 'cancel', icon: 'x', action: 'cancel', style: 'ghost', side: 'end', prio: 2, tip: 'Dismiss' },
          );
        }
        return segs;
      }
      default:
        if (Date.now() >= this.readyUntil) return [];
        return [
          { t: 'icon', key: 'icon', icon: 'check', tone: 'good', prio: 0 },
          { t: 'text', key: 'ready', text: 'Local AI is ready', weight: 'semibold', prio: 0 },
          { t: 'button', key: 'ask', icon: 'spark', label: label('Ask'), action: 'ask', style: 'secondary', side: 'end', prio: 1, tip: 'Ask Local AI' },
        ];
    }
  }

  /** The answer on a card: growing while it is written, then with a box for the follow-up. */
  sheet(_env: SheetEnv): SheetView | null {
    if (this.phase === 'streaming') {
      return {
        key: this.cardKey,
        blocks: [
          { t: 'head', key: 'head', icon: 'spark', tone: 'violet', title: 'Local AI', sub: this.model, buttons: [{ key: 'stop', icon: 'stop', label: 'Stop', action: 'stop', style: 'secondary' }] },
          { t: 'countdown', key: 'left', until: this.startedAt + this.estimate, total: this.estimate, tone: 'violet' },
          { t: 'text', key: 'answer', text: this.answer, bubble: true, lines: 12 },
        ],
      };
    }
    if (this.phase !== 'answer') return null;
    const copied = Date.now() - this.copiedAt < COPIED_MS;
    return {
      key: this.cardKey,
      blocks: [
        {
          t: 'head',
          key: 'head',
          icon: 'spark',
          tone: 'violet',
          title: 'Local AI',
          sub: clip(`${this.model} · ${oneLine(this.lastQuestion())}`, 70),
          buttons: [
            { key: 'copy', icon: copied ? 'check' : 'copy', label: copied ? 'Copied' : 'Copy', action: 'copy', style: 'secondary' },
            { key: 'new', icon: 'plus', label: 'New chat', action: 'new', style: 'ghost' },
          ],
        },
        { t: 'text', key: 'answer', text: this.answer, bubble: true, lines: 12 },
        { t: 'input', key: 'follow', placeholder: 'Follow up…', action: 'send' },
      ],
    };
  }

  tile(_env: SheetEnv): Tile | null {
    if (!this.available && (this.phase === 'idle' || this.phase === 'setup')) {
      // No Ollama: offer Island's own model, if this PC can run one.
      const b = this.bundled;
      if (!b?.model) return null;
      const share = this.setupShare();
      const sub = this.phase === 'setup' ? `Downloading${share == null ? '…' : ` ${Math.round(share * 100)}%`}` : `${b.model} · ${gbText(b.download)} download`;
      const buttons: SheetButton[] = this.phase === 'setup' ? [] : [{ key: 'setup', icon: 'download', label: 'Set up', action: 'setup', style: 'primary' }];
      return { key: 'local', span: 2, tone: 'violet', body: { k: 'actions', icon: 'spark', label: 'Local AI', sub, buttons } };
    }
    const chatting = this.history.length > 0;
    const buttons: SheetButton[] = [{ key: 'ask', icon: 'spark', label: chatting ? 'Follow up' : 'Ask', action: 'ask', style: 'primary' }];
    if (chatting) buttons.push({ key: 'new', icon: 'plus', label: 'New chat', action: 'new', style: 'ghost' });
    const sub = this.phase === 'thinking' ? 'Thinking…' : this.phase === 'streaming' ? 'Writing…' : this.answer && chatting ? clip(oneLine(this.answer), 48) : `Runs on ${thisComputer()}`;
    return { key: 'local', span: 2, tone: 'violet', body: { k: 'actions', icon: 'spark', label: 'Local AI', sub, buttons } };
  }
}
