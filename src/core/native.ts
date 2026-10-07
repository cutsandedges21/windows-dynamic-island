// Typed bridge to the Rust layer: one wrapper per command, one per event.
// Outside Tauri (npm run dev in a browser) the same calls resolve to safe
// defaults and `demo` is true, so activities can feed scripted demo data and
// the island can be developed and screenshotted in a normal browser.

import { invoke } from '@tauri-apps/api/core';
import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
    call<{ home: string; downloads: string; desktop: string; pictures: string; screenshots: string[]; appData: string; localAppData: string }>(
      'known_folders',
      {},
      { home: '', downloads: '', desktop: '', pictures: '', screenshots: [], appData: '', localAppData: '' },
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
  audioState: () => call<AudioState | null>('audio_state', {}, null),
  audioSet: (volume: number | null, muted: boolean | null) => call<boolean>('audio_set', { volume, muted }, false),
  micSetMute: (muted: boolean) => call<boolean>('mic_set_mute', { muted }, false),
  powerState: () => call<PowerState | null>('power_state', {}, null),
  sysSample: (withTop: boolean) => call<SysSample | null>('sys_sample', { withTop }, null),
  netSample: () => call<NetSample | null>('net_sample', {}, null),
  clipboardSetText: (text: string) => call<boolean>('clipboard_set_text', { text }, false),
  clipboardCopyImage: (path: string) => call<boolean>('clipboard_copy_image', { path }, false),
  clipboardHistory: () => call('clipboard_history', {}, undefined),
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
  openApp: (page: string | null = null) => call('app_open', { page }, undefined),
  quit: () => call('app_quit', {}, undefined),
  autostartGet: () => call<boolean>('autostart_get', {}, false),
  autostartSet: (enabled: boolean) => call<boolean>('autostart_set', { enabled }, false),
};

export type Native = typeof native;
