import { describe, expect, it } from 'vitest';
import { deniedText, pairErrorText, pairInLocation, phoneName, readPairInput } from '../phone/web/src/pairing';
import { encodePair, pairUrl, PHONE_SITE, type PairPayload } from '../src/remote/protocol';

const PAIR: PairPayload = {
  v: 1,
  id: 'k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0',
  relays: ['https://use1-1.relay.n0.iroh.iroh.link/'],
  code: '0123456789abcdef0123456789abcdef',
  name: 'MossLaptop',
};

describe('pairing input', () => {
  it('takes the whole URL, the #pair part or the bare code, with stray spaces', () => {
    for (const text of [pairUrl(PAIR), `  ${pairUrl(PAIR)}\n`, `#pair=${encodePair(PAIR)}`, encodePair(PAIR)]) {
      const r = readPairInput(text);
      expect(r.ok && r.pair).toEqual(PAIR);
    }
    expect(pairUrl(PAIR).startsWith(PHONE_SITE)).toBe(true);
  });

  it('says what is wrong in plain words', () => {
    const empty = readPairInput('   ');
    expect(!empty.ok && empty.error).toMatch(/Paste/);
    const other = readPairInput('https://example.com/');
    expect(!other.ok && other.error).toMatch(/isn't a pairing link.*Settings › Your phone › Pair a phone/);
    const cut = readPairInput(pairUrl(PAIR).slice(0, -12));
    expect(!cut.ok && cut.error).toMatch(/cut short or damaged/);
  });

  it('finds a code in the page address, and tells a damaged one from none', () => {
    expect(pairInLocation({ hash: `#pair=${encodePair(PAIR)}`, search: '' })).toEqual({ found: true, pair: PAIR });
    expect(pairInLocation({ hash: '#pair=zzz', search: '' })).toEqual({ found: true, pair: null });
    expect(pairInLocation({ hash: '', search: '?demo' })).toEqual({ found: false, pair: null });
  });

  it('explains a refusal', () => {
    expect(deniedText('expired', 'X')).toBe('That code ran out. Make a new one on your PC: Settings › Your phone › Pair a phone.');
    expect(pairErrorText(Object.assign(new Error('denied'), { why: 'expired' }), 'X')).toMatch(/ran out/);
    expect(pairErrorText(new Error('denied: code'), 'X')).toMatch(/didn't work/);
    expect(pairErrorText(new Error('no answer in 20 s'), 'MossLaptop')).toMatch(/^MossLaptop didn't answer/);
    expect(pairErrorText(new Error('relay down'), 'X')).toBe("Couldn't pair with X: relay down");
    expect(pairErrorText({ why: 'version' }, 'X')).toMatch(/Update Island/);
  });

  it('names the phone from its browser', () => {
    expect(phoneName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(phoneName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('iPad');
    expect(phoneName('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile')).toBe('Android phone');
    expect(phoneName('Mozilla/5.0 (Windows NT 10.0)')).toBe('Phone');
  });
});
