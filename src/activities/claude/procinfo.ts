// One process-table scan per poll answers, for every session: alive (with PID
// reuse guard), which app hosts it, whether it runs through a shell, and whether
// a tool is executing. Ported from Usage Clip's procinfo.js.

import type { ProcRow } from '../../core/native';

const IGNORED_CHILD_NAMES = new Set(['conhost.exe']);
export const IGNORED_ANCESTOR_NAMES = new Set(['explorer.exe']);
const HELPER_WINDOW_MS = 10000;
const MAX_ANCESTOR_DEPTH = 15;
const TICK_TOLERANCE_MS = 10000;

export const EDITOR_HOSTS = new Map([
  ['code.exe', 'VS Code'],
  ['code - insiders.exe', 'VS Code Insiders'],
  ['codium.exe', 'VSCodium'],
  ['cursor.exe', 'Cursor'],
  ['windsurf.exe', 'Windsurf'],
]);
export const TERMINAL_HOSTS = new Map([
  ['windowsterminal.exe', 'Terminal'],
  ['wezterm-gui.exe', 'WezTerm'],
  ['alacritty.exe', 'Alacritty'],
  ['conemu64.exe', 'ConEmu'],
  ['conemu.exe', 'ConEmu'],
  ['hyper.exe', 'Hyper'],
  ['warp.exe', 'Warp'],
  ['tabby.exe', 'Tabby'],
  ['mintty.exe', 'Terminal'],
]);
const SHELL_HOSTS = new Map([
  ['pwsh.exe', 'PowerShell'],
  ['powershell.exe', 'PowerShell'],
  ['cmd.exe', 'Command Prompt'],
  ['bash.exe', 'Git Bash'],
]);
const CONSOLE_HOST_NAMES = new Set(['conhost.exe', 'openconsole.exe']);
export const TERMINAL_WINDOW_OWNERS = new Set([...TERMINAL_HOSTS.keys(), ...CONSOLE_HOST_NAMES]);

const FILETIME_UNIX_OFFSET_MS = 11644473600000n;
const DOTNET_UNIX_OFFSET_MS = 62135596800000n;

/**
 * procStart is 100ns ticks: FILETIME since 1601 UTC (current Claude Code) or
 * .NET local-time ticks since year 1 (older). Either within 10 s is a match.
 */
export function ticksMatch(ticks: bigint | null, startMs: number | null, toleranceMs = TICK_TOLERANCE_MS): boolean {
  if (typeof ticks !== 'bigint' || startMs == null || !Number.isFinite(startMs)) return false;
  const asFiletime = Number(ticks / 10000n - FILETIME_UNIX_OFFSET_MS);
  if (Math.abs(asFiletime - startMs) <= toleranceMs) return true;
  const asLocalWall = Number(ticks / 10000n - DOTNET_UNIX_OFFSET_MS);
  const actualLocalWall = startMs - new Date(startMs).getTimezoneOffset() * 60000;
  return Math.abs(asLocalWall - actualLocalWall) <= toleranceMs;
}

export interface HostInfo {
  host: string | null;
  hostKind: 'editor' | 'terminal' | 'shell' | null;
  viaCli: boolean;
}

export function classifyAncestry(names: string[]): HostInfo {
  let firstShell: string | null = null;
  for (const name of names) {
    if (EDITOR_HOSTS.has(name)) return { host: EDITOR_HOSTS.get(name)!, hostKind: 'editor', viaCli: firstShell !== null };
    if (TERMINAL_HOSTS.has(name)) return { host: TERMINAL_HOSTS.get(name)!, hostKind: 'terminal', viaCli: firstShell !== null };
    if (firstShell === null && SHELL_HOSTS.has(name)) firstShell = SHELL_HOSTS.get(name)!;
  }
  if (firstShell !== null) return { host: firstShell, hostKind: 'shell', viaCli: true };
  return { host: null, hostKind: null, viaCli: false };
}

export interface ProbeResult extends HostInfo {
  alive: boolean;
  childCount: number;
  startMs: number | null;
  ancestors: Array<{ pid: number; name: string }>;
}

export class ProcessProbe {
  table = new Map<number, { ppid: number; name: string; start: number | null }>();
  private children = new Map<number, number[]>();

  load(rows: ProcRow[]): void {
    this.table = new Map(rows.map(([pid, ppid, name, start]) => [pid, { ppid, name, start }]));
    const children = new Map<number, number[]>();
    for (const [pid, { ppid }] of this.table) {
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
    this.children = children;
  }

  startOf(pid: number): number | null {
    return this.table.get(pid)?.start ?? null;
  }

  /** Ancestors nearest first; stops where a parent started after its child (PID reuse). */
  ancestors(pid: number): Array<{ pid: number; name: string }> {
    const out: Array<{ pid: number; name: string }> = [];
    const visited = new Set([pid]);
    let current = pid;
    for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
      const entry = this.table.get(current);
      if (!entry) break;
      const parentPid = entry.ppid;
      const parent = this.table.get(parentPid);
      if (!parent || visited.has(parentPid)) break;
      const ps = this.startOf(parentPid);
      const cs = this.startOf(current);
      if (ps != null && cs != null && ps > cs + 1000) break;
      out.push({ pid: parentPid, name: parent.name });
      visited.add(parentPid);
      current = parentPid;
    }
    return out;
  }

  /** Descendants that look like tool runs: not conhost, not started with the session. */
  meaningfulChildren(pid: number): Array<{ pid: number; name: string }> {
    const found: Array<{ pid: number; name: string }> = [];
    const visited = new Set([pid]);
    const sessionStart = this.startOf(pid);
    const pending: Array<[number, number]> = (this.children.get(pid) || []).map((c) => [pid, c]);
    while (pending.length) {
      const [parent, child] = pending.pop()!;
      if (visited.has(child)) continue;
      const ps = this.startOf(parent);
      const cs = this.startOf(child);
      if (ps == null || cs == null || cs < ps - 1000) continue;
      visited.add(child);
      const entry = this.table.get(child);
      if (!entry) continue;
      const helper = sessionStart != null && cs <= sessionStart + HELPER_WINDOW_MS;
      if (!IGNORED_CHILD_NAMES.has(entry.name) && !helper) found.push({ pid: child, name: entry.name });
      for (const grandchild of this.children.get(child) || []) pending.push([child, grandchild]);
    }
    return found;
  }

  probe(pid: number, procStart: bigint | null): ProbeResult {
    const dead: ProbeResult = { alive: false, host: null, hostKind: null, viaCli: false, childCount: 0, startMs: null, ancestors: [] };
    if (!this.table.has(pid)) return dead;
    const startMs = this.startOf(pid);
    if (startMs == null) return dead;
    if (procStart != null && !ticksMatch(procStart, startMs)) return dead;
    const ancestors = this.ancestors(pid);
    const cls = classifyAncestry(ancestors.map((a) => a.name));
    return { alive: true, ...cls, childCount: this.meaningfulChildren(pid).length, startMs, ancestors };
  }

  processName(pid: number): string | null {
    return this.table.get(pid)?.name ?? null;
  }

  runningEditor(): string | null {
    for (const p of this.table.values()) if (EDITOR_HOSTS.has(p.name)) return EDITOR_HOSTS.get(p.name)!;
    return null;
  }

  isRunning(name: string): boolean {
    for (const p of this.table.values()) if (p.name === name) return true;
    return false;
  }
}
