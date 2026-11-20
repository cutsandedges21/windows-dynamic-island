import { describe, expect, it } from 'vitest';
import { CATALOG_BY_ID } from '../src/activities/catalog';
import { macWords } from '../src/mac/words';

describe('the Activities page in a Mac\'s words', () => {
  it('names the Mac\'s own things', () => {
    expect(macWords('Windows Hello to Allow')).toBe('Touch ID to Allow');
    expect(macWords('Sleep this PC at 99%')).toBe('Sleep this Mac at 99%');
    expect(macWords('Alt+Shift+1–9 switch to a session')).toBe('Option+Shift+1–9 switch to a session');
    expect(macWords('My Windows accounts')).toBe("This Mac's calendars");
    expect(macWords('Nothing to change here.')).toBe('Nothing to change here.');
  });

  it('leaves no "Windows" or "this PC" in what a Mac shows of the activities it runs', () => {
    // Importing words.ts rewrote the catalog, as the Mac build does at start.
    const leftovers: string[] = [];
    for (const [id, meta] of CATALOG_BY_ID) {
      if (meta.mac) continue;
      const texts = [meta.description, ...meta.options.filter((o) => o.mac !== 'never').flatMap((o) => [o.label, o.help ?? '', ...('choices' in o && Array.isArray(o.choices) ? o.choices.map((c) => c.label) : [])])];
      for (const t of texts) if (/\bWindows\b|this PC|This PC/.test(t)) leftovers.push(`${id}: ${t.slice(0, 90)}`);
    }
    expect(leftovers).toEqual([]);
  });
});
