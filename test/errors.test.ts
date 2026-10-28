import { describe, expect, it } from 'vitest';
import { errorLogger, errorText } from '../src/core/errors';

describe('errorText', () => {
  it('names the file, line and message of a script error', () => {
    expect(errorText({ message: 'boom', filename: 'http://tauri.localhost/assets/index-abc.js', lineno: 12, colno: 5 })).toBe('boom (index-abc.js:12:5)');
  });

  it('takes the first line of a stack when there is no message', () => {
    expect(errorText({ error: Object.assign(new TypeError('x is undefined'), { stack: 'TypeError: x is undefined\n    at f (a.js:1:1)' }) })).toBe('TypeError: x is undefined');
  });

  it('reads a rejected promise reason, Error or not', () => {
    expect(errorText({ reason: new RangeError('bad') })).toBe('RangeError: bad');
    expect(errorText({ reason: 'plain text' })).toBe('plain text');
    expect(errorText({ reason: undefined })).toBe('unknown error');
  });

  it('keeps a line short', () => {
    expect(errorText({ message: 'a'.repeat(1000) }).length).toBeLessThanOrEqual(300);
  });
});

describe('errorLogger', () => {
  it('logs each error once a minute and at most 30 a run', () => {
    const lines: string[] = [];
    let now = 0;
    const log = errorLogger('island', (l) => lines.push(l), () => now);
    log('js error', 'boom');
    log('js error', 'boom');
    expect(lines).toEqual(['island: js error: boom']);
    now = 61_000;
    log('js error', 'boom');
    expect(lines).toHaveLength(2);
    for (let i = 0; i < 100; i++) log('js error', `other ${i}`);
    expect(lines).toHaveLength(30);
    expect(lines[29]).toBe('island: js errors: more than 30, the rest are not logged');
  });
});
