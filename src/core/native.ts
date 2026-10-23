// Typed bridge to the Rust layer: one wrapper per command, one per event.
// Outside Tauri (npm run dev in a browser) the same calls resolve to safe
// defaults and `demo` is true, so activities can feed scripted demo data and
// the island can be developed and screenshotted in a normal browser.

import { invoke } from '@tauri-apps/api/core';
import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { IslandMsg } from '../remote/protocol';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const demo = !isTauri;
/** This window's label: 'island', 'app', or 'mirror-N' (a Duplicate-mode copy of the pill). */
export const windowLabel = isTauri ? getCurrentWindow().label : 'island';

export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface MonitorInfo {
  id: string;
  name: string;
  primary: boolean;
  bounds: MonitorRect;
  work: MonitorRect;
  scale: number;
  portrait: boolean;
  taskbar: 'top' | 'bottom' | 'left' | 'right' | 'hidden';
}
export interface Placement {
  monitor: MonitorInfo;
  width: number;
  height: number;
  scale: number;
}
export type ProcRow = [pid: number, ppid: number, name: string, startMs: number | null];
export interface WindowRow {
  hwnd: number;
  pid: number;
  title: string;
}
export interface FileStat {
  size: number;
  mtimeMs: number;
  dir: boolean;
}
export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}
export interface Tail {
  size: number;
  mtimeMs: number;
  lines: string[];
}
export interface TranscriptMeta {
  consumed: number;
  size: number;
  aiTitle: string | null;
  customTitle: string | null;
  permissionMode: string | null;
  userTexts: string[];
  /**
   * What turns and the context did, in file order: 'p' a prompt, 'e' a finished reply, 'x' an
   * interrupt or an API error, 'c' a compaction, 'u' the context after one API response (`tokens`).
   */
  marks: Array<[kind: 'p' | 'e' | 'x' | 'c' | 'u', ts: number, tokens: number]>;
}
export interface UsageScan {
  consumed: number;
  size: number;
  entries: Array<[key: string, ts: number, input: number, cacheCreation: number, output: number, cacheRead: number]>;
}
export interface ClaudeEnv {
  configDir: string;
  home: string;
  desktopBlobDirs: string[];
  usageClipCache: string;
  hookExe: string;
  hookReady: boolean;
  claudeExe: string | null;
}
export interface UsageFetch {
  status: number;
  retryAfter: number | null;
  body: unknown;
  noToken: boolean;
}
export interface AgendaEvent {
  id: string;
  title: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  /** Teams, Meet, Zoom… whatever the invite carries. */
  link: string;
  calendar: string;
}
export interface Agenda {
  ok: boolean;
  /** Why there is nothing: no accounts in Windows, or calendar access turned off. */
  reason: string | null;
  calendars: string[];
  events: AgendaEvent[];
}

export interface GameState {
  game: { name: string; appId: number | null; pid: number; source: 'steam' | 'store' } | null;
  fps: number | null;
  fpsSource: 'frames' | 'rivatuner' | null;
  /** Windows refused frame timing: the one-time setup (or a sign-in after it) is needed. */
  fpsNeedsSetup: boolean;
  ping: number | null;
  pingTarget: string | null;
  pingKind: 'server' | 'internet' | null;
}

export interface HookStatus {
  installed: boolean;
  /** Installing again would change nothing. */
  upToDate?: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}
export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  fingerprint: string;
}
export interface MediaState {
  available: boolean;
  app: string | null;
  appId: string | null;
  title: string;
  artist: string;
  album: string;
  status: 'playing' | 'paused' | 'stopped' | 'changing' | 'closed' | 'none';
  position: number | null;
  duration: number | null;
  updatedAt: number;
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  canPrev: boolean;
  thumbnail: string | null;
}
export interface AudioState {
  volume: number;
  muted: boolean;
  device: string | null;
  deviceId: string | null;
  micMuted: boolean | null;
  micDevice: string | null;
}
export interface PrivacyState {
  mic: string[];
  cam: string[];
}
export interface PowerState {
  hasBattery: boolean;
  percent: number | null;
  ac: boolean;
  charging: boolean;
  saver: boolean;
  secondsLeft: number | null;
  /** While it charges: how long until it is full (Windows only; absent elsewhere). */
  secondsToFull?: number | null;
}
export interface SysSample {
  cpu: number;
  memUsed: number;
  memTotal: number;
  gpu: number | null;
  top: { name: string; cpu: number } | null;
}
export interface NetSample {
  rxBps: number;
  txBps: number;
  connected: boolean;
  internet: boolean;
  name: string | null;
  wifi: boolean;
  vpn: boolean;
}
export interface ClipboardEvent {
  seq: number;
  kind: 'text' | 'image' | 'files' | 'other';
  text: string | null;
  files: string[];
  excluded: boolean;
}
export interface DeviceEvent {
  kind: 'volume';
  action: 'arrived' | 'removed';
  drive: string;
  label: string;
  removable: boolean;
}
export interface PortRow {
  port: number;
  pid: number;
  process: string;
  address: string;
}
export interface MenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  items?: MenuItem[];
}

