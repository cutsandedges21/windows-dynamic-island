// Reading Codex's session files: a chat's state, its last words, its context, and the plan's
// limits, from the lines Codex writes. The fixture is a real file Codex 0.158 wrote on
// 2026-10-30 (a two-turn chat with one command), trimmed.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RolloutLine } from '../src/core/native';
import { codexLimits } from '../src/activities/codex/limits';
import { chatMessages, emptySummary, foldRollout, isContextText, weekTokens } from '../src/activities/codex/rollout';

const FIXTURE = path.join(__dirname, '..', 'src-tauri', 'src', 'testdata', 'codex-rollout.jsonl');
const lines = (): RolloutLine[] =>
  fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RolloutLine);

const at = (iso: string) => Date.parse(iso);
const ev = (timestamp: string, payload: Record<string, unknown>): RolloutLine => ({ timestamp, type: 'event_msg', payload });

describe('a Codex session file', () => {
  it('gives the chat, its folder, its first prompt and its last answer', () => {
    const s = foldRollout(emptySummary(), lines());
    expect(s.id).toBe('01a18eb4-0570-7f92-b87d-4917403176d2');
    expect(s.cwd).toBe('C:\\tmp\\codex-probe\\work');
    expect(s.originator).toBe('island-probe');
    expect(s.version).toBe('0.158.0-alpha.2.1');
    // The environment block Codex sends as a user message is not the user's prompt.
    expect(s.title).toBe('please PROBE-TOOL now');
    expect(s.lastPrompt).toBe('say hello');
    expect(s.lastAssistant).toBe('All done. Wrote probe.txt.');
    expect(s.turnOpen).toBe(false);
    expect(s.turns).toEqual([3545, 873]);
    expect(s.lastTool).toEqual({ name: 'exec_command', detail: 'cmd /c echo island-probe> probe.txt' });
    expect(s.lastActivityMs).toBe(at('2026-10-30T21:25:29.653Z'));
  });

  it('counts the context and every request’s tokens', () => {
    const s = foldRollout(emptySummary(), lines());
    expect(s.context).toEqual({ used: 1240, window: 258400 });
    expect(s.tokens.map((t) => [t.input, t.cached, t.output])).toEqual([
      [1200, 200, 40],
      [1200, 200, 40],
      [1200, 200, 40],
    ]);
    const all = weekTokens([s], 0);
    expect(all).toEqual({ fresh: 3 * (1000 + 40), cached: 600, output: 120 });
    expect(weekTokens([s], Number.MAX_SAFE_INTEGER)).toEqual({ fresh: 0, cached: 0, output: 0 });
  });

  it('folds new lines onto what it already knew', () => {
    const all = lines();
    const half = foldRollout(emptySummary(), all.slice(0, 14));
    const s = foldRollout(half, all.slice(14));
    expect(s).toEqual(foldRollout(emptySummary(), all));
  });

  it('a turn that started and has not ended is still working; an aborted one is not', () => {
    let s = foldRollout(emptySummary(), [ev('2026-10-30T10:00:00.000Z', { type: 'task_started', turn_id: 't1', started_at: 1793354400 })]);
    expect(s.turnOpen).toBe(true);
    expect(s.turnStartMs).toBe(1793354400 * 1000);
    s = foldRollout(s, [ev('2026-10-30T10:00:05.000Z', { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' })]);
    expect(s.turnOpen).toBe(false);
    expect(s.aborted).toBe(true);
    s = foldRollout(s, [ev('2026-10-30T10:01:00.000Z', { type: 'task_started', turn_id: 't2' }), ev('2026-10-30T10:01:30.000Z', { type: 'error', message: 'stream disconnected' })]);
    expect(s.turnStartMs).toBe(at('2026-10-30T10:01:00.000Z'));
    expect(s.aborted).toBe(false);
    expect(s.error).toBe('stream disconnected');
  });

  it('reads older files, which said it with user_message and agent_message', () => {
    const s = foldRollout(emptySummary(), [
      { timestamp: '2026-05-17T15:57:25.159Z', type: 'session_meta', payload: { id: 'abc', cwd: 'C:\\code\\app', originator: 'Codex Desktop', source: 'vscode' } },
      ev('2026-05-17T15:57:25.160Z', { type: 'user_message', message: 'make it look better' }),
      ev('2026-05-17T15:57:26.160Z', { type: 'agent_message', message: 'Looking at the site.' }),
    ]);
    expect(s.title).toBe('make it look better');
    expect(s.lastAssistant).toBe('Looking at the site.');
    expect(s.originator).toBe('Codex Desktop');
  });

  it('knows Codex’s context blocks from what the user typed', () => {
    expect(isContextText('<environment_context>\n  <cwd>C:\\x</cwd>')).toBe(true);
    expect(isContextText('<permissions instructions> Filesystem sandboxing')).toBe(true);
    expect(isContextText('# AGENTS.md instructions for C:\\x')).toBe(true);
    expect(isContextText('<div> is broken, fix it')).toBe(false);
    expect(isContextText('fix the build')).toBe(false);
  });
});

describe('a Codex chat on the phone', () => {
  it('shows what the user said and what Codex answered, oldest first', () => {
    const m = chatMessages(lines(), 12);
    expect(m.map((x) => [x.kind, x.text])).toEqual([
      ['you', 'please PROBE-TOOL now'],
      ['tool', 'Ran cmd /c echo island-probe> probe.txt'],
      ['claude', 'All done. Wrote probe.txt.'],
      ['you', 'say hello'],
      ['claude', 'All done. Wrote probe.txt.'],
    ]);
    expect(new Set(m.map((x) => x.key)).size).toBe(m.length);
    expect(chatMessages(lines(), 2).map((x) => x.text)).toEqual(['say hello', 'All done. Wrote probe.txt.']);
  });
});

describe('Codex limits', () => {
  it('reads the 5-hour and weekly windows from the newest reading', () => {
    const s = foldRollout(emptySummary(), lines());
    expect(s.limits?.at).toBe(at('2026-10-30T21:25:29.303Z'));
    const d = codexLimits(s.limits!.raw);
    expect(d).toEqual({ fiveHour: { pct: 42, resetsAt: 1793406329000 }, sevenDay: { pct: 17, resetsAt: 1793741129000 }, models: [] });
  });

  it('goes by the window length, not the order', () => {
    const d = codexLimits({ primary: { used_percent: 9, window_minutes: 10080, resets_at: 2 }, secondary: { used_percent: 30, window_minutes: 300, resets_at: 1 } });
    expect(d?.fiveHour).toEqual({ pct: 30, resetsAt: 1000 });
    expect(d?.sevenDay).toEqual({ pct: 9, resetsAt: 2000 });
  });

  it('has nothing to say without a plan (API key, local model)', () => {
    expect(codexLimits(null)).toBeNull();
    expect(codexLimits({ primary: null, secondary: null })).toBeNull();
    expect(codexLimits('nonsense')).toBeNull();
  });
});
