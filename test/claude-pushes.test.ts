import { describe, expect, it } from 'vitest';
import { askText, clipBody, permissionText, PushGate, pushFor } from '../src/activities/claude/pushes';

describe('what a push says', () => {
  it('names the moment and the chat, with an emoji tag and a priority', () => {
    expect(pushFor('done', 'Fix the parser', 'Parser fixed.')).toEqual({ title: 'Done · Fix the parser', body: 'Parser fixed.', tag: 'white_check_mark', priority: 3 });
    expect(pushFor('error', 'Fix the parser', '').body).toBe('The chat stopped on an error.');
    expect(pushFor('asks', 'x', '').priority).toBe(4);
    expect(pushFor('waiting', 'x', '').title).toBe('Your turn · x');
  });

  it('cuts long messages', () => {
    const long = 'word '.repeat(200);
    expect(clipBody(long).length).toBe(400);
    expect(clipBody(long).endsWith('…')).toBe(true);
    expect(clipBody('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('lists a question with numbered options, and says what a permission is for', () => {
    expect(askText({ questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }, { question: 'Sure?' }] })).toBe('Which?\n1. A\n2. B\n\nSure?');
    expect(askText(null)).toBe('');
    expect(permissionText('Bash', { command: 'npm test' })).toBe('Running command: npm test');
    expect(permissionText('TodoWrite', {})).toBe('Planning');
  });
});

describe('the push gate', () => {
  const T = 1_000_000;

  it('sends a finished turn once even when hooks and polling both report it', () => {
    const g = new PushGate();
    expect(g.allow('S1', 'done', T)).toBe(true);
    expect(g.allow('S1', 'done', T + 2_000)).toBe(false);
    expect(g.allow('S1', 'done', T + 60_000)).toBe(true);
    expect(g.allow('S2', 'done', T + 60_000)).toBe(true);
  });

  it('folds the reports of one request into one push, but not a new request', () => {
    const g = new PushGate();
    expect(g.allow('S1', 'permission', T, 'Bash:a')).toBe(true);
    expect(g.allow('S1', 'needs', T + 1_000)).toBe(false);
    expect(g.allow('S1', 'permission', T + 2_000, 'Bash:a')).toBe(false);
    expect(g.allow('S1', 'permission', T + 3_000, 'Bash:b')).toBe(true);
    expect(g.allow('S1', 'needs', T + 40_000)).toBe(true);
  });

  it('says "your turn" only when nothing was sent for a while', () => {
    const g = new PushGate();
    expect(g.allow('S1', 'done', T)).toBe(true);
    expect(g.allow('S1', 'waiting', T + 60_000)).toBe(false);
    expect(g.allow('S1', 'waiting', T + 700_000)).toBe(true);
    expect(new PushGate().allow('S1', 'waiting', T)).toBe(true);
  });
});