/** Land (src-tauri/src/land.rs): a computer nearby that takes files. */
export interface LandPeer {
  id: string;
  name: string;
  /** 'windows' | 'macos' | 'linux' | 'other' */
  os: string;
  /** Its key for friends on other networks, when it announced one (signed); matches a friend's id. */
  anywhere?: string | null;
}
export interface LandInfo {
  id: string;
  name: string;
  visible: boolean;
  peers: LandPeer[];
  /** Land's first start on this computer: the system is asking about the firewall or the local network now. */
  fresh: boolean;
  /** Friends on other networks (empty while that is off). */
  friends: LandFriend[];
}
/** 'blocked': Windows Firewall keeps computers on this network ('public', 'private', 'domain') out. */
export interface LandFirewall {
  state: 'ok' | 'blocked' | 'block-all' | 'unknown';
  network: string;
}

/** Land anywhere (src-tauri/src/anywhere.rs): an Island this one sends to and takes files from, on any network. */
export interface LandFriend {
  /** Its key (hex). */
  id: string;
  name: string;
  /** When it was added (ms). */
  added: number;
}
/** This Island's key and the code a friend pastes to add it. */
export interface LandMe {
  id: string;
  code: string;
}
/** Someone asking to be friends ('land-friend-ask'); later events say how it ended. */
export interface LandFriendAsk {
  id: string;
  from: LandPeer;
  state: 'asking' | 'added' | 'declined' | 'blocked' | 'expired' | 'gone';
  /** While asking: when the request expires (ms). */
  expires?: number;
}
/** One dropped item of a transfer: a file, or a folder and the files in it. */
export interface LandItem {
  name: string;
  size: number;
  files: number;
  dir: boolean;
}
/** 'paused': the connection dropped after Accept; the sender tries again and the receiver keeps what arrived.
 * 'queued': a friend who is away; the send waits (kept on disk) and goes when they come online. */
export type LandState = 'waiting' | 'asking' | 'sending' | 'receiving' | 'paused' | 'queued' | 'done' | 'declined' | 'failed' | 'cancelled';
/** One transfer, as Rust reports it on every change and as bytes move ('land-transfer'). */
export interface LandTransfer {
  id: string;
  dir: 'out' | 'in';
  peer: LandPeer;
  state: LandState;
  done: number;
  total: number;
  count: number;
  /** The dropped files and folders (the first 20; count and total cover them all). */
  items: LandItem[];
  error: string | null;
  /** What arrived, as saved: a file, or the folder a dropped folder became. */
  saved: string[];
  folder: string | null;
  /** When an offer stops waiting for an answer (epoch ms). */
  expires: number | null;
  /** How it goes: a computer nearby ('lan'), or a friend 'direct' or through a 'relay' (it can change midway). */
  via?: 'lan' | 'direct' | 'relay' | null;
  /** A text send (a link, a note) instead of files. */
  text?: string | null;
}
/** A dropped path before it is sent. */
export interface LandStaged {
  path: string;
  name: string;
  size: number;
  dir: boolean;
  files: number;
  error: string | null;
}
export type Tried<T> = { ok: true; value: T } | { ok: false; error: string };
/** Files (or text) shared with a phone: the address and its QR code (src-tauri/src/land/share.rs). */
export interface ShareInfo {
  url: string;
  /** The QR code: `size` modules a side, row by row, '1' for dark. */
  qr: string;
  size: number;
  expires: number;
  count: number;
  bytes: number;
}
/** A phone paired in Settings › Your phone (Island on your phone, src-tauri/src/remote). */
export interface RemotePhone {
  /** Its iroh EndpointId. */
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number | null;
  connected: boolean;
  /** It turned notifications on (Web Push). */
  push: boolean;
}
/** A pairing code being shown: the address in the QR code, the code's modules, and when it stops working. */
export interface RemotePairing {
  url: string;
  /** The QR code: `size` modules a side, row by row, '1' for dark. */
  qr: string;
  size: number;
  expires: number;
}
/** A file a phone sent, saved to Downloads ('remote-file'). */
export interface RemoteFile {
  phone: string;
  id: string;
  name: string;
  path: string;
  size: number;
  mime: string;
}
/** How a file the PC sent to a phone went ('remote-file-sent'). */
export interface RemoteFileSent {
  phone: string;
  name: string;
  ok: boolean;
  error?: string | null;
}
/** A button on a phone push: a tap posts `reply` to the reply topic (src-tauri/src/phone.rs). */
export interface PushButton {
  label: string;
  reply: string;
}

/** workspaces.json as Rust holds it (src-tauri/src/workspaces/mod.rs); `doc` is checked by src/workspaces/model.ts. */
export interface WsLoaded {
  doc: unknown;
  rev: number;
  /** Where an unreadable file was moved. */
  recovered: string | null;
  /** Why nothing can be saved. */
  blocked: string | null;
}
/** Whether a path a workspace names is there ('unknown' outside the app). */
export interface PathCheck {
  state: 'file' | 'dir' | 'missing' | 'invalid' | 'unknown';
  /** Where it was found, when not exactly as typed (a program found by name, a path in the project folder). */
  resolved: string | null;
}

/** One thing a workspace opens, as Rust's ws_launch takes it (src-tauri/src/workspaces/launch.rs). */
export type LaunchItem =
  | { kind: 'app'; path: string; args: string; cwd: string }
  | { kind: 'file'; path: string; openWith: string }
  | { kind: 'folder'; path: string }
  | { kind: 'command'; id: string; command: string; shell: string; host: string; cwd: string; title: string };
export interface Launched {
  pid: number | null;
  /** Said beside the result ("Windows Terminal isn't installed, so it ran in its own window"). */
  note: string | null;
}
/** An app in Start's list: `target` is its program, or shell:AppsFolder\<id> for a Store app. */
export interface InstalledApp {
  name: string;
  target: string;
}
/** An app window on screen (src-tauri/src/workspaces/layout.rs). */
export interface LiveWindow {
  hwnd: number;
  pid: number;
  exe: string;
  title: string;
  className: string;
  /** Its rectangle when not maximized or minimized, physical pixels. */
  rect: MonitorRect;
  state: 'normal' | 'maximized' | 'minimized';
  monitor: string;
  dpi: number;
}
export interface WinPlaced {
  hwnd: number;
  ok: boolean;
  why: string | null;
}

/** Files dragged over the island and dropped on it; positions in CSS px. */
export type FileDrop =
  | { type: 'enter'; paths: string[]; x: number; y: number }
  | { type: 'over'; x: number; y: number }
  | { type: 'drop'; paths: string[]; x: number; y: number }
  | { type: 'leave' };

const mockSettingsKey = 'island:settings';

async function call<T>(cmd: string, args: Record<string, unknown> = {}, fallback: T): Promise<T> {
  if (!isTauri) return fallback;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`native ${cmd} failed`, err);
    return fallback;
  }
}

/** A command whose error message the caller shows (Land says why it cannot start or send). */
async function tryCall<T>(cmd: string, args: Record<string, unknown>): Promise<Tried<T>> {
  if (!isTauri) return { ok: false, error: 'This needs the Island app.' };
  try {
    return { ok: true, value: await invoke<T>(cmd, args) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ------------------------------------------------------------------ events

type Handler<T> = (payload: T) => void;
const localBus = new Map<string, Set<Handler<unknown>>>();

/** Subscribe to a Rust (or, in demo mode, local) event. */
export async function on<T>(event: string, cb: Handler<T>): Promise<UnlistenFn> {
  if (isTauri) return listen<T>(event, (e) => cb(e.payload));
  let set = localBus.get(event);
  if (!set) localBus.set(event, (set = new Set()));
  set.add(cb as Handler<unknown>);
  return () => set!.delete(cb as Handler<unknown>);
}

/**
 * Files dragged onto the island. Tauri reports them for the island window (the pill is the
 * only part that takes the mouse, so the only part a drop reaches); the browser preview uses
 * HTML drag events, with file names standing in for paths.
 */
export async function onFileDrop(cb: (e: FileDrop) => void): Promise<UnlistenFn> {
  if (isTauri) {
    return getCurrentWebview().onDragDropEvent(({ payload: p }) => {
      // Tauri gives physical pixels; the island works in CSS px.
      const k = window.devicePixelRatio || 1;
      if (p.type === 'leave') cb({ type: 'leave' });
      else if (p.type === 'over') cb({ type: 'over', x: p.position.x / k, y: p.position.y / k });
      else cb({ type: p.type, paths: p.paths, x: p.position.x / k, y: p.position.y / k });
    });
  }
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  let inside = 0;
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (inside++ === 0) cb({ type: 'enter', paths: ['files'], x: e.clientX, y: e.clientY });
  };
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    cb({ type: 'over', x: e.clientX, y: e.clientY });
  };
  const leave = () => {
    if (inside > 0 && --inside === 0) cb({ type: 'leave' });
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    inside = 0;
    cb({ type: 'drop', paths: Array.from(e.dataTransfer?.files ?? []).map((f) => f.name), x: e.clientX, y: e.clientY });
  };
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragover', over);
  window.addEventListener('dragleave', leave);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragenter', enter);
    window.removeEventListener('dragover', over);
    window.removeEventListener('dragleave', leave);
    window.removeEventListener('drop', drop);
  };
}

/** Demo mode only: deliver an event as if Rust had sent it. */
export function emitLocal<T>(event: string, payload: T): void {
  for (const cb of localBus.get(event) ?? []) cb(payload);
}

/** Send an event to the other window (island ⇄ app). */
export async function sendTo(window: 'island' | 'app', event: string, payload: unknown): Promise<void> {
  if (isTauri) {
    try {
      await emitTo(window, event, payload);
    } catch {
      /* the window may not exist */
    }
  } else emitLocal(event, payload);
}

// ------------------------------------------------------------------ commands

const DEMO_MONITOR: MonitorInfo = {
  id: '\\\\.\\DISPLAY1',
  name: 'Demo display',
  primary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  work: { x: 0, y: 0, width: 1920, height: 1032 },
  scale: 1,
  portrait: false,
  taskbar: 'bottom',
};

/** One of the phone's notifications, as Phone Link mirrored it (src-tauri/src/phonelink.rs). */
export interface PhoneNote {
  id: number;
  /** The phone app it came from ("Messages"), when Phone Link says. */
  app: string;
  title: string;
  body: string;
}

export const native = {
  isTauri,
  demo,

  log: (text: string) => (isTauri ? call('log_line', { text }, undefined) : (console.log('[log]', text), Promise.resolve())),

  settingsGet: async (): Promise<unknown> => {
    if (isTauri) return call('settings_get', {}, null);
    try {
      return JSON.parse(localStorage.getItem(mockSettingsKey) ?? 'null');
    } catch {
      return null;
    }
  },
  settingsSet: async (value: unknown, origin: string): Promise<void> => {
    if (isTauri) return call('settings_set', { value, origin }, undefined);
    localStorage.setItem(mockSettingsKey, JSON.stringify(value));
    emitLocal('settings', { value, origin });
  },

  monitors: () => call<MonitorInfo[]>('monitors_list', {}, [DEMO_MONITOR]),
  monitorAtCursor: () => call<MonitorInfo | null>('monitor_at_cursor', {}, DEMO_MONITOR),

  place: async (monitor: string | null): Promise<Placement | null> => {
    if (isTauri) return call<Placement | null>('island_place', { monitor }, null);
    return { monitor: DEMO_MONITOR, width: window.innerWidth, height: window.innerHeight, scale: 1 };
  },
  setHit: (rects: Array<{ x: number; y: number; w: number; h: number }>) => call('island_set_hit', { rects }, undefined),
  show: (visible: boolean) => call('island_show', { visible }, undefined),
  /** Peek behind: tapping Ctrl over the pill lets clicks through it until the pointer leaves. */
  setPeek: (enabled: boolean) => call('island_set_peek', { enabled }, undefined),
  /** Install newer releases from GitHub on their own (release builds only). */
  setAutoUpdate: (enabled: boolean) => call('update_set', { enabled }, undefined),
  /** Duplicate mode: one click-through copy of the pill on each of these monitors. */
  mirrors: (monitors: string[]) => call('island_mirrors', { monitors }, undefined),
  mirrorHello: () => call<Placement | null>('mirror_hello', {}, null),
  /** An event to every window (the island's copies listen for its frames). */
  broadcast: (event: string, payload: unknown) => (isTauri ? emit(event, payload).catch(() => {}) : (emitLocal(event, payload), Promise.resolve())),
  setFocusable: (focusable: boolean) => call<boolean>('island_set_focusable', { focusable }, true),

  procSnapshot: () => call<ProcRow[]>('proc_snapshot', {}, []),
  winEnum: () => call<WindowRow[]>('win_enum', {}, []),
  activate: (hwnd: number) => call<boolean>('win_activate', { hwnd }, false),
  foreground: () => call<number>('win_foreground', {}, 0),
  foregroundPid: () => call<number>('win_foreground_pid', {}, 0),
  /** Windows Do Not Disturb (a focus session); null where Windows has none. */
  dndGet: () => call<boolean | null>('dnd_get', {}, null),
  dndSet: (on: boolean) => call<{ ok: boolean; active: boolean | null; reason: string | null }>('dnd_set', { on }, { ok: false, active: null, reason: null }),
  /** Every calendar Windows syncs, read-only: `back` days behind and `ahead` days in front. */
  agendaRead: (back: number, ahead: number) => call<Agenda | null>('agenda_read', { back, ahead }, null),
  gameState: () => call<GameState | null>('game_state', {}, null),
  gameFpsSetup: () => call<{ ok: boolean; message: string }>('game_fps_setup', {}, { ok: false, message: 'This needs the Island app.' }),
  modifiersDown: () => call<boolean>('input_modifiers_down', {}, false),
  allowForeground: () => call('win_allow_foreground', {}, undefined),

  statMany: (paths: string[]) => call<Array<FileStat | null>>('fs_stat_many', { paths }, paths.map(() => null)),
  readDir: (path: string) => call<DirEntry[] | null>('fs_read_dir', { path }, null),
  listFiles: (dir: string, recursive: boolean, ext: string, maxAgeMs: number) =>
    call<DirEntry[]>('fs_list_files', { dir, recursive, ext, maxAgeMs }, []),
  readTail: (path: string, maxBytes: number) => call<Tail | null>('fs_read_tail', { path, maxBytes }, null),
  readText: (path: string, maxBytes = 4 * 1024 * 1024) => call<string | null>('fs_read_text', { path, maxBytes }, null),
  readBytes: async (path: string, maxBytes: number): Promise<Uint8Array | null> => {
    if (!isTauri) return null;
    try {
      const buf = await invoke<ArrayBuffer>('fs_read_bytes', { path, maxBytes });
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  },
  watch: (id: string, path: string, recursive = false) => call<boolean>('fs_watch', { id, path, recursive }, false),
  unwatch: (id: string) => call('fs_unwatch', { id }, undefined),
  knownFolders: () =>
    call<{ home: string; downloads: string; desktop: string; pictures: string; screenshots: string[]; appData: string; localAppData: string; islandData: string }>(
      'known_folders',
      {},
      { home: '', downloads: '', desktop: '', pictures: '', screenshots: [], appData: '', localAppData: '', islandData: '' },
    ),

  claudeEnv: () =>
    call<ClaudeEnv | null>('claude_env', {}, null),
  transcriptMeta: (path: string, offset: number, needUser: boolean) => call<TranscriptMeta | null>('claude_transcript_meta', { path, offset, needUser }, null),
  usageEntries: (path: string, offset: number) => call<UsageScan | null>('claude_usage_entries', { path, offset }, null),
  usageFetch: (version: string | null) => call<UsageFetch>('claude_usage_fetch', { version }, { status: 0, retryAfter: null, body: null, noToken: true }),
  openUrl: (url: string) => call<boolean>('open_url', { url }, false),
  claudeResume: (sessionId: string, cwd: string, prompt: string | null, minimized: boolean) =>
    call<boolean>('claude_resume', { sessionId, cwd, prompt, minimized }, false),
  claudeInject: (pid: number, text: string) => call<{ ok: boolean; error: string | null }>('claude_inject', { pid, text }, { ok: false, error: 'not available' }),
  selectTerminalTab: (title: string) => call<number | null>('claude_select_wt_tab', { title }, null),
  hooksStatus: () => call<HookStatus | null>('hooks_status', {}, null),
  hooksPreview: (install: boolean) => call<HookPreview | { error: string }>('hooks_preview', { install }, { error: 'not available' }),
  hooksWrite: (install: boolean, fingerprint: string) => call<{ ok: boolean; backup?: string; error?: string }>('hooks_write', { install, fingerprint }, { ok: false, error: 'not available' }),
  /**
   * The island's word on a waiting hook: 'ack' | `ack:${ms}` | `hold:${ms}` | 'allow' | 'deny' | 'pass',
   * or a JSON line island-hook understands ({kind:'reply'|'answer'|'deny', ...}).
   */
  hookReply: (requestId: string, reply: string) => call<boolean>('hook_reply', { requestId, reply }, false),

  mediaState: () => call<MediaState | null>('media_state', {}, null),
  mediaControl: (action: 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'seek', value?: number) => call<boolean>('media_control', { action, value: value ?? null }, false),
  /** Music bars: tap the speakers for bass-to-treble levels ('spectrum' events, six 0..1 numbers). */
  spectrumWatch: (on: boolean) => call('spectrum_watch', { on }, undefined),
  audioState: () => call<AudioState | null>('audio_state', {}, null),
  audioSet: (volume: number | null, muted: boolean | null) => call<boolean>('audio_set', { volume, muted }, false),
  micSetMute: (muted: boolean) => call<boolean>('mic_set_mute', { muted }, false),
  /** Of the apps Windows lists as using the mic or camera, the ones whose camera Island can switch (src-tauri/src/calls.rs). */
  callControls: (labels: string[]) => call<Array<{ label: string; app: string }>>('call_controls', { labels }, []),
  /** Presses the call app's own camera shortcut (Teams Ctrl+Shift+O, Zoom Alt+V, Meet Ctrl+E). */
  callCamera: (label: string) => tryCall<null>('call_camera', { label }),
  powerState: () => call<PowerState | null>('power_state', {}, null),
  sysSample: (withTop: boolean) => call<SysSample | null>('sys_sample', { withTop }, null),
  netSample: () => call<NetSample | null>('net_sample', {}, null),
  clipboardSetText: (text: string) => call<boolean>('clipboard_set_text', { text }, false),
  clipboardCopyImage: (path: string) => call<boolean>('clipboard_copy_image', { path }, false),
  clipboardHistory: () => call('clipboard_history', {}, undefined),
  /** Windows' sound output picker (Quick Settings), for the music player's output button. */
  soundOutput: () => call('sound_output', {}, undefined),
  /** What Ctrl+V on Land's icon pastes: files copied in Explorer, or text. */
  clipboardPaste: () => call<{ files: string[]; text: string | null }>('clipboard_paste', {}, { files: [], text: null }),
  /** Ctrl+V goes to Land while the pointer rests on its icon (Rust holds it as a hotkey meanwhile). */
  pasteArm: (armed: boolean) => call<undefined>('island_paste_arm', { armed }, undefined),
  ports: () => call<PortRow[]>('ports_listening', {}, []),
  httpGet: (url: string, maxBytes = 2 * 1024 * 1024) => call<{ status: number; body: string } | null>('http_get', { url, maxBytes }, null),

  open: (target: string) => call<boolean>('shell_open', { target }, false),
  reveal: (path: string) => call<boolean>('shell_reveal', { path }, false),
  edit: (path: string) => call<boolean>('shell_edit_image', { path }, false),
  lock: () => call('shell_lock', {}, undefined),
  snip: () => call('shell_snip', {}, undefined),

  trayUpdate: (tooltip: string, alert: boolean, menu: MenuItem[]) => call('tray_update', { tooltip, alert, menu }, undefined),
  hotkeysSet: (keys: Array<{ id: string; accel: string }>) => call<string[]>('hotkeys_set', { keys }, []),
  notify: (title: string, body: string) => call('notify', { title, body }, undefined),
  /** Whether Windows lets Island read notifications, which is how Phone Link's arrive. */
  phoneLinkAccess: () => call<'allowed' | 'denied' | 'unspecified' | 'unavailable'>('phone_link_access', {}, 'unavailable'),
  /** Starts or stops reading Phone Link's notifications; says whether Windows lets Island read them. */
  phoneLinkWatch: (on: boolean) => call<'allowed' | 'denied' | 'unspecified' | 'unavailable'>('phone_link_watch', { on }, 'unavailable'),
  /** One push to the phone's ntfy app; true when ntfy.sh took it. */
  phonePush: (topic: string, title: string, body: string, tag?: string, priority?: number, replyTopic?: string, buttons?: PushButton[]) =>
    call<boolean>('phone_push', { topic, title, body, tag: tag ?? null, priority: priority ?? null, replyTopic: replyTopic ?? null, buttons: buttons ?? null }, false),
  /** Hands what is posted to the reply topic to the island (`phone-reply`) for `seconds` more. */
  phoneListen: (topic: string, seconds: number) => call<boolean>('phone_listen', { topic, seconds }, false),
  openApp: (page: string | null = null) => call('app_open', { page }, undefined),
  quit: () => call('app_quit', {}, undefined),
  autostartGet: () => call<boolean>('autostart_get', {}, false),
  autostartSet: (enabled: boolean) => call<boolean>('autostart_set', { enabled }, false),

  /** Turns Land on, or updates its name and whether it takes files (null name: the computer's). */
  landStart: (name: string | null, visible: boolean, anywhere: boolean) => tryCall<LandInfo>('land_start', { name, visible, anywhere }),
  /** This Island's Land code (works with Land off). */
  landMe: () => tryCall<LandMe>('land_me', {}),
  landFriends: () => call<LandFriend[]>('land_friends', {}, []),
  /** The friends whose Island answers right now (ids). */
  landFriendsOnline: () => call<string[]>('land_friends_online', {}, []),
  /** Asks the Island whose code this is to be friends; resolves when its user answers. */
  landFriendAdd: (code: string) => tryCall<LandFriend>('land_friend_add', { code }),
  /** Asks a computer nearby (its Land id) to be friends, with the key it announced: no code needed. */
  landFriendAddNearby: (id: string) => tryCall<LandFriend>('land_friend_add_nearby', { id }),
  landFriendAnswer: (id: string, reply: 'add' | 'no' | 'block') => call<boolean>('land_friend_answer', { id, reply }, false),
  /** Removes a friend (they are not told), or blocks them too. */
  landFriendRemove: (id: string, block: boolean) => tryCall<null>('land_friend_remove', { id, block }),
  landStop: () => call('land_stop', {}, undefined),
  /** Asks every device nearby to say who it is; the list as it stands. */
  landScan: () => call<LandPeer[]>('land_scan', {}, []),
  /** Islands at the same place found over the internet, when its Wi-Fi keeps devices apart (they can only be added as friends). */
  landPlace: () => call<LandPeer[]>('land_place', {}, []),
  /** Whether the firewall lets computers on this network reach Island (src-tauri/src/firewall.rs). */
  landFirewall: () => call<LandFirewall>('land_firewall', {}, { state: 'ok', network: '' }),
  /** Lets Island through on every network (one UAC prompt); the new verdict. */
  landFirewallFix: () => tryCall<LandFirewall>('land_firewall_fix', {}),
  /** Starts sending; the transfer's id, or why it cannot. */
  landSend: (peer: string, paths: string[]) => tryCall<string>('land_send', { peer, paths }),
  landSendText: (peer: string, text: string) => tryCall<string>('land_send_text', { peer, text }),
  landShareStart: (paths: string[], text: string | null) => tryCall<ShareInfo>('land_share_start', { paths, text }),
  landShareStop: () => call<undefined>('land_share_stop', {}, undefined),
  landAnswer: (id: string, accept: boolean) => call<boolean>('land_answer', { id, accept }, false),
  landCancel: (id: string) => call<boolean>('land_cancel', { id }, false),
  landStage: (paths: string[]) =>
    call<LandStaged[]>('land_stage', { paths }, paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() || p, size: 0, dir: false, files: 1, error: null }))),

  /** Island on your phone (src-tauri/src/remote): a one-time pairing code for the phone site at `site`, with its QR code. */
  remotePairStart: (site: string) => tryCall<RemotePairing>('remote_pair_start', { site }),
  remotePairStop: () => call<undefined>('remote_pair_stop', {}, undefined),
  remotePhones: () => call<RemotePhone[]>('remote_phones', {}, []),
  remoteRename: (id: string, name: string) => call<boolean>('remote_rename', { id, name }, false),
  /** Forgets a phone; its connection closes at once. */
  remoteForget: (id: string) => call<boolean>('remote_forget', { id }, false),
  /** One line to a phone, or to every connected one (null). */
  remoteSend: (phone: string | null, msg: IslandMsg) => call<boolean>('remote_send', { phone, msg }, false),
  /** Sends a file to a phone on its own stream; how it went arrives as 'remote-file-sent'. */
  remoteSendFile: (phone: string, path: string) => tryCall<string>('remote_send_file', { phone, path }),
  /** The public key phones subscribe to pushes with (Web Push); '' while there is none. */
  remoteVapid: () => call<string>('remote_vapid', {}, ''),
  /** The computer's name, for phones (Land's name when Land runs). */
  remoteName: () => call<string>('remote_name', {}, ''),
  /** A notification to every phone that turned them on; a tap opens the app on `open`'s card. How many it went to. */
  remotePush: (title: string, body: string, tag: string, open: string, urgent: boolean) => call<number>('remote_push', { title, body, tag, open, urgent }, 0),

  /** Workspaces (src/workspaces/store.ts goes through these; outside the app it keeps them in the browser). */
  wsLoad: () => call<WsLoaded | null>('workspaces_load', {}, null),
  /** The first document, written only when nothing is saved yet; what is there either way. */
  wsInit: (doc: unknown) => tryCall<WsLoaded>('workspaces_init', { doc }),
  /** The whole document, only if nothing changed since revision `rev`; the new revision. */
  wsReplace: (doc: unknown, rev: number, origin: string) => tryCall<number>('workspaces_replace', { doc, rev, origin }),
  wsUpsert: (id: string, fields: Record<string, unknown>, origin: string) => tryCall<number>('workspaces_upsert', { id, fields, origin }),
  wsRemove: (id: string, origin: string) => tryCall<number>('workspaces_remove', { id, origin }),
  wsReorder: (ids: string[], origin: string) => tryCall<number>('workspaces_reorder', { ids, origin }),
  /** Is each path there, and a file or a folder? Relative paths are taken from `base`. */
  wsCheck: (paths: string[], base: string) =>
    call<PathCheck[]>('ws_check', { paths, base }, paths.map(() => ({ state: 'unknown' as const, resolved: null }))),
  /** A folder a workspace names opens in Explorer; a file is shown selected in its folder. Nothing runs. */
  wsShow: (path: string, base: string) => call<boolean>('ws_show', { path, base }, false),
  /** Opens one workspace item; `base` is its project folder. */
  wsLaunch: (item: LaunchItem, base: string) => tryCall<Launched>('ws_launch', { item, base }),
  /** The app an item starts, if it's running now (with its main window). */
  wsRunning: (path: string, base: string) => call<{ pid: number; hwnd: number | null } | null>('ws_running', { path, base }, null),
  /** Start's list of apps. */
  wsApps: () => call<InstalledApp[]>('ws_apps', {}, []),
  /** App windows on screen now, front first. */
  wsWindows: () => tryCall<LiveWindow[]>('ws_windows', {}),
  /** Moves windows to their rectangles and states; one result each. */
  wsPlace: (places: Array<{ hwnd: number; rect: MonitorRect; state: string }>) => tryCall<WinPlaced[]>('ws_place', { places }),
  /** What's in front (Workspaces › Notice what I work on), and how long since the last input. */
  noticeNow: () => call<{ window: LiveWindow | null; idleMs: number }>('notice_now', {}, { window: null, idleMs: 0 }),
  noticeLoad: () => call<unknown>('notice_load', {}, null),
  noticeSave: (doc: unknown) => call<null>('notice_save', { doc }, null),
  /** Deletes recent-work.json. */
  noticeForget: () => call<boolean>('notice_forget', {}, false),
  /** The system's Open dialog over this window; the chosen paths, empty when cancelled. */
  wsPick: (kind: 'app' | 'file' | 'folder' | 'program', multiple: boolean, start: string | null) =>
    call<string[]>('ws_pick', { kind, multiple, start }, []),
};

export type Native = typeof native;
